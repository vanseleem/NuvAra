
var VIDLINK_API = "https://vidlink.pro";
var DECRYPT_API = "https://enc-dec.app/api";
var TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";   // only used for the title text
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
var HEADERS = {
  "User-Agent": UA,
  "Connection": "keep-alive",
  "Referer": VIDLINK_API + "/",
  "Origin": VIDLINK_API
};
var MIN_HEIGHT = 360;        // smallest variant to list (the original script stopped at 720)
var FETCH_TIMEOUT = 10000;
var META_TIMEOUT = 4000;     // TMDB is cosmetic, never wait long for it

// Fallback only: used if enc-dec.app is down or its token is refused.
var KEY_HEX = "c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd";
var TOKEN_TTL = 480;

/* ---------- http ---------- */

function timed(promise, ms) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var t = setTimeout(function() { if (!done) { done = true; reject(new Error("timeout")); } }, ms);
    promise.then(function(v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
                 function(e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
  });
}

function getRes(url, headers, ms) {
  var req = headers ? fetch(url, { headers: headers }) : fetch(url);
  return timed(req.then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r;
  }), ms || FETCH_TIMEOUT);
}

function getJson(url, headers, ms) {
  return getRes(url, headers, ms).then(function(r) { return r.json(); });
}

function getText(url, headers, ms) {
  return getRes(url, headers, ms).then(function(r) { return r.text(); });
}

/* ---------- local token (fallback only) ---------- */

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

/* XSalsa20-Poly1305 (NaCl secretbox), pure JS */

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

// XOR data with the XSalsa20 keystream (24-byte nonce), starting at stream offset skip.
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

/* ---------- HLS master parsing ---------- */

function labelFromRes(w, h) {
  if (!w && !h) return "";
  if (w >= 3600 || h >= 2000) return "4K";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 650) return "720p";
  if (w >= 800 || h >= 450) return "480p";
  return "360p";
}

function normPath(p) {
  var out = [];
  p.split("/").forEach(function(seg) {
    if (seg === ".") return;
    if (seg === "..") { if (out.length > 1) out.pop(); return; }
    out.push(seg);
  });
  return out.join("/");
}

