var API_BASE = "https://vidlink.pro";
var ENC_RELAY = "https://enc-dec.app/api/enc-vidlink?text=";
var KEY_HEX = "c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";
var TOKEN_TTL = 480;
var CHECK_TIMEOUT = 12000;

/* ---------- helpers ---------- */

function withTimeout(promise, ms, fallback) {
  if (typeof setTimeout !== "function") return promise;
  return new Promise(function(resolve) {
    var done = false;
    var t = setTimeout(function() {
      if (!done) { done = true; resolve(fallback); }
    }, ms);
    function finish(v) {
      if (done) return;
      done = true;
      if (typeof clearTimeout === "function") clearTimeout(t);
      resolve(v);
    }
    promise.then(finish, function() { finish(fallback); });
  });
}

function apiHeaders() {
  return {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Origin": API_BASE,
    "Referer": API_BASE + "/",
    "x-playback-environment": "webkit"
  };
}

function streamHeaders() {
  return {
    "User-Agent": UA,
    "Accept": "*/*",
    "Origin": API_BASE,
    "Referer": API_BASE + "/",
    "x-playback-environment": "webkit"
  };
}

function fetchText(url, headers) {
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function hexToBytes(hex) {
  var out = [];
  for (var i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

function strToBytes(s) {
  var out = [];
  s = String(s);
  for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
  return out;
}

function bytesToB64Url(bytes) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  var out = "";
  var i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += chars.charAt((n >> 18) & 63) + chars.charAt((n >> 12) & 63) + chars.charAt((n >> 6) & 63) + chars.charAt(n & 63);
  }
  if (i + 1 === bytes.length) {
    var a = bytes[i] << 16;
    out += chars.charAt((a >> 18) & 63) + chars.charAt((a >> 12) & 63);
  } else if (i + 2 === bytes.length) {
    var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += chars.charAt((b >> 18) & 63) + chars.charAt((b >> 12) & 63) + chars.charAt((b >> 6) & 63);
  }
  return out;
}

/* ---------- XSalsa20-Poly1305 (NaCl secretbox), pure JS ---------- */

function rotl(a, b) {
  return (a << b) | (a >>> (32 - b));
}

function qr(x, a, b, c, d) {
  x[b] ^= rotl((x[a] + x[d]) | 0, 7);
  x[c] ^= rotl((x[b] + x[a]) | 0, 9);
  x[d] ^= rotl((x[c] + x[b]) | 0, 13);
  x[a] ^= rotl((x[d] + x[c]) | 0, 18);
}

function le32(b, i) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
}

var SIGMA = [101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107];

function salsaState(inp, key) {
  return [
    le32(SIGMA, 0), le32(key, 0), le32(key, 4), le32(key, 8), le32(key, 12),
    le32(SIGMA, 4), le32(inp, 0), le32(inp, 4), le32(inp, 8), le32(inp, 12),
    le32(SIGMA, 8), le32(key, 16), le32(key, 20), le32(key, 24), le32(key, 28),
    le32(SIGMA, 12)
  ];
}

function salsaRounds(x) {
  for (var i = 0; i < 10; i++) {
    qr(x, 0, 4, 8, 12); qr(x, 5, 9, 13, 1); qr(x, 10, 14, 2, 6); qr(x, 15, 3, 7, 11);
    qr(x, 0, 1, 2, 3); qr(x, 5, 6, 7, 4); qr(x, 10, 11, 8, 9); qr(x, 15, 12, 13, 14);
  }
}

function words2bytes(words, out) {
  for (var i = 0; i < words.length; i++) {
    out.push(words[i] & 255, (words[i] >>> 8) & 255, (words[i] >>> 16) & 255, (words[i] >>> 24) & 255);
  }
  return out;
}

function salsa20Block(inp, key) {
  var s = salsaState(inp, key);
  var x = s.slice();
  salsaRounds(x);
  for (var i = 0; i < 16; i++) x[i] = (x[i] + s[i]) | 0;
  return words2bytes(x, []);
}

