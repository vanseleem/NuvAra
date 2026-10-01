/**
 * TheFlixBay provider  (v3)
 *
 * Verified against the live site:
 *  - AJAX param `t` is the TMDB id (Spider-Man: Brand New Day = 969681), so for
 *    MOVIES the TMDB id Nuvio passes in is used directly - no search needed.
 *  - Site ids (/movie/202724, /series/19689) are NOT TMDB ids; page URLs may
 *    carry a slug (/movie/202724-watch-...-online).
 *  - Series pages have NO per-episode ids: episodes are javascript:void(0)
 *    links, so TV needs season + episode sent to a series AJAX endpoint.
 *
 * Flow
 *  MOVIE : 1) /ajax/cinemov*.php?t=<tmdbId>  (3 servers, in parallel)
 *          2) fallback: search -> page -> discover endpoints -> ajax
 *  TV    : 1) search -> series page -> discover endpoint + param names from the
 *             page's own JS -> ajax with season/episode
 *          2) fallback: blind try of likely endpoints with the TMDB id
 *
 * Every step logs what it tried, and when a response has no usable link it logs
 * the first characters of that response (so a failure can be diagnosed from the
 * Nuvio log). No setTimeout is required.
 */

var BASE = "https://theflixbay.com";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

var FETCH_TIMEOUT_MS = 15000;   // only applied if the runtime provides setTimeout
var MATCH_THRESHOLD = 0.4;
var RESOLVE_EMBEDS = true;      // try to turn embed pages into direct m3u8/mp4
var MAX_EMBEDS = 6;

var MOVIE_SERVERS = [
  { path: "/ajax/cinemov.php",  label: "BlackFlag" },
  { path: "/ajax/cinemov2.php", label: "ThePort" },
  { path: "/ajax/cinemov3.php", label: "JollyRgr" }
];
var SERVER_LABELS = ["BlackFlag", "ThePort", "JollyRgr"];
// only used if the series page doesn't reveal its endpoints
var TV_FALLBACK_PATHS = ["/ajax/cinetv.php", "/ajax/cinetv2.php", "/ajax/cinetv3.php"];

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

function encodeNonAscii(str) {
  return String(str).replace(/[^\x00-\x7F]/g, function(c) {
    try { return encodeURIComponent(c); } catch (e) { return ""; }
  });
}

function fetchText(url, referer, ajax) {
  url = encodeNonAscii(url);
  var headers = {
    "User-Agent": UA,
    "Accept": ajax ? "*/*" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };
  if (referer) headers["Referer"] = encodeNonAscii(referer);
  if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
  return withTimeout(
    fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }),
    FETCH_TIMEOUT_MS
  );
}

