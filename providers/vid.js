// VidLink provider (deobfuscated)
// Chain: enc-dec.app relay → vidlink.pro /api/b/{movie|tv}/... → master .m3u8 → variants ≥720p

var VIDLINK_API = "https://vidlink.pro";
var DECRYPT_API = "https://enc-dec.app/api";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Connection": "keep-alive",
  "Referer": "https://vidlink.pro/",
  "Origin": "https://vidlink.pro"
};

// ───────────────────────── Byte helpers ─────────────────────────

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "Unknown";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(2) + " " + units[i];
}

// Estimated size from bitrate × duration, in MB
function calculateCalculatedFallbackSize(quality, duration) {
  var mins = parseInt(duration) || 90;
  var q = String(quality || "").toLowerCase();
  var bitrate = 5200; // kbps default for 1080p
  if (q.includes("4k") || q.includes("2160")) bitrate = 16000;
  else if (q.includes("1080") || q.includes("fhd")) bitrate = 5200;
  else if (q.includes("720") || q.includes("hd")) bitrate = 2500;
  else if (q.includes("480") || q.includes("sd")) bitrate = 1200;

  var factor = 0.94 + (mins % 9) / 100;
  var totalBytes = bitrate * factor * 1000 / 8 * (mins * 60);
  return formatBytes(totalBytes);
}

// ─────────────────────── TMDB (cosmetic only) ───────────────────

function getTmdbMetadata(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    var name = "Unknown Title";
    var duration = mediaType === "tv" ? "45 min" : "90 min";
    try {
      var type = mediaType === "movie" ? "movie" : "tv";
      var mainUrl = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
      var resp = yield fetch(mainUrl);
      if (!resp.ok) return { name: name, year: "N/A", duration: duration };

      var data = yield resp.json();

      if (mediaType === "movie" && data.runtime) {
        duration = data.runtime + " min";
      } else if (mediaType === "tv") {
        var epUrl = "https://api.themoviedb.org/3/tv/" + tmdbId +
                    "/season/" + season + "/episode/" + episode +
                    "?api_key=" + TMDB_API_KEY;
        var epResp = yield fetch(epUrl);
        if (epResp.ok) {
          var ep = yield epResp.json();
          if (ep.runtime) duration = ep.runtime + " min";
          else if (data.episode_run_time && data.episode_run_time.length > 0) {
            duration = data.episode_run_time[0] + " min";
          }
        }
      }
      return {
        name: data.title || data.name || name,
        year: (data.release_date || data.first_air_date || "").split("-")[0] || "N/A",
        duration: duration
      };
    } catch (e) {
      return { name: name, year: "N/A", duration: duration };
    }
  });
}

// ───────────────────── Master M3U8 parser ──────────────────────

function generateM3u8(url, headers) {
  headers = headers || {};
  return __async(this, arguments, function* () {
    try {
      console.log("[Vidlink] Fetching m3u8: " + url);
      var resp = yield fetch(url, { headers: headers });
      var text = yield resp.text();
      var baseUrl = url.substring(0, url.lastIndexOf("/")) + "/";
      var out = [];
      var re = /#EXT-X-STREAM-INF:.*?RESOLUTION=(\d+x\d+).*?\n([^\n]+)/g;
      var m;
      while ((m = re.exec(text)) !== null) {
        var height = parseInt(m[1].split("x")[1], 10);
        if (height < 720) continue;
        var quality = height + "p";
        var u = m[2].trim();
        if (!u.startsWith("http")) {
          if (u.startsWith("/")) {
            u = new URL(url).origin + u;
          } else {
            u = baseUrl + u;
          }
        }
        out.push({ quality: quality, url: u });
      }
      return out;
    } catch (e) {
      console.warn("[Vidlink] Failed to parse m3u8:", e);
      return [];
    }
  });
}

// ─────────────────────────── Entry point ────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[Vidlink] Fetching streams for " + mediaType + " " + tmdbId);
    try {
      // 1. Relay token
      var relayUrl = DECRYPT_API + "/enc-vidlink?text=" + tmdbId;
      var relayResp = yield fetch(relayUrl);
      var relayJson = yield relayResp.json();
      var token = relayJson.result;
      if (!token) {
        console.log("[Vidlink] No encrypted ID");
        return [];
      }

      // 2. Movie vs TV
      var isMovie = mediaType !== "tv" && season == null;
      var type = isMovie ? "movie" : "tv";

      // 3. Metadata
      var meta = yield getTmdbMetadata(tmdbId, type, season, episode);

      // 4. VidLink API
      var apiUrl = isMovie
        ? VIDLINK_API + "/api/b/movie/" + token
        : VIDLINK_API + "/api/b/tv/" + token + "/" + season + "/" + episode;
      console.log("[Vidlink] Fetching playlist from: " + apiUrl);

      var apiResp = yield fetch(apiUrl, { headers: HEADERS });
      var data = yield apiResp.json();
      var playlist = data && data.stream && data.stream.playlist;
      if (!playlist) {
        console.log("[Vidlink] No playlist in response");
        return [];
      }

      var streams = [];

      // 5. Stream builder
      var addStream = function (quality, url) {
        var label = "1080p FHD";
        var shortQ = "1080P";
        var q = String(quality).toLowerCase();

        if (q.includes("2160") || q.includes("4k")) { label = "4K UHD"; shortQ = "2160P"; }
        else if (q.includes("1080")) { label = "1080p FHD"; shortQ = "1080P"; }
        else if (q.includes("720")) { label = "720p HD"; shortQ = "720P"; }
        else if (q.includes("480")) { label = "480p SD"; shortQ = "480P"; }

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
          quality: quality,
          type: "m3u8",
          headers: {
            "User-Agent": HEADERS["User-Agent"],
            "Referer": VIDLINK_API + "/",
            "Origin": VIDLINK_API
          },
          provider: "vidlink"
        });
      };

      // Auto entry uses the master playlist directly
      addStream("Auto", playlist);

      // 6. Per-variant entries
      try {
        var variants = yield generateM3u8(playlist, {
          "Referer": VIDLINK_API + "/",
          "User-Agent": HEADERS["User-Agent"]
        });
        variants.forEach(function (v) {
          addStream(v.quality, v.url);
        });
      } catch (e) {
        console.warn("[Vidlink] Failed to parse m3u8:", playlist);
      }

      console.log("[Vidlink] Found playlist stream");
      return streams.map(function (s) {
        s.quality = getSortedQuality(s.quality);
        return s;
      });
    } catch (e) {
      console.error("[Vidlink] Error: " + e.message);
      return [];
    }
  });
}

// Zero-width prefixes make higher qualities sort first in the app
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

module.exports = { getStreams: getStreams };
