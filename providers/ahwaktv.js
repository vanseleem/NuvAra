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

function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http")) return u;
  if (u.startsWith("/")) return DOMAIN + u;
  return DOMAIN + "/" + u;
}

function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?keywords=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Searching:", url);
    const html = yield get(url);
    const results = [];
    const re1 = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
    let m;
    while ((m = re1.exec(html)) !== null) {
      const watchUrl = normalizeUrl(m[1]);
      const title = decodeHtml(m[2]);
      if (!results.find(r => r.url === watchUrl)) results.push({ url: watchUrl, title });
    }
    if (!results.length) {
      const re2 = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"/gi;
      while ((m = re2.exec(html)) !== null) {
        const watchUrl = normalizeUrl(m[1]);
        if (!results.find(r => r.url === watchUrl)) results.push({ url: watchUrl, title: "" });
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

// Collect every embed URL from see.php — iframes, links, data attributes
function extractEmbedUrls(html) {
  const out = [];
  const seen = new Set();

  function add(u) {
    u = decodeHtml(String(u || "").trim());
    if (u.startsWith("//")) u = "https:" + u;
    if (u.startsWith("/")) u = DOMAIN + u;
    if (!u.startsWith("http")) return;
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads|amazon|gstatic/i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  }

  // 1) iframes
  let m;
  const reIf = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) !== null) add(m[1]);

  // 2) <a> with data-url or href pointing to known hosts
  const reHref = /href=["']([^"']*(?:1vid|vidmoly|playmogo|uqload|dood|voe|streamtape|filemoon|upstream|mp4upload|sendvid|sibnet|mixdrop)[^"']*)["']/gi;
  while ((m = reHref.exec(html)) !== null) add(m[1]);

  // 3) data-* attributes with URLs
  const reData = /data-(?:url|src|embed|video|server)=["']([^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) add(m[1]);

  // 4) Any http link to a known host anywhere in text
  const reAny = /https?:\/\/[^"'\s<>]*(?:1vid|vidmoly|playmogo|uqload|dood|voe|streamtape|filemoon|upstream|mp4upload|sendvid|sibnet|mixdrop)[^"'\s<>]*/gi;
  while ((m = reAny.exec(html)) !== null) add(m[0]);

  return out;
}

function hostLabel(url) {
  const m = String(url || "").match(/^https?:\/\/(?:www\.)?([^\.\/]+)/i);
  return m ? m[1] : "Server";
}

function makeStream(url, label, referer, type) {
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  let t = type || "iframe";
  if (/\.m3u8/i.test(url)) t = "hls";
  else if (/\.mp4/i.test(url)) t = "mp4";
  return {
    name: "🌙 AhwakTV",
    title: `🌙 AhwakTV • ${label}`,
    url: url,
    quality: "Auto",
    type: t,
    referer: referer || (DOMAIN + "/"),
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": referer || (DOMAIN + "/")
    }
  };
}

// === VIDMOLY: extract m3u8 from sources: [{ file: '...' }] ===
function resolveVidMoly(embedUrl) {
  console.log("[AhwakTV] VidMoly:", embedUrl);
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Referer": DOMAIN + "/",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow"
      });
      const html = yield res.text();
      // Match: sources: [{ file: 'https://...m3u8...' }],
      let m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/i);
      if (!m) {
        // Alternate: file: 'https://...m3u8' anywhere
        m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      }
      if (!m) {
        console.log("[AhwakTV] VidMoly: no m3u8");
        return [];
      }
      const url = m[1].replace(/\\\//g, "/");
      console.log("[AhwakTV] VidMoly m3u8:", url.slice(0, 120));
      return [makeStream(url, "VidMoly", "https://vidmoly.to/", "hls")];
    } catch (e) {
      console.log("[AhwakTV] VidMoly error:", e.message);
      return [];
    }
  });
}

