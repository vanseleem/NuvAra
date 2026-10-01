/**
 * Dramacafe ☕ — Nuvio Provider (Hybrid / Fixed)
 *
 * Real site flow (verified):
 *   TMDB title -> search.php?keywords= -> watch.php?vid=XXXX
 *     -> pm_video_data.embed_url -> embed.php?vid=XXXX
 *     -> iframe -> external player (vidspeed / streamtape / etc.)
 *     -> m3u8 / mp4
 *
 * Fallback: if direct stream can't be extracted, returns the embed iframe URL
 * so Nuvio still shows a playable entry.
 */

var BASE = "https://ddramacafe-tv.bar";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_KEY = "83d364331c40bfbe29858aeed82f45cc";

/* ------------------------------------------------------------------ */
/*  UTILITIES                                                          */
/* ------------------------------------------------------------------ */

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function (c) {
    return encodeURIComponent(c);
  });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (referer) {
    headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function (c) {
      return encodeURIComponent(c);
    });
  }
  return fetch(url, { headers: headers, redirect: "follow" }).then(function (r) {
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
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/");
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
  bb.forEach(function (x) { setB[x] = 1; });
  var common = 0;
  aa.forEach(function (x) { if (setB[x]) common++; });
  return common / Math.max(aa.length, bb.length);
}

function originOf(url) {
  var m = String(url || "").match(/^(https?:\/\/[^\/]+)/i);
  return m ? m[1] : "";
}

function absolute(url, base) {
  if (!url) return "";
  url = decodeHtml(url);
  if (url.indexOf("http") === 0) return url;
  if (url.indexOf("//") === 0) return "https:" + url;
  if (url.indexOf("/") === 0) return originOf(base || BASE) + url;
  return originOf(base || BASE) + "/" + url;
}

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  return "Auto";
}

function makeStream(url, label, playerUrl) {
  var origin = originOf(playerUrl) || BASE;
  var streamReferer = origin + "/";
  if (url.indexOf("http://") === 0) url = "https://" + url.slice(7);
  return {
    name: "☕ DramaCafe",
    title: label ? "☕ DramaCafe • " + label : "☕ DramaCafe",
    url: url,
    quality: qualityFromUrl(url),
    referer: streamReferer,
    headers: {
      "User-Agent": UA,
      "Referer": streamReferer,
      "Origin": origin,
      "Accept": "*/*"
    }
  };
}

/* ------------------------------------------------------------------ */
/*  TMDB TITLES                                                       */
/* ------------------------------------------------------------------ */

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  var titles = [];

  return langs.reduce(function (chain, lang) {
    return chain.then(function () {
      var apiUrl = "https://api.themoviedb.org/3/" + type + "/" +
        encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&language=" + lang;
      return fetch(apiUrl)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var title = type === "movie"
            ? (data.title || data.original_title)
            : (data.name || data.original_name);
          if (title && titles.indexOf(title) === -1) titles.push(title);
        })
        .catch(function () {});
    });
  }, Promise.resolve()).then(function () {
    if (!titles.length) throw new Error("No TMDB titles for " + tmdbId);
    console.log("[DramaCafe] TMDB titles:", titles.join(" | "));
    return titles;
  });
}

/* ------------------------------------------------------------------ */
/*  SEARCH  (search.php?keywords=)                                     */
/* ------------------------------------------------------------------ */

