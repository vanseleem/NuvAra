"use strict";

var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => { try { step(generator.next(value)); } catch (e) { reject(e); } };
    var rejected = (value) => { try { step(generator.throw(value)); } catch (e) { reject(e); } };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

const USER_AGENT = "Mozilla/5.0 (Linux; Android 10, K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
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

function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?keywords=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Search:", query);
    const html = yield get(url);
    const results = [];
    const seen = new Set();

    // Primary: any <a> with href containing watch.php?vid= and a title attribute
    const re1 = /<a[^>]*href="([^"]*\/watch\.php\?vid=([A-Za-z0-9]+))"[^>]*title="([^"]*)"/gi;
    let m;
    while ((m = re1.exec(html)) !== null) {
      const vid = m[2];
      if (seen.has(vid)) continue;
      seen.add(vid);
      let u = m[1];
      if (u.startsWith("//")) u = "https:" + u;
      else if (!u.startsWith("http")) u = DOMAIN + (u.startsWith("/") ? u : "/" + u);
      results.push({ url: u, title: decodeHtml(m[3]), vid });
    }

    // Fallback: any watch link without title
    if (!results.length) {
      const re2 = /<a[^>]*href="([^"]*\/watch\.php\?vid=([A-Za-z0-9]+))"/gi;
      while ((m = re2.exec(html)) !== null) {
        const vid = m[2];
        if (seen.has(vid)) continue;
        seen.add(vid);
        let u = m[1];
        if (u.startsWith("//")) u = "https:" + u;
        else if (!u.startsWith("http")) u = DOMAIN + (u.startsWith("/") ? u : "/" + u);
        results.push({ url: u, title: "", vid });
      }
    }

    console.log("[AhwakTV] Results:", results.length);
    return results;
  });
}

function extractSeeUrl(html) {
  const m = html.match(/https?:\/\/[a-z0-9.-]*\/see\.php\?vid=[A-Za-z0-9]+/i);
  if (m) return m[0];
  const m2 = html.match(/['"]((?:https?:)?\/\/[^"']*\/see\.php\?vid=[A-Za-z0-9]+)['"]/i);
  if (m2) { let u = m2[1]; if (u.startsWith("//")) u = "https:" + u; return u; }
  const m3 = html.match(/['"]([^"']*\/see\.php\?vid=[A-Za-z0-9]+)['"]/i);
  if (m3) { let u = m3[1]; if (u.startsWith("//")) u = "https:" + u; else if (!u.startsWith("http")) u = DOMAIN + (u.startsWith("/") ? u : "/" + u); return u; }
  return null;
}

function extractEmbedUrls(html) {
  const out = [];
  const seen = new Set();
  function add(u) {
    u = decodeHtml(String(u || "").trim());
    if (u.startsWith("//")) u = "https:" + u;
    else if (u.startsWith("/")) u = DOMAIN + u;
    if (!u.startsWith("http")) return;
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads|amazon|gstatic|jquery/i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  }
  let m;
  const reIf = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) !== null) add(m[1]);
  const reHref = /href=["']([^"']*(?:1vid|vidmoly|playmogo|uqload|dood|voe|streamtape|filemoon|upstream|mp4upload|sendvid|sibnet|mixdrop)[^"']*)["']/gi;
  while ((m = reHref.exec(html)) !== null) add(m[1]);
  const reData = /data-(?:url|src|embed|video|server)=["']([^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) add(m[1]);
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
    headers: { "User-Agent": USER_AGENT, "Referer": referer || (DOMAIN + "/") }
  };
}

