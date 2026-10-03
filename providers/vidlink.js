var PROVIDER_ID = "vidlink";
var PROVIDER_NAME = "VidLink";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_API = "https://vidlink.pro/api/b";
var VIDLINK_BASE = "https://vidlink.pro";

// Sent on the VidLink API call. Without it the API returns bcdn MP4s that answer 429 to non-browser clients.
var PLAYBACK_ENV = "webkit";

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

// Stream type: trust the response's own "type" first.
function detectType(declared, url) {
  var d = String(declared || "").toLowerCase();
  if (d.indexOf("dash") !== -1 || d.indexOf("mpd") !== -1) return "dash";
  if (d.indexOf("hls") !== -1 || d.indexOf("m3u8") !== -1) return "hls";
  if (d.indexOf("mp4") !== -1) return "mp4";
  if (/\.mpd(\?|#|$)/i.test(url)) return "dash";
  if (/\.mp4(\?|#|$)/i.test(url)) return "mp4";
  return "hls";
}

// ---------------------------------------------------------------- DASH MPD splitting

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function base64Encode(str) {
  if (typeof btoa === "function") {
    return btoa(unescape(encodeURIComponent(str)));
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64");
  }
  throw new Error("no base64 encoder available");
}

// Work out what <BaseURL> to inject. If the original MPD had one, resolve it
// against the MPD URL to make it absolute. Otherwise use the MPD's own directory.
function resolveBaseUrl(mpdText, mpdUrl) {
  var m = mpdText.match(/<BaseURL>([^<]+)<\/BaseURL>/);
  if (m) {
    var b = m[1].trim();
    if (/^https?:\/\//i.test(b)) return b;
    if (b.charAt(b.length - 1) !== "/") b += "/";
    return new URL(b, mpdUrl).href;
  }
  return mpdUrl.substring(0, mpdUrl.lastIndexOf("/") + 1);
}

// Strip all <BaseURL> elements anywhere in the MPD so we can put our own back
// at the top level.
function stripBaseUrls(mpdText) {
  return mpdText.replace(/<BaseURL>[^<]*<\/BaseURL>/g, "");
}

function injectBaseUrl(mpdText, baseUrl) {
  // Insert right after the opening <MPD ...> tag, so it applies to all Periods.
  return mpdText.replace(/(<MPD\b[^>]*>)/, "$1\n  <BaseURL>" + baseUrl + "</BaseURL>");
}

// Return a copy of the MPD that contains only the given video Representation id,
// plus every non-video AdaptationSet unchanged.
function buildFilteredMpd(mpdText, keepRepId) {
  return mpdText.replace(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/g, function(asBlock) {
    var isVideo =
      /mimeType="video\//.test(asBlock) ||
      /contentType="video"/.test(asBlock);
    if (!isVideo) return asBlock;

    var hasClosingForm = /<Representation\b[^>]*>[\s\S]*?<\/Representation>/.test(asBlock);
    var repPattern = hasClosingForm
      ? /<Representation\b[^>]*>[\s\S]*?<\/Representation>/g
      : /<Representation\b[^>]*\/>/g;

    // Remove every video representation.
    var withoutReps = asBlock.replace(repPattern, "");

    // Put back the one we want.
    var idPattern = escapeRegex(keepRepId);
    var keepRe = new RegExp(
      '<Representation\\b[^>]*\\bid="' + idPattern + '"[^>]*>[\\s\\S]*?<\\/Representation>' +
      '|<Representation\\b[^>]*\\bid="' + idPattern + '"[^>]*\\/>'
    );
    var keepMatch = asBlock.match(keepRe);
    if (!keepMatch) return asBlock;

    return withoutReps.replace(
      /<\/AdaptationSet>/,
      "  " + keepMatch[0] + "\n</AdaptationSet>"
    );
  });
}

// Parse the MPD and return one entry per video representation.
// Each entry has an absolute BaseURL injected and is returned as a data: URL.
function splitDashMpd(mpdText, mpdUrl) {
  var baseUrl = resolveBaseUrl(mpdText, mpdUrl);
  var cleaned = stripBaseUrls(mpdText);
  cleaned = injectBaseUrl(cleaned, baseUrl);

  var results = [];
  var adaptationSets = cleaned.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/g) || [];

  adaptationSets.forEach(function(asBlock) {
    var isVideo =
      /mimeType="video\//.test(asBlock) ||
      /contentType="video"/.test(asBlock);
    if (!isVideo) return;

    var reps = asBlock.match(/<Representation\b[^>]*>[\s\S]*?<\/Representation>/g) || [];
    if (!reps.length) {
      reps = asBlock.match(/<Representation\b[^>]*\/>/g) || [];
    }

    reps.forEach(function(repBlock) {
      var idMatch = repBlock.match(/\bid="([^"]+)"/);
      if (!idMatch) return;
      var repId = idMatch[1];

      var hMatch = repBlock.match(/\bheight="([^"]+)"/);
      var wMatch = repBlock.match(/\bwidth="([^"]+)"/);
      var bMatch = repBlock.match(/\bbandwidth="([^"]+)"/);

      var height = hMatch ? parseInt(hMatch[1], 10) : 0;
      var width = wMatch ? parseInt(wMatch[1], 10) : 0;
      var bw = bMatch ? parseInt(bMatch[1], 10) : 0;

      var label = height ? (height + "p")
                 : width ? (width + "p")
                 : "Auto";

      var filtered = buildFilteredMpd(cleaned, repId);
      var dataUrl = "data:application/dash+xml;base64," + base64Encode(filtered);

      results.push({
        repId: repId,
        quality: label,
        height: height,
        width: width,
        bandwidth: bw,
        url: dataUrl
      });
    });
  });

  // De-dupe identical labels in case of odd MPDs.
  var seen = {};
  return results.filter(function(r) {
    if (seen[r.quality]) return false;
    seen[r.quality] = true;
    return true;
  });
}

