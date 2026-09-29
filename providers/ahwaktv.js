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

function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, " ").trim();
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

    // Match BOTH relative and absolute watch links with title
    const re = /<a[^>]*href="([^"]*\/watch\.php\?vid=([A-Za-z0-9]+))"[^>]*title="([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const vid = m[2];
      if (seen.has(vid)) continue;
      seen.add(vid);
      let u = m[1];
      if (u.startsWith("//")) u = "https:" + u;
      else if (!u.startsWith("http")) u = DOMAIN + (u.startsWith("/") ? u : "/" + u);
      results.push({ url: u, title: decodeHtml(m[3]), vid });
    }

    // Fallback: watch links with no title
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

// Pick the best result — prefer exact match, then "فيلم"/"مسلسل" by type
function pickBest(results, wantedTitle, mediaType) {
  if (!results.length) return null;
  const nt = normalizeText(wantedTitle);
  const matched = results.filter(r => {
    const rt = normalizeText(r.title);
    return rt.indexOf(nt) !== -1 || nt.indexOf(rt) !== -1;
  });
  const pool = matched.length ? matched : results;

  if (mediaType === "movie") {
    const movieOnly = pool.filter(r => r.title.indexOf("فيلم") !== -1);
    if (movieOnly.length) return movieOnly[0];
  }
  if (mediaType === "tv") {
    const seriesOnly = pool.filter(r => r.title.indexOf("مسلسل") !== -1);
    if (seriesOnly.length) return seriesOnly[0];
  }
  return pool[0];
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

// VidMoly — single-quoted file: '...m3u8...'
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
      console.log("[AhwakTV] VidMoly ✓", url.slice(0, 90));
      return [makeStream(url, "VidMoly", "https://vidmoly.to/", "hls")];
    } catch (e) { console.log("[AhwakTV] VidMoly err:", e.message); return []; }
  });
}

// PlayMogo / DoodStream
function resolveDood(embedUrl) {
  console.log("[AhwakTV] Dood:", embedUrl.slice(0, 80));
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, { headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" }, redirect: "follow" });
      const html = yield res.text();
      const pm = html.match(/["'](\/pass_md5\/[^"']+)["']/i);
      if (!pm) { console.log("[AhwakTV] Dood: no pass_md5"); return []; }
      const tokenMatch = pm[1].match(/\/pass_md5\/([^\/]+)/);
      const token = tokenMatch ? tokenMatch[1] : "";
      const expiryMatch = html.match(/[?&]expiry=([0-9]+)/i);
      const expiry = expiryMatch ? expiryMatch[1] : String(Math.floor(Date.now()/1000) + 3600);
      const originMatch = embedUrl.match(/^(https?:\/\/[^\/]+)/);
      const origin = originMatch ? originMatch[1] : "";
      const pr = yield fetch(origin + pm[1], { headers: { "User-Agent": USER_AGENT, "Referer": embedUrl }, redirect: "follow" });
      const base = yield pr.text();
      if (!base || base.length < 10) return [];
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let rnd = "";
      for (let i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
      const finalUrl = base + rnd + "?token=" + token + "&expiry=" + expiry;
      console.log("[AhwakTV] Dood ✓", finalUrl.slice(0, 90));
      return [makeStream(finalUrl, "PlayMogo", embedUrl, "mp4")];
    } catch (e) { console.log("[AhwakTV] Dood err:", e.message); return []; }
  });
}

// 1Vid — unpack eval
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
      const res = yield fetch(embedUrl, { headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" }, redirect: "follow" });
      const html = yield res.text();
      const unpacked = unpackEval(html) || html;
      const m = unpacked.match(/https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/i);
      if (!m) { console.log("[AhwakTV] 1Vid: no URL"); return []; }
      const url = m[0].replace(/\\\//g, "/");
      const isHls = /\.m3u8/i.test(url);
      console.log("[AhwakTV] 1Vid ✓", url.slice(0, 90));
      return [makeStream(url, "1Vid", embedUrl, isHls ? "hls" : "mp4")];
    } catch (e) { console.log("[AhwakTV] 1Vid err:", e.message); return []; }
  });
}

