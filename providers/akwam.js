var BASE = "https://akwam.ss";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

var _CACHE = { data: {}, ttl: 5 * 60 * 1000 };
function _cGet(k) {
  var e = _CACHE.data[k];
  if (!e) return null;
  if (Date.now() - e.t > _CACHE.ttl) { delete _CACHE.data[k]; return null; }
  return e.v;
}
function _cSet(k, v) {
  _CACHE.data[k] = { t: Date.now(), v: v };
  return v;
}

var _AR_SEASONS = {
  'الاول': 1, 'الاولي': 1, 'الأول': 1, 'الأولى': 1,
  'الثاني': 2, 'الثانية': 2, 'الثالث': 3, 'الثالثة': 3,
  'الرابع': 4, 'الرابعة': 4, 'الخامس': 5, 'الخامسة': 5,
  'السادس': 6, 'السادسة': 6, 'السابع': 7, 'السابعة': 7,
  'الثامن': 8, 'الثامنة': 8, 'التاسع': 9, 'التاسعة': 9,
  'العاشر': 10, 'العاشرة': 10
};
function _parseSeason(t) {
  var m = String(t || '').match(/الموسم\s+(\S+)/);
  if (!m) return null;
  if (_AR_SEASONS[m[1]] != null) return _AR_SEASONS[m[1]];
  var n = Number(m[1]);
  return isNaN(n) ? null : n;
}