function hsalsa20(inp, key) {
  var x = salsaState(inp, key);
  salsaRounds(x);
  return words2bytes([x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]], []);
}

// XOR `data` with the XSalsa20 keystream (24-byte nonce), starting at stream offset `skip`.
function xsalsa20Xor(data, nonce, key, skip) {
  var subkey = hsalsa20(nonce.slice(0, 16), key);
  var out = [];
  var total = skip + data.length;
  var block = [];
  var counter = 0;
  var produced = 0;
  while (produced < total) {
    var inp = nonce.slice(16, 24).concat([counter & 255, (counter >>> 8) & 255, (counter >>> 16) & 255, (counter >>> 24) & 255, 0, 0, 0, 0]);
    block = salsa20Block(inp, subkey);
    for (var i = 0; i < 64 && produced < total; i++, produced++) {
      if (produced >= skip) out.push(data[produced - skip] ^ block[i]);
    }
    counter++;
  }
  return out;
}

// Original TweetNaCl Poly1305 (17 limbs of 8 bits).
function poly1305(m, k) {
  var h = [], r = [], c = [], x = [], g = [], i, j, u, s;
  var minusp = [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 252];
  for (j = 0; j < 17; j++) { r[j] = 0; h[j] = 0; }
  for (j = 0; j < 16; j++) r[j] = k[j];
  r[3] &= 15; r[4] &= 252; r[7] &= 15; r[8] &= 252; r[11] &= 15; r[12] &= 252; r[15] &= 15;
  function add(hh, cc) {
    var t = 0;
    for (var q = 0; q < 17; q++) { t += hh[q] + cc[q]; hh[q] = t & 255; t >>= 8; }
  }
  var pos = 0, n = m.length;
  while (n > 0) {
    for (j = 0; j < 17; j++) c[j] = 0;
    for (j = 0; j < 16 && j < n; j++) c[j] = m[pos + j];
    c[j] = 1;
    pos += j; n -= j;
    add(h, c);
    for (i = 0; i < 17; i++) {
      x[i] = 0;
      for (j = 0; j < 17; j++) x[i] += h[j] * (j <= i ? r[i - j] : 320 * r[i + 17 - j]);
    }
    for (i = 0; i < 17; i++) h[i] = x[i];
    u = 0;
    for (j = 0; j < 16; j++) { u += h[j]; h[j] = u & 255; u >>= 8; }
    u += h[16]; h[16] = u & 3;
    u = 5 * (u >> 2);
    for (j = 0; j < 16; j++) { u += h[j]; h[j] = u & 255; u >>= 8; }
    u += h[16]; h[16] = u;
  }
  for (j = 0; j < 17; j++) g[j] = h[j];
  add(h, minusp);
  s = -(h[16] >> 7);
  for (j = 0; j < 17; j++) h[j] ^= s & (g[j] ^ h[j]);
  for (j = 0; j < 16; j++) c[j] = k[j + 16];
  c[16] = 0;
  add(h, c);
  return h.slice(0, 16);
}

// Returns tag(16) || ciphertext, same layout as nacl.secretbox.
function secretbox(msg, nonce, key) {
  var zeros = [];
  for (var i = 0; i < 32; i++) zeros.push(0);
  var polyKey = xsalsa20Xor(zeros, nonce, key, 0);
  var ct = xsalsa20Xor(msg, nonce, key, 32);
  return poly1305(ct, polyKey).concat(ct);
}

function makeToken(mediaId, nowSec) {
  var ts = nowSec + TOKEN_TTL;
  var tsBytes = [];
  var hi = Math.floor(ts / 4294967296);
  var lo = ts >>> 0;
  tsBytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  var msg = strToBytes(mediaId).concat(tsBytes);
  var nonce = new Array(24);
  for (var i = 0; i < 24; i++) nonce[i] = 0;
  var box = secretbox(msg, nonce, hexToBytes(KEY_HEX));
  return bytesToB64Url(nonce.concat(box));
}

/* ---------- API ---------- */

