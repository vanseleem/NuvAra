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

function normalizeArabic(s) {
  return String(s || "").replace(/[\u064B-\u065F\u0670]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
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

// Search — filters results so only titles matching the query survive
function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?keywords=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Search:", query);
    const html = yield get(url);
    const results = [];
    const seen = new Set();
    const nq = normalizeArabic(query);
    const queryWords = nq.split(/\s+/).filter(w => w.length > 1);

    const re = /<a[^>]*href="([^"]*\/watch\.php\?vid=([A-Za-z0-9]+))"[^>]*title="([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const vid = m[2];
      if (seen.has(vid)) continue;
      seen.add(vid);
      let u = m[1];
      if (u.startsWith("//")) u = "https:" + u;
      else if (!u.startsWith("http")) u = DOMAIN + (u.startsWith("/") ? u : "/" + u);
      const title = decodeHtml(m[3]);

      // Filter: title must contain the query or at least one query word
      const nt = normalizeArabic(title);
      const containsQuery = nt.indexOf(nq) !== -1;
      const wordMatch = queryWords.length === 0 || queryWords.some(w => nt.indexOf(w) !== -1);
      if (!containsQuery && !wordMatch) continue;

      results.push({ url: u, title, vid });
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

// === FIX: extract ANY data-* attribute with an http URL, plus iframes/hrefs ===
function extractEmbedUrls(html) {
  const out = [];
  const seen = new Set();
  function add(u) {
    u = decodeHtml(String(u || "").trim());
    if (u.startsWith("//")) u = "https:" + u;
    else if (u.startsWith("/")) u = DOMAIN + u;
    if (!u.startsWith("http")) return;
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads|amazon|gstatic|jquery|w3\.org|schema\.org/i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  }
  let m;
  // 1) iframes
  const reIf = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) !== null) add(m[1]);
  // 2) ANY data-* attribute whose value starts with http (catches data-embed-url, data-src, etc)
  const reData = /data-[a-z0-9_-]+=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) add(m[1]);
  // 3) raw URLs to known hosts anywhere
  const reAny = /https?:\/\/[^"'\s<>]*(?:1vid|vidmoly|playmogo|uqload|dood|voe|streamtape|filemoon|upstream|mp4upload|sendvid|sibnet|mixdrop|ds2play|vidspeed|ok\.ru|vk\.com)[^"'\s<>]*/gi;
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

// === VIDMOLY ===
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

// === DOODSTREAM family: playmogo, dood, uqload, ds2play, vidspeed ===
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
      return [makeStream(finalUrl, "Dood", embedUrl, "mp4")];
    } catch (e) { console.log("[AhwakTV] Dood err:", e.message); return []; }
  });
}

// === 1VID ===
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

// === OK.RU / OK.RU embed ===
function resolveOkRu(embedUrl) {
  console.log("[AhwakTV] OK.ru:", embedUrl.slice(0, 80));
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, {
        headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" },
        redirect: "follow"
      });
      const html = yield res.text();
      // HLS manifest
      let m = html.match(/"hlsManifestUrl":"([^"]+)"/i);
      if (m) {
        const url = m[1].replace(/\\\//g, "/");
        console.log("[AhwakTV] OK.ru ✓ HLS");
        return [makeStream(url, "OK.ru", "https://ok.ru/", "hls")];
      }
      // Direct video URL
      m = html.match(/"videoUrl":"([^"]+)"/i);
      if (m) {
        const url = m[1].replace(/\\\//g, "/");
        console.log("[AhwakTV] OK.ru ✓ MP4");
        return [makeStream(url, "OK.ru", "https://ok.ru/", "mp4")];
      }
      // legacy flashvars url720 etc
      m = html.match(/url[0-9]{3}["']?\s*[:=]\s*["']([^"']+)["']/);
      if (m) {
        const url = m[1].replace(/\\\//g, "/");
        console.log("[AhwakTV] OK.ru ✓ legacy");
        return [makeStream(url, "OK.ru", "https://ok.ru/", "mp4")];
      }
      console.log("[AhwakTV] OK.ru: no URL");
      return [];
    } catch (e) { console.log("[AhwakTV] OK.ru err:", e.message); return []; }
  });
}