// ---------------------------------------------------------------- stream builder
function buildStreams(qualities, displayTitle, embedPageUrl, signedHeaders) {
  var streams = [];
  var browserHeaders = {
    "User-Agent": UA,
    "Referer": embedPageUrl,
    "Origin": VIDLINK_BASE,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin"
  };

  var streamHeaders = browserHeaders;
  if (signedHeaders && typeof signedHeaders === "object" && Object.keys(signedHeaders).length) {
    streamHeaders = { "User-Agent": UA };
    Object.keys(signedHeaders).forEach(function(k) { streamHeaders[k] = signedHeaders[k]; });
  }

  Object.keys(qualities || {}).forEach(function(key) {
    var entry = qualities[key];
    if (!entry) return;
    var url = entry.url || entry.playlist || entry.file || entry.src;
    if (!url) return;
    if (url.indexOf("http") !== 0 && url.indexOf("data:") !== 0) return;

    var kind = detectType(entry.type, url);
    var qLabel = qualityLabel(key);
    log("  quality " + qLabel + " [" + kind + "] -> " + url.slice(0, 100) + "...");

    streams.push({
      name: PROVIDER_NAME + " " + qLabel,
      title: displayTitle + " • " + qLabel,
      url: url,
      quality: qLabel,
      size: "Unknown",
      type: kind,
      headers: streamHeaders,
      provider: PROVIDER_ID
    });
  });

  streams.sort(function(a, b) {
    return qualityToNumber(b.quality) - qualityToNumber(a.quality);
  });
  return streams;
}

