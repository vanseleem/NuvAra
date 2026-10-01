/**
 * DramaCafe provider  (v1 — rebuilt from scratch)
 *
 * Architecture (verified live):
 *  1. search.php?keywords=Q        → HTML containing watch.php?vid= links
 *  2. watch.php?vid=VID            → confirms video exists, provides title
 *  3. ajax.php?p=video&do=getplayer&vid=VID&aid=1&player=detail&playlist=
 *                                   → returns plain-text list of embed URLs
 *  4. Each embed URL is returned as a separate stream entry
 *
 * Powered by PHP Melody CMS.
 */

var BASE = "https://ddramacafe-tv.bar";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

var FETCH_TIMEOUT_MS = 15000;
var MATCH_THRESHOLD = 0.35;
var MAX_MOVIE_VERSIONS = 2;

// ---------------------------------------------------------------- http
function withTimeout(promise, ms, label) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var t = setTimeout(function() {
      if (!done) { done = true; reject(new Error((label || "request") + " timeout")); }
    }, ms);
    promise.then(function(v) {
      if (!done) { done = true; clearTimeout(t); resolve(v); }
    }, function(e) {
      if (!done) { done = true; clearTimeout(t); reject(e); }
    });
  });
}

function encodeNonAscii(str) {
  return String(str).replace(/[^\x00-\x7F]/g, function(c) {
    try { return encodeURIComponent(c); } catch (e) { return ""; }
  });
}

function fetchText(url, referer) {
  url = encodeNonAscii(url);
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar,en;q=0.9",
    "Referer": referer ? encodeNonAscii(referer) : BASE + "/"
  };
  return withTimeout(
    fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }),
    FETCH_TIMEOUT_MS,
    url
  );
}

// ---------------------------------------------------------------- text helpers
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

function normalizeArabic(s) {
  return String(s || "")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[\u0622\u0623\u0625]/g, "\u0627")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064A");
}

