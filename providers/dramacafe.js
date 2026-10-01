

var BASE = "https://ddramacafe-tv.bar";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

// ---------------------------------------------------------------- config
var FETCH_TIMEOUT_MS = 12000;
var MATCH_THRESHOLD = 0.5;        // minimum title score to accept a search result
var MAX_MOVIE_VERSIONS = 2;       // the site sometimes has the same movie uploaded twice
var VERSION_WINDOW = 0.25;        // 2nd upload must score within this of the best one
var MAX_IFRAMES_PER_PAGE = 6;     // servers followed per embed/play page
var INCLUDE_DOWNLOAD_LINKS = true;
// The download mirrors (1fichier, Bowfile, ...) are landing pages, not direct
// streams. They are returned as "open this page" entries using this type.
var DOWNLOAD_ENTRY_TYPE = "iframe";

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
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
  if (referer) headers["Referer"] = encodeNonAscii(referer);
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

function normalizeArabic(s) {
  return String(s || "")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")   // diacritics + tatweel
    .replace(/[\u0622\u0623\u0625]/g, "\u0627")    // alef variants
    .replace(/\u0629/g, "\u0647")                  // teh marbuta
    .replace(/\u0649/g, "\u064A");                 // alef maksura
}

function normalizeTitle(str) {
  return normalizeArabic(String(str || "").toLowerCase())
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

var NOISE = {};
["فيلم", "مسلسل", "مترجم", "مترجمه", "مدبلج", "مدبلجه", "كامل", "كامله",
 "اون", "لاين", "اونلاين", "hd"].forEach(function(w) { NOISE[normalizeArabic(w)] = 1; });

// Title with filler words and the year removed (for matching).
function cleanTitle(str) {
  var toks = normalizeTitle(str).split(" ").filter(function(t) { return t && !NOISE[t]; });
  var noYear = toks.filter(function(t) { return !/^(19|20)\d\d$/.test(t); });
  return (noYear.length ? noYear : toks).join(" ");
}

// a / b must already be cleaned.
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

// ---- season / episode parsing from titles
var SEASON_WORDS = ["", "الأول", "الثاني", "الثالث", "الرابع", "الخامس",
                    "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
var SEASON_WORDS_N = SEASON_WORDS.map(normalizeArabic);
var CUT_TOKENS = {};
["الحلقة", "الموسم", "الجزء", "episode", "season"].forEach(function(w) { CUT_TOKENS[normalizeArabic(w)] = 1; });

// "مسلسل Squid Game الموسم الثاني الحلقة 1 مترجمة" -> "squid game"
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

// returns season number, or null if the title carries no season marker
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

function absUrl(u, base) {
  u = decodeHtml(String(u || "")).trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  var origin = originOf(base) || BASE;
  if (u.charAt(0) === "/") return origin + u;
  var b = String(base || "").replace(/[?#].*$/, "");
  var i = b.lastIndexOf("/");
  var dir = i > 7 ? b.slice(0, i + 1) : origin + "/";
  return dir + u;
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

// ---------------------------------------------------------------- site: search + watch pages
// Every <a> that points at watch.php?vid=..., in document order.
function parseWatchAnchors(html) {
  var out = [];
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  html = String(html || "");
  while ((m = re.exec(html)) !== null) {
    var href = getAttr(m[1], "href");
    var vm = href.match(/watch\.php\?vid=([A-Za-z0-9_-]+)/i);
    if (!vm) continue;
    var inner = stripHtml(m[2]);
    out.push({
      vid: vm[1],
      url: BASE + "/watch.php?vid=" + vm[1],
      title: getAttr(m[1], "title") || inner,
      inner: inner
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
    console.log("[DramaCafe] Search results:", results.length);
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

// ---------------------------------------------------------------- site: episode list
// Every watch page of a series prints the full "المواسم والحلقات" list:
//   <a href="watch.php?vid=XXXX" title="...">  <em>1</em>حلقة </a>
// One block per season, each restarting at episode 1. We group by that reset.
function parseEpisodeGroups(html) {
  var eps = [];
  parseWatchAnchors(html).forEach(function(a) {
    var m = a.inner.match(/^[\s\-\*\u2022]*(\d+)\s*\*?\s*حلق[ةه]\s*$/) ||
            a.inner.match(/^[\s\-\*\u2022]*حلق[ةه]\s*\*?\s*(\d+)\s*$/);
    if (!m) return;
    eps.push({ ep: parseInt(m[1], 10), vid: a.vid, title: a.title });
  });
  if (!eps.length) return [];

  var desc = eps.length > 1 && eps[1].ep < eps[0].ep;   // newest-first listing
  var groups = [];
  var cur = null;
  var prev = 0;
  eps.forEach(function(e, i) {
    var reset = !cur || (desc ? e.ep >= prev : e.ep <= prev);
    if (reset) { cur = []; groups.push(cur); }
    cur.push(e);
    prev = e.ep;
  });

  // drop duplicated lists (page printing the same block twice)
  var seen = {};
  var unique = [];
  groups.forEach(function(g) {
    var key = g.map(function(e) { return e.vid; }).join(",");
    if (!seen[key]) { seen[key] = 1; unique.push(g); }
  });
  return unique;
}

function pickFromGroups(groups, season, episode) {
  if (!groups || !groups.length) return null;
  var g = null;
  if (groups.length >= season) {
    g = groups[season - 1];
  } else if (groups.length === 1) {
    // site lists each season as its own series: trust the season in the titles
    var st = seasonFromTitle(groups[0][0].title) || 1;
    if (st === season) g = groups[0];
  }
  if (!g) return null;
  for (var i = 0; i < g.length; i++) {
    if (g[i].ep === episode) return g[i].vid;
  }
  return null;
}

// Fallback when no episode list is available: use season/episode in the titles.
function pickByTitle(items, season, episode) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (episodeFromTitle(it.title) === episode && (seasonFromTitle(it.title) || 1) === season) return it;
  }
  return null;
}

function pickRepresentative(items, season) {
  for (var i = 0; i < items.length; i++) {
    if ((seasonFromTitle(items[i].title) || 1) === season) return items[i];
  }
  return items[0];
}

// ---------------------------------------------------------------- unpacker (p.a.c.k.e.r)
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

// ---------------------------------------------------------------- player pages
var ASSET_RE = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|json|xml)(?:[?#]|$)/i;
var SITE_PAGE_RE = /\/(?:watch|category|index|view-serie|user|login|contact|search|topvideos|newvideos|moslslat)\.php/i;

// All server/iframe URLs on a page (iframes, lazy iframes, data-embed style buttons, <option>s).
function findPlayerIframes(html, baseUrl) {
  var urls = [];
  function add(raw) {
    var u = absUrl(raw, baseUrl);
    if (!/^https?:\/\//i.test(u)) return;
    if (ASSET_RE.test(u) || SITE_PAGE_RE.test(u)) return;
    if (urls.indexOf(u) === -1) urls.push(u);
  }
  html = String(html || "");
  var m;

  var reIframe = /<iframe\b([^>]*)>/gi;
  while ((m = reIframe.exec(html)) !== null) {
    add(getAttr(m[1], "src") || getAttr(m[1], "data-src") || getAttr(m[1], "data-lazy-src"));
  }

  var reData = /\sdata-(?:embed|iframe|player|video|server|link|url|src)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) add(m[1]);

  var reOpt = /<option\b[^>]*\bvalue\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;
  while ((m = reOpt.exec(html)) !== null) add(m[1]);

  return urls;
}

// All direct .m3u8 / .mp4 URLs in a page (including inside packed JS).
function extractStreamsFromPlayer(playerHtml, baseUrl) {
  var streams = [];
  var seen = {};
  var unpacked = unpackAll(playerHtml);
  var search = (unpacked ? unpacked + "\n" : "") + String(playerHtml || "");
  search = search.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
  console.log("[DramaCafe] unpacked:", unpacked ? "yes (" + unpacked.length + " chars)" : "no");

  function add(raw) {
    var u = absUrl(raw, baseUrl);
    if (!/^https?:\/\//i.test(u)) return;
    if (ASSET_RE.test(u)) return;
    if (seen[u]) return;
    seen[u] = 1;
    streams.push(u);
  }

  var m;
  var reAbs = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)(?![A-Za-z0-9_.\-])(?:\?[^"'\s<>\\]*)?/gi;
  while ((m = reAbs.exec(search)) !== null) add(m[0]);

  var reKey = /(?:file|source|src|url|hls\d*|link|video_url|stream)["']?\s*[:=]\s*["']([^"']+?\.(?:m3u8|mp4)(?![A-Za-z0-9_.\-])[^"']*)["']/gi;
  while ((m = reKey.exec(search)) !== null) add(m[1]);

  var reTag = /<(?:source|video)\b([^>]*)>/gi;
  while ((m = reTag.exec(search)) !== null) {
    var src = getAttr(m[1], "src");
    if (src) add(src);
  }

  console.log("[DramaCafe] m3u8/mp4 found:", streams.length);
  return streams;
}

// Download mirrors listed on downloads.php
function parseDownloadLinks(html) {
  var out = [];
  var seen = {};
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  html = String(html || "");
  while ((m = re.exec(html)) !== null) {
    var href = decodeHtml(getAttr(m[1], "href"));
    if (!/^https?:\/\//i.test(href)) continue;
    if (originOf(href) === BASE || /downloads\.php/i.test(href)) continue;
    var txt = stripHtml(m[2]);
    if (txt.indexOf("للتحميل") === -1) continue;
    if (seen[href]) continue;
    seen[href] = 1;
    var name = txt.replace(/اضغط هنا للتحميل/g, "").replace(/[\*\s]+/g, " ").trim() || hostOf(href);
    out.push({ name: name, url: href });
  }
  return out;
}

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1440/.test(s)) return "1440p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  if (/360/.test(s)) return "360p";
  return "Unknown";
}

function tagged(tag, label) {
  return tag ? tag + " \u2022 " + label : label;
}

// Auto-referer: uses the player's own origin (works for any host)
function makeStream(url, label, playerUrl) {
  var origin = originOf(playerUrl) || BASE;
  var streamReferer = origin + "/";

  if (url.indexOf("http://") === 0) {
    url = "https://" + url.slice(7);
  }

  return {
    name: "⚜️ DramaCafe",
    title: label ? "⚜️ DramaCafe \u2022 " + label : "⚜️ DramaCafe",
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

function makeEmbedEntry(url, label, referer) {
  return {
    name: "☕ DramaCafe",
    title: label ? "☕ DramaCafe \u2022 " + label : "☕ DramaCafe (Embed)",
    url: url,
    quality: "Auto",
    type: "iframe",
    referer: referer
  };
}

// Fetch one player page (embed.php or play.php), follow every iframe on it.
// Returns { direct: [{url, playerUrl}], embeds: [iframeUrl] } with stable order.
function collectFromPage(pageUrl, referer) {
  return fetchText(pageUrl, referer).then(function(html) {
    var result = { direct: [], embeds: [] };
    extractStreamsFromPlayer(html, pageUrl).forEach(function(u) {
      result.direct.push({ url: u, playerUrl: pageUrl });
    });

    var iframes = findPlayerIframes(html, pageUrl).slice(0, MAX_IFRAMES_PER_PAGE);
    console.log("[DramaCafe]", pageUrl.replace(BASE, ""), "-> iframes:", iframes.length);

    return Promise.all(iframes.map(function(f) {
      return fetchText(f, pageUrl).then(function(ph) {
        return { frame: f, urls: extractStreamsFromPlayer(ph, f) };
      }).catch(function(err) {
        console.log("[DramaCafe] player failed:", f, err.message);
        return { frame: f, urls: [] };
      });
    })).then(function(frames) {
      frames.forEach(function(fr) {
        if (fr.urls.length) {
          fr.urls.forEach(function(u) { result.direct.push({ url: u, playerUrl: fr.frame }); });
        } else {
          result.embeds.push(fr.frame);
        }
      });
      return result;
    });
  });
}

function emptyPage() { return { direct: [], embeds: [] }; }

// Everything we can offer for one site video id.
function resolveVid(vid, tag) {
  var watchUrl = BASE + "/watch.php?vid=" + vid;
  var embedUrl = BASE + "/embed.php?vid=" + vid;
  var playUrl = BASE + "/play.php?vid=" + vid;
  var dlUrl = BASE + "/downloads.php?vid=" + vid;
  console.log("[DramaCafe] resolve vid:", vid);

  return Promise.all([
    collectFromPage(embedUrl, watchUrl).catch(function(e) {
      console.log("[DramaCafe] embed.php failed:", e.message); return emptyPage();
    }),
    collectFromPage(playUrl, watchUrl).catch(function(e) {
      console.log("[DramaCafe] play.php failed:", e.message); return emptyPage();
    }),
    INCLUDE_DOWNLOAD_LINKS
      ? fetchText(dlUrl, watchUrl).then(parseDownloadLinks).catch(function(e) {
          console.log("[DramaCafe] downloads.php failed:", e.message); return [];
        })
      : Promise.resolve([])
  ]).then(function(r) {
    var pages = [r[0], r[1]];
    var out = [];
    var seen = {};
    var n = 0;

    // 1) direct streams
    pages.forEach(function(p) {
      p.direct.forEach(function(d) {
        if (seen[d.url]) return;
        seen[d.url] = 1;
        n++;
        var host = hostOf(d.playerUrl);
        out.push(makeStream(d.url, tagged(tag, "Server " + n + (host ? " (" + host + ")" : "")), d.playerUrl));
      });
    });

    // 2) iframe-only servers (no direct URL could be extracted)
    var e = 0;
    pages.forEach(function(p) {
      p.embeds.forEach(function(u) {
        if (seen[u]) return;
        seen[u] = 1;
        e++;
        out.push(makeEmbedEntry(u, tagged(tag, "Embed " + e + " (" + hostOf(u) + ")"), embedUrl));
      });
    });

    // 3) download mirrors
    r[2].forEach(function(link) {
      if (seen[link.url]) return;
      seen[link.url] = 1;
      out.push({
        name: "⬇️ DramaCafe",
        title: "⬇️ DramaCafe \u2022 " + tagged(tag, link.name + " (download page)"),
        url: link.url,
        quality: "Download",
        type: DOWNLOAD_ENTRY_TYPE,
        referer: BASE + "/"
      });
    });

    console.log("[DramaCafe] vid", vid, "->", out.length, "links (direct:", n, "embeds:", e, "downloads:", r[2].length + ")");
    return out;
  });
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
      var picks = scored.filter(function(x) { return x.s >= top - VERSION_WINDOW; }).slice(0, MAX_MOVIE_VERSIONS);
      console.log("[DramaCafe] Movie picks:", picks.map(function(p) { return p.r.title + " (" + p.s.toFixed(2) + ")"; }).join(" | "));

      return Promise.all(picks.map(function(p, i) {
        return resolveVid(p.r.vid, picks.length > 1 ? "V" + (i + 1) : "").catch(function() { return []; });
      })).then(function(groups) {
        var out = [];
        groups.forEach(function(g) { out = out.concat(g); });
        return out;
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

function tryBuckets(buckets, i, season, episode) {
  if (i >= buckets.length) return Promise.resolve([]);
  var b = buckets[i];
  function next() { return tryBuckets(buckets, i + 1, season, episode); }
  function go(vid) {
    return resolveVid(vid, "").then(function(s) { return s.length ? s : next(); });
  }

  // search results already contain the exact season + episode
  var direct = pickByTitle(b.items, season, episode);
  if (direct) {
    console.log("[DramaCafe] direct title hit:", direct.title);
    return go(direct.vid);
  }

  // otherwise read the season/episode list from any watch page of the series
  var rep = pickRepresentative(b.items, season);
  return fetchText(rep.url, BASE + "/").then(function(html) {
    var groups = parseEpisodeGroups(html);
    console.log("[DramaCafe] episode list:", groups.map(function(g) { return g.length; }).join("/") || "none");
    var vid = pickFromGroups(groups, season, episode);
    if (!vid) return next();
    return go(vid);
  }).catch(function(err) {
    console.log("[DramaCafe] series page failed:", err.message);
    return next();
  });
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
        if (!buckets[k]) buckets[k] = { key: k, items: [], score: 0 };
        buckets[k].items.push(r);
      });

      var ranked = Object.keys(buckets).map(function(k) {
        var b = buckets[k];
        b.score = bestTitleScore(k, meta.titles);
        return b;
      }).filter(function(b) { return b.score >= MATCH_THRESHOLD; })
        .sort(function(a, b) { return b.score - a.score; });

      console.log("[DramaCafe] Series matches:", ranked.map(function(b) { return b.key + " (" + b.score.toFixed(2) + ")"; }).join(" | ") || "none");
      return tryBuckets(ranked.slice(0, 3), 0, wantedSeason, wantedEp);
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

module.exports = {
  getStreams: getStreams
};