function resolveEmbed(embedUrl) {
  const host = hostLabel(embedUrl).toLowerCase();
  if (host.indexOf("vidmoly") !== -1) return resolveVidMoly(embedUrl);
  if (host.indexOf("playmogo") !== -1 || host.indexOf("dood") !== -1) return resolveDood(embedUrl);
  if (host.indexOf("1vid") !== -1) return resolve1Vid(embedUrl);
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
    const t0 = Date.now();
    const el = () => "+" + (Date.now() - t0) + "ms";
    console.log("[AhwakTV] START:", tmdbId, mediaType, season, episode);

    if (!tmdbId) return [];
    if (mediaType !== "movie" && mediaType !== "tv") return [];
    if (mediaType === "tv" && (!season || !episode)) return [];

    // Fetch titles
    let titles = yield tmdbTitles(tmdbId, mediaType);
    console.log("[AhwakTV] Titles:", titles.join(" | "), el());
    if (!titles.length) return [];

    // Try first title
    let results = yield searchSite(titles[0]).catch(e => { console.log("[AhwakTV] Search err:", e.message); return []; });
    if (!results.length && titles[1]) {
      results = yield searchSite(titles[1]).catch(() => []);
    }
    if (!results.length) { console.log("[AhwakTV] No search results", el()); return []; }

    // Best match
    const best = pickBest(results, titles[0], mediaType);
    if (!best) { console.log("[AhwakTV] No best match", el()); return []; }
    console.log("[AhwakTV] Best:", best.title, el());

    // For TV, find the wanted episode
    let targetUrl = best.url;
    if (mediaType === "tv") {
      const wantedEp = Number(episode) || 1;
      const titleEpMatch = best.title.match(/الحلقة\s+(\d+)/);
      if (!(titleEpMatch && parseInt(titleEpMatch[1], 10) === wantedEp)) {
        const html = yield get(best.url).catch(() => "");
        const list = extractEpisodeList(html);
        const entry = list.find(e => e.num === wantedEp);
        if (!entry) { console.log("[AhwakTV] Episode " + wantedEp + " not found", el()); return []; }
        targetUrl = entry.url;
      }
    }

    // Fetch watch page → see.php
    const watchHtml = yield get(targetUrl).catch(() => "");
    const seeUrl = extractSeeUrl(watchHtml);
    console.log("[AhwakTV] see.php:", seeUrl ? "found" : "MISSING", el());
    if (!seeUrl) return [];

    // Fetch see.php → embeds
    const seeHtml = yield get(seeUrl, targetUrl).catch(() => "");
    const embeds = extractEmbedUrls(seeHtml);
    console.log("[AhwakTV] Embeds:", embeds.length, "[" + embeds.map(hostLabel).join(", ") + "]", el());
    if (!embeds.length) return [];

    // Try VidMoly first (fast, reliable)
    const vidmoly = embeds.find(u => /vidmoly/i.test(u));
    if (vidmoly) {
      const s = yield resolveVidMoly(vidmoly);
      if (s.length) { console.log("[AhwakTV] DONE via VidMoly", el()); return s; }
    }

    // Try others in order
    const others = embeds.filter(u => !/vidmoly/i.test(u));
    for (const embed of others) {
      const s = yield resolveEmbed(embed);
      if (s.length) { console.log("[AhwakTV] DONE via " + hostLabel(embed), el()); return s; }
    }

    // Last resort: raw iframes so user sees something
    console.log("[AhwakTV] Fallback raw iframes", el());
    return embeds.map(u => ({
      name: "🌙 AhwakTV",
      title: `🌙 AhwakTV • ${hostLabel(u)}`,
      url: u,
      quality: "Auto",
      type: "iframe",
      referer: seeUrl,
      headers: { "User-Agent": USER_AGENT, "Referer": seeUrl }
    }));
  });
}

module.exports = { getStreams };
