/**
 * TheFlixBay provider  (v3 — with VixSrc + Peachify resolution)
 *
 * VixSrc extraction (verified from yoruix/nuvio-providers):
 *  - Fetch https://vixsrc.to/movie/{tmdbId} or /tv/{tmdbId}/{s}/{e}
 *  - Parse window.masterPlaylist for url, token, expires
 *  - Build: {url}?token={token}&expires={expires}&h=1&lang=en
 *
 * Peachify extraction (verified from enc-dec.app docs):
 *  - Fetch embed page, extract encrypted payload
 *  - POST to https://enc-dec.app/api/dec-peachify with { "text": "..." }
 */

var BASE = "https://theflixbay.com";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var MIRROR_TIMEOUT = 15000;

function fetchText(url, referer, ajax) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function fetchJson(url, body, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json"
  };
  if (referer) headers["Referer"] = referer;
  return fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); });
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function normalizeTitle(str) {
  return String(str || "").toLowerCase()
    .replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = normalizeTitle(a); b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) {
    return 0.5 + 0.4 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  var aa = a.split(" "), bb = b.split(" ");
  var setB = {};
  bb.forEach(function(x) { setB[x] = 1; });
  var common = 0;
  aa.forEach(function(x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  var titles = [], year = null;
  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return fetch(apiUrl).then(function(r) { return r.json(); }).then(function(data) {
        var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
        if (title && titles.indexOf(title) === -1) titles.push(title);
        if (!year) {
          var dateStr = type === "movie" ? data.release_date : data.first_air_date;
          if (dateStr) year = dateStr.slice(0, 4);
        }
      }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    if (!titles.length) throw new Error("No TMDB titles");
    return { titles: titles, year: year };
  });
}

function searchTheFlixBay(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/index.php?menu=search&query=" + encodeURIComponent(cleanTitle);
  console.log("[TheFlixBay] Search:", cleanTitle);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [], seen = {};
    var re = /<a\s+href="(\/(?:movie|series)\/(\d+))"[^>]*title="([^"]*)"/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var id = m[2];
      if (seen[id]) continue;
      seen[id] = 1;
      results.push({ id: id, url: BASE + m[1], title: decodeHtml(m[3]), kind: m[1].indexOf("/series/") === 0 ? "series" : "movie" });
    }
    console.log("[TheFlixBay] Search results:", results.length);
    return results;
  });
}

