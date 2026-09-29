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

function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http")) return u;
  if (u.startsWith("/")) return DOMAIN + u;
  return DOMAIN + "/" + u;
}

function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?keywords=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Searching:", url);
    const html = yield get(url);
    const results = [];

    const re1 = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
    let m;
    while ((m = re1.exec(html)) !== null) {
      const watchUrl = normalizeUrl(m[1]);
      const title = decodeHtml(m[2]);
      if (!results.find(r => r.url === watchUrl)) {
        results.push({ url: watchUrl, title });
      }
    }

    if (!results.length) {
      const re2 = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"/gi;
      while ((m = re2.exec(html)) !== null) {
        const watchUrl = normalizeUrl(m[1]);
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
  const m = html.match(/https?:\/\/[a-z0-9.-]*\/see\.php\?vid=[A-Za-z0-9]+/i);
  if (m) return m[0];
  const m2 = html.match(/['"]((?:https?:)?\/\/[^"']*\/see\.php\?vid=[A-Za-z0-9]+)['"]/i);
  if (m2) return normalizeUrl(m2[1]);
  const m3 = html.match(/['"]([^"']*\/see\.php\?vid=[A-Za-z0-9]+)['"]/i);
  if (m3) return normalizeUrl(m3[1]);
  return null;
}

function extractIframes(html) {
  const streams = [];
  const seen = new Set();
  const re = /<iframe[^>]*src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u = decodeHtml(m[1]);
    if (u.startsWith("//")) u = "https:" + u;
    if (!u.startsWith("http")) continue;
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

function makeStream(url, label, referer, type) {
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  let streamType = type || "iframe";
  if (/\.m3u8/i.test(url)) streamType = "hls";
  else if (/\.mp4/i.test(url)) streamType = "mp4";
  return {
    name: "🌙 AhwakTV",
    title: `🌙 AhwakTV • ${label}`,
    url: url,
    quality: qualityFromUrl(url),
    type: streamType,
    referer: referer || (DOMAIN + "/"),
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": referer || (DOMAIN + "/")
    }
  };
}

// ============================================================
// VIDMOLY RESOLVER
// Embed page contains: sources: [{file: "https://...m3u8"}]
// ============================================================
function resolveVidMoly(embedUrl) {
  console.log("[AhwakTV] VidMoly:", embedUrl);
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Referer": "https://vidmoly.to/",
          "Sec-Fetch-Dest": "iframe",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow"
      });
      const html = yield res.text();
      // Look for sources : [{file: "https://..."}]
      const m = html.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i);
      if (m) {
        const url = m[1].replace(/\\\//g, "/");
        console.log("[AhwakTV] VidMoly m3u8:", url.slice(0, 100));
        return [makeStream(url, "VidMoly", "https://vidmoly.to/", "hls")];
      }
      // Also try {file:"..."} variants
      const m2 = html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
      if (m2) {
        const url = m2[1].replace(/\\\//g, "/");
        return [makeStream(url, "VidMoly", "https://vidmoly.to/", "hls")];
      }
      console.log("[AhwakTV] VidMoly: no m3u8 found");
      return [];
    } catch (e) {
      console.log("[AhwakTV] VidMoly error:", e.message);
      return [];
    }
  });
}

// ============================================================
// DOODSTREAM (playmogo) RESOLVER
// 1) Fetch embed page
// 2) Extract /pass_md5/XXXX
// 3) Fetch that URL → returns base string
// 4) Build: baseString + randomString(10) + "?token=TOKEN&expiry=EXPIRY"
// ============================================================
function resolveDoodStream(embedUrl) {
  console.log("[AhwakTV] DoodStream:", embedUrl);
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Referer": DOMAIN + "/",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow"
      });
      const html = yield res.text();

      // Look for /pass_md5/ path
      const m = html.match(/["'](\/pass_md5\/[^"']+)["']/i);
      if (!m) {
        console.log("[AhwakTV] DoodStream: no pass_md5");
        return [];
      }
      const passPath = m[1];
      // Extract token from passPath: /pass_md5/{token}/{id} → token
      const tokenMatch = passPath.match(/\/pass_md5\/([^\/]+)/);
      const token = tokenMatch ? tokenMatch[1] : "";
      // Extract expiry from embed page
      const expiryMatch = html.match(/[?&]expiry=([0-9]+)/i);
      const expiry = expiryMatch ? expiryMatch[1] : String(Math.floor(Date.now() / 1000) + 3600);

      // Origin of embed URL for pass_md5 fetch
      const originMatch = embedUrl.match(/^(https?:\/\/[^\/]+)/);
      const origin = originMatch ? originMatch[1] : "";

      // Fetch pass_md5 URL
      const passUrl = origin + passPath;
      const passRes = yield fetch(passUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Referer": embedUrl,
          "Accept": "*/*"
        },
        redirect: "follow"
      });
      const baseString = yield passRes.text();
      if (!baseString || baseString.length < 10) {
        console.log("[AhwakTV] DoodStream: empty base string");
        return [];
      }

      // Random string (10 chars)
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let rnd = "";
      for (let i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));

      // Build final: baseString + rnd + "?token=" + token + "&expiry=" + expiry
      let finalUrl;
      if (baseString.indexOf("?") !== -1) {
        finalUrl = baseString + rnd;
      } else {
        finalUrl = baseString + rnd + "?token=" + token + "&expiry=" + expiry;
      }

      console.log("[AhwakTV] DoodStream resolved:", finalUrl.slice(0, 120));
      return [makeStream(finalUrl, "PlayMogo", embedUrl, "mp4")];
    } catch (e) {
      console.log("[AhwakTV] DoodStream error:", e.message);
      return [];
    }
  });
}

