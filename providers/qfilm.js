var BASE = "https://a.qfilm.tv";
var PROVIDER_ID = "qfilm";
var PROVIDER_NAME = "🧿 QFilm";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var UA_EMBED = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function log(m) { console.log("[QFilm] " + m); }

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
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
  var year = null;

  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return fetch(apiUrl).then(function(r) { return r.json(); }).then(function(data) {
        var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
        if (title && titles.indexOf(title) === -1) titles.push(title);
        if (!year) {
          var dateStr = type === "movie" ? data.release_date : data.first_air_date;
          if (dateStr) year = dateStr.slice(0, 4);
        }
      }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    log("TMDB titles: " + titles.join(" | "));
    return { titles: titles, year: year };
  });
}

function searchQFilm(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(cleanTitle);
  log("Search: " + cleanTitle);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    var re = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*title=["']([^"']+)["'][^>]*>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var fullUrl = decodeHtml(m[1]);
      var vid = m[2];
      var linkTitle = decodeHtml(m[3]);
      if (seen[vid]) continue;
      seen[vid] = 1;
      var absolute = fullUrl.indexOf("http") === 0 ? fullUrl : BASE + fullUrl;
      results.push({ url: absolute, title: linkTitle, vid: vid });
    }
    if (!results.length) {
      var re2 = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*>/gi;
      while ((m = re2.exec(html)) !== null) {
        var fullUrl2 = decodeHtml(m[1]);
        var vid2 = m[2];
        if (seen[vid2]) continue;
        seen[vid2] = 1;
        var absolute2 = fullUrl2.indexOf("http") === 0 ? fullUrl2 : BASE + fullUrl2;
        results.push({ url: absolute2, title: vid2, vid: vid2 });
      }
    }
    log("Search results: " + results.length);
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
  if (best) log("Best: " + best.title + " score: " + bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

// ═══════════════════════════════════════════════════════════════════════
// NEW: Generic extraction layer (same approach as Ahwak)
// ═══════════════════════════════════════════════════════════════════════

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "2160p";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  if (/240/.test(s)) return "240p";
  var m = /(\d{3,4})p\b/i.exec(s);
  return m ? m[1] + "p" : null;
}

function qualityRank(q) {
  if (q === "Auto") return 1080;
  var n = parseInt(q, 10);
  return isNaN(n) ? 0 : n;
}

function cleanMediaUrl(url) {
  return String(url)
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
}

function unpackAll(text) {
  var out = [];
  if (text.indexOf("p,a,c,k,e") === -1) return out;
  var digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  var patterns = [
    /\}\(\s*'((?:[^'\\]|\\[\s\S])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\[\s\S])*)'\s*\.split\(\s*'\|'\s*\)/g,
    /\}\(\s*"((?:[^"\\]|\\[\s\S])*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\[\s\S])*)"\s*\.split\(\s*"\|"\s*\)/g
  ];
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) {
      var radix = parseInt(m[2], 10);
      var words = m[4].split("|");
      var payload = m[1].replace(/\\\\/g, "\\").replace(/\\'/g, "'").replace(/\\"/g, '"');
      out.push(payload.replace(/\b\w+\b/g, function (w) {
        var n = 0;
        for (var i = 0; i < w.length; i++) {
          var d = digits.indexOf(w.charAt(i));
          if (d < 0 || d >= radix) return w;
          n = n * radix + d;
        }
        return words[n] ? words[n] : w;
      }));
    }
  });
  return out;
}

