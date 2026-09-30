var BASE = "https://ramoflix.net";
var PROVIDER_ID = "ramoflix";
var PROVIDER_NAME = "🎬 RamoFlix";

var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var SITE_TIMEOUT = 15000;
var EMBED_TIMEOUT = 12000;
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var UA_EMBED = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function log(m) { console.log("[RamoFlix] " + m); }

function decodeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

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

function asciiSafe(v) { return String(v).replace(/[^\x00-\x7F]/g, function (c) { return encodeURIComponent(c); }); }

function fetchText(url, referer, timeoutMs) {
  url = asciiSafe(url);
  var headers = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  if (referer) headers["Referer"] = asciiSafe(referer);
  var p = fetch(url, { headers: headers, redirect: "follow" }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
  if (typeof setTimeout !== "function") return p;
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error("timeout")); }, timeoutMs || SITE_TIMEOUT);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function hostOf(url) { var m = /^https?:\/\/([^\/?#:]+)/i.exec(url); return m ? m[1].toLowerCase().replace(/^www\./, "") : ""; }
function originOf(url) { var m = /^(https?:\/\/[^\/?#]+)/i.exec(url); return m ? m[1] : ""; }
function absoluteUrl(url, baseUrl) {
  var u = decodeHtml(url).trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.charAt(0) === "/") return originOf(baseUrl) + u;
  return "";
}

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "2160p";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  if (/240/.test(s)) return "240p";
  return "Auto";
}

function qualityRank(q) {
  if (q === "Auto") return 1080;
  var n = parseInt(q, 10);
  return isNaN(n) ? 0 : n;
}

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var titles = [];
  var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=en";
  return fetch(apiUrl).then(function (r) { return r.json(); }).then(function (data) {
    var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
    if (title) titles.push(title);
    var orig = type === "movie" ? data.original_title : data.original_name;
    if (orig && orig !== title) titles.push(orig);
    if (!titles.length) throw new Error("No TMDB titles for " + tmdbId);
    log("TMDB titles: " + titles.join(" | "));
    return { titles: titles };
  });
}

function searchSite(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/?s=" + encodeURIComponent(cleanTitle);
  log("Search: " + cleanTitle);
  return fetchText(url, BASE + "/").then(function (html) {
    var results = [], seen = {};
    var re = /<div class="poster">\s*<a href="([^"]+)">[\s\S]*?<div class="meta">[\s\S]*?<a href="[^"]+">([^<]*)<\/a>/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var link = decodeHtml(m[1]);
      var name = decodeHtml(m[2]).trim();
      if (!link || !name || seen[link]) continue;
      seen[link] = 1;
      results.push({ url: link, title: name });
    }
    log("Search results: " + results.length);
    return results;
  });
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
  if (best) log("Best: " + best.title + " score: " + bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

function extractServers(html) {
  var m = html.match(/var Servers = (\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\\//g, "/")); }
  catch (e) { return null; }
}

function extractServerLabels(html) {
  var labels = {};
  var re = /<li class="server[^"]*"\s+onclick="loadServer\((\w+)\)"[^>]*><span>([^<]+)<\/span>/g;
  var m;
  while ((m = re.exec(html)) !== null) labels[m[1]] = decodeHtml(m[2]).trim();
  return labels;
}

function extractEpisodes(html) {
  var m = html.match(/var Episodes = (\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\\//g, "/")); }
  catch (e) { return null; }
}

function extractTvServerLabels(html) {
  var labels = [];
  var re = /<li class="server[^"]*"[^>]*data-load-embed-host="([^"]+)"[^>]*><span>([^<]+)<\/span>/g;
  var m;
  while ((m = re.exec(html)) !== null) labels.push({ host: m[1], label: decodeHtml(m[2]).trim() });
  return labels;
}

// ── Dean Edwards packer unpacker ──
function unpackAll(text) {
  var out = [];
  if (text.indexOf("p,a,c,k,e") === -1) return out;
  var digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  var re = /\}\(\s*'((?:[^'\\]|\\[\s\S])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\[\s\S])*)'\s*\.split\(\s*'\|'\s*\)/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var radix = parseInt(m[2], 10);
    var words = m[4].split("|");
    var payload = m[1].replace(/\\\\/g, "\\").replace(/\\'/g, "'");
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
  return out;
}

var BAD_ASSET = /\.(?:jpe?g|png|gif|webp|vtt|srt|css|js|json|html?)(?:[?#]|$)/i;

function scanMediaUrls(text, baseUrl) {
  var patterns = [
    /sources\s*:\s*\[\s*\{\s*["']?file["']?\s*:\s*["']([^"']+)["']/gi,
    /sources\s*:\s*\[\s*["']([^"']+)["']/gi,
    /["']?file["']?\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
    /["']hls\d*["']\s*:\s*["']([^"']+)["']/gi,
    /["'](https?:\\?\/\\?\/[^"'\s]+?\.(?:m3u8|mp4)[^"'\s]*)["']/gi,
    /source\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi
  ];
  var found = [], seen = {};
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) {
      var u = String(m[1]).replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&").trim();
      if (!/^https?:/i.test(u)) continue;
      if (seen[u] || BAD_ASSET.test(u)) continue;
      seen[u] = 1;
      found.push(u);
    }
  });
  return found;
}

// ── Recursively fetch embed + nested iframes, collect direct media URLs ──
function resolveEmbedDirect(embedUrl, label, depth) {
  depth = depth || 0;
  if (depth > 2) return Promise.resolve([]);
  var origin = originOf(embedUrl);
  log("  fetching: " + label + " (" + embedUrl + ")");

  return fetchText(embedUrl, origin + "/", EMBED_TIMEOUT).then(function (html) {
    // Scan raw + unpacked
    var texts = [html].concat(unpackAll(html));
    var urls = [];
    texts.forEach(function (t) {
      scanMediaUrls(t, embedUrl).forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
    });

    if (urls.length) {
      log("  ✓ direct URLs found: " + urls.length);
      return urls;
    }

    // No direct URLs → look for nested iframes
    var iframeRe = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
    var nested = [], m;
    while ((m = iframeRe.exec(html)) !== null) {
      var u = absoluteUrl(m[1], embedUrl);
      if (u && nested.indexOf(u) === -1) nested.push(u);
    }
    if (!nested.length) {
      log("  ✗ nothing found in " + label);
      return [];
    }

    log("  → following " + nested.length + " nested iframe(s)");
    return Promise.all(nested.slice(0, 2).map(function (u) {
      return resolveEmbedDirect(u, label, depth + 1);
    })).then(function (groups) {
      var flat = [];
      groups.forEach(function (g) { g.forEach(function (u) { if (flat.indexOf(u) === -1) flat.push(u); }); });
      return flat;
    });
  }).catch(function (e) {
    log("  ✗ " + label + ": " + e.message);
    return [];
  });
}

function buildStreamsForEmbed(item, title) {
  var origin = originOf(item.url);
  var headers = { "User-Agent": UA_EMBED, "Referer": origin + "/" };

  return resolveEmbedDirect(item.url, item.label).then(function (directUrls) {
    if (!directUrls.length) {
      // Fallback: iframe
      return [{
        name: PROVIDER_NAME + " " + item.label + " (iframe)",
        title: title + " - " + item.label,
        url: item.url,
        quality: "Auto",
        size: "Unknown",
        type: "iframe",
        headers: headers,
        provider: PROVIDER_ID,
        behaviorHints: { notWebReady: true }
      }];
    }
    // Return one stream per direct URL, each with real quality
    return directUrls.map(function (u) {
      var isHls = /\.m3u8/i.test(u);
      var q = isHls ? "Auto" : qualityFromUrl(u);
      return {
        name: PROVIDER_NAME + " " + item.label + " " + q,
        title: title + " - " + item.label + " " + q,
        url: u,
        quality: q,
        size: "Unknown",
        type: isHls ? "hls" : "mp4",
        headers: headers,
        provider: PROVIDER_ID
      };
    });
  });
}

function buildStreams(embedList, title) {
  return Promise.all(embedList.map(function (item) {
    return buildStreamsForEmbed(item, title);
  })).then(function (groups) {
    var streams = [], seen = {};
    groups.forEach(function (g) {
      g.forEach(function (s) {
        if (seen[s.url]) return;
        seen[s.url] = 1;
        streams.push(s);
      });
    });
    streams.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return streams;
  });
}

function getMovieStreams(meta, title) {
  var queries = meta.titles.slice(0, 3);
  var allResults = [], seen = {};
  var qi = 0;
  function nextQuery() {
    if (qi >= queries.length) return Promise.resolve();
    return searchSite(queries[qi++]).then(function (results) {
      results.forEach(function (r) { if (!seen[r.url]) { seen[r.url] = 1; allResults.push(r); } });
      return nextQuery();
    });
  }
  return nextQuery().then(function () {
    log("Movie candidates: " + allResults.length);
    if (!allResults.length) return [];
    var match = chooseResult(allResults, meta.titles);
    if (!match) return [];
    return fetchText(match.url, BASE + "/").then(function (html) {
      var servers = extractServers(html);
      if (!servers) { log("No Servers object"); return []; }
      var labels = extractServerLabels(html);
      var embedList = [];
      Object.keys(labels).forEach(function (key) {
        var url = servers[key];
        if (url && /^https?:\/\//.test(url)) embedList.push({ url: url, label: labels[key] });
      });
      log("Movie servers: " + embedList.length);
      return buildStreams(embedList, title);
    });
  });
}

function getTvStreams(meta, season, episode, title) {
  var queries = meta.titles.slice(0, 3);
  var allResults = [], seen = {};
  var qi = 0;
  function nextQuery() {
    if (qi >= queries.length) return Promise.resolve();
    return searchSite(queries[qi++]).then(function (results) {
      results.forEach(function (r) { if (!seen[r.url]) { seen[r.url] = 1; allResults.push(r); } });
      return nextQuery();
    });
  }
  return nextQuery().then(function () {
    log("TV candidates: " + allResults.length);
    if (!allResults.length) return [];
    var match = chooseResult(allResults, meta.titles);
    if (!match) return [];
    return fetchText(match.url, BASE + "/").then(function (html) {
      var eps = extractEpisodes(html);
      if (!eps || !eps.post_id) { log("No Episodes object"); return []; }
      var postId = eps.post_id;
      var serverLabels = extractTvServerLabels(html);
      if (!serverLabels.length) { log("No TV servers"); return []; }
      var embedList = serverLabels.map(function (s) {
        return {
          url: BASE + "/?player_tv=" + postId + "&s=" + season + "&e=" + episode +
            "&sv=" + encodeURIComponent(s.host) + "&tv=true",
          label: s.label
        };
      });
      log("TV servers: " + embedList.length);
      return buildStreams(embedList, title);
    });
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  log("getStreams: " + tmdbId + " " + mediaType + " " + season + " " + episode);
  var type = mediaType === "tv" ? "tv" : "movie";
  return getTmdbTitles(tmdbId, type).then(function (meta) {
    var display = type === "tv"
      ? meta.titles[0] + " S" + (season < 10 ? "0" + season : season) + "E" + (episode < 10 ? "0" + episode : episode)
      : meta.titles[0];
    if (type === "tv") return getTvStreams(meta, season || 1, episode || 1, display);
    return getMovieStreams(meta, display);
  }).catch(function (err) {
    log("Error: " + err.message);
    return [];
  });
}

module.exports = { getStreams: getStreams };