function searchDramaCafe(title) {
  var cleanTitle = String(title || "")
    .replace(/[:\u060C-\u061F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(cleanTitle);
  console.log("[DramaCafe] Search:", cleanTitle);

  return fetchText(url, BASE + "/").then(function (html) {
    var results = [];
    var seen = {};

    // Primary: <a href=".../watch.php?vid=XXX" title="...">
    var re = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*title=["']([^"']+)["'][^>]*>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var fullUrl = absolute(m[1], BASE);
      var vid = m[2];
      var linkTitle = decodeHtml(m[3]);
      if (seen[vid]) continue;
      seen[vid] = 1;
      results.push({ url: fullUrl, title: linkTitle, vid: vid });
    }

    // Fallback: anchor without title attr
    if (!results.length) {
      var re2 = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*>/gi;
      while ((m = re2.exec(html)) !== null) {
        var fullUrl2 = absolute(m[1], BASE);
        var vid2 = m[2];
        if (seen[vid2]) continue;
        seen[vid2] = 1;
        // Try to grab inner text as title
        var inner = m[0].replace(/<[^>]+>/g, " ").trim();
        results.push({ url: fullUrl2, title: inner || vid2, vid: vid2 });
      }
    }

    console.log("[DramaCafe] Search results:", results.length);
    return results;
  });
}

function chooseResult(results, titles) {
  var best = null;
  var bestScore = 0;
  results.forEach(function (r) {
    var s = 0;
    titles.forEach(function (t) {
      var sc = similarity(r.title, t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (best) console.log("[DramaCafe] Best:", best.title, "score:", bestScore.toFixed(3));
  return bestScore >= 0.3 ? best : null;
}

/* ------------------------------------------------------------------ */
/*  WATCH PAGE -> embed_url (from pm_video_data)                       */
/* ------------------------------------------------------------------ */

function getEmbedUrl(watchUrl) {
  return fetchText(watchUrl, BASE + "/").then(function (html) {
    // pm_video_data = { ... embed_url: "https://.../embed.php?vid=XXXX" ... }
    var m = html.match(/embed_url\s*:\s*["']([^"']+)["']/i);
    if (m) {
      var u = decodeHtml(m[1]);
      console.log("[DramaCafe] embed_url:", u);
      return u;
    }
    // Fallback: link rel=embedURL
    m = html.match(/<link[^>]+itemprop=["']embedURL["'][^>]+href=["']([^"']+)["']/i);
    if (m) return absolute(m[1], watchUrl);
    // Fallback: construct from vid
    var v = watchUrl.match(/vid=([^&]+)/);
    if (v) return BASE + "/embed.php?vid=" + v[1];
    throw new Error("No embed_url found");
  });
}

/* ------------------------------------------------------------------ */
/*  EMBED PAGE -> external iframe player URL                           */
/* ------------------------------------------------------------------ */

function getPlayerIframe(embedUrl) {
  return fetchText(embedUrl, BASE + "/").then(function (html) {
    var m = html.match(/<iframe[^>]*src=["']([^"']+)["']/i);
    if (m) {
      var u = absolute(m[1], embedUrl);
      console.log("[DramaCafe] player iframe:", u);
      return u;
    }
    // Fallback: contentUrl meta
    m = html.match(/contentUrl["'][^>]*content=["']([^"']+)["']/i);
    if (m) {
      var u2 = absolute(m[1], embedUrl);
      console.log("[DramaCafe] player contentUrl:", u2);
      return u2;
    }
    throw new Error("No player iframe found");
  });
}

/* ------------------------------------------------------------------ */
/*  EXTERNAL PLAYER -> m3u8 / mp4                                      */
/* ------------------------------------------------------------------ */

function unpackEval(html) {
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
      payload = payload.replace(pat, function () { return key; });
    }
  }
  return payload;
}

function extractStreamsFromPlayer(playerHtml) {
  var streams = [];
  var seen = {};
  var search = unpackEval(playerHtml) || playerHtml;

  // 1. Direct m3u8 / mp4 URLs
  var re = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
  var m;
  while ((m = re.exec(search)) !== null) {
    var u = m[0].replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    if (seen[u]) continue;
    seen[u] = 1;
    streams.push(u);
  }

  // 2. JS assignments: file: "...", source: "...", src: "..."
  var re2 = /(?:file|source|src|url|playlist)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi;
  while ((m = re2.exec(search)) !== null) {
    var u2 = m[1].replace(/\\\//g, "/");
    if (u2.indexOf("http") !== 0) continue;
    if (seen[u2]) continue;
    seen[u2] = 1;
    streams.push(u2);
  }

  // 3. JW Player setup: sources: [{ file: "..." }]
  var re3 = /sources\s*:\s*\[([^\]]+)\]/i;
  var sm = re3.exec(search);
  if (sm) {
    var inner = sm[1];
    var re4 = /["']file["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi;
    var m4;
    while ((m4 = re4.exec(inner)) !== null) {
      var u3 = m4[1].replace(/\\\//g, "/");
      if (seen[u3]) continue;
      seen[u3] = 1;
      streams.push(u3);
    }
  }

  // 4. Base64-encoded m3u8 (atob)
  var b64re = /atob\(\s*["']([A-Za-z0-9+/=]{40,})["']\s*\)/g;
  var b;
  while ((b = b64re.exec(search)) !== null) {
    try {
      var dec = decodeBase64(b[1]);
      var inner2 = /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)[^\s"'<>\\]*/i.exec(dec);
      if (inner2 && !seen[inner2[0]]) {
        seen[inner2[0]] = 1;
        streams.push(inner2[0]);
      }
    } catch (e) {}
  }

  console.log("[DramaCafe] streams found:", streams.length);
  return streams;
}

function decodeBase64(str) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var out = "";
  var i = 0;
  str = str.replace(/=+$/, "");
  while (i < str.length) {
    var c1 = chars.indexOf(str.charAt(i++));
    var c2 = chars.indexOf(str.charAt(i++));
    var c3 = chars.indexOf(str.charAt(i++));
    var c4 = chars.indexOf(str.charAt(i++));
    out += String.fromCharCode((c1 << 2) | (c2 >> 4));
    if (c3 !== 64 && c3 !== -1) out += String.fromCharCode(((c2 & 15) << 4) | (c3 >> 2));
    if (c4 !== 64 && c4 !== -1) out += String.fromCharCode(((c3 & 3) << 6) | c4);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  RESOLVE ONE CANDIDATE                                              */
/* ------------------------------------------------------------------ */

function resolveCandidate(candidate) {
  var watchUrl = candidate.url;

  return getEmbedUrl(watchUrl)
    .then(function (embedUrl) {
      return getPlayerIframe(embedUrl).then(function (playerUrl) {
        return fetchText(playerUrl, embedUrl).then(function (playerHtml) {
          var directUrls = extractStreamsFromPlayer(playerHtml);
          if (directUrls.length) {
            return directUrls.map(function (u, i) {
              return makeStream(u, "Server " + (i + 1), playerUrl);
            });
          }
          // Fallback: return the embed iframe URL as an iframe entry
          console.log("[DramaCafe] No direct URL — returning embed fallback");
          return [{
            name: "☕ DramaCafe",
            title: "☕ DramaCafe (Embed)",
            url: playerUrl,
            quality: "Auto",
            type: "iframe",
            referer: embedUrl
          }];
        });
      }).catch(function (err) {
        console.log("[DramaCafe] player failed:", err.message);
        return [{
          name: "☕ DramaCafe",
          title: "☕ DramaCafe (Embed)",
          url: embedUrl,
          quality: "Auto",
          type: "iframe",
          referer: watchUrl
        }];
      });
    })
    .catch(function (err) {
      console.log("[DramaCafe] embed failed:", err.message);
      return [];
    });
}

/* ------------------------------------------------------------------ */
/*  MOVIE / TV FLOWS                                                   */
/* ------------------------------------------------------------------ */

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function (titles) {
    return Promise.all(titles.map(function (t) {
      return searchDramaCafe(t).catch(function () { return []; });
    })).then(function (groups) {
      var all = [];
      var seen = {};
      groups.forEach(function (g) {
        g.forEach(function (r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      console.log("[DramaCafe] Unique movie candidates:", all.length);
      if (!all.length) return [];
      var best = chooseResult(all, titles);
      if (!best) return [];
      return resolveCandidate(best);
    });
  }).catch(function (err) {
    console.log("[DramaCafe] Movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var wanted = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function (titles) {
    var searches = [];
    titles.forEach(function (t) {
      // Arabic + numeric episode variants (site uses both)
      searches.push(t + " الحلقة " + wanted);
      searches.push(t + " " + wanted);
      searches.push(t);
    });

    return Promise.all(searches.map(function (q) {
      return searchDramaCafe(q).catch(function () { return []; });
    })).then(function (groups) {
      var all = [];
      var seen = {};
      groups.forEach(function (g) {
        g.forEach(function (r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      console.log("[DramaCafe] Unique TV candidates:", all.length);

      // Prefer results that mention the episode number
      var withEp = all.filter(function (r) {
        return new RegExp("(?:الحلق[ةه]\\s*" + wanted + "\\b|\\b" + wanted + "\\b)", "i")
          .test(r.title);
      });
      var pool = withEp.length ? withEp : all;
      console.log("[DramaCafe] TV candidates with ep " + wanted + ":", withEp.length, "/ pool:", pool.length);

      if (!pool.length) return [];
      var best = chooseResult(pool, titles);
      if (!best) return [];
      return resolveCandidate(best);
    });
  }).catch(function (err) {
    console.log("[DramaCafe] TV error:", err.message);
    return [];
  });
}

/* ------------------------------------------------------------------ */
/*  ENTRY POINT                                                        */
/* ------------------------------------------------------------------ */

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[DramaCafe] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
