var BASE = "https://akwam.ss";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
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
  return decodeHtml(String(str || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  a = normalizeTitle(a);
  b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  var aa = new Set(a.split(" "));
  var bb = new Set(b.split(" "));
  var common = 0;
  aa.forEach(function(x) { if (bb.has(x)) common++; });
  return common / Math.max(aa.size, bb.size);
}

function getSearchTitle(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  var titles = [];
  var year = null;
  return langs.reduce(function(chain, lang) {
    return chain.then(function() {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
      return fetchText(apiUrl).then(function(text) {
        try {
          var data = JSON.parse(text);
          var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
          if (title && titles.indexOf(title) === -1) titles.push(title);
          if (!year) {
            var dateStr = type === "movie" ? data.release_date : data.first_air_date;
            if (dateStr) year = dateStr.slice(0, 4);
          }
        } catch (e) {}
      }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    console.log("[Akwam] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year, title: titles[0] };
  });
}

function extractSearchResults(html) {
  var results = [];
  var seen = new Set();
  var re = /<a\b[^>]*href=["']([^"']*\/(?:movie|series)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = decodeHtml(m[1]);
    var block = m[2];
    if (seen.has(url)) continue;
    var title = "";
    var titleMatch = block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
      block.match(/class=["'][^"']*(?:entry-title|title|text-white)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
    if (titleMatch) title = stripHtml(titleMatch[1]);
    if (!title || title === "-->" || title.length < 2) {
      var pathMatch = url.match(/\/(?:movie|series)\/[^\/]+\/([^?#"']+)/i);
      if (pathMatch) {
        try { title = decodeURIComponent(pathMatch[1]); } catch (e) { title = pathMatch[1]; }
        title = title.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    if (!title || title === "-->" || title.length < 2) continue;
    var absolute = url.startsWith("http") ? url : BASE + url;
    seen.add(url);
    results.push({ url: absolute, title: title });
  }
  return results;
}

function searchAkwam(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/search?q=" + encodeURIComponent(cleanTitle);
  console.log("[Akwam] Search:", url);
  return fetchText(url, BASE).then(function(html) {
    var results = extractSearchResults(html);
    console.log("[Akwam] Search results for", title + ":", results.length);
    return results;
  });
}

function getCandidatePage(url) {
  return fetchText(url, BASE).then(function(html) {
    var title = "";
    var m = html.match(/<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
    if (!m) m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) title = stripHtml(m[1]);
    var year = null;
    m = html.match(/\b(19[0-9]{2}|20[0-9]{2})\b/);
    if (m) year = m[1];
    return { url: url, title: title, year: year, html: html };
  });
}

function chooseResult(results, meta) {
  if (!results || !results.length) return Promise.resolve(null);
  var candidates = [];
  return Promise.all(results.map(function(result) {
    return getCandidatePage(result.url).then(function(page) {
      candidates.push(page);
      console.log("[Akwam] Candidate page:", page.title || result.title, "year:", page.year || "?");
      return page;
    }).catch(function() { return null; });
  })).then(function() {
    var best = null;
    var bestScore = 0;
    candidates.forEach(function(candidate) {
      if (!candidate) return;
      var titleScore = 0;
      meta.titles.forEach(function(tmdbTitle) {
        var score = similarity(candidate.title, tmdbTitle);
        if (score > titleScore) titleScore = score;
      });
      var yearScore = 0;
      if (meta.year && candidate.year && String(meta.year) === String(candidate.year)) yearScore = 0.25;
      var total = titleScore + yearScore;
      console.log("[Akwam] Match:", candidate.title, "title:", titleScore.toFixed(3), "year:", yearScore ? "MATCH" : "NO", "total:", total.toFixed(3));
      if (total > bestScore) { bestScore = total; best = candidate; }
    });
    if (!best || bestScore < 0.80) {
      console.log("[Akwam] No safe title match. Best score:", bestScore.toFixed(3));
      return null;
    }
    console.log("[Akwam] SAFE SELECT:", best.title, best.url, "score:", bestScore.toFixed(3));
    return best;
  });
}

function extractWatchUrls(html) {
  var urls = [];
  var seen = new Set();
  var re = /href=["']([^"']*\/watch\/[^"']+)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = decodeHtml(m[1]);
    var absolute = url.startsWith("http") ? url : BASE + url;
    if (!seen.has(absolute)) { seen.add(absolute); urls.push(absolute); }
  }
  return urls;
}

function extractSources(html) {
  var streams = [];
  var seen = new Set();
  var re = /<source\b[^>]*>/gi;
  var tag;
  while ((tag = re.exec(html)) !== null) {
    var source = tag[0];
    var srcMatch = source.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    var url = decodeHtml(srcMatch[1]).trim();
    if (!url) continue;
    if (url.startsWith("//")) url = "https:" + url;
    else if (url.startsWith("/")) url = BASE + url;
    if (seen.has(url)) continue;
    seen.add(url);
    var qualityMatch = source.match(/\bsize=["']([^"']+)["']/i) || source.match(/\blabel=["']([^"']+)["']/i);
    var quality = qualityMatch ? qualityMatch[1] : "Unknown";
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
    if (Array.isArray(g)) {
      g.forEach(function(x) { out.push(x); });
    }
  });
  return out;
}

function getMovieStreams(tmdbId) {
  return getSearchTitle(tmdbId, "movie").then(function(meta) {
    var searches = meta.titles.slice();
    return Promise.all(searches.map(function(title) {
      return searchAkwam(title).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = new Set();
      groups.forEach(function(group) {
        group.forEach(function(result) {
          if (!seen.has(result.url)) { seen.add(result.url); all.push(result); }
        });
      });
      console.log("[Akwam] Unique candidates:", all.length);
      return chooseResult(all, meta);
    }).then(function(result) {
      if (!result) return [];
      return Promise.resolve(result.html).then(function(html) {
        var watchUrls = extractWatchUrls(html);
        console.log("[Akwam] Watch pages:", watchUrls.length);
        return Promise.all(watchUrls.map(function(watchUrl) {
          return fetchText(watchUrl, result.url).then(function(watchHtml) {
            return extractSources(watchHtml);
          }).catch(function() { return []; });
        }));
      }).then(flattenOnce);
    });
  }).catch(function(err) {
    console.error("[Akwam] Movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  return getSearchTitle(tmdbId, "tv").then(function(meta) {
    console.log("[Akwam] TV search titles:", meta.titles.join(" | "), "year:", meta.year || "?");
    return Promise.all(meta.titles.map(function(title) {
      return searchAkwam(title).catch(function(err) {
        console.error("[Akwam] TV search failed:", title, err.message);
        return [];
      });
    })).then(function(groups) {
      var results = [];
      var seen = new Set();
      groups.forEach(function(group) {
        group.forEach(function(result) {
          if (!seen.has(result.url)) { seen.add(result.url); results.push(result); }
        });
      });
      console.log("[Akwam] TV unique candidates:", results.length);

      var _wantS = Number(season) || 1;
      var _AR = {
        'الاول': 1, 'الاولي': 1, 'الأول': 1, 'الأولى': 1,
        'الثاني': 2, 'الثانية': 2,
        'الثالث': 3, 'الثالثة': 3,
        'الرابع': 4, 'الرابعة': 4,
        'الخامس': 5, 'الخامسة': 5,
        'السادس': 6, 'السادسة': 6,
        'السابع': 7, 'السابعة': 7,
        'الثامن': 8, 'الثامنة': 8,
        'التاسع': 9, 'التاسعة': 9,
        'العاشر': 10, 'العاشرة': 10
      };
      function _sOf(t) {
        var m = String(t || '').match(/الموسم\s+(\S+)/);
        if (!m) return null;
        if (_AR[m[1]] != null) return _AR[m[1]];
        var n = Number(m[1]);
        return isNaN(n) ? null : n;
      }
      var _explicit = results.filter(function(r) { return _sOf(r.title) === _wantS; });
      if (_explicit.length > 0) {
        results = _explicit;
        console.log("[Akwam] TV season filter: S" + _wantS + " -> " + results.length + " EXACT candidates");
      }

      return chooseResult(results, meta);
    }).then(function(result) {
      if (!result) {
        console.log("[Akwam] TV: no safe series match");
        return [];
      }
      console.log("[Akwam] TV selected:", result.title, result.url);
      return fetchText(result.url, BASE).then(function(html) {
        var episodeLinks = [];
        var seen = new Set();
        var re = /href=["']([^"']*\/episode\/[^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
          var url = decodeHtml(m[1]);
          var absolute = url.startsWith("http") ? url : BASE + url;
          if (!seen.has(absolute)) { seen.add(absolute); episodeLinks.push(absolute); }
        }
        console.log("[Akwam] TV episode links:", episodeLinks.length);

        var wanted = Number(episode) || 1;

        function _dec(u) { try { return decodeURIComponent(u); } catch (e) { return u; } }
        function _eNum(u) {
          var d = _dec(u);
          var mm = d.match(/الحلق[ةه][^0-9]*([0-9]+)/i);
          if (mm) return Number(mm[1]);
          return null;
        }
        var _withN = episodeLinks.filter(function(u) { return _eNum(u) !== null; });
        var selected = [];
        if (_withN.length > 0) {
          selected = _withN.filter(function(u) { return _eNum(u) === wanted; });
          console.log("[Akwam] TV ep method 1 (Arabic): " + selected.length + " of " + _withN.length);
        }
        if (!selected.length && episodeLinks.length >= wanted) {
          var _byId = episodeLinks.map(function(u) {
            var mm = u.match(/\/episode\/([0-9]+)/);
            return { url: u, id: mm ? Number(mm[1]) : 0 };
          });
          _byId.sort(function(a, b) { return a.id - b.id; });
          selected = [_byId[wanted - 1].url];
          console.log("[Akwam] TV ep fallback (sorted by ID): E" + wanted + " = " + selected[0]);
        }

        if (!selected.length) {
          console.log("[Akwam] TV: requested episode not found:", wanted);
          return [];
        }

        return Promise.all(selected.map(function(url) {
          console.log("[Akwam] TV episode page:", url);
          return fetchText(url, result.url).then(function(epHtml) {
            var watchUrls = extractWatchUrls(epHtml);
            console.log("[Akwam] TV watch pages:", watchUrls.length);
            return Promise.all(watchUrls.map(function(watchUrl) {
              return fetchText(watchUrl, url).then(function(watchHtml) {
                var sources = extractSources(watchHtml);
                console.log("[Akwam] TV sources:", sources.length);
                return sources;
              }).catch(function(err) {
                console.error("[Akwam] Watch page failed:", err.message);
                return [];
              });
            })).then(flattenOnce);
          }).catch(function(err) {
            console.error("[Akwam] Episode page failed:", err.message);
            return [];
          });
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
  if (mediaType === "tv") {
    return getTvStreams(tmdbId, season, episode);
  }
  return getMovieStreams(tmdbId);
}

module.exports = {
  getStreams: getStreams
};
