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

function fetchJson(url, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest"
  };
  if (referer) headers["Referer"] = referer;
  return fetch(url, { headers: headers, redirect: "follow" })
    .then(function(r) { return r.text(); })
    .then(function(t) {
      try { return JSON.parse(t); } catch (e) { return null; }
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

// ── NEW: Search via AJAX JSON endpoint (was scraping HTML before) ──
function searchShahid(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  // The search page loads results from this endpoint via AJAX.
  var url = SEARCH_BASE + "/search.php?keywords=" + encodeURIComponent(cleanTitle) + "&ajax=1";
  console.log("[ShahidMosalsalat] Search:", cleanTitle, url);
  return fetchJson(url, SEARCH_BASE + "/").then(function(data) {
    if (!data) return [];
    // Response may be an array of items or an object with a results/data key.
    var list = Array.isArray(data) ? data : (data.results || data.data || data.items || []);
    var results = [];
    var seen = {};
    list.forEach(function(item) {
      var vid = item.vid || item.id || item.video_id || (item.url && (item.url.match(/vid=([^&"']+)/) || [])[1]);
      var t = item.title || item.name || item.post_title || "";
      if (!vid || seen[vid]) return;
      seen[vid] = 1;
      results.push({ vid: String(vid), title: decodeHtml(t) });
    });
    console.log("[ShahidMosalsalat] Search results:", results.length);
    return results;
  }).catch(function(e) {
    console.log("[ShahidMosalsalat] Search error:", e.message);
    return [];
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

// ── FIXED: Parse embed URL from watch page (multiple patterns + JSON) ──
function extractEmbedUrl(watchHtml) {
  // Direct patterns from the original script
  var m = watchHtml.match(/embed_url\s*[:=]\s*["']([^"']+)["']/i);
  if (m) return decodeHtml(m[1]);
  m = watchHtml.match(/contentUrl["'][^>]*content\s*=\s*["']([^"']+)["']/i);
  if (m) return decodeHtml(m[1]);
  // Iframe with common streaming hosts
  m = watchHtml.match(/<iframe[^>]*src\s*=\s*["'](https?:\/\/(?:[^"']*(?:vk\.com|ok\.ru|vidmoly|uqload|1vid|mixdrop|vidspeed|hgcloud|vidhide|dood|streamtape|filemoon|voe|upstream|mp4upload|sendvid|sibnet)[^"']*))["']/i);
  if (m) return decodeHtml(m[1]);
  // Any iframe pointing off-site
  m = watchHtml.match(/<iframe[^>]*src\s*=\s*["'](https?:\/\/(?!.*shahidmosalsalat)[^"']+)["']/i);
  if (m) return decodeHtml(m[1]);
  // JSON blob inside script tags
  m = watchHtml.match(/["'](?:file|source|url|src)["']\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
  if (m) return decodeHtml(m[1]);
  return null;
}

// === VK resolver — unchanged from original ===
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

    var hlsRe = /"hls"\s*:\s*"([^"]+)"/gi;
    while ((m = hlsRe.exec(vkHtml)) !== null) add(m[1]);

    var urlRe = /"url(\d{3,4})"\s*:\s*"([^"]+)"/gi;
    while ((m = urlRe.exec(vkHtml)) !== null) add(m[2]);

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