// ============================================================
// GENERIC RESOLVER — tries to find direct video URL in embed page
// ============================================================
function resolveGeneric(embedUrl) {
  console.log("[AhwakTV] Generic:", embedUrl);
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Referer": DOMAIN + "/",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow"
      });
      const html = yield res.text();

      // Look for m3u8/mp4 in sources/file variables
      const patterns = [
        /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i,
        /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
        /["']([^"']+\.m3u8[^"']*)["']/i,
        /["']([^"']+\.mp4[^"']*)["']/i
      ];
      for (const pat of patterns) {
        const m = html.match(pat);
        if (m) {
          const url = m[1].replace(/\\\//g, "/");
          if (url.startsWith("http")) {
            const isHls = /\.m3u8/i.test(url);
            console.log("[AhwakTV] Generic found:", url.slice(0, 100));
            return [makeStream(url, hostLabel(embedUrl), embedUrl, isHls ? "hls" : "mp4")];
          }
        }
      }
      console.log("[AhwakTV] Generic: no direct URL");
      return [];
    } catch (e) {
      console.log("[AhwakTV] Generic error:", e.message);
      return [];
    }
  });
}

// Main resolver: picks the right one based on host
function resolveEmbed(embedUrl) {
  const host = hostLabel(embedUrl).toLowerCase();
  if (host.indexOf("vidmoly") !== -1) return resolveVidMoly(embedUrl);
  if (host.indexOf("playmogo") !== -1 || host.indexOf("dood") !== -1) return resolveDoodStream(embedUrl);
  return resolveGeneric(embedUrl);
}

function resolveSee(seeUrl, referer) {
  console.log("[AhwakTV] see.php:", seeUrl);
  return __async(this, null, function* () {
    try {
      const html = yield get(seeUrl, referer);
      const iframes = extractIframes(html);
      console.log("[AhwakTV] see.php iframes:", iframes.length);

      const allStreams = [];
      const seen = new Set();
      for (const iframe of iframes) {
        const resolved = yield resolveEmbed(iframe);
        for (const s of resolved) {
          if (seen.has(s.url)) continue;
          seen.add(s.url);
          allStreams.push(s);
        }
        // If resolution failed, still offer the iframe as fallback
        if (!resolved.length) {
          const fallback = makeStream(iframe, hostLabel(iframe), seeUrl, "iframe");
          if (!seen.has(fallback.url)) {
            seen.add(fallback.url);
            allStreams.push(fallback);
          }
        }
      }
      return allStreams;
    } catch (e) {
      console.log("[AhwakTV] see.php error:", e.message);
      return [];
    }
  });
}

function extractEpisodeList(html) {
  const episodes = [];
  const re = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = normalizeUrl(m[1]);
    const title = decodeHtml(m[2]);
    const numMatch = title.match(/الحلقة\s+(\d+)/);
    if (!numMatch) continue;
    const num = parseInt(numMatch[1], 10);
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
              let targetUrl = null;

              if (titleEpMatch && parseInt(titleEpMatch[1], 10) === wantedEp) {
                targetUrl = result.url;
              } else {
                const epList = extractEpisodeList(html);
                const epEntry = epList.find(e => e.num === wantedEp);
                if (epEntry) targetUrl = epEntry.url;
              }

              if (!targetUrl) continue;

              const epHtml = targetUrl === result.url ? html : yield get(targetUrl);
              const seeUrl = extractSeeUrl(epHtml);
              if (!seeUrl) continue;
              const resolved = yield resolveSee(seeUrl, targetUrl);
              for (const s of resolved) {
                if (seen.has(s.url)) continue;
                seen.add(s.url);
                streams.push(s);
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
