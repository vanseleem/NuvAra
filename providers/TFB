

var BASE = "https://theflixbay.com";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var MIRROR_TIMEOUT = 15000;

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "X-Requested-With": "XMLHttpRequest"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
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
    var re = /<a\s+href="(\/movie\/(\d+))"[^>]*title="([^"]*)"/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var id = m[2];
      if (seen[id]) continue;
      seen[id] = 1;
      var linkTitle = decodeHtml(m[3]);
      results.push({ id: id, url: BASE + m[1], title: linkTitle });
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

function fetchPlayerSources(id) {
  var endpoints = [
    BASE + "/ajax/cinemov.php",
    BASE + "/ajax/theport.php",
    BASE + "/ajax/jollyrgr.php"
  ];
  var referer = BASE + "/movie/" + id;

  return Promise.all(endpoints.map(function(ep) {
    return fetchText(ep + "?id=" + id + "&server=1", referer).then(function(html) {
      return html;
    }).catch(function() { return ""; });
  })).then(function(htmls) {
    var urls = [];
    var seen = {};
    htmls.forEach(function(html) {
      var re = /(?:src|file|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var u = m[1];
        if (u.indexOf("http") !== 0) continue;
        if (seen[u]) continue;
        seen[u] = 1;
        urls.push(u);
      }
    });
    console.log("[TheFlixBay] Player sources found:", urls.length);
    return urls;
  });
}

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  return "Unknown";
}

function makeStream(url, label) {
  var origin = "https://theflixbay.com";
  var streamReferer = origin + "/";

  if (url.indexOf("http://") === 0) {
    url = "https://" + url.slice(7);
  }

  return {
    name: "🎬 TheFlixBay",
    title: label ? "🎬 TheFlixBay \u2022 " + label : "🎬 TheFlixBay",
    url: url,
    quality: qualityFromUrl(url),
    headers: {
      "User-Agent": UA,
      "Referer": streamReferer,
      "Origin": origin,
      "Accept": "*/*"
    }
  };
}

function resolveVid(id) {
  var movieUrl = BASE + "/movie/" + id;
  console.log("[TheFlixBay] resolve movie:", movieUrl);

  return fetchText(movieUrl, BASE + "/").then(function(html) {
    // Extract the server list from the page
    var servers = [];
    var re = /data-server="(\d+)"[^>]*>\s*<a[^>]*>\s*<i[^>]*><\/i>\s*([^<]+)/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      servers.push({ number: parseInt(m[1], 10), label: m[2].trim() });
    }
    console.log("[TheFlixBay] Servers found:", servers.length, "->", servers.map(function(s) { return s.label; }).join(", "));

    if (!servers.length) {
      return [{
        name: "🎬 TheFlixBay",
        title: "🎬 TheFlixBay",
        url: movieUrl,
        quality: "Auto",
        type: "iframe",
        referer: BASE + "/"
      }];
    }

    return Promise.all(servers.map(function(s) {
      return fetchPlayerSources(id).then(function(urls) {
        if (urls.length) {
          return urls.map(function(u) {
            return makeStream(u, s.label);
          });
        }
        return [{
          name: "🎬 TheFlixBay",
          title: "🎬 TheFlixBay \u2022 " + s.label,
          url: movieUrl,
          quality: "Auto",
          type: "iframe",
          referer: BASE + "/"
        }];
      });
    })).then(function(groups) {
      var out = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(s) {
          if (seen[s.url]) return;
          seen[s.url] = 1;
          out.push(s);
        });
      });
      return out;
    });
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return searchTheFlixBay(meta.titles[0]).then(function(results) {
      console.log("[TheFlixBay] Unique movie candidates:", results.length);
      if (!results.length) return [];
      var best = chooseResult(results, meta.titles);
      if (!best) return [];
      return resolveVid(best.id);
    });
  }).catch(function(err) {
    console.log("[TheFlixBay] Movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var wanted = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    var searches = [];
    meta.titles.forEach(function(t) {
      searches.push(t + " " + wanted);
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

      var withEp = all.filter(function(r) {
        return new RegExp("(?:الحلق[ةه]\\s*" + wanted + "\\b|\\b" + wanted + "\\b)", "i").test(r.title);
      });
      var pool = withEp.length ? withEp : all;
      console.log("[TheFlixBay] TV candidates with ep " + wanted + ":", withEp.length, "/ pool:", pool.length);

      if (!pool.length) return [];
      var best = chooseResult(pool, meta.titles);
      if (!best) return [];
      return resolveVid(best.id);
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