// === PLAYMOGO / DOODSTREAM: pass_md5 flow ===
function resolveDood(embedUrl) {
  console.log("[AhwakTV] Dood:", embedUrl);
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" },
        redirect: "follow"
      });
      const html = yield res.text();
      const pm = html.match(/["'](\/pass_md5\/[^"']+)["']/i);
      if (!pm) { console.log("[AhwakTV] Dood: no pass_md5"); return []; }
      const passPath = pm[1];
      const tokenMatch = passPath.match(/\/pass_md5\/([^\/]+)/);
      const token = tokenMatch ? tokenMatch[1] : "";
      const expiryMatch = html.match(/[?&]expiry=([0-9]+)/i);
      const expiry = expiryMatch ? expiryMatch[1] : String(Math.floor(Date.now()/1000) + 3600);
      const originMatch = embedUrl.match(/^(https?:\/\/[^\/]+)/);
      const origin = originMatch ? originMatch[1] : "";
      const pr = yield fetch(origin + passPath, {
        headers: { "User-Agent": USER_AGENT, "Referer": embedUrl },
        redirect: "follow"
      });
      const base = yield pr.text();
      if (!base || base.length < 10) return [];
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let rnd = "";
      for (let i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
      const finalUrl = base + rnd + "?token=" + token + "&expiry=" + expiry;
      console.log("[AhwakTV] Dood resolved:", finalUrl.slice(0, 120));
      return [makeStream(finalUrl, "PlayMogo", embedUrl, "mp4")];
    } catch (e) {
      console.log("[AhwakTV] Dood error:", e.message);
      return [];
    }
  });
}

// === 1VID: unpack eval + extract URL ===
function unpackEval(html) {
  const m = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  let payload = m[1];
  const base = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  const kw = m[4].split("|");
  let i = count;
  while (i--) {
    if (kw[i]) {
      const pat = new RegExp("\\b" + i.toString(base) + "\\b", "g");
      payload = payload.replace(pat, kw[i]);
    }
  }
  return payload;
}

function resolve1Vid(embedUrl) {
  console.log("[AhwakTV] 1Vid:", embedUrl);
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" },
        redirect: "follow"
      });
      const html = yield res.text();
      const unpacked = unpackEval(html) || html;
      const m = unpacked.match(/https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/i);
      if (!m) { console.log("[AhwakTV] 1Vid: no direct URL"); return []; }
      const url = m[0].replace(/\\\//g, "/");
      console.log("[AhwakTV] 1Vid found:", url.slice(0, 120));
      const isHls = /\.m3u8/i.test(url);
      return [makeStream(url, "1Vid", embedUrl, isHls ? "hls" : "mp4")];
    } catch (e) {
      console.log("[AhwakTV] 1Vid error:", e.message);
      return [];
    }
  });
}

function resolveEmbed(embedUrl) {
  const host = hostLabel(embedUrl).toLowerCase();
  if (host.indexOf("vidmoly") !== -1) return resolveVidMoly(embedUrl);
  if (host.indexOf("playmogo") !== -1 || host.indexOf("dood") !== -1) return resolveDood(embedUrl);
  if (host.indexOf("1vid") !== -1) return resolve1Vid(embedUrl);
  return Promise.resolve([]);
}

function resolveSee(seeUrl, referer) {
  console.log("[AhwakTV] see.php:", seeUrl);
  return __async(this, null, function* () {
    try {
      const html = yield get(seeUrl, referer);
      const embeds = extractEmbedUrls(html);
      console.log("[AhwakTV] Embeds found:", embeds.length, embeds.map(hostLabel).join(", "));

      const all = [];
      const seen = new Set();
      for (const embed of embeds) {
        const resolved = yield resolveEmbed(embed);
        for (const s of resolved) {
          if (seen.has(s.url)) continue;
          seen.add(s.url);
          all.push(s);
        }
      }
      return all;
    } catch (e) {
      console.log("[AhwakTV] see.php error:", e.message);
      return [];
    }
  });
}

function extractEpisodeList(html) {
  const eps = [];
  const re = /<a[^>]*href="([^"]*\/watch\.php\?vid=[A-Za-z0-9]+)"[^>]*title="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const numMatch = decodeHtml(m[2]).match(/الحلقة\s+(\d+)/);
    if (!numMatch) continue;
    const num = parseInt(numMatch[1], 10);
    if (!eps.find(e => e.num === num)) eps.push({ num, url: normalizeUrl(m[1]) });
  }
  return eps;
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
            } catch (e) { console.log("[AhwakTV] Movie page error:", e.message); }
          }
        } else {
          for (const result of results.slice(0, 3)) {
            try {
              const html = yield get(result.url);
              const titleEpMatch = result.title.match(/الحلقة\s+(\d+)/);
              let targetUrl = null;
              if (titleEpMatch && parseInt(titleEpMatch[1], 10) === wantedEp) targetUrl = result.url;
              else {
                const list = extractEpisodeList(html);
                const entry = list.find(e => e.num === wantedEp);
                if (entry) targetUrl = entry.url;
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
            } catch (e) { console.log("[AhwakTV] TV page error:", e.message); }
          }
        }
        if (streams.length) break;
      } catch (e) { console.log("[AhwakTV] Error:", title, e.message); }
    }

    console.log("[AhwakTV] Final streams:", streams.length);
    return streams;
  });
}

module.exports = { getStreams };
