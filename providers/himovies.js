/**
 * HiMovies.ac provider
 *
 * Architecture (verified against Thanatoslayer6/Himovies-Unofficial-API + live site):
 *  - Search:          GET /search/{query}                → HTML (.film-detail)
 *  - Movie servers:   GET /ajax/movie/episodes/{movieId} → HTML (<a data-id>)
 *  - TV seasons:      GET /ajax/v2/tv/seasons/{tvId}     → HTML (<a data-id>)
 *  - TV episodes:     GET /ajax/v2/season/episodes/{sid} → HTML (.eps-item)
 *  - Episode servers: GET /ajax/v2/episode/servers/{eid} → HTML (<a data-id>)
 *  - Stream link:     GET /ajax/sources/{serverId}       → JSON {link: "..."}
 *                     Referer: {BASE}/watch-movie/{movieId}.{serverId}
 *
 * The AJAX endpoints require X-Requested-With header and Referer.
 * The final link points to an external embed host (mzzcloud.life, streamsb, etc.)
 * returned as an iframe stream with proper headers.
 */

var BASE = "https://himovies.ac";
var PROVIDER_ID = "himovies";
var PROVIDER_NAME = "🎬 HiMovies";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var FETCH_TIMEOUT_MS = 15000;
var MATCH_THRESHOLD = 0.35;

function log(m) { console.log("[HiMovies] " + m); }

// ---------------------------------------------------------------- http
function withTimeout(promise, ms) {
  if (typeof setTimeout !== "function") return promise;
  return new Promise(function(resolve, reject) {
    var done = false;
    var t = setTimeout(function() {
      if (!done) { done = true; reject(new Error("timeout")); }
    }, ms);
    promise.then(function(v) {
      if (!done) { done = true; if (typeof clearTimeout === "function") clearTimeout(t); resolve(v); }
    }, function(e) {
      if (!done) { done = true; if (typeof clearTimeout === "function") clearTimeout(t); reject(e); }
    });
  });
}

function fetchText(url, referer, ajax) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = {
    "User-Agent": UA,
    "Accept": ajax ? "application/json, text/javascript, */*; q=0.01" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
  return withTimeout(
    fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }),
    FETCH_TIMEOUT_MS
  );
}

function fetchJson(url, referer) {
  return fetchText(url, referer, true).then(function(t) {
    try { return JSON.parse(t); } catch (e) { return null; }
  });
}

