"use strict";

// ===== CONFIG =====
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
var ATLANTIC_BASE = "https://atlantic.st";
var REQUEST_TIMEOUT_MS = 12000;
var MAX_RETRIES = 1;
var RETRY_DELAY_MS = 600;
var CACHE_TTL_MS = 3 * 60 * 1000;
var FAIL_CACHE_TTL_MS = 60 * 1000;
var PREFERRED_SERVERS = ["Moscow", "Novo", "Omsk"];

var cache = {};
var inflight = {};

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  return null;
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function withTimeout(promise, ms) {
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() { reject(new Error("Timeout after " + ms + "ms")); }, ms);
    promise.then(
      function(v) { clearTimeout(timer); resolve(v); },
      function(e) { clearTimeout(timer); reject(e); }
    );
  });
}

function fetchAtlanticStreams(tmdbId, mediaType, season, episode, attempt) {
  attempt = attempt || 0;
  var query = "tmdbId=" + encodeURIComponent(String(tmdbId)) + "&type=" + encodeURIComponent(mediaType);
  if (mediaType === "tv") {
    query += "&season=" + encodeURIComponent(String(season || 1)) + "&episode=" + encodeURIComponent(String(episode || 1));
  }
  var fullUrl = ATLANTIC_BASE + "/api/get-streams?" + query;
  console.log("[Atlantic] Fetching streams:", fullUrl, "attempt", attempt);

  return withTimeout(fetch(fullUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": ATLANTIC_BASE + "/",
      "Origin": ATLANTIC_BASE
    }
  }), REQUEST_TIMEOUT_MS)
    .then(function(response) {
      if (!response.ok) {
        var httpErr = new Error("HTTP " + response.status);
        httpErr.status = response.status;
        throw httpErr;
      }
      return response.text();
    })
    .then(function(text) {
      try {
        return JSON.parse(text) || {};
      } catch (e) {
        var parseErr = new Error("Non-JSON response: " + String(text).slice(0, 120));
        parseErr.noRetry = true;
        throw parseErr;
      }
    })
    .catch(function(err) {
      var retryable = !err.noRetry && (!err.status || err.status >= 500);
      if (retryable && attempt < MAX_RETRIES) {
        return delay(RETRY_DELAY_MS).then(function() {
          return fetchAtlanticStreams(tmdbId, mediaType, season, episode, attempt + 1);
        });
      }
      throw err;
    });
}

function makeStream(url, server, label) {
  var quality = qualityFromUrl(url) || (label && label !== "Auto" ? label : null) || "Auto";
  return {
    name: "🌊 Atlantic",
    title: "🌊 Atlantic • " + server + " • " + quality,
    url: url,
    quality: quality,
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": ATLANTIC_BASE + "/",
      "Origin": ATLANTIC_BASE
    }
  };
}

function buildStreams(sources) {
  var keys = Object.keys(sources || {});
  var names = PREFERRED_SERVERS.filter(function(n) { return keys.indexOf(n) !== -1; })
    .concat(keys.filter(function(k) { return PREFERRED_SERVERS.indexOf(k) === -1; }));

  var seen = {};
  var streams = [];
  names.forEach(function(serverName) {
    var source = sources[serverName];
    if (!source || typeof source.url !== "string" || !source.url) return;
    if (seen[source.url]) return;
    seen[source.url] = true;
    streams.push(makeStream(source.url, serverName, source.label || null));
  });
  return streams;
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[Atlantic] Request:", tmdbId, mediaType, season, episode);
  if (!tmdbId || (mediaType !== "movie" && mediaType !== "tv")) return Promise.resolve([]);
  if (mediaType === "tv" && (!season || !episode)) return Promise.resolve([]);

  var key = mediaType + ":" + tmdbId + ":" + (season || 0) + ":" + (episode || 0);
  var hit = cache[key];
  if (hit && hit.expires > Date.now()) {
    console.log("[Atlantic] Cache hit:", key);
    return Promise.resolve(hit.streams);
  }
  if (inflight[key]) return inflight[key];

  inflight[key] = fetchAtlanticStreams(tmdbId, mediaType, season, episode)
    .then(function(sources) {
      var streams = buildStreams(sources);
      console.log("[Atlantic] Total streams:", streams.length);
      cache[key] = { streams: streams, expires: Date.now() + (streams.length ? CACHE_TTL_MS : FAIL_CACHE_TTL_MS) };
      return streams;
    })
    .catch(function(error) {
      console.error("[Atlantic] getStreams error:", error.message);
      cache[key] = { streams: [], expires: Date.now() + FAIL_CACHE_TTL_MS };
      return [];
    })
    .then(function(streams) {
      delete inflight[key];
      return streams;
    });

  return inflight[key];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