function apiPath(tokenOrId, mediaType, season, episode) {
  if (mediaType === "tv") return "/api/b/tv/" + tokenOrId + "/" + (Number(season) || 1) + "/" + (Number(episode) || 1) + "?multiLang=1";
  return "/api/b/movie/" + tokenOrId + "?multiLang=1";
}

function relayToken(tmdbId) {
  return fetchText(ENC_RELAY + encodeURIComponent(tmdbId), { "User-Agent": UA, "Accept": "application/json" }).then(function(text) {
    var t = String(text || "").trim();
    try {
      var j = JSON.parse(t);
      if (j && typeof j === "object") t = j.result || j.data || j.token || j.encrypted || "";
      else if (typeof j === "string") t = j;
    } catch (e) {}
    if (!t || typeof t !== "string") throw new Error("relay returned no token");
    return t;
  });
}

function callApi(token, mediaType, season, episode) {
  var url = API_BASE + apiPath(token, mediaType, season, episode);
  console.log("[VidLink] API:", url.slice(0, 80) + "...");
  return fetchText(url, apiHeaders()).then(function(text) {
    var body = String(text || "").trim();
    if (!body || body === "null") return null;
    return JSON.parse(body);
  });
}

function fetchSources(tmdbId, mediaType, season, episode) {
  var local = null;
  try { local = makeToken(String(tmdbId), Math.floor(Date.now() / 1000)); } catch (e) { console.log("[VidLink] token error:", e.message); }
  var first = local ? callApi(local, mediaType, season, episode).catch(function(err) {
    console.log("[VidLink] local token call failed:", err.message);
    return undefined;
  }) : Promise.resolve(undefined);

  return first.then(function(data) {
    if (data) return data;
    console.log("[VidLink] retrying with enc-dec relay token");
    return relayToken(String(tmdbId)).then(function(tok) {
      return callApi(tok, mediaType, season, episode);
    }).catch(function(err) {
      console.log("[VidLink] relay path failed:", err.message);
      return null;
    });
  });
}

/* ---------- response parsing (shape tolerant) ---------- */

var SKIP_PATH = /caption|subtitle|thumb|poster|image|sprite|track/i;
var MEDIA_KEYS = /^(playlist|file|url|src|source|hls|mp4|dash|stream|link|manifest)$/i;

function looksMedia(url, key, path) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (SKIP_PATH.test(path)) return false;
  if (/\.(vtt|srt|ass|ssa|jpe?g|png|webp|gif|svg|ico)(\?|$)/i.test(url)) return false;
  if (/\.(m3u8|mp4|mpd|mkv|webm)(\?|$)/i.test(url)) return true;
  return MEDIA_KEYS.test(key);
}

function collectMedia(node, key, path, ctx, out, depth) {
  if (depth > 8 || node === null || node === undefined) return;
  if (typeof node === "string") {
    if (looksMedia(node, key, path)) out.push({ url: node, key: key, ctx: ctx, path: path });
    return;
  }
  if (typeof node !== "object") return;
  var isArr = Object.prototype.toString.call(node) === "[object Array]";
  var next = ctx;
  if (!isArr) {
    next = { source: ctx.source, lang: ctx.lang, quality: ctx.quality };
    ["sourceId", "source", "server", "name", "provider"].forEach(function(k) { if (typeof node[k] === "string" && node[k]) next.source = node[k]; });
    ["language", "lang", "label"].forEach(function(k) { if (typeof node[k] === "string" && node[k] && node[k].length < 30) next.lang = node[k]; });
    ["quality", "resolution", "height"].forEach(function(k) { if ((typeof node[k] === "string" || typeof node[k] === "number") && node[k]) next.quality = String(node[k]); });
  }
  var keys = isArr ? node.map(function(_, i) { return i; }) : Object.keys(node);
  keys.forEach(function(k) {
    collectMedia(node[k], String(k), path + "/" + k, next, out, depth + 1);
  });
}

