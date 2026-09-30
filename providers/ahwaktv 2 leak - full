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
  return String(s || "")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\w\u0600-\u06FF ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

// Search — NO filter here, just collect everything
function searchSite(query) {
  return __async(this, null, function* () {
    const url = `${DOMAIN}/search.php?keywords=${encodeURIComponent(query)}`;
    console.log("[AhwakTV] Search:", query);
    const html = yield get(url);
    const results = [];
    const seen = new Set();

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

    // Fallback: no title attribute
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

    console.log("[AhwakTV] Raw results:", results.length);
    return results;
  });
}

// Score and sort candidates by how well their title matches the query
function scoreCandidates(results, query, mediaType, ep) {
  if (!results.length) return [];
  const nq = normalizeArabic(query);
  // Strip "الحلقة N" from query
  const baseQuery = nq.replace(/الحلق[هة]\s*[0-9\u0660-\u0669]+/g, "").trim();
  const baseWords = baseQuery.split(/\s+/).filter(w => w.length >= 2);

  const scored = results.map(r => {
    const nt = normalizeArabic(r.title);
    let score = 0;

    // Full query containment — biggest signal
    if (baseQuery && nt.indexOf(baseQuery) !== -1) score += 10;

    // Per-word match
    let wordsHit = 0;
    for (const w of baseWords) {
      if (nt.indexOf(w) !== -1) wordsHit++;
    }
    if (baseWords.length) {
      const ratio = wordsHit / baseWords.length;
      score += Math.round(ratio * 8);
    }

    // Type preference
    if (mediaType === "movie" && r.title.indexOf("فيلم") !== -1) score += 4;
    if (mediaType === "tv" && r.title.indexOf("مسلسل") !== -1) score += 4;

    // Exact episode match for TV
    if (mediaType === "tv" && ep) {
      const em = r.title.match(/الحلقة\s+([0-9\u0660-\u0669]+)/);
      if (em) {
        const n = parseInt(em[1].replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)), 10);
        if (n === ep) score += 6;
        else score -= 2; // wrong episode — penalty
      }
    }

    return Object.assign({}, r, { score });
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
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
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads|amazon|gstatic|jquery|w3\.org|schema\.org/i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  }
  let m;
  const reIf = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) !== null) add(m[1]);
  const reData = /data-[a-z0-9_-]+=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) add(m[1]);
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

function resolveVidMoly(embedUrl) {
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, { headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" }, redirect: "follow" });
      const html = yield res.text();
      let m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/i);
      if (!m) m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      if (!m) return [];
      return [makeStream(m[1].replace(/\\\//g, "/"), "VidMoly", "https://vidmoly.to/", "hls")];
    } catch (e) { console.log("[AhwakTV] VidMoly err:", e.message); return []; }
  });
}

function resolveDood(embedUrl) {
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, { headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" }, redirect: "follow" });
      const html = yield res.text();
      const pm = html.match(/["'](\/pass_md5\/[^"']+)["']/i);
      if (!pm) return [];
      const token = (pm[1].match(/\/pass_md5\/([^\/]+)/) || [])[1] || "";
      const expiry = (html.match(/[?&]expiry=([0-9]+)/i) || [])[1] || String(Math.floor(Date.now()/1000) + 3600);
      const origin = (embedUrl.match(/^(https?:\/\/[^\/]+)/) || [])[1] || "";
      const pr = yield fetch(origin + pm[1], { headers: { "User-Agent": USER_AGENT, "Referer": embedUrl }, redirect: "follow" });
      const base = yield pr.text();
      if (!base || base.length < 10) return [];
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let rnd = "";
      for (let i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
      return [makeStream(base + rnd + "?token=" + token + "&expiry=" + expiry, "Dood", embedUrl, "mp4")];
    } catch (e) { console.log("[AhwakTV] Dood err:", e.message); return []; }
  });
}

function unpackEval(html) {
  const m = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  let payload = m[1];
  const base = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  const kw = m[4].split("|");
  let i = count;
  while (i--) {
    if (kw[i]) payload = payload.replace(new RegExp("\\b" + i.toString(base) + "\\b", "g"), kw[i]);
  }
  return payload;
}

function resolve1Vid(embedUrl) {
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, { headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" }, redirect: "follow" });
      const html = yield res.text();
      const unpacked = unpackEval(html) || html;
      const m = unpacked.match(/https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/i);
      if (!m) return [];
      const url = m[0].replace(/\\\//g, "/");
      return [makeStream(url, "1Vid", embedUrl, /\.m3u8/i.test(url) ? "hls" : "mp4")];
    } catch (e) { console.log("[AhwakTV] 1Vid err:", e.message); return []; }
  });
}

