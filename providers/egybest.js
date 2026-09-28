var BASE = "https://egybest.la";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

var _CACHE = { data: {}, ttl: 5 * 60 * 1000 };
function _cGet(k) {
  var e = _CACHE.data[k];
  if (!e) return null;
  if (Date.now() - e.t > _CACHE.ttl) { delete _CACHE.data[k]; return null; }
  return e.v;
}
function _cSet(k, v) { _CACHE.data[k] = { t: Date.now(), v: v }; return v; }

function encodeUrl(u) {
  return String(u).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
}

function fetchText(url, referer) {
  url = encodeUrl(url);
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar,en-US;q=0.9,en;q=0.8"
  };
  if (referer) headers["Referer"] = encodeUrl(referer);
  var c = _cGet("p:" + url);
  if (c) { console.log("[EgyBest] page cached"); return Promise.resolve(c); }
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then(function(t) { _cSet("p:" + url, t); return t; });
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
  return decodeHtml(String(str || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitle(str) {
  return String(str || "").toLowerCase().replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ").replace(/\s+/g, " ").trim();
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
  var urls = ["ar", "en"].map(function(lang) {
    return "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + TMDB_API_KEY + "&language=" + lang;
  });
  return Promise.all(urls.map(function(u) {
    return fetch(u).then(function(r) { return r.json(); }).catch(function() { return null; });
  })).then(function(dataArr) {
    var titles = [];
    var year = null;
    dataArr.forEach(function(d) {
      if (!d) return;
      var t = type === "movie" ? (d.title || d.original_title) : (d.name || d.original_name);
      if (t && titles.indexOf(t) === -1) titles.push(t);
      if (!year) {
        var ds = type === "movie" ? d.release_date : d.first_air_date;
        if (ds) year = ds.slice(0, 4);
      }
    });
    console.log("[EgyBest] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year };
  });
}

// EgyBest search — WordPress style: ?s=query (confirmed from iegybest.in scan)
function searchEgyBest(query) {
  var cleanQuery = String(query || "").trim();
  var url = BASE + "/?s=" + encodeURIComponent(cleanQuery);
  console.log("[EgyBest] Search:", cleanQuery);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    // Match movie/series links — EgyBest uses /movies/, /series/, /movie/, /titles/
    var re = /<a[^>]*href=["']([^"']*\/(?:movies|series|movie|titles|watch)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = decodeHtml(m[1]);
      if (seen[u]) continue;
      seen[u] = 1;
      var abs = u.indexOf("http") === 0 ? u : BASE + u;
      var title = stripHtml(m[2]);
      if (title.length > 1) results.push({ url: abs, title: title });
    }
    // Fallback: broader extraction
    if (!results.length) {
      var re2 = /href=["']([^"']*\/(?:movies|series|movie|titles|watch)\/[^"']+)["']/gi;
      while ((m = re2.exec(html)) !== null) {
        var u2 = decodeHtml(m[1]);
        if (seen[u2]) continue;
        seen[u2] = 1;
        var abs2 = u2.indexOf("http") === 0 ? u2 : BASE + u2;
        var pm = u2.match(/\/(?:movies|series|movie|titles|watch)\/[^\/]+\/([^?#"']+)/i);
        var t2 = pm ? decodeURIComponent(pm[1]).replace(/[-_]+/g, " ").trim() : "";
        if (t2) results.push({ url: abs2, title: t2 });
      }
    }
    console.log("[EgyBest] results:", cleanQuery, results.length);
    return results;
  }).catch(function(err) {
    console.log("[EgyBest] search error:", err.message);
    return [];
  });
}

// Extract stream URLs — EgyBest uses multiple hosts + direct links
function extractStreams(html, referer) {
  var streams = [];
  var seen = {};
  // Direct .mp4
  var re = /https?:\/\/[^"'\s<>]+\.mp4/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = m[0].replace(/\\\//g, "/");
    if (!seen[u]) { seen[u] = 1; streams.push(u); }
  }
  // data-url / data-href with base64 or direct
  var re2 = /data-(?:url|href|src|video)=["']([^"']+)["']/gi;
  while ((m = re2.exec(html)) !== null) {
    var val = m[1];
    var decoded = val;
    try {
      if (val.indexOf("aHR0c") === 0) decoded = atob(val);
    } catch (e) {}
    if (decoded.indexOf("http") === 0 && !seen[decoded]) {
      seen[decoded] = 1;
      streams.push(decoded);
    }
  }
  // iframe sources
  var re3 = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = re3.exec(html)) !== null) {
    var u3 = decodeHtml(m[1]);
    if (u3.indexOf("//") === 0) u3 = "https:" + u3;
    else if (u3.indexOf("/") === 0) u3 = BASE + u3;
    if (!seen[u3]) { seen[u3] = 1; streams.push(u3); }
  }
  return streams;
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchEgyBest(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      if (!all.length) return [];
      // Pick best match
      var best = null, bestScore = 0;
      all.forEach(function(r) {
        var s = 0;
        meta.titles.forEach(function(t) {
          var sc = similarity(r.title, t);
          if (sc > s) s = sc;
        });
        if (s > bestScore) { bestScore = s; best = r; }
      });
      if (!best || bestScore < 0.5) return [];
      console.log("[EgyBest] selected:", best.title, bestScore.toFixed(2));
      return fetchText(best.url, BASE + "/").then(function(html) {
        var urls = extractStreams(html, best.url);
        console.log("[EgyBest] streams found:", urls.length);
        return urls.map(function(u, i) {
          return { name: "EgyBest", title: "EgyBest Server " + (i + 1), url: u, quality: "Unknown", referer: BASE + "/" };
        });
      });
    });
  }).catch(function(err) {
    console.log("[EgyBest] movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchEgyBest(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      if (!all.length) return [];
      var best = null, bestScore = 0;
      all.forEach(function(r) {
        var s = 0;
        meta.titles.forEach(function(t) {
          var sc = similarity(r.title, t);
          if (sc > s) s = sc;
        });
        if (s > bestScore) { bestScore = s; best = r; }
      });
      if (!best || bestScore < 0.5) return [];
      console.log("[EgyBest] TV selected:", best.title);
      return fetchText(best.url, BASE + "/").then(function(html) {
        // Find episode links
        var epLinks = [];
        var seen2 = {};
        var re = /href=["']([^"']*\/(?:episode|watch|series)\/[^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
          var u = decodeHtml(m[1]);
          var abs = u.indexOf("http") === 0 ? u : BASE + u;
          if (!seen2[abs]) { seen2[abs] = 1; epLinks.push(abs); }
        }
        var wanted = Number(episode) || 1;
        var selected = [];
        for (var i = 0; i < epLinks.length; i++) {
          var dec = "";
          try { dec = decodeURIComponent(epLinks[i]); } catch (e) { dec = epLinks[i]; }
          var mm = dec.match(/الحلق[ةه][^0-9]*([0-9]+)/i) || dec.match(/[-_](\d+)(?:[/?#]|$)/);
          if (mm && Number(mm[1]) === wanted) selected.push(epLinks[i]);
        }
        if (!selected.length && epLinks.length >= wanted) selected = [epLinks[wanted - 1]];
        if (!selected.length) return [];
        return fetchText(selected[0], best.url).then(function(epHtml) {
          var urls = extractStreams(epHtml, selected[0]);
          console.log("[EgyBest] TV streams found:", urls.length);
          return urls.map(function(u, i) {
            return { name: "EgyBest", title: "EgyBest Server " + (i + 1), url: u, quality: "Unknown", referer: BASE + "/" };
          });
        });
      });
    });
  }).catch(function(err) {
    console.log("[EgyBest] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[EgyBest] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
