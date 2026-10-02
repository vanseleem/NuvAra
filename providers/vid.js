// VidLink provider for Nuvio (Corrected for new API format & Promise-only runtime)
var VIDLINK_API = "https://vidlink.pro";
var DECRYPT_API = "https://enc-dec.app/api";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc"; // Your TMDB key

var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Connection": "keep-alive",
  "Referer": VIDLINK_API + "/",
  "Origin": VIDLINK_API
};

// --- Helper: Format bytes (kept from original) ---
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "Unknown";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(2) + " " + units[i];
}

// --- Helper: Estimate size (kept from original) ---
function calculateCalculatedFallbackSize(quality, duration) {
  var mins = parseInt(duration) || 90;
  var q = String(quality || "").toLowerCase();
  var bitrate = 5200;
  if (q.includes("4k") || q.includes("2160")) bitrate = 16000;
  else if (q.includes("1080") || q.includes("fhd")) bitrate = 5200;
  else if (q.includes("720") || q.includes("hd")) bitrate = 2500;
  else if (q.includes("480") || q.includes("sd")) bitrate = 1200;

  var factor = 0.94 + (mins % 9) / 100;
  var totalBytes = bitrate * factor * 1000 / 8 * (mins * 60);
  return formatBytes(totalBytes);
}

// --- Helper: TMDB Metadata (Promise-only) ---
function getTmdbMetadata(tmdbId, mediaType, season, episode) {
  var name = "Unknown Title";
  var duration = mediaType === "tv" ? "45 min" : "90 min";
  var type = mediaType === "movie" ? "movie" : "tv";
  var mainUrl = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;

  return fetch(mainUrl)
    .then(function(resp) {
      if (!resp.ok) return { name: name, year: "N/A", duration: duration };
      return resp.json().then(function(data) {
        if (mediaType === "movie" && data.runtime) {
          duration = data.runtime + " min";
          return { name: data.title || name, year: (data.release_date || "").split("-")[0] || "N/A", duration: duration };
        } else if (mediaType === "tv") {
          var epUrl = "https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + season + "/episode/" + episode + "?api_key=" + TMDB_API_KEY;
          return fetch(epUrl).then(function(epResp) {
            if (epResp.ok) {
              return epResp.json().then(function(ep) {
                if (ep.runtime) duration = ep.runtime + " min";
                else if (data.episode_run_time && data.episode_run_time.length > 0) duration = data.episode_run_time[0] + " min";
                return { name: data.name || name, year: (data.first_air_date || "").split("-")[0] || "N/A", duration: duration };
              });
            }
            return { name: data.name || name, year: (data.first_air_date || "").split("-")[0] || "N/A", duration: duration };
          }).catch(function() {
            return { name: data.name || name, year: (data.first_air_date || "").split("-")[0] || "N/A", duration: duration };
          });
        }
        return { name: data.title || data.name || name, year: (data.release_date || data.first_air_date || "").split("-")[0] || "N/A", duration: duration };
      });
    }).catch(function() {
      return { name: name, year: "N/A", duration: duration };
    });
}

// --- Helper: Sort quality (kept from original) ---
function getSortedQuality(q) {
  if (!q) return "Auto";
  var s = q.toLowerCase();
  if (s.includes("auto")) return "Auto";
  if (s.includes("2160") || s.includes("4k") || s.includes("uhd")) return "\u200b" + q;
  if (s.includes("1080") || s.includes("fhd")) return "\u200b\u200b" + q;
  if (s.includes("720") || s.includes("hd")) return "\u200b\u200b\u200b" + q;
  if (s.includes("480") || s.includes("sd")) return "\u200b\u200b\u200b\u200b" + q;
  if (s.includes("360")) return "\u200b\u200b\u200b\u200b\u200b" + q;
  return "\u200b\u200b\u200b\u200b" + q;
}

// --- Main Entry Point (Promise-only) ---
function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[Vidlink] Fetching streams for " + mediaType + " " + tmdbId);

  var isMovie = mediaType !== "tv" && season == null;
  var relayUrl = DECRYPT_API + "/enc-vidlink?text=" + tmdbId;

  return fetch(relayUrl)
    .then(function(resp) { return resp.json(); })
    .then(function(relayJson) {
      var token = relayJson.result;
      if (!token) {
        console.log("[Vidlink] No encrypted ID");
        return [];
      }
      var type = isMovie ? "movie" : "tv";
      return Promise.all([
        getTmdbMetadata(tmdbId, type, season, episode),
        fetch(isMovie ? VIDLINK_API + "/api/b/movie/" + token : VIDLINK_API + "/api/b/tv/" + token + "/" + season + "/" + episode, { headers: HEADERS })
          .then(function(resp) { return resp.json(); })
      ]);
    })
    .then(function(results) {
      var meta = results[0];
      var data = results[1];

      // --- NEW PARSER for stream.qualities ---
      var qualities = data && data.stream && data.stream.qualities;
      if (!qualities) {
        console.log("[Vidlink] No qualities in response");
        return [];
      }

      var streams = [];
      var qualityKeys = Object.keys(qualities);

      qualityKeys.forEach(function (q) {
        var url = qualities[q];
        if (!url || typeof url !== 'string') return;

        var label = "1080p FHD";
        var shortQ = "1080P";
        var lowerQ = q.toLowerCase();

        if (lowerQ.includes("2160") || lowerQ.includes("4k")) { label = "4K UHD"; shortQ = "2160P"; }
        else if (lowerQ.includes("1080")) { label = "1080p FHD"; shortQ = "1080P"; }
        else if (lowerQ.includes("720")) { label = "720p HD"; shortQ = "720P"; }
        else if (lowerQ.includes("480")) { label = "480p SD"; shortQ = "480P"; }

        var size = calculateCalculatedFallbackSize(shortQ, meta.duration);
        var shown = meta.name + (!isMovie ? " S" + season + "E" + episode : "");
        var name = "VidLink | " + label + " | Main Mirror";
        var title = "\uD83C\uDFAC " + shown + " - " + meta.year +
                    "\n\u26A1 " + shortQ + " | \uD83C\uDF0D Original" +
                    "\n\uD83C\uDF9E M3U8 | \u23F1 " + meta.duration + " | \uD83D\uDCCC Main Mirror";

        streams.push({
          name: name,
          title: title,
          url: url,
          quality: getSortedQuality(q), // Pass the original quality key for sorting
          type: "m3u8",
          headers: {
            "User-Agent": HEADERS["User-Agent"],
            "Referer": VIDLINK_API + "/",
            "Origin": VIDLINK_API
          },
          provider: "vidlink"
        });
      });

      console.log("[Vidlink] Found " + streams.length + " stream(s)");
      return streams;
    })
    .catch(function(err) {
      console.log("[Vidlink] Error: " + err.message);
      return [];
    });
}

module.exports = { getStreams: getStreams };
