var BASE = "https://ramoflix.net";
var PROVIDER_ID = "ramoflix";
var PROVIDER_NAME = "🎬 RamoFlix";

var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var SITE_TIMEOUT = 15000;
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";

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

function fetchText(url, referer) {
  url = asciiSafe(url);
  var headers = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  if (referer) headers["Referer"] = asciiSafe(referer);
  return fetch(url, { headers: headers, redirect: "follow" }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function hostOf(url) { var m = /^https?:\/\/([^\/?#:]+)/i.exec(url); return m ? m[1].toLowerCase().replace(/^www\./, "") : ""; }
function originOf(url) { var m = /^(https?:\/\/[^\/?#]+)/i.exec(url); return m ? m[1] : ""; }

// ── fmovie theme fixed keys → human labels ──
var SERVER_LABELS = {
  embedru:    "Vidsrc",
  vidlink:    "Videasy",
  superembed: "VidFast",
  vidsrc:     "Cinesrc",
  vidsrc2:    "VidZee",
  movieclub:  "111Movies"
};

function labelForKey(key, url) {
  if (Object.prototype.hasOwnProperty.call(SERVER_LABELS, key)) return SERVER_LABELS[key];
  var h = hostOf(url);
  if (/gardenbeast|vidsrc/.test(h)) return "Vidsrc";
  if (/vidy\.st|videasy/.test(h))  return "Videasy";
  if (/vidfast/.test(h))           return "VidFast";
  if (/cinesrc/.test(h))           return "Cinesrc";
  if (/vidzee/.test(h))            return "VidZee";
  if (/vidlove|111movies/.test(h)) return "111Movies";
  if (/vidcore/.test(h))           return "VidCore";
  return key;
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

function extractEpisodes(html) {
  var m = html.match(/var Episodes = (\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\\//g, "/")); }
  catch (e) { return null; }
}

// ── Iframe stream (playback handled by Nuvio's external player) ──
function buildStreams(embedList, title) {
  return embedList.map(function (item) {
    var origin = originOf(item.url);
    return {
      name: PROVIDER_NAME + " " + item.label,
      title: title + " - " + item.label,
      url: item.url,
      quality: "Auto",
      size: "Unknown",
      type: "iframe",
      headers: { "User-Agent": UA, "Referer": origin + "/" },
      behaviorHints: { notWebReady: true },
      provider: PROVIDER_ID
    };
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
      var embedList = [];
      Object.keys(servers).forEach(function (key) {
        var url = servers[key];
        if (!url || !/^https?:\/\//i.test(url)) return;
        var label = labelForKey(key, url);
        if (!label) return;
        embedList.push({ url: url, label: label });
      });
      log("Movie servers: " + embedList.map(function (e) { return e.label; }).join(", "));
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
      // TV server keys are the same names as movie keys
      var embedList = [];
      Object.keys(SERVER_LABELS).forEach(function (key) {
        embedList.push({
          url: BASE + "/?player_tv=" + postId + "&s=" + season + "&e=" + episode +
            "&sv=" + key + "&tv=true",
          label: SERVER_LABELS[key]
        });
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
