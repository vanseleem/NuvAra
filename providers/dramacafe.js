/**
 * Dramacafe ☕ — Nuvio Provider
 * Arabic-dubbed Turkish / Korean / Indian / Arabic content.
 *
 * Flow:
 *   tmdbId -> TMDB API -> titles[] -> Dramacafe search -> content page -> stream URL
 *
 * NOTE: BASE_URL rotates frequently (.bar / .top / .baby / .fun ...). Update as needed.
 */

var BASE_URL = "https://ddramacafe-tv.bar";
var TMDB_KEY = "83d364331c40bfbe29858aeed82f45cc";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/* ------------------------------------------------------------------ */
/*  PUBLIC ENTRY                                                       */
/* ------------------------------------------------------------------ */

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[Dramacafe] " + mediaType + " tmdb=" + tmdbId +
              (season ? " S" + season + "E" + episode : ""));

  return fetchTitles(tmdbId, mediaType)
    .then(function (titles) {
      if (!titles.length) throw new Error("No titles from TMDB");
      console.log("[Dramacafe] Titles: " + titles.join(" | "));
      return searchAllTitles(titles, mediaType, season, episode);
    })
    .then(function (result) {
      if (!result) {
        console.log("[Dramacafe] No match on site");
        return [];
      }
      return fetchStream(result.url, result.type, season, episode);
    })
    .catch(function (e) {
      console.error("[Dramacafe] " + e.message);
      return [];
    });
}

/* ------------------------------------------------------------------ */
/*  1. TMDB -> titles                                                  */
/* ------------------------------------------------------------------ */

function fetchTitles(tmdbId, mediaType) {
  var path = mediaType === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + path + "/" + tmdbId +
            "?api_key=" + TMDB_KEY + "&language=ar";

  return fetch(url, { headers: { "User-Agent": UA } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var out = [];
      // Arabic title first (site is Arabic), then original, then English
      [d.title, d.name, d.original_title, d.original_name].forEach(function (t) {
        if (t && out.indexOf(t) === -1) out.push(t);
      });
      return out;
    });
}

/* ------------------------------------------------------------------ */
/*  2. Search Dramacafe with each title variant                        */
/* ------------------------------------------------------------------ */

function searchAllTitles(titles, mediaType, season, episode) {
  // Try Arabic search endpoint variants in order.
  // Most Arabic WordPress-style sites accept /?s=QUERY
  var i = 0;

  function tryNext() {
    if (i >= titles.length) return Promise.resolve(null);
    var q = titles[i++];
    var url = BASE_URL + "/?s=" + encodeURIComponent(q);

    return fetch(url, { headers: { "User-Agent": UA, "Referer": BASE_URL } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var hit = parseSearch(html, q, mediaType, season, episode);
        if (hit) return hit;
        return tryNext();
      });
  }

  return tryNext();
}

/* ------------------------------------------------------------------ */
/*  3. Parse search results                                            */
/* ------------------------------------------------------------------ */