function normalizeTitle(str) {
  return normalizeArabic(String(str || "").toLowerCase())
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

var NOISE = {};
["فيلم", "مسلسل", "مترجم", "مترجمه", "مدبلج", "مدبلجه", "كامل", "كامله",
 "اون", "لاين", "اونلاين", "hd"].forEach(function(w) { NOISE[normalizeArabic(w)] = 1; });

function cleanTitle(str) {
  var toks = normalizeTitle(str).split(" ").filter(function(t) { return t && !NOISE[t]; });
  var noYear = toks.filter(function(t) { return !/^(19|20)\d\d$/.test(t); });
  return (noYear.length ? noYear : toks).join(" ");
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  var at = a.split(" "), bt = b.split(" ");
  var shortS = a.length <= b.length ? a : b;
  var longS = a.length <= b.length ? b : a;
  if ((" " + longS + " ").indexOf(" " + shortS + " ") !== -1) {
    return 0.55 + 0.35 * (shortS.length / longS.length);
  }
  var setB = {};
  bt.forEach(function(x) { setB[x] = 1; });
  var common = 0;
  at.forEach(function(x) { if (setB[x]) common++; });
  return common / Math.max(at.length, bt.length);
}

function extractYear(str) {
  var all = String(str || "").match(/\b(?:19|20)\d\d\b/g);
  return all ? parseInt(all[all.length - 1], 10) : null;
}

// ---- season / episode parsing
var SEASON_WORDS = ["", "الأول", "الثاني", "الثالث", "الرابع", "الخامس",
                    "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
var SEASON_WORDS_N = SEASON_WORDS.map(normalizeArabic);
var CUT_TOKENS = {};
["الحلقة", "الموسم", "الجزء", "episode", "season"].forEach(function(w) { CUT_TOKENS[normalizeArabic(w)] = 1; });

function seriesKey(title) {
  var toks = normalizeTitle(title).split(" ");
  var cut = toks.length;
  for (var i = 0; i < toks.length; i++) {
    if (CUT_TOKENS[toks[i]]) { cut = i; break; }
  }
  return toks.slice(0, cut).filter(function(t) { return t && !NOISE[t]; }).join(" ");
}

function episodeFromTitle(title) {
  var n = normalizeTitle(title);
  var m = n.match(/(?:الحلقه|episode)\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function seasonFromTitle(title) {
  var n = normalizeTitle(title);
  var m = n.match(/(?:الموسم|الجزء|season)\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  m = n.match(/(?:الموسم|الجزء)\s*(\S+)/);
  if (m) {
    var i = SEASON_WORDS_N.indexOf(m[1]);
    if (i > 0) return i;
  }
  return null;
}

// ---------------------------------------------------------------- url helpers
function originOf(url) {
  var m = String(url || "").match(/^(https?:\/\/[^\/]+)/i);
  return m ? m[1] : "";
}

function hostOf(url) {
  var m = String(url || "").match(/^https?:\/\/([^\/:?#]+)/i);
  return m ? m[1].replace(/^www\./, "") : "";
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
  var langs = ["ar", "en"];
  var titles = [];
  var year = null;

  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return withTimeout(fetch(apiUrl).then(function(r) { return r.json(); }), FETCH_TIMEOUT_MS, "tmdb")
        .then(function(data) {
          var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
          if (title && titles.indexOf(title) === -1) titles.push(title);
          if (!year) {
            var dateStr = type === "movie" ? data.release_date : data.first_air_date;
            if (dateStr) year = dateStr.slice(0, 4);
          }
        }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    console.log("[DramaCafe] TMDB titles:", titles.join(" | "), "year:", year);
    return { titles: titles, year: year };
  });
}

// ---------------------------------------------------------------- search
function parseWatchAnchors(html) {
  var out = [];
  var seen = {};
  html = String(html || "");

  var re = /<a\s+[^>]*?href\s*=\s*["']([^"']*watch\.php\?vid=([A-Za-z0-9_-]+))["'][^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var vid = m[2];
    if (seen[vid]) continue;
    seen[vid] = 1;

    var tagMatch = m[0];
    var titleMatch = tagMatch.match(/title\s*=\s*["']([^"']*)["']/i);
    var title = titleMatch ? decodeHtml(titleMatch[1]).trim() : "";

    out.push({
      vid: vid,
      url: BASE + "/watch.php?vid=" + vid,
      title: title
    });
  }
  return out;
}

function dedupeByVid(list) {
  var idx = {};
  var out = [];
  list.forEach(function(a) {
    if (idx[a.vid] === undefined) {
      idx[a.vid] = out.length;
      out.push(a);
    } else if (!out[idx[a.vid]].title && a.title) {
      out[idx[a.vid]] = a;
    }
  });
  return out;
}

function searchDramaCafe(title) {
  var q = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(q);
  console.log("[DramaCafe] Search:", q);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = dedupeByVid(parseWatchAnchors(html));
    console.log("[DramaCafe] Search results:", results.length, "(html size:", html.length + ")");
    return results;
  });
}

function searchMany(queries) {
  var uniq = [];
  queries.forEach(function(q) { if (q && uniq.indexOf(q) === -1) uniq.push(q); });
  return Promise.all(uniq.map(function(q) {
    return searchDramaCafe(q).catch(function(e) {
      console.log("[DramaCafe] search failed:", q, e.message);
      return [];
    });
  })).then(function(groups) {
    var all = [];
    groups.forEach(function(g) { all = all.concat(g); });
    return dedupeByVid(all);
  });
}

// ---------------------------------------------------------------- AJAX player
/**
 * Confirmed live: this endpoint returns plain text inside
 * <div id="Playerholder"> with one or more embed URLs.
 */
function fetchPlayerSources(vid) {
  var url = BASE + "/ajax.php?p=video&do=getplayer&vid=" +
    encodeURIComponent(vid) + "&aid=1&player=detail&playlist=";
  console.log("[DramaCafe] AJAX player:", url);

  return fetchText(url, BASE + "/watch.php?vid=" + vid).then(function(html) {
    var urls = [];
    var seen = {};

    // Extract all http(s) URLs from the response
    var re = /https?:\/\/[^\s"'<>]+/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = m[0].replace(/&amp;/g, "&").trim();
      if (!u || seen[u]) continue;
      // Skip the site's own URLs
      if (originOf(u) === BASE) continue;
      seen[u] = 1;
      urls.push(u);
    }

    console.log("[DramaCafe] Player sources found:", urls.length);
    return urls;
  }).catch(function(e) {
    console.log("[DramaCafe] AJAX player failed:", e.message);
    return [];
  });
}

// ---------------------------------------------------------------- stream builder
var QUALITY_RANK_AUTO = 1080;

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "2160p";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  if (/240/.test(s)) return "240p";
  return "Auto";
}

function qualityRank(q) {
  if (q === "Auto") return QUALITY_RANK_AUTO;
  var n = parseInt(q, 10);
  return isNaN(n) ? 0 : n;
}

function serverLabelFromUrl(url) {
  var h = hostOf(url);
  if (/vidspeed/.test(h)) return "Vidspeed";
  if (/uqload/.test(h)) return "Uqload";
  if (/ds2play/.test(h)) return "DS2Play";
  if (/ok\.ru/.test(h)) return "OK.ru";
  if (/voe\.sx/.test(h)) return "Voe";
  if (/yourupload/.test(h)) return "YourUpload";
  if (/dailymotion/.test(h)) return "Dailymotion";
  if (/youtube/.test(h)) return "YouTube";
  if (/vidmoly/.test(h)) return "Vidmoly";
  if (/mixdrop/.test(h)) return "Mixdrop";
  return h.split(".").slice(-2, -1)[0] || h;
}

function buildStreamsFromSources(sources, displayTitle) {
  var streams = [];
  var seen = {};

  sources.forEach(function(url) {
    if (seen[url]) return;
    seen[url] = 1;

    var label = serverLabelFromUrl(url);
    var quality = qualityFromUrl(url);
    var origin = originOf(url);

    streams.push({
      name: "⚜️ DramaCafe " + label + " " + quality,
      title: displayTitle + " • " + label,
      url: url,
      quality: quality,
      size: "Unknown",
      type: "iframe",
      headers: {
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Origin": BASE
      },
      provider: "dramacafe"
    });
  });

  streams.sort(function(a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
  return streams;
}

// ---------------------------------------------------------------- movies
function scoreMovie(resultTitle, meta) {
  var rt = cleanTitle(resultTitle);
  var s = 0;
  meta.titles.forEach(function(t) {
    var sc = similarity(rt, cleanTitle(t));
    if (sc > s) s = sc;
  });
  if (meta.year) {
    var ry = extractYear(resultTitle);
    if (ry) {
      var d = Math.abs(ry - Number(meta.year));
      if (d === 0) s += 0.1;
      else if (d > 1) s -= 0.25;
    }
  }
  return s;
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      console.log("[DramaCafe] Unique movie candidates:", all.length);
      var scored = all.map(function(r) { return { r: r, s: scoreMovie(r.title, meta) }; })
        .filter(function(x) { return x.s >= MATCH_THRESHOLD; })
        .sort(function(a, b) { return b.s - a.s; });
      if (!scored.length) return [];

      var top = scored[0].s;
      var picks = scored.filter(function(x) { return x.s >= top - 0.25; }).slice(0, MAX_MOVIE_VERSIONS);
      console.log("[DramaCafe] Movie picks:", picks.map(function(p) { return p.r.title + " (" + p.s.toFixed(2) + ")"; }).join(" | "));

      return Promise.all(picks.map(function(p) {
        return fetchPlayerSources(p.r.vid).then(function(sources) {
          return { sources: sources, title: p.r.title };
        }).catch(function() { return { sources: [], title: p.r.title }; });
      })).then(function(results) {
        var allStreams = [];
        results.forEach(function(res) {
          var displayTitle = res.title;
          buildStreamsFromSources(res.sources, displayTitle).forEach(function(s) {
            allStreams.push(s);
          });
        });
        return allStreams;
      });
    });
  }).catch(function(err) {
    console.log("[DramaCafe] Movie error:", err.message);
    return [];
  });
}

// ---------------------------------------------------------------- series
function bestTitleScore(key, titles) {
  var s = 0;
  titles.forEach(function(t) {
    var sc = similarity(key, cleanTitle(t));
    if (sc > s) s = sc;
  });
  return s;
}

function getTvStreams(tmdbId, season, episode) {
  var wantedSeason = Number(season) || 1;
  var wantedEp = Number(episode) || 1;

  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    var queries = [];
    meta.titles.forEach(function(t) {
      queries.push(t);
      queries.push(t + " الحلقة " + wantedEp);
      if (wantedSeason > 1) queries.push(t + " الموسم " + (SEASON_WORDS[wantedSeason] || wantedSeason));
    });

    return searchMany(queries).then(function(all) {
      console.log("[DramaCafe] Unique TV candidates:", all.length);

      var buckets = {};
      all.forEach(function(r) {
        var k = seriesKey(r.title);
        if (!k) return;
        if (!buckets[k]) buckets[k] = { key: k, items: [] };
        buckets[k].items.push(r);
      });

      var ranked = Object.keys(buckets).map(function(k) {
        var b = buckets[k];
        b.score = bestTitleScore(k, meta.titles);
        return b;
      }).filter(function(b) { return b.score >= MATCH_THRESHOLD; })
        .sort(function(a, b) { return b.score - a.score; });

      console.log("[DramaCafe] Series matches:", ranked.map(function(b) { return b.key + " (" + b.score.toFixed(2) + ")"; }).join(" | ") || "none");

      // Try direct episode match in search results first
      for (var i = 0; i < ranked.length; i++) {
        var b = ranked[i];
        for (var j = 0; j < b.items.length; j++) {
          var it = b.items[j];
          if (episodeFromTitle(it.title) === wantedEp &&
              (seasonFromTitle(it.title) || 1) === wantedSeason) {
            console.log("[DramaCafe] direct episode hit:", it.title);
            return fetchPlayerSources(it.vid).then(function(sources) {
              return buildStreamsFromSources(sources, it.title);
            });
          }
        }
      }

      // Fallback: use first matching series entry
      if (ranked.length) {
        var rep = ranked[0].items[0];
        return fetchPlayerSources(rep.vid).then(function(sources) {
          return buildStreamsFromSources(sources, rep.title);
        });
      }

      return [];
    });
  }).catch(function(err) {
    console.log("[DramaCafe] TV error:", err.message);
    return [];
  });
}

// ---------------------------------------------------------------- entry point
function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[DramaCafe] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
