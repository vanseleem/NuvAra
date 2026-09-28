var BASE = "https://topcinemaa.cam";
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
  if (c) { console.log("[TopCinema] page cached"); return Promise.resolve(c); }
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
    console.log("[TopCinema] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year };
  });
}

// TopCinema is WordPress-based — search via ?s= (confirmed from multiple scans)
function searchTopCinema(query) {
  var cleanQuery = String(query || "").trim();
  var url = BASE + "/?s=" + encodeURIComponent(cleanQuery);
  console.log("[TopCinema] Search:", cleanQuery);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    // TopCinema uses /film/, /series/, /anime/ paths
    var re = /<a[^>]*href=["']([^"']*\/(?:film|movie|series|anime|episode|watch)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = decodeHtml(m[1]);
      if (seen[u]) continue;
      seen[u] = 1;
      var abs = u.indexOf("http") === 0 ? u : BASE + u;
      var title = stripHtml(m[2]);
      if (title.length > 1) results.push({ url: abs, title: title });
    }
    // Fallback
    if (!results.length) {
      var re2 = /href=["']([^"']*\/(?:film|movie|series|anime|episode|watch)\/[^"']+)["']/gi;
      while ((m = re2.exec(html)) !== null) {
        var u2 = decodeHtml(m[1]);
        if (seen[u2]) continue;
        seen[u2] = 1;
        var abs2 = u2.indexOf("http") === 0 ? u2 : BASE + u2;
        var pm = u2.match(/\/(?:film|movie|series|anime|episode|watch)\/[^\/]+\/([^?#"']+)/i);
        var t2 = pm ? decodeURIComponent(pm[1]).replace(/[-_]+/g, " ").trim() : "";
        if (t2) results.push({ url: abs2, title: t2 });
      }
    }
    console.log("[TopCinema] results:", cleanQuery, results.length);
    return results;
  }).catch(function(err) {
    console.log("[TopCinema] search error:", err.message);
    return [];
  });
}

// VidTube resolver — down.vidtube.one/d/ID.html → direct .mp4 links
function resolveVidTube(vidtubeUrl) {
  console.log("[TopCinema] VidTube:", vidtubeUrl);
  return fetchText(vidtubeUrl, BASE + "/").then(function(html) {
    var urls = [];
    var seen = {};
    // Direct .mp4 in the vidtube page
    var re = /https?:\/\/[^"'\s<>]+\.mp4/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = m[0].replace(/\\\//g, "/");
      if (!seen[u]) { seen[u] = 1; urls.push(u); }
    }
    // Also look for sources with quality labels
    var re2 = /(?:src|file|source|url)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/gi;
    while ((m = re2.exec(html)) !== null) {
      var u2 = m[1].replace(/\\\//g, "/");
      if (!seen[u2]) { seen[u2] = 1; urls.push(u2); }
    }
    console.log("[TopCinema] VidTube mp4s:", urls.length);
    return urls;
  }).catch(function(err) {
    console.log("[TopCinema] VidTube error:", err.message);
    return [];
  });
}

// Extract download/watch links from a TopCinema post page
function extractDownloadLinks(html) {
  var links = [];
  var seen = {};
  // Watch page link
  var re = /href=["']([^"']*\/watch\/[^"']+)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = decodeHtml(m[1]);
    var abs = u.indexOf("http") === 0 ? u : BASE + u;
    if (!seen[abs]) { seen[abs] = 1; links.push({ type: "watch", url: abs }); }
  }
  // Download page link
  var re2 = /href=["']([^"']*\/download\/[^"']+)["']/gi;
  while ((m = re2.exec(html)) !== null) {
    var u2 = decodeHtml(m[1]);
    var abs2 = u2.indexOf("http") === 0 ? u2 : BASE + u2;
    if (!seen[abs2]) { seen[abs2] = 1; links.push({ type: "download", url: abs2 }); }
  }
  // Direct vidtube link
  var re3 = /(https?:\/\/down\.vidtube\.one\/[^"'\s<>]+)/gi;
  while ((m = re3.exec(html)) !== null) {
    var v = m[1];
    if (!seen[v]) { seen[v] = 1; links.push({ type: "vidtube", url: v }); }
  }
  // data-* attributes with URLs
  var re4 = /data-(?:url|href|src|video)=["']([^"']+)["']/gi;
  while ((m = re4.exec(html)) !== null) {
    var val = m[1];
    var decoded = val;
    try { if (val.indexOf("aHR0c") === 0) decoded = atob(val); } catch (e) {}
    if (decoded.indexOf("http") === 0 && !seen[decoded]) {
      seen[decoded] = 1;
      links.push({ type: "data", url: decoded });
    }
  }
  return links;
}

function extractStreamsFromPage(html) {
  var streams = [];
  var seen = {};
  var re = /https?:\/\/[^"'\s<>]+\.mp4/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = m[0].replace(/\\\//g, "/");
    if (!seen[u]) { seen[u] = 1; streams.push(u); }
  }
  var re2 = /<source[^>]*src=["']([^"']+)["']/gi;
  while ((m = re2.exec(html)) !== null) {
    var u2 = decodeHtml(m[1]);
    if (u2.indexOf("//") === 0) u2 = "https:" + u2;
    else if (u2.indexOf("/") === 0) u2 = BASE + u2;
    if (!seen[u2]) { seen[u2] = 1; streams.push(u2); }
  }
  return streams;
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
      var best = null, bestScore = 0;
      all.forEach(function(r) {
        var s = 0;
        meta.titles.forEach(function(t) {
          var sc = similarity(r.title, t);
          if (sc > s) s = sc;
        });
        if (s > bestScore) { bestScore = s; best = r; }
      });
      if (!best || bestScore < 0.4) return [];
      console.log("[TopCinema] selected:", best.title, bestScore.toFixed(2));
      return fetchText(best.url, BASE + "/").then(function(html) {
        var links = extractDownloadLinks(html);
        console.log("[TopCinema] links found:", links.length);
        // Try direct mp4 in page first
        var directStreams = extractStreamsFromPage(html);
        if (directStreams.length) {
          console.log("[TopCinema] direct mp4s:", directStreams.length);
          return directStreams.map(function(u, i) {
            return { name: "TopCinema", title: "TopCinema " + (i + 1), url: u, quality: "Unknown", referer: BASE + "/" };
          });
        }
        // Try vidtube links
        var vidtubeLink = null;
        for (var i = 0; i < links.length; i++) {
          if (links[i].type === "vidtube") { vidtubeLink = links[i].url; break; }
        }
        if (vidtubeLink) {
          return resolveVidTube(vidtubeLink).then(function(urls) {
            return urls.map(function(u, i) {
              return { name: "TopCinema", title: "TopCinema " + (i + 1), url: u, quality: "Unknown", referer: BASE + "/" };
            });
          });
        }
        // Try download page
        var dlLink = null;
        for (var j = 0; j < links.length; j++) {
          if (links[j].type === "download") { dlLink = links[j].url; break; }
        }
        if (dlLink) {
          return fetchText(dlLink, best.url).then(function(dlHtml) {
            var urls2 = extractStreamsFromPage(dlHtml);
            var vt = extractDownloadLinks(dlHtml);
            for (var k = 0; k < vt.length; k++) {
              if (vt[k].type === "vidtube") { urls2 = urls2.concat(vt[k].url); }
            }
            return urls2.map(function(u, i) {
              return { name: "TopCinema", title: "TopCinema " + (i + 1), url: u, quality: "Unknown", referer: BASE + "/" };
            });
          });
        }
        return [];
      });
    });
  }).catch(function(err) {
    console.log("[TopCinema] movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
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
      var best = null, bestScore = 0;
      all.forEach(function(r) {
        var s = 0;
        meta.titles.forEach(function(t) {
          var sc = similarity(r.title, t);
          if (sc > s) s = sc;
        });
        if (s > bestScore) { bestScore = s; best = r; }
      });
      if (!best || bestScore < 0.4) return [];
      console.log("[TopCinema] TV selected:", best.title);
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
          var directStreams = extractStreamsFromPage(epHtml);
          if (directStreams.length) {
            return directStreams.map(function(u, i) {
              return { name: "TopCinema", title: "TopCinema " + (i + 1), url: u, quality: "Unknown", referer: BASE + "/" };
            });
          }
          var links = extractDownloadLinks(epHtml);
          var vtLink = null;
          for (var j = 0; j < links.length; j++) {
            if (links[j].type === "vidtube") { vtLink = links[j].url; break; }
          }
          if (vtLink) {
            return resolveVidTube(vtLink).then(function(urls) {
              return urls.map(function(u, i) {
                return { name: "TopCinema", title: "TopCinema " + (i + 1), url: u, quality: "Unknown", referer: BASE + "/" };
              });
            });
          }
          return [];
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
