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

'''

tail = r'''
/* ---------- HLS master parsing ---------- */

'''

flow = r'''
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
