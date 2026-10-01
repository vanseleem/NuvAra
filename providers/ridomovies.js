/**
 * RidoMovies provider
 *
 * Architecture (verified):
 *  - Search: /?s={query} → server-rendered HTML with /movies/ and /tv/ links
 *  - Movie page: /movies/{slug}-watch-online-{year}-rd{n}
 *  - TV page: /tv/{slug}-rd{n}
 *  - Player: AJAX POST to /api/player-url with data-player-token
 *  - Closeload embed: ROT13 → Base64 → Reverse decoding → m3u8
 *
 * Stream hosts: closeload.top / ridorapid.closeload.top
 */

var BASE = "https://ridomovies.tv";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var FETCH_TIMEOUT_MS = 15000;
var MATCH_THRESHOLD = 0.4;

function log(m) { console.log("[RidoMovies] " + m); }

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

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  return withTimeout(
    fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }),
    FETCH_TIMEOUT_MS
  );
}

function fetchJson(url, body, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest"
  };
  if (referer) headers["Referer"] = referer;
  return withTimeout(
    fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    }).then(function(r) { return r.json(); }),
    FETCH_TIMEOUT_MS
  );
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

function snippet(text) {
  return String(text || "").replace(/\s+/g, " ").slice(0, 200);
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
function parseListing(html) {
  var out = []; var seen = {};
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  html = String(html || "");
  while ((m = re.exec(html)) !== null) {
    var href = getAttr(m[1], "href");
    var hm = href.match(/\/(movies|tv)\/([^"?#]+)/i);
    if (!hm) continue;
    var kind = hm[1].toLowerCase() === "movies" ? "movie" : "series";
    var slug = hm[2];
    var key = kind + slug;

    var title = getAttr(m[1], "title") || "";
    if (!title) {
      var alt = m[2].match(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i);
      if (alt) title = alt[1];
    }
    if (!title) title = stripHtml(m[2]);
    title = title.replace(/\s*[-–]\s*watch online.*$/i, "").replace(/\s+rd\d+$/i, "").trim();
    if (!title || title.length < 2) continue;

    if (seen[key] !== undefined) continue;
    seen[key] = out.length;
    out.push({ slug: slug, kind: kind, url: BASE + "/" + hm[1] + "/" + slug, title: title });
  }
  return out;
}

function searchRidoMovies(title) {
  var q = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/?s=" + encodeURIComponent(q);
  log("Search: " + q);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = parseListing(html);
    log("Search results: " + results.length + " (html " + html.length + "b)");
    if (!results.length) log("Search page starts with: " + snippet(html));
    return results;
  });
}

function searchMany(titles) {
  return Promise.all(titles.map(function(t) {
    return searchRidoMovies(t).catch(function(e) {
      log("search failed: " + e.message);
      return [];
    });
  })).then(function(groups) {
    var all = []; var seen = {};
    groups.forEach(function(g) {
      g.forEach(function(r) {
        var k = r.kind + r.slug;
        if (!seen[k]) { seen[k] = 1; all.push(r); }
      });
    });
    log("Unique candidates: " + all.length);
    return all;
  });
}

function chooseResult(results, titles, wantKind) {
  var best = null; var bestScore = 0;
  results.forEach(function(r) {
    if (wantKind && r.kind !== wantKind) return;
    var s = 0;
    titles.forEach(function(t) {
      var sc = similarity(r.title, t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (best) log("Best: " + best.title + " (" + best.kind + ") score=" + bestScore.toFixed(3));
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

// ---------------------------------------------------------------- player resolution
// RidoMovies uses an AJAX endpoint: POST /api/player-url with { t: token }
// The token comes from the data-player-token attribute on the movie page.

function extractPlayerToken(html) {
  // Look for data-player-token="..." or data-player-token='...'
  var m = html.match(/data-player-token\s*=\s*["']([^"']+)["']/i);
  if (m) return m[1];
  // Look for player token in JSON config
  m = html.match(/["']playerToken["']\s*:\s*["']([^"']+)["']/i);
  if (m) return m[1];
  // Look for any data-* attribute with a token-like value
  m = html.match(/data-[a-z-]*token\s*=\s*["']([A-Za-z0-9+\/=_-]{20,})["']/i);
  if (m) return m[1];
  return null;
}

function extractModelAndId(html) {
  // Look for data-model="movie" data-id="12345"
  var model = null, id = null;
  var mm = html.match(/data-model\s*=\s*["']([^"']+)["']/i);
  if (mm) model = mm[1];
  var im = html.match(/data-id\s*=\s*["']([^"']+)["']/i);
  if (im) id = im[1];
  // Alternative: look for /api/player-url/movie/12345 pattern
  var pm = html.match(/\/api\/player-url\/([a-z]+)\/([0-9]+)/i);
  if (pm) { model = pm[1]; id = pm[2]; }
  return { model: model, id: id };
}

function resolvePlayerUrl(moviePageUrl) {
  return fetchText(moviePageUrl, BASE + "/").then(function(html) {
    var token = extractPlayerToken(html);
    var ctx = extractModelAndId(html);
    log("Player token: " + (token ? "found (" + token.slice(0, 16) + "...)" : "NOT FOUND"));
    log("Model/ID: " + (ctx.model || "?") + "/" + (ctx.id || "?"));

    // If no token, try to find the player iframe directly
    if (!token) {
      var iframeMatch = html.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
      if (iframeMatch) {
        var u = iframeMatch[1];
        if (u.indexOf("//") === 0) u = "https:" + u;
        if (u.indexOf("http") === 0) return { direct: [u] };
      }
      return { direct: [] };
    }

    // POST to /api/player-url with token
    var apiUrl = BASE + "/api/player-url";
    return fetchJson(apiUrl, { t: token }, moviePageUrl).then(function(res) {
      log("Player API response: " + JSON.stringify(res).slice(0, 300));

      // Parse the response for iframe URLs
      var urls = [];
      if (res && res.url) urls.push(res.url);
      if (res && res.iframe) urls.push(res.iframe);
      if (res && res.data && res.data.url) urls.push(res.data.url);
      if (res && res.html) {
        var im = res.html.match(/src\s*=\s*["']([^"']+)["']/i);
        if (im) urls.push(im[1]);
      }
      return { direct: urls, raw: res };
    }).catch(function(e) {
      log("Player API failed: " + e.message);
      return { direct: [] };
    });
  });
}

// ---------------------------------------------------------------- Closeload extractor
// Streamflix uses: ROT13 → Base64 → Reverse (in some order)
// The "Smart Brute Force" tries all permutations.

function rot13(s) {
  return String(s).replace(/[a-zA-Z]/g, function(c) {
    var base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function b64decode(s) {
  try {
    if (typeof atob === "function") return atob(s);
    if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("binary");
  } catch (e) {}
  return "";
}

function reverse(s) {
  return String(s).split("").reverse().join("");
}

function smartDecode(input) {
  // Try all permutations of ROT13, Base64, Reverse (up to 3 layers each)
  var candidates = [input];
  var transforms = [
    { name: "rot13", fn: rot13 },
    { name: "b64", fn: b64decode },
    { name: "rev", fn: reverse }
  ];
  var seen = {};
  seen[input] = 1;
  var results = [];

  for (var depth = 0; depth < 4; depth++) {
    var next = [];
    candidates.forEach(function(c) {
      transforms.forEach(function(t) {
        var out = t.fn(c);
        if (!out || out === c || out.length < 8) return;
        if (seen[out]) return;
        seen[out] = 1;
        next.push(out);
        if (/\.m3u8|\.mp4|https?:\/\//i.test(out)) {
          results.push({ text: out, path: t.name });
        }
      });
    });
    candidates = next;
    if (results.length) break;
  }

  // Extract any URLs from results
  var urls = [];
  results.forEach(function(r) {
    var re = /https?:\/\/[^"'\s<>\\]+/gi;
    var m;
    while ((m = re.exec(r.text)) !== null) {
      if (urls.indexOf(m[0]) === -1) urls.push(m[0]);
    }
  });
  return urls;
}

function extractCloseload(embedUrl, referer) {
  log("Closeload: " + embedUrl);
  return fetchText(embedUrl, referer).then(function(html) {
    var urls = [];

    // Direct m3u8/mp4 in the page
    var re = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
    var m;
    while ((m = re.exec(html)) !== null) urls.push(m[0]);

    // Look for encoded strings that need decoding
    if (!urls.length) {
      var encoded = [];
      var reEnc = /["']([A-Za-z0-9+\/=_-]{30,})["']/g;
      while ((m = reEnc.exec(html)) !== null) encoded.push(m[1]);

      encoded.forEach(function(e) {
        smartDecode(e).forEach(function(u) {
          if (urls.indexOf(u) === -1) urls.push(u);
        });
      });
    }

    // Look for packed eval
    if (!urls.length) {
      var unpacked = unpackAll(html);
      if (unpacked) {
        var re2 = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
        while ((m = re2.exec(unpacked)) !== null) urls.push(m[0]);
      }
    }

    log("Closeload streams: " + urls.length);
    return urls;
  }).catch(function(e) {
    log("Closeload failed: " + e.message);
    return [];
  });
}

// ---------------------------------------------------------------- p.a.c.k.e.r
function packerEncode(c, a) {
  return (c < a ? "" : packerEncode(parseInt(c / a, 10), a)) +
    ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
}

function unpackAll(html) {
  var out = [];
  var re = /eval\(function\(p,a,c,k,e,(?:d|r)\)\{[\s\S]*?\}\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\s*\.split\('\|'\)/g;
  var m;
  html = String(html || "");
  while ((m = re.exec(html)) !== null) {
    var payload = m[1].replace(/\\(?:u([0-9a-fA-F]{4})|([\s\S]))/g, function(_, hex, ch) {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (ch === "n") return "\n";
      if (ch === "t") return "\t";
      return ch;
    });
    var base = parseInt(m[2], 10);
    var count = parseInt(m[3], 10);
    var keywords = m[4].split("|");
    while (count--) {
      if (keywords[count]) {
        var key = keywords[count];
        var pat = new RegExp("\\b" + packerEncode(count, base) + "\\b", "g");
        payload = payload.replace(pat, function() { return key; });
      }
    }
    out.push(payload);
  }
  return out.join("\n");
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

function serverLabelFromUrl(url) {
  var h = hostOf(url).toLowerCase();
  if (/closeload/.test(h)) return "Closeload";
  if (/ridorapid/.test(h)) return "RidoRapid";
  if (/vidsrc/.test(h)) return "Vidsrc";
  if (/voe\.sx/.test(h)) return "Voe";
  if (/filemoon/.test(h)) return "Filemoon";
  return h.split(".").slice(-2, -1)[0] || h;
}

function buildStreams(urls, pageUrl, label) {
  var out = [];
  var seen = {};
  urls.forEach(function(url) {
    if (seen[url]) return;
    seen[url] = 1;
    if (url.indexOf("http://") === 0) url = "https://" + url.slice(7);
    var isHls = /\.m3u8/i.test(url);
    var host = serverLabelFromUrl(url);
    var referer = originOf(pageUrl) + "/";
    out.push({
      name: "🎬 RidoMovies " + label + " (" + host + ")",
      title: "🎬 RidoMovies • " + label + " (" + host + ")",
      url: url,
      quality: isHls ? "Auto" : qualityFromUrl(url),
      size: "Unknown",
      type: isHls ? "hls" : "mp4",
      headers: {
        "User-Agent": UA,
        "Referer": referer,
        "Origin": originOf(pageUrl),
        "Accept": "*/*"
      },
      provider: "ridomovies"
    });
  });
  log("Streams: " + out.length);
  return out;
}

// ---------------------------------------------------------------- movie flow
function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      var best = chooseResult(all, meta.titles, "movie");
      if (!best) return [];
      log("Resolving: " + best.url);

      return fetchText(best.url, BASE + "/").then(function(html) {
        // Try to get player URL via AJAX
        return resolvePlayerUrl(best.url).then(function(playerRes) {
          var allUrls = [];

          // If player API returned URLs directly
          if (playerRes.direct && playerRes.direct.length) {
            playerRes.direct.forEach(function(u) {
              if (/closeload|ridorapid/i.test(u)) {
                return; // will be handled below
              }
              allUrls.push(u);
            });
          }

          // Resolve Closeload embeds
          var closeloadEmbeds = [];
          var re = /(https?:\/\/(?:[\w.-]+\.)?closeload\.top[^"'\s<>]*)/gi;
          var m;
          var combined = html + " " + JSON.stringify(playerRes.raw || "");
          while ((m = re.exec(combined)) !== null) {
            if (closeloadEmbeds.indexOf(m[1]) === -1) closeloadEmbeds.push(m[1]);
          }

          if (!closeloadEmbeds.length && playerRes.direct) {
            playerRes.direct.forEach(function(u) {
              if (/closeload|ridorapid/i.test(u)) closeloadEmbeds.push(u);
            });
          }

          log("Closeload embeds: " + closeloadEmbeds.length);
          return Promise.all(closeloadEmbeds.map(function(embed) {
            return extractCloseload(embed, best.url).then(function(urls) {
              urls.forEach(function(u) { if (allUrls.indexOf(u) === -1) allUrls.push(u); });
            });
          })).then(function() {
            // Also scan the page itself for direct m3u8
            var reDirect = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
            var dm;
            while ((dm = reDirect.exec(html)) !== null) {
              if (allUrls.indexOf(dm[0]) === -1) allUrls.push(dm[0]);
            }
            return buildStreams(allUrls, best.url, "Movie");
          });
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
  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      var best = chooseResult(all, meta.titles, "series");
      if (!best) return [];
      log("Resolving: " + best.url);

      return fetchText(best.url, BASE + "/").then(function(html) {
        // Look for season/episode links on the page
        var seasonEpisodePattern = new RegExp("season[-/ ]?" + season + ".*?episode[-/ ]?" + episode, "i");
        var epMatch = html.match(seasonEpisodePattern);
        var epUrl = best.url;
        if (epMatch) {
          // Try to find a link near the episode
          var near = html.slice(Math.max(0, epMatch.index - 500), epMatch.index + 500);
          var linkMatch = near.match(/href\s*=\s*["']([^"']+)["']/i);
          if (linkMatch) {
            var u = linkMatch[1];
            if (u.indexOf("http") !== 0) u = BASE + (u.charAt(0) === "/" ? "" : "/") + u;
            epUrl = u;
          }
        }

        return resolvePlayerUrl(epUrl).then(function(playerRes) {
          var allUrls = [];
          var combined = html + " " + JSON.stringify(playerRes.raw || "");
          var closeloadEmbeds = [];
          var re = /(https?:\/\/(?:[\w.-]+\.)?closeload\.top[^"'\s<>]*)/gi;
          var m;
          while ((m = re.exec(combined)) !== null) {
            if (closeloadEmbeds.indexOf(m[1]) === -1) closeloadEmbeds.push(m[1]);
          }

          return Promise.all(closeloadEmbeds.map(function(embed) {
            return extractCloseload(embed, epUrl).then(function(urls) {
              urls.forEach(function(u) { if (allUrls.indexOf(u) === -1) allUrls.push(u); });
            });
          })).then(function() {
            var reDirect = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)[^"'\s<>\\]*/gi;
            var dm;
            while ((dm = reDirect.exec(html)) !== null) {
              if (allUrls.indexOf(dm[0]) === -1) allUrls.push(dm[0]);
            }
            var label = "S" + (season < 10 ? "0" + season : season) + "E" + (episode < 10 ? "0" + episode : episode);
            return buildStreams(allUrls, epUrl, label);
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