// ---------------------------------------------------------------- text helpers
function decodeHtml(str) {
  return String(str || "")
    .replace(/&#x([0-9a-f]+);/gi, function(_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function(_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripHtml(str) {
  return decodeHtml(String(str || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeTitle(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  a = normalizeTitle(a);
  b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  var shortS = a.length <= b.length ? a : b;
  var longS = a.length <= b.length ? b : a;
  if ((" " + longS + " ").indexOf(" " + shortS + " ") !== -1) {
    return 0.55 + 0.35 * (shortS.length / longS.length);
  }
  var aa = a.split(" ");
  var bb = b.split(" ");
  var setB = {};
  bb.forEach(function(x) { setB[x] = 1; });
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

function absUrl(u, base) {
  u = decodeHtml(String(u || "")).trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return "";      // javascript:, about:, data: ...
  var origin = originOf(base) || BASE;
  if (u.charAt(0) === "/") return origin + u;
  var b = String(base || "").replace(/[?#].*$/, "");
  var i = b.lastIndexOf("/");
  var dir = i > 7 ? b.slice(0, i + 1) : origin + "/";
  return dir + u;
}

function getAttr(attrs, name) {
  var re = new RegExp("(?:^|[\\s\"'])" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  var m = String(attrs || "").match(re);
  if (!m) return "";
  return decodeHtml(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
}

function snippet(text) {
  return String(text || "").replace(/\s+/g, " ").slice(0, 160);
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
    if (!titles.length) throw new Error("Could not get TMDB titles for " + tmdbId);
    console.log("[TheFlixBay] TMDB titles:", titles.join(" | "), "year:", year);
    return { titles: titles, year: year };
  });
}

// ---------------------------------------------------------------- search
// listing titles look like "Watch X Free Online Now" / "Stream X Free Episodes Now"
function cleanListingTitle(t) {
  return decodeHtml(t)
    .replace(/^\s*(?:watch|stream)\s+/i, "")
    .replace(/\s+free\s+(?:online|episodes?)(?:\s+now)?(?:\s+in\s+hd)?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Accepts /movie/ID, /movie/ID-slug, absolute URLs, any attribute order.
function parseListing(html) {
  var out = [];
  var seen = {};
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  html = String(html || "");
  while ((m = re.exec(html)) !== null) {
    var href = getAttr(m[1], "href");
    var hm = href.match(/\/(movie|series)\/(\d+)(?=$|[-\/?#])/i);
    if (!hm) continue;
    var seg = hm[1].toLowerCase();
    var kind = seg === "movie" ? "movie" : "series";
    var id = hm[2];
    var key = kind + id;

    var title = cleanListingTitle(getAttr(m[1], "title"));
    if (!title) {
      var alt = m[2].match(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i);
      if (alt) title = cleanListingTitle(alt[1]);
    }
    if (!title) {
      title = cleanListingTitle(stripHtml(m[2]).replace(/^(?:(?:TS|HD|CAM|SD|HDTS)\s+)?\d+(?:\.\d+)?\s+/i, ""));
    }
    if (!title) continue;

    if (seen[key] !== undefined) continue;
    seen[key] = out.length;
    out.push({ id: id, kind: kind, url: BASE + "/" + seg + "/" + id, title: title });
  }
  return out;
}

function searchTheFlixBay(title) {
  var q = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/index.php?menu=search&query=" + encodeURIComponent(q);
  console.log("[TheFlixBay] Search:", q);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = parseListing(html);
    console.log("[TheFlixBay] Search results:", results.length);
    if (!results.length) console.log("[TheFlixBay] Search page starts with:", snippet(html));
    return results;
  });
}

function searchMany(titles) {
  return Promise.all(titles.map(function(t) {
    return searchTheFlixBay(t).catch(function(e) {
      console.log("[TheFlixBay] search failed:", e.message);
      return [];
    });
  })).then(function(groups) {
    var all = [];
    var seen = {};
    groups.forEach(function(g) {
      g.forEach(function(r) {
        var k = r.kind + r.id;
        if (!seen[k]) { seen[k] = 1; all.push(r); }
      });
    });
    console.log("[TheFlixBay] Unique candidates:", all.length);
    return all;
  });
}

function chooseResult(results, titles, wantKind) {
  var best = null;
  var bestScore = 0;
  results.forEach(function(r) {
    if (wantKind && r.kind !== wantKind) return;
    var s = 0;
    titles.forEach(function(t) {
      var sc = similarity(r.title, t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (best) console.log("[TheFlixBay] Best:", best.title, "(" + best.kind + " " + best.id + ")", "score:", bestScore.toFixed(3));
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

// ---------------------------------------------------------------- page / endpoint discovery
// The page's player code does:  $.get(serverUrl, {"t": '969681', ...}, ...)
function extractTmdbId(html) {
  var m = String(html || "").match(/["']t["']\s*:\s*["'](\d{3,10})["']/);
  if (m) return m[1];
  m = String(html || "").match(/"t"\s*:\s*"?(\d{3,10})"?/);
  return m ? m[1] : null;
}

function discoverAjaxPaths(text) {
  var out = [];
  var re = /\/?ajax\/[A-Za-z0-9_\-]+\.php/gi;
  var m;
  text = String(text || "");
  while ((m = re.exec(text)) !== null) {
    var p = "/" + m[0].replace(/^\//, "");
    if (out.indexOf(p) === -1) out.push(p);
  }
  return out.sort();
}

// Parameter names used by the page's $.get / $.post calls and ?a=b query strings.
function discoverParamKeys(text) {
  var sets = [];
  var m;
  text = String(text || "");
  var reCall = /\$\.(?:get|post|getJSON)\s*\([^,]+,\s*\{([^}]*)\}/g;
  while ((m = reCall.exec(text)) !== null) {
    var keys = [];
    var kr = /["']?([A-Za-z_]\w*)["']?\s*:/g;
    var k;
    while ((k = kr.exec(m[1])) !== null) keys.push(k[1]);
    if (keys.length) sets.push(keys);
  }
  var reQs = /ajax\/[\w\-]+\.php\?([^"'\s<>]+)/g;
  while ((m = reQs.exec(text)) !== null) {
    var qk = [];
    var pr = /(?:^|&)([A-Za-z_]\w*)=/g;
    var p;
    while ((p = pr.exec(m[1])) !== null) qk.push(p[1]);
    if (qk.length) sets.push(qk);
  }
  return sets;
}

function findLocalScripts(html) {
  var out = [];
  var re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(String(html || ""))) !== null) {
    var u = absUrl(m[1], BASE + "/");
    if (!u || originOf(u) !== BASE) continue;
    if (/jquery|bootstrap|swiper|slick|owl|fancybox|popper|analytics/i.test(u)) continue;
    if (out.indexOf(u) === -1) out.push(u);
  }
  return out;
}

// { t, paths, keySets } for a movie/series page (reads external scripts only if needed)
function readPageConfig(html, referer) {
  var cfg = {
    t: extractTmdbId(html),
    paths: discoverAjaxPaths(html),
    keySets: discoverParamKeys(html)
  };
  if (cfg.paths.length) return Promise.resolve(cfg);

  var scripts = findLocalScripts(html).slice(0, 4);
  console.log("[TheFlixBay] no ajax paths inline; reading", scripts.length, "script file(s)");
  return Promise.all(scripts.map(function(u) {
    return fetchText(u, referer).catch(function() { return ""; });
  })).then(function(texts) {
    var all = texts.join("\n");
    cfg.paths = discoverAjaxPaths(all);
    cfg.keySets = cfg.keySets.concat(discoverParamKeys(all));
    if (!cfg.t) cfg.t = extractTmdbId(all);
    return cfg;
  });
}

// ---------------------------------------------------------------- extracting links from AJAX responses
var ASSET_RE = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|json|xml|vtt|srt)(?:[?#]|$)/i;
var JUNK_HOST_RE = /google|gstatic|googleapis|facebook|twitter|doubleclick|jquery|cdnjs\.cloudflare|bootstrapcdn|tmdb\.org|themoviedb|fontawesome|jsdelivr|unpkg/i;

function isMediaUrl(u) {
  return /\.(?:m3u8|mp4)(?![A-Za-z0-9_.\-])/i.test(u);
}

// Works for HTML, JSON, or JS snippets: collects embed URLs and direct media URLs.
function extractSources(text, baseUrl) {
  var s = String(text || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/g, "&")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
  var out = [];
  var seen = {};
  var m;

  function add(raw) {
    var u = absUrl(raw, baseUrl);
    if (!/^https?:\/\//i.test(u)) return;
    var media = isMediaUrl(u);
    if (ASSET_RE.test(u) && !media) return;
    if (JUNK_HOST_RE.test(hostOf(u))) return;
    if (originOf(u) === BASE && !media) return;
    if (seen[u]) return;
    seen[u] = 1;
    out.push({ url: u, kind: media ? "direct" : "iframe" });
  }

  var reAttr = /\b(?:src|data-src|data-url|data-embed|data-link|data-iframe|data-video|href|value)\s*=\s*["']([^"']+)["']/gi;
  while ((m = reAttr.exec(s)) !== null) add(m[1]);

  var reKey = /["']?(?:file|url|src|link|embed|iframe|source|stream|video)["']?\s*:\s*["']([^"']+)["']/gi;
  while ((m = reKey.exec(s)) !== null) add(m[1]);

  var reMedia = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)(?![A-Za-z0-9_.\-])(?:\?[^"'\s<>\\]*)?/gi;
  while ((m = reMedia.exec(s)) !== null) add(m[0]);

  return out;
}

function labelForPath(path) {
  for (var i = 0; i < MOVIE_SERVERS.length; i++) {
    if (MOVIE_SERVERS[i].path === path) return MOVIE_SERVERS[i].label;
  }
  var m = String(path).match(/(\d+)\.php$/);
  var n = m ? parseInt(m[1], 10) : 1;
  return SERVER_LABELS[n - 1] || ("Server " + n);
}

// Try several query strings against one endpoint, stop at the first that yields links.
function tryQueries(path, queries, referer, i) {
  if (i >= queries.length) return Promise.resolve([]);
  var url = BASE + path + "?" + queries[i];
  return fetchText(url, referer, true).then(function(text) {
    var found = extractSources(text, url);
    console.log("[TheFlixBay]", path + "?" + queries[i], "->", found.length, "link(s),", String(text).length, "bytes");
    if (found.length) {
      return found.map(function(f) { return { url: f.url, kind: f.kind, label: labelForPath(path) }; });
    }
    console.log("[TheFlixBay]   empty response starts with:", snippet(text));
    return tryQueries(path, queries, referer, i + 1);
  }, function(err) {
    console.log("[TheFlixBay]", path + "?" + queries[i], "failed:", err.message);
    return tryQueries(path, queries, referer, i + 1);
  });
}

function runEndpoints(paths, queries, referer) {
  return Promise.all(paths.map(function(p) {
    return tryQueries(p, queries, referer, 0);
  })).then(function(groups) {
    var all = [];
    groups.forEach(function(g) { all = all.concat(g); });
    return all;
  });
}

// ---------------------------------------------------------------- p.a.c.k.e.r + embed resolving
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

function extractMediaFromPlayer(html, baseUrl) {
  var unpacked = unpackAll(html);
  var s = ((unpacked ? unpacked + "\n" : "") + String(html || ""))
    .replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
  var urls = [];
  var seen = {};
  var m;
  function add(raw) {
    var u = absUrl(raw, baseUrl);
    if (!/^https?:\/\//i.test(u) || !isMediaUrl(u) || seen[u]) return;
    seen[u] = 1;
    urls.push(u);
  }
  var reAbs = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)(?![A-Za-z0-9_.\-])(?:\?[^"'\s<>\\]*)?/gi;
  while ((m = reAbs.exec(s)) !== null) add(m[0]);
  var reKey = /(?:file|source|src|url|hls\d*|link|video_url|stream)["']?\s*[:=]\s*["']([^"']+?\.(?:m3u8|mp4)(?![A-Za-z0-9_.\-])[^"']*)["']/gi;
  while ((m = reKey.exec(s)) !== null) add(m[1]);
  var reTag = /<(?:source|video)\b([^>]*)>/gi;
  while ((m = reTag.exec(s)) !== null) { var src = getAttr(m[1], "src"); if (src) add(src); }
  return urls;
}

// Embed pages -> direct streams where possible; otherwise the embed stays as-is.
function resolveEmbeds(sources, referer) {
  var direct = sources.filter(function(s) { return s.kind === "direct"; });
  var embeds = sources.filter(function(s) { return s.kind === "iframe"; });
  if (!RESOLVE_EMBEDS || !embeds.length) return Promise.resolve(sources);

  var head = embeds.slice(0, MAX_EMBEDS);
  var tail = embeds.slice(MAX_EMBEDS);
  return Promise.all(head.map(function(e) {
    return fetchText(e.url, referer).then(function(html) {
      return { e: e, urls: extractMediaFromPlayer(html, e.url) };
    }).catch(function(err) {
      console.log("[TheFlixBay] embed fetch failed:", hostOf(e.url), err.message);
      return { e: e, urls: [] };
    });
  })).then(function(res) {
    var out = direct.slice();
    res.forEach(function(r) {
      console.log("[TheFlixBay] embed", hostOf(r.e.url), "->", r.urls.length, "direct link(s)");
      if (r.urls.length) {
        r.urls.forEach(function(u) {
          out.push({ url: u, kind: "direct", label: r.e.label, playerUrl: r.e.url });
        });
      } else {
        out.push(r.e);
      }
    });
    return out.concat(tail);
  });
}

// ---------------------------------------------------------------- build Nuvio streams
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
  if (/vidspeed/.test(h)) return "Vidspeed";
  if (/uqload/.test(h)) return "Uqload";
  if (/ds2play/.test(h)) return "DS2Play";
  if (/ok\.ru/.test(h)) return "OK.ru";
  if (/voe\.sx/.test(h)) return "Voe";
  if (/yourupload/.test(h)) return "YourUpload";
  if (/streamtape/.test(h)) return "Streamtape";
  if (/dood/.test(h)) return "Dood";
  if (/filemoon/.test(h)) return "Filemoon";
  if (/vidmoly/.test(h)) return "Vidmoly";
  if (/mixdrop/.test(h)) return "Mixdrop";
  return h.split(".").slice(-2, -1)[0] || h;
}

function buildStreams(sources, pageUrl) {
  var out = [];
  var seen = {};

  sources.forEach(function(s) {
    if (seen[s.url]) return;
    seen[s.url] = 1;

    var url = s.url.indexOf("http://") === 0 ? "https://" + s.url.slice(7) : s.url;
    var isHls = /\.m3u8/i.test(url);
    var host = serverLabelFromUrl(s.playerUrl || url);
    var referer = s.playerUrl ? originOf(s.playerUrl) + "/" : pageUrl;
    var origin = s.playerUrl ? originOf(s.playerUrl) : BASE;

    out.push({
      name: "🎬 TheFlixBay " + s.label + " (" + host + ")",
      title: "🎬 TheFlixBay • " + s.label + " (" + host + ")",
      url: url,
      quality: s.kind === "iframe" ? "Auto" : (isHls ? "Auto" : qualityFromUrl(url)),
      size: "Unknown",
      type: s.kind === "iframe" ? "iframe" : (isHls ? "hls" : "mp4"),
      headers: {
        "User-Agent": UA,
        "Referer": referer,
        "Origin": origin,
        "Accept": "*/*"
      },
      provider: "theflixbay"
    });
  });

  // direct streams first, embeds last
  out.sort(function(a, b) {
    return (a.type === "iframe" ? 1 : 0) - (b.type === "iframe" ? 1 : 0);
  });
  console.log("[TheFlixBay] Total streams:", out.length,
    "(direct:", out.filter(function(s) { return s.type !== "iframe"; }).length + ")");
  return out;
}

// ---------------------------------------------------------------- movies
function movieQueries(t) { return ["t=" + encodeURIComponent(t)]; }

function getMovieStreams(tmdbId) {
  // 1) direct: the AJAX `t` parameter IS the TMDB id
  console.log("[TheFlixBay] Movie: direct AJAX with TMDB id", tmdbId);
  var directPaths = MOVIE_SERVERS.map(function(s) { return s.path; });

  return runEndpoints(directPaths, movieQueries(tmdbId), BASE + "/").then(function(found) {
    if (found.length) {
      return resolveEmbeds(found, BASE + "/").then(function(res) { return buildStreams(res, BASE + "/"); });
    }
    console.log("[TheFlixBay] Direct AJAX gave nothing; falling back to search");
    return movieViaSearch(tmdbId);
  }).catch(function(err) {
    console.log("[TheFlixBay] Movie error:", err.message);
    return [];
  });
}

function movieViaSearch(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      var best = chooseResult(all, meta.titles, "movie");
      if (!best) return [];
      console.log("[TheFlixBay] Resolving page:", best.url);
      return fetchText(best.url, BASE + "/").then(function(html) {
        return readPageConfig(html, best.url).then(function(cfg) {
          var t = cfg.t || String(tmdbId);
          var paths = cfg.paths.length ? cfg.paths : MOVIE_SERVERS.map(function(s) { return s.path; });
          console.log("[TheFlixBay] page t:", t, "paths:", paths.join(","));
          return runEndpoints(paths, movieQueries(t), best.url).then(function(found) {
            if (!found.length) return [];
            return resolveEmbeds(found, best.url).then(function(res) { return buildStreams(res, best.url); });
          });
        });
      });
    });
  });
}

// ---------------------------------------------------------------- series
function pairsToQuery(pairs) {
  return pairs.map(function(p) { return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]); }).join("&");
}

// Turn the parameter names the page itself uses into a query for (t, season, episode).
function queryFromKeys(keys, ctx) {
  var pairs = [];
  var hasT = false, hasS = false, hasE = false;
  keys.forEach(function(k) {
    var lk = k.toLowerCase();
    if (/^(t|id|tid|tmdb|tmdbid|tmdb_id)$/.test(lk)) { pairs.push([k, ctx.t]); hasT = true; }
    else if (/^(s|se|sn|ss|season|seas|season_number|seasonnumber)$/.test(lk)) { pairs.push([k, ctx.season]); hasS = true; }
    else if (/^(e|ep|epi|episode|episode_number|episodenumber|en)$/.test(lk)) { pairs.push([k, ctx.episode]); hasE = true; }
  });
  return hasT && hasS && hasE ? pairsToQuery(pairs) : null;
}

function seriesQueries(keySets, ctx) {
  var out = [];
  function add(q) { if (q && out.indexOf(q) === -1) out.push(q); }
  keySets.forEach(function(ks) { add(queryFromKeys(ks, ctx)); });
  add(pairsToQuery([["t", ctx.t], ["s", ctx.season], ["e", ctx.episode]]));
  add(pairsToQuery([["t", ctx.t], ["season", ctx.season], ["episode", ctx.episode]]));
  add(pairsToQuery([["t", ctx.t], ["s", ctx.season], ["ep", ctx.episode]]));
  return out;
}

function getTvStreams(tmdbId, season, episode) {
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  return getTmdbTitles(tmdbId, "tv").then(function(meta) {
    return searchMany(meta.titles).then(function(all) {
      var best = chooseResult(all, meta.titles, "series");
      if (!best) {
        console.log("[TheFlixBay] No series match; trying endpoints blind");
        return tvBlind(tmdbId, s, e);
      }
      console.log("[TheFlixBay] Resolving series page:", best.url);
      return fetchText(best.url, BASE + "/").then(function(html) {
        // sanity: does the site list this episode?
        var wanted = new RegExp("season\\s*" + s + "\\s*episode\\s*" + e + "\\b", "i");
        if (!wanted.test(html)) console.log("[TheFlixBay] note: page does not list S" + s + "E" + e + " (trying anyway)");

        return readPageConfig(html, best.url).then(function(cfg) {
          var ctx = { t: cfg.t || String(tmdbId), season: s, episode: e };
          var paths = cfg.paths.length ? cfg.paths : TV_FALLBACK_PATHS;
          var queries = seriesQueries(cfg.keySets, ctx);
          console.log("[TheFlixBay] series t:", ctx.t, "| paths:", paths.join(","), "| queries:", queries.join(" , "));

          return runEndpoints(paths, queries, best.url).then(function(found) {
            if (!found.length) {
              console.log("[TheFlixBay] page-driven attempt found nothing; trying blind");
              return tvBlind(tmdbId, s, e);
            }
            return resolveEmbeds(found, best.url).then(function(res) { return buildStreams(res, best.url); });
          });
        });
      });
    });
  }).catch(function(err) {
    console.log("[TheFlixBay] TV error:", err.message);
    return [];
  });
}

function tvBlind(tmdbId, s, e) {
  var ctx = { t: String(tmdbId), season: s, episode: e };
  var paths = TV_FALLBACK_PATHS.concat(MOVIE_SERVERS.map(function(m) { return m.path; }));
  return runEndpoints(paths, seriesQueries([], ctx), BASE + "/").then(function(found) {
    if (!found.length) return [];
    return resolveEmbeds(found, BASE + "/").then(function(res) { return buildStreams(res, BASE + "/"); });
  });
}

// ---------------------------------------------------------------- entry point
function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[TheFlixBay] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