function chooseResult(results, titles) {
  var best = null, bestScore = 0;
  results.forEach(function(r) {
    var s = 0;
    titles.forEach(function(t) {
      var sc = similarity(r.title, t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (best) console.log("[TheFlixBay] Best:", best.title, "score:", bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

function extractTmdbId(html) {
  var m = html.match(/["']t["']\s*:\s*["'](\d{3,10})["']/);
  if (m) return m[1];
  m = html.match(/"t"\s*:\s*"?(\d{3,10})"?/);
  if (m) return m[1];
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// VIXSRC EXTRACTION
// ═══════════════════════════════════════════════════════════════════════

function extractVixSrc(tmdbId, isTv, season, episode, embedUrl) {
  var url = isTv
    ? "https://vixsrc.to/tv/" + tmdbId + "/" + season + "/" + episode
    : "https://vixsrc.to/movie/" + tmdbId;
  console.log("[TheFlixBay] VixSrc:", url);
  return fetchText(url, embedUrl || "https://vixsrc.to/").then(function(html) {
    if (html.indexOf("window.masterPlaylist") !== -1) {
      var urlMatch = html.match(/url:\s*['"]([^'"]+)['"]/);
      var tokenMatch = html.match(/['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/);
      var expiresMatch = html.match(/['"]?expires['"]?\s*:\s*['"]([^'"]+)['"]/);
      if (urlMatch && tokenMatch && expiresMatch) {
        var baseUrl = urlMatch[1], token = tokenMatch[1], expires = expiresMatch[1];
        var m3u8 = baseUrl.indexOf("?b=1") !== -1
          ? baseUrl + "&token=" + token + "&expires=" + expires + "&h=1&lang=en"
          : baseUrl + "?token=" + token + "&expires=" + expires + "&h=1&lang=en";
        console.log("[TheFlixBay] VixSrc m3u8:", m3u8);
        return [m3u8];
      }
    }
    var m3u8Match = html.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/);
    if (m3u8Match) return [m3u8Match[1]];
    return [];
  }).catch(function(e) {
    console.log("[TheFlixBay] VixSrc failed:", e.message);
    return [];
  });
}

// ═══════════════════════════════════════════════════════════════════════
// PEACHIFY EXTRACTION
// ═══════════════════════════════════════════════════════════════════════

function extractPeachify(embedUrl, tmdbId, isTv, season, episode) {
  console.log("[TheFlixBay] Peachify:", embedUrl);
  return fetchText(embedUrl, BASE + "/").then(function(html) {
    // Look for the encrypted payload — usually a long base64 string
    var payloads = [];
    var re = /["']([A-Za-z0-9+\/]{40,}={0,2})["']/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      payloads.push(m[1]);
    }
    if (!payloads.length) {
      console.log("[TheFlixBay] Peachify: no encrypted payload found");
      return [];
    }
    console.log("[TheFlixBay] Peachify: " + payloads.length + " payloads found");

    // Decrypt each via enc-dec.app
    return Promise.all(payloads.slice(0, 5).map(function(p) {
      return fetchJson("https://enc-dec.app/api/dec-peachify", { text: p }, embedUrl)
        .then(function(res) {
          // Response may contain the m3u8 directly
          if (typeof res === "string") return res;
          if (res && res.url) return res.url;
          if (res && res.m3u8) return res.m3u8;
          return null;
        }).catch(function() { return null; });
    })).then(function(results) {
      var valid = results.filter(function(u) { return u && /\.m3u8|\.mp4/i.test(u); });
      console.log("[TheFlixBay] Peachify: " + valid.length + " valid streams");
      return valid;
    });
  }).catch(function(e) {
    console.log("[TheFlixBay] Peachify failed:", e.message);
    return [];
  });
}

// ═══════════════════════════════════════════════════════════════════════
// STREAM BUILDER
// ═══════════════════════════════════════════════════════════════════════

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "2160p";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  return "Auto";
}

function buildStream(url, label, referer) {
  if (url.indexOf("http://") === 0) url = "https://" + url.slice(7);
  var isHls = /\.m3u8/i.test(url);
  var origin = (referer || "").match(/^(https?:\/\/[^\/]+)/i);
  var streamReferer = origin ? origin[1] + "/" : BASE + "/";
  return {
    name: "🎬 TheFlixBay " + label,
    title: "🎬 TheFlixBay • " + label,
    url: url,
    quality: qualityFromUrl(url),
    size: "Unknown",
    type: isHls ? "hls" : "mp4",
    headers: {
      "User-Agent": UA,
      "Referer": streamReferer,
      "Origin": origin ? origin[1] : BASE,
      "Accept": "*/*"
    },
    provider: "theflixbay"
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN RESOLVER
// ═══════════════════════════════════════════════════════════════════════

function resolveVid(id, kind, season, episode) {
  var pageUrl = kind === "series" ? BASE + "/series/" + id : BASE + "/movie/" + id;
  console.log("[TheFlixBay] Resolving:", pageUrl);

  return fetchText(pageUrl, BASE + "/").then(function(html) {
    var tmdbId = extractTmdbId(html);
    if (!tmdbId) {
      console.log("[TheFlixBay] No TMDB ID found");
      return [];
    }
    console.log("[TheFlixBay] TMDB ID:", tmdbId);

    var isTv = kind === "series";

    // Run VixSrc and Peachify in parallel
    return Promise.all([
      extractVixSrc(tmdbId, isTv, season || 1, episode || 1),
      extractPeachify("https://peachify.top/embed/movie/" + tmdbId, tmdbId, isTv, season, episode)
    ]).then(function(results) {
      var streams = [];
      var seen = {};
      results[0].forEach(function(u) {
        if (seen[u]) return;
        seen[u] = 1;
        streams.push(buildStream(u, "VixSrc", "https://vixsrc.to/"));
      });
      results[1].forEach(function(u) {
        if (seen[u]) return;
        seen[u] = 1;
        streams.push(buildStream(u, "Peachify", "https://peachify.top/"));
      });
      console.log("[TheFlixBay] Total streams:", streams.length);
      return streams;
    });
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchTheFlixBay(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [], seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.id]) { seen[r.id] = 1; all.push(r); }
        });
      });
      if (!all.length) return [];
      var best = chooseResult(all, meta.titles);
      if (!best) return [];
      return resolveVid(best.id, best.kind);
    });
  }).catch(function(err) {
    console.log("[TheFlixBay] Movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var wanted = Number(episode) || 1;
  var wantedSeason = Number(season) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchTheFlixBay(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [], seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.id]) { seen[r.id] = 1; all.push(r); }
        });
      });
      var series = all.filter(function(r) { return r.kind === "series"; });
      var pool = series.length ? series : all;
      if (!pool.length) return [];
      var best = chooseResult(pool, meta.titles);
      if (!best) return [];
      return resolveVid(best.id, best.kind, wantedSeason, wanted);
    });
  }).catch(function(err) {
    console.log("[TheFlixBay] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[TheFlixBay] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
