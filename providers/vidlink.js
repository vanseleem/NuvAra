
var PROVIDER_ID = "vidlink";
var PROVIDER_NAME = "VidLink";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_API = "https://vidlink.pro/api/b";
var VIDLINK_REFERER = "https://vidlink.pro";

var FETCH_TIMEOUT_MS = 12000;

function log(m) { console.log("[VidLink] " + m); }

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
  headers = headers || {};
  return withTimeout(
    fetch(url, { method: "GET", headers: headers, redirect: "follow" }).then(function(r) {
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

// ---------------------------------------------------------------- TMDB
function fetchTmdb(tmdbId, type) {
  var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
    "?api_key=" + TMDB_API_KEY + "&language=en";
  return fetchJson(url, { "Accept": "application/json" });
}

// ---------------------------------------------------------------- encryption
function encodeTmdbId(tmdbId) {
  var url = ENC_API + "?text=" + encodeURIComponent(String(tmdbId));
  log("Encoding TMDB ID: " + tmdbId);
  return fetchJson(url, { "Accept": "application/json" }).then(function(data) {
    var result = data && (data.result || data.encoded || data.data);
    if (!result) throw new Error("enc-vidlink returned no result");
    log("Encoded: " + String(result).slice(0, 20) + "...");
    return result;
  });
}

// ---------------------------------------------------------------- quality helpers
function qualityToNumber(q) {
  if (!q) return 0;
  var s = String(q).toLowerCase();
  if (s === "4k" || s === "2160") return 2160;
  if (s === "auto" || s === "unknown") return 0;
  var n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function qualityLabel(q) {
  if (!q) return "Auto";
  var s = String(q).toLowerCase();
  if (s === "4k" || s === "2160") return "4K";
  if (s === "auto" || s === "unknown") return "Auto";
  var n = parseInt(s, 10);
  return isNaN(n) ? String(q) : n + "p";
}

// ---------------------------------------------------------------- stream builder
function buildStreams(qualities, displayTitle) {
  var streams = [];
  Object.keys(qualities || {}).forEach(function(key) {
    var entry = qualities[key];
    if (!entry) return;
    var url = entry.url || entry.playlist || entry.file || entry.src;
    if (!url || url.indexOf("http") !== 0) return;

    var isHls = /\.m3u8/i.test(url);
    var qLabel = qualityLabel(key);
    streams.push({
      name: PROVIDER_NAME + " " + qLabel,
      title: displayTitle + " • " + qLabel,
      url: url,
      quality: qLabel,
      size: "Unknown",
      type: isHls ? "hls" : "mp4",
      headers: {
        "User-Agent": UA,
        "Referer": VIDLINK_REFERER,
        "Origin": VIDLINK_REFERER,
        "Accept": "*/*"
      },
      provider: PROVIDER_ID
    });
  });
  streams.sort(function(a, b) {
    return qualityToNumber(b.quality) - qualityToNumber(a.quality);
  });
  return streams;
}

// ---------------------------------------------------------------- core
function getStreamsFor(tmdbId, mediaType, season, episode) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var displayTitle;
  return fetchTmdb(tmdbId, type).then(function(data) {
    var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
    var year = type === "movie" ? (data.release_date || "") : (data.first_air_date || "");
    if (type === "movie") {
      displayTitle = title + (year ? " (" + year.slice(0, 4) + ")" : "");
    } else {
      var p2 = function(n) { return n < 10 ? "0" + n : String(n); };
      displayTitle = title + " S" + p2(season) + "E" + p2(episode);
    }
    log(type + ' "' + title + '"');
  }).catch(function() {
    displayTitle = type === "movie" ? ("TMDB " + tmdbId) : ("TMDB " + tmdbId + " S" + season + "E" + episode);
  }).then(function() {
    return encodeTmdbId(tmdbId);
  }).then(function(encodedId) {
    var url;
    if (type === "movie") {
      url = VIDLINK_API + "/movie/" + encodeURIComponent(encodedId) + "?multiLang=0";
    } else {
      url = VIDLINK_API + "/tv/" + encodeURIComponent(encodedId) + "/" +
        encodeURIComponent(season) + "/" + encodeURIComponent(episode) + "?multiLang=0";
    }
    log("API: " + url.split("?")[0]);

    return fetchJson(url, {
      "User-Agent": UA,
      "Referer": VIDLINK_REFERER,
      "Accept": "application/json, text/plain, */*"
    }).then(function(data) {
      var stream = data && data.stream;
      if (!stream) {
        log("No stream object in response");
        return [];
      }
      var qualities = stream.qualities;
      if (!qualities) {
        // legacy fallback — old API returned stream.playlist
        if (stream.playlist) {
          log("Legacy playlist format detected");
          return buildStreams({ "auto": { url: stream.playlist } }, displayTitle);
        }
        log("No qualities in stream");
        return [];
      }
      var streams = buildStreams(qualities, displayTitle);
      log("Returned " + streams.length + " stream(s)");
      return streams;
    });
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
    return [];
  });
}

module.exports = { getStreams: getStreams };
