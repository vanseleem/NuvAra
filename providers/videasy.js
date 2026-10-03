var PROVIDER_ID = "videasy";
var PROVIDER_NAME = "Videasy";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

var API_BASE = "https://api.speedracelight.com";
var DEC_API = "https://enc-dec.app/api/dec-videasy";
var PLAYER_ORIGIN = "https://player.videasy.to";
var PLAYER_REFERER = "https://player.videasy.to/";

var FETCH_TIMEOUT_MS = 10000;
var GLOBAL_DEADLINE_MS = 22000; // return whatever is ready by then (host may kill slow scrapers silently)

// true = when zero links come back, return ONE fake link whose title says why (set false once stable)
var DEBUG_STREAM = true;

// true = when a source is an HLS master, also list one link per quality variant
var EXPAND_HLS = true;

// path = speedracelight route, only = keep sources whose "quality" equals this (hdmovie mixes languages)
var SERVERS = [
  { name: "Yoru", path: "cdn" },
  { name: "Breach", path: "m4uhd" },
  { name: "Neon", path: "vsrc" },
  { name: "Vyse", path: "hdmovie", only: "english" }
  // { name: "Killjoy", path: "meine", extra: "&language=german" },
  // { name: "Fade", path: "hdmovie", only: "hindi" },
  // { name: "Omen", path: "lamovie" },
  // { name: "Raze", path: "superflix" }
];

function log(m) { console.log("[Videasy] " + m); }

// ---------------------------------------------------------------- http
function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== "function") return promise;
  return new Promise(function(resolve, reject) {
    var done = false;
    var t = setTimeout(function() {
      if (!done) { done = true; reject(new Error((label || "request") + " timeout")); }
    }, ms);
    promise.then(function(v) {
      if (!done) { done = true; clearTimeout(t); resolve(v); }
    }, function(e) {
      if (!done) { done = true; clearTimeout(t); reject(e); }
    });
  });
}

function fetchText(url, headers, timeoutMs) {
  return withTimeout(
    fetch(url, { method: "GET", headers: headers || {}, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }),
    timeoutMs || FETCH_TIMEOUT_MS,
    url.split("?")[0]
  );
}

function fetchJson(url, headers, timeoutMs) {
  return fetchText(url, headers, timeoutMs).then(function(t) {
    try { return JSON.parse(t); } catch (e) { throw new Error("invalid JSON"); }
  });
}

function postJson(url, body, timeoutMs) {
  return withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }),
    timeoutMs || FETCH_TIMEOUT_MS,
    url.split("?")[0]
  );
}