function resolveOkRu(embedUrl) {
  return __async(this, null, function* () {
    try {
      const res = yield fetch(embedUrl, { headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/" }, redirect: "follow" });
      const html = yield res.text();
      let m = html.match(/"hlsManifestUrl":"([^"]+)"/i);
      if (m) return [makeStream(m[1].replace(/\\\//g, "/"), "OK.ru", "https://ok.ru/", "hls")];
      m = html.match(/"videoUrl":"([^"]+)"/i);
      if (m) return [makeStream(m[1].replace(/\\\//g, "/"), "OK.ru", "https://ok.ru/", "mp4")];
      m = html.match(/url[0-9]{3}["']?\s*[:=]\s*["']([^"']+)["']/);
      if (m) return [makeStream(m[1].replace(/\\\//g, "/"), "OK.ru", "https://ok.ru/", "mp4")];
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

// Resolve all embeds from a candidate — return ALL working streams
function resolveCandidate(candidate, mediaType, ep) {
  return __async(this, null, function* () {
    let targetUrl = candidate.url;
    // For TV: if candidate isn't the exact episode, try to find it
    if (mediaType === "tv" && ep) {
      const m = candidate.title.match(/الحلقة\s+([0-9\u0660-\u0669]+)/);
      if (m) {
        const n = parseInt(m[1].replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)), 10);
        if (n !== ep) {
          // Wrong episode candidate — try fetching page and finding episode list
          try {
            const html = yield get(candidate.url);
            const re = /<a[^>]*href="([^"]*\/watch\.php\?vid=([A-Za-z0-9]+))"[^>]*title="([^"]*)"/gi;
            let lm;
            const eps = [];
            while ((lm = re.exec(html)) !== null) {
              const em = decodeHtml(lm[3]).match(/الحلقة\s+([0-9\u0660-\u0669]+)/);
              if (!em) continue;
              const num = parseInt(em[1].replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)), 10);
              if (eps.find(e => e.num === num)) continue;
              let u = lm[1];
              if (u.startsWith("//")) u = "https:" + u;
              else if (!u.startsWith("http")) u = DOMAIN + (u.startsWith("/") ? u : "/" + u);
              eps.push({ num, url: u });
            }
            const match = eps.find(e => e.num === ep);
            if (!match) return [];
            targetUrl = match.url;
          } catch (_) { return []; }
        }
      }
    }

    const watchHtml = yield get(targetUrl).catch(() => "");
    const seeUrl = extractSeeUrl(watchHtml);
    if (!seeUrl) return [];
    const seeHtml = yield get(seeUrl, targetUrl).catch(() => "");
    const embeds = extractEmbedUrls(seeHtml);
    if (!embeds.length) return [];

    // Resolve all embeds in parallel
    const resolved = yield Promise.all(embeds.map(e => resolveEmbed(e).catch(() => [])));
    const streams = [];
    const seen = new Set();
    for (const list of resolved) {
      for (const s of list) {
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        streams.push(s);
      }
    }
    return streams;
  });
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

    // Build queries — for TV, include episode number
    const queries = [];
    if (mediaType === "tv") {
      for (const t of titles) queries.push(t + " الحلقة " + ep);
    }
    for (const t of titles) queries.push(t);

    // === SPEED: fire ALL searches in parallel ===
    const searchGroups = yield Promise.all(queries.map(q => searchSite(q).catch(() => [])));

    // Merge unique
    const allResults = [];
    const seenVids = new Set();
    for (const group of searchGroups) {
      for (const r of group) {
        if (seenVids.has(r.vid)) continue;
        seenVids.add(r.vid);
        allResults.push(r);
      }
    }

    if (!allResults.length) { console.log("[AhwakTV] No candidates"); return []; }
    console.log("[AhwakTV] Total candidates:", allResults.length);

    // === LEAK FIX: score candidates by title match ===
    const primaryTitle = titles[0] || "";
    const scored = scoreCandidates(allResults, primaryTitle, mediaType, ep);
    console.log("[AhwakTV] Top candidates:",
      scored.slice(0, 3).map(c => `[${c.score}] ${c.title.slice(0, 40)}`).join(" | "));

    // Filter: keep only candidates with strong score (>= 6)
    const strong = scored.filter(c => c.score >= 6);
    const pool = strong.length ? strong : scored;
    console.log("[AhwakTV] Strong matches:", strong.length, "/ Using pool of:", pool.length);

    // === Try candidates in order, return ALL streams from the first that works ===
    const triedVids = new Set();
    for (const candidate of pool) {
      if (triedVids.size >= 3) break;
      if (triedVids.has(candidate.vid)) continue;
      triedVids.add(candidate.vid);

      console.log("[AhwakTV] Trying " + candidate.vid + " (score " + candidate.score + "): " + candidate.title.slice(0, 60));
      const streams = yield resolveCandidate(candidate, mediaType, ep);
      if (streams.length) {
        console.log("[AhwakTV] ✓ " + streams.length + " streams from " + candidate.vid);
        return streams;
      }
    }

    console.log("[AhwakTV] No streams found");
    return [];
  });
}

module.exports = { getStreams };