var BAD_ASSET = /\.(?:jpe?g|png|gif|webp|vtt|srt|css|js|json|html?)(?:[?#]|$)/i;

function scanMediaUrls(text, baseUrl) {
  var patterns = [
    /sources\s*:\s*\[\s*\{\s*["']?file["']?\s*:\s*["']([^"']+)["']/gi,
    /sources\s*:\s*\[\s*["']([^"']+)["']/gi,
    /["']?file["']?\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
    /["']hls\d*["']\s*:\s*["']([^"']+)["']/gi,
    /wurl\s*=\s*["']([^"']+)["']/gi,
    /["'](https?:\\?\/\\?\/[^"'\s]+?\.(?:m3u8|mp4)[^"'\s]*)["']/gi
  ];
  var found = [];
  var seen = {};
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) {
      var url = cleanMediaUrl(m[1]);
      if (url.indexOf("http") !== 0) continue;
      if (seen[url] || BAD_ASSET.test(url)) continue;
      seen[url] = true;
      found.push(url);
    }
  });
  return found;
}

function extractGeneric(embedUrl) {
  return fetchText(embedUrl, embedUrl).then(function (html) {
    var texts = [html].concat(unpackAll(html));
    var urls = [];
    texts.forEach(function (t) {
      scanMediaUrls(t, embedUrl).forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
    });
    var origin = embedUrl.replace(/^(https?:\/\/[^\/]+).*/, "$1");
    return urls.map(function (u) {
      var isHls = /\.m3u8/i.test(u);
      return {
        url: u,
        quality: isHls ? "Auto" : (qualityFromUrl(u) || "Unknown"),
        headers: { "User-Agent": UA_EMBED, "Referer": origin + "/" }
      };
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// MODIFIED: resolveVid now attempts extraction
// ═══════════════════════════════════════════════════════════════════════

function resolveVid(vid) {
  var playUrl = BASE + "/play.php?vid=" + vid;
  log("play: " + playUrl);
  return fetchText(playUrl, BASE + "/").then(function(html) {
    var m = html.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) { log("no servers array found"); return []; }

    var rawServers;
    try { rawServers = JSON.parse(m[1]); }
    catch (e) { log("servers JSON parse failed: " + e.message); return []; }

    var labels = {};
    var btnRe = /<button[^>]*id="server-btn-(\d+)"[^>]*>[\s\S]*?<\/div>\s*([^<]+)\s*<\/button>/gi;
    var bm;
    while ((bm = btnRe.exec(html)) !== null) {
      labels[parseInt(bm[1], 10)] = decodeHtml(bm[2]).trim();
    }

    // Build a list of embed URLs with labels
    var embedList = [];
    rawServers.forEach(function(srv, idx) {
      var srcMatch = srv.match(/src="([^"]+)"/);
      if (!srcMatch) return;
      var rawUrl = srcMatch[1].replace(/\\\//g, "/").replace(/\\"/g, "");
      if (rawUrl.indexOf("//") === 0) rawUrl = "https:" + rawUrl;
      if (rawUrl.indexOf("http") !== 0) return;
      var label = labels[idx] || ("Server " + (idx + 1));
      embedList.push({ url: rawUrl, label: label });
    });

    log("embeds: " + embedList.length);

    // Extract streams from each embed in parallel
    return Promise.all(embedList.map(function (item) {
      return extractGeneric(item.url).then(function (streams) {
        if (streams.length) {
          return streams.map(function (s) {
            return {
              name: PROVIDER_NAME + " " + item.label + " " + s.quality,
              title: PROVIDER_NAME + " • " + item.label + " " + s.quality,
              url: s.url,
              quality: s.quality,
              size: "Unknown",
              type: /\.m3u8/i.test(s.url) ? "hls" : "mp4",
              headers: s.headers,
              provider: PROVIDER_ID
            };
          });
        }
        // If no direct stream found, return iframe with correct Referer
        var origin = item.url.replace(/^(https?:\/\/[^\/]+).*/, "$1");
        return [{
          name: PROVIDER_NAME + " " + item.label,
          title: PROVIDER_NAME + " • " + item.label,
          url: item.url,
          quality: "Auto",
          size: "Unknown",
          type: "iframe",
          headers: { "User-Agent": UA, "Referer": playUrl },
          referer: playUrl,
          provider: PROVIDER_ID
        }];
      }).catch(function () {
        var origin = item.url.replace(/^(https?:\/\/[^\/]+).*/, "$1");
        return [{
          name: PROVIDER_NAME + " " + item.label,
          title: PROVIDER_NAME + " • " + item.label,
          url: item.url,
          quality: "Auto",
          size: "Unknown",
          type: "iframe",
          headers: { "User-Agent": UA, "Referer": playUrl },
          referer: playUrl,
          provider: PROVIDER_ID
        }];
      });
    })).then(function (groups) {
      var streams = [];
      var seen = {};
      groups.forEach(function (g) {
        g.forEach(function (s) {
          if (seen[s.url]) return;
          seen[s.url] = 1;
          streams.push(s);
        });
      });
      // Sort: extracted streams first (by quality), iframes last
      streams.sort(function (a, b) {
        if (a.type === "iframe" && b.type !== "iframe") return 1;
        if (b.type === "iframe" && a.type !== "iframe") return -1;
        return qualityRank(b.quality) - qualityRank(a.quality);
      });
      log("total streams: " + streams.length);
      return streams;
    });
  }).catch(function(err) {
    log("play page failed: " + err.message);
    return [];
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Movies / TV / Entry (unchanged)
// ─────────────────────────────────────────────────────────────────────────

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchQFilm(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      log("Unique movie candidates: " + all.length);
      if (!all.length) return [];
      var best = chooseResult(all, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function(err) {
    log("Movie error: " + err.message);
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
      return searchQFilm(q).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      log("Unique TV candidates: " + all.length);

      var withEp = all.filter(function(r) {
        return new RegExp("(?:الحلق[ةه]\\s*" + wanted + "\\b|\\b" + wanted + "\\b)", "i").test(r.title);
      });
      var pool = withEp.length ? withEp : all;
      log("TV candidates with ep " + wanted + ": " + withEp.length + " / pool: " + pool.length);

      if (!pool.length) return [];
      var best = chooseResult(pool, meta.titles);
      if (!best) return [];
      return resolveVid(best.vid);
    });
  }).catch(function(err) {
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
