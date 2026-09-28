var WORKER_URL = "https://test.vanseleem.workers.dev";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";

// Cache for IMDb IDs and final stream URLs
var _cache = { ttl: 30 * 60 * 1000, imdb: {}, streams: {} };

function getImdbId(tmdbId, mediaType) {
  var key = tmdbId + "|" + mediaType;
  if (_cache.imdb[key]) return Promise.resolve(_cache.imdb[key]);
  var type = mediaType === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "/external_ids?api_key=" + TMDB_API_KEY;
  return fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.imdb_id) {
        _cache.imdb[key] = data.imdb_id;
        console.log("[VidSrc] TMDB " + tmdbId + " -> " + data.imdb_id);
        return data.imdb_id;
      }
      console.log("[VidSrc] No IMDb ID for TMDB " + tmdbId);
      return null;
    })
    .catch(function() { return null; });
}

function fetchViaWorker(targetUrl) {
  var url = WORKER_URL + "?url=" + encodeURIComponent(targetUrl);
  return fetch(url, { headers: { "User-Agent": UA } })
    .then(function(r) {
      if (!r.ok) throw new Error("Worker HTTP " + r.status);
      return r.text();
    });
}

// Step 1: Fetch embed page, extract RCP iframe URL
function getRcpUrl(embedUrl) {
  return fetchViaWorker(embedUrl).then(function(html) {
    var m = html.match(/<iframe[^>]*src=["']([^"']*cloudnestra\.com\/rcp\/[^"']+)["']/i);
    if (!m) {
      console.log("[VidSrc] No RCP iframe found in embed page");
      throw new Error("No RCP iframe");
    }
    var rcpUrl = m[1];
    if (rcpUrl.indexOf("//") === 0) rcpUrl = "https:" + rcpUrl;
    console.log("[VidSrc] RCP URL: " + rcpUrl);
    return rcpUrl;
  });
}

// Step 2: Fetch RCP page, extract prorcp hash
function getProrcpUrl(rcpUrl) {
  return fetchViaWorker(rcpUrl).then(function(html) {
    var m = html.match(/<iframe[^>]*src=["']([^"']*cloudnestra\.com\/prorcp\/[^"']+)["']/i);
    if (!m) {
      console.log("[VidSrc] No prorcp iframe found in RCP page");
      throw new Error("No prorcp iframe");
    }
    var prorcpUrl = m[1];
    if (prorcpUrl.indexOf("//") === 0) prorcpUrl = "https:" + prorcpUrl;
    console.log("[VidSrc] prorcp URL: " + prorcpUrl);
    return prorcpUrl;
  });
}

// Step 3: Fetch prorcp page, extract M3U8 URL
function getM3u8Url(prorcpUrl) {
  return fetchViaWorker(prorcpUrl).then(function(html) {
    var m = html.match(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/i);
    if (!m) {
      console.log("[VidSrc] No M3U8 URL found in prorcp page");
      throw new Error("No M3U8 URL");
    }
    var m3u8 = m[1].replace(/\\\//g, "/");
    console.log("[VidSrc] M3U8 URL: " + m3u8);
    return m3u8;
  });
}

// Main stream extraction pipeline
function getStreamsFromIds(imdbId, tmdbId, mediaType, season, episode) {
  var embedUrl;
  if (mediaType === "tv") {
    // vidsrc.to uses /embed/tv/{imdb}/{season}/{episode}
    embedUrl = "https://vidsrc.to/embed/tv/" + imdbId + "/" + season + "/" + episode;
  } else {
    embedUrl = "https://vidsrc.to/embed/movie/" + imdbId;
  }
  console.log("[VidSrc] embed: " + embedUrl);

  return getRcpUrl(embedUrl)
    .then(function(rcpUrl) { return getProrcpUrl(rcpUrl); })
    .then(function(prorcpUrl) { return getM3u8Url(prorcpUrl); })
    .then(function(m3u8) {
      // Cache the result for 30 minutes
      var cacheKey = imdbId + "|" + mediaType + "|" + (season || "") + "|" + (episode || "");
      _cache.streams[cacheKey] = { m3u8: m3u8, t: Date.now() };
      return m3u8;
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[VidSrc] getStreams: " + tmdbId + " " + mediaType + " S" + (season || "?") + "E" + (episode || "?"));

  // Check cache first (keyed by imdbId we don't know yet, so we'll cache on imdb lookup)
  return getImdbId(tmdbId, mediaType).then(function(imdbId) {
    if (!imdbId) return [];

    // Check stream cache
    var cacheKey = imdbId + "|" + mediaType + "|" + (season || "") + "|" + (episode || "");
    var cached = _cache.streams[cacheKey];
    if (cached && (Date.now() - cached.t) < _cache.ttl) {
      console.log("[VidSrc] Using cached M3U8");
      return [{ name: "VidSrc", title: "VidSrc", url: cached.m3u8, quality: "Auto" }];
    }

    return getStreamsFromIds(imdbId, tmdbId, mediaType, season, episode)
      .then(function(m3u8) {
        return [{ name: "VidSrc", title: "VidSrc", url: m3u8, quality: "Auto" }];
      })
      .catch(function(err) {
        console.log("[VidSrc] Extraction failed: " + err.message);
        return [];
      });
  });
}

module.exports = { getStreams: getStreams };
