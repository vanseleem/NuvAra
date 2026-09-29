"use strict";

var BASE = "https://vod.q-drama.com";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function fetchText(url, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar,en-US;q=0.9,en;q=0.8"
  };
  if (referer) headers["Referer"] = referer;
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
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
  return decodeHtml(String(str || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitle(str) {
  return String(str || "").toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = normalizeTitle(a);
  b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  var aa = a.split(" ");
  var bb = b.split(" ");
  var setB = {};
  bb.forEach(function(x) { setB[x] = 1; });
  var common = 0;
  aa.forEach(function(x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var urls = ["ar", "en"].map(function(lang) {
    return "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + TMDB_API_KEY + "&language=" + lang;
  });
  return Promise.all(urls.map(function(u) {
    return fetch(u).then(function(r) { return r.json(); }).catch(function() { return null; });
  })).then(function(dataArr) {
    var titles = [];
    var year = null;
    dataArr.forEach(function(d) {
      if (!d) return;
      var t = type === "movie" ? (d.title || d.original_title) : (d.name || d.original_name);
      if (t && titles.indexOf(t) === -1) titles.push(t);
      if (!year) {
        var ds = type === "movie" ? d.release_date : d.first_air_date;
        if (ds) year = ds.slice(0, 4);
      }
    });
    console.log("[QDrama] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year };
  });
}

function searchQdrama(query) {
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(query);
  console.log("[QDrama] Search:", query);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    var re = /<a\s+href="([^"]*watch\.php\?vid=[^"]+)"\s+title="([^"]+)"/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var href = decodeHtml(m[1]);
      var title = stripHtml(m[2]);
      var abs = href.startsWith("http") ? href : BASE + "/" + href.replace(/^\//, "");
      if (seen[abs]) continue;
      seen[abs] = 1;
      results.push({ url: abs, title: title });
    }
    console.log("[QDrama] Search results:", results.length);
    return results;
  });
}

function packerUnpack(html) {
  var m = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  var payload = m[1];
  var base = parseInt(m[2], 10);
  var count = parseInt(m[3], 10);
  var keywords = m[4].split("|");
  while (count--) {
    if (keywords[count]) {
      var key = keywords[count];
      var pat = new RegExp("\\b" + count.toString(base) + "\\b", "g");
      payload = payload.replace(pat, key);
    }
  }
  return payload;
}

function extractM3u8(html) {
  var m = html.match(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/i);
  if (m) return m[0].replace(/\\\//g, "/");
  m = html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
  if (m) return m[1].replace(/\\\//g, "/");
  var unpacked = packerUnpack(html);
  if (unpacked) {
    m = unpacked.match(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/i);
    if (m) return m[0].replace(/\\\//g, "/");
    m = unpacked.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (m) return m[1].replace(/\\\//g, "/");
  }
  return null;
}

function resolveLiiivideo(embedUrl) {
  console.log("[QDrama] Liiivideo:", embedUrl);
  return fetchText(embedUrl, BASE + "/").then(function(html) {
    var m3u8 = extractM3u8(html);
    if (m3u8) {
      console.log("[QDrama] Found M3U8:", m3u8);
      return m3u8;
    }
    console.log("[QDrama] No M3U8 in liiivideo page");
    return null;
  });
}

function getStreamsFromWatchPage(watchUrl) {
  return fetchText(watchUrl, BASE + "/").then(function(html) {
    var liiMatch = html.match(/(?:https?:)?\/\/[^"'\s<>]*liiivideo[^"'\s<>]*/i);
    if (liiMatch) {
      var liiUrl = liiMatch[0];
      if (liiUrl.startsWith("//")) liiUrl = "https:" + liiUrl;
      return resolveLiiivideo(liiUrl).then(function(m3u8) {
        if (m3u8) return [m3u8];
        return [];
      });
    }

    var embedMatch = html.match(/<iframe[^>]*src=["']([^"']*embed\.php[^"']*)["']/i);
    if (embedMatch) {
      var embedUrl = decodeHtml(embedMatch[1]);
      if (!embedUrl.startsWith("http")) embedUrl = BASE + "/" + embedUrl.replace(/^\//, "");
      console.log("[QDrama] Embed URL:", embedUrl);
      return fetchText(embedUrl, watchUrl).then(function(embedHtml) {
        var liiMatch2 = embedHtml.match(/(?:https?:)?\/\/[^"'\s<>]*liiivideo[^"'\s<>]*/i);
        if (liiMatch2) {
          var liiUrl2 = liiMatch2[0];
          if (liiUrl2.startsWith("//")) liiUrl2 = "https:" + liiUrl2;
          return resolveLiiivideo(liiUrl2).then(function(m3u8) {
            if (m3u8) return [m3u8];
            return [];
          });
        }
        return [];
      });
    }

    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[QDrama] getStreams:", tmdbId, mediaType, season, episode);
  return getTmdbTitles(tmdbId, mediaType).then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchQdrama(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      console.log("[QDrama] Unique results:", all.length);

      var wanted = Number(episode) || 1;
      var candidates = all.filter(function(r) {
        var s = 0;
        meta.titles.forEach(function(t) {
          var sc = similarity(r.title, t);
          if (sc > s) s = sc;
        });
        return s >= 0.5;
      });

      if (mediaType === "tv") {
        var epMatch = candidates.filter(function(r) {
          var m = r.title.match(/الحلق[ةه]\s*(\d+)/i);
          return m && Number(m[1]) === wanted;
        });
        if (epMatch.length) candidates = epMatch;
      }

      if (!candidates.length) return [];

      var chain = Promise.resolve([]);
      candidates.slice(0, 3).forEach(function(c) {
        chain = chain.then(function(streams) {
          if (streams.length) return streams;
          return getStreamsFromWatchPage(c.url).then(function(urls) {
            return urls.map(function(u, i) {
              return {
                name: "⚜️ QDrama",
                title: "⚜️ QDrama • Auto",
                url: u,
                quality: "Auto",
                referer: BASE + "/"
              };
            });
          });
        });
      });
      return chain;
    });
  }).catch(function(err) {
    console.log("[QDrama] Error:", err.message);
    return [];
  });
}

module.exports = { getStreams: getStreams };
