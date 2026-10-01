// ============================================================
// Rivestream.xyz — Nuvio provider plugin
//
// Rivestream is a Next.js frontend that assembles streams from
// well-known embed providers using the TMDB ID directly.
// URL patterns (confirmed from source / MPA / community docs):
//
//   /watch?type=movie&id={tmdbId}
//   /watch?type=tv&id={tmdbId}&season={s}&episode={e}
//
// The player page embeds multiple iframe servers:
//   • vidlink.pro      /movie/{id}   /tv/{id}/{s}/{e}
//   • vidsrc.to        /embed/movie/{id}   /embed/tv/{id}/{s}/{e}
//   • 2embed.cc        /embed/{id}   /embedtv/{id}&s={s}&e={e}
//   • superembed       /playere.php?tmdb={id}[&season&episode]
//   • embed.su         /embed/movie/{id}   /embed/tv/{id}/{s}/{e}
//   • vidsrc.su        /embed/movie/{id}   /embed/tv/{id}/{s}/{e}
//   • vidsrc.rip       /embed/movie/{id}   /embed/tv/{id}/{s}/{e}
//
// Strategy:
//   1. Hit rivestream.xyz/watch to grab whatever embed URLs the
//      page actually serves for this TMDB ID (most reliable).
//   2. If the page fetch fails (bot block, timeout), fall back to
//      constructing all known server URLs directly.
//   3. Return each embed as type:"iframe" — Nuvio opens these in
//      its built-in webview. That is the only correct approach
//      because each provider uses client-side JS decryption to
//      produce the final m3u8; a server-side scraper cannot get
//      the stream URL without running that JS.
// ============================================================

var BASE = "https://www.rivestream.xyz";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
var FETCH_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------- http
function withTimeout(p, ms) {
  return new Promise(function(res, rej) {
    var done = false;
    var t = setTimeout(function() { if (!done) { done = true; rej(new Error("timeout")); } }, ms);
    p.then(function(v) { if (!done) { done = true; clearTimeout(t); res(v); } },
           function(e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
  });
}

function fetchText(url, referer) {
  var headers = { "User-Agent": UA, "Accept": "text/html,*/*" };
  if (referer) headers["Referer"] = referer;
  return withTimeout(
    fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }),
    FETCH_TIMEOUT_MS
  );
}

// ---------------------------------------------------------------- URL builder helpers
function buildUrls(tmdbId, mediaType, season, episode) {
  var id = String(tmdbId);
  var s  = String(season  || 1);
  var e  = String(episode || 1);
  var isMovie = mediaType !== "tv";

  // Each entry: { name, url }
  var servers = [];

  if (isMovie) {
    servers = [
      { name: "Vidlink",      url: "https://vidlink.pro/movie/" + id },
      { name: "VidSrc",       url: "https://vidsrc.to/embed/movie/" + id },
      { name: "2Embed",       url: "https://www.2embed.cc/embed/" + id },
      { name: "SuperEmbed",   url: "https://multiembed.mov/directstream.php?video_id=" + id + "&tmdb=1" },
      { name: "Embed.su",     url: "https://embed.su/embed/movie/" + id },
      { name: "VidSrc.su",    url: "https://vidsrc.su/embed/movie/" + id },
      { name: "VidSrc.rip",   url: "https://vidsrc.rip/embed/movie/" + id },
      { name: "SmashyStream", url: "https://embed.smashystream.com/playere.php?tmdb=" + id },
      { name: "VidSrc.cc",    url: "https://vidsrc.cc/v2/embed/movie/" + id },
      { name: "AutoEmbed",    url: "https://autoembed.cc/movie/tmdb-" + id },
    ];
  } else {
    servers = [
      { name: "Vidlink",      url: "https://vidlink.pro/tv/" + id + "/" + s + "/" + e },
      { name: "VidSrc",       url: "https://vidsrc.to/embed/tv/" + id + "/" + s + "/" + e },
      { name: "2Embed",       url: "https://www.2embed.cc/embedtv/" + id + "&s=" + s + "&e=" + e },
      { name: "SuperEmbed",   url: "https://multiembed.mov/directstream.php?video_id=" + id + "&tmdb=1&s=" + s + "&e=" + e },
      { name: "Embed.su",     url: "https://embed.su/embed/tv/" + id + "/" + s + "/" + e },
      { name: "VidSrc.su",    url: "https://vidsrc.su/embed/tv/" + id + "/" + s + "/" + e },
      { name: "VidSrc.rip",   url: "https://vidsrc.rip/embed/tv/" + id + "/" + s + "/" + e },
      { name: "SmashyStream", url: "https://embed.smashystream.com/playere.php?tmdb=" + id + "&season=" + s + "&episode=" + e },
      { name: "VidSrc.cc",    url: "https://vidsrc.cc/v2/embed/tv/" + id + "/" + s + "/" + e },
      { name: "AutoEmbed",    url: "https://autoembed.cc/tv/tmdb-" + id + "-" + s + "-" + e },
    ];
  }

  return servers;
}

