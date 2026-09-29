"use strict";

var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try { step(generator.next(value)); } catch (e) { reject(e); }
    };
    var rejected = (value) => {
      try { step(generator.throw(value)); } catch (e) { reject(e); }
    };
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

// Extract all watch.php?vid= links from any HTML page
function extractWatchLinks(html) {
  const results = [];
  // Pattern 1: href="watch.php?vid=X" title="Y"
  const re1 = /href="([^"]*watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    let url = decodeHtml(m[1]);
    const title = decodeHtml(m[2]);
    if (!url.startsWith("http")) url = DOMAIN + "/" + url.replace(/^\//, "");
    if (!results.find(r => r.url === url)) results.push({ url, title });
  }
  // Pattern 2: href="watch.php?vid=X" anywhere — no title attr (fallback)
  if (!results.length) {
    const re2 = /href="([^"]*watch\.php\?vid=[A-Za-z0-9]+)"/gi;
    while ((m = re2.exec(html)) !== null) {
      let url = decodeHtml(m[1]);
      if (!url.startsWith("http")) url = DOMAIN + "/" + url.replace(/^\//, "");
      if (!results.find(r => r.url === url)) results.push({ url, title: "" });
    }
  }
  return results;
}

// Search and return watch links
function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?q=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Search URL:", url);
    const html = yield get(url);
    return extractWatchLinks(html);
  });
}

// Get see.php?vid= URL from a watch.php page
function extractSeeUrl(html, watchUrl) {
  // Confirmed pattern: see.php?vid=XXXXX appears multiple times
  const m = html.match(/(?:https?:\/\/yam\.ahwaktv\.net\/)?see\.php\?vid=([A-Za-z0-9]+)/);
  if (!m) return null;
  return `${DOMAIN}/see.php?vid=${m[1]}`;
}

// Get serie ID from a watch.php page
function extractSerieId(html) {
  const m = html.match(/view-serie\.php\?id=(\d+)/);
  return m ? m[1] : null;
}

// Get episode watch URL from serie page by episode number
function getEpisodeUrl(serieId, wantedEp) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/view-serie.php?id=${serieId}`;
    console.log("[AhwakTV] Serie page:", url);
    const html = yield get(url);

    // Links + titles from serie page
    const links = extractWatchLinks(html);
    console.log("[AhwakTV] Serie links found:", links.length);

    for (const link of links) {
      // Match الحلقة N in title
      const epMatch = link.title.match(/الحلقة\s+(\d+)/);
      if (epMatch && parseInt(epMatch[1], 10) === wantedEp) {
        console.log("[AhwakTV] Found ep", wantedEp, "at", link.url);
        return link.url;
      }
    }

    // Fallback: if titles are empty, try ordering (ep N = index N-1)
    if (links.length >= wantedEp) {
      console.log("[AhwakTV] Fallback: using index", wantedEp - 1);
      return links[wantedEp - 1].url;
    }

    return null;
  });
}

function makeStream(seeUrl, label, watchUrl) {
  return {
    name: "🌙 AhwakTV",
    title: `🌙 AhwakTV • ${label}`,
    url: seeUrl,
    quality: "Auto",
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": watchUrl || (DOMAIN + "/")
    }
  };
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
        console.log("[AhwakTV] Searching:", title);
        const results = yield searchSite(title);
        console.log("[AhwakTV] Results:", results.length);
        if (!results.length) continue;

        if (mediaType === "movie") {
          // Each result is a direct episode/movie watch page
          for (const result of results.slice(0, 3)) {
            try {
              const html = yield get(result.url);
              const seeUrl = extractSeeUrl(html, result.url);
              if (!seeUrl || seen.has(seeUrl)) continue;
              seen.add(seeUrl);
              streams.push(makeStream(seeUrl, "فيلم", result.url));
              console.log("[AhwakTV] Movie stream:", seeUrl);
            } catch (e) {
              console.log("[AhwakTV] Movie error:", e.message);
            }
          }
        } else {
          // TV: find serie ID, then get correct episode
          for (const result of results.slice(0, 5)) {
            try {
              const html = yield get(result.url);
              const serieId = extractSerieId(html);
              if (!serieId) {
                // This watch page itself might be the right episode
                // Check title for episode number match
                const epInTitle = result.title.match(/الحلقة\s+(\d+)/);
                if (epInTitle && parseInt(epInTitle[1], 10) === wantedEp) {
                  const seeUrl = extractSeeUrl(html, result.url);
                  if (seeUrl && !seen.has(seeUrl)) {
                    seen.add(seeUrl);
                    streams.push(makeStream(seeUrl, `الحلقة ${wantedEp}`, result.url));
                    console.log("[AhwakTV] TV direct stream:", seeUrl);
                  }
                }
                continue;
              }
              console.log("[AhwakTV] Serie ID:", serieId);
              const epUrl = yield getEpisodeUrl(serieId, wantedEp);
              if (!epUrl) continue;
              const epHtml = yield get(epUrl);
              const seeUrl = extractSeeUrl(epHtml, epUrl);
              if (!seeUrl || seen.has(seeUrl)) continue;
              seen.add(seeUrl);
              streams.push(makeStream(seeUrl, `الحلقة ${wantedEp}`, epUrl));
              console.log("[AhwakTV] TV stream:", seeUrl);
              break;
            } catch (e) {
              console.log("[AhwakTV] TV error:", e.message);
            }
          }
        }

        if (streams.length) break;
      } catch (e) {
        console.log("[AhwakTV] Search error:", title, e.message);
      }
    }

    console.log("[AhwakTV] Final streams:", streams.length);
    return streams;
  });
}

module.exports = { getStreams };