function _rawFetch(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function fetchText(url, referer) {
  var key = "p:" + url;
  var c = _cGet(key);
  if (c) { console.log("[Akwam] page cached:", url.slice(-40)); return Promise.resolve(c); }
  return _rawFetch(url, referer).then(function(t) { _cSet(key, t); return t; });
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(str) {
  return decodeHtml(String(str || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitle(str) {
  return String(str || "").toLowerCase().replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ").replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = normalizeTitle(a);
  b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
  var aa = a.split(" ");
  var bb = b.split(" ");
  var setB = {};
  bb.forEach(function(x) { setB[x] = 1; });
  var common = 0;
  aa.forEach(function(x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

function getSearchTitle(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var urls = ["ar", "en"].map(function(lang) {
    return "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
  });
  // PARALLEL TMDB lookups
  return Promise.all(urls.map(function(u) {
    var c = _cGet("tmdb:" + u);
    if (c) return Promise.resolve(c);
    return _rawFetch(u).then(function(text) {
      try { var d = JSON.parse(text); _cSet("tmdb:" + u, d); return d; }
      catch (e) { return null; }
    }).catch(function() { return null; });
  })).then(function(dataArr) {
    var titles = [];
    var year = null;
    dataArr.forEach(function(data) {
      if (!data) return;
      var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
      if (title && titles.indexOf(title) === -1) titles.push(title);
      if (!year) {
        var ds = type === "movie" ? data.release_date : data.first_air_date;
        if (ds) year = ds.slice(0, 4);
      }
    });
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    console.log("[Akwam] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year, title: titles[0] };
  });
}

function extractSearchResults(html) {
  var results = [];
  var seen = {};
  var re = /<a\b[^>]*href=["']([^"']*\/(?:movie|series)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = decodeHtml(m[1]);
    var block = m[2];
    if (seen[url]) continue;
    var title = "";
    var titleMatch = block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
      block.match(/class=["'][^"']*(?:entry-title|title|text-white)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
    if (titleMatch) title = stripHtml(titleMatch[1]);
    if (!title || title === "-->" || title.length < 2) {
      var pm = url.match(/\/(?:movie|series)\/[^\/]+\/([^?#"']+)/i);
      if (pm) {
        try { title = decodeURIComponent(pm[1]); } catch (e) { title = pm[1]; }
        title = title.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    if (!title || title === "-->" || title.length < 2) continue;
    var abs = url.indexOf("http") === 0 ? url : BASE + url;
    seen[url] = 1;
    results.push({ url: abs, title: title });
  }
  return results;
}

function searchAkwam(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/search?q=" + encodeURIComponent(cleanTitle);
  var c = _cGet("s:" + url);
  if (c) { console.log("[Akwam] search cached:", title, c.length); return Promise.resolve(c); }
  console.log("[Akwam] Search:", title);
  return _rawFetch(url, BASE).then(function(html) {
    var results = extractSearchResults(html);
    console.log("[Akwam] results:", title, results.length);
    _cSet("s:" + url, results);
    return results;
  });
}

// Return { url, title, html } — html may be null for fast path
function inspectCandidate(candidate) {
  return fetchText(candidate.url, BASE).then(function(html) {
    var title = "";
    var m = html.match(/<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
    if (!m) m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) title = stripHtml(m[1]);
    var year = null;
    m = html.match(/\b(19[0-9]{2}|20[0-9]{2})\b/);
    if (m) year = m[1];
    return { url: candidate.url, title: title, year: year, html: html };
  });
}

function chooseResult(results, meta) {
  if (!results || !results.length) return Promise.resolve(null);

  // === FAST PATH: score from search titles, skip page fetch ===
  var quickBest = null;
  var quickScore = 0;
  results.forEach(function(r) {
    var titleScore = 0;
    meta.titles.forEach(function(t) {
      var s = similarity(r.title, t);
      if (s > titleScore) titleScore = s;
    });
    if (titleScore > quickScore) { quickScore = titleScore; quickBest = r; }
  });
  if (quickBest && quickScore >= 0.85) {
    console.log("[Akwam] FAST SELECT:", quickBest.title, "score:", quickScore.toFixed(3));
    // Return without fetching HTML — caller will fetch once
    return Promise.resolve({ url: quickBest.url, title: quickBest.title, html: null, _fast: true });
  }
  // === end fast path ===

  // Slow path: inspect all candidates
  return Promise.all(results.map(function(r) {
    return inspectCandidate(r).catch(function() { return null; });
  })).then(function(candidates) {
    var best = null;
    var bestScore = 0;
    candidates.forEach(function(c) {
      if (!c) return;
      var titleScore = 0;
      meta.titles.forEach(function(t) {
        var s = similarity(c.title, t);
        if (s > titleScore) titleScore = s;
      });
      var yearScore = 0;
      if (meta.year && c.year && String(meta.year) === String(c.year)) yearScore = 0.25;
      var total = titleScore + yearScore;
      console.log("[Akwam] Match:", c.title, "score:", total.toFixed(3));
      if (total > bestScore) { bestScore = total; best = c; }
    });
    if (!best || bestScore < 0.80) {
      console.log("[Akwam] No safe match. Best:", bestScore.toFixed(3));
      return null;
    }
    console.log("[Akwam] SAFE SELECT:", best.title, "score:", bestScore.toFixed(3));
    return best;
  });
}

function extractWatchUrls(html) {
  var urls = [];
  var seen = {};
  var re = /href=["']([^"']*\/watch\/[^"']+)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = decodeHtml(m[1]);
    var abs = url.indexOf("http") === 0 ? url : BASE + url;
    if (!seen[abs]) { seen[abs] = 1; urls.push(abs); }
  }
  return urls;
}

function extractSources(html) {
  var streams = [];
  var seen = {};
  var re = /<source\b[^>]*>/gi;
  var tag;
  while ((tag = re.exec(html)) !== null) {
    var source = tag[0];
    var srcMatch = source.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    var url = decodeHtml(srcMatch[1]).trim();
    if (!url) continue;
    if (url.indexOf("//") === 0) url = "https:" + url;
    else if (url.indexOf("/") === 0) url = BASE + url;
    if (seen[url]) continue;
    seen[url] = 1;
    var qm = source.match(/\bsize=["']([^"']+)["']/i) || source.match(/\blabel=["']([^"']+)["']/i);
    var quality = qm ? qm[1] : "Unknown";
    streams.push({
      name: "Akwam",
      title: quality === "Unknown" ? "Akwam" : "Akwam " + quality,
      url: url,
      quality: quality
    });
  }
  return streams;
}

function flattenOnce(groups) {
  var out = [];
  groups.forEach(function(g) {
    if (Array.isArray(g)) g.forEach(function(x) { out.push(x); });
  });
  return out;
}

function getMovieStreams(tmdbId) {
  return getSearchTitle(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchAkwam(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      console.log("[Akwam] movie candidates:", all.length);
      return chooseResult(all, meta);
    }).then(function(result) {
      if (!result) return [];
      var htmlPromise = result.html ? Promise.resolve(result.html) : fetchText(result.url, BASE);
      return htmlPromise.then(function(html) {
        var watchUrls = extractWatchUrls(html);
        console.log("[Akwam] Watch pages:", watchUrls.length);
        return Promise.all(watchUrls.map(function(wu) {
          return fetchText(wu, result.url).then(extractSources).catch(function() { return []; });
        }));
      }).then(flattenOnce);
    });
  }).catch(function(err) {
    console.error("[Akwam] Movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var _wantS = Number(season) || 1;
  return getSearchTitle(tmdbId, "tv").then(function(meta) {
    console.log("[Akwam] TV titles:", meta.titles.join(" | "), meta.year || "?");
    return Promise.all(meta.titles.map(function(t) {
      return searchAkwam(t).catch(function() { return []; });
    })).then(function(groups) {
      var results = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; results.push(r); }
        });
      });
      console.log("[Akwam] TV candidates:", results.length);

      // Pre-filter season BEFORE inspection
      var _explicit = results.filter(function(r) { return _parseSeason(r.title) === _wantS; });
      if (_explicit.length > 0) {
        results = _explicit;
        console.log("[Akwam] TV pre-filter S" + _wantS + " ->", results.length);
      }

      return chooseResult(results, meta);
    }).then(function(result) {
      if (!result) { console.log("[Akwam] TV: no match"); return []; }
      console.log("[Akwam] TV selected:", result.title);
      // Reuse HTML if we already have it, otherwise fetch once
      var htmlPromise = result.html ? Promise.resolve(result.html) : fetchText(result.url, BASE);
      return htmlPromise.then(function(html) {
        var episodeLinks = [];
        var seen = {};
        var re = /href=["']([^"']*\/episode\/[^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
          var url = decodeHtml(m[1]);
          var abs = url.indexOf("http") === 0 ? url : BASE + url;
          if (!seen[abs]) { seen[abs] = 1; episodeLinks.push(abs); }
        }
        console.log("[Akwam] episodes:", episodeLinks.length);

        var wanted = Number(episode) || 1;
        function _dec(u) { try { return decodeURIComponent(u); } catch (e) { return u; } }
        function _eNum(u) {
          var d = _dec(u);
          var mm = d.match(/الحلق[ةه][^0-9]*([0-9]+)/i);
          return mm ? Number(mm[1]) : null;
        }
        var _withN = episodeLinks.filter(function(u) { return _eNum(u) !== null; });
        var selected = [];
        if (_withN.length > 0) selected = _withN.filter(function(u) { return _eNum(u) === wanted; });
        if (!selected.length && episodeLinks.length >= wanted) {
          var _byId = episodeLinks.map(function(u) {
            var mm = u.match(/\/episode\/([0-9]+)/);
            return { url: u, id: mm ? Number(mm[1]) : 0 };
          });
          _byId.sort(function(a, b) { return a.id - b.id; });
          selected = [_byId[wanted - 1].url];
          console.log("[Akwam] ep fallback E" + wanted);
        }
        if (!selected.length) { console.log("[Akwam] ep not found:", wanted); return []; }

        return Promise.all(selected.map(function(url) {
          return fetchText(url, result.url).then(function(epHtml) {
            var watchUrls = extractWatchUrls(epHtml);
            console.log("[Akwam] watch pages:", watchUrls.length);
            return Promise.all(watchUrls.map(function(wu) {
              return fetchText(wu, url).then(function(wHtml) {
                var s = extractSources(wHtml);
                console.log("[Akwam] sources:", s.length);
                return s;
              }).catch(function() { return []; });
            })).then(flattenOnce);
          }).catch(function() { return []; });
        })).then(flattenOnce);
      });
    });
  }).catch(function(err) {
    console.error("[Akwam] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[Akwam] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
