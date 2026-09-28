var BASE = "https://wecima.ac";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

// Cloudflare cookie cache
var _cfCookie = null;

function encodeUrl(u) {
  return String(u).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
}

function fetchText(url, referer) {
  url = encodeUrl(url);
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7"
  };
  if (referer) headers["Referer"] = encodeUrl(referer);
  if (_cfCookie) headers["Cookie"] = _cfCookie;

  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    // capture cf_clearance if present
    try {
      var sc = r.headers.get("set-cookie");
      if (sc) {
        var m = sc.match(/cf_clearance=([^;]+)/);
        if (m) _cfCookie = "cf_clearance=" + m[1];
      }
    } catch (e) {}
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function fetchPost(url, body, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
  };
  if (referer) headers["Referer"] = encodeUrl(referer);
  if (_cfCookie) headers["Cookie"] = _cfCookie;

  return fetch(encodeUrl(url), {
    method: "POST",
    headers: headers,
    body: body,
    redirect: "follow"
  }).then(function(r) {
    try {
      var sc = r.headers.get("set-cookie");
      if (sc) {
        var m = sc.match(/cf_clearance=([^;]+)/);
        if (m) _cfCookie = "cf_clearance=" + m[1];
      }
    } catch (e) {}
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

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  var titles = [];

  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" +
        encodeURIComponent(tmdbId) +
        "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return fetch(apiUrl)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var t = type === "movie"
            ? (data.title || data.original_title)
            : (data.name || data.original_name);
          if (t && titles.indexOf(t) === -1) titles.push(t);
        })
        .catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    console.log("[WeCima] TMDB titles:", titles.join(" | "));
    return titles;
  });
}

function searchWeCima(query) {
  var url = BASE + "/search";
  var body = "q=" + encodeURIComponent(query);
  console.log("[WeCima] Search POST:", url, "q=" + query);

  return fetchPost(url, body, BASE + "/").then(function(text) {
    var results = [];
    try {
      var data = JSON.parse(text);
      if (data && data.results) {
        data.results.forEach(function(item) {
          if (item.istv === 2) return; // skip
          var isTv = item.istv !== 0;
          var prefix = isTv ? "/series/" : "/watch/";
          var slug = item.slug || "";
          if (!slug) return;
          var itemUrl = slug.startsWith("http")
            ? slug
            : BASE + prefix + encodeURIComponent(slug);
          results.push({
            title: item.title || "",
            url: itemUrl,
            isTv: isTv,
            year: item.year
          });
        });
      }
    } catch (e) {
      console.log("[WeCima] search parse error:", e.message);
    }
    console.log("[WeCima] Search results:", results.length);
    return results;
  });
}

function base64Decode(str) {
  // Try global atob first (available in most JS runtimes)
  try {
    if (typeof atob === "function") return atob(str);
  } catch (e) {}
  // Fallback
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(str, "base64").toString("utf-8");
    }
  } catch (e) {}
  return null;
}

