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
var _CATALOG = { vod: null, series: null, t: 0, ttl: 30 * 60 * 1000 };

function xtreamUrl(action, extra) {
  var u = IPTV_HOST.replace(/\/$/, "") + "/player_api.php?username=" +
    encodeURIComponent(IPTV_USER) + "&password=" + encodeURIComponent(IPTV_PASS);
  if (action) u += "&action=" + action;
  if (extra) u += "&" + extra;
  return u;
}

function fetchJson(url) {
  return fetch(url, {
    headers: { "User-Agent": UA }
  }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

function normalize(s) {
  return String(s || "").toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
  var aa = a.split(" "), bb = b.split(" ");
  var setB = {}; bb.forEach(function(x) { setB[x] = 1; });
  var common = 0; aa.forEach(function(x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

// ---- CATALOG LOADER ----
function loadCatalog() {
  var now = Date.now();
  if (_CATALOG.vod && _CATALOG.series && (now - _CATALOG.t) < _CATALOG.ttl) {
    console.log("[IPTV] catalog cached");
    return Promise.resolve(_CATALOG);
  }
  console.log("[IPTV] loading full catalog...");
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
    console.log("[IPTV] VOD:", vodArr.length, "Series:", serArr.length);
    _CATALOG.vod = vodArr;
    _CATALOG.series = serArr;
    _CATALOG.t = Date.now();
    return _CATALOG;
  });
}

// ---- SEARCH ----
function searchCatalog(titles, type) {
  return loadCatalog().then(function(cat) {
    var pool = type === "movie" ? cat.vod : cat.series;
    var results = [];
    titles.forEach(function(t) {
      pool.forEach(function(item) {
        var name = item.name || item.title || "";
        var s = similarity(name, t);
        if (s >= 0.5) {
          results.push({ item: item, score: s });
        }
      });
    });
    // Sort by score
    results.sort(function(a, b) { return b.score - a.score; });
    // Dedupe by stream_id/series_id
    var seen = {};
    var unique = [];
    results.forEach(function(r) {
      var id = r.item.stream_id || r.item.series_id;
      if (!seen[id]) { seen[id] = 1; unique.push(r); }
    });
    console.log("[IPTV] search", type, "->", unique.length, "matches");
    return unique;
  });
}

// ---- BUILD STREAM URL ----
function buildVodUrl(item) {
  var ext = item.container_extension || "mp4";
  return IPTV_HOST.replace(/\/$/, "") + "/movie/" +
    encodeURIComponent(IPTV_USER) + "/" +
    encodeURIComponent(IPTV_PASS) + "/" +
    item.stream_id + "." + ext;
}

function buildSeriesEpisodeUrl(ep) {
  var ext = ep.container_extension || "mp4";
  // Episode stream URL uses the episode ID
  return IPTV_HOST.replace(/\/$/, "") + "/series/" +
    encodeURIComponent(IPTV_USER) + "/" +
    encodeURIComponent(IPTV_PASS) + "/" +
    ep.id + "." + ext;
}

// ---- TV EPISODE FETCH ----
function getSeriesEpisodes(seriesId) {
  return fetchJson(xtreamUrl("get_series_info", "series_id=" + seriesId))
    .then(function(data) {
      if (!data || !data.episodes) return [];
      var episodes = [];
      var seasonsObj = data.episodes;
      Object.keys(seasonsObj).forEach(function(seasonNum) {
        var arr = seasonsObj[seasonNum];
        if (!Array.isArray(arr)) return;
        arr.forEach(function(ep) {
          episodes.push({
            season: Number(seasonNum),
            episode: Number(ep.episode_num || ep.episode || 0),
            id: ep.id,
            title: ep.title || "",
            container_extension: ep.container_extension || "mp4"
          });
        });
      });
      return episodes;
    });
}

// ---- TMDB TITLES ----
function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var urls = ["ar", "en"].map(function(lang) {
    return "https://api.themoviedb.org/3/" + type + "/" +
      encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
  });
  return Promise.all(urls.map(function(u) {
    return fetch(u).then(function(r) { return r.json(); }).catch(function() { return null; });
  })).then(function(dataArr) {
    var titles = [];
    dataArr.forEach(function(d) {
      if (!d) return;
      var t = type === "movie"
        ? (d.title || d.original_title)
        : (d.name || d.original_name);
      if (t && titles.indexOf(t) === -1) titles.push(t);
    });
    console.log("[IPTV] TMDB titles:", titles.join(" | "));
    return titles;
  });
}

// ---- MOVIE ----
function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(titles) {
    if (!titles.length) return [];
    return searchCatalog(titles, "movie").then(function(matches) {
      if (!matches.length) return [];
      // Take top 3 matches (different quality/release versions)
      var top = matches.slice(0, 3);
      return top.map(function(m, i) {
        return {
          name: "IPTV",
          title: "IPTV " + (m.item.name || m.item.title || ("Movie " + (i+1))),
          url: buildVodUrl(m.item),
          quality: m.item.container_extension === "mp4" ? "SD" : "Unknown",
          referer: IPTV_HOST + "/"
        };
      });
    });
  }).catch(function(err) {
    console.log("[IPTV] movie error:", err.message);
    return [];
  });
}

// ---- TV ----
function getTvStreams(tmdbId, season, episode) {
  var wantedS = Number(season) || 1;
  var wantedE = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(titles) {
    if (!titles.length) return [];
    return searchCatalog(titles, "series").then(function(matches) {
      if (!matches.length) return [];
      // Take best match and fetch its episodes
      var best = matches[0];
      console.log("[IPTV] series match:", best.item.name, "id:", best.item.series_id);
      return getSeriesEpisodes(best.item.series_id).then(function(eps) {
        if (!eps.length) return [];
        // Find matching season + episode
        var match = null;
        for (var i = 0; i < eps.length; i++) {
          if (eps[i].season === wantedS && eps[i].episode === wantedE) {
            match = eps[i]; break;
          }
        }
        // Fallback: just match episode number regardless of season
        if (!match) {
          for (var j = 0; j < eps.length; j++) {
            if (eps[j].episode === wantedE) { match = eps[j]; break; }
          }
        }
        if (!match) {
          console.log("[IPTV] episode not found S" + wantedS + "E" + wantedE);
          return [];
        }
        console.log("[IPTV] found episode:", match.title || ("E" + match.episode));
        return [{
          name: "IPTV",
          title: "IPTV " + (best.item.name || "Series") + " S" + wantedS + "E" + wantedE,
          url: buildSeriesEpisodeUrl(match),
          quality: "Unknown",
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
