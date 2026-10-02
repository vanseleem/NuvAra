/**
 * RidoMovies provider  (v2 — corrected from Streamflix source)
 *
 * REAL API (verified from stantanasi/streamflix RidomoviesProvider.kt):
 *  - Search:       GET /core/api/search?q={query}
 *  - Movie videos: GET /core/api/movies/{slug}/videos
 *  - TV seasons:   GET /core/api/series/{slug}/seasons
 *  - Episodes:     GET /core/api/series/{slug}/seasons/{seasonId}/episodes
 *  - Ep videos:    GET /core/api/episodes/{id}/videos
 *
 * The `url` field in video responses contains HTML: <iframe data-src="...">
 * The `data-src` is the embed URL (closeload.top / ridorapid.closeload.top).
 *
 * My previous version guessed /api/player-url + data-player-token — both wrong.
 */

var BASE = "https://ridomovies.tv";
var PROVIDER_ID = "ridomovies";
var PROVIDER_NAME = "🎬 RidoMovies";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var MATCH_THRESHOLD = 0.35;
var FETCH_TIMEOUT_MS = 15000;

function log(m) { console.log("[RidoMovies] " + m); }

// ---------------------------------------------------------------- http
function withTimeout(promise, ms) {
  if (typeof setTimeout !== "function") return promise;
  return new Promise(function(resolve, reject) {
    var done = false;
    var t = setTimeout(function() {
      if (!done) { done = true; reject(new Error("timeout")); }
    }, ms);
    promise.then(function(v) {
      if (!done) { done = true; if (typeof clearTimeout === "function") clearTimeout(t); resolve(v); }
    }, function(e) {
      if (!done) { done = true; if (typeof clearTimeout === "function") clearTimeout(t); reject(e); }
    });
  });
}

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  return withTimeout(
    fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }),
    FETCH_TIMEOUT_MS
  );
}

function fetchJson(url, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*"
  };
  if (referer) headers["Referer"] = referer;
  return withTimeout(
    fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }),
    FETCH_TIMEOUT_MS
  );
}

