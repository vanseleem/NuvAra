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
    return titles;
  });
}

function searchAhwak(query) {
  var clean = String(query || "").trim();
  if (!clean) return Promise.resolve([]);
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(clean);
  
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
    return results;
  }).catch(function() {
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

// MASSIVE UPDATE: Smart Link Extractor
function extractLinksFromHtml(html, streams, seen) {
  
  // 1. Hunt for multi-server buttons (data-url, data-server, data-embed)
  var dataRe = /data-(?:url|src|link|server|embed)=["']([^"']+)["']/gi;
  var m;
  while ((m = dataRe.exec(html)) !== null) {
    var dUrl = decodeHtml(m[1]).replace(/\\\//g, '/');
    if (dUrl.indexOf("data:image") > -1 || dUrl.indexOf("javascript:") > -1) continue; 
    
    if (dUrl.indexOf("/") === 0 && dUrl.indexOf("//") !== 0) dUrl = BASE + dUrl;
    else if (dUrl.indexOf("//") === 0) dUrl = "https:" + dUrl;

    if (!seen[dUrl] && dUrl.indexOf("http") === 0 && dUrl.indexOf(BASE) === -1) {
      seen[dUrl] = 1;
      var isDirect = (dUrl.indexOf(".mp4") > -1 || dUrl.indexOf(".m3u8") > -1);
      streams.push(makeStream(dUrl, hostLabel(dUrl) || "Server", isDirect ? "url" : "iframe"));
    }
  }

  // 2. Extract standard iframes and filter out social media / tracking
  var iframeRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
  while ((m = iframeRe.exec(html)) !== null) {
    var src = decodeHtml(m[1]).replace(/\\\//g, '/');
    if (src.indexOf("/") === 0 && src.indexOf("//") !== 0) src = BASE + src;
    else if (src.indexOf("//") === 0) src = "https:" + src;
    
    var skip = ["search.php", "facebook.com", "twitter.com", "youtube.com", "googletagmanager"];
    var shouldSkip = false;
    for (var i = 0; i < skip.length; i++) {
        if (src.indexOf(skip[i]) > -1) shouldSkip = true;
    }
    
    if (!seen[src] && src.indexOf("http") === 0 && !shouldSkip) {
      seen[src] = 1;
      // Skip pushing see.php as an iframe directly, because we scrape it internally below
      if (src.indexOf("see.php") === -1) {
          streams.push(makeStream(src, hostLabel(src) || "Server", "iframe"));
      }
    }
  }

  // 3. Strict JWPlayer / VideoJS extraction
  var re = /(?:src=["']|(?:url|file)\s*:\s*["'])((?:https?:\/\/)?[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*)/gi;
  while ((m = re.exec(html)) !== null) {
    var u = m[1].replace(/\\\//g, '/'); 
    if (u.indexOf("/") === 0 && u.indexOf("//") !== 0) u = BASE + u;
    else if (u.indexOf("//") === 0) u = "https:" + u;
    
    // Ignore dummy videos
    if (u.indexOf("trailer") > -1 || u.indexOf("blank") > -1 || u.indexOf("empty") > -1) continue;

    if (!seen[u] && u.indexOf("http") === 0) {
      seen[u] = 1;
      streams.push(makeStream(u, u.indexOf(".m3u8") > -1 ? "HLS Direct" : "MP4 Direct", "url"));
    }
  }
}

function resolveFromWatch(vid) {
  var watchUrl = BASE + "/watch.php?vid=" + vid;
  return fetchText(watchUrl, BASE + "/").then(function(html) {
    var streams = [];
    var seen = {};
    
    html = html.replace(/\\\//g, '/');
    extractLinksFromHtml(html, streams, seen);
    
    // Concurrently fetch see.php to grab anything hidden in the player frame
    var seeUrl = BASE + "/see.php?vid=" + vid;
    return fetchText(seeUrl, watchUrl).then(function(seeHtml) {
      seeHtml = seeHtml.replace(/\\\//g, '/');
      extractLinksFromHtml(seeHtml, streams, seen);
      return streams;
    }).catch(function() {
      return streams; 
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
      if (!all.length) return [];
      var best = chooseResult(all, titles);
      if (!best) return [];
      return resolveFromWatch(best.id);
    });
  }).catch(function() {
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
      
      var withEp = all.filter(function(r) {
        var hasSeasonNum = /الموسم\s*(\d+)/i.exec(r.title) || /موسم\s*(\d+)/i.exec(r.title);
        if (hasSeasonNum && parseInt(hasSeasonNum[1]) !== wantedSeason) {
          return false;
        }
        return new RegExp("(?:الحلق[ةه]\\s*" + wantedEp + "\\b|\\b" + wantedEp + "\\b)", "i").test(r.title);
      });
      
      var pool = withEp.length ? withEp : all;
      if (!pool.length) return [];
      
      var best = chooseResult(pool, titles);
      if (!best) return [];
      return resolveFromWatch(best.id);
    });
  }).catch(function() {
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
