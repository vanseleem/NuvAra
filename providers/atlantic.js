"use strict";

var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
var ATLANTIC_BASE = "https://atlantic.st";
var TMDB_API = "https://api.themoviedb.org/3";
var TMDB_KEY = "83d364331c40bfbe29858aeed82f45cc";

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

function searchTMDB(title, mediaType, year) {
  return new Promise(function(resolve, reject) {
    var endpoint = mediaType === "tv" ? "search/tv" : "search/movie";
    var tmdbUrl = TMDB_API + "/" + endpoint + "?query=" + encodeURIComponent(title) + "&api_key=" + TMDB_KEY;
    if (year) {
      tmdbUrl += "&year=" + year;
    }
    
    console.log("[Atlantic] TMDB Search:", tmdbUrl);
    
    var fetchOptions = {
      headers: {
        "Accept": "application/json"
      }
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      fetchOptions.signal = AbortSignal.timeout(8000);
    }
    
    fetch(tmdbUrl, fetchOptions)
      .then(function(response) {
        if (!response.ok) throw new Error("TMDB HTTP " + response.status);
        return response.json();
      })
      .then(function(data) {
        if (!data.results || data.results.length === 0) {
          reject(new Error("No TMDB results"));
          return;
        }
        resolve(data.results[0]);
      })
      .catch(function(err) {
        console.error("[Atlantic] TMDB search failed:", err.message);
        reject(err);
      });
  });
}

function fetchAtlanticStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function(resolve, reject) {
    var streamUrl = ATLANTIC_BASE + "/api/get-streams";
    var params = new URLSearchParams();
    params.set("tmdbId", String(tmdbId));
    params.set("type", mediaType);
    if (mediaType === "tv") {
      params.set("season", String(season || 1));
      params.set("episode", String(episode || 1));
    }
    
    var fullUrl = streamUrl + "?" + params.toString();
    console.log("[Atlantic] Fetching streams:", fullUrl);
    
    var fetchOptions = {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Referer": ATLANTIC_BASE + "/"
      }
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      fetchOptions.signal = AbortSignal.timeout(12000);
    }
    
    fetch(fullUrl, fetchOptions)
      .then(function(response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function(data) {
        resolve(data || {});
      })
      .catch(function(err) {
        console.error("[Atlantic] Stream fetch failed:", err.message);
        reject(err);
      });
  });
}

function makeStream(url, server, label) {
  var quality = qualityFromUrl(url) || (label && label !== "Auto" ? label : null) || "Auto";
  return {
    name: "✨ Atlantic",
    title: "✨ Atlantic • " + server + " • " + quality,
    url: url,
    quality: quality,
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": ATLANTIC_BASE + "/"
    }
  };
}

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
    
    fetchAtlanticStreams(tmdbId, mediaType, season, episode)
      .then(function(sources) {
        var keys = Object.keys(sources);
        if (keys.length === 0) {
          console.log("[Atlantic] No sources found.");
          return [];
        }
        
        var serverOrder = ["Moscow", "Novo", "Omsk"];
        var seen = {};
        var streams = [];
        
        serverOrder.forEach(function(serverName) {
          var source = sources[serverName];
          if (!source || !source.url) return;
          
          var m3u8Url = source.url;
          if (seen[m3u8Url]) return;
          seen[m3u8Url] = true;
          
          var stream = makeStream(m3u8Url, serverName, source.label || null);
          streams.push(stream);
        });
        
        console.log("[Atlantic] Total streams:", streams.length);
        return streams;
      })
      .then(function(streams) {
        resolve(streams);
      })
      .catch(function(error) {
        console.error("[Atlantic] getStreams error:", error.message);
        resolve([]);
      });
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
