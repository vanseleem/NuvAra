var BASE = "https://mycima.living";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

// Paste your cf_clearance cookie here — get it from browser dev tools
// When this expires, MyCima stops working
var _cfCookie = null;

function encodeUrl(u) {
  return String(u).replace(/[^\x00-\x7F]/g, function(c) {
    return encodeURIComponent(c);
  });
}

function fetchText(url, referer) {
  url = encodeUrl(url);
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar,en-US;q=0.9,en;q=0.8"
  };
  if (referer) headers["Referer"] = encodeUrl(referer);
  if (_cfCookie) headers["Cookie"] = _cfCookie;

  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    try {
      var sc = r.headers.get("set-cookie");
      if (sc) {
        var m = sc.match(/cf_clearance=([^;]+)/);
        if (m) _cfCookie = "cf_clearance=" + m[1];
      }
    } catch (e) {}
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
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
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
    return "https://api.themoviedb.org/3/" + type + "/" +
      encodeURIComponent(tmdbId) +
      "?api_key=" + TMDB_API_KEY + "&language=" + lang;
  });
  return Promise.all(urls.map(function(u) {
    return fetch(u).then(function(r) { return r.json(); }).catch(function() { return null; });
  })).then(function(dataArr) {
    var titles = [];
    var year = null;
    dataArr.forEach(function(data) {
      if (!data) return;
      var title = type === "movie"
        ? (data.title || data.original_title)
        : (data.name || data.original_name);
      if (title && titles.indexOf(title) === -1) titles.push(title);
      if (!year) {
        var ds = type === "movie" ? data.release_date : data.first_air_date;
        if (ds) year = ds.slice(0, 4);
      }
    });
    console.log("[MyCima] TMDB titles:", titles.join(" | "));
    return { titles: titles, year: year };
  });
}

function searchMyCima(query) {
  var url = BASE + "/filtering/?keywords=" + encodeURIComponent(query);
  console.log("[MyCima] Search:", query);

  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    var re = /<a\b[^>]*href=["']([^"']*\/(?:watch|series)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var m;

    while ((m = re.exec(html)) !== null) {
      var itemUrl = decodeHtml(m[1]);
      if (seen[itemUrl]) continue;
      seen[itemUrl] = 1;

      var abs = itemUrl.indexOf("http") === 0 ? itemUrl : BASE + itemUrl;
      var block = m[2];
      var title = "";
      var tm = block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
      if (tm) title = stripHtml(tm[1]);
      if (!title) {
        var pm = itemUrl.match(/\/(?:watch|series)\/[^\/]+\/([^?#"']+)/i);
        if (pm) {
          try { title = decodeURIComponent(pm[1]); } catch (e) { title = pm[1]; }
          title = title.replace(/[-_]+/g, " ").trim();
        }
      }
      if (title) results.push({ url: abs, title: title });
    }
    console.log("[MyCima] results:", query, results.length);
    return results;
  }).catch(function(err) {
    console.log("[MyCima] search error:", err.message);
    return [];
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchMyCima(t);
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      if (!all.length) return [];
      var best = all[0];
      console.log("[MyCima] selected:", best.title);

      return fetchText(best.url, BASE + "/").then(function(html) {
        // Find watch links or video sources
        var streams = [];
        var re = /<source\b[^>]*src=["']([^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
          var u = decodeHtml(m[1]);
          if (u.indexOf("//") === 0) u = "https:" + u;
          else if (u.indexOf("/") === 0) u = BASE + u;
          streams.push({
            name: "MyCima",
            title: "MyCima",
            url: u,
            quality: "Unknown",
            referer: BASE + "/"
          });
        }
        // Also try data-url / data-href (base64 encoded)
        var re2 = /data-(?:url|href)=["']([^"']+)["']/gi;
        while ((m = re2.exec(html)) !== null) {
          try {
            var decoded = "";
            if (typeof atob === "function") decoded = atob(m[1].replace(/\+/g, ""));
            if (decoded && decoded.indexOf("http") === 0) {
              streams.push({
                name: "MyCima",
                title: "MyCima Server",
                url: decoded,
                quality: "Unknown",
                referer: BASE + "/"
              });
            }
          } catch (e) {}
        }
        return streams;
      });
    });
  }).catch(function(err) {
    console.log("[MyCima] movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    return Promise.all(meta.titles.map(function(t) {
      return searchMyCima(t);
    })).then(function(groups) {
      var all = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.url]) { seen[r.url] = 1; all.push(r); }
        });
      });
      if (!all.length) return [];
      var best = all[0];
      console.log("[MyCima] TV selected:", best.title);

      return fetchText(best.url, BASE + "/").then(function(html) {
        // Find episode links
        var epLinks = [];
        var re = /href=["']([^"']*\/(?:watch|episode)\/[^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
          var u = decodeHtml(m[1]);
          var abs = u.indexOf("http") === 0 ? u : BASE + u;
          if (epLinks.indexOf(abs) === -1) epLinks.push(abs);
        }

        var wanted = Number(episode) || 1;
        var selected = [];
        for (var i = 0; i < epLinks.length; i++) {
          var dec = "";
          try { dec = decodeURIComponent(epLinks[i]); } catch (e) { dec = epLinks[i]; }
          var mm = dec.match(/الحلق[ةه][^0-9]*([0-9]+)/i);
          if (mm && Number(mm[1]) === wanted) selected.push(epLinks[i]);
        }
        if (!selected.length && epLinks.length >= wanted) {
          selected = [epLinks[wanted - 1]];
        }
        if (!selected.length) return [];

        return fetchText(selected[0], best.url).then(function(epHtml) {
          var streams = [];
          var re2 = /<source\b[^>]*src=["']([^"']+)["']/gi;
          while ((m = re2.exec(epHtml)) !== null) {
            var u2 = decodeHtml(m[1]);
            if (u2.indexOf("//") === 0) u2 = "https:" + u2;
            else if (u2.indexOf("/") === 0) u2 = BASE + u2;
            streams.push({
              name: "MyCima",
              title: "MyCima",
              url: u2,
              quality: "Unknown",
              referer: BASE + "/"
            });
          }
          return streams;
        });
      });
    });
  }).catch(function(err) {
    console.log("[MyCima] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[MyCima] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
