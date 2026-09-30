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

    return results;
  });
}

function scoreCandidates(results, query, mediaType, ep) {
  if (!results.length) return [];
  const nq = normalizeArabic(query);
  const baseQuery = nq.replace(/الحلق[هة]\s*[0-9\u0660-\u0669]+/g, "").trim();
  const baseWords = baseQuery.split(/\s+/).filter(w => w.length >= 2);

  const scored = results.map(r => {
    const nt = normalizeArabic(r.title);
    let score = 0;

    if (baseQuery && nt.indexOf(baseQuery) !== -1) score += 10;

    let wordsHit = 0;
    for (const w of baseWords) {
      if (nt.indexOf(w) !== -1) wordsHit++;
    }
    if (baseWords.length) {
      score += Math.round((wordsHit / baseWords.length) * 8);
    }

    if (mediaType === "movie" && r.title.indexOf("فيلم") !== -1) score += 4;
    if (mediaType === "tv" && r.title.indexOf("مسلسل") !== -1) score += 4;

    if (mediaType === "tv" && ep) {
      const em = r.title.match(/الحلقة\s+([0-9\u0660-\u0669]+)/);
      if (em) {
        const n = parseInt(em[1].replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)), 10);
        if (n === ep) score += 6;
        else score -= 2;
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

function hostLabel(url) {
  const m = String(url || "").match(/^https?:\/\/(?:www\.)?([^\.\/]+)/i);
  return m ? m[1].toUpperCase() : "Server";
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

// FULLY UNLOCKED EXTRACTOR: Grabs direct links AND handles every external player dynamically
function extractEmbedUrls(html, referer) {
  const out = [];
  const seen = new Set();
  
  function add(u, label, type) {
    u = decodeHtml(String(u || "").trim()).replace(/\\\//g, "/");
    if (u.startsWith("//")) u = "https:" + u;
    else if (u.startsWith("/")) u = DOMAIN + u;
    if (!u.startsWith("http")) return;
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads|amazon|gstatic|jquery|w3\.org|schema\.org/i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(makeStream(u, label || hostLabel(u), referer, type));
  }

  let m;
  // 1. Catch direct MP4 and M3U8 links anywhere
  const reDirect = /(?:https?:\/\/|\/)[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*?/gi;
  while ((m = reDirect.exec(html)) !== null) {
    add(m[0], /\.m3u8/i.test(m[0]) ? "HLS Direct" : "MP4 Direct", referer, /\.m3u8/i.test(m[0]) ? "hls" : "mp4");
  }

  // 2. Catch multi-server data attributes (data-url, data-src, etc.)
  const reData = /data-(?:url|src|link|server|embed)=["']([^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) {
    add(m[1], hostLabel(m[1]), referer, "iframe");
  }

  // 3. Catch all standard iframes embedded on see.php
  const reIf = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) !== null) {
    if (m[1].indexOf("see.php") === -1) {
      add(m[1], hostLabel(m[1]), referer, "iframe");
    }
  }

  return out;
}

function resolveCandidate(candidate, mediaType, ep) {
  return __async(this, null, function* () {
    let targetUrl = candidate.url;
    if (mediaType === "tv" && ep) {
      const m = candidate.title.match(/الحلقة\s+([0-9\u0660-\u0669]+)/);
      if (m) {
        const n = parseInt(m[1].replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)), 10);
        if (n !== ep) {
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
    
    // Extract everything dynamically without whitelisting
    const streams = extractEmbedUrls(seeHtml, seeUrl);
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
    if (!titles.length) return [];

    const ep = mediaType === "tv" ? Number(episode) || 1 : null;
    const queries = [];
    if (mediaType === "tv") {
      for (const t of titles) queries.push(t + " الحلقة " + ep);
    }
    for (const t of titles) queries.push(t);

    const searchGroups = yield Promise.all(queries.map(q => searchSite(q).catch(() => [])));
    const allResults = [];
    const seenVids = new Set();
    for (const group of searchGroups) {
      for (const r of group) {
        if (seenVids.has(r.vid)) continue;
        seenVids.add(r.vid);
        allResults.push(r);
      }
    }

    if (!allResults.length) return [];
    const primaryTitle = titles[0] || "";
    const scored = scoreCandidates(allResults, primaryTitle, mediaType, ep);
    const strong = scored.filter(c => c.score >= 6);
    const pool = strong.length ? strong : scored;

    const triedVids = new Set();
    for (const candidate of pool) {
      if (triedVids.size >= 3) break;
      if (triedVids.has(candidate.vid)) continue;
      triedVids.add(candidate.vid);

      const streams = yield resolveCandidate(candidate, mediaType, ep);
      if (streams.length) {
        console.log("[AhwakTV] ✓ Found " + streams.length + " streams");
        return streams;
      }
    }

    return [];
  });
}

module.exports = { getStreams };