function resolveEmbed(embedUrl) {
  const host = hostLabel(embedUrl).toLowerCase();
  if (host.indexOf("vidmoly") !== -1) return resolveVidMoly(embedUrl);
  if (host.indexOf("playmogo") !== -1 || host.indexOf("dood") !== -1 ||
      host.indexOf("uqload") !== -1 || host.indexOf("ds2play") !== -1 ||
      host.indexOf("vidspeed") !== -1) return resolveDood(embedUrl);
  if (host.indexOf("1vid") !== -1) return resolve1Vid(embedUrl);
  if (host.indexOf("ok.ru") !== -1 || host.indexOf("okru") !== -1) return resolveOkRu(embedUrl);
  return Promise.resolve([]);
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

    const ep = mediaType === "tv" ? Number(episode) || 1 : null;

    // Build search queries
    const queries = [];
    if (mediaType === "tv") {
      for (const t of titles) {
        queries.push(t + " الحلقة " + ep);
      }
    }
    for (const t of titles) queries.push(t);

    // Collect candidates across all queries
    const allResults = [];
    const seenVids = new Set();
    for (const q of queries) {
      if (allResults.length >= 20) break;
      try {
        const results = yield searchSite(q);
        for (const r of results) {
          if (seenVids.has(r.vid)) continue;
          seenVids.add(r.vid);
          allResults.push(r);
        }
      } catch (e) { console.log("[AhwakTV] Search err:", e.message); }
    }

    if (!allResults.length) { console.log("[AhwakTV] No candidates"); return []; }
    console.log("[AhwakTV] Total candidates:", allResults.length);

    // Sort: TV wants exact episode, movie wants فيلم
    if (mediaType === "tv") {
      allResults.sort((a, b) => {
        const aM = a.title.match(/الحلقة\s+(\d+)/);
        const bM = b.title.match(/الحلقة\s+(\d+)/);
        const aEx = aM && parseInt(aM[1], 10) === ep ? 1 : 0;
        const bEx = bM && parseInt(bM[1], 10) === ep ? 1 : 0;
        return bEx - aEx;
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

    for (const result of allResults) {
      if (streams.length >= 6) break;
      if (triedVids.has(result.vid)) continue;
      triedVids.add(result.vid);

      try {
        // For TV: resolve to the correct episode page
        let targetUrl = result.url;
        if (mediaType === "tv") {
          const m = result.title.match(/الحلقة\s+(\d+)/);
          const isExact = m && parseInt(m[1], 10) === ep;
          if (!isExact) {
            try {
              const html = yield get(result.url);
              const list = extractEpisodeList(html);
              const entry = list.find(e => e.num === ep);
              if (entry) targetUrl = entry.url;
              else continue;
            } catch (_) { continue; }
          }
        }

        const watchHtml = yield get(targetUrl).catch(() => "");
        const seeUrl = extractSeeUrl(watchHtml);
        if (!seeUrl) continue;

        const seeHtml = yield get(seeUrl, targetUrl).catch(() => "");
        const embeds = extractEmbedUrls(seeHtml);
        if (!embeds.length) continue;
        console.log("[AhwakTV] " + result.vid + " embeds:", embeds.map(hostLabel).join(", "));

        // Try every embed with its resolver, in parallel
        const promises = embeds.map(e => resolveEmbed(e).catch(() => []));
        const resolved = yield Promise.all(promises);
        for (const list of resolved) {
          for (const s of list) {
            if (seenUrls.has(s.url)) continue;
            seenUrls.add(s.url);
            streams.push(s);
          }
        }

        if (streams.length >= 2) break;
      } catch (e) {
        console.log("[AhwakTV] Candidate err:", e.message);
      }
    }

    console.log("[AhwakTV] Final streams:", streams.length);
    return streams;
  });
}

module.exports = { getStreams };
