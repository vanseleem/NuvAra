/**
 * TheFlixBay provider  (v2 — corrected AJAX endpoints)
 *
 * Verified live from the movie page's own JavaScript:
 *  - Server 1: /ajax/cinemov.php?t={tmdbId}    (BlackFlag)
 *  - Server 2: /ajax/cinemov2.php?t={tmdbId}   (ThePort)
 *  - Server 3: /ajax/cinemov3.php?t={tmdbId}   (JollyRgr)
 *  - Servers 4-9: /ajax/cinemov4.php ... /ajax/cinemov9.php
 *
 * The `t` param is the TMDB ID, extracted from the page as {"t": 'NNNNNN'}.
 */

var BASE = "https://theflixbay.com";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var MIRROR_TIMEOUT = 15000;

function fetchText(url, referer, ajax) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
  if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeTitle(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  a = normalizeTitle(a);
  b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) {
    return 0.5 + 0.4 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  var aa = a.split(" ");
  var bb = b.split(" ");
  var setB = {};
  bb.forEach(function(x) { setB[x] = 1; });
  var common = 0;
  aa.forEach(function(x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  var titles = [];
  var year = null;

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
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    console.log("[TheFlixBay] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year };
  });
}

function searchTheFlixBay(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/index.php?menu=search&query=" + encodeURIComponent(cleanTitle);
  console.log("[TheFlixBay] Search:", cleanTitle);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};

    // Match both /movie/{id} and /series/{id}
    var reMovie = /<a\s+href="(\/movie\/(\d+))"[^>]*title="([^"]*)"/gi;
    var reSeries = /<a\s+href="(\/series\/(\d+))"[^>]*title="([^"]*)"/gi;
    var m;
    while ((m = reMovie.exec(html)) !== null) {
      var id = m[2];
      if (seen[id]) continue;
      seen[id] = 1;
      results.push({ id: id, url: BASE + m[1], title: decodeHtml(m[3]), kind: "movie" });
    }
    while ((m = reSeries.exec(html)) !== null) {
      var sid = m[2];
      if (seen[sid]) continue;
      seen[sid] = 1;
      results.push({ id: sid, url: BASE + m[1], title: decodeHtml(m[3]), kind: "series" });
    }
    console.log("[TheFlixBay] Search results:", results.length);
    return results;
  });
}