function parseSearch(html, title, mediaType, season, episode) {
  // Grab all anchors with href + text
  var re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m, candidates = [];

  while ((m = re.exec(html)) !== null) {
    var href = m[1];
    var text = m[2].replace(/<[^>]+>/g, "").trim();
    if (!href || !text) continue;

    // Skip nav / category / non-content links
    if (/\/(category|tag|page|author|wp-|feed)\//i.test(href)) continue;
    if (/^(#|javascript:)/i.test(href)) continue;

    // Normalised match: both title & anchor contain each other
    var t = title.toLowerCase();
    var a = text.toLowerCase();
    var score = 0;
    if (a === t) score = 3;
    else if (a.indexOf(t) !== -1 || t.indexOf(a) !== -1) score = 2;
    else {
      // token overlap
      var toks = t.split(/\s+/).filter(function (x) { return x.length > 2; });
      var hitCount = toks.filter(function (x) { return a.indexOf(x) !== -1; }).length;
      if (toks.length && hitCount / toks.length >= 0.6) score = 1;
    }
    if (score > 0) candidates.push({ href: href, text: text, score: score });
  }

  if (!candidates.length) return null;

  // Pick highest score, prefer /series/ or /movie/ or /watch/ URLs
  candidates.sort(function (a, b) {
    var pa = /\/(series|movie|film|watch|episode|moslsl|film)\//i.test(a.href) ? 1 : 0;
    var pb = /\/(series|movie|film|watch|episode|moslsl|film)\//i.test(b.href) ? 1 : 0;
    return (b.score + pb) - (a.score + pa);
  });

  var best = candidates[0];
  var fullUrl = best.href.indexOf("http") === 0 ? best.href : BASE_URL + best.href;

  return { url: fullUrl, type: mediaType };
}

/* ------------------------------------------------------------------ */
/*  4. Fetch content page → episode (if TV) → stream URL               */
/* ------------------------------------------------------------------ */

function fetchStream(url, mediaType, season, episode) {
  return fetch(url, { headers: { "User-Agent": UA, "Referer": BASE_URL } })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      if (mediaType === "tv" && season && episode) {
        var epUrl = findEpisodeUrl(html, url, season, episode);
        if (epUrl) {
          return fetch(epUrl, { headers: { "User-Agent": UA, "Referer": url } })
            .then(function (r) { return r.text(); })
            .then(function (epHtml) { return buildStreams(epHtml, epUrl); });
        }
        console.log("[Dramacafe] Episode link not found, using series page");
      }
      return buildStreams(html, url);
    });
}

function findEpisodeUrl(html, baseUrl, season, episode) {
  // Arabic sites often label: "الحلقة 5" or "الحلقة الخامسة", plus "S01E05"
  var ep = parseInt(episode, 10);
  var se = parseInt(season, 10);

  // Build a list of patterns to search for
  var patterns = [
    new RegExp("الحلقة\\s*0?" + ep + "\\b", "i"),
    new RegExp("S0?" + se + "E0?" + ep + "\\b", "i"),
    new RegExp("\\bE0?" + ep + "\\b", "i")
  ];

  var re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var href = m[1];
    var text = m[2].replace(/<[^>]+>/g, "").trim();
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(text) || patterns[i].test(href)) {
        return href.indexOf("http") === 0 ? href : BASE_URL + href;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  5. Extract stream URL from watch/episode page                      */
/* ------------------------------------------------------------------ */

function buildStreams(html, pageUrl) {
  var url = extractStreamUrl(html);
  if (!url) return [];

  // Resolve relative URLs
  if (url.indexOf("//") === 0) url = "https:" + url;
  else if (url.indexOf("/") === 0) url = BASE_URL + url;

  return [{
    name: "Dramacafe ☕",
    title: "Dramacafe",
    url: url,
    quality: "HD",
    type: url.indexOf(".m3u8") !== -1 ? "hls" : "mp4",
    headers: {
      "User-Agent": UA,
      "Referer": pageUrl
    }
  }];
}

function extractStreamUrl(html) {
  var patterns = [
    /(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/i,
    /(https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*)/i,
    /["']file["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /(?:var|let|const)\s+(?:streamUrl|file|source|src|url)\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /<source[^>]+src=["']([^"']+)["']/i,
    /data-(?:src|url|stream|file)\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i
  ];

  for (var i = 0; i < patterns.length; i++) {
    var m = patterns[i].exec(html);
    if (m) return m[1];
  }

  // Fallback: decode base64 blobs that often hide the m3u8
  var b64re = /atob\(\s*["']([A-Za-z0-9+/=]{40,})["']\s*\)/g;
  var b;
  while ((b = b64re.exec(html)) !== null) {
    try {
      var dec = decodeBase64(b[1]);
      var inner = /(https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)[^\s"'<>\\]*)/i.exec(dec);
      if (inner) return inner[1];
    } catch (e) { /* ignore */ }
  }
  return null;
}

/* Minimal base64 decoder (Hermes-safe, no Node crypto) */
function decodeBase64(str) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var out = "";
  var i = 0;
  str = str.replace(/=+$/, "");
  while (i < str.length) {
    var c1 = chars.indexOf(str.charAt(i++));
    var c2 = chars.indexOf(str.charAt(i++));
    var c3 = chars.indexOf(str.charAt(i++));
    var c4 = chars.indexOf(str.charAt(i++));
    out += String.fromCharCode((c1 << 2) | (c2 >> 4));
    if (c3 !== 64 && c3 !== -1) out += String.fromCharCode(((c2 & 15) << 4) | (c3 >> 2));
    if (c4 !== 64 && c4 !== -1) out += String.fromCharCode(((c3 & 3) << 6) | c4);
  }
  return out;
}

/* ------------------------------------------------------------------ */
module.exports = { getStreams: getStreams };
