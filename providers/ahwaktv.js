"use strict";

var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => { try { step(generator.next(value)); } catch (e) { reject(e); } };
    var rejected = (value) => { try { step(generator.throw(value)); } catch (e) { reject(e); } };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
const DOMAIN = "https://yam.ahwaktv.net";
const TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function decodeHtml(str) {
  return String(str)
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function get(url, referer) {
  return __async(this, null, function* () {
    const res = yield fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": referer || (DOMAIN + "/"),
        "Accept-Language": "ar,en;q=0.9"
      },
      redirect: "follow"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return yield res.text();
  });
}

function tmdbTitles(tmdbId, mediaType) {
  return __async(this, null, function* () {
    const type = mediaType === "movie" ? "movie" : "tv";
    const titles = [];
    for (const lang of ["ar", "en"]) {
      try {
        const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=${lang}`;
        const res = yield fetch(url);
        if (!res.ok) continue;
        const data = yield res.json();
        const t = type === "movie"
          ? (data.title || data.original_title)
          : (data.name || data.original_name);
        if (t && !titles.includes(t)) titles.push(t);
      } catch (_) {}
    }
    return titles;
  });
}

// === FIX 1: use keywords= not q=
function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?keywords=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Searching:", url);
    const html = yield get(url);
    const results = [];

    const re1 = /href="(watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
    let m;
    while ((m = re1.exec(html)) !== null) {
      const watchUrl = `${DOMAIN}/${m[1]}`;
      const title = decodeHtml(m[2]);
      if (!results.find(r => r.url === watchUrl)) {
        results.push({ url: watchUrl, title });
      }
    }

    if (!results.length) {
      const re2 = /href="(watch\.php\?vid=[A-Za-z0-9]+)"/gi;
      while ((m = re2.exec(html)) !== null) {
        const watchUrl = `${DOMAIN}/${m[1]}`;
        if (!results.find(r => r.url === watchUrl)) {
          results.push({ url: watchUrl, title: "" });
        }
      }
    }

    console.log("[AhwakTV] Found", results.length, "results");
    return results;
  });
}

function extractSeeUrl(html) {
  const m = html.match(/https?:\/\/yam\.ahwaktv\.net\/see\.php\?vid=([A-Za-z0-9]+)/);
  if (m) return m[0];
  const m2 = html.match(/['"](\/see\.php\?vid=[A-Za-z0-9]+)['"]/);
  if (m2) return DOMAIN + m2[1];
  const m3 = html.match(/['"](see\.php\?vid=[A-Za-z0-9]+)['"]/);
  if (m3) return DOMAIN + "/" + m3[1];
  return null;
}

// === FIX 2: extract iframes from see.php page ===
function extractIframes(html) {
  const streams = [];
  const seen = new Set();
  const re = /<iframe[^>]*src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u = decodeHtml(m[1]);
    if (u.startsWith("//")) u = "https:" + u;
    if (!u.startsWith("http")) continue;
    // skip ads/tracking
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads/i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    streams.push(u);
  }
  return streams;
}

function hostLabel(url) {
  const m = String(url || "").match(/^https?:\/\/(?:www\.)?([^\.\/]+)/i);
  return m ? m[1] : "Server";
}

function qualityFromUrl(url) {
  const s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  return "Auto";
}

function makeStream(url, label, referer) {
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  return {
    name: "🌙 AhwakTV",
    title: `🌙 AhwakTV • ${label}`,
    url: url,
    quality: qualityFromUrl(url),
    type: "iframe",
    referer: referer || (DOMAIN + "/"),
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": referer || (DOMAIN + "/")
    }
  };
}

// === FIX 3: fetch see.php, extract iframes, return them ===
function resolveSee(seeUrl, referer) {
  console.log("[AhwakTV] see.php:", seeUrl);
  return __async(this, null, function* () {
    try {
      const html = yield get(seeUrl, referer);
      const iframes = extractIframes(html);
      console.log("[AhwakTV] see.php iframes:", iframes.length);
      return iframes.map(u => makeStream(u, hostLabel(u), seeUrl));
    } catch (e) {
      console.log("[AhwakTV] see.php error:", e.message);
      return [];
    }
  });
}

// Extract episode list from a series page
function extractEpisodeList(html) {
  const episodes = [];
  const re2 = /href="(watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
  let m;
  while ((m = re2.exec(html)) !== null) {
    const title = decodeHtml(m[2]);
    const numMatch = title.match(/الحلقة\s+(\d+)/);
    if (!numMatch) continue;
    const num = parseInt(numMatch[1], 10);
    const url = `${DOMAIN}/${m[1]}`;
    if (!episodes.find(e => e.num === num)) {
      episodes.push({ num, url });
    }
  }
  return episodes;
}

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[AhwakTV] Request:", { tmdbId, mediaType, season, episode });
    if (!tmdbId) return [];
    if (mediaType !== "movie" && mediaType !== "tv") return [];
    if (mediaType === "tv" && (!season || !episode)) return [];

    const wantedEp = mediaType === "tv" ? Number(episode) : null;

    let titles = yield tmdbTitles(tmdbId, mediaType);
    console.log("[AhwakTV] Titles:", titles);
    if (!titles.length) titles = [String(tmdbId)];

    const streams = [];
    const seen = new Set();

    for (const title of titles) {
      try {
        const results = yield searchSite(title);
        if (!results.length) continue;

        if (mediaType === "movie") {
          for (const result of results.slice(0, 3)) {
            try {
              const html = yield get(result.url);
              const seeUrl = extractSeeUrl(html);
              if (!seeUrl) continue;
              const resolved = yield resolveSee(seeUrl, result.url);
              for (const s of resolved) {
                if (seen.has(s.url)) continue;
                seen.add(s.url);
                streams.push(s);
              }
              if (streams.length) break;
            } catch (e) {
              console.log("[AhwakTV] Movie page error:", e.message);
            }
          }
        } else {
          for (const result of results.slice(0, 3)) {
            try {
              const html = yield get(result.url);

              const titleEpMatch = result.title.match(/الحلقة\s+(\d+)/);
              if (titleEpMatch && parseInt(titleEpMatch[1], 10) === wantedEp) {
                const seeUrl = extractSeeUrl(html);
                if (seeUrl) {
                  const resolved = yield resolveSee(seeUrl, result.url);
                  for (const s of resolved) {
                    if (seen.has(s.url)) continue;
                    seen.add(s.url);
                    streams.push(s);
                  }
                  if (streams.length) break;
                }
              }

              const epList = extractEpisodeList(html);
              const epEntry = epList.find(e => e.num === wantedEp);
              if (epEntry) {
                const epHtml = epEntry.url === result.url ? html : yield get(epEntry.url);
                const seeUrl = extractSeeUrl(epHtml);
                if (seeUrl) {
                  const resolved = yield resolveSee(seeUrl, epEntry.url);
                  for (const s of resolved) {
                    if (seen.has(s.url)) continue;
                    seen.add(s.url);
                    streams.push(s);
                  }
                  if (streams.length) break;
                }
              }

              if (streams.length) break;
            } catch (e) {
              console.log("[AhwakTV] TV page error:", e.message);
            }
          }
        }

        if (streams.length) break;
      } catch (e) {
        console.log("[AhwakTV] Error:", title, e.message);
      }
    }

    console.log("[AhwakTV] Final streams:", streams.length);
    return streams;
  });
}

module.exports = { getStreams };