// ---------------------------------------------------------------- helpers
function decodeHtml(str) {
  return String(str || "")
    .replace(/&#x([0-9a-f]+);/gi, function(_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function stripHtml(str) {
  return decodeHtml(String(str || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeTitle(str) {
  return String(str || "").toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = normalizeTitle(a); b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  var shortS = a.length <= b.length ? a : b;
  var longS = a.length <= b.length ? b : a;
  if ((" " + longS + " ").indexOf(" " + shortS + " ") !== -1) {
    return 0.55 + 0.35 * (shortS.length / longS.length);
  }
  var aa = a.split(" "); var bb = b.split(" ");
  var setB = {}; bb.forEach(function(x) { setB[x] = 1; });
  var common = 0;
  aa.forEach(function(x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

function getAttr(attrs, name) {
  var re = new RegExp("(?:^|[\\s\"'])" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  var m = String(attrs || "").match(re);
  if (!m) return "";
  return decodeHtml(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
}

// ---------------------------------------------------------------- TMDB
function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["en", "ar"];
  var titles = [];
  var year = null;
  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return fetch(apiUrl).then(function(r) { return r.json(); }).then(function(data) {
        var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
        if (title && titles.indexOf(title) === -1) titles.push(title);
        if (!year) {
          var dateStr = type === "movie" ? data.release_date : data.first_air_date;
          if (dateStr) year = dateStr.slice(0, 4);
        }
      }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    if (!titles.length) throw new Error("No TMDB titles for " + tmdbId);
    log("TMDB titles: " + titles.join(" | "));
    return { titles: titles, year: year };
  });
}

// ---------------------------------------------------------------- search
// Each result: <div class="film-detail">
//   <h2 class="film-name"><a href="/movie/slug-HASH" title="Title">Title</a></h2>
//   <div class="fd-infor">... year ...</div>
function parseSearchResults(html) {
  var out = []; var seen = {};
  var re = /<div[^>]*class="[^"]*film-detail[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  var m;
  html = String(html || "");
  while ((m = re.exec(html)) !== null) {
    var block = m[1];
    var aMatch = block.match(/<a\s+href="(\/(?:movie|tv)\/[^"]+)"[^>]*title="([^"]*)"/i) ||
                 block.match(/<a\s+title="([^"]*)"[^>]*href="(\/(?:movie|tv)\/[^"]+)"/i);
    if (!aMatch) continue;
    var href, title;
    if (aMatch[1].indexOf("/") === 0) { href = aMatch[1]; title = decodeHtml(aMatch[2]); }
    else { title = decodeHtml(aMatch[1]); href = aMatch[2]; }
    var hm = href.match(/\/(movie|tv)\/([^"?#]+)/i);
    if (!hm) continue;
    var kind = hm[1].toLowerCase() === "movie" ? "movie" : "series";
    var slug = hm[2];
    var key = kind + ":" + slug;
    if (seen[key]) continue;
    seen[key] = 1;
    var yearMatch = block.match(/\b(19|20)\d\d\b/);
    out.push({
      slug: slug,
      kind: kind,
      title: title.replace(/\s*\(.*?\)\s*$/, "").trim(),
      year: yearMatch ? yearMatch[0] : "",
      url: BASE + href
    });
  }
  log("Parsed search results: " + out.length);
  return out;
}

function searchHiMovies(query) {
  var q = String(query || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/search/" + encodeURIComponent(q).replace(/%20/g, "-");
  log("Search: " + q + " → " + url);
  return fetchText(url, BASE + "/").then(function(html) {
    return parseSearchResults(html);
  }).catch(function(e) {
    log("Search failed: " + e.message);
    return [];
  });
}

function searchMany(titles) {
  var uniq = [];
  titles.forEach(function(t) { if (t && uniq.indexOf(t) === -1) uniq.push(t); });
  return Promise.all(uniq.map(searchHiMovies)).then(function(groups) {
    var all = []; var seen = {};
    groups.forEach(function(g) {
      g.forEach(function(r) {
        var k = r.kind + ":" + r.slug;
        if (!seen[k]) { seen[k] = 1; all.push(r); }
      });
    });
    log("Unique candidates: " + all.length);
    return all;
  });
}

function chooseResult(results, titles, wantKind, year) {
  var best = null; var bestScore = 0;
  results.forEach(function(r) {
    if (wantKind && r.kind !== wantKind) return;
    var s = 0;
    titles.forEach(function(t) {
      var sc = similarity(r.title, t);
      if (sc > s) s = sc;
    });
    if (year && r.year && Math.abs(Number(r.year) - Number(year)) <= 1) s += 0.15;
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (best) log("Best: " + best.title + " (" + best.kind + ", " + best.year + ") score=" + bestScore.toFixed(3));
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

// ---------------------------------------------------------------- server lists
// <a data-id="SID" data-linkid="SID"><span>ServerName</span></a>
function parseServerAnchors(html) {
  var out = []; var seen = {};
  var re = /<a\b([^>]*data-(?:id|linkid)="[^"]+"[^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  html = String(html || "");
  while ((m = re.exec(html)) !== null) {
    var sid = getAttr(m[1], "data-id") || getAttr(m[1], "data-linkid");
    if (!sid || seen[sid]) continue;
    seen[sid] = 1;
    var name = stripHtml(m[2]);
    if (!name) name = "Server " + sid;
    out.push({ serverId: sid, name: name });
  }
  return out;
}

function getMovieServers(movieSlug) {
  var url = BASE + "/ajax/movie/episodes/" + encodeURIComponent(movieSlug);
  log("Movie servers: " + url);
  return fetchText(url, BASE + "/movie/" + movieSlug, true).then(function(html) {
    var servers = parseServerAnchors(html);
    log("Movie server count: " + servers.length + " [" + servers.map(function(s) { return s.name; }).join(", ") + "]");
    return servers;
  }).catch(function(e) {
    log("Movie servers failed: " + e.message);
    return [];
  });
}

function getTvSeasons(tvSlug) {
  var url = BASE + "/ajax/v2/tv/seasons/" + encodeURIComponent(tvSlug);
  log("TV seasons: " + url);
  return fetchText(url, BASE + "/tv/" + tvSlug, true).then(function(html) {
    var out = []; var seen = {};
    var re = /<a\b([^>]*data-id="[^"]+"[^>]*)>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var sid = getAttr(m[1], "data-id");
      if (!sid || seen[sid]) continue;
      seen[sid] = 1;
      var name = stripHtml(m[2]);
      var numMatch = name.match(/(\d+)/);
      out.push({ seasonId: sid, name: name, number: numMatch ? parseInt(numMatch[1], 10) : null });
    }
    log("Seasons: " + out.length);
    return out;
  }).catch(function(e) {
    log("Seasons failed: " + e.message);
    return [];
  });
}

function getEpisodes(seasonId) {
  var url = BASE + "/ajax/v2/season/episodes/" + encodeURIComponent(seasonId);
  log("Episodes: " + url);
  return fetchText(url, BASE + "/", true).then(function(html) {
    var out = []; var seen = {};
    var re = /<a\b([^>]*class="[^"]*eps-item[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var eid = getAttr(m[1], "data-id");
      if (!eid || seen[eid]) continue;
      seen[eid] = 1;
      var title = getAttr(m[1], "title") || stripHtml(m[2]);
      var numMatch = title.match(/(\d+)/);
      out.push({ episodeId: eid, title: title, number: numMatch ? parseInt(numMatch[1], 10) : null });
    }
    log("Episodes: " + out.length);
    return out;
  }).catch(function(e) {
    log("Episodes failed: " + e.message);
    return [];
  });
}

function getEpisodeServers(episodeId) {
  var url = BASE + "/ajax/v2/episode/servers/" + encodeURIComponent(episodeId);
  log("Episode servers: " + url);
  return fetchText(url, BASE + "/", true).then(function(html) {
    return parseServerAnchors(html);
  }).catch(function(e) {
    log("Episode servers failed: " + e.message);
    return [];
  });
}

// ---------------------------------------------------------------- stream link
// GET /ajax/sources/{serverId}
// Referer: {BASE}/watch-movie/{movieSlug}.{serverId}   (movies)
//         {BASE}/watch-tv/{tvSlug}.{serverId}          (tv — appears to use the slug too)
function getSourceLink(serverId, refererUrl) {
  var url = BASE + "/ajax/sources/" + encodeURIComponent(serverId);
  log("Source link: " + url);
  return fetchJson(url, refererUrl).then(function(res) {
    if (!res) { log("No JSON from sources"); return null; }
    var link = res.link || res.url || (res.data && res.data.link);
    if (!link) { log("No link in JSON: " + JSON.stringify(res).slice(0, 200)); return null; }
    if (link.indexOf("//") === 0) link = "https:" + link;
    log("Stream link: " + link.slice(0, 100));
    return link;
  }).catch(function(e) {
    log("Source link failed: " + e.message);
    return null;
  });
}

// ---------------------------------------------------------------- build streams
function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "2160p";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  return "Auto";
}

function hostLabel(url) {
  var m = String(url || "").match(/^https?:\/\/(?:www\.)?([^\/:?#]+)/i);
  var h = m ? m[1].toLowerCase() : "";
  if (/mzzcloud/.test(h)) return "MzzCloud";
  if (/streamsb/.test(h)) return "StreamSB";
  if (/upcloud/.test(h)) return "UpCloud";
  if (/vidcloud/.test(h)) return "VidCloud";
  if (/megacloud/.test(h)) return "MegaCloud";
  if (/vidstreaming/.test(h)) return "VidStreaming";
  if (/dood/.test(h)) return "Dood";
  if (/streamtape/.test(h)) return "StreamTape";
  if (/voe/.test(h)) return "Voe";
  if (/filemoon/.test(h)) return "Filemoon";
  return h.split(".").slice(-2, -1)[0] || h;
}

function makeStream(link, serverName, tag, pageUrl) {
  var origin = "https://himovies.ac";
  var isHls = /\.m3u8/i.test(link);
  var type = isHls ? "hls" : "iframe";
  return {
    name: PROVIDER_NAME + " " + serverName + (tag ? " " + tag : ""),
    title: PROVIDER_NAME + " • " + serverName + (tag ? " " + tag : "") + " (" + hostLabel(link) + ")",
    url: link,
    quality: isHls ? "Auto" : qualityFromUrl(link),
    size: "Unknown",
    type: type,
    headers: {
      "User-Agent": UA,
      "Referer": origin + "/",
      "Origin": origin,
      "Accept": "*/*"
    },
    provider: PROVIDER_ID
  };
}

// ---------------------------------------------------------------- movie flow
function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      var best = chooseResult(all, meta.titles, "movie", meta.year);
      if (!best) { log("No movie match"); return []; }
      log("Resolving movie: " + best.slug);
      return getMovieServers(best.slug).then(function(servers) {
        if (!servers.length) return [];
        var refererBase = BASE + "/movie/" + best.slug;
        return Promise.all(servers.map(function(srv) {
          var watchUrl = BASE + "/watch-movie/" + best.slug + "." + srv.serverId;
          return getSourceLink(srv.serverId, watchUrl).then(function(link) {
            if (!link) return null;
            return makeStream(link, srv.name, "", refererBase);
          });
        })).then(function(list) {
          var out = list.filter(Boolean);
          log("Total movie streams: " + out.length);
          return out;
        });
      });
    });
  }).catch(function(err) {
    log("Movie error: " + err.message);
    return [];
  });
}

// ---------------------------------------------------------------- TV flow
function getTvStreams(tmdbId, season, episode) {
  var s = Number(season) || 1;
  var e = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      var best = chooseResult(all, meta.titles, "series", null);
      if (!best) { log("No series match"); return []; }
      log("Resolving series: " + best.slug + " S" + s + "E" + e);
      return getTvSeasons(best.slug).then(function(seasons) {
        if (!seasons.length) return [];
        var targetSeason = null;
        for (var i = 0; i < seasons.length; i++) {
          if (seasons[i].number === s) { targetSeason = seasons[i]; break; }
        }
        if (!targetSeason) targetSeason = seasons[0];
        log("Using season: " + targetSeason.name + " (" + targetSeason.seasonId + ")");
        return getEpisodes(targetSeason.seasonId).then(function(episodes) {
          if (!episodes.length) return [];
          var targetEp = null;
          for (var j = 0; j < episodes.length; j++) {
            if (episodes[j].number === e) { targetEp = episodes[j]; break; }
          }
          if (!targetEp) {
            log("Episode " + e + " not found");
            return [];
          }
          log("Using episode: " + targetEp.title + " (" + targetEp.episodeId + ")");
          return getEpisodeServers(targetEp.episodeId).then(function(servers) {
            if (!servers.length) return [];
            var tag = "S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
            var refererBase = BASE + "/tv/" + best.slug;
            return Promise.all(servers.map(function(srv) {
              var watchUrl = BASE + "/watch-tv/" + best.slug + "." + srv.serverId;
              return getSourceLink(srv.serverId, watchUrl).then(function(link) {
                if (!link) return null;
                return makeStream(link, srv.name, tag, refererBase);
              });
            })).then(function(list) {
              var out = list.filter(Boolean);
              log("Total TV streams: " + out.length);
              return out;
            });
          });
        });
      });
    });
  }).catch(function(err) {
    log("TV error: " + err.message);
    return [];
  });
}

// ---------------------------------------------------------------- entry
function getStreams(tmdbId, mediaType, season, episode) {
  log("getStreams: " + tmdbId + " " + mediaType + " " + season + " " + episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
