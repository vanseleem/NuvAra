var BASE = "https://v5.shahidmosalsalat.business";
var SEARCH_BASE = "https://r.shahidmosalsalat.me";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
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
  var langs = ["ar", "en"];
  var titles = [];
  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return fetch(apiUrl).then(function(r) { return r.json(); }).then(function(data) {
        var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
        if (title && titles.indexOf(title) === -1) titles.push(title);
      }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    console.log("[ShahidMosalsalat] TMDB titles:", titles.join(" | "));
    return { titles: titles };
  });
}

function searchShahid(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = SEARCH_BASE + "/search.php?keywords=" + encodeURIComponent(cleanTitle);
  console.log("[ShahidMosalsalat] Search:", cleanTitle);
  return fetchText(url, SEARCH_BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    var re = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*title=["']([^"']+)["'][^>]*>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var vid = m[2];
      var linkTitle = decodeHtml(m[3]);
      if (seen[vid]) continue;
      seen[vid] = 1;
      results.push({ vid: vid, title: linkTitle });
    }
    console.log("[ShahidMosalsalat] Search results:", results.length);
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
  if (best) console.log("[ShahidMosalsalat] Best:", best.title, "score:", bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

function extractEmbedUrl(watchHtml) {
  var m = watchHtml.match(/embed_url:\s*["']([^"']+)["']/i);
  if (m) return decodeHtml(m[1]);
  m = watchHtml.match(/contentUrl["'][^>]*content=["']([^"']+)["']/i);
  if (m) return decodeHtml(m[1]);
  m = watchHtml.match(/<iframe[^>]*src=["'](https?:\/\/[^"']+)["']/i);
  if (m) return decodeHtml(m[1]);
  return null;
}

// === VK resolver — extracts HLS URL from vk.com/video_ext.php ===
function resolveVk(vkUrl) {
  console.log("[ShahidMosalsalat] VK:", vkUrl);
  return fetchText(vkUrl, "https://vk.com/").then(function(vkHtml) {
    var urls = [];
    var seen = {};

    function decode(u) {
      if (!u) return "";
      return String(u)
        .replace(/\\\//g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\u002F/g, "/")
        .replace(/&amp;/g, "&");
    }

    function add(u) {
      u = decode(u);
      if (!u) return;
      if (u.indexOf("http") !== 0) return;
      if (seen[u]) return;
      seen[u] = 1;
      urls.push(u);
    }

    var m;

    // 1) PRIMARY: HLS field — new VK format
    var hlsRe = /"hls"\s*:\s*"([^"]+)"/gi;
    while ((m = hlsRe.exec(vkHtml)) !== null) add(m[1]);

    // 2) Legacy: url240, url360, url480, url720, url1080
    var urlRe = /"url(\d{3,4})"\s*:\s*"([^"]+)"/gi;
    while ((m = urlRe.exec(vkHtml)) !== null) add(m[2]);

    // 3) Any direct m3u8/mp4 anywhere in the page
    var rawRe = /https?:\\?\/\\?\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/gi;
    while ((m = rawRe.exec(vkHtml)) !== null) add(m[0]);

    console.log("[ShahidMosalsalat] VK URLs found:", urls.length);
    return urls;
  });
}

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  if (/240/.test(s)) return "240p";
  return "Unknown";
}

function makeStream(url, label) {
  if (url.indexOf("http://") === 0) url = "https://" + url.slice(7);
  var isHls = /\.m3u8/i.test(url);
  return {
    name: "⚜️ ShahidMosalsalat",
    title: label ? "⚜️ ShahidMosalsalat \u2022 " + label : "⚜️ ShahidMosalsalat",
    url: url,
    quality: qualityFromUrl(url),
    type: isHls ? "hls" : "mp4",
    referer: "https://vk.com/",
    headers: {
      "User-Agent": UA,
      "Referer": "https://vk.com/",
      "Origin": "https://vk.com",
      "Accept": "*/*"
    }
  };
}

function resolveVid(vid) {
  var watchUrl = BASE + "/watch.php?vid=" + vid;
  console.log("[ShahidMosalsalat] watch:", watchUrl);
  return fetchText(watchUrl, BASE + "/").then(function(watchHtml) {
    var embedUrl = extractEmbedUrl(watchHtml);
    console.log("[ShahidMosalsalat] embed:", embedUrl || "NOT FOUND");
    if (!embedUrl) return [];
    return resolveVk(embedUrl).then(function(urls) {
      if (!urls.length) {
        console.log("[ShahidMosalsalat] No VK URLs — returning embed fallback");
        return [{
          name: "⚜️ ShahidMosalsalat",
          title: "⚜️ ShahidMosalsalat (Embed)",
          url: embedUrl,
          quality: "Auto",
          type: "iframe",
          referer: watchUrl
        }];
      }
      return urls.map(function(u, i) {
        return makeStream(u, qualityFromUrl(u) || ("Server " + (i + 1)));
      });
    });
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchShahid(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      console.log("[ShahidMosalsalat] Movie candidates:", all.length);
      if (!all.length) return [];
      var best = chooseResult(all, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function(err) {
    console.log("[ShahidMosalsalat] Movie error:", err.message);
    return [];
  });
}

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
      return searchShahid(q).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      console.log("[ShahidMosalsalat] TV candidates:", all.length);
      var withEp = all.filter(function(r) {
        return new RegExp("(?:الحلق[ةه]\\s*" + wanted + "\\b|\\b" + wanted + "\\b)", "i").test(r.title);
      });
      var pool = withEp.length ? withEp : all;
      if (!pool.length) return [];
      var best = chooseResult(pool, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function(err) {
    console.log("[ShahidMosalsalat] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[ShahidMosalsalat] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
