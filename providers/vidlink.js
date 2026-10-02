

var API_URL = 'https://vidlink.pro/api/b';
var PROVIDER_ID = 'vidlink';
var PROVIDER_NAME = 'VidLink';
var REFERER = 'https://vidlink.pro/';
var ORIGIN = 'https://vidlink.pro';

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

var REQUEST_TIMEOUT = 15000;

// AES-256-CBC key (hex) recovered from vidlink.pro frontend
var KEY_HEX = '2de6e6ea13a9df9503b11a6117fd7e51941e04a0c223dfeacfe8a1dbb6c52783';

var WORKING_HEADERS = {
  'User-Agent': UA,
  'Referer': REFERER,
  'Origin': ORIGIN,
  'Accept': '*/*',
};

// ─────────────────────────────── Logging ──────────────────────────────

function log(message) {
  console.log('[VidLink] ' + message);
}

// ──────────────────────────── Crypto (pure JS AES) ────────────────────

// Minimal AES-256-CBC implementation (no Node crypto dependency).
// Adapted from public-domain JS AES implementations for Hermes compatibility.

var AES = (function () {
  var SBOX = new Uint8Array(256);
  var INV_SBOX = new Uint8Array(256);
  var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

  (function init() {
    var p = 1, q = 1;
    do {
      p = p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0);
      p &= 0xff;
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
      if (q & 0x80) q ^= 0x09;
      var x = q ^ (q << 1) ^ (q << 2) ^ (q << 3) ^ (q << 4);
      x &= 0xff;
      SBOX[p] = x ^ 0x63;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (var i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  })();

  function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
  function mul(a, b) {
    var r = 0;
    while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
    return r;
  }

  function expandKey(key) {
    var Nk = key.length / 4;
    var Nr = Nk + 6;
    var w = [];
    for (var i = 0; i < Nk; i++) w[i] = [key[4*i], key[4*i+1], key[4*i+2], key[4*i+3]];
    for (var i = Nk; i < 4 * (Nr + 1); i++) {
      var temp = w[i-1].slice();
      if (i % Nk === 0) {
        temp.push(temp.shift());
        temp = temp.map(function (b) { return SBOX[b]; });
        temp[0] ^= RCON[(i / Nk) - 1];
      } else if (Nk > 6 && i % Nk === 4) {
        temp = temp.map(function (b) { return SBOX[b]; });
      }
      w[i] = w[i-Nk].map(function (b, j) { return b ^ temp[j]; });
    }
    return { w: w, Nr: Nr };
  }

  function encryptBlock(block, w, Nr) {
    var s = block.slice();
    var rk = function (r) { return w.slice(r*4, r*4+4); };
    function addRoundKey(r) {
      var k = rk(r);
      for (var c = 0; c < 4; c++) for (var i = 0; i < 4; i++) s[4*c+i] ^= k[c][i];
    }
    addRoundKey(0);
    for (var round = 1; round < Nr; round++) {
      for (var i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      // ShiftRows
      var t = s.slice();
      for (var c = 0; c < 4; c++) for (var i = 0; i < 4; i++) s[4*c+i] = t[4*((c+i)%4)+i];
      // MixColumns
      for (var c = 0; c < 4; c++) {
        var a0=s[4*c], a1=s[4*c+1], a2=s[4*c+2], a3=s[4*c+3];
        s[4*c]   = mul(a0,2)^mul(a1,3)^a2^a3;
        s[4*c+1] = a0^mul(a1,2)^mul(a2,3)^a3;
        s[4*c+2] = a0^a1^mul(a2,2)^mul(a3,3);
        s[4*c+3] = mul(a0,3)^a1^a2^mul(a3,2);
      }
      addRoundKey(round);
    }
    for (var i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    var t = s.slice();
    for (var c = 0; c < 4; c++) for (var i = 0; i < 4; i++) s[4*c+i] = t[4*((c+i)%4)+i];
    addRoundKey(Nr);
    return s;
  }

  function decryptBlock(block, w, Nr) {
    var s = block.slice();
    var rk = function (r) { return w.slice(r*4, r*4+4); };
    function addRoundKey(r) {
      var k = rk(r);
      for (var c = 0; c < 4; c++) for (var i = 0; i < 4; i++) s[4*c+i] ^= k[c][i];
    }
    addRoundKey(Nr);
    for (var round = Nr - 1; round >= 1; round--) {
      var t = s.slice();
      for (var c = 0; c < 4; c++) for (var i = 0; i < 4; i++) s[4*c+i] = t[4*((c-i+4)%4)+i];
      for (var i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
      addRoundKey(round);
      for (var c = 0; c < 4; c++) {
        var a0=s[4*c], a1=s[4*c+1], a2=s[4*c+2], a3=s[4*c+3];
        s[4*c]   = mul(a0,14)^mul(a1,11)^mul(a2,13)^mul(a3,9);
        s[4*c+1] = mul(a0,9)^mul(a1,14)^mul(a2,11)^mul(a3,13);
        s[4*c+2] = mul(a0,13)^mul(a1,9)^mul(a2,14)^mul(a3,11);
        s[4*c+3] = mul(a0,11)^mul(a1,13)^mul(a2,9)^mul(a3,14);
      }
    }
    var t = s.slice();
    for (var c = 0; c < 4; c++) for (var i = 0; i < 4; i++) s[4*c+i] = t[4*((c-i+4)%4)+i];
    for (var i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    addRoundKey(0);
    return s;
  }

  return {
    encryptCBC: function (plainBytes, keyBytes, ivBytes) {
      var expanded = expandKey(keyBytes);
      var padLen = 16 - (plainBytes.length % 16);
      var padded = new Uint8Array(plainBytes.length + padLen);
      padded.set(plainBytes);
      for (var i = plainBytes.length; i < padded.length; i++) padded[i] = padLen;
      var out = new Uint8Array(padded.length);
      var prev = ivBytes;
      for (var off = 0; off < padded.length; off += 16) {
        var block = new Array(16);
        for (var i = 0; i < 16; i++) block[i] = padded[off+i] ^ prev[i];
        var enc = encryptBlock(block, expanded.w, expanded.Nr);
        for (var i = 0; i < 16; i++) out[off+i] = enc[i];
        prev = enc;
      }
      return out;
    },
    decryptCBC: function (cipherBytes, keyBytes, ivBytes) {
      var expanded = expandKey(keyBytes);
      var out = new Uint8Array(cipherBytes.length);
      var prev = ivBytes;
      for (var off = 0; off < cipherBytes.length; off += 16) {
        var block = new Array(16);
        for (var i = 0; i < 16; i++) block[i] = cipherBytes[off+i];
        var dec = decryptBlock(block, expanded.w, expanded.Nr);
        for (var i = 0; i < 16; i++) out[off+i] = dec[i] ^ prev[i];
        prev = block;
      }
      var padLen = out[out.length - 1];
      if (padLen < 1 || padLen > 16) padLen = 0;
      return out.slice(0, out.length - padLen);
    },
  };
})();

function hexToBytes(hex) {
  var bytes = [];
  for (var i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  return new Uint8Array(bytes);
}

function bytesToHex(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
  return out;
}

function bytesToBase64(bytes) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = i+1 < bytes.length ? bytes[i+1] : 0, b2 = i+2 < bytes.length ? bytes[i+2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i+1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i+2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return out;
}

function base64ToBytes(b64) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var lookup = {};
  for (var i = 0; i < chars.length; i++) lookup[chars[i]] = i;
  var clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  var out = [];
  for (var i = 0; i < clean.length; i += 4) {
    var c0 = lookup[clean[i]] || 0, c1 = lookup[clean[i+1]] || 0;
    var c2 = lookup[clean[i+2]], c3 = lookup[clean[i+3]];
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 !== undefined) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 !== undefined) out.push(((c2 & 3) << 6) | c3);
  }
  return new Uint8Array(out);
}

function utf8ToBytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  return new Uint8Array(out);
}

function bytesToUtf8(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i] & 0x3f));
    else out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
  }
  return out;
}

