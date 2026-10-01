var API_BASES = ["https://vidrock.net", "https://vidrock.to"];
var ORIGIN = "https://vidrock.net";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var KEY_HEX = "7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f";
var LANE_TIMEOUT = 12000;
var LANE_ORDER = ["orion", "luna", "nova", "astra", "atlas"];
var PROXY_PREFIX = "https://proxy.vidrock.store/";

/* ---------- small helpers ---------- */

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

function b64urlToBytes(str) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var s = String(str || "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+\/]/g, "");
  var out = [];
  var bits = 0, acc = 0;
  for (var i = 0; i < s.length; i++) {
    acc = (acc << 6) | chars.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

function bytesToStr(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/* ---------- AES-256 (encrypt only) + GCM counter-mode decrypt ---------- */

var SBOX = null;

function xtime(a) {
  return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
}

function initSbox() {
  if (SBOX) return;
  SBOX = [];
  var p = 1, q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ ((p & 0x80) ? 0x1b : 0)) & 0xff;
    q ^= (q << 1) & 0xff;
    q ^= (q << 2) & 0xff;
    q ^= (q << 4) & 0xff;
    if (q & 0x80) q ^= 0x09;
    var x = q ^ (((q << 1) | (q >> 7)) & 0xff) ^ (((q << 2) | (q >> 6)) & 0xff) ^ (((q << 3) | (q >> 5)) & 0xff) ^ (((q << 4) | (q >> 4)) & 0xff);
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
}

function expandKey256(key) {
  initSbox();
  var w = [];
  var i;
  for (i = 0; i < 8; i++) w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
  var rcon = 1;
  for (i = 8; i < 60; i++) {
    var t = w[i - 1].slice();
    if (i % 8 === 0) {
      t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
      rcon = xtime(rcon);
    } else if (i % 8 === 4) {
      t = [SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]];
    }
    w[i] = [w[i - 8][0] ^ t[0], w[i - 8][1] ^ t[1], w[i - 8][2] ^ t[2], w[i - 8][3] ^ t[3]];
  }
  var rk = [];
  for (i = 0; i < 60; i++) rk.push(w[i][0], w[i][1], w[i][2], w[i][3]);
  return rk;
}

function encryptBlock(rk, input) {
  var s = input.slice();
  var r, c, i;
  for (i = 0; i < 16; i++) s[i] ^= rk[i];
  for (r = 1; r <= 14; r++) {
    for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    var t = s.slice();
    for (c = 0; c < 4; c++) {
      for (i = 0; i < 4; i++) s[c * 4 + i] = t[((c + i) % 4) * 4 + i];
    }
    if (r < 14) {
      for (c = 0; c < 4; c++) {
        var a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        var all = a0 ^ a1 ^ a2 ^ a3;
        s[c * 4] = a0 ^ all ^ xtime(a0 ^ a1);
        s[c * 4 + 1] = a1 ^ all ^ xtime(a1 ^ a2);
        s[c * 4 + 2] = a2 ^ all ^ xtime(a2 ^ a3);
        s[c * 4 + 3] = a3 ^ all ^ xtime(a3 ^ a0);
      }
    }
    for (i = 0; i < 16; i++) s[i] ^= rk[r * 16 + i];
  }
  return s;
}

// GCM with a 12-byte IV: keystream blocks are AES(K, IV || counter), counter starts at 2.
// The auth tag is not checked; callers validate the plaintext instead.
function gcmDecrypt(keyBytes, iv, ct) {
  var rk = expandKey256(keyBytes);
  var out = [];
  var counter = 2;
  for (var off = 0; off < ct.length; off += 16) {
    var block = iv.slice(0, 12);
    block.push((counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff);
    var ks = encryptBlock(rk, block);
    for (var i = 0; i < 16 && off + i < ct.length; i++) out.push(ct[off + i] ^ ks[i]);
    counter++;
  }
  return out;
}

var KEY_BYTES = hexToBytes(KEY_HEX);

function decryptLaneUrl(blob) {
  var bytes = b64urlToBytes(blob);
  if (bytes.length < 12 + 16 + 4) return null;
  var plain = bytesToStr(gcmDecrypt(KEY_BYTES, bytes.slice(0, 12), bytes.slice(12, bytes.length - 16)));
  return /^https?:\/\/[\x21-\x7e]+$/.test(plain) ? plain : null;
}

/* ---------- lanes ---------- */

function normalizeLanes(data) {
  var lanes = [];
  if (!data || typeof data !== "object") return lanes;
  var entries = [];
  if (Object.prototype.toString.call(data) === "[object Array]") {
    data.forEach(function(v, i) { entries.push([(v && (v.name || v.server)) || ("Server " + (i + 1)), v]); });
  } else {
    Object.keys(data).forEach(function(k) { entries.push([k, data[k]]); });
  }
  entries.forEach(function(e) {
    var v = e[1];
    if (!v || typeof v !== "object" || typeof v.url !== "string" || !v.url) return;
    lanes.push({ name: String(e[0]), url: v.url, type: v.type || "", language: v.language || "" });
  });
  lanes.sort(function(a, b) {
    var ia = LANE_ORDER.indexOf(a.name.toLowerCase());
    var ib = LANE_ORDER.indexOf(b.name.toLowerCase());
    if (ia === -1) ia = 99;
    if (ib === -1) ib = 99;
    return ia - ib;
  });
  return lanes;
}

function fetchLanes(path) {
  var idx = 0;
  function next() {
    if (idx >= API_BASES.length) return Promise.resolve([]);
    var base = API_BASES[idx++];
    var url = base + path;
    console.log("[VidRock] API:", url);
    return fetchText(url, {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Referer": base + "/"
    }).then(function(text) {
      var data = JSON.parse(text);
      var lanes = normalizeLanes(data);
      console.log("[VidRock] lanes with url:", lanes.map(function(l) { return l.name; }).join(", ") || "none");
      return lanes.length ? lanes : next();
    }).catch(function(err) {
      console.log("[VidRock] API failed:", base, err.message);
      return next();
    });
  }
  return next();
}

function laneHeaders(url) {
  if (/ngcorp/i.test(url)) return { "User-Agent": " ", "Accept": "*/*" };
  return { "User-Agent": UA, "Referer": ORIGIN + "/", "Origin": ORIGIN, "Accept": "*/*" };
}

function qualityLabel(w, h) {
  if (!w && !h) return "Auto";
  if (w >= 3600 || h >= 2000) return "4K";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 650) return "720p";
  if (w >= 800 || h >= 450) return "480p";
  return "360p";
}

function parseMaster(text) {
  var maxW = 0, maxH = 0, m;
  var re = /RESOLUTION=(\d+)x(\d+)/gi;
  while ((m = re.exec(text)) !== null) {
    var w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (w > maxW) { maxW = w; maxH = h; }
  }
  return qualityLabel(maxW, maxH);
}

function unwrapProxy(u) {
  if (u.indexOf(PROXY_PREFIX) === 0) {
    try { return decodeURIComponent(u.slice(PROXY_PREFIX.length).replace(/^\//, "")); } catch (e) {}
  }
  return u;
}

function makeStream(url, lane, quality, verified) {
  var headers = laneHeaders(url);
  var parts = ["🎸 VidRock", lane.name];
  if (lane.language) parts.push(lane.language);
  if (quality && quality !== "Auto") parts.push(quality);
  if (!verified) parts.push("unverified");
  return {
    name: "🎸 VidRock",
    title: parts.join(" \u2022 "),
    url: url,
    quality: quality || "Auto",
    referer: headers["Referer"] || "",
    headers: headers,
    _verified: verified
  };
}

// Turns one API lane into 0..n playable streams. Never rejects.
function resolveLane(lane) {
  var url = lane.url;
  if (!/^https?:\/\//i.test(url)) {
    var dec = decryptLaneUrl(url);
    if (!dec) {
      console.log("[VidRock]", lane.name, "decrypt failed (key rotated?)");
      return Promise.resolve([]);
    }
    url = dec;
  }
  url = unwrapProxy(url);

  if (/\.mp4(\?|$)/i.test(url)) return Promise.resolve([makeStream(url, lane, "Auto", true)]);

  return fetchText(url, laneHeaders(url)).then(function(text) {
    var body = String(text || "").replace(/^\s+/, "");
    if (body.indexOf("#EXTM3U") === 0) {
      return [makeStream(url, lane, parseMaster(body), true)];
    }
    if (body.charAt(0) === "[" || body.charAt(0) === "{") {
      var json = JSON.parse(body);
      var list = Object.prototype.toString.call(json) === "[object Array]" ? json : [json];
      var out = [];
      list.forEach(function(item) {
        if (!item || typeof item.url !== "string") return;
        var u = unwrapProxy(item.url);
        var res = parseInt(item.resolution || item.quality, 10);
        out.push(makeStream(u, lane, res ? res + "p" : "Auto", true));
      });
      return out;
    }
    console.log("[VidRock]", lane.name, "unexpected body, keeping unverified");
    return [makeStream(url, lane, "Auto", false)];
  }).catch(function(err) {
    console.log("[VidRock]", lane.name, "check failed:", err.message, "- keeping unverified");
    return [makeStream(url, lane, "Auto", false)];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[VidRock] getStreams:", tmdbId, mediaType, season, episode);
  var path = mediaType === "tv"
    ? "/api/tv/" + encodeURIComponent(tmdbId) + "/" + (Number(season) || 1) + "/" + (Number(episode) || 1)
    : "/api/movie/" + encodeURIComponent(tmdbId);

  return fetchLanes(path).then(function(lanes) {
    if (!lanes.length) return [];
    return Promise.all(lanes.map(function(lane) {
      return withTimeout(resolveLane(lane), LANE_TIMEOUT, [makeStream(lane.url, lane, "Auto", false)].filter(function(s) { return /^https?:\/\//i.test(s.url); }));
    }));
  }).then(function(groups) {
    var verified = [], other = [], seen = {};
    groups.forEach(function(g) {
      g.forEach(function(s) {
        if (seen[s.url]) return;
        seen[s.url] = 1;
        var v = s._verified;
        delete s._verified;
        (v ? verified : other).push(s);
      });
    });
    var all = verified.concat(other);
    console.log("[VidRock] streams:", all.length, "(verified:", verified.length + ")");
    return all;
  }).catch(function(err) {
    console.log("[VidRock] error:", err.message);
    return [];
  });
}

module.exports = {
  getStreams: getStreams
};