function qualityFromText(s) {
  var m = String(s || "").match(/(2160|1440|1080|720|480|360)/);
  if (m) return m[1] + "p";
  if (/4k/i.test(s)) return "4K";
  return "";
}

function qualityFromMaster(text) {
  var maxW = 0, maxH = 0, m;
  var re = /RESOLUTION=(\d+)x(\d+)/gi;
  while ((m = re.exec(text)) !== null) {
    var w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (w > maxW) { maxW = w; maxH = h; }
  }
  if (!maxW) return "";
  if (maxW >= 3600 || maxH >= 2000) return "4K";
  if (maxW >= 1800 || maxH >= 1000) return "1080p";
  if (maxW >= 1200 || maxH >= 650) return "720p";
  if (maxW >= 800 || maxH >= 450) return "480p";
  return "360p";
}

function makeStream(item, kind, quality, verified) {
  var parts = ["🔗 VidLink"];
  if (item.ctx.source) parts.push(item.ctx.source);
  if (item.ctx.lang) parts.push(item.ctx.lang);
  if (quality) parts.push(quality);
  if (!verified) parts.push("unverified");
  var h = streamHeaders();
  return {
    name: "🔗 VidLink",
    title: parts.join(" \u2022 "),
    url: item.url,
    quality: quality || "Auto",
    referer: h["Referer"],
    headers: h,
    _kind: kind,
    _verified: verified
  };
}

function resolveItem(item) {
  var url = item.url;
  var hint = qualityFromText(item.ctx.quality) || qualityFromText(url) || qualityFromText(item.path);
  if (/\.mp4(\?|$)/i.test(url) || /\.(mkv|webm)(\?|$)/i.test(url)) return Promise.resolve([makeStream(item, "mp4", hint, true)]);
  if (/\.mpd(\?|$)/i.test(url)) return Promise.resolve([makeStream(item, "dash", hint, true)]);
  return fetchText(url, streamHeaders()).then(function(text) {
    var body = String(text || "").replace(/^\s+/, "");
    if (body.indexOf("#EXTM3U") === 0) return [makeStream(item, "hls", qualityFromMaster(body) || hint, true)];
    if (/^<\?xml|^<MPD/i.test(body)) return [makeStream(item, "dash", hint, true)];
    console.log("[VidLink] unexpected playlist body, keeping unverified");
    return [makeStream(item, "unknown", hint, false)];
  }).catch(function(err) {
    console.log("[VidLink] playlist check failed:", err.message, "- keeping unverified");
    return [makeStream(item, "unknown", hint, false)];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[VidLink] getStreams:", tmdbId, mediaType, season, episode);
  return fetchSources(tmdbId, mediaType, season, episode).then(function(data) {
    if (!data || typeof data !== "object") {
      console.log("[VidLink] no sources for this title (empty/null response)");
      return [];
    }
    console.log("[VidLink] response keys:", Object.keys(data).join(","));
    var found = [];
    collectMedia(data, "", "", { source: "", lang: "", quality: "" }, found, 0);
    var seen = {};
    found = found.filter(function(f) { if (seen[f.url]) return false; seen[f.url] = 1; return true; });
    console.log("[VidLink] media urls found:", found.length);
    if (!found.length) {
      console.log("[VidLink] response sample:", JSON.stringify(data).slice(0, 400));
      return [];
    }
    return Promise.all(found.map(function(item) {
      return withTimeout(resolveItem(item), CHECK_TIMEOUT, [makeStream(item, "unknown", "", false)]);
    })).then(function(groups) {
      var ok = [], rest = [];
      groups.forEach(function(g) {
        g.forEach(function(s) {
          var v = s._verified;
          delete s._kind;
          delete s._verified;
          (v ? ok : rest).push(s);
        });
      });
      var all = ok.concat(rest);
      console.log("[VidLink] streams:", all.length, "(verified:", ok.length + ")");
      return all;
    });
  }).catch(function(err) {
    console.log("[VidLink] error:", err.message);
    return [];
  });
}

module.exports = {
  getStreams: getStreams
};
