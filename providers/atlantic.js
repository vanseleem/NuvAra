"use strict";

/**
 * Atlantic.st Provider for Nuvio
 * 
 * Works like the other providers (akwam, alooty, etc.)
 * Direct API + AES-GCM decryption
 * No external dependencies
 * 
 * Verified: September 28, 2026
 * Algorithm: 100% Confirmed
 */

var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// Configuration
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const HELIOS_API = "https://stream.hls.lol";
const AES_GCM_KEY_HEX = "117c358bcfcaf8fe2cfca57c9d2238a300e1c4de2efb83a5012ba84d8a31f1dd";

/**
 * Hex string to Uint8Array (for browser/Node.js)
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Decrypt AES-GCM encrypted Helios URL
 * Payload format: IV (12 bytes) + ciphertext + tag
 */
function decryptHeliosUrl(encryptedUrl) {
  return __async(this, null, function* () {
    try {
      // Check if already decrypted
      if (!encryptedUrl.startsWith("hl_")) {
        return encryptedUrl;
      }

      // Strip "hl_" prefix and hex-decode
      const hexPayload = encryptedUrl.slice(3);
      const encryptedBytes = hexToBytes(hexPayload);

      // Validate minimum length (12 IV + 16 tag + at least 1 byte ciphertext)
      if (encryptedBytes.length < 29) {
        throw new Error("Helios payload too short");
      }

      // Extract IV (first 12 bytes) and ciphertext (rest)
      const iv = encryptedBytes.slice(0, 12);
      const ciphertext = encryptedBytes.slice(12);

      // Check if crypto.subtle is available (Node.js 15+, modern browsers, Cloudflare)
      if (typeof crypto === "undefined" || !crypto.subtle) {
        console.error("[Atlantic] crypto.subtle not available. Decryption failed.");
        return encryptedUrl; // Fallback: return as-is
      }

      // Import the decryption key
      const keyBytes = hexToBytes(AES_GCM_KEY_HEX);
      const cryptoKey = yield crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false,
        ["decrypt"]
      );

      // Decrypt using AES-GCM
      const decrypted = yield crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        cryptoKey,
        ciphertext
      );

      // Convert to string
      return new TextDecoder().decode(decrypted);
    } catch (error) {
      console.error("[Atlantic] Decryption error:", error.message);
      throw error;
    }
  });
}

/**
 * Fetch from Helios API
 */
function fetchHelios(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      // Build query parameters
      const params = new URLSearchParams();
      params.set("tmdbId", String(tmdbId));
      params.set("type", mediaType);

      if (mediaType === "tv") {
        params.set("seasonId", String(season || 1));
        params.set("episodeId", String(episode || 1));
      }

      const url = `${HELIOS_API}/helios?${params.toString()}`;
      
      console.log("[Atlantic] Fetching:", url);

      const response = yield fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = yield response.json();
      console.log("[Atlantic] Got response, sources:", Object.keys(data.sources || {}));

      return data.sources || {};
    } catch (error) {
      console.error("[Atlantic] Helios fetch failed:", error.message);
      return {};
    }
  });
}

/**
 * Build stream object
 */
function makeStream(url, server, quality) {
  return {
    name: "Atlantic",
    title: `Atlantic • ${server}`,
    url: url,
    quality: quality || "Auto",
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": "https://atlantic.st/"
    }
  };
}

/**
 * Main getStreams function for Nuvio
 */
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[Atlantic] Request:", {
      tmdbId: tmdbId,
      mediaType: mediaType,
      season: season,
      episode: episode
    });

    // Validate inputs
    if (!tmdbId) {
      console.log("[Atlantic] No TMDB ID");
      return [];
    }

    if (mediaType !== "movie" && mediaType !== "tv") {
      console.log("[Atlantic] Invalid media type:", mediaType);
      return [];
    }

    if (mediaType === "tv" && (!season || !episode)) {
      console.log("[Atlantic] Missing season/episode for TV");
      return [];
    }

    try {
      // Fetch from Helios
      const sources = yield fetchHelios(tmdbId, mediaType, season, episode);

      if (!Object.keys(sources).length) {
        console.log("[Atlantic] No sources found");
        return [];
      }

      // Process sources
      const streams = [];
      const serverOrder = ["Moscow", "Novo", "Omsk"];
      const seen = new Set();

      for (const serverName of serverOrder) {
        const source = sources[serverName];
        if (!source || !source.url) {
          continue;
        }

        try {
          // Decrypt the URL
          const m3u8Url = yield decryptHeliosUrl(source.url);
          
          // Avoid duplicates
          if (seen.has(m3u8Url)) {
            continue;
          }
          seen.add(m3u8Url);

          // Add stream
          streams.push(makeStream(m3u8Url, serverName, source.label || "Auto"));
          console.log(`[Atlantic] Added ${serverName}: ${m3u8Url.substring(0, 80)}...`);
        } catch (decryptError) {
          console.error(`[Atlantic] Failed to decrypt ${serverName}:`, decryptError.message);
          continue;
        }
      }

      console.log("[Atlantic] Total streams:", streams.length);
      return streams;
    } catch (error) {
      console.error("[Atlantic] getStreams error:", error.message);
      return [];
    }
  });
}

// Export for Nuvio
module.exports = {
  getStreams: getStreams
};
