// ─────────────────────────────────────────────────────────────────────
// ShahidMosalsalat — original structure + AhwakTV URL fetch logic
// ─────────────────────────────────────────────────────────────────────
var BASE = "https://v5.shahidmosalsalat.business";
var SEARCH_BASE = "https://r.shahidmosalsalat.me";
var PROVIDER_ID = "shahidmosalsalat";
var PROVIDER_NAME = "⚜️ ShahidMosalsalat";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

var SITE_TIMEOUT = 15000;
var EMBED_TIMEOUT = 12000;
var MAX_SEARCH_PAGES = 3;

var UA_SITE = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var UA_EMBED = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function log(message) {
  console.log("[ShahidMosalsalat] " + message);
}

// ─────────────────────────── Ahwak HTTP layer ─────────────────────────

function asciiSafe(value) {
  return String(value).replace(/[^\x00-\x7F]/g, function (c) { return encodeURIComponent(c); });
}

function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== "function") return promise;
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error("timeout: " + label)); }, ms);
    promise.then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); }
    );
  });
}

function fetchText(url, headers, timeoutMs) {
  url = asciiSafe(url);
  if (headers && headers["Referer"]) headers["Referer"] = asciiSafe(headers["Referer"]);
  return withTimeout(fetch(url, { method: "GET", headers: headers, redirect: "follow" }), timeoutMs, url.split("?")[0])
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    });
}

function siteGet(url, referer) {
  return fetchText(url, {
    "User-Agent": UA_SITE,
    "Referer": referer || BASE + "/",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "ar,en;q=0.9"
  }, SITE_TIMEOUT);
}

