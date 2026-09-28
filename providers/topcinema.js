var BASE = "https://topcinema.io";
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
  if (c) { console.log("[TopCinema] cached"); return Promise.resolve(c); }
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

function normalizeTitle(str) {
  return String(str || "").toLowerCase()
    .replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ").replace(/\s+/g, " ").trim();
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
    console.log("[TopCinema] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year };
  });
}

// Search via the form action we found: /search/?q=query
function searchTopCinema(query) {
  var url = BASE + "/search/?q=" + encodeURIComponent(query);
  console.log("[TopCinema] Search:", query);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    // All TopCinema content URLs have percent-encoded Arabic (%d8 or %d9)
    var re = /href="(https:\/\/topcinema\.io\/[^"]*%d[89][^"]*)"/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = decodeHtml(m[1]);
      if (seen[u]) continue;
      seen[u] = 1;
      // Extract title from the last URL slug segment
      var last = u.replace(/\/$/, "").split("/").pop();
      var title = "";
      try { title = decodeURIComponent(last); } catch (e) { title = last; }
      title = title.replace(/[-_]+/g, " ").trim();
      if (title.length > 2) results.push({ url: u, title: title });
    }
    console.log("[TopCinema] results:", query, results.length);
    return results;
  }).catch(function(err) {
    console.log("[TopCinema] search error:", err.message);
    return [];
  });
}

// Dean Edwards Packer unpacker
function unpackEval(html) {
  var m = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  var payload = m[1];
  var base = parseInt(m[2], 10);
  var count = parseInt(m[3], 10);
  var keywords = m[4].split("|");
  while (count--) {
    if (keywords[count]) {
      var key = keywords[count];
      var pat = new RegExp("\\b" + count.toString(base) + "\\b", "g");
      payload = payload.replace(pat, key);
    }
  }
  return payload;
}

// Resolve VidTube embed → direct .mp4 URL(s)
function resolveVidTube(vidtubeUrl) {
  console.log("[TopCinema] vidtube:", vidtubeUrl);
  return fetchText(vidtubeUrl, BASE + "/").then(function(html) {
    var urls = [];
    var seen = {};
    // Try unpacking first
    var unpacked = unpackEval(html);
    var search = unpacked || html;
    // Find all .mp4 URLs
    var re = /https?:\/\/[^"'\s<>\\]+\.mp4[^"'\s<>\\]*/gi;
    var m;
    while ((m = re.exec(search)) !== null) {
      var u = m[0].replace(/\\\//g, "/").replace(/\\u0026/g, "&");
      if (!seen[u]) { seen[u] = 1; urls.push(u); }
    }
    // Also try file: "..." pattern
    var re2 = /file\s*:\s*["']([^"']+)["']/gi;
    while ((m = re2.exec(search)) !== null) {
      var u2 = m[1].replace(/\\\//g, "/");
      if (u2.indexOf("http") === 0 && !seen[u2]) {
        seen[u2] = 1;
        urls.push(u2);
      }
    }
    console.log("[TopCinema] vidtube mp4s:", urls.length);
    return urls;
  }).catch(function(err) {
    console.log("[TopCinema] vidtube error:", err.message);
    return [];
  });
}

// Find the /watch/ link on a movie/episode page
function findWatchLink(html, pageUrl) {
  var m = html.match(/href=["']([^"']*\/watch\/?)["']/i);
  if (m) {
    var u = decodeHtml(m[1]);
    return u.indexOf("http") === 0 ? u : BASE + u;
  }
  // Fallback: append /watch/
  if (pageUrl && pageUrl.indexOf("/watch") === -1) {
    return pageUrl.replace(/\/?$/, "/watch/");
  }
  return null;
}

// Extract streams from a watch page
function getStreamsFromWatchPage(watchUrl) {
  return fetchText(watchUrl, BASE + "/").then(function(html) {
    // Look for VidTube iframe
    var m = html.match(/<iframe[^>]*src=["']([^"']*vidtube[^"']*)["']/i);
    if (m) {
      var vtUrl = decodeHtml(m[1]);
      if (vtUrl.indexOf("//") === 0) vtUrl = "https:" + vtUrl;
      return resolveVidTube(vtUrl);
    }
    // Fallback: direct .mp4 in watch page
    var urls = [];
    var seen = {};
    var re = /https?:\/\/[^"'\s<>]+\.mp4/gi;
    while ((m = re.exec(html)) !== null) {
      var u = m[0];
      if (!seen[u]) { seen[u] = 1; urls.push(u); }
    }
    return urls;
  });
}

// Pick best match from search results
function pickBest(all, meta) {
  var best = null, bestScore = 0;
  all.forEach(function(r) {
    var s = 0;
    meta.titles.forEach(function(t) {
      var sc = similarity(r.title, t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (best) console.log("[TopCinema] best match:", best.title, "score:", bestScore.toFixed(2));
  return best && bestScore >= 0.3 ? best : null;
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchTopCinema(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      if (!all.length) return [];
      var best = pickBest(all, meta);
      if (!best) return [];
      return fetchText(best.url, BASE + "/").then(function(html) {
        var watchUrl = findWatchLink(html, best.url);
        if (!watchUrl) return [];
        console.log("[TopCinema] watch:", watchUrl);
        return getStreamsFromWatchPage(watchUrl).then(function(urls) {
          return urls.map(function(u, i) {
            return {
              name: "TopCinema",
              title: "TopCinema " + (i + 1),
              url: u,
              quality: "Unknown",
              referer: BASE + "/"
            };
          });
        });
      });
    });
  }).catch(function(err) {
    console.log("[TopCinema] movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var wanted = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchTopCinema(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      if (!all.length) return [];

      // Filter by episode number if we can detect it
      var epMatches = [];
      all.forEach(function(r) {
        var dec = "";
        try { dec = decodeURIComponent(r.url); } catch (e) { dec = r.url; }
        var mm = dec.match(/الحلق[ةه][-_ ]?(\d+)/i);
        if (mm && Number(mm[1]) === wanted) epMatches.push(r);
      });

      var candidates = epMatches.length ? epMatches : all;
      var best = pickBest(candidates, meta);
      if (!best) return [];

      return fetchText(best.url, BASE + "/").then(function(html) {
        var watchUrl = findWatchLink(html, best.url);
        if (!watchUrl) return [];
        console.log("[TopCinema] TV watch:", watchUrl);
        return getStreamsFromWatchPage(watchUrl).then(function(urls) {
          return urls.map(function(u, i) {
            return {
              name: "TopCinema",
              title: "TopCinema " + (i + 1),
              url: u,
              quality: "Unknown",
              referer: BASE + "/"
            };
          });
        });
      });
    });
  }).catch(function(err) {
    console.log("[TopCinema] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[TopCinema] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