// Resolve a playlist/segment reference against the URL it was found in.
function resolveRel(base, rel) {
  rel = String(rel || "").trim();
  if (/^https?:\/\//i.test(rel)) return rel;
  var m = String(base).match(/^(https?:\/\/)([^\/?#]+)([^?#]*)/i);
  if (!m) return rel;
  if (rel.indexOf("//") === 0) return m[1] + rel;
  var qi = rel.search(/[?#]/);
  var relPath = qi === -1 ? rel : rel.slice(0, qi);
  var relTail = qi === -1 ? "" : rel.slice(qi);
  var path = relPath.charAt(0) === "/" ? relPath : (m[3].replace(/[^\/]*$/, "") || "/") + relPath;
  return m[1] + m[2] + normPath(path) + relTail;
}

// #EXT-X-STREAM-INF entries of a master playlist -> [{url,width,height,bandwidth}]
function parseMaster(text, baseUrl) {
  var lines = String(text || "").split(/\r?\n/);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
    var res = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    var bw = line.match(/(?:^|[,:])BANDWIDTH=(\d+)/i);
    var j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().charAt(0) === "#")) j++;
    if (j >= lines.length) break;
    out.push({
      url: resolveRel(baseUrl, lines[j].trim()),
      width: res ? parseInt(res[1], 10) : 0,
      height: res ? parseInt(res[2], 10) : 0,
      bandwidth: bw ? parseInt(bw[1], 10) : 0
    });
    i = j;
  }
  return out;
}

/* ---------- TMDB (title text only) ---------- */

function getMeta(tmdbId, isMovie, season, episode) {
  var def = { name: "Unknown Title", year: "N/A", duration: isMovie ? "90 min" : "45 min" };
  var base = "https://api.themoviedb.org/3/";
  var main = getJson(base + (isMovie ? "movie/" : "tv/") + tmdbId + "?api_key=" + TMDB_API_KEY, null, META_TIMEOUT);
  var ep = isMovie ? Promise.resolve(null)
    : getJson(base + "tv/" + tmdbId + "/season/" + season + "/episode/" + episode + "?api_key=" + TMDB_API_KEY, null, META_TIMEOUT)
        .catch(function() { return null; });
  return Promise.all([main, ep]).then(function(r) {
    var d = r[0], e = r[1];
    var duration = def.duration;
    if (isMovie && d.runtime) duration = d.runtime + " min";
    else if (!isMovie) {
      if (e && e.runtime) duration = e.runtime + " min";
      else if (d.episode_run_time && d.episode_run_time.length > 0) duration = d.episode_run_time[0] + " min";
    }
    return {
      name: d.title || d.name || def.name,
      year: (d.release_date || d.first_air_date || "").split("-")[0] || "N/A",
      duration: duration
    };
  }).catch(function() { return def; });
}

/* ---------- quality labels (same scheme as the original) ---------- */

function qualityInfo(q) {
  var s = String(q || "").toLowerCase();
  if (s.indexOf("auto") !== -1) return { label: "Auto Dynamic", short: "Auto" };
  if (s.indexOf("2160") !== -1 || s.indexOf("4k") !== -1) return { label: "4K UHD", short: "2160P" };
  if (s.indexOf("1080") !== -1) return { label: "1080p FHD", short: "1080P" };
  if (s.indexOf("720") !== -1) return { label: "720p HD", short: "720P" };
  if (s.indexOf("480") !== -1) return { label: "480p SD", short: "480P" };
  if (s.indexOf("360") !== -1) return { label: "360p", short: "360P" };
  return { label: "1080p FHD", short: "1080P" };
}

// Zero-width prefixes make the app list higher qualities first (kept from the original).
function sortedQuality(q) {
  if (!q) return "Auto";
  var s = String(q).toLowerCase();
  var Z = "\u200b";
  if (s.indexOf("auto") !== -1) return "Auto";
  if (s.indexOf("2160") !== -1 || s.indexOf("4k") !== -1 || s.indexOf("uhd") !== -1) return Z + q;
  if (s.indexOf("1080") !== -1 || s.indexOf("fhd") !== -1) return Z + Z + q;
  if (s.indexOf("720") !== -1 || s.indexOf("hd") !== -1) return Z + Z + Z + q;
  if (s.indexOf("480") !== -1 || s.indexOf("sd") !== -1) return Z + Z + Z + Z + q;
  if (s.indexOf("360") !== -1) return Z + Z + Z + Z + Z + q;
  return Z + Z + Z + Z + q;
}

/* ---------- token + playlist ---------- */

function relayToken(tmdbId) {
  return getJson(DECRYPT_API + "/enc-vidlink?text=" + encodeURIComponent(tmdbId)).then(function(j) {
    var t = j && j.result;
    if (!t || typeof t !== "string") throw new Error("No encrypted ID returned");
    return t;
  });
}

function findPlaylist(node, depth) {
  if (!node || typeof node !== "object" || depth > 6) return "";
  if (node.stream && typeof node.stream.playlist === "string" && node.stream.playlist) return node.stream.playlist;
  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    var v = node[keys[i]];
    if (keys[i] === "playlist" && typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    if (v && typeof v === "object") {
      var f = findPlaylist(v, depth + 1);
      if (f) return f;
    }
  }
  return "";
}

function fetchPlaylist(token, isMovie, season, episode) {
  var url = isMovie
    ? VIDLINK_API + "/api/b/movie/" + token
    : VIDLINK_API + "/api/b/tv/" + token + "/" + season + "/" + episode;
  console.log("[Vidlink] Fetching playlist from: " + url);
  return getJson(url, HEADERS).then(function(data) {
    var pl = findPlaylist(data, 0);
    if (!pl) console.log("[Vidlink] No playlist in response");
    return pl;
  });
}

function resolvePlaylist(tmdbId, isMovie, season, episode) {
  return relayToken(tmdbId).then(function(tok) {
    return fetchPlaylist(tok, isMovie, season, episode);
  }).catch(function(err) {
    console.log("[Vidlink] relay path failed: " + err.message);
    return "";
  }).then(function(pl) {
    if (pl) return pl;
    var local = "";
    try { local = makeToken(String(tmdbId), Math.floor(Date.now() / 1000)); } catch (e) { return ""; }
    console.log("[Vidlink] trying local token");
    return fetchPlaylist(local, isMovie, season, episode).catch(function(err) {
      console.log("[Vidlink] local token path failed: " + err.message);
      return "";
    });
  });
}

// Master playlist -> one entry per variant (fetched with Referer + User-Agent only, like the original).
function expandMaster(playlistUrl) {
  return getText(playlistUrl, { "Referer": VIDLINK_API + "/", "User-Agent": UA }).then(function(text) {
    var variants = parseMaster(text, playlistUrl).filter(function(v) { return v.height >= MIN_HEIGHT; });
    variants.sort(function(a, b) { return (b.height - a.height) || (b.bandwidth - a.bandwidth); });
    var seen = {};
    var out = [];
    variants.forEach(function(v) {
      if (seen[v.url]) return;
      seen[v.url] = 1;
      out.push({ quality: labelFromRes(v.width, v.height) || (v.height + "p"), url: v.url });
    });
    return out;
  }).catch(function() {
    console.log("[M3U8] Error parsing M3U8, returning empty.");
    return [];
  });
}

/* ---------- stream objects ---------- */

function makeStream(meta, isMovie, season, episode, q, url) {
  var info = qualityInfo(q);
  var shown = meta.name + (isMovie ? "" : " S" + season + "E" + episode);
  return {
    name: "VidLink | " + info.label + " | Main Mirror",
    title: "🎬 " + shown + " - " + meta.year +
           "\n⚡ " + info.short + " | 🌍 Original" +
           "\n🎞 M3U8 | ⏱ " + meta.duration + " | 📌 Main Mirror",
    url: url,
    quality: sortedQuality(q),
    type: "m3u8",
    headers: { "User-Agent": UA, "Referer": VIDLINK_API + "/", "Origin": VIDLINK_API },
    provider: "vidlink"
  };
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[Vidlink] Fetching streams for " + mediaType + " " + tmdbId);
  var isMovie = mediaType !== "tv" && season == null;
  var s = Number(season) || 1;
  var e = Number(episode) || 1;
  var metaP = getMeta(tmdbId, isMovie, s, e);

  return resolvePlaylist(tmdbId, isMovie, s, e).then(function(playlist) {
    if (!playlist) return [];
    return Promise.all([metaP, expandMaster(playlist)]).then(function(r) {
      var out = [makeStream(r[0], isMovie, s, e, "Auto", playlist)];
      r[1].forEach(function(v) { out.push(makeStream(r[0], isMovie, s, e, v.quality, v.url)); });
      console.log("[Vidlink] Found playlist stream, entries: " + out.length);
      return out;
    });
  }).catch(function(err) {
    console.log("[Vidlink] Error: " + err.message);
    return [];
  });
}

module.exports = {
  getStreams: getStreams
};
