"use strict";

// --- Configuration (unchanged) ---
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
var HELIOS_API = "https://stream.hls.lol";
var AES_GCM_KEY_HEX = "117c358bcfcaf8fe2cfca57c9d2238a300e1c4de2efb83a5012ba84d8a31f1dd";

// --- Helper: Hex to Uint8Array (unchanged) ---
function hexToBytes(hex) {
  var bytes = new Uint8Array(hex.length / 2);
  for (var i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// --- Decryption (Promise-based, no async/await) ---
function decryptHeliosUrl(encryptedUrl) {
  return new Promise(function(resolve, reject) {
    if (!encryptedUrl.startsWith("hl_")) {
      resolve(encryptedUrl);
      return;
    }
    var hexPayload = encryptedUrl.slice(3);
    var encryptedBytes = hexToBytes(hexPayload);
    if (encryptedBytes.length < 29) {
      reject(new Error("Helios payload too short"));
      return;
    }
    var iv = encryptedBytes.slice(0, 12);
    var ciphertext = encryptedBytes.slice(12);
    if (typeof crypto === "undefined" || !crypto.subtle) {
      // Fallback: cannot decrypt
      console.warn("[Atlantic] crypto.subtle unavailable, returning encrypted URL.");
      resolve(encryptedUrl);
      return;
    }
    var keyBytes = hexToBytes(AES_GCM_KEY_HEX);
    crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"])
      .then(function(cryptoKey) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, cryptoKey, ciphertext);
      })
      .then(function(decrypted) {
        resolve(new TextDecoder().decode(decrypted));
      })
      .catch(function(err) {
        console.error("[Atlantic] Decryption error:", err.message);
        reject(err);
      });
  });
}

// --- Fetch Helios (Promise-based, no async/await) ---
function fetchHelios(tmdbId, mediaType, season, episode) {
  return new Promise(function(resolve, reject) {
    var params = new URLSearchParams();
    params.set("tmdbId", String(tmdbId));
    params.set("type", mediaType);
    if (mediaType === "tv") {
      params.set("seasonId", String(season || 1));
      params.set("episodeId", String(episode || 1));
    }
    var url = HELIOS_API + "/helios?" + params.toString();
    console.log("[Atlantic] Fetching:", url);

    var fetchOptions = {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json"
      }
    };
    // Safely add timeout if AbortSignal.timeout exists
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      fetchOptions.signal = AbortSignal.timeout(10000);
    }

    fetch(url, fetchOptions)
      .then(function(response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function(data) {
        resolve(data.sources || {});
      })
      .catch(function(error) {
        console.error("[Atlantic] Helios fetch failed:", error.message);
        reject(error);
      });
  });
}

// --- Stream Object Builder (unchanged) ---
function makeStream(url, server, quality) {
  return {
    name: "Atlantic",
    title: "Atlantic • " + server,
    url: url,
    quality: quality || "Auto",
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": "https://atlantic.st/"
    }
  };
}

// --- Main getStreams (Promise-based) ---
function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function(resolve, reject) {
    console.log("[Atlantic] Request:", tmdbId, mediaType, season, episode);

    if (!tmdbId || (mediaType !== "movie" && mediaType !== "tv")) {
      resolve([]);
      return;
    }
    if (mediaType === "tv" && (!season || !episode)) {
      resolve([]);
      return;
    }

    fetchHelios(tmdbId, mediaType, season, episode)
      .then(function(sources) {
        var keys = Object.keys(sources);
        if (keys.length === 0) {
          console.log("[Atlantic] No sources found.");
          return [];
        }
        var serverOrder = ["Moscow", "Novo", "Omsk"];
        var seen = {};
        var streamPromises = serverOrder.map(function(serverName) {
          var source = sources[serverName];
          if (!source || !source.url) return Promise.resolve(null);
          return decryptHeliosUrl(source.url)
            .then(function(m3u8Url) {
              if (seen[m3u8Url]) return null;
              seen[m3u8Url] = true;
              return makeStream(m3u8Url, serverName, source.label || "Auto");
            })
            .catch(function(err) {
              console.error("[Atlantic] Failed to decrypt " + serverName + ":", err.message);
              return null;
            });
        });
        return Promise.all(streamPromises);
      })
      .then(function(results) {
        var streams = results.filter(function(s) { return s !== null; });
        console.log("[Atlantic] Total streams:", streams.length);
        resolve(streams);
      })
      .catch(function(error) {
        console.error("[Atlantic] getStreams error:", error.message);
        resolve([]); // Resolve with empty array on failure
      });
  });
}

// --- Export for Nuvio ---
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
