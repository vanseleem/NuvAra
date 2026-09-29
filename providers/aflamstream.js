var BASE = "https://aflamstream.com";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function stripHtml(str) {
  return decodeHtml(String(str || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitle(str) {
  return String(str || "").toLowerCase().replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ").replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = normalizeTitle(a); b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
  var aa = a.split(" "), bb = b.split(" "), setB = {};
  bb.forEach(function(x) { setB[x] = 1; });
  var c = 0; aa.forEach(function(x) { if (setB[x]) c++; });
  return c / Math.max(aa.length, bb.length);
}

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  var titles = [];
  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      return fetch("https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang)
        .then(function(r) { return r.json(); })
        .then(function(d) {
          var t = type === "movie" ? (d.title || d.original_title) : (d.name || d.original_name);
          if (t && titles.indexOf(t) === -1) titles.push(t);
        }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    console.log("[AflamStream] TMDB titles:", titles.join(" | "));
    return titles;
  });
}

// Search via ?s=
function searchAflam(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/?s=" + encodeURIComponent(cleanTitle);
  console.log("[AflamStream] Search:", cleanTitle);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    // Match content links: /فيلم-xxx-2026-مترجم/12345/
    var re = /href=["'](https?:\/\/aflamstream\.com\/[^"']*\/\d+\/?)["']/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var link = m[1];
      if (seen[link]) continue;
      seen[link] = 1;
      var pm = link.match(/\/([^\/]+)\/(\d+)\/?$/);
      var t = "";
      if (pm) {
        try { t = decodeURIComponent(pm[1]).replace(/[-_]+/g, " "); } catch (e) { t = pm[1]; }
      }
      results.push({ url: link, title: t, id: pm ? pm[2] : null });
    }
    console.log("[AflamStream] Search results:", results.length);
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
  if (best) console.log("[AflamStream] Best:", best.title, "score:", bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  return "Auto";
}

function makeStream(url, label) {
  return {
    name: "⚜️ AflamStream",
    title: label ? "⚜️ AflamStream \u2022 " + label : "⚜️ AflamStream",
    url: url,
    quality: qualityFromUrl(url),
    type: "iframe",
    referer: BASE + "/"
  };
}

function resolveFromWatch(watchUrl) {
  console.log("[AflamStream] watch:", watchUrl);
  return fetchText(watchUrl, BASE + "/").then(function(html) {
    var streams = [];
    var seen = {};
    // Extract data-url attributes (the servers list)
    var re = /data-url=["']([^"']+)["']/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = decodeHtml(m[1]);
      if (u.indexOf("http") !== 0) continue;
      if (seen[u]) continue;
      seen[u] = 1;
      streams.push(u);
    }
    console.log("[AflamStream] data-url streams:", streams.length);
    return streams.map(function(u, i) {
      var host = "";
      try { host = u.split("/")[2].split(".")[0]; } catch (e) {}
      return makeStream(u, host || ("Server " + (i + 1)));
    });
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(titles) {
    return Promise.all(titles.map(function(t) {
      return searchAflam(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [], seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      console.log("[AflamStream] Unique candidates:", all.length);
      if (!all.length) return [];
      var best = chooseResult(all, titles);
      if (!best || !best.id) return [];
      return resolveFromWatch(BASE + "/watch/?id=" + best.id);
    });
  }).catch(function(err) {
    console.log("[AflamStream] Movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var wanted = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(titles) {
    var searches = [];
    titles.forEach(function(t) {
      searches.push(t + " الحلقة " + wanted);
      searches.push(t);
    });
    return Promise.all(searches.map(function(q) {
      return searchAflam(q).catch(function() { return []; });
    })).then(function(groups) {
      var all = [], seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      console.log("[AflamStream] TV candidates:", all.length);
      var withEp = all.filter(function(r) {
        return new RegExp("(?:الحلق[ةه]\\s*" + wanted + "\\b|\\b" + wanted + "\\b)", "i").test(r.title);
      });
      var pool = withEp.length ? withEp : all;
      if (!pool.length) return [];
      var best = chooseResult(pool, titles);
      if (!best || !best.id) return [];
      return resolveFromWatch(BASE + "/watch/?id=" + best.id);
    });
  }).catch(function(err) {
    console.log("[AflamStream] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[AflamStream] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
