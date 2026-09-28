// ============================================================
// EDIT THESE THREE LINES WITH YOUR IPTV CREDENTIALS
// ============================================================
var IPTV_HOST = "http://doom-iptv.online:80";   // <-- YOUR HOST
var IPTV_USER = "iAE7VFpRgy";                  // <-- YOUR USERNAME
var IPTV_PASS = "4422352741";                  // <-- YOUR PASSWORD
// ============================================================

var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";

// ---- CACHE ----
var _CACHE = {
  catalog: null,     // { movies: [], series: [] }
  imdbIndex: null,   // { "tt1234567": {type, item} }
  tmdbImdb: {},      // tmdbId|mediaType -> imdbId
  t: 0,
  ttl: 30 * 60 * 1000
};

function xtreamUrl(action, extra) {
  var u = IPTV_HOST.replace(/\/$/, "") + "/player_api.php?username=" +
    encodeURIComponent(IPTV_USER) + "&password=" + encodeURIComponent(IPTV_PASS);
  if (action) u += "&action=" + action;
  if (extra) u += "&" + extra;
  return u;
}

function fetchJson(url, headers) {
  var h = { "User-Agent": UA };
  if (headers) { Object.keys(headers).forEach(function(k) { h[k] = headers[k]; }); }
  return fetch(url, { headers: h }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

// ---- STEP 1: GET IMDb ID FROM TMDB ----
function tmdbToImdb(tmdbId, mediaType) {
  var key = tmdbId + "|" + mediaType;
  if (_CACHE.tmdbImdb[key]) return Promise.resolve(_CACHE.tmdbImdb[key]);

  var type = mediaType === "tv" ? "tv" : "movie";
  // Use /find endpoint with external_source=imdb_id won't work here. Use details with append_to_response
  var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
            "/external_ids?api_key=" + TMDB_API_KEY;

  return fetchJson(url).then(function(data) {
    var imdb = data.imdb_id || null;
    if (imdb) {
      _CACHE.tmdbImdb[key] = imdb;
      console.log("[IPTV] TMDB " + tmdbId + " -> IMDb " + imdb);
    } else {
      console.log("[IPTV] TMDB " + tmdbId + " has no IMDb ID");
    }
    return imdb;
  }).catch(function(e) {
    console.log("[IPTV] TMDB external_ids failed:", e.message);
    return null;
  });
}

// ---- STEP 2: BUILD IMDb INDEX FROM IPTV CATALOG ----
function loadCatalog() {
  var now = Date.now();
  if (_CACHE.catalog && _CACHE.imdbIndex && (now - _CACHE.t) < _CACHE.ttl) {
    console.log("[IPTV] catalog cached (" + Object.keys(_CACHE.imdbIndex).length + " imdb entries)");
    return Promise.resolve(_CACHE.catalog);
  }

  console.log("[IPTV] loading catalog...");
  return Promise.all([
    fetchJson(xtreamUrl("get_vod_streams")).catch(function(e) {
      console.log("[IPTV] VOD failed:", e.message); return [];
    }),
    fetchJson(xtreamUrl("get_series")).catch(function(e) {
      console.log("[IPTV] Series failed:", e.message); return [];
    })
  ]).then(function(res) {
    var vodArr = Array.isArray(res[0]) ? res[0] : [];
    var serArr = Array.isArray(res[1]) ? res[1] : [];

    // Build imdb index
    var idx = {};
    var vodWithImdb = 0, serWithImdb = 0;

    vodArr.forEach(function(item) {
      var imdb = item.imdb_id || item.imdbId || "";
      if (imdb && imdb.indexOf("tt") === 0) {
        if (!idx[imdb]) {
          idx[imdb] = { type: "movie", item: item };
          vodWithImdb++;
        }
      }
    });

    serArr.forEach(function(item) {
      var imdb = item.imdb_id || item.imdbId || "";
      if (imdb && imdb.indexOf("tt") === 0) {
        if (!idx[imdb]) {
          idx[imdb] = { type: "series", item: item };
          serWithImdb++;
        }
      }
    });

    console.log("[IPTV] catalog: " + vodArr.length + " VOD (" + vodWithImdb + " with imdb), " +
                serArr.length + " series (" + serWithImdb + " with imdb)");

    _CACHE.catalog = { movies: vodArr, series: serArr };
    _CACHE.imdbIndex = idx;
    _CACHE.t = Date.now();
    return _CACHE.catalog;
  });
}

// ---- STREAM URL BUILDERS ----
function buildMovieUrl(item) {
  var ext = item.container_extension || "mp4";
  return IPTV_HOST.replace(/\/$/, "") + "/movie/" +
    encodeURIComponent(IPTV_USER) + "/" +
    encodeURIComponent(IPTV_PASS) + "/" +
    item.stream_id + "." + ext;
}

function buildEpisodeUrl(ep) {
  var ext = ep.container_extension || "mp4";
  return IPTV_HOST.replace(/\/$/, "") + "/series/" +
    encodeURIComponent(IPTV_USER) + "/" +
    encodeURIComponent(IPTV_PASS) + "/" +
    ep.id + "." + ext;
}

// ---- GET SERIES EPISODES ----
function getSeriesEpisodes(seriesId) {
  return fetchJson(xtreamUrl("get_series_info", "series_id=" + seriesId))
    .then(function(data) {
      if (!data || !data.episodes) return [];
      var episodes = [];
      var seasonsObj = data.episodes;
      // Handle both object format ({ "1": [...] }) and array format
      if (Array.isArray(seasonsObj)) {
        seasonsObj.forEach(function(arr, i) {
          if (!Array.isArray(arr)) return;
          arr.forEach(function(ep) {
            episodes.push({
              season: Number(ep.season || i + 1),
              episode: Number(ep.episode_num || ep.episode || 0),
              id: ep.id,
              title: ep.title || "",
              container_extension: ep.container_extension || "mp4"
            });
          });
        });
      } else {
        Object.keys(seasonsObj).forEach(function(seasonNum) {
          var arr = seasonsObj[seasonNum];
          if (!Array.isArray(arr)) return;
          arr.forEach(function(ep) {
            episodes.push({
              season: Number(ep.season || seasonNum),
              episode: Number(ep.episode_num || ep.episode || 0),
              id: ep.id,
              title: ep.title || "",
              container_extension: ep.container_extension || "mp4"
            });
          });
        });
      }
      return episodes;
    });
}

// ---- MOVIE STREAMS ----
function getMovieStreams(tmdbId) {
  return tmdbToImdb(tmdbId, "movie").then(function(imdbId) {
    if (!imdbId) {
      console.log("[IPTV] no IMDb ID for TMDB " + tmdbId + " — cannot match");
      return [];
    }
    return loadCatalog().then(function() {
      var entry = _CACHE.imdbIndex[imdbId];
      if (!entry) {
        console.log("[IPTV] IMDb " + imdbId + " not in IPTV catalog");
        return [];
      }
      if (entry.type !== "movie") {
        console.log("[IPTV] IMDb " + imdbId + " is a series, not a movie");
        return [];
      }
      var item = entry.item;
      console.log("[IPTV] ✅ matched: " + item.name + " (stream_id " + item.stream_id + ")");
      return [{
        name: "IPTV",
        title: "IPTV — " + (item.name || "Movie"),
        url: buildMovieUrl(item),
        quality: (item.container_extension || "mp4").toUpperCase(),
        referer: IPTV_HOST + "/"
      }];
    });
  }).catch(function(err) {
    console.log("[IPTV] movie error:", err.message);
    return [];
  });
}

// ---- TV STREAMS ----
function getTvStreams(tmdbId, season, episode) {
  var wantedS = Number(season) || 1;
  var wantedE = Number(episode) || 1;

  return tmdbToImdb(tmdbId, "tv").then(function(imdbId) {
    if (!imdbId) {
      console.log("[IPTV] no IMDb ID for TMDB " + tmdbId + " — cannot match");
      return [];
    }
    return loadCatalog().then(function() {
      var entry = _CACHE.imdbIndex[imdbId];
      if (!entry || entry.type !== "series") {
        console.log("[IPTV] series " + imdbId + " not in IPTV catalog");
        return [];
      }
      var series = entry.item;
      console.log("[IPTV] ✅ series matched: " + series.name + " (series_id " + series.series_id + ")");

      return getSeriesEpisodes(series.series_id).then(function(eps) {
        console.log("[IPTV] series has " + eps.length + " episodes");
        if (!eps.length) return [];

        // Find S/E
        var match = null;
        for (var i = 0; i < eps.length; i++) {
          if (eps[i].season === wantedS && eps[i].episode === wantedE) {
            match = eps[i]; break;
          }
        }
        // Fallback: just episode number
        if (!match) {
          for (var j = 0; j < eps.length; j++) {
            if (eps[j].episode === wantedE) { match = eps[j]; break; }
          }
        }
        if (!match) {
          console.log("[IPTV] S" + wantedS + "E" + wantedE + " not found");
          return [];
        }

        console.log("[IPTV] ✅ episode: S" + match.season + "E" + match.episode + " id " + match.id);
        return [{
          name: "IPTV",
          title: "IPTV — " + (series.name || "Series") + " S" + wantedS + "E" + wantedE,
          url: buildEpisodeUrl(match),
          quality: (match.container_extension || "mp4").toUpperCase(),
          referer: IPTV_HOST + "/"
        }];
      });
    });
  }).catch(function(err) {
    console.log("[IPTV] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[IPTV] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