// ---------------------------------------------------------------- helpers
function decodeHtml(str) {
  return String(str || "")
    .replace(/&#x([0-9a-f]+);/gi, function(_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function normalizeTitle(str) {
  return String(str || "").toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = normalizeTitle(a); b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  var shortS = a.length <= b.length ? a : b;
  var longS = a.length <= b.length ? b : a;
  if ((" " + longS + " ").indexOf(" " + shortS + " ") !== -1) {
    return 0.55 + 0.35 * (shortS.length / longS.length);
  }
  var aa = a.split(" "); var bb = b.split(" ");
  var setB = {}; bb.forEach(function(x) { setB[x] = 1; });
  var common = 0;
  aa.forEach(function(x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

function originOf(url) {
  var m = String(url || "").match(/^(https?:\/\/[^\/]+)/i);
  return m ? m[1] : "";
}

function hostOf(url) {
  var m = String(url || "").match(/^https?:\/\/([^\/:?#]+)/i);
  return m ? m[1].replace(/^www\./, "") : "";
}

// ---------------------------------------------------------------- TMDB
function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["en", "ar"];
  var titles = [];
  var year = null;
  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + TMDB_API_KEY + "&language=" + lang;
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
    if (!titles.length) throw new Error("No TMDB titles for " + tmdbId);
    log("TMDB titles: " + titles.join(" | "));
    return { titles: titles, year: year };
  });
}

// ---------------------------------------------------------------- search API
// GET /core/api/search?q={query}
// Response: { code, message, data: { items: [{ slug, title, type, ... }] } }
function searchRidoMovies(query) {
  var q = String(query || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/core/api/search?q=" + encodeURIComponent(q);
  log("Search: " + q);
  return fetchJson(url, BASE + "/").then(function(res) {
    var items = (res && res.data && res.data.items) || [];
    log("Search results: " + items.length);
    return items.map(function(it) {
      return {
        slug: it.slug || it.fullSlug,
        title: it.title || (it.contentable && it.contentable.originalTitle) || "",
        type: it.type || "",
        year: (it.contentable && it.contentable.releaseYear) || ""
      };
    }).filter(function(x) { return x.slug && x.title; });
  }).catch(function(e) {
    log("Search failed: " + e.message);
    return [];
  });
}

function searchMany(titles) {
  return Promise.all(titles.map(function(t) {
    return searchRidoMovies(t);
  })).then(function(groups) {
    var all = []; var seen = {};
    groups.forEach(function(g) {
      g.forEach(function(r) {
        var k = r.slug;
        if (!seen[k]) { seen[k] = 1; all.push(r); }
      });
    });
    log("Unique candidates: " + all.length);
    return all;
  });
}

function chooseResult(results, titles) {
  var best = null; var bestScore = 0;
  results.forEach(function(r) {
    var s = 0;
    titles.forEach(function(t) {
      var sc = similarity(r.title, t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (best) log("Best: " + best.title + " (" + best.slug + ") score=" + bestScore.toFixed(3));
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

// ---------------------------------------------------------------- video API
// GET /core/api/movies/{slug}/videos
// Response: { data: [{ id, link, lang, quality, url }] }
//   url = HTML string like: <iframe data-src="https://closeload.top/..."></iframe>
function extractIframeSrc(html) {
  var s = String(html || "");
  // Primary: data-src (what Streamflix uses)
  var m = s.match(/<iframe[^>]*\sdata-src\s*=\s*["']([^"']+)["']/i);
  if (m) return decodeHtml(m[1]);
  // Fallback: src
  m = s.match(/<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  if (m) return decodeHtml(m[1]);
  // Fallback: any https URL in the string
  m = s.match(/(https?:\/\/[^"'\s<>]+)/i);
  if (m) return m[1];
  return null;
}

function getMovieVideos(slug) {
  var url = BASE + "/core/api/movies/" + encodeURIComponent(slug) + "/videos";
  log("Movie videos API: " + url);
  return fetchJson(url, BASE + "/movies/" + slug).then(function(res) {
    var videos = (res && res.data) || [];
    log("Video entries: " + videos.length);
    var servers = [];
    videos.forEach(function(v) {
      var src = extractIframeSrc(v.url);
      if (!src) return;
      if (src.indexOf("//") === 0) src = "https:" + src;
      if (src.indexOf("http") !== 0) return;
      servers.push({
        id: v.id,
        quality: v.quality || "Auto",
        lang: v.lang || "",
        url: src,
        host: hostOf(src)
      });
    });
    log("Extracted servers: " + servers.length + " [" + servers.map(function(s) { return s.host + "/" + s.quality; }).join(", ") + "]");
    return servers;
  }).catch(function(e) {
    log("Movie videos failed: " + e.message);
    return [];
  });
}

function getEpisodeVideos(episodeId) {
  var url = BASE + "/core/api/episodes/" + encodeURIComponent(episodeId) + "/videos";
  log("Episode videos API: " + url);
  return fetchJson(url, BASE + "/").then(function(res) {
    var videos = (res && res.data) || [];
    var servers = [];
    videos.forEach(function(v) {
      var src = extractIframeSrc(v.url);
      if (!src) return;
      if (src.indexOf("//") === 0) src = "https:" + src;
      if (src.indexOf("http") !== 0) return;
      servers.push({
        id: v.id,
        quality: v.quality || "Auto",
        lang: v.lang || "",
        url: src,
        host: hostOf(src)
      });
    });
    log("Episode servers: " + servers.length);
    return servers;
  }).catch(function(e) {
    log("Episode videos failed: " + e.message);
    return [];
  });
}

// TV: get seasons, then find the episode, then get its videos
function getTvServers(slug, season, episode) {
  var seasonsUrl = BASE + "/core/api/series/" + encodeURIComponent(slug) + "/seasons";
  log("Seasons API: " + seasonsUrl);
  return fetchJson(seasonsUrl, BASE + "/tv/" + slug).then(function(res) {
    var seasons = (res && res.data && res.data.items) || [];
    log("Seasons: " + seasons.length);
    var target = seasons.filter(function(s) {
      return String(s.seasonNumber) === String(season);
    })[0];
    if (!target) {
      log("Season " + season + " not found");
      return [];
    }
    var epsUrl = BASE + "/core/api/series/" + encodeURIComponent(slug) +
      "/seasons/" + encodeURIComponent(target.id) + "/episodes";
    log("Episodes API: " + epsUrl);
    return fetchJson(epsUrl, BASE + "/tv/" + slug).then(function(epsRes) {
      var episodes = (epsRes && epsRes.data && epsRes.data.items) || [];
      log("Episodes: " + episodes.length);
      var targetEp = episodes.filter(function(e) {
        return String(e.episodeNumber) === String(episode);
      })[0];
      if (!targetEp) {
        log("Episode " + episode + " not found");
        return [];
      }
      return getEpisodeVideos(targetEp.id);
    });
  }).catch(function(e) {
    log("TV API failed: " + e.message);
    return [];
  });
}

// ---------------------------------------------------------------- closeload extractor
// Streamflix uses ROT13 -> Base64 -> Reverse (Smart Brute Force).
// We try all permutations of those transforms.

function rot13(s) {
  return String(s).replace(/[a-zA-Z]/g, function(c) {
    var base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function b64decode(s) {
  try {
    if (typeof atob === "function") return atob(s);
    if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("binary");
  } catch (e) {}
  return "";
}

function reverse(s) {
  return String(s).split("").reverse().join("");
}

function smartDecode(input) {
  var transforms = [
    { name: "rot13", fn: rot13 },
    { name: "b64", fn: b64decode },
    { name: "rev", fn: reverse }
  ];
  var seen = {};
  seen[input] = 1;
  var candidates = [input];
  var urls = [];

  for (var depth = 0; depth < 4; depth++) {
    var next = [];
    for (var ci = 0; ci < candidates.length; ci++) {
      var c = candidates[ci];
      for (var ti = 0; ti < transforms.length; ti++) {
        var t = transforms[ti];
        var out;
        try { out = t.fn(c); } catch (e) { continue; }
        if (!out || out === c || out.length < 8) continue;
        if (seen[out]) continue;
        seen[out] = 1;
        next.push(out);
        // Extract any URLs
        var re = /https?:\/\/[^"'\s<>\\]+/gi;
        var m;
        while ((m = re.exec(out)) !== null) {
          if (urls.indexOf(m[0]) === -1) urls.push(m[0]);
        }
        // Also check for direct m3u8/mp4 markers
        if (/\.m3u8|\.mp4/i.test(out)) {
          var re2 = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
          while ((m = re2.exec(out)) !== null) {
            if (urls.indexOf(m[0]) === -1) urls.push(m[0]);
          }
        }
      }
    }
    candidates = next;
    if (urls.length) break;
  }
  return urls;
}

function extractCloseload(embedUrl, referer) {
  log("Closeload: " + embedUrl);
  return fetchText(embedUrl, referer).then(function(html) {
    var urls = [];

    // Direct m3u8/mp4 in page
    var re = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
    var m;
    while ((m = re.exec(html)) !== null) urls.push(m[0]);

    // Packed eval
    if (!urls.length) {
      var unpacked = unpackAll(html);
      if (unpacked) {
        var re2 = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
        while ((m = re2.exec(unpacked)) !== null) urls.push(m[0]);
      }
    }

    // Encoded strings
    if (!urls.length) {
      var reEnc = /["']([A-Za-z0-9+\/=_-]{30,})["']/g;
      while ((m = reEnc.exec(html)) !== null) {
        smartDecode(m[1]).forEach(function(u) {
          if (urls.indexOf(u) === -1) urls.push(u);
        });
      }
    }

    log("Closeload streams: " + urls.length);
    return urls;
  }).catch(function(e) {
    log("Closeload failed: " + e.message);
    return [];
  });
}

// ---------------------------------------------------------------- p.a.c.k.e.r
function packerEncode(c, a) {
  return (c < a ? "" : packerEncode(parseInt(c / a, 10), a)) +
    ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
}

function unpackAll(html) {
  var out = [];
  var re = /eval\(function\(p,a,c,k,e,(?:d|r)\)\{[\s\S]*?\}\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\s*\.split\('\|'\)/g;
  var m;
  html = String(html || "");
  while ((m = re.exec(html)) !== null) {
    var payload = m[1].replace(/\\(?:u([0-9a-fA-F]{4})|([\s\S]))/g, function(_, hex, ch) {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (ch === "n") return "\n";
      if (ch === "t") return "\t";
      return ch;
    });
    var base = parseInt(m[2], 10);
    var count = parseInt(m[3], 10);
    var keywords = m[4].split("|");
    while (count--) {
      if (keywords[count]) {
        var key = keywords[count];
        var pat = new RegExp("\\b" + packerEncode(count, base) + "\\b", "g");
        payload = payload.replace(pat, function() { return key; });
      }
    }
    out.push(payload);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- build streams
function qualityFromUrl(url, fallback) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "2160p";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  return fallback || "Auto";
}

function serverLabelFromUrl(url) {
  var h = hostOf(url).toLowerCase();
  if (/closeload/.test(h)) return "Closeload";
  if (/ridorapid/.test(h)) return "RidoRapid";
  if (/vidsrc/.test(h)) return "Vidsrc";
  if (/voe\.sx/.test(h)) return "Voe";
  if (/filemoon/.test(h)) return "Filemoon";
  return h.split(".").slice(-2, -1)[0] || h;
}

function buildStreams(servers, pageUrl, tag) {
  // servers: [{ url, quality, lang, host }]
  // Each server is an iframe URL from the API. Try to resolve to direct m3u8.
  return Promise.all(servers.map(function(srv) {
    return extractCloseload(srv.url, pageUrl).then(function(directUrls) {
      var items = [];
      if (directUrls.length) {
        directUrls.forEach(function(u) {
          items.push({
            url: u,
            quality: qualityFromUrl(u, srv.quality),
            label: serverLabelFromUrl(u) + " " + (srv.quality || ""),
            direct: true
          });
        });
      } else {
        // Fallback: return the iframe URL
        items.push({
          url: srv.url,
          quality: srv.quality || "Auto",
          label: serverLabelFromUrl(srv.url) + " (iframe)",
          direct: false
        });
      }
      return items;
    });
  })).then(function(groups) {
    var out = []; var seen = {};
    groups.forEach(function(g) {
      g.forEach(function(it) {
        if (seen[it.url]) return;
        seen[it.url] = 1;
        var isHls = /\.m3u8/i.test(it.url);
        var origin = originOf(pageUrl);
        out.push({
          name: PROVIDER_NAME + " " + (tag ? tag + " " : "") + it.label,
          title: PROVIDER_NAME + " • " + (tag ? tag + " " : "") + it.label,
          url: it.url,
          quality: it.quality,
          size: "Unknown",
          type: it.direct ? (isHls ? "hls" : "mp4") : "iframe",
          headers: {
            "User-Agent": UA,
            "Referer": it.direct ? (originOf(it.url) + "/") : pageUrl,
            "Origin": originOf(it.url) || origin,
            "Accept": "*/*"
          },
          provider: PROVIDER_ID
        });
      });
    });
    // Direct streams first
    out.sort(function(a, b) {
      return (a.type === "iframe" ? 1 : 0) - (b.type === "iframe" ? 1 : 0);
    });
    log("Total streams: " + out.length + " (direct: " + out.filter(function(s) { return s.type !== "iframe"; }).length + ")");
    return out;
  });
}

// ---------------------------------------------------------------- movie flow
function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      var best = chooseResult(all, meta.titles);
      if (!best) return [];
      log("Resolving movie: " + best.slug);
      return getMovieVideos(best.slug).then(function(servers) {
        if (!servers.length) return [];
        var title = best.title + (meta.year ? " (" + meta.year + ")" : "");
        return buildStreams(servers, BASE + "/movies/" + best.slug, title);
      });
    });
  }).catch(function(err) {
    log("Movie error: " + err.message);
    return [];
  });
}

// ---------------------------------------------------------------- TV flow
function getTvStreams(tmdbId, season, episode) {
  var s = Number(season) || 1;
  var e = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      var best = chooseResult(all, meta.titles);
      if (!best) return [];
      log("Resolving TV: " + best.slug + " S" + s + "E" + e);
      return getTvServers(best.slug, s, e).then(function(servers) {
        if (!servers.length) return [];
        var tag = "S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
        var title = best.title + " " + tag;
        return buildStreams(servers, BASE + "/tv/" + best.slug, title);
      });
    });
  }).catch(function(err) {
    log("TV error: " + err.message);
    return [];
  });
}

// ---------------------------------------------------------------- entry
function getStreams(tmdbId, mediaType, season, episode) {
  log("getStreams: " + tmdbId + " " + mediaType + " " + season + " " + episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
