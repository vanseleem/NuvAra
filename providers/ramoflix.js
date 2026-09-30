// ═══════════════════════════════════════════════════════════════════════
// RamoFlix / Doraby — fmovie-theme provider with multi-server extraction
// ═══════════════════════════════════════════════════════════════════════
var BASE = "https://ramoflix.net";            // Doraby: "https://doraby.com"
var PROVIDER_ID = "ramoflix";                 // Doraby: "doraby"
var PROVIDER_NAME = "🎬 RamoFlix";            // Doraby: "🎬 Doraby"

var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var SITE_TIMEOUT = 15000;
var EMBED_TIMEOUT = 12000;

var UA_SITE = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var UA_EMBED = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─────────────────────────────── Logging ──────────────────────────────

function log(m) { console.log("[" + PROVIDER_NAME.replace(/[^A-Za-z]/g, "") + "] " + m); }

// ───────────────────────────── Text helpers ───────────────────────────

function decodeEntities(str) {
  return String(str == null ? "" : str)
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function normalizeText(input) {
  return decodeEntities(input).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\u0621-\u064Aa-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function bigramMap(str) {
  var s = str.replace(/ /g, ""), map = {}, size = 0;
  for (var i = 0; i < s.length - 1; i++) {
    var g = s.substr(i, 2);
    map[g] = (map[g] || 0) + 1;
    size++;
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

function pad2(n) { return n < 10 ? "0" + n : String(n); }

// ──────────────────────────────── HTTP ────────────────────────────────

function asciiSafe(v) {
  return String(v).replace(/[^\x00-\x7F]/g, function (c) { return encodeURIComponent(c); });
}

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
    "User-Agent": UA_SITE,
    "Referer": BASE + "/",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en;q=0.9"
  });
}

function hostOf(url) {
  var m = /^https?:\/\/([^\/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}

function originOf(url) {
  var m = /^(https?:\/\/[^\/?#]+)/i.exec(url);
  return m ? m[1] : "";
}

// ──────────────────────────── TMDB ────────────────────────────────────

function fetchTmdb(tmdbId, type) {
  var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
    "?api_key=" + TMDB_API_KEY + "&language=en&append_to_response=translations,alternative_titles";
  return fetchText(url, { "Accept": "application/json" }).then(function (b) { return JSON.parse(b); });
}

function buildMeta(data, type) {
  var isTv = type === "tv";
  var raw = [isTv ? data.name : data.title, isTv ? data.original_name : data.original_title];
  var trs = (data.translations && data.translations.translations) || [];
  trs.forEach(function (t) {
    if (t.iso_639_1 === "en" && t.data) raw.push(isTv ? t.data.name : t.data.title);
  });
  if (!isTv) {
    var alts = (data.alternative_titles && data.alternative_titles.titles) || [];
    alts.forEach(function (a) { if (a.title) raw.push(a.title); });
  }
  var dateStr = isTv ? data.first_air_date : data.release_date;
  var year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;
  var seenNorm = {}, titles = [];
  raw.forEach(function (t) {
    if (!t) return;
    var n = normalizeText(t);
    if (!n || seenNorm[n]) return;
    seenNorm[n] = true;
    titles.push(t);
  });
  return {
    titles: titles,
    targets: titles.map(normalizeText),
    year: isNaN(year) ? null : year
  };
}

// ──────────────────────────── Search ─────────────────────────────────

function parseSearchResults(html) {
  var results = [], seen = {};
  var re = /<div class="poster">[\s\S]*?<a\s+href="([^"]+)"[^>]*>[\s\S]*?<h2[^>]*>([^<]+)<\/h2>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = decodeEntities(m[1]);
    var title = decodeEntities(m[2]).trim();
    if (!url || !title || seen[url]) continue;
    seen[url] = 1;
    results.push({ url: url, title: title });
  }
  // Fallback: broader regex in case theme markup differs
  if (!results.length) {
    var re2 = /href="(https?:\/\/[^"]*\/(movie|tv)\/[^"\/]+\/)"[^>]*title="([^"]+)"/gi;
    while ((m = re2.exec(html)) !== null) {
      var u = decodeEntities(m[1]), t = decodeEntities(m[3]).trim();
      if (!seen[u]) { seen[u] = 1; results.push({ url: u, title: t }); }
    }
  }
  return results;
}