function chooseResult(results, titles) {
  var best = null;
  var bestScore = 0;
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

// ═══════════════════════════════════════════════════════════════════════
// CRITICAL FIX: Extract TMDB ID from the movie page JavaScript
// The page contains: $.get(serverUrl, {"t": '969681'}, ...
// ═══════════════════════════════════════════════════════════════════════

function extractTmdbId(html) {
  // Pattern 1: {"t": '969681'} inside the $.get call
  var m = html.match(/["']t["']\s*:\s*["'](\d{3,10})["']/);
  if (m) return m[1];
  // Pattern 2: Any "t": "NNNNN" or "t":NNNNN
  m = html.match(/"t"\s*:\s*"?(\d{3,10})"?/);
  if (m) return m[1];
  // Pattern 3: /movie/{id}-watch-...-{year}-online and TMDB link
  m = html.match(/image\.tmdb\.org\/t\/p\/[^"]+\/([^"\/]+\.jpg)/);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// CRITICAL FIX: Correct AJAX endpoints + X-Requested-With header
// ═══════════════════════════════════════════════════════════════════════

function fetchPlayerSources(tmdbId, moviePageUrl) {
  var servers = [
    { url: BASE + "/ajax/cinemov.php?t=" + encodeURIComponent(tmdbId),  label: "BlackFlag" },
    { url: BASE + "/ajax/cinemov2.php?t=" + encodeURIComponent(tmdbId), label: "ThePort" },
    { url: BASE + "/ajax/cinemov3.php?t=" + encodeURIComponent(tmdbId), label: "JollyRgr" }
  ];

  console.log("[TheFlixBay] AJAX with tmdbId:", tmdbId);

  return Promise.all(servers.map(function(srv) {
    return fetchText(srv.url, moviePageUrl, true).then(function(html) {
      console.log("[TheFlixBay] " + srv.label + " response size:", html.length);
      return { html: html, label: srv.label, url: srv.url };
    }).catch(function(e) {
      console.log("[TheFlixBay] " + srv.label + " failed:", e.message);
      return { html: "", label: srv.label, url: srv.url };
    });
  }));
}

function extractStreams(serverResults) {
  var streams = [];
  var seen = {};

  serverResults.forEach(function(res) {
    if (!res.html) return;

    // Look for iframe src in the AJAX response
    var reIframe = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi;
    var m;
    while ((m = reIframe.exec(res.html)) !== null) {
      var u = decodeHtml(m[1]).trim();
      if (u.indexOf("//") === 0) u = "https:" + u;
      if (u.indexOf("http") !== 0) continue;
      if (seen[u]) continue;
      seen[u] = 1;
      streams.push({ url: u, label: res.label, kind: "iframe" });
    }

    // Look for direct m3u8/mp4
    var reMedia = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
    while ((m = reMedia.exec(res.html)) !== null) {
      var mu = m[0].replace(/\\\//g, "/");
      if (seen[mu]) continue;
      seen[mu] = 1;
      streams.push({ url: mu, label: res.label, kind: "direct" });
    }

    // Look for sources/file JSON
    var reJson = /(?:file|source|src)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi;
    while ((m = reJson.exec(res.html)) !== null) {
      var ju = m[1].replace(/\\\//g, "/");
      if (ju.indexOf("http") !== 0) continue;
      if (seen[ju]) continue;
      seen[ju] = 1;
      streams.push({ url: ju, label: res.label, kind: "direct" });
    }
  });

  console.log("[TheFlixBay] Total streams extracted:", streams.length);
  return streams;
}

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

function serverLabelFromUrl(url) {
  var m = url.match(/^https?:\/\/(?:www\.)?([^\/:?#]+)/i);
  var h = m ? m[1].toLowerCase() : "";
  if (/vidspeed/.test(h)) return "Vidspeed";
  if (/uqload/.test(h)) return "Uqload";
  if (/ds2play/.test(h)) return "DS2Play";
  if (/ok\.ru/.test(h)) return "OK.ru";
  if (/voe\.sx/.test(h)) return "Voe";
  if (/yourupload/.test(h)) return "YourUpload";
  if (/streamtape/.test(h)) return "Streamtape";
  if (/dood/.test(h)) return "Dood";
  if (/filemoon/.test(h)) return "Filemoon";
  if (/vidmoly/.test(h)) return "Vidmoly";
  if (/mixdrop/.test(h)) return "Mixdrop";
  return h.split(".").slice(-2, -1)[0] || h;
}

function buildStreams(sources, moviePageUrl) {
  var origin = "https://theflixbay.com";
  var out = [];
  var seen = {};

  sources.forEach(function(s) {
    if (seen[s.url]) return;
    seen[s.url] = 1;

    var isHls = /\.m3u8/i.test(s.url);
    var quality = isHls ? "Auto" : qualityFromUrl(s.url);
    var label = serverLabelFromUrl(s.url);

    out.push({
      name: "🎬 TheFlixBay " + s.label + " (" + label + ")",
      title: "🎬 TheFlixBay • " + s.label + " (" + label + ")",
      url: s.url,
      quality: quality,
      size: "Unknown",
      type: s.kind === "iframe" ? "iframe" : (isHls ? "hls" : "mp4"),
      headers: {
        "User-Agent": UA,
        "Referer": moviePageUrl,
        "Origin": origin,
        "Accept": "*/*"
      },
      provider: "theflixbay"
    });
  });

  return out;
}

function resolveVid(id, kind) {
  var pageUrl = kind === "series" ? BASE + "/series/" + id : BASE + "/movie/" + id;
  console.log("[TheFlixBay] Resolving:", pageUrl);

  return fetchText(pageUrl, BASE + "/").then(function(html) {
    // Extract TMDB ID from the page's JavaScript
    var tmdbId = extractTmdbId(html);
    if (!tmdbId) {
      console.log("[TheFlixBay] No TMDB ID found in page");
      return [];
    }
    console.log("[TheFlixBay] Extracted TMDB ID:", tmdbId);

    return fetchPlayerSources(tmdbId, pageUrl).then(function(results) {
      var streams = extractStreams(results);
      if (!streams.length) {
        console.log("[TheFlixBay] No streams extracted from AJAX responses");
        return [];
      }
      return buildStreams(streams, pageUrl);
    });
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchTheFlixBay(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.id]) { seen[r.id] = 1; all.push(r); }
        });
      });
      console.log("[TheFlixBay] Unique movie candidates:", all.length);
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
  return getTvStreamsInternal(tmdbId, season, wanted);
}

function getTvStreamsInternal(tmdbId, season, wanted) {
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    var searches = [];
    meta.titles.forEach(function(t) {
      searches.push(t);
    });

    return Promise.all(searches.map(function(q) {
      return searchTheFlixBay(q).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.id]) { seen[r.id] = 1; all.push(r); }
        });
      });
      console.log("[TheFlixBay] Unique TV candidates:", all.length);

      var series = all.filter(function(r) { return r.kind === "series"; });
      var pool = series.length ? series : all;
      if (!pool.length) return [];
      var best = chooseResult(pool, meta.titles);
      if (!best) return [];
      return resolveVid(best.id, best.kind);
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
