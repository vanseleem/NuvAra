var BASE = "https://ramoflix.net";
var PROVIDER_ID = "ramoflix";
var PROVIDER_NAME = "🎬 RamoFlix";

var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var SITE_TIMEOUT = 15000;
var EMBED_TIMEOUT = 10000;
var M3U8_TIMEOUT = 6000;
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

// ───────────────────────────── URL helpers ─────────────────────────────

function flatten(groups) { return [].concat.apply([], groups); }

function originOf(url) {
  var m = /^(https?:\/\/[^\/?#]+)/i.exec(url);
  return m ? m[1] : "";
}

function absoluteUrl(url, baseUrl) {
  var u = decodeHtml(url).trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.charAt(0) === "/") return originOf(baseUrl) + u;
  return "";
}

function resolveRelative(rel, baseUrl) {
  if (/^https?:\/\//i.test(rel)) return rel;
  if (rel.indexOf("//") === 0) return "https:" + rel;
  if (rel.charAt(0) === "/") return originOf(baseUrl) + rel;
  var clean = baseUrl.split("?")[0].split("#")[0];
  return clean.substring(0, clean.lastIndexOf("/") + 1) + rel;
}

function cleanMediaUrl(url) {
  return String(url)
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
}

function qualityFromUrl(url) {
  var m = /(\d{3,4})p\b/i.exec(url);
  return m ? m[1] + "p" : null;
}

// ───────────────────────────── Site search ─────────────────────────────

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

// ─────────────────────── Embed -> real stream resolver ─────────────────────

// Dean Edwards p.a.c.k.e.r unpacker (some embed hosts hide their m3u8 in it).
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
    /["'](https?:\\?\/\\?\/[^"'\s]+?\.(?:m3u8|mp4)[^"'\s]*)["']/gi
  ];
  var found = [];
  var seen = {};
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) {
      var url = absoluteUrl(cleanMediaUrl(m[1]), baseUrl);
      if (!url || seen[url] || BAD_ASSET.test(url)) continue;
      seen[url] = true;
      found.push(url);
    }
  });
  return found;
}

function findIframes(html, baseUrl) {
  var out = [];
  var re = /<iframe\b[^>]*?\s(?:data-)?src\s*=\s*["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = absoluteUrl(m[1], baseUrl);
    if (u && out.indexOf(u) === -1) out.push(u);
  }
  return out;
}

function embedGet(url, referer) {
  return fetchText(url, {
    "User-Agent": UA,
    "Referer": referer || BASE + "/",
    "Accept": "text/html,application/xhtml+xml,*/*",
    "Accept-Language": "en;q=0.9"
  }, EMBED_TIMEOUT);
}

// Reads an HLS master playlist and returns one entry per resolution.
function expandHls(url, headers) {
  return fetchText(url, headers, M3U8_TIMEOUT).then(function (text) {
    if (text.indexOf("#EXT-X-STREAM-INF") === -1) return [{ url: url, quality: "Auto" }];
    var variants = [];
    var seenQ = {};
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
      var res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
      var height = res ? parseInt(res[2], 10) : 0;
      var next = "";
      for (var j = i + 1; j < lines.length; j++) {
        var t = lines[j].trim();
        if (t && t.charAt(0) !== "#") { next = t; i = j; break; }
      }
      if (!next || !height) continue;
      var quality = height + "p";
      if (seenQ[quality]) continue;
      seenQ[quality] = true;
      variants.push({ url: resolveRelative(next, url), quality: quality, height: height });
    }
    variants.sort(function (a, b) { return b.height - a.height; });
    return variants.length ? variants : [{ url: url, quality: "Auto" }];
  }).catch(function () {
    return [{ url: url, quality: "Auto" }];
  });
}

// item = { url, label }. depth 1 allows following one iframe (used for TV pages).
function resolveEmbed(item, depth, referer) {
  return embedGet(item.url, referer).then(function (html) {
    var texts = [html].concat(unpackAll(html));
    var urls = [];
    texts.forEach(function (t) {
      scanMediaUrls(t, item.url).forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
    });

    if (!urls.length) {
      var frames = depth < 1 ? findIframes(html, item.url) : [];
      log(item.label + ": no media in page, iframes=" + frames.length);
      return Promise.all(frames.slice(0, 2).map(function (f) {
        return resolveEmbed({ url: f, label: item.label }, depth + 1, item.url);
      })).then(flatten);
    }

    var origin = originOf(item.url);
    var headers = { "User-Agent": UA, "Referer": origin + "/", "Origin": origin };
    log(item.label + ": " + urls.length + " media url(s)");

    return Promise.all(urls.slice(0, 3).map(function (u) {
      if (/\.m3u8/i.test(u)) {
        return expandHls(u, headers).then(function (variants) {
          var list = [{ url: u, quality: "Auto" }].concat(variants.filter(function (v) { return v.url !== u; }));
          return list.map(function (v) {
            return { url: v.url, quality: v.quality, label: item.label, headers: headers };
          });
        });
      }
      return Promise.resolve([{ url: u, quality: qualityFromUrl(u) || "Auto", label: item.label, headers: headers }]);
    })).then(flatten);
  }).catch(function (err) {
    log(item.label + " failed: " + (err && err.message));
    return [];
  });
}

function buildStreams(embedItems, title) {
  return Promise.all(embedItems.map(function (item) {
    return resolveEmbed(item, 0, BASE + "/");
  })).then(function (groups) {
    var streams = [];
    var seen = {};
    groups.forEach(function (items) {
      items.forEach(function (it) {
        if (seen[it.url]) return;
        seen[it.url] = true;
        streams.push({
          name: PROVIDER_NAME + " " + it.label + " " + it.quality,
          title: title + " - " + it.label,
          url: it.url,
          quality: it.quality,
          headers: it.headers,
          provider: PROVIDER_ID
        });
      });
    });
    log("playable streams: " + streams.length + " from " + embedItems.length + " servers");
    return streams;
  });
}

// ───────────────────────────── Movies / TV ─────────────────────────────

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
      return buildStreams(embedUrls, title);
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
      return buildStreams(embedUrls, title);
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