function searchSite(query) {
  var url = BASE + "/?s=" + encodeURIComponent(query);
  return siteGet(url).then(parseSearchResults).catch(function (e) {
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

// ──────────────────────── Server extraction ──────────────────────────

function extractServers(html) {
  var m = html.match(/var\s+Servers\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\\//g, "/")); }
  catch (e) { log("Servers parse error: " + e.message); return null; }
}

function extractServerLabels(html) {
  var labels = {};
  // Pattern A: onclick="loadServer(key)" with a label span
  var re = /<li[^>]*class="[^"]*server[^"]*"[^>]*onclick="loadServer\(['"]?(\w+)['"]?\)"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/gi;
  var m;
  while ((m = re.exec(html)) !== null) labels[m[1]] = decodeEntities(m[2]).trim();
  // Pattern B: data-server="key" with label text
  if (!Object.keys(labels).length) {
    var re2 = /data-server=["'](\w+)["'][^>]*>([^<]+)</gi;
    while ((m = re2.exec(html)) !== null) labels[m[1]] = decodeEntities(m[2]).trim();
  }
  return labels;
}

function extractEpisodes(html) {
  var m = html.match(/var\s+Episodes\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\\//g, "/")); }
  catch (e) { return null; }
}

function extractTvServerLabels(html) {
  var labels = [], seen = {};
  var re = /data-load-embed-host=["']([^"']+)["'][^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var host = decodeEntities(m[1]).trim(), label = decodeEntities(m[2]).trim();
    if (!seen[host]) { seen[host] = 1; labels.push({ host: host, label: label }); }
  }
  // Fallback: any list item with data-load-embed-host
  if (!labels.length) {
    var re2 = /data-load-embed-host=["']([^"']+)["']/gi;
    while ((m = re2.exec(html)) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = 1; labels.push({ host: m[1], label: m[1] }); }
    }
  }
  return labels;
}

// ──────────────── Embed resolution (direct-URL extraction) ────────────

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

function serverLabelFromHost(host) {
  if (/vidfast/.test(host)) return "VidFast";
  if (/vidcore/.test(host)) return "VidCore";
  if (/vidzee/.test(host)) return "VidZee";
  if (/vidy\.st|videasy/.test(host)) return "Videasy";
  if (/vidlove|111movies/.test(host)) return "111Movies";
  if (/gardenbeast|vidsrc/.test(host)) return "Vidsrc";
  if (/cinesrc/.test(host)) return "Cinesrc";
  return host.split(".").slice(-2, -1)[0] || host;
}

function scanMediaUrls(text, baseUrl) {
  var patterns = [
    /sources\s*:\s*\[\s*\{\s*["']?file["']?\s*:\s*["']([^"']+)["']/gi,
    /["']?file["']?\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
    /["']hls\d*["']\s*:\s*["']([^"']+)["']/gi,
    /["'](https?:\\?\/\\?\/[^"'\s]+?\.(?:m3u8|mp4)[^"'\s]*)["']/gi,
    /source\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi
  ];
  var found = [], seen = {};
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) {
      var u = String(m[1]).replace(/\\\//g, "/").replace(/&amp;/g, "&").trim();
      if (!/^https?:/i.test(u)) continue;
      if (seen[u]) continue;
      if (/\.(?:jpe?g|png|gif|webp|vtt|srt|css|js|json)(?:[?#]|$)/i.test(u)) continue;
      seen[u] = 1;
      found.push(u);
    }
  });
  return found;
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
      var radix = parseInt(m[2], 10), words = m[4].split("|");
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

function resolveEmbedToDirectStreams(embedUrl, label) {
  var host = hostOf(embedUrl);
  var origin = originOf(embedUrl);
  var headers = {
    "User-Agent": UA_EMBED,
    "Referer": origin + "/",
    "Origin": origin,
    "Accept": "text/html,application/xhtml+xml,application/json",
    "Accept-Language": "en;q=0.9"
  };
  log("resolving embed: " + label + " → " + embedUrl);
  return fetchText(embedUrl, headers, EMBED_TIMEOUT).then(function (html) {
    var texts = [html].concat(unpackAll(html));
    var urls = [];
    texts.forEach(function (t) {
      scanMediaUrls(t, embedUrl).forEach(function (u) {
        if (urls.indexOf(u) === -1) urls.push(u);
      });
    });
    if (!urls.length) {
      log("  no direct URL found for " + label + " — will return iframe fallback");
      return [];
    }
    var streams = [];
    urls.forEach(function (u) {
      var q = /\.m3u8/i.test(u) ? "Auto" : (qualityFromUrl(u) || "Unknown");
      streams.push({
        name: PROVIDER_NAME + " " + label + " " + (q !== "Unknown" ? q : "Auto"),
        title: label,
        url: u,
        quality: q,
        size: "Unknown",
        headers: headers,
        provider: PROVIDER_ID
      });
    });
    log("  found " + streams.length + " direct streams for " + label);
    return streams;
  }).catch(function (e) {
    log("  resolve failed for " + label + ": " + e.message);
    return [];
  });
}

function makeIframeFallback(embedUrl, label, title) {
  var origin = originOf(embedUrl);
  return {
    name: PROVIDER_NAME + " " + label + " (iframe)",
    title: title + " – " + label,
    url: embedUrl,
    quality: "Auto",
    size: "Unknown",
    type: "iframe",
    headers: {
      "User-Agent": UA_EMBED,
      "Referer": origin + "/",
      "Origin": origin
    },
    provider: PROVIDER_ID
  };
}

function buildStreamsFromEmbeds(embedList, displayTitle) {
  // For each embed, try direct extraction; if it fails, keep an iframe fallback.
  return Promise.all(embedList.map(function (item) {
    return resolveEmbedToDirectStreams(item.url, item.label).then(function (streams) {
      if (streams.length) return streams;
      return [makeIframeFallback(item.url, item.label, displayTitle)];
    });
  })).then(function (groups) {
    var out = [], seen = {};
    groups.forEach(function (g) {
      g.forEach(function (s) {
        if (seen[s.url]) return;
        seen[s.url] = 1;
        out.push(s);
      });
    });
    return out;
  });
}

// ──────────────────────────── Movies ─────────────────────────────────

function getMovieStreams(meta, displayTitle) {
  var queries = meta.titles.slice(0, 3);
  var all = [], seen = {}, qi = 0;
  function nextQuery() {
    if (qi >= queries.length) return Promise.resolve();
    return searchSite(queries[qi++]).then(function (rs) {
      rs.forEach(function (r) { if (!seen[r.url]) { seen[r.url] = 1; all.push(r); } });
      return nextQuery();
    });
  }
  return nextQuery().then(function () {
    log("movie candidates: " + all.length);
    if (!all.length) return [];
    var match = findBestMatch(all, meta);
    if (!match) return [];
    return siteGet(match.url).then(function (html) {
      var servers = extractServers(html);
      if (!servers) { log("no Servers object found"); return []; }
      var labels = extractServerLabels(html);
      var embedList = [];
      Object.keys(servers).forEach(function (k) {
        var url = servers[k];
        if (!url || !/^https?:\/\//i.test(url)) return;
        var label = labels[k] || serverLabelFromHost(hostOf(url));
        embedList.push({ url: url, label: label });
      });
      log("movie servers: " + embedList.map(function (e) { return e.label; }).join(", "));
      return buildStreamsFromEmbeds(embedList, displayTitle);
    });
  });
}

// ──────────────────────────── Series ─────────────────────────────────

function getTvStreams(meta, season, episode, displayTitle) {
  var queries = meta.titles.slice(0, 3);
  var all = [], seen = {}, qi = 0;
  function nextQuery() {
    if (qi >= queries.length) return Promise.resolve();
    return searchSite(queries[qi++]).then(function (rs) {
      rs.forEach(function (r) { if (!seen[r.url]) { seen[r.url] = 1; all.push(r); } });
      return nextQuery();
    });
  }
  return nextQuery().then(function () {
    log("tv candidates: " + all.length);
    if (!all.length) return [];
    var match = findBestMatch(all, meta);
    if (!match) return [];
    return siteGet(match.url).then(function (html) {
      var eps = extractEpisodes(html);
      if (!eps || !eps.post_id) { log("no Episodes object found"); return []; }
      var postId = eps.post_id;
      var serverLabels = extractTvServerLabels(html);
      if (!serverLabels.length) { log("no TV server labels found"); return []; }
      var embedList = serverLabels.map(function (s) {
        var url = BASE + "/?player_tv=" + postId + "&s=" + season + "&e=" + episode +
          "&sv=" + encodeURIComponent(s.host) + "&tv=true";
        return { url: url, label: s.label };
      });
      log("tv servers: " + embedList.map(function (e) { return e.label; }).join(", "));
      // For TV, the player_tv page is a proxy — don't try direct extraction there;
      // we just return iframe streams with proper Referer set to the embed host if known.
      return embedList.map(function (e) {
        return {
          name: PROVIDER_NAME + " " + e.label + " (iframe)",
          title: displayTitle + " – " + e.label,
          url: e.url,
          quality: "Auto",
          size: "Unknown",
          type: "iframe",
          headers: {
            "User-Agent": UA_EMBED,
            "Referer": BASE + "/"
          },
          provider: PROVIDER_ID
        };
      });
    });
  });
}

// ──────────────────────────── Entry point ────────────────────────────

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;

  if (!TMDB_API_KEY || TMDB_API_KEY === "YOUR_TMDB_API_KEY") {
    log("TMDB_API_KEY not set");
    return Promise.resolve([]);
  }

  return fetchTmdb(tmdbId, type).then(function (data) {
    var meta = buildMeta(data, type);
    if (!meta.titles.length) { log("no usable title for TMDB " + tmdbId); return []; }

    var displayTitle = type === "tv"
      ? meta.titles[0] + " S" + pad2(season) + "E" + pad2(episode)
      : meta.titles[0] + (meta.year ? " (" + meta.year + ")" : "");

    log(type + ' "' + meta.titles[0] + '" year=' + meta.year + " queries=" + JSON.stringify(meta.titles.slice(0, 3)));

    return type === "tv"
      ? getTvStreams(meta, season, episode, displayTitle)
      : getMovieStreams(meta, displayTitle);
  }).catch(function (err) {
    log("error: " + (err && err.message));
    return [];
  });
}

module.exports = { getStreams: getStreams };
