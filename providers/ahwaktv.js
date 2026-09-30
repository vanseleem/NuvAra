var BASE = "https://yam.ahwaktv.net";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = { "User-Agent": UA, "Accept": "application/json, text/html, */*" };
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

function normalizeTitle(str) {
  return String(str || "").toLowerCase()
    .replace(/فيلم/g, "")
    .replace(/مسلسل/g, "")
    .replace(/مترجم[ةه]?/g, "")
    .replace(/مدبلج[ةه]?/g, "")
    .replace(/الموسم\s*[^\s]+/g, "")
    .replace(/الحلق[ةه]\s*[^\s]+/g, "")
    .replace(/كامل[ةه]?/g, "")
    .replace(/اون\s*لاين/g, "")
    .replace(/مشاهد[ةه]/g, "")
    .replace(/تحميل/g, "")
    .replace(/hd/ig, "")
    .replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    console.log("[AhwakTV] TMDB titles:", titles.join(" | "));
    return titles;
  });
}

// Search via HTML parsing instead of REST API
function searchAhwak(query) {
  var clean = String(query || "").trim();
  if (!clean) return Promise.resolve([]);
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(clean);
  console.log("[AhwakTV] search:", url);
  
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    var re = /<a\s+([^>]+)>([\s\S]*?)<\/a>/ig;
    var m;
    
    while ((m = re.exec(html)) !== null) {
      var attrs = m[1];
      var innerHtml = m[2];
      
      var hrefM = attrs.match(/href=["']([^"']+)["']/i);
      if (!hrefM) continue;
      var href = hrefM[1];
      
      // Look for the specific video ID AhwakTV uses
      var vidM = href.match(/vid=([a-zA-Z0-9_-]+)/i);
      if (!vidM) continue;
      var vid = vidM[1];
      
      var title = "";
      var titleM = attrs.match(/title=["']([^"']+)["']/i);
      if (titleM) title = titleM[1];
      
      if (!title) {
        var altM = innerHtml.match(/alt=["']([^"']+)["']/i);
        if (altM) title = altM[1];
      }
      if (!title) {
        title = innerHtml.replace(/<[^>]+>/g, "").trim();
      }
      
      title = decodeHtml(title).replace(/\s+/g, " ").trim();
      
      if (title && !seen[vid]) {
        seen[vid] = 1;
        results.push({ id: vid, url: href, title: title });
      }
    }
    console.log("[AhwakTV] search results:", results.length);
    return results;
  }).catch(function(err) {
    console.log("[AhwakTV] search failed:", err.message);
    return [];
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
  if (best) console.log("[AhwakTV] Best match:", best.title, "score:", bestScore.toFixed(3));
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

function makeStream(url, label, type) {
  var q = qualityFromUrl(url);
  if (!type) type = url.indexOf(".mp4") > -1 || url.indexOf(".m3u8") > -1 ? "url" : "iframe";
  return {
    name: "⚜️ AhwakTV",
    title: label ? "AhwakTV \u2022 " + label : "AhwakTV Stream",
    url: url,
    quality: q,
    type: type,
    referer: BASE + "/"
  };
}

function hostLabel(url) {
  var m = String(url || "").match(/^https?:\/\/(?:www\.)?([^\.\/]+)/i);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : "";
}

function extractLinksFromHtml(html, streams, seen) {
  // Extract direct media files
  var re = /((?:https?:\/\/)?[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*)/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = m[1].replace(/\\\//g, '/'); // Clean up PHP JSON escaped slashes
    if (u.indexOf("/") === 0 && u.indexOf("//") !== 0) u = BASE + u;
    else if (u.indexOf("//") === 0) u = "https:" + u;
    
    if (!seen[u] && u.indexOf("http") === 0) {
      seen[u] = 1;
      streams.push(makeStream(u, u.indexOf(".m3u8") > -1 ? "HLS Direct" : "MP4 Direct", "url"));
    }
  }
  
  // Extract external iframes (e.g. Vidmoly)
  var iframeRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
  while ((m = iframeRe.exec(html)) !== null) {
    var src = decodeHtml(m[1]).replace(/\\\//g, '/');
    if (src.indexOf("/") === 0 && src.indexOf("//") !== 0) src = BASE + src;
    else if (src.indexOf("//") === 0) src = "https:" + src;
    
    // Ignore internal search tags
    if (!seen[src] && src.indexOf("http") === 0 && src.indexOf("search.php") === -1) {
      seen[src] = 1;
      streams.push(makeStream(src, hostLabel(src), "iframe"));
    }
  }
}

function resolveFromWatch(vid) {
  var watchUrl = BASE + "/watch.php?vid=" + vid;
  console.log("[AhwakTV] resolving:", watchUrl);
  return fetchText(watchUrl, BASE + "/").then(function(html) {
    var streams = [];
    var seen = {};
    
    html = html.replace(/\\\//g, '/');
    extractLinksFromHtml(html, streams, seen);
    
    // Failsafe: Dive into see.php concurrently if it exists
    var seeUrl = BASE + "/see.php?vid=" + vid;
    return fetchText(seeUrl, watchUrl).then(function(seeHtml) {
      seeHtml = seeHtml.replace(/\\\//g, '/');
      extractLinksFromHtml(seeHtml, streams, seen);
      console.log("[AhwakTV] servers found:", streams.length);
      return streams;
    }).catch(function() {
      return streams; // Return what we have if see.php fails
    });
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(titles) {
    return Promise.all(titles.map(function(t) {
      return searchAhwak(t);
    })).then(function(groups) {
      var all = [], seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.id]) { seen[r.id] = 1; all.push(r); }
        });
      });
      console.log("[AhwakTV] Unique Movie candidates:", all.length);
      if (!all.length) return [];
      
      var best = chooseResult(all, titles);
      if (!best) return [];
      return resolveFromWatch(best.id);
    });
  }).catch(function(err) {
    console.log("[AhwakTV] Movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var wantedSeason = Number(season) || 1;
  var wantedEp = Number(episode) || 1;
  
  return getTmdbTitles(tmdbId, "tv").then(function(titles) {
    var searches = [];
    titles.forEach(function(t) {
      searches.push(t + " الحلقة " + wantedEp);
      searches.push(t);
    });
    return Promise.all(searches.map(function(q) {
      return searchAhwak(q);
    })).then(function(groups) {
      var all = [], seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.id]) { seen[r.id] = 1; all.push(r); }
        });
      });
      
      console.log("[AhwakTV] TV candidates:", all.length);
      
      var withEp = all.filter(function(r) {
        // Drop result if it clearly belongs to the wrong season
        var hasSeasonNum = /الموسم\s*(\d+)/i.exec(r.title) || /موسم\s*(\d+)/i.exec(r.title);
        if (hasSeasonNum && parseInt(hasSeasonNum[1]) !== wantedSeason) {
          return false;
        }
        // Strict Arabic digit match for the requested episode
        var epMatch = new RegExp("(?:الحلق[ةه]\\s*" + wantedEp + "\\b|\\b" + wantedEp + "\\b)", "i").test(r.title);
        return epMatch;
      });
      
      var pool = withEp.length ? withEp : all;
      if (!pool.length) return [];
      
      var best = chooseResult(pool, titles);
      if (!best) return [];
      return resolveFromWatch(best.id);
    });
  }).catch(function(err) {
    console.log("[AhwakTV] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[AhwakTV] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