function hostOf(url) {
  var m = /^https?:\/\/([^\/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}

function originOf(url) {
  var m = /^(https?:\/\/[^\/?#]+)/i.exec(url);
  return m ? m[1] : "";
}

function absoluteUrl(url, baseUrl) {
  var u = String(url || "").trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.charAt(0) === "/") return originOf(baseUrl) + u;
  return "";
}

function decodeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function getAttr(tag, name) {
  var m = new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i").exec(tag);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : "";
}

// ─────────────────────── Ahwak anchor + pagination ────────────────────

function parseWatchAnchors(html) {
  var byVid = {};
  var out = [];
  var re = /<a\b[^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var tag = m[0];
    var idMatch = /watch\.php\?vid=([A-Za-z0-9]+)/.exec(decodeHtml(getAttr(tag, "href")));
    if (!idMatch) continue;
    var vid = idMatch[1];
    var title = decodeHtml(getAttr(tag, "title")).trim();
    if (byVid[vid]) {
      if (!byVid[vid].title && title) byVid[vid].title = title;
      continue;
    }
    byVid[vid] = { vid: vid, title: title };
    out.push(byVid[vid]);
  }
  return out;
}

function parseMaxPage(html) {
  var max = 1;
  var re = /[?&;]page=(\d+)/g;
  var m;
  while ((m = re.exec(html)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return max;
}

// ─────────────── Original ShahidMosalsalat scoring ────────────────────

function normalizeTitle(str) {
  return String(str || "").toLowerCase()
    .replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = normalizeTitle(a); b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
  var aa = a.split(" "); var bb = b.split(" ");
  var setB = {}; bb.forEach(function (x) { setB[x] = 1; });
  var common = 0;
  aa.forEach(function (x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

function chooseResult(results, titles) {
  var best = null, bestScore = 0;
  results.forEach(function (r) {
    var s = 0;
    titles.forEach(function (t) {
      var sc = similarity(r.title, t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (best) log("best: " + best.title + " score: " + bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  var titles = [];
  return langs.reduce(function (chain, lang) {
    return chain.then(function () {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return fetch(apiUrl).then(function (r) { return r.json(); }).then(function (data) {
        var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
        if (title && titles.indexOf(title) === -1) titles.push(title);
      }).catch(function () {});
    });
  }, Promise.resolve()).then(function () {
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    log("TMDB titles: " + titles.join(" | "));
    return { titles: titles };
  });
}

// ───────────── Ahwak paged search (replaces single-page search) ───────

function searchPage(query, page) {
  var url = SEARCH_BASE + "/search.php?keywords=" + encodeURIComponent(query) + (page > 1 ? "&page=" + page : "");
  return siteGet(url, SEARCH_BASE + "/").then(function (html) {
    return {
      entries: parseWatchAnchors(html).filter(function (a) { return a.title; }),
      maxPage: parseMaxPage(html)
    };
  });
}

function searchPages(query, onEntries) {
  var page = 1;
  function step() {
    return searchPage(query, page).then(function (res) {
      if (onEntries(res.entries)) return true;
      if (page >= MAX_SEARCH_PAGES || page >= res.maxPage) return false;
      page += 1;
      return step();
    }).catch(function (err) {
      log("search failed (" + query + " p" + page + "): " + (err && err.message));
      return false;
    });
  }
  return step();
}

// ───────────── Ahwak embed extractor (replaces extractEmbedUrl) ───────

function fetchEmbedUrls(vid) {
  var watchUrl = BASE + "/watch.php?vid=" + vid;
  return siteGet(watchUrl, BASE + "/").then(function (html) {
    var urls = [];
    var seen = {};
    var baseHost = hostOf(BASE);
    function add(u) {
      u = absoluteUrl(decodeHtml(u), BASE);
      if (!u || seen[u]) return;
      if (hostOf(u) === baseHost) return;
      seen[u] = true;
      urls.push(u);
    }
    function collect(re) {
      var m;
      while ((m = re.exec(html)) !== null) add(m[1]);
    }
    // Ahwak patterns
    collect(/<iframe\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi);
    collect(/data-embed-url\s*=\s*["']([^"']+)["']/gi);
    // Site-specific patterns (kept from original ShahidMosalsalat)
    collect(/embed_url:\s*["']([^"']+)["']/gi);
    collect(/contentUrl["'][^>]*content=["']([^"']+)["']/gi);
    return urls;
  });
}

// ───────────── Original ShahidMosalsalat VK resolver ──────────────────

function resolveVk(vkUrl) {
  log("VK: " + vkUrl);
  return fetchText(vkUrl, {
    "User-Agent": UA_EMBED,
    "Referer": "https://vk.com/"
  }, EMBED_TIMEOUT).then(function (vkHtml) {
    var urls = [];
    var seen = {};
    function decode(u) {
      if (!u) return "";
      return String(u).replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/\\u002F/g, "/").replace(/&amp;/g, "&");
    }
    function add(u) {
      u = decode(u);
      if (!u || u.indexOf("http") !== 0 || seen[u]) return;
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
    log("VK URLs found: " + urls.length);
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
    name: PROVIDER_NAME,
    title: label ? PROVIDER_NAME + " \u2022 " + label : PROVIDER_NAME,
    url: url,
    quality: qualityFromUrl(url),
    type: isHls ? "hls" : "mp4",
    referer: "https://vk.com/",
    headers: {
      "User-Agent": UA_EMBED,
      "Referer": "https://vk.com/",
      "Origin": "https://vk.com",
      "Accept": "*/*"
    },
    provider: PROVIDER_ID
  };
}

// ─────────────── Original resolveVid using Ahwak embeds ───────────────

function resolveVid(vid) {
  var watchUrl = BASE + "/watch.php?vid=" + vid;
  log("watch: " + watchUrl);
  return fetchEmbedUrls(vid).then(function (embedUrls) {
    log("embeds: " + embedUrls.length + " [" + embedUrls.map(hostOf).join(", ") + "]");
    if (!embedUrls.length) return [];

    // Prefer VK embed, else use the first found embed.
    var embedUrl = null;
    for (var i = 0; i < embedUrls.length; i++) {
      if (/(^|\.)vk\.com$|vkvideo\.ru$/.test(hostOf(embedUrls[i]))) { embedUrl = embedUrls[i]; break; }
    }
    if (!embedUrl) embedUrl = embedUrls[0];

    return resolveVk(embedUrl).then(function (urls) {
      if (!urls.length) {
        log("No VK URLs — returning embed fallback");
        return [{
          name: PROVIDER_NAME,
          title: PROVIDER_NAME + " (Embed)",
          url: embedUrl,
          quality: "Auto",
          type: "iframe",
          referer: watchUrl,
          provider: PROVIDER_ID
        }];
      }
      return urls.map(function (u, i) {
        return makeStream(u, qualityFromUrl(u) || ("Server " + (i + 1)));
      });
    });
  });
}

// ───────────── Original movie / TV flow, using Ahwak search ───────────

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function (meta) {
    var all = [], seen = {};
    var qi = 0;
    function nextQuery() {
      if (qi >= meta.titles.length) return Promise.resolve();
      var t = meta.titles[qi++];
      return searchPages(t, function (entries) {
        entries.forEach(function (r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
        return false;
      }).then(nextQuery);
    }
    return nextQuery().then(function () {
      log("Movie candidates: " + all.length);
      if (!all.length) return [];
      var best = chooseResult(all, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function (err) {
    log("Movie error: " + err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var wanted = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function (meta) {
    var queries = [];
    meta.titles.forEach(function (t) {
      queries.push(t + " الحلقة " + wanted);
      queries.push(t + " " + wanted);
      queries.push(t);
    });
    var all = [], seen = {};
    var qi = 0;
    function nextQuery() {
      if (qi >= queries.length) return Promise.resolve();
      var q = queries[qi++];
      return searchPages(q, function (entries) {
        entries.forEach(function (r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
        return false;
      }).then(nextQuery);
    }
    return nextQuery().then(function () {
      log("TV candidates: " + all.length);
      var withEp = all.filter(function (r) {
        return new RegExp("(?:الحلق[ةه]\\s*" + wanted + "\\b|\\b" + wanted + "\\b)", "i").test(r.title);
      });
      var pool = withEp.length ? withEp : all;
      if (!pool.length) return [];
      var best = chooseResult(pool, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function (err) {
    log("TV error: " + err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  log("getStreams: " + tmdbId + " " + mediaType + " " + season + " " + episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