// ---------------------------------------------------------------- DASH path
function buildDashStreams(mpdUrl, displayTitle, embedPageUrl, signedHeaders) {
  var fetchHeaders = { "User-Agent": UA };
  if (signedHeaders && typeof signedHeaders === "object") {
    Object.keys(signedHeaders).forEach(function(k) {
      fetchHeaders[k] = signedHeaders[k];
    });
  }

  return fetchText(mpdUrl, fetchHeaders).then(function(mpdText) {
    var parts = splitDashMpd(mpdText, mpdUrl);
    log("Parsed MPD: " + parts.length + " video representation(s)");

    var streamHeaders = { "User-Agent": UA };
    if (signedHeaders && typeof signedHeaders === "object") {
      Object.keys(signedHeaders).forEach(function(k) {
        streamHeaders[k] = signedHeaders[k];
      });
    }

    var streams = [];

    // Always include the original MPD first as a fallback "Auto (all qualities)".
    streams.push({
      name: PROVIDER_NAME + " Auto",
      title: displayTitle + " • Auto (all qualities)",
      url: mpdUrl,
      quality: "Auto",
      size: "Unknown",
      type: "dash",
      headers: streamHeaders,
      provider: PROVIDER_ID
    });

    parts.forEach(function(part) {
      streams.push({
        name: PROVIDER_NAME + " " + part.quality,
        title: displayTitle + " • " + part.quality,
        url: part.url,
        quality: part.quality,
        size: "Unknown",
        type: "dash",
        headers: streamHeaders,
        provider: PROVIDER_ID
      });
    });

    // Sort so 1080p is at the top and "Auto" (numeric 0) is at the bottom.
    streams.sort(function(a, b) {
      return qualityToNumber(b.quality) - qualityToNumber(a.quality);
    });

    log("Returned " + streams.length + " DASH stream(s)");
    return streams;
  }).catch(function(e) {
    log("DASH split failed (" + (e && e.message) + ") — falling back to single MPD entry");
    return buildStreams(
      { "auto": { url: mpdUrl, type: "dash" } },
      displayTitle, embedPageUrl, signedHeaders
    );
  });
}

// ---------------------------------------------------------------- core
function getStreamsFor(tmdbId, mediaType, season, episode) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var displayTitle;
  var embedPageUrl;

  if (type === "movie") {
    embedPageUrl = VIDLINK_BASE + "/movie/" + tmdbId;
  } else {
    embedPageUrl = VIDLINK_BASE + "/tv/" + tmdbId + "/" + season + "/" + episode;
  }

  return fetchTmdb(tmdbId, type).then(function(data) {
    var title = type === "movie"
      ? (data.title || data.original_title)
      : (data.name || data.original_name);
    var year = type === "movie" ? (data.release_date || "") : (data.first_air_date || "");
    if (type === "movie") {
      displayTitle = title + (year ? " (" + year.slice(0, 4) + ")" : "");
    } else {
      var p2 = function(n) { return n < 10 ? "0" + n : String(n); };
      displayTitle = title + " S" + p2(season) + "E" + p2(episode);
    }
    log(type + ' "' + title + '" — Referer will be: ' + embedPageUrl);
  }).catch(function() {
    displayTitle = type === "movie"
      ? ("TMDB " + tmdbId)
      : ("TMDB " + tmdbId + " S" + season + "E" + episode);
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
      "Referer": embedPageUrl,
      "Origin": VIDLINK_BASE,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "x-playback-environment": PLAYBACK_ENV
    }).then(function(data) {
      var stream = data && data.stream;
      if (!stream) {
        log("No stream object in response");
        return [];
      }
      log("deliveryType: " + stream.deliveryType);

      var qualities = stream.qualities;
      if (qualities) {
        var s = buildStreams(qualities, displayTitle, embedPageUrl, stream.playlistHeaders);
        log("Returned " + s.length + " stream(s) from qualities");
        return s;
      }

      if (stream.playlist) {
        var kind = detectType(stream.type, stream.playlist);
        log("Playlist format detected (type: " + stream.type + " -> " + kind + ")");

        if (kind === "dash") {
          return buildDashStreams(stream.playlist, displayTitle, embedPageUrl, stream.playlistHeaders);
        }

        return buildStreams(
          { "auto": { url: stream.playlist, type: stream.type } },
          displayTitle, embedPageUrl, stream.playlistHeaders
        );
      }

      log("No qualities or playlist in stream");
      return [];
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
