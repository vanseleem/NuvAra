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

function normalizeText(input) {
  return decodeHtml(input).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\u0621-\u064Aa-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function bigramMap(str) {
  var s = str.replace(/ /g, ""); var map = {}; var size = 0;
  for (var i = 0; i < s.length - 1; i++) {
    var g = s.substr(i, 2); map[g] = (map[g] || 0) + 1; size++;
  }
  return { map: map, size: size };
}

function diceScore(a, b) {
  if (a === b) return 1;
  var x = bigramMap(a), y = bigramMap(b);
  if (!x.size || !y.size) return 0;
  var common = 0;
  Object.keys(x.map).forEach(function (g) { if (y.map[g]) common += Math.min(x.map[g], y.map[g]); });
  return (2 * common) / (x.size + y.size);
}

function asciiSafe(v) { return String(v).replace(/[^\x00-\x7F]/g, function (c) { return encodeURIComponent(c); }); }

function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== "function") return promise;
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error("timeout: " + label)); }, ms);
    promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
  });
}

function fetchText(url, headers, timeoutMs) {
  url = asciiSafe(url);
  if (headers && headers["Referer"]) headers["Referer"] = asciiSafe(headers["Referer"]);
  return withTimeout(fetch(url, { method: "GET", headers: headers, redirect: "follow" }), timeoutMs || SITE_TIMEOUT, url.split("?")[0])
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
}

function siteGet(url) {
  return fetchText(url, {
    "User-Agent": UA,
    "Referer": BASE + "/",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en;q=0.9"
  });
}

function fetchTmdb(tmdbId, type) {
  var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
    "?api_key=" + TMDB_API_KEY + "&language=en";
  return fetchText(url, { "Accept": "application/json" }).then(JSON.parse);
}

function parseSearchResults(html) {
  var results = [];
  var re = /<div class="poster">\s*<a href="([^"]+)">[\s\S]*?<div class="meta">[\s\S]*?<a href="[^"]+">([^<]*)<\/a>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = decodeHtml(m[1]);
    var title = decodeHtml(m[2]).trim();
    if (url && title) results.push({ url: url, title: title });
  }
  return results;
}

function searchSite(query) {
  var url = BASE + "/?s=" + encodeURIComponent(query);
  return siteGet(url).then(function (html) {
    return parseSearchResults(html);
  }).catch(function (e) {
    log("search failed (" + query + "): " + e.message);
    return [];
  });
}

function findBestMatch(results, meta) {
  var best = null, bestScore = 0;
  results.forEach(function (r) {
    var s = 0;
    meta.targets.forEach(function (t) {
      var sc = diceScore(normalizeText(r.title), t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  log("best match: " + (best ? best.title : "none") + " score=" + bestScore.toFixed(2));
  return bestScore >= 0.5 ? best : null;
}

function extractServers(html) {
  var m = html.match(/var Servers = (\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/\\\//g, "/"));
  } catch (e) {
    log("Servers parse error: " + e.message);
    return null;
  }
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
  try {
    return JSON.parse(m[1].replace(/\\\//g, "/"));
  } catch (e) {
    return null;
  }
}

function extractTvServerLabels(html) {
  var labels = [];
  var re = /<li class="server[^"]*"[^>]*data-load-embed-host="([^"]+)"[^>]*><span>([^<]+)<\/span>/g;
  var m;
  while ((m = re.exec(html)) !== null) labels.push({ host: m[1], label: decodeHtml(m[2]).trim() });
  return labels;
}

function buildStreams(embedUrls, title, serverLabels) {
  var streams = [];
  embedUrls.forEach(function (item) {
    streams.push({
      name: PROVIDER_NAME + " " + item.label + " (Auto)",
      title: title + " - " + item.label,
      url: item.url,
      quality: "Auto",
      size: "Unknown",
      type: "iframe",
      headers: { "User-Agent": UA, "Referer": BASE + "/" },
      provider: PROVIDER_ID
    });
  });
  return streams;
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
    log("movie candidates: " + allResults.length);
    if (!allResults.length) return [];
    var match = findBestMatch(allResults, meta);
    if (!match) return [];
    return siteGet(match.url).then(function (html) {
      var servers = extractServers(html);
      if (!servers) { log("no Servers object"); return []; }
      var labels = extractServerLabels(html);
      var embedUrls = [];
      Object.keys(labels).forEach(function (key) {
        var url = servers[key];
        if (url && /^https?:\/\//.test(url)) embedUrls.push({ url: url, label: labels[key] });
      });
      log("movie servers found: " + embedUrls.length);
      return buildStreams(embedUrls, title, labels);
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
    log("tv candidates: " + allResults.length);
    if (!allResults.length) return [];
    var match = findBestMatch(allResults, meta);
    if (!match) return [];
    return siteGet(match.url).then(function (html) {
      var eps = extractEpisodes(html);
      if (!eps || !eps.post_id) { log("no Episodes object"); return []; }
      var postId = eps.post_id;
      var serverLabels = extractTvServerLabels(html);
      if (!serverLabels.length) { log("no TV servers"); return []; }
      var embedUrls = [];
      serverLabels.forEach(function (s) {
        var url = BASE + "/?player_tv=" + postId + "&s=" + season + "&e=" + episode +
          "&sv=" + encodeURIComponent(s.host) + "&tv=true";
        embedUrls.push({ url: url, label: s.label });
      });
      log("tv servers found: " + embedUrls.length);
      return buildStreams(embedUrls, title, serverLabels);
    });
  });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;

  if (!TMDB_API_KEY || TMDB_API_KEY === "YOUR_TMDB_API_KEY") {
    log("TMDB_API_KEY not set");
    return Promise.resolve([]);
  }

  return fetchTmdb(tmdbId, type).then(function (data) {
    var isTv = type === "tv";
    var title = isTv ? (data.name || data.original_name) : (data.title || data.original_title);
    var origTitle = isTv ? data.original_name : data.original_title;
    var dateStr = isTv ? data.first_air_date : data.release_date;
    var year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;

    var titles = [title];
    if (origTitle && origTitle !== title) titles.push(origTitle);
    if (year) titles.push(title + " " + year);

    var targets = titles.map(function (t) { return normalizeText(t); });

    var meta = {
      title: title,
      year: isNaN(year) ? null : year,
      titles: titles,
      targets: targets
    };

    var displayTitle = isTv
      ? title + " S" + (season < 10 ? "0" + season : season) + "E" + (episode < 10 ? "0" + episode : episode)
      : title + (meta.year ? " (" + meta.year + ")" : "");

    log(type + ' "' + title + '" year=' + meta.year + " queries=" + JSON.stringify(titles));

    return isTv
      ? getTvStreams(meta, season, episode, displayTitle)
      : getMovieStreams(meta, displayTitle);
  }).catch(function (err) {
    log("error: " + (err && err.message));
    return [];
  });
}

module.exports = { getStreams: getStreams };
