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

const T_PAGE = 5000;
const T_TMDB = 4000;
const T_PROBE = 4000;
const HARD_MS = 8000;
const GRACE_MS = 2500;
const MAX_STREAMS = 6;
const MAX_CANDIDATES = 2;
const MAX_EMBEDS = 8;

const tmdbCache = new Map();

// ---------- utils ----------
function decodeHtml(str) {
  return String(str)
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function unesc(u) {
  return String(u || "").replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
}

function norm(s) {
  return decodeHtml(String(s || "")).toLowerCase()
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[\u060C\u061B\u061F]/g, " ")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\u0600-\u06FFa-z0-9]+/g, " ")
    .trim();
}

function fetchT(url, opts, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(url, opts).then(
      r => { clearTimeout(t); resolve(r); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

function get(url, referer) {
  return __async(this, null, function* () {
    const res = yield fetchT(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": referer || (DOMAIN + "/"),
        "Accept-Language": "ar,en;q=0.9"
      },
      redirect: "follow"
    }, T_PAGE);
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return yield res.text();
  });
}

function absUrl(u) {
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http")) return u;
  return DOMAIN + (u.startsWith("/") ? u : "/" + u);
}

function hostOf(u) {
  const m = String(u || "").match(/^https?:\/\/([^\/?#:]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function originOf(u) {
  const m = String(u || "").match(/^(https?:\/\/[^\/?#]+)/i);
  return m ? m[1] : "";
}

function vidOf(u) {
  const m = String(u || "").match(/vid=([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}

// ---------- title parsing / strict matching ----------
const NOISE = new Set([
  "مشاهده", "تحميل", "مسلسل", "فيلم", "مسلسلات", "افلام", "كامل", "كامله",
  "مترجم", "مترجمه", "مدبلج", "مدبلجه", "اون", "لاين", "اونلاين", "جوده",
  "عاليه", "بجوده", "hd", "bluray", "720p", "1080p", "web", "dl", "بدون",
  "اعلانات", "انمي", "برنامج", "جميع", "المواسم", "حصريا", "مباشره", "full"
].map(norm));

const ORD = {
  "الاول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 4, "الخامس": 5,
  "السادس": 6, "السابع": 7, "الثامن": 8, "التاسع": 9, "العاشر": 10
};

function parseTitle(raw) {
  let n = " " + norm(raw) + " ";
  let ep = null, season = null, year = null;
  let m = n.match(/ (?:الحلقه|حلقه) (\d+) /);
  if (m) { ep = parseInt(m[1], 10); n = n.replace(m[0], " "); }
  m = n.match(/ (?:الموسم|موسم) (\d+|[^ ]+) /);
  if (m) {
    const v = m[1];
    season = /^\d+$/.test(v) ? parseInt(v, 10) : (ORD[v] || null);
    n = n.replace(m[0], " ");
  }
  m = n.match(/ ((?:19\d\d|20[0-2]\d)) /);
  if (m) { year = parseInt(m[1], 10); n = n.replace(m[0], " "); }
  const all = n.split(" ").filter(Boolean);
  const isFilm = all.indexOf("فيلم") !== -1;
  const isSeries = all.indexOf("مسلسل") !== -1 || ep !== null;
  let tokens = all.filter(t => !NOISE.has(t));
  if (!tokens.length && year) { tokens = [String(year)]; year = null; }
  return { ep, season, year, isFilm, isSeries, tokens, base: tokens.join(" ") };
}

function matchScore(p, qBase) {
  const b = p.base;
  if (!b || !qBase) return 0;
  if (b === qBase) return 10;
  const padded = " " + b + " ";
  const needle = " " + qBase + " ";
  if (padded.indexOf(needle) === -1) return 0;
  const qLen = qBase.split(" ").length;
  const extra = p.tokens.length - qLen;
  if (extra > 2) return 0;
  const rest = padded.replace(needle, " ").split(" ").filter(Boolean);
  if (rest.some(t => /^\d+$/.test(t))) return 0; // sequel marker (e.g. "X 2")
  return 6 - extra;
}

// ---------- TMDB ----------
function tmdbInfo(tmdbId, mediaType) {
  return __async(this, null, function* () {
    const type = mediaType === "movie" ? "movie" : "tv";
    const key = type + ":" + tmdbId;
    if (tmdbCache.has(key)) return tmdbCache.get(key);

    const datas = yield Promise.all(["ar", "en"].map(lang =>
      fetchT(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=${lang}`, {}, T_TMDB)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    ));

    const titles = [];
    const seen = new Set();
    let year = null;
    function add(t) {
      if (!t) return;
      const k = norm(t);
      if (!k || seen.has(k)) return;
      seen.add(k);
      titles.push(t);
    }
    for (const d of datas) {
      if (!d) continue;
      const date = d.release_date || d.first_air_date || "";
      if (!year && /^\d{4}/.test(date)) year = parseInt(date.slice(0, 4), 10);
      add(type === "movie" ? d.title : d.name);
      add(type === "movie" ? d.original_title : d.original_name);
    }
    // subtitle-less variants ("X: Y" -> "X")
    for (const t of titles.slice()) {
      const head = t.split(/\s*[:\-–—]\s*/)[0];
      if (head && head !== t && norm(head).length >= 4) add(head);
    }

    const info = { titles: titles.slice(0, 4), year };
    if (titles.length) tmdbCache.set(key, info);
    return info;
  });
}

// ---------- site scraping ----------
function extractLinks(html) {
  const out = [];
  const seen = new Set();
  const re1 = /<a[^>]*href="([^"]*\/watch\.php\?vid=([A-Za-z0-9]+))"[^>]*title="([^"]*)"/gi;
  const re2 = /<a[^>]*title="([^"]*)"[^>]*href="([^"]*\/watch\.php\?vid=([A-Za-z0-9]+))"/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ url: absUrl(m[1]), vid: m[2], title: decodeHtml(m[3]) });
  }
  while ((m = re2.exec(html)) !== null) {
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    out.push({ url: absUrl(m[2]), vid: m[3], title: decodeHtml(m[1]) });
  }
  return out;
}

function searchSite(query) {
  return __async(this, null, function* () {
    const html = yield get(`${DOMAIN}/search.php?keywords=${encodeURIComponent(query)}`);
    const r = extractLinks(html);
    console.log("[AhwakTV] Search:", query, "->", r.length);
    return r;
  });
}

function findSeeUrl(html, vid) {
  if (vid && new RegExp("see\\.php\\?vid=" + vid, "i").test(html)) {
    return DOMAIN + "/see.php?vid=" + vid;
  }
  const m = html.match(/see\.php\?vid=([A-Za-z0-9]+)/i);
  return m ? DOMAIN + "/see.php?vid=" + m[1] : null;
}

// ---------- hosts ----------
function hostType(u) {
  const h = hostOf(u);
  if (!h) return null;
  if (/vidmoly/.test(h)) return "vidmoly";
  if (/uqload/.test(h)) return "uqload";
  if (/(^|\.)ok\.ru$|okru/.test(h)) return "okru";
  if (/1vid/.test(h)) return "1vid";
  if (/dood|playmogo|ds2play|vidspeed|d0o0d|do7go|vide0/.test(h)) return "dood";
  return null;
}

const LABELS = { vidmoly: "VidMoly", uqload: "Uqload", okru: "OK.ru", "1vid": "1Vid", dood: "Dood" };

function extractEmbedUrls(html) {
  const out = [];
  const seen = new Set();
  function add(u) {
    u = decodeHtml(String(u || "").trim());
    if (u.startsWith("//")) u = "https:" + u;
    else if (u.startsWith("/")) u = DOMAIN + u;
    if (!/^https?:\/\//i.test(u)) return;
    if (!hostType(u)) return;
    const k = hostOf(u) + u.replace(/^https?:\/\/[^\/]+/, "").split("?")[0];
    if (seen.has(k)) return;
    seen.add(k);
    out.push(u);
  }
  let m;
  const reIf = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) !== null) add(m[1]);
  const reData = /data-[a-z0-9_-]+=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) add(m[1]);
  const reAny = /https?:\/\/[^"'\s<>]*(?:1vid|vidmoly|playmogo|uqload|dood|ds2play|vidspeed|ok\.ru)[^"'\s<>]*/gi;
  while ((m = reAny.exec(html)) !== null) add(m[0]);
  return out.slice(0, MAX_EMBEDS);
}

function makeStream(url, label, referer, type) {
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  let t = type || "mp4";
  if (/\.m3u8/i.test(url)) t = "hls";
  else if (/\.mp4/i.test(url)) t = "mp4";
  const ref = referer || (DOMAIN + "/");
  return {
    name: "🌙 AhwakTV",
    title: `🌙 AhwakTV • ${label}`,
    url: url,
    quality: "Auto",
    type: t,
    referer: ref,
    headers: { "User-Agent": USER_AGENT, "Referer": ref }
  };
}

function fetchEmbedHtml(embedUrl) {
  return __async(this, null, function* () {
    const res = yield fetchT(embedUrl, {
      headers: { "User-Agent": USER_AGENT, "Referer": DOMAIN + "/", "Accept": "text/html,*/*" },
      redirect: "follow"
    }, T_PAGE);
    const html = yield res.text();
    return { html, finalUrl: res.url || embedUrl };
  });
}

// ---------- packer ----------
function unpackEval(html) {
  const m = html.match(/\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const base = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  const kw = m[4].split("|");
  const digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function toBase(n) {
    let s = "";
    do { s = digits[n % base] + s; n = Math.floor(n / base); } while (n > 0);
    return s;
  }
  const dict = {};
  for (let i = 0; i < count; i++) dict[toBase(i)] = kw[i] || toBase(i);
  return payload.replace(/\b\w+\b/g, w => (dict[w] !== undefined ? dict[w] : w));
}

// ---------- resolvers ----------
function resolveVidMoly(embedUrl) {
  return __async(this, null, function* () {
    try {
      const r = yield fetchEmbedHtml(embedUrl);
      let html = r.html;
      let m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/i);
      if (!m) m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      if (!m) {
        const un = unpackEval(html);
        if (un) m = un.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      }
      if (!m) return [];
      return [makeStream(unesc(m[1]), "VidMoly", "https://vidmoly.to/", "hls")];
    } catch (e) { console.log("[AhwakTV] VidMoly err:", e.message); return []; }
  });
}

function resolveDood(embedUrl) {
  return __async(this, null, function* () {
    try {
      const pageUrl = embedUrl.replace("/d/", "/e/");
      const r = yield fetchEmbedHtml(pageUrl);
      const html = r.html;
      const pm = html.match(/["'](\/pass_md5\/[^"']+)["']/i);
      if (!pm) return [];
      const tk = pm[1].match(/\/pass_md5\/[^\/]+\/([^\/"']+)/);
      const token = tk ? tk[1] : pm[1].split("/").pop();
      const origin = originOf(r.finalUrl) || originOf(pageUrl);
      const pr = yield fetchT(origin + pm[1], {
        headers: { "User-Agent": USER_AGENT, "Referer": r.finalUrl },
        redirect: "follow"
      }, T_PAGE);
      const base = (yield pr.text()).trim();
      if (!/^https?:\/\//i.test(base)) return [];
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let rnd = "";
      for (let i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
      const finalUrl = base + rnd + "?token=" + token + "&expiry=" + Date.now();
      return [makeStream(finalUrl, "Dood", origin + "/", "mp4")];
    } catch (e) { console.log("[AhwakTV] Dood err:", e.message); return []; }
  });
}

function resolveUqload(embedUrl) {
  return __async(this, null, function* () {
    try {
      const r = yield fetchEmbedHtml(embedUrl);
      const m = r.html.match(/sources\s*:\s*\[\s*["']([^"']+)["']/i);
      if (!m) return [];
      const origin = originOf(r.finalUrl) || originOf(embedUrl);
      return [makeStream(unesc(m[1]), "Uqload", origin + "/", "mp4")];
    } catch (e) { console.log("[AhwakTV] Uqload err:", e.message); return []; }
  });
}

function resolve1Vid(embedUrl) {
  return __async(this, null, function* () {
    try {
      const r = yield fetchEmbedHtml(embedUrl);
      const unpacked = unpackEval(r.html) || r.html;
      const m = unpacked.match(/https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/i);
      if (!m) return [];
      const url = unesc(m[0]);
      const origin = originOf(r.finalUrl) || originOf(embedUrl);
      return [makeStream(url, "1Vid", origin + "/", /\.m3u8/i.test(url) ? "hls" : "mp4")];
    } catch (e) { console.log("[AhwakTV] 1Vid err:", e.message); return []; }
  });
}

function resolveOkRu(embedUrl) {
  return __async(this, null, function* () {
    try {
      const r = yield fetchEmbedHtml(embedUrl);
      const html = decodeHtml(r.html);
      let m = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/i);
      if (m) return [makeStream(unesc(m[1]), "OK.ru", "https://ok.ru/", "hls")];
      m = html.match(/"hlsMasterPlaylistUrl"\s*:\s*"([^"]+)"/i);
      if (m) return [makeStream(unesc(m[1]), "OK.ru", "https://ok.ru/", "hls")];
      m = html.match(/"videoUrl"\s*:\s*"([^"]+)"/i);
      if (m) return [makeStream(unesc(m[1]), "OK.ru", "https://ok.ru/", "mp4")];
      return [];
    } catch (e) { console.log("[AhwakTV] OK.ru err:", e.message); return []; }
  });
}

function resolveEmbed(embedUrl) {
  switch (hostType(embedUrl)) {
    case "vidmoly": return resolveVidMoly(embedUrl);
    case "dood": return resolveDood(embedUrl);
    case "uqload": return resolveUqload(embedUrl);
    case "1vid": return resolve1Vid(embedUrl);
    case "okru": return resolveOkRu(embedUrl);
    default: return Promise.resolve([]);
  }
}

// ---------- link verification ----------
function verifyStream(s) {
  return __async(this, null, function* () {
    try {
      if (s.type === "hls") {
        const r = yield fetchT(s.url, { headers: s.headers }, T_PROBE);
        if (!r.ok) return null;
        const t = yield r.text();
        return /^\s*#EXTM3U/.test(t) ? s : null;
      }
      const r = yield fetchT(s.url, {
        headers: Object.assign({}, s.headers, { "Range": "bytes=0-1" })
      }, T_PROBE);
      return r.status >= 400 ? null : s;
    } catch (e) {
      return s.type === "hls" ? null : s;
    }
  });
}

// ---------- job runner (early exit) ----------
function runJobs(jobs, hardMs, graceMs, maxStreams) {
  return new Promise(resolve => {
    const out = [];
    const seen = new Set();
    let pending = jobs.length;
    let done = false;
    let graceT = null;
    let hardT = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hardT);
      if (graceT) clearTimeout(graceT);
      resolve(out);
    };
    hardT = setTimeout(finish, hardMs);
    const push = s => {
      if (done || !s || seen.has(s.url)) return;
      seen.add(s.url);
      out.push(s);
      if (out.length >= maxStreams) return finish();
      if (!graceT) graceT = setTimeout(finish, graceMs);
    };
    if (!pending) return finish();
    jobs.forEach(j => {
      let p;
      try { p = j(push); } catch (e) { p = Promise.resolve(); }
      Promise.resolve(p).catch(e => console.log("[AhwakTV] job err:", e && e.message)).then(() => {
        pending--;
        if (pending === 0) finish();
      });
    });
  });
}

function candidateJob(cand, ctx) {
  return function (push) {
    return __async(this, null, function* () {
      let target = cand.url;

      if (ctx.isTv && cand.parsed.ep !== ctx.ep) {
        const listHtml = yield get(cand.url);
        const hit = extractLinks(listHtml)
          .map(l => ({ l, p: parseTitle(l.title) }))
          .find(x => x.p.ep === ctx.ep && x.p.base === cand.parsed.base && x.p.season === cand.parsed.season);
        if (!hit) return;
        target = hit.l.url;
      }

      const watchHtml = yield get(target);
      const seeUrl = findSeeUrl(watchHtml, vidOf(target));
      if (!seeUrl) return;

      const seeHtml = yield get(seeUrl, target);
      const embeds = extractEmbedUrls(seeHtml);
      console.log("[AhwakTV] " + cand.vid + " embeds:", embeds.map(hostType).join(","));

      yield Promise.all(embeds.map(e =>
        resolveEmbed(e)
          .then(list => Promise.all(list.map(verifyStream)))
          .then(list => { list.forEach(s => { if (s) push(s); }); })
          .catch(() => {})
      ));
    });
  };
}

// ---------- ranking ----------
function rankCandidates(results, ctx) {
  const out = [];
  const seen = new Set();
  for (const r of results) {
    if (seen.has(r.vid)) continue;
    seen.add(r.vid);
    const p = parseTitle(r.title);
    let best = 0;
    for (const q of ctx.qBases) best = Math.max(best, matchScore(p, q));
    if (!best) continue;

    let score = best;
    if (ctx.isTv) {
      if (p.isFilm && p.ep === null) continue;
      if (p.season !== null) { if (p.season !== ctx.season) continue; }
      else if (ctx.season > 1) continue;
      if (p.ep === ctx.ep) score += 5;
    } else {
      if (p.ep !== null) continue;
      if (p.isSeries && !p.isFilm) continue;
      if (p.year && ctx.year) {
        if (Math.abs(p.year - ctx.year) > 1) continue;
        if (p.year === ctx.year) score += 3;
      }
      if (p.isFilm) score += 2;
    }
    out.push({ url: r.url, vid: r.vid, title: r.title, parsed: p, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------- entry ----------
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[AhwakTV] START:", tmdbId, mediaType, season, episode);
    if (!tmdbId) return [];
    if (mediaType !== "movie" && mediaType !== "tv") return [];
    if (mediaType === "tv" && (!season || !episode)) return [];

    const isTv = mediaType === "tv";
    const info = yield tmdbInfo(tmdbId, mediaType);
    if (!info.titles.length) return [];
    console.log("[AhwakTV] Titles:", info.titles.join(" | "), info.year || "");

    const ctx = {
      isTv,
      season: Number(season) || 1,
      ep: isTv ? (Number(episode) || 1) : null,
      year: info.year,
      qBases: []
    };
    const qSeen = new Set();
    for (const t of info.titles) {
      const b = parseTitle(t).base;
      if (b && !qSeen.has(b)) { qSeen.add(b); ctx.qBases.push(b); }
    }
    if (!ctx.qBases.length) return [];

    const queries = [];
    for (const t of info.titles.slice(0, 3)) {
      queries.push(t);
      if (isTv) queries.push(t + " الحلقة " + ctx.ep);
    }

    const lists = yield Promise.all(queries.slice(0, 5).map(q => searchSite(q).catch(() => [])));
    const all = [];
    for (const l of lists) for (const r of l) all.push(r);

    const ranked = rankCandidates(all, ctx).slice(0, MAX_CANDIDATES);
    console.log("[AhwakTV] Candidates:", ranked.map(c => c.title + " (" + c.score + ")").join(" | "));
    if (!ranked.length) return [];

    const streams = yield runJobs(
      ranked.map(c => candidateJob(c, ctx)),
      HARD_MS, GRACE_MS, MAX_STREAMS
    );
    console.log("[AhwakTV] Final streams:", streams.length);
    return streams;
  });
}

module.exports = { getStreams };
