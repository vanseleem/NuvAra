"use strict";

/**
 * Atlantic.st Provider for Nuvio
 * Fixed version - compatible with Hermes
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
 * Hex string to Uint8Array
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
 */
function decryptHeliosUrl(encryptedUrl) {
  return __async(this, null, function* () {
    try {
      // Check if already decrypted
      if (!encryptedUrl.startsWith("hl_")) {
        return encryptedUrl;
      }

      // Crypto.subtle must be available
      if (typeof crypto === "undefined" || !crypto.subtle) {
        throw new Error("crypto.subtle not available in this runtime");
      }

      // Strip "hl_" and hex-decode
      const hexPayload = encryptedUrl.slice(3);
      const encryptedBytes = hexToBytes(hexPayload);

      if (encryptedBytes.length < 29) {
        throw new Error("Payload too short");
      }

      const iv = encryptedBytes.slice(0, 12);
      const ciphertext = encryptedBytes.slice(12);

      // Import key
      const keyBytes = hexToBytes(AES_GCM_KEY_HEX);
      const cryptoKey = yield crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false,
        ["decrypt"]
      );

      // Decrypt
      const decrypted = yield crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        cryptoKey,
        ciphertext
      );

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
      const params = new URLSearchParams();
      params.set("tmdbId", String(tmdbId));
      params.set("type", mediaType);

      if (mediaType === "tv") {
        params.set("seasonId", String(season || 1));
        params.set("episodeId", String(episode || 1));
      }

      const url = `${HELIOS_API}/helios?${params.toString()}`;
      
      console.log("[Atlantic] Fetching:", url);

      // Fetch with timeout - use older pattern for compatibility
      let response;
      try {
        // Try with AbortSignal.timeout if available
        response = yield fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json"
          },
          signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
        });
      } catch (fetchErr) {
        // Fallback without timeout
        response = yield fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json"
          }
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = yield response.json();
      console.log("[Atlantic] Got response, sources:", Object.keys(data.sources || {}));

      return data.sources || {};
    } catch (error) {
      console.error("[Atlantic] Helios fetch failed:", error.message);
      throw error;
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
 * Main getStreams for Nuvio
 */
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[Atlantic] Request:", { tmdbId, mediaType, season, episode });

    if (!tmdbId) return [];
    if (mediaType !== "movie" && mediaType !== "tv") return [];
    if (mediaType === "tv" && (!season || !episode)) return [];

    try {
      // Fetch from Helios
      const sources = yield fetchHelios(tmdbId, mediaType, season, episode);

      if (!Object.keys(sources).length) {
        console.log("[Atlantic] No sources found");
        return [];
      }

      const streams = [];
      const serverOrder = ["Moscow", "Novo", "Omsk"];
      const seen = new Set();

      for (const serverName of serverOrder) {
        const source = sources[serverName];
        if (!source || !source.url) continue;

        try {
          const m3u8Url = yield decryptHeliosUrl(source.url);
          
          if (seen.has(m3u8Url)) continue;
          seen.add(m3u8Url);

          streams.push(makeStream(m3u8Url, serverName, source.label || "Auto"));
          console.log(`[Atlantic] Added ${serverName}`);
        } catch (decryptError) {
          console.error(`[Atlantic] Decrypt ${serverName} failed:`, decryptError.message);
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

module.exports = {
  getStreams: getStreams
};
