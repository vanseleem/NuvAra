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

// Search returns watch.php links with episode title in the title attribute
// Pattern from real HTML: href="watch.php?vid=Ebbc5101f" title="مسلسل ... الحلقة 4"
function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?q=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Searching:", url);
    const html = yield get(url);
    const results = [];

    // Primary pattern: title attr present
    const re1 = /href="(watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
    let m;
    while ((m = re1.exec(html)) !== null) {
      const watchUrl = `${DOMAIN}/${m[1]}`;
      const title = decodeHtml(m[2]);
      if (!results.find(r => r.url === watchUrl)) {
        results.push({ url: watchUrl, title });
      }
    }

    // Fallback: no title attr, grab any watch link
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

// Extract see.php URL from a watch page
// Confirmed: appears as full URL https://yam.ahwaktv.net/see.php?vid=Ebbc5101f
function extractSeeUrl(html) {
  const m = html.match(/https?:\/\/yam\.ahwaktv\.net\/see\.php\?vid=([A-Za-z0-9]+)/);
  if (m) return m[0];
  // relative fallback
  const m2 = html.match(/['"](\/see\.php\?vid=[A-Za-z0-9]+)['"]/);
  if (m2) return DOMAIN + m2[1];
  return null;
}

// Extract the episode list from a watch page
// Pattern confirmed: [*N*حلقة](watch.php?vid=XXX title="...")
// or: href="watch.php?vid=XXX" title="... الحلقة N ..."
function extractEpisodeList(html) {
  const episodes = [];

  // Pattern 1: [*N*حلقة](watch.php?vid=XXX "title")  ← from serie episode grid
  const re1 = /\[\*(\d+)\*[^\]]*\]\(([^)? ]+watch\.php\?vid=[A-Za-z0-9]+)[^)]*\)/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const num = parseInt(m[1], 10);
    let url = decodeHtml(m[2]);
    if (!url.startsWith("http")) url = DOMAIN + "/" + url.replace(/^\//, "");
    if (!episodes.find(e => e.num === num)) {
      episodes.push({ num, url });
    }
  }

  // Pattern 2: href="watch.php?vid=XXX" title="... الحلقة N ..."
  if (!episodes.length) {
    const re2 = /href="(watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
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
  }

  return episodes;
}

function makeStream(seeUrl, label, referer) {
  return {
    name: "🌙 AhwakTV",
    title: `🌙 AhwakTV • ${label}`,
    url: seeUrl,
    quality: "Auto",
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": referer || (DOMAIN + "/")
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
        const results = yield searchSite(title);
        if (!results.length) continue;

        if (mediaType === "movie") {
          // Each search result IS the movie watch page — grab first valid one
          for (const result of results.slice(0, 3)) {
            try {
              const html = yield get(result.url);
              const seeUrl = extractSeeUrl(html);
              if (!seeUrl || seen.has(seeUrl)) continue;
              seen.add(seeUrl);
              streams.push(makeStream(seeUrl, "فيلم", result.url));
              console.log("[AhwakTV] Movie:", seeUrl);
            } catch (e) {
              console.log("[AhwakTV] Movie page error:", e.message);
            }
          }

        } else {
          // TV: search returns individual episode pages
          // Each watch page has the full episode list for the series
          // Strategy: load first result, extract episode list, find wantedEp
          for (const result of results.slice(0, 3)) {
            try {
              const html = yield get(result.url);

              // Check: does this page's title match wantedEp directly?
              const titleEpMatch = result.title.match(/الحلقة\s+(\d+)/);
              if (titleEpMatch && parseInt(titleEpMatch[1], 10) === wantedEp) {
                // This IS the episode we want
                const seeUrl = extractSeeUrl(html);
                if (seeUrl && !seen.has(seeUrl)) {
                  seen.add(seeUrl);
                  streams.push(makeStream(seeUrl, `الحلقة ${wantedEp}`, result.url));
                  console.log("[AhwakTV] TV direct hit ep", wantedEp, ":", seeUrl);
                  break;
                }
              }

              // Extract episode list from this page and find wantedEp
              const epList = extractEpisodeList(html);
              console.log("[AhwakTV] Episode list found:", epList.length, "eps");

              const epEntry = epList.find(e => e.num === wantedEp);
              if (epEntry) {
                // Fetch that episode's watch page
                const epHtml = epEntry.url === result.url
                  ? html
                  : yield get(epEntry.url);
                const seeUrl = extractSeeUrl(epHtml);
                if (seeUrl && !seen.has(seeUrl)) {
                  seen.add(seeUrl);
                  streams.push(makeStream(seeUrl, `الحلقة ${wantedEp}`, epEntry.url));
                  console.log("[AhwakTV] TV from list ep", wantedEp, ":", seeUrl);
                }
                break;
              }

              // If episode list is available but wantedEp not in it → wrong series, skip
              if (epList.length > 0) continue;

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