// ---------------------------------------------------------------- helpers
// Python's urllib quote(s, safe="") also escapes ! ' ( ) * - match it, then apply twice (Videasy wants double-encoded titles)
function pyQuote(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, function(c) {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function parseQuality(q) {
  var s = String(q == null ? "" : q).toLowerCase();
  if (s === "4k" || s === "2160" || s === "2160p") return 2160;
  var n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function qualityLabel(h, bw) {
  if (h >= 2160) return "4K";
  if (h > 0) return h + "p";
  if (bw > 0) return Math.round(bw / 1000) + "kbps";
  return "Auto";
}

function detectType(declared, url) {
  var d = String(declared || "").toLowerCase();
  if (d.indexOf("dash") !== -1 || d.indexOf("mpd") !== -1) return "dash";
  if (d.indexOf("hls") !== -1 || d.indexOf("m3u8") !== -1) return "hls";
  if (d.indexOf("mp4") !== -1) return "mp4";
  if (/\.mpd(\?|#|$)/i.test(url)) return "dash";
  if (/\.mp4(\?|#|$)/i.test(url)) return "mp4";
  return "hls";
}

function absUrl(base, rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  var clean = base.split("#")[0].split("?")[0];
  var m = /^(https?:\/\/[^\/]+)(\/.*)?$/i.exec(clean);
  if (!m) return rel;
  var origin = m[1];
  if (rel.charAt(0) === "/") return origin + rel;
  var parts = (m[2] || "/").split("/");
  parts.pop();
  rel.split("/").forEach(function(seg) {
    if (seg === "..") { if (parts.length > 1) parts.pop(); }
    else if (seg !== ".") parts.push(seg);
  });
  return origin + parts.join("/");
}

// HLS master -> [{height, bandwidth, url}] (skipped when audio is a separate rendition)
function expandHls(masterUrl, text) {
  if (/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/i.test(text)) return [];
  var lines = text.split(/\r?\n/);
  var byKey = {};
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (l.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
    var res = /RESOLUTION=(\d+)x(\d+)/i.exec(l);
    var bw = /BANDWIDTH=(\d+)/i.exec(l);
    var uri = null;
    for (var j = i + 1; j < lines.length; j++) {
      var n = lines[j].trim();
      if (n && n.charAt(0) !== "#") { uri = n; break; }
    }
    if (!uri) continue;
    var h = res ? parseInt(res[2], 10) : 0;
    var b = bw ? parseInt(bw[1], 10) : 0;
    var key = h || ("bw" + b);
    if (!byKey[key] || b > byKey[key].bandwidth) {
      byKey[key] = { height: h, bandwidth: b, url: absUrl(masterUrl, uri) };
    }
  }
  return Object.keys(byKey).map(function(k) { return byKey[k]; });
}

// ---------------------------------------------------------------- TMDB
function fetchMeta(tmdbId, type) {
  var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
    "?api_key=" + TMDB_API_KEY + "&language=en&append_to_response=external_ids";
  return fetchJson(url, { "Accept": "application/json" }).then(function(d) {
    var title = type === "movie" ? (d.title || d.original_title) : (d.name || d.original_name);
    var date = type === "movie" ? d.release_date : d.first_air_date;
    var imdb = (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || "";
    return { title: title || "", year: (date || "").slice(0, 4), imdbId: imdb };
  });
}

// ---------------------------------------------------------------- videasy
function buildSourcesUrl(server, ctx) {
  var q = "title=" + pyQuote(pyQuote(ctx.meta.title)) +
    "&mediaType=" + ctx.type +
    "&year=" + ctx.meta.year;
  if (ctx.type === "tv") q += "&episodeId=" + ctx.episode + "&seasonId=" + ctx.season;
  q += "&tmdbId=" + ctx.tmdbId + "&imdbId=" + ctx.meta.imdbId + "&enc=2&seed=" + ctx.seed;
  if (server.extra) q += server.extra;
  return API_BASE + "/" + server.path + "/sources-with-title?" + q;
}

function decrypt(encText, ctx) {
  return postJson(DEC_API, { text: encText, id: String(ctx.tmdbId), seed: ctx.seed }).then(function(j) {
    if (!j || j.status !== 200 || !j.result) {
      throw new Error("status " + (j && j.status) + (j && j.error ? " " + j.error : (j && !j.result ? " no result" : "")));
    }
    return j.result;
  });
}

var SUB_KEY = /sub|caption|track|thumb|poster|vtt|srt|preview/i;
var SUB_URL = /\.(vtt|srt|ass|ssa|jpg|jpeg|png|webp)(\?|#|$)/i;

function walkSources(node, out, depth, key) {
  if (node == null || depth > 6) return;
  if (typeof node === "string") {
    if (/^https?:\/\//i.test(node) && !SUB_KEY.test(key || "") && !SUB_URL.test(node)) out.push({ url: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(function(n) { walkSources(n, out, depth + 1, key); });
    return;
  }
  if (typeof node === "object") {
    var u = node.url || node.file || node.src || node.link || node.playlist || node.stream;
    if (typeof u === "string" && /^https?:\/\//i.test(u)) {
      if (!SUB_KEY.test(key || "") && !SUB_URL.test(u)) out.push(node);
      return;
    }
    Object.keys(node).forEach(function(k) {
      if (!SUB_KEY.test(k)) walkSources(node[k], out, depth + 1, k);
    });
  }
}

function shortJson(v, n) {
  var t;
  try { t = typeof v === "string" ? v : JSON.stringify(v); } catch (e) { t = String(v); }
  return String(t).replace(/\s+/g, " ").slice(0, n || 140);
}

function pickSources(result, server) {
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch (e) { /* keep string */ }
  }
  var list = [];
  walkSources(result, list, 0, "");
  if (server.only) {
    list = list.filter(function(x) {
      return String(x.quality || x.language || x.label || "").toLowerCase() === server.only;
    });
  }
  return list;
}

function makeStream(server, ctx, url, kind, h, bw, rank) {
  var label = qualityLabel(h, bw);
  return {
    name: PROVIDER_NAME + " " + server.name + " " + label,
    title: ctx.displayTitle + " • " + label + " • " + server.name,
    url: url,
    quality: label,
    size: "Unknown",
    type: kind,
    headers: ctx.streamHeaders,
    provider: PROVIDER_ID,
    _rank: rank
  };
}

// One source -> its own link, plus (for an HLS master) one link per quality variant.
function expandSource(server, src, ctx) {
  var url = src.url || src.file || src.src || src.link || src.playlist || src.stream;
  if (!url || String(url).indexOf("http") !== 0) return Promise.resolve([]);
  var kind = detectType(src.type, url);
  var h = server.only ? 0 : parseQuality(src.quality || src.label || src.resolution);

  if (h > 0) return Promise.resolve([makeStream(server, ctx, url, kind, h, 0, h)]);

  var base = makeStream(server, ctx, url, kind, 0, 0, 1000000);
  if (kind !== "hls" || !EXPAND_HLS) return Promise.resolve([base]);

  return fetchText(url, ctx.streamHeaders).then(function(text) {
    var variants = expandHls(url, text);
    if (variants.length < 2) return [base];
    return [base].concat(variants.map(function(v) {
      return makeStream(server, ctx, v.url, "hls", v.height, v.bandwidth, v.height || 0);
    }));
  }).catch(function(e) {
    log(server.name + " master fetch failed: " + (e && e.message));
    return [base];
  });
}

function retry(fn, times) {
  return fn().catch(function(e) {
    if (times <= 0) throw e;
    return retry(fn, times - 1);
  });
}

function runServer(server, ctx) {
  var tag = server.name;
  return retry(function() { return fetchText(buildSourcesUrl(server, ctx), ctx.apiHeaders); }, 1).catch(function(e) {
    throw new Error("sources " + (e && e.message));
  }).then(function(enc) {
    if (!enc || enc.length < 8) throw new Error("empty payload");
    if (/^\s*</.test(enc)) throw new Error("html reply (blocked?) " + shortJson(enc, 40));
    if (/^\s*\{/.test(enc)) throw new Error("json reply " + shortJson(enc, 80));
    return decrypt(enc, ctx).catch(function(e) { throw new Error("decrypt " + (e && e.message)); });
  }).then(function(result) {
    var list = pickSources(result, server);
    log(tag + ": " + list.length + " source(s)");
    if (!list.length) {
      ctx.diag.push(tag + ": 0 sources, result=" + shortJson(result, 110));
      return [];
    }
    return Promise.all(list.map(function(src) {
      return expandSource(server, src, ctx).catch(function() { return []; });
    })).then(function(groups) {
      var flat = [];
      groups.forEach(function(g) { flat = flat.concat(g); });
      flat.sort(function(a, b) { return b._rank - a._rank; });
      return flat;
    });
  }).catch(function(e) {
    var msg = tag + ": " + (e && e.message);
    log(msg);
    ctx.diag.push(msg);
    return [];
  });
}

// Run all servers in parallel; resolve when all finished OR the deadline hits (partial results kept).
function runAll(ctx) {
  return new Promise(function(resolve) {
    var all = [];
    var pending = SERVERS.length;
    var finished = false;
    var timer = null;
    function finish() {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(all);
    }
    if (typeof setTimeout === "function") {
      timer = setTimeout(function() {
        ctx.diag.push("deadline " + (GLOBAL_DEADLINE_MS / 1000) + "s hit, " + pending + " server(s) still pending");
        finish();
      }, GLOBAL_DEADLINE_MS);
    }
    SERVERS.forEach(function(sv) {
      runServer(sv, ctx).then(function(list) {
        list.forEach(function(x) { all.push(x); });
      }).then(function() {
        pending--;
        if (pending <= 0) finish();
      });
    });
  });
}

function diagStream(ctx) {
  return {
    name: PROVIDER_NAME + " \u26A0 no links",
    title: ctx.diag.join(" | ").slice(0, 400) || "unknown failure",
    url: "https://videasy-debug.invalid/no-links.m3u8",
    quality: "Auto",
    size: "Unknown",
    type: "hls",
    headers: {},
    provider: PROVIDER_ID
  };
}

// ---------------------------------------------------------------- core
function getStreamsFor(tmdbId, type, season, episode) {
  var ctx = {
    tmdbId: tmdbId, type: type, season: season, episode: episode,
    meta: { title: "", year: "", imdbId: "" }, seed: "", displayTitle: "", diag: [],
    apiHeaders: {
      "Accept": "*/*",
      "Origin": PLAYER_ORIGIN,
      "Referer": PLAYER_REFERER,
      "User-Agent": UA
    },
    streamHeaders: {
      "User-Agent": UA,
      "Referer": PLAYER_REFERER,
      "Origin": PLAYER_ORIGIN,
      "Accept": "*/*"
    }
  };

  // TMDB title + seed in parallel; seed is mandatory, TMDB failure only degrades the title/year/imdb
  var metaP = retry(function() { return fetchMeta(tmdbId, type); }, 1).catch(function(e) {
    ctx.diag.push("TMDB: " + (e && e.message));
    return null;
  });
  var seedP = retry(function() {
    return fetchJson(API_BASE + "/seed?mediaId=" + encodeURIComponent(tmdbId), ctx.apiHeaders);
  }, 1);

  return Promise.all([metaP, seedP.catch(function(e) {
    ctx.diag.push("seed: " + (e && e.message));
    return null;
  })]).then(function(r) {
    if (r[0]) ctx.meta = r[0];
    var p2 = function(n) { return n < 10 ? "0" + n : String(n); };
    ctx.displayTitle = type === "movie"
      ? (ctx.meta.title || ("TMDB " + tmdbId)) + (ctx.meta.year ? " (" + ctx.meta.year + ")" : "")
      : (ctx.meta.title || ("TMDB " + tmdbId)) + " S" + p2(season) + "E" + p2(episode);
    log(type + ' "' + ctx.displayTitle + '"');

    if (!r[1] || !r[1].seed) {
      if (r[1]) ctx.diag.push("seed: no seed in " + shortJson(r[1], 80));
      return [];
    }
    ctx.seed = String(r[1].seed);
    return runAll(ctx);
  }).then(function(list) {
    var seen = {};
    var out = [];
    list.forEach(function(x) {
      if (seen[x.url]) return;
      seen[x.url] = true;
      delete x._rank;
      out.push(x);
    });
    log("Returned " + out.length + " stream(s)" + (ctx.diag.length ? " | diag: " + ctx.diag.join(" | ") : ""));
    if (!out.length && DEBUG_STREAM) return [diagStream(ctx)];
    return out;
  });
}

// ---------------------------------------------------------------- entry point
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;
  log("getStreams: " + tmdbId + " " + type + " S" + season + "E" + episode);

  return getStreamsFor(tmdbId, type, season, episode).catch(function(err) {
    log("error: " + (err && err.message));
    if (!DEBUG_STREAM) return [];
    return [diagStream({ diag: ["fatal: " + (err && err.message)] })];
  });
}

module.exports = { getStreams: getStreams };