function randomBytes(n) {
  var bytes = new Uint8Array(n);
  for (var i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function encryptId(id) {
  var key = hexToBytes(KEY_HEX).slice(0, 32);
  var iv = randomBytes(16);
  var plain = utf8ToBytes(String(id));
  var cipher = AES.encryptCBC(plain, key, iv);
  var payload = bytesToHex(iv) + ':' + bytesToHex(cipher);
  return bytesToBase64(utf8ToBytes(payload));
}

function decryptPayload(text) {
  var decoded = bytesToUtf8(base64ToBytes(text));
  var parts = decoded.split(':');
  if (parts.length !== 2) throw new Error('invalid encrypted payload');
  var iv = hexToBytes(parts[0]);
  var cipher = hexToBytes(parts[1]);
  var key = hexToBytes(KEY_HEX).slice(0, 32);
  var plain = AES.decryptCBC(cipher, key, iv);
  return bytesToUtf8(plain);
}

// ─────────────────────────────── HTTP ─────────────────────────────────

function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== 'function') return promise;
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('timeout: ' + label)); }, ms);
    promise.then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); }
    );
  });
}

function httpGet(url, headers) {
  return withTimeout(
    fetch(url, { method: 'GET', headers: headers, redirect: 'follow' }),
    REQUEST_TIMEOUT,
    url
  ).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    return res.text();
  });
}

// ────────────────────────────── Parsing ───────────────────────────────

function parsePlaylist(data, title) {
  var stream = data && data.stream;
  if (!stream || !stream.playlist) return null;
  return {
    name: PROVIDER_NAME,
    title: title,
    url: stream.playlist,
    quality: 'Auto',
    size: 'Unknown',
    headers: WORKING_HEADERS,
    provider: PROVIDER_ID,
  };
}

function buildTitle(tmdbId, mediaType, season, episode) {
  if (mediaType === 'tv' || mediaType === 'series') {
    return 'TMDB ' + tmdbId + ' S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0');
  }
  return 'TMDB ' + tmdbId;
}

// ───────────────────────────── Entry point ────────────────────────────

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;
  var title = buildTitle(tmdbId, type, season, episode);

  return new Promise(function (resolve) {
    var encodedId;
    try {
      encodedId = encryptId(tmdbId);
    } catch (e) {
      log('encrypt failed: ' + e.message);
      return resolve([]);
    }

    var url;
    if (type === 'tv') {
      url = API_URL + '/tv/' + encodedId + '/' + season + '/' + episode;
    } else {
      url = API_URL + '/movie/' + encodedId;
    }

    log('requesting ' + url);

    httpGet(url, WORKING_HEADERS)
      .then(function (encryptedText) {
        var decrypted;
        try {
          decrypted = decryptPayload(encryptedText);
        } catch (e) {
          log('decrypt failed: ' + e.message);
          return resolve([]);
        }
        var data;
        try {
          data = JSON.parse(decrypted);
        } catch (e) {
          log('json parse failed: ' + e.message);
          return resolve([]);
        }
        var stream = parsePlaylist(data, title);
        if (!stream) {
          log('no playlist in response');
          return resolve([]);
        }
        log('stream: ' + stream.url.slice(0, 80) + '...');
        resolve([stream]);
      })
      .catch(function (err) {
        log('error: ' + (err && err.message));
        resolve([]);
      });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
        }