// ---------------------------------------------------------------- page scrape
// Try to read the iframes Rivestream actually loads for this content,
// which is the ground-truth list. Returns [] on any failure.
function scrapeRivePage(tmdbId, mediaType, season, episode) {
  var s = String(season  || 1);
  var e = String(episode || 1);
  var pageUrl = mediaType === "tv"
    ? BASE + "/watch?type=tv&id=" + tmdbId + "&season=" + s + "&episode=" + e
    : BASE + "/watch?type=movie&id=" + tmdbId;

  console.log("[Rivestream] scraping:", pageUrl);
  return fetchText(pageUrl, BASE + "/").then(function(html) {
    var found = [];
    var seen  = {};

    // Next.js pages embed their data in __NEXT_DATA__ as JSON
    var ndm = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (ndm) {
      try {
        var nd = JSON.parse(ndm[1]);
        // Walk the whole object stringified looking for embed URLs
        var str = JSON.stringify(nd);
        extractEmbeds(str, found, seen);
      } catch (err) {}
    }

    // Also scan the raw HTML for any iframe/data-src pointing at embed services
    extractEmbeds(html, found, seen);

    console.log("[Rivestream] page iframes found:", found.length);
    return found;
  }).catch(function(err) {
    console.log("[Rivestream] page scrape failed:", err.message);
    return [];
  });
}

var EMBED_DOMAINS = [
  "vidlink.pro", "vidsrc.to", "vidsrc.me", "vidsrc.su", "vidsrc.rip", "vidsrc.cc",
  "2embed.cc", "2embed.org", "multiembed.mov", "superembed.stream", "smashystream.com",
  "embed.su", "autoembed.cc", "vidapi.", "moviesapi.", "streamtape.", "doodstream.",
  "filemoon.", "streamwish.", "vidhide.", "upstream.", "streamlare.", "mixdrop.",
];

function extractEmbeds(text, found, seen) {
  // Match anything that looks like an embed URL from a known domain
  var re = /https?:\/\/[^"'\s<>\]\\]+/gi;
  var m;
  while ((m = re.exec(text)) !== null) {
    var u = m[0].replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/&amp;/g, "&");
    // strip trailing junk
    u = u.replace(/['")\]>]+$/, "");
    if (seen[u]) continue;
    var host = (u.match(/^https?:\/\/([^\/]+)/i) || [])[1] || "";
    var isEmbed = EMBED_DOMAINS.some(function(d) { return host.indexOf(d) >= 0; });
    if (!isEmbed) continue;
    seen[u] = 1;
    found.push(u);
  }
}

// ---------------------------------------------------------------- result builder
function makeEntry(name, url, referer) {
  return {
    name: "🌊 Rivestream \u2022 " + name,
    title: "🌊 Rivestream \u2022 " + name,
    url: url,
    quality: "Auto",
    type: "iframe",
    provider: "rivestream",
    referer: referer || (BASE + "/"),
    headers: {
      "User-Agent": UA,
      "Referer": referer || (BASE + "/")
    }
  };
}

// ---------------------------------------------------------------- entry point
function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[Rivestream] getStreams:", tmdbId, mediaType, season, episode);

  var fallbackServers = buildUrls(tmdbId, mediaType, season, episode);

  return scrapeRivePage(tmdbId, mediaType, season, episode).then(function(scraped) {
    var out = [];
    var seen = {};

    if (scraped.length > 0) {
      // Use what the site actually returned, label them by host
      scraped.forEach(function(url) {
        var host = (url.match(/^https?:\/\/([^\/]+)/i) || [])[1] || "Server";
        host = host.replace(/^www\./, "");
        if (!seen[url]) {
          seen[url] = 1;
          out.push(makeEntry(host, url, BASE + "/"));
        }
      });
      console.log("[Rivestream] returning", out.length, "scraped entries");
    }

    // Always include fallback servers not already in the scraped list
    fallbackServers.forEach(function(sv) {
      if (!seen[sv.url]) {
        seen[sv.url] = 1;
        out.push(makeEntry(sv.name, sv.url, BASE + "/"));
      }
    });

    console.log("[Rivestream] total entries:", out.length);
    return out;
  }).catch(function(err) {
    console.log("[Rivestream] error:", err.message);
    // Return fallback list so the plugin always returns something
    return fallbackServers.map(function(sv) {
      return makeEntry(sv.name, sv.url, BASE + "/");
    });
  });
}

// ---------------------------------------------------------------- export (dual: CommonJS + Hermes global)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
       }