function decodeWecimaUrl(encoded) {
  try {
    if (!encoded) return null;
    var cleaned = String(encoded).replace(/\+/g, "").trim();
    var final = cleaned.indexOf("aHR0c") === 0 ? cleaned : "aHR0c" + cleaned;
    var decoded = base64Decode(final);
    if (!decoded) return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

function extractStreamsFromEpisodePage(html) {
  var streams = [];
  var seen = new Set();

  // Look for data-url on server buttons
  var re = /data-url\s*=\s*["']([^"']+)["']/gi;
  var m;
  var idx = 0;

  while ((m = re.exec(html)) !== null) {
    var decoded = decodeWecimaUrl(m[1]);
    if (decoded && decoded.indexOf("http") === 0 && !seen.has(decoded)) {
      seen.add(decoded);
      idx++;
      streams.push({
        name: "WeCima",
        title: "WeCima Server " + idx,
        url: decoded,
        quality: "Unknown",
        referer: BASE + "/"
      });
    }
  }

  // Also try data-href (download buttons)
  var re2 = /data-href\s*=\s*["']([^"']+)["']/gi;
  while ((m = re2.exec(html)) !== null) {
    var dec2 = decodeWecimaUrl(m[1]);
    if (dec2 && dec2.indexOf("http") === 0 && !seen.has(dec2)) {
      seen.add(dec2);
      idx++;
      streams.push({
        name: "WeCima",
        title: "WeCima Download " + idx,
        url: dec2,
        quality: "Unknown",
        referer: BASE + "/"
      });
    }
  }

  return streams;
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(titles) {
    if (!titles.length) return [];
    return searchWeCima(titles[0]).then(function(results) {
      if (!results.length) {
        console.log("[WeCima] no movie results");
        return [];
      }
      // Take first result
      var best = results[0];
      console.log("[WeCima] selected:", best.title, best.url);

      // If it's already a /watch/ URL, extract streams
      if (best.url.indexOf("/watch/") !== -1) {
        return fetchText(best.url, BASE + "/").then(function(html) {
          return extractStreamsFromEpisodePage(html);
        });
      }

      // Otherwise, fetch the page and look for a watch link
      return fetchText(best.url, BASE + "/").then(function(html) {
        var m = html.match(/href=["']([^"']*\/watch\/[^"']+)["']/i);
        if (!m) {
          console.log("[WeCima] no watch link on movie page");
          return [];
        }
        var watchUrl = m[1].indexOf("http") === 0 ? m[1] : BASE + m[1];
        return fetchText(watchUrl, best.url).then(function(whtml) {
          return extractStreamsFromEpisodePage(whtml);
        });
      });
    });
  });
}

function getTvStreams(tmdbId, season, episode) {
  return getTmdbTitles(tmdbId, "tv").then(function(titles) {
    if (!titles.length) return [];
    return searchWeCima(titles[0]).then(function(results) {
      if (!results.length) {
        console.log("[WeCima] no TV results");
        return [];
      }
      // Pick first TV result
      var best = results.find(function(r) { return r.isTv; }) || results[0];
      console.log("[WeCima] selected TV:", best.title, best.url);

      // Fetch series page, find episode link matching season/episode
      return fetchText(best.url, BASE + "/").then(function(html) {
        // Look for links with "الحلقة" or "Episode"
        var epLinks = [];
        var re = /href=["']([^"']*\/watch\/[^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
          var u = decodeHtml(m[1]);
          if (epLinks.indexOf(u) === -1) epLinks.push(u);
        }

        if (!epLinks.length) {
          console.log("[WeCima] no episode links found");
          return [];
        }

        // Try to match episode number
        var wanted = Number(episode) || 1;
        var selected = epLinks.filter(function(u) {
          var dec = "";
          try { dec = decodeURIComponent(u); } catch (e) { dec = u; }
          var mm = dec.match(/الحلق[ةه][^0-9]*([0-9]+)/i) ||
                   u.match(/-([0-9]+)(?:[/?#]|$)/);
          return mm && Number(mm[1]) === wanted;
        });

        var target = selected.length ? selected[0] : epLinks[Math.min(wanted - 1, epLinks.length - 1)];
        if (!target) return [];

        var watchUrl = target.indexOf("http") === 0 ? target : BASE + target;
        console.log("[WeCima] episode page:", watchUrl);

        return fetchText(watchUrl, best.url).then(function(ehtml) {
          return extractStreamsFromEpisodePage(ehtml);
        });
      });
    });
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[WeCima] getStreams:", tmdbId, mediaType, season, episode);
  var fn = mediaType === "tv"
    ? getTvStreams(tmdbId, season, episode)
    : getMovieStreams(tmdbId);
  return fn.catch(function(err) {
    console.log("[WeCima] error:", err.message);
    return [];
  });
}

module.exports = { getStreams: getStreams };
