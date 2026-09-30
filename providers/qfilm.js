var BASE = "https://a.qfilm.tv";
var PROVIDER_ID = "qfilm";
var PROVIDER_NAME = "🔆 QFilm";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function log(m) { console.log("[QFilm] " + m); }

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
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

function stripHtml(str) {
  return decodeHtml(String(str || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
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
    log("TMDB titles: " + titles.join(" | "));
    return { titles: titles, year: year };
  });
}

function searchQFilm(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(cleanTitle);
  log("Search: " + cleanTitle);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    var re = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*title=["']([^"']+)["'][^>]*>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var fullUrl = decodeHtml(m[1]);
      var vid = m[2];
      var linkTitle = decodeHtml(m[3]);
      if (seen[vid]) continue;
      seen[vid] = 1;
      var absolute = fullUrl.indexOf("http") === 0 ? fullUrl : BASE + fullUrl;
      results.push({ url: absolute, title: linkTitle, vid: vid });
    }
    if (!results.length) {
      var re2 = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*>/gi;
      while ((m = re2.exec(html)) !== null) {
        var fullUrl2 = decodeHtml(m[1]);
        var vid2 = m[2];
        if (seen[vid2]) continue;
        seen[vid2] = 1;
        var absolute2 = fullUrl2.indexOf("http") === 0 ? fullUrl2 : BASE + fullUrl2;
        results.push({ url: absolute2, title: vid2, vid: vid2 });
      }
    }
    log("Search results: " + results.length);
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
  if (best) log("Best: " + best.title + " score: " + bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Player resolution — QFilm's real endpoint is play.php?vid=X
// The page contains a `var servers = [...]` array of iframe HTML strings.
// ─────────────────────────────────────────────────────────────────────────

function resolveVid(vid) {
  var playUrl = BASE + "/play.php?vid=" + vid;
  log("play: " + playUrl);
  return fetchText(playUrl, BASE + "/").then(function(html) {
    // Parse the `var servers = [...]` array
    var m = html.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) {
      log("no servers array found");
      return [];
    }

    var rawServers;
    try {
      rawServers = JSON.parse(m[1]);
    } catch (e) {
      log("servers JSON parse failed: " + e.message);
      return [];
    }

    // Parse button labels from the page (سيرفر VIP, سيرفر [ 2 ], etc.)
    var labels = {};
    var btnRe = /<button[^>]*id="server-btn-(\d+)"[^>]*>[\s\S]*?<\/div>\s*([^<]+)\s*<\/button>/gi;
    var bm;
    while ((bm = btnRe.exec(html)) !== null) {
      labels[parseInt(bm[1], 10)] = decodeHtml(bm[2]).trim();
    }

    // Extract src from each iframe string
    var streams = [];
    rawServers.forEach(function(srv, idx) {
      var srcMatch = srv.match(/src="([^"]+)"/);
      if (!srcMatch) return;

      var rawUrl = srcMatch[1].replace(/\\\//g, "/").replace(/\\"/g, "");
      if (rawUrl.indexOf("//") === 0) rawUrl = "https:" + rawUrl;
      if (rawUrl.indexOf("http") !== 0) return;

      var label = labels[idx] || ("Server " + (idx + 1));
      var host = rawUrl.replace(/^https?:\/\/([^\/]+).*/, "$1").replace(/^www\./, "");

      streams.push({
        name: PROVIDER_NAME + " " + label,
        title: PROVIDER_NAME + " • " + label + " (" + host + ")",
        url: rawUrl,
        quality: "Auto",
        size: "Unknown",
        type: "iframe",
        referer: playUrl,
        headers: {
          "User-Agent": UA,
          "Referer": playUrl
        },
        provider: PROVIDER_ID
      });
    });

    log("extracted servers: " + streams.length);
    return streams;
  }).catch(function(err) {
    log("play page failed: " + err.message);
    return [];
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Movies
// ─────────────────────────────────────────────────────────────────────────

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchQFilm(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      log("Unique movie candidates: " + all.length);
      if (!all.length) return [];
      var best = chooseResult(all, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function(err) {
    log("Movie error: " + err.message);
    return [];
  });
}

// ─────────────────────────────────────────────────────────────────────────
// TV
// ─────────────────────────────────────────────────────────────────────────

function getTvStreams(tmdbId, season, episode) {
  var wanted = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    var searches = [];
    meta.titles.forEach(function(t) {
      searches.push(t + " الحلقة " + wanted);
      searches.push(t + " " + wanted);
      searches.push(t);
    });

    return Promise.all(searches.map(function(q) {
      return searchQFilm(q).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      log("Unique TV candidates: " + all.length);

      var withEp = all.filter(function(r) {
        return new RegExp("(?:الحلق[ةه]\\s*" + wanted + "\\b|\\b" + wanted + "\\b)", "i").test(r.title);
      });
      var pool = withEp.length ? withEp : all;
      log("TV candidates with ep " + wanted + ": " + withEp.length + " / pool: " + pool.length);

      if (!pool.length) return [];
      var best = chooseResult(pool, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function(err) {
    log("TV error: " + err.message);
    return [];
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  log("getStreams: " + tmdbId + " " + mediaType + " " + season + " " + episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
