var BASE = "https://ddramacafe-tv.bar";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

// ---------------------------------------------------------------- http
function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (referer) {
    headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) {
      return encodeURIComponent(c);
    });
  }
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

// ---------------------------------------------------------------- text helpers
function decodeHtml(str) {
  return String(str || "")
    .replace(/&#x([0-9a-f]+);/gi, function(_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
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

// ---------------------------------------------------------------- TMDB
function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  var titles = [];
  var year = null;

  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return fetch(apiUrl).then(function(r) { return r.json(); }).then(function(data) {
        var title = type === "movie"
          ? (data.title || data.original_title)
          : (data.name || data.original_name);
        if (title && titles.indexOf(title) === -1) titles.push(title);
        if (!year) {
          var dateStr = type === "movie" ? data.release_date : data.first_air_date;
          if (dateStr) year = dateStr.slice(0, 4);
        }
      }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    console.log("[DramaCafe] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year };
  });
}

// ---------------------------------------------------------------- search
function searchDramaCafe(title) {
  var cleanQ = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(cleanQ);
  console.log("[DramaCafe] Search:", cleanQ);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};

    // Primary: anchors with title attribute pointing at watch.php
    var re = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*title=["']([^"']+)["'][^>]*>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var vid = m[2];
      if (seen[vid]) continue;
      seen[vid] = 1;
      var fullUrl = decodeHtml(m[1]);
      var absolute = fullUrl.indexOf("http") === 0 ? fullUrl : BASE + "/" + fullUrl.replace(/^\//, "");
      results.push({ url: absolute, title: decodeHtml(m[3]), vid: vid });
    }

    // Fallback: any anchor pointing at watch.php
    if (!results.length) {
      var re2 = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*>/gi;
      while ((m = re2.exec(html)) !== null) {
        var vid2 = m[2];
        if (seen[vid2]) continue;
        seen[vid2] = 1;
        var fullUrl2 = decodeHtml(m[1]);
        var absolute2 = fullUrl2.indexOf("http") === 0 ? fullUrl2 : BASE + "/" + fullUrl2.replace(/^\//, "");
        results.push({ url: absolute2, title: vid2, vid: vid2 });
      }
    }

    console.log("[DramaCafe] Search results:", results.length);
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
  if (best) console.log("[DramaCafe] Best match:", best.title, "score:", bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

// ---------------------------------------------------------------- player extraction
// EXACTLY as the working script: embed.php -> first iframe -> extract streams
function findPlayerIframe(embedHtml, embedUrl) {
  // First iframe src on the embed page
  var m = embedHtml.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  if (m) {
    var u = decodeHtml(m[1]);
    if (u.indexOf("//") === 0) u = "https:" + u;
    if (u.indexOf("/") === 0) u = BASE + u;
    return u;
  }
  // data-src lazy iframes
  m = embedHtml.match(/<iframe[^>]*\sdata-src=["']([^"']+)["']/i);
  if (m) {
    var u2 = decodeHtml(m[1]);
    if (u2.indexOf("//") === 0) u2 = "https:" + u2;
    if (u2.indexOf("/") === 0) u2 = BASE + u2;
    return u2;
  }
  // contentUrl meta fallback
  m = embedHtml.match(/contentUrl["'][^>]*content=["']([^"']+)["']/i);
  if (m) {
    var u3 = decodeHtml(m[1]);
    if (u3.indexOf("//") === 0) u3 = "https:" + u3;
    return u3;
  }
  return null;
}

function unpackEval(html) {
  // Standard p,a,c,k,e,d packer
  var m = html.match(/eval\(function\(p,a,c,k,e,(?:d|r)\)\{[\s\S]*?\}\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\s*\.split\('\|'\)/);
  if (!m) return null;
  var payload = m[1].replace(/\\(?:u([0-9a-fA-F]{4})|([\s\S]))/g, function(_, hex, ch) {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    return ch;
  });
  var base = parseInt(m[2], 10);
  var count = parseInt(m[3], 10);
  var keywords = m[4].split("|");
  while (count--) {
    if (keywords[count]) {
      var key = keywords[count];
      // use base 36 encoding like the original packer
      var encoded = count.toString(base > 36 ? 36 : base);
      var pat = new RegExp("\\b" + encoded + "\\b", "g");
      payload = payload.replace(pat, function() { return key; });
    }
  }
  return payload;
}

function extractStreamsFromPlayer(playerHtml) {
  var streams = [];
  var seen = {};
  var unpacked = unpackEval(playerHtml);
  var search = unpacked ? unpacked + "\n" + playerHtml : playerHtml;
  search = search.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
  console.log("[DramaCafe] unpacked:", unpacked ? "yes (" + unpacked.length + " chars)" : "no");

  // Absolute .m3u8 / .mp4 URLs anywhere in the text
  var re = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)(?![A-Za-z0-9_.])(?:[^"'\s<>\\]*)?/gi;
  var m;
  while ((m = re.exec(search)) !== null) {
    var u = m[0];
    if (seen[u]) continue;
    seen[u] = 1;
    streams.push(u);
  }

  // Key=value patterns: file:"...", source:"...", etc.
  var re2 = /(?:file|source|src|url|hls|link|video_url|stream)\s*[:=]\s*["']([^"']+?\.(?:m3u8|mp4)[^"']*)["']/gi;
  while ((m = re2.exec(search)) !== null) {
    var u2 = m[1];
    if (u2.indexOf("http") !== 0) continue;
    if (seen[u2]) continue;
    seen[u2] = 1;
    streams.push(u2);
  }

  // <source src="..."> and <video src="..."> tags
  var re3 = /<(?:source|video)[^>]+\bsrc=["']([^"']+)["']/gi;
  while ((m = re3.exec(search)) !== null) {
    var u3 = m[1];
    if (u3.indexOf("http") !== 0) continue;
    if (!/\.(?:m3u8|mp4)/i.test(u3)) continue;
    if (seen[u3]) continue;
    seen[u3] = 1;
    streams.push(u3);
  }

  console.log("[DramaCafe] m3u8/mp4 found:", streams.length);
  return streams;
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

function originOf(url) {
  var m = String(url || "").match(/^(https?:\/\/[^\/]+)/i);
  return m ? m[1] : "";
}

function makeStream(url, label, playerUrl) {
  var origin = originOf(playerUrl) || BASE;
  var streamReferer = origin + "/";
  if (url.indexOf("http://") === 0) {
    url = "https://" + url.slice(7);
  }
  return {
    name: "⚜️ DramaCafe",
    title: label ? "⚜️ DramaCafe \u2022 " + label : "⚜️ DramaCafe",
    url: url,
    quality: qualityFromUrl(url),
    provider: "dramacafe",
    referer: streamReferer,
    headers: {
      "User-Agent": UA,
      "Referer": streamReferer,
      "Origin": origin,
      "Accept": "*/*"
    }
  };
}

// ---------------------------------------------------------------- resolve one vid
// Exactly like the working script:
//   1. fetch embed.php
//   2. find the first iframe (= the player host)
//   3. fetch that player page
//   4. extract .m3u8 / .mp4
//   5. if none found, return the player URL as an iframe fallback
function resolveVid(vid) {
  var embedUrl = BASE + "/embed.php?vid=" + vid;
  var playUrl  = BASE + "/play.php?vid="  + vid;
  console.log("[DramaCafe] resolving vid:", vid);

  // Try embed.php first, then play.php as fallback
  return fetchText(embedUrl, BASE + "/watch.php?vid=" + vid).then(function(embedHtml) {
    var playerUrl = findPlayerIframe(embedHtml, embedUrl);
    console.log("[DramaCafe] player iframe:", playerUrl || "NOT FOUND");

    if (!playerUrl) {
      // embed page had no iframe — try play.php
      return fetchText(playUrl, BASE + "/watch.php?vid=" + vid).then(function(playHtml) {
        var playerUrl2 = findPlayerIframe(playHtml, playUrl);
        console.log("[DramaCafe] play.php player iframe:", playerUrl2 || "NOT FOUND");
        if (!playerUrl2) return [];
        return fetchAndExtract(playerUrl2, playUrl);
      });
    }

    return fetchAndExtract(playerUrl, embedUrl);
  });
}

function fetchAndExtract(playerUrl, referer) {
  return fetchText(playerUrl, referer).then(function(playerHtml) {
    var directUrls = extractStreamsFromPlayer(playerHtml);
    if (directUrls.length) {
      return directUrls.map(function(u, i) {
        return makeStream(u, "Server " + (i + 1), playerUrl);
      });
    }
    // No direct stream found — return the player page itself as iframe fallback
    // Nuvio can open this inside a webview
    console.log("[DramaCafe] no direct URL — returning iframe fallback");
    return [{
      name: "☕ DramaCafe",
      title: "☕ DramaCafe (Embed)",
      url: playerUrl,
      quality: "Auto",
      type: "iframe",
      provider: "dramacafe",
      referer: referer
    }];
  }).catch(function(err) {
    console.log("[DramaCafe] player fetch failed:", err.message, "— returning iframe fallback");
    return [{
      name: "☕ DramaCafe",
      title: "☕ DramaCafe (Embed)",
      url: playerUrl,
      quality: "Auto",
      type: "iframe",
      provider: "dramacafe",
      referer: referer
    }];
  });
}

// ---------------------------------------------------------------- movies
function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchDramaCafe(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      console.log("[DramaCafe] Unique movie candidates:", all.length);
      if (!all.length) return [];
      var best = chooseResult(all, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function(err) {
    console.log("[DramaCafe] Movie error:", err.message);
    return [];
  });
}

// ---------------------------------------------------------------- TV
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
      return searchDramaCafe(q).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      console.log("[DramaCafe] Unique TV candidates:", all.length);

      // Prefer results that mention the episode number in the title
      var withEp = all.filter(function(r) {
        return new RegExp("(?:الحلق[ةه]\\s*" + wanted + "\\b|\\b" + wanted + "\\b)", "i").test(r.title);
      });
      var pool = withEp.length ? withEp : all;
      console.log("[DramaCafe] TV pool (ep " + wanted + "):", pool.length);
      if (!pool.length) return [];
      var best = chooseResult(pool, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function(err) {
    console.log("[DramaCafe] TV error:", err.message);
    return [];
  });
}

// ---------------------------------------------------------------- entry point
function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[DramaCafe] getStreams:", tmdbId, mediaType, season, episode);
  var result;
  try {
    result = mediaType === "tv"
      ? getTvStreams(tmdbId, season, episode)
      : getMovieStreams(tmdbId);
  } catch (e) {
    console.log("[DramaCafe] fatal:", e.message);
    return Promise.resolve([]);
  }
  return result.catch(function(e) {
    console.log("[DramaCafe] uncaught:", e.message);
    return [];
  });
}

// ---------------------------------------------------------------- export
// Dual export required: module.exports for Node/testing, global for Hermes/React Native
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