// === VIDMOLY resolver ===
function resolveVidMoly(embedUrl) {
  console.log("[AhwakTV] VidMoly:", embedUrl.slice(0, 80));
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/", "Accept": "text/html,*/*" },
        redirect: "follow"
      });
      const html = yield res.text();
      let m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/i);
      if (!m) m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      if (!m) { console.log("[AhwakTV] VidMoly: no m3u8"); return []; }
      const url = m[1].replace(/\\\//g, "/");
      console.log("[AhwakTV] VidMoly ✓");
      return [makeStream(url, "VidMoly", "https://vidmoly.to/", "hls")];
    } catch (e) { console.log("[AhwakTV] VidMoly err:", e.message); return []; }
  });
}

// === PLAYMOGO / DOODSTREAM resolver ===
function resolveDood(embedUrl) {
  console.log("[AhwakTV] Dood:", embedUrl.slice(0, 80));
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" },
        redirect: "follow"
      });
      const html = yield res.text();
      const pm = html.match(/["'](\/pass_md5\/[^"']+)["']/i);
      if (!pm) { console.log("[AhwakTV] Dood: no pass_md5"); return []; }
      const tokenMatch = pm[1].match(/\/pass_md5\/([^\/]+)/);
      const token = tokenMatch ? tokenMatch[1] : "";
      const expiryMatch = html.match(/[?&]expiry=([0-9]+)/i);
      const expiry = expiryMatch ? expiryMatch[1] : String(Math.floor(Date.now()/1000) + 3600);
      const originMatch = embedUrl.match(/^(https?:\/\/[^\/]+)/);
      const origin = originMatch ? originMatch[1] : "";
      const pr = yield fetch(origin + pm[1], {
        headers: { "User-Agent": USER_AGENT, "Referer": embedUrl },
        redirect: "follow"
      });
      const base = yield pr.text();
      if (!base || base.length < 10) { console.log("[AhwakTV] Dood: empty base"); return []; }
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let rnd = "";
      for (let i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
      const finalUrl = base + rnd + "?token=" + token + "&expiry=" + expiry;
      console.log("[AhwakTV] Dood ✓");
      return [makeStream(finalUrl, "PlayMogo", embedUrl, "mp4")];
    } catch (e) { console.log("[AhwakTV] Dood err:", e.message); return []; }
  });
}

// === 1VID resolver (best effort) ===
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
  console.log("[AhwakTV] 1Vid:", embedUrl.slice(0, 80));
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" },
        redirect: "follow"
      });
      const html = yield res.text();
      const unpacked = unpackEval(html) || html;
      const m = unpacked.match(/https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/i);
      if (!m) { console.log("[AhwakTV] 1Vid: no URL"); return []; }
      const url = m[0].replace(/\\\//g, "/");
      const isHls = /\.m3u8/i.test(url);
      console.log("[AhwakTV] 1Vid ✓");
      return [makeStream(url, "1Vid", embedUrl, isHls ? "hls" : "mp4")];
    } catch (e) { console.log("[AhwakTV] 1Vid err:", e.message); return []; }
  });
}

function extractEpisodeList(html) {
  const eps = [];
  const re = /<a[^>]*href="([^"]*\/watch\.php\?vid=([A-Za-z0-9]+))"[^>]*title="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const numMatch = decodeHtml(m[3]).match(/الحلقة\s+(\d+)/);
    if (!numMatch) continue;
    const num = parseInt(numMatch[1], 10);
    if (eps.find(e => e.num === num)) continue;
    let u = m[1];
    if (u.startsWith("//")) u = "https:" + u;
    else if (!u.startsWith("http")) u = DOMAIN + (u.startsWith("/") ? u : "/" + u);
    eps.push({ num, url: u });
  }
  return eps;
}

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[AhwakTV] START:", tmdbId, mediaType, season, episode);
    if (!tmdbId) return [];
    if (mediaType !== "movie" && mediaType !== "tv") return [];
    if (mediaType === "tv" && (!season || !episode)) return [];

    const titles = yield tmdbTitles(tmdbId, mediaType);
    console.log("[AhwakTV] Titles:", titles.join(" | "));
    if (!titles.length) return [];

    // Search with both titles — collect ALL unique results
    const allResults = [];
    const seenVids = new Set();

    // For TV: append episode number to improve hit rate
    const queries = [];
    if (mediaType === "tv") {
      const ep = Number(episode) || 1;
      for (const t of titles) {
        queries.push(t + " الحلقة " + ep);
        queries.push(t);
      }
    } else {
      for (const t of titles) {
        queries.push(t);
      }
    }

    for (const q of queries) {
      try {
        const results = yield searchSite(q);
        for (const r of results) {
          if (seenVids.has(r.vid)) continue;
          seenVids.add(r.vid);
          allResults.push(r);
        }
        // If we already have plenty, stop searching
        if (allResults.length >= 15) break;
      } catch (e) {
        console.log("[AhwakTV] Search err:", e.message);
      }
    }

    if (!allResults.length) { console.log("[AhwakTV] No results at all"); return []; }
    console.log("[AhwakTV] Total candidates:", allResults.length);

    // Sort: for TV, prefer exact episode match. For movie, prefer "فيلم".
    if (mediaType === "tv") {
      const ep = Number(episode) || 1;
      allResults.sort((a, b) => {
        const aM = a.title.match(/الحلقة\s+(\d+)/);
        const bM = b.title.match(/الحلقة\s+(\d+)/);
        const aExact = aM && parseInt(aM[1], 10) === ep ? 1 : 0;
        const bExact = bM && parseInt(bM[1], 10) === ep ? 1 : 0;
        return bExact - aExact;
      });
    } else {
      allResults.sort((a, b) => {
        const aF = a.title.indexOf("فيلم") !== -1 ? 1 : 0;
        const bF = b.title.indexOf("فيلم") !== -1 ? 1 : 0;
        return bF - aF;
      });
    }

    const streams = [];
    const seenUrls = new Set();
    const triedVids = new Set();

    // Try up to 6 candidates
    for (const result of allResults) {
      if (streams.length >= 4) break;
      if (triedVids.has(result.vid)) continue;
      triedVids.add(result.vid);

      try {
        // For TV: if this result is a series page (not the exact episode), find the episode URL
        let targetUrl = result.url;
        if (mediaType === "tv") {
          const ep = Number(episode) || 1;
          const m = result.title.match(/الحلقة\s+(\d+)/);
          const isExact = m && parseInt(m[1], 10) === ep;
          if (!isExact) {
            // Fetch page and look for episode list
            try {
              const html = yield get(result.url);
              const list = extractEpisodeList(html);
              const entry = list.find(e => e.num === ep);
              if (entry) {
                targetUrl = entry.url;
              } else {
                // No episode list on this page — skip
                continue;
              }
            } catch (_) { continue; }
          }
        }

        const watchHtml = yield get(targetUrl).catch(() => "");
        const seeUrl = extractSeeUrl(watchHtml);
        if (!seeUrl) continue;

        const seeHtml = yield get(seeUrl, targetUrl).catch(() => "");
        const embeds = extractEmbedUrls(seeHtml);
        if (!embeds.length) continue;
        console.log("[AhwakTV] Embeds on " + result.vid + ":", embeds.map(hostLabel).join(", "));

        // Try each embed with its resolver
        for (const embed of embeds) {
          const host = hostLabel(embed).toLowerCase();
          let resolved = [];
          if (host.indexOf("vidmoly") !== -1) {
            resolved = yield resolveVidMoly(embed);
          } else if (host.indexOf("playmogo") !== -1 || host.indexOf("dood") !== -1) {
            resolved = yield resolveDood(embed);
          } else if (host.indexOf("1vid") !== -1) {
            resolved = yield resolve1Vid(embed);
          }
          for (const s of resolved) {
            if (seenUrls.has(s.url)) continue;
            seenUrls.add(s.url);
            streams.push(s);
          }
        }
      } catch (e) {
        console.log("[AhwakTV] Candidate err:", e.message);
      }
    }

    // If nothing resolved, return raw embeds from the first candidate that had them
    if (!streams.length) {
      console.log("[AhwakTV] No resolver worked, trying raw iframe fallback");
      for (const result of allResults.slice(0, 2)) {
        try {
          const watchHtml = yield get(result.url).catch(() => "");
          const seeUrl = extractSeeUrl(watchHtml);
          if (!seeUrl) continue;
          const seeHtml = yield get(seeUrl, result.url).catch(() => "");
          const embeds = extractEmbedUrls(seeHtml);
          for (const embed of embeds) {
            if (seenUrls.has(embed)) continue;
            seenUrls.add(embed);
            streams.push(makeStream(embed, hostLabel(embed), seeUrl, "iframe"));
          }
        } catch (_) {}
      }
    }

    console.log("[AhwakTV] Final streams:", streams.length);
    return streams;
  });
}

module.exports = { getStreams };
