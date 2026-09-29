
cd ~/nuvio-akwam

cat > providers/ahwaktv.js << 'EOF'
"use strict";

var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => { try { step(generator.next(value)); } catch (e) { reject(e); } };
    var rejected = (value) => { try { step(generator.throw(value)); } catch (e) { reject(e); } };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
const DOMAIN = "https://yam.ahwaktv.net";
const TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

// ---- Embed resolver settings (edit here) ----
const RESOLVE_EMBEDS = true;           // open each embed page and pull out the real video link
const KEEP_UNRESOLVED_EMBEDS = false;  // false = drop embeds we could not resolve (they only buffer)
const MAX_EMBEDS = 6;                  // max embed servers to try per episode/movie

function decodeHtml(str) {
  return String(str)
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function get(url, referer) {
  return __async(this, null, function* () {
    const res = yield fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": referer || (DOMAIN + "/"),
        "Accept-Language": "ar,en;q=0.9"
      },
      redirect: "follow"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return yield res.text();
  });
}

function tmdbTitles(tmdbId, mediaType) {
  return __async(this, null, function* () {
    const type = mediaType === "movie" ? "movie" : "tv";
    const titles = [];
    for (const lang of ["ar", "en"]) {
      try {
        const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=${lang}`;
        const res = yield fetch(url);
        if (!res.ok) continue;
        const data = yield res.json();
        const t = type === "movie"
          ? (data.title || data.original_title)
          : (data.name || data.original_name);
        if (t && !titles.includes(t)) titles.push(t);
      } catch (_) {}
    }
    return titles;
  });
}

// === URL normalizer: handles both relative and absolute hrefs ===
function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http")) return u;
  if (u.startsWith("/")) return DOMAIN + u;
  return DOMAIN + "/" + u;
}

// Search — uses keywords= AND handles absolute URLs
function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?keywords=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Searching:", url);
    const html = yield get(url);
    const results = [];

    // Primary: any href containing watch.php?vid=, with a title
    const re1 = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
    let m;
    while ((m = re1.exec(html)) !== null) {
      const watchUrl = normalizeUrl(m[1]);
      const title = decodeHtml(m[2]);
      if (!results.find(r => r.url === watchUrl)) {
        results.push({ url: watchUrl, title });
      }
    }

    // Fallback: any watch.php?vid= link without title
    if (!results.length) {
      const re2 = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"/gi;
      while ((m = re2.exec(html)) !== null) {
        const watchUrl = normalizeUrl(m[1]);
        if (!results.find(r => r.url === watchUrl)) {
          results.push({ url: watchUrl, title: "" });
        }
      }
    }

    console.log("[AhwakTV] Found", results.length, "results");
    return results;
  });
}

function extractSeeUrl(html) {
  const m = html.match(/https?:\/\/[a-z0-9.-]*\/see\.php\?vid=[A-Za-z0-9]+/i);
  if (m) return m[0];
  const m2 = html.match(/['"]((?:https?:)?\/\/[^"']*\/see\.php\?vid=[A-Za-z0-9]+)['"]/i);
  if (m2) return normalizeUrl(m2[1]);
  const m3 = html.match(/['"]([^"']*\/see\.php\?vid=[A-Za-z0-9]+)['"]/i);
  if (m3) return normalizeUrl(m3[1]);
  return null;
}

function extractIframes(html) {
  const streams = [];
  const seen = new Set();
  const re = /<iframe[^>]*src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u = decodeHtml(m[1]);
    if (u.startsWith("//")) u = "https:" + u;
    if (!u.startsWith("http")) continue;
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads/i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    streams.push(u);
  }
  return streams;
}

function hostLabel(url) {
  const m = String(url || "").match(/^https?:\/\/(?:www\.)?([^\.\/]+)/i);
  return m ? m[1] : "Server";
}

function qualityFromUrl(url) {
  const s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  return "Auto";
}

function makeStream(url, label, referer) {
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  return {
    name: "🌙 AhwakTV",
    title: `🌙 AhwakTV • ${label}`,
    url: url,
    quality: qualityFromUrl(url),
    type: "iframe",
    referer: referer || (DOMAIN + "/"),
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": referer || (DOMAIN + "/")
    }
  };
}

// ---------------------------------------------------------------
// Embed resolver: pulls the real .m3u8/.mp4 out of an embed page.
// Pure JS unpacker for the "eval(function(p,a,c,k,e,d)" packer.
// ---------------------------------------------------------------
function packerBase(n, radix) {
  return (n < radix ? "" : packerBase(Math.floor(n / radix), radix)) +
    ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
}

function unpackAll(html) {
  const out = [];
  const re = /eval\(function\(p,a,c,k,e,[a-z]\)\{[\s\S]*?\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      const radix = parseInt(m[2], 10);
      let count = parseInt(m[3], 10);
      const dict = m[4].split("|");
      const map = {};
      while (count--) {
        const key = packerBase(count, radix);
        map[key] = dict[count] || key;
      }
      out.push(payload.replace(/\b\w+\b/g, w => (map[w] !== undefined ? map[w] : w)));
    } catch (_) {}
  }
  return out;
}

function findVideoLinks(text, origin) {
  const found = [];
  function add(raw) {
    let u = String(raw || "")
      .replace(/\\\//g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&")
      .trim();
    if (u.startsWith("//")) u = "https:" + u;
    else if (u.startsWith("/")) u = origin + u;
    if (!/^https?:\/\//i.test(u)) return;
    if (!/\.(m3u8|mp4)(\?|#|$)/i.test(u)) return;
    if (!found.includes(u)) found.push(u);
  }
  let m;
  const quoted = /["']([^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)["']/gi;
  while ((m = quoted.exec(text)) !== null) add(m[1]);
  const bare = /https?:\/\/[^"'\s\\<>]+\.(?:m3u8|mp4)[^"'\s\\<>]*/gi;
  while ((m = bare.exec(text)) !== null) add(m[0]);
  return found;
}

function resolveEmbed(embedUrl) {
  return __async(this, null, function* () {
    try {
      const html = yield get(embedUrl, DOMAIN + "/");
      const originMatch = embedUrl.match(/^https?:\/\/[^\/]+/i);
      const origin = originMatch ? originMatch[0] : DOMAIN;
      let links = findVideoLinks(html, origin);
      const unpacked = unpackAll(html);
      for (const block of unpacked) {
        for (const l of findVideoLinks(block, origin)) {
          if (!links.includes(l)) links.push(l);
        }
      }
      console.log("[AhwakTV] embed:", embedUrl, "packed blocks:", unpacked.length, "video links:", links.length);
      if (!links.length) {
        console.log("[AhwakTV] embed sample:", (unpacked.length ? unpacked[0] : html).slice(0, 300));
      }
      return links.map(l => ({ url: l, origin: origin }));
    } catch (e) {
      console.log("[AhwakTV] embed error:", embedUrl, e.message);
      return [];
    }
  });
}

function makeDirectStream(url, label, origin) {
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  return {
    name: "🌙 AhwakTV",
    title: `🌙 AhwakTV • ${label}${/\.m3u8/i.test(url) ? " (HLS)" : ""}`,
    url: url,
    quality: qualityFromUrl(url),
    referer: origin + "/",
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": origin + "/"
    }
  };
}

function resolveSee(seeUrl, referer) {
  console.log("[AhwakTV] see.php:", seeUrl);
  return __async(this, null, function* () {
    try {
      const html = yield get(seeUrl, referer);
      const iframes = extractIframes(html);
      console.log("[AhwakTV] see.php iframes:", iframes.length);

      if (!RESOLVE_EMBEDS) {
        return iframes.map(u => makeStream(u, hostLabel(u), seeUrl));
      }

      const out = [];
      for (const u of iframes.slice(0, MAX_EMBEDS)) {
        const direct = yield resolveEmbed(u);
        if (direct.length) {
          for (const d of direct) {
            out.push(makeDirectStream(d.url, hostLabel(u), d.origin));
          }
        } else if (KEEP_UNRESOLVED_EMBEDS) {
          out.push(makeStream(u, hostLabel(u), seeUrl));
        }
      }
      return out;
    } catch (e) {
      console.log("[AhwakTV] see.php error:", e.message);
      return [];
    }
  });
}

function extractEpisodeList(html) {
  const episodes = [];
  const re = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = normalizeUrl(m[1]);
    const title = decodeHtml(m[2]);
    const numMatch = title.match(/الحلقة\s+(\d+)/);
    if (!numMatch) continue;
    const num = parseInt(numMatch[1], 10);
    if (!episodes.find(e => e.num === num)) {
      episodes.push({ num, url });
    }
  }
  return episodes;
}

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[AhwakTV] Request:", { tmdbId, mediaType, season, episode });
    if (!tmdbId) return [];
    if (mediaType !== "movie" && mediaType !== "tv") return [];
    if (mediaType === "tv" && (!season || !episode)) return [];

    const wantedEp = mediaType === "tv" ? Number(episode) : null;

    let titles = yield tmdbTitles(tmdbId, mediaType);
    console.log("[AhwakTV] Titles:", titles);
    if (!titles.length) titles = [String(tmdbId)];

    const streams = [];
    const seen = new Set();

    for (const title of titles) {
      try {
        const results = yield searchSite(title);
        if (!results.length) continue;

        if (mediaType === "movie") {
          for (const result of results.slice(0, 3)) {
            try {
              const html = yield get(result.url);
              const seeUrl = extractSeeUrl(html);
              if (!seeUrl) continue;
              const resolved = yield resolveSee(seeUrl, result.url);
              for (const s of resolved) {
                if (seen.has(s.url)) continue;
                seen.add(s.url);
                streams.push(s);
              }
              if (streams.length) break;
            } catch (e) {
              console.log("[AhwakTV] Movie page error:", e.message);
            }
          }
        } else {
          for (const result of results.slice(0, 3)) {
            try {
              const html = yield get(result.url);
              const titleEpMatch = result.title.match(/الحلقة\s+(\d+)/);
              let targetUrl = null;

              if (titleEpMatch && parseInt(titleEpMatch[1], 10) === wantedEp) {
                targetUrl = result.url;
              } else {
                const epList = extractEpisodeList(html);
                const epEntry = epList.find(e => e.num === wantedEp);
                if (epEntry) targetUrl = epEntry.url;
              }

              if (!targetUrl) continue;

              const epHtml = targetUrl === result.url ? html : yield get(targetUrl);
              const seeUrl = extractSeeUrl(epHtml);
              if (!seeUrl) continue;
              const resolved = yield resolveSee(seeUrl, targetUrl);
              for (const s of resolved) {
                if (seen.has(s.url)) continue;
                seen.add(s.url);
                streams.push(s);
              }
              if (streams.length) break;
            } catch (e) {
              console.log("[AhwakTV] TV page error:", e.message);
            }
          }
        }

        if (streams.length) break;
      } catch (e) {
        console.log("[AhwakTV] Error:", title, e.message);
      }
    }

    console.log("[AhwakTV] Final streams:", streams.length);
    return streams;
  });
}

module.exports = { getStreams };
EOF

node --check providers/ahwaktv.js && echo "SYNTAX OK"

echo "========== HERMES CHECK =========="
grep -nE "AbortSignal|new URL|Buffer|async function|await |node-fetch|require\(" providers/ahwaktv.js || true
echo "=================================="

node - <<'NODE'
const provider = require('./providers/ahwaktv.js');
(async () => {
  const streams = await provider.getStreams('311287', 'tv', 1, 1);
  console.log('\nSTREAM COUNT:', streams.length);
  for (const s of streams) {
    console.log(s.title);
    console.log(s.url);
    console.log(JSON.stringify(s.headers));
  }
})().catch(err => { console.error(err); process.exit(1); });
NODE
