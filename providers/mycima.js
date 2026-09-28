var BASE = "https://wecima.show";
var PROXY = "https://api.allorigins.win/raw?url=";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

// Uses allorigins proxy to bypass Cloudflare 403 on datacenter IPs
// (proven pattern from stremio-addon commit 695a1c5)
function proxyFetch(url, referer) {
  var target = PROXY + encodeURIComponent(url);
  var headers = { "User-Agent": UA };
  if (referer) headers["Referer"] = referer;
  return fetch(target, { headers: headers }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function directFetch(url, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar,en-US;q=0.9,en;q=0.8"
  };
  if (referer) headers["Referer"] = referer;
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

// Try direct first, fall back to proxy if blocked
function fetchText(url, referer) {
  return directFetch(url, referer).catch(function(err) {
    console.log("[WeCima] direct failed (" + err.message + "), trying proxy");
    return proxyFetch(url, referer);
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
  return decodeHtml(String(str || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
    dataArr.forEach(function(d) {
      if (!d) return;
      var t = type === "movie" ? (d.title || d.original_title) : (d.name || d.original_name);
      if (t && titles.indexOf(t) === -1) titles.push(t);
    });
    console.log("[WeCima] TMDB titles:", titles.join(" | "));
    return titles;
  });
}

// Search via Stremify's exact endpoint
function searchWeCima(query) {
  var url = BASE + "/AjaxCenter/Searching/" + encodeURIComponent(query);
  console.log("[WeCima] Search:", query);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    // Matches Stremify's regex: extracts href + name from result cards
    var re = /href=["']([^"']*\/watch\/[^"']+|\/[^"']*\/series\/[^"']+)["'][^>]*>[\s\S]{0,300}?<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = decodeHtml(m[1]);
      if (seen[u]) continue;
      seen[u] = 1;
      var abs = u.indexOf("http") === 0 ? u : BASE + u;
      results.push({ url: abs, title: stripHtml(m[2]) });
    }
    // Fallback: broad href extraction
    if (!results.length) {
      var re2 = /<a[^>]*href=["']([^"']*\/(?:watch|series)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = re2.exec(html)) !== null) {
        var u2 = decodeHtml(m[1]);
        if (seen[u2]) continue;
        seen[u2] = 1;
        var abs2 = u2.indexOf("http") === 0 ? u2 : BASE + u2;
        var title = stripHtml(m[2]);
        if (title.length > 1) results.push({ url: abs2, title: title });
      }
    }
    console.log("[WeCima] results:", query, results.length);
    return results;
  }).catch(function(err) {
    console.log("[WeCima] search error:", err.message);
    return [];
  });
}

// Govid resolver — matches Stremify's govvidResolve
function resolveGovid(govidUrl) {
  console.log("[WeCima] govid:", govidUrl);
  return fetchText(govidUrl, BASE + "/").then(function(html) {
    var streams = [];
    var seen = {};
    var re = /\b((https?:\/\/(?:www\.)?[^ \n"'<>]+\.mp4))\b/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = m[1];
      if (seen[u]) continue;
      seen[u] = 1;
      streams.push(u);
    }
    console.log("[WeCima] mp4 links found:", streams.length);
    return streams;
  }).catch(function(err) {
    console.log("[WeCima] govid error:", err.message);
    return [];
  });
}

// Find GoViD link in page HTML (Stremify's exact regex)
function findGovid(html) {
  var m = html.match(/url="([^"]*)"[^>]*class="[^"]*hoverable[^"]*"[^>]*>[\s\S]{0,50}?GoViD/i);
  if (m) return m[1];
  m = html.match(/https?:\/\/govid\.[^"'\s<>]+/i);
  if (m) return m[0];
  return null;
}

function getStreamsFromPage(pageUrl) {
  return fetchText(pageUrl, BASE + "/").then(function(html) {
    var govidUrl = findGovid(html);
    if (govidUrl) {
      return resolveGovid(govidUrl).then(function(urls) {
        return urls.map(function(u, i) {
          return {
            name: "WeCima",
            title: "WeCima Server " + (i + 1),
            url: u,
            quality: "Unknown",
            referer: BASE + "/"
          };
        });
      });
    }
    // Direct mp4 in page
    var urls = [];
    var re = /\b(https?:\/\/[^ \n"'<>]+\.mp4)\b/g;
    var m;
    while ((m = re.exec(html)) !== null) urls.push(m[1]);
    return urls.map(function(u, i) {
      return { name: "WeCima", title: "WeCima " + (i + 1), url: u, quality: "Unknown", referer: BASE + "/" };
    });
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(titles) {
    if (!titles.length) return [];
    return searchWeCima(titles[0]).then(function(results) {
      if (!results.length) return [];
      var best = results[0];
      console.log("[WeCima] movie:", best.title);
      return getStreamsFromPage(best.url);
    });
  }).catch(function(err) {
    console.log("[WeCima] movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  return getTmdbTitles(tmdbId, "tv").then(function(titles) {
    if (!titles.length) return [];
    return searchWeCima(titles[0]).then(function(results) {
      if (!results.length) return [];
      var best = results[0];
      console.log("[WeCima] TV:", best.title);
      return fetchText(best.url, BASE + "/").then(function(html) {
        // Extract episode links
        var epLinks = [];
        var seen = {};
        var re = /href=["']([^"']*\/(?:watch|episode)\/[^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
          var u = decodeHtml(m[1]);
          var abs = u.indexOf("http") === 0 ? u : BASE + u;
          if (!seen[abs]) { seen[abs] = 1; epLinks.push(abs); }
        }
        console.log("[WeCima] episodes found:", epLinks.length);
        var wanted = Number(episode) || 1;
        var selected = [];
        for (var i = 0; i < epLinks.length; i++) {
          var dec = "";
          try { dec = decodeURIComponent(epLinks[i]); } catch (e) { dec = epLinks[i]; }
          var mm = dec.match(/الحلق[ةه][^0-9]*([0-9]+)/i);
          if (mm && Number(mm[1]) === wanted) selected.push(epLinks[i]);
        }
        if (!selected.length && epLinks.length >= wanted) selected = [epLinks[wanted - 1]];
        if (!selected.length) return [];
        return getStreamsFromPage(selected[0]);
      });
    });
  }).catch(function(err) {
    console.log("[WeCima] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[WeCima] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
