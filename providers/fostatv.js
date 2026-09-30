var BASE = "https://fosta-tv.monster";
var UA = "Mozilla/5.0 (Linux; Android 10, K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";

function fetchText(url, referer) {
  url = String(url).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  var headers = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  if (referer) headers["Referer"] = String(referer).replace(/[^\x00-\x7F]/g, function(c) { return encodeURIComponent(c); });
  return fetch(url, { headers: headers, redirect: "follow" }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
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

function getTmdbTitles(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var langs = ["ar", "en"];
  return Promise.all(langs.map(function(lang) {
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
    return fetch(url).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; });
  })).then(function(responses) {
    var titles = [];
    responses.forEach(function(d) {
      if (!d) return;
      var t = type === "movie" ? (d.title || d.original_title) : (d.name || d.original_name);
      if (t && titles.indexOf(t) === -1) titles.push(t);
    });
    console.log("[FostaTV] TMDB titles:", titles.join(" | "));
    return titles;
  });
}

// Search — no filter, we score later
function searchFosta(title) {
  var cleanTitle = String(title || "").replace(/[:\u060C-\u061F]/g, " ").replace(/\s+/g, " ").trim();
  var url = BASE + "/search.php?keywords=" + encodeURIComponent(cleanTitle);
  console.log("[FostaTV] Search:", cleanTitle);
  return fetchText(url, BASE + "/").then(function(html) {
    var results = [];
    var seen = {};
    var re = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*title=["']([^"']+)["'][^>]*>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var fullUrl = decodeHtml(m[1]);
      var vid = m[2];
      var linkTitle = decodeHtml(m[3]);
      if (seen[vid]) continue;
      seen[vid] = 1;
      var absolute = fullUrl.indexOf("http") === 0 ? fullUrl : BASE + fullUrl;
      results.push({ url: absolute, title: linkTitle, vid: vid });
    }
    if (!results.length) {
      var re2 = /<a[^>]*href=["']([^"']*\/watch\.php\?vid=([^"'&]+))["'][^>]*>/gi;
      while ((m = re2.exec(html)) !== null) {
        var vid2 = m[2];
        if (seen[vid2]) continue;
        seen[vid2] = 1;
        var abs2 = m[1].indexOf("http") === 0 ? m[1] : BASE + m[1];
        results.push({ url: abs2, title: "", vid: vid2 });
      }
    }
    console.log("[FostaTV] Search results:", results.length);
    return results;
  });
}

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return "4K";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  return "Auto";
}

function hostLabel(url) {
  var m = String(url || "").match(/^https?:\/\/(?:www\.)?([^\.\/]+)/i);
  return m ? m[1] : "Server";
}

function makeStream(url, label, referer, type) {
  if (url.indexOf("http://") === 0) url = "https://" + url.slice(7);
  var t = type || "iframe";
  if (/\.m3u8/i.test(url)) t = "hls";
  else if (/\.mp4/i.test(url)) t = "mp4";
  return {
    name: "⚜️ FostaTV",
    title: label ? "⚜️ FostaTV \u2022 " + label : "⚜️ FostaTV",
    url: url,
    quality: qualityFromUrl(url),
    type: t,
    referer: referer || BASE + "/",
    headers: { "User-Agent": UA, "Referer": referer || BASE + "/" }
  };
}

// Extract every embed URL from play.php — iframes + data-* + known hosts
function extractEmbedUrls(html) {
  var out = [];
  var seen = {};
  function add(u) {
    u = decodeHtml(String(u || "").trim());
    if (u.indexOf("//") === 0) u = "https:" + u;
    else if (u.charAt(0) === "/") u = BASE + u;
    if (!/^https?:/i.test(u)) return;
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads|amazon|gstatic|jquery|w3\.org|schema\.org/i.test(u)) return;
    if (seen[u]) return;
    seen[u] = 1;
    out.push(u);
  }
  var m;
  var reIf = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) !== null) add(m[1]);
  var reData = /data-[a-z0-9_-]+=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) add(m[1]);
  var reAny = /https?:\/\/[^"'\s<>]*(?:1vid|vidmoly|playmogo|uqload|dood|voe|streamtape|filemoon|upstream|mp4upload|sendvid|sibnet|mixdrop|ds2play|vidspeed|ok\.ru|vk\.com|hgcloud|vidhidehub|listeamed)[^"'\s<>]*/gi;
  while ((m = reAny.exec(html)) !== null) add(m[0]);
  return out;
}

// === RESOLVERS (same as Ahwak) ===

function resolveVidMoly(embedUrl) {
  return fetch(embedUrl, {
    headers: { "User-Agent": UA, "Referer": BASE + "/" },
    redirect: "follow"
  })
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/i);
      if (!m) m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      if (!m) return [];
      return [makeStream(m[1].replace(/\\\//g, "/"), "VidMoly", "https://vidmoly.to/", "hls")];
    })
    .catch(function(e) { console.log("[FostaTV] VidMoly err:", e.message); return []; });
}

function resolveDood(embedUrl) {
  return fetch(embedUrl, {
    headers: { "User-Agent": UA, "Referer": BASE + "/" },
    redirect: "follow"
  })
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var pm = html.match(/["'](\/pass_md5\/[^"']+)["']/i);
      if (!pm) return [];
      var tk = pm[1].match(/\/pass_md5\/([^\/]+)/);
      var token = tk ? tk[1] : "";
      var exm = html.match(/[?&]expiry=([0-9]+)/i);
      var expiry = exm ? exm[1] : String(Math.floor(Date.now() / 1000) + 3600);
      var om = embedUrl.match(/^(https?:\/\/[^\/]+)/);
      var origin = om ? om[1] : "";
      return fetch(origin + pm[1], {
        headers: { "User-Agent": UA, "Referer": embedUrl },
        redirect: "follow"
      })
        .then(function(pr) { return pr.text(); })
        .then(function(base) {
          if (!base || base.length < 10) return [];
          var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
          var rnd = "";
          for (var i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
          return [makeStream(base + rnd + "?token=" + token + "&expiry=" + expiry, "Dood", embedUrl, "mp4")];
        });
    })
    .catch(function(e) { console.log("[FostaTV] Dood err:", e.message); return []; });
}

function unpackEval(html) {
  var m = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  var payload = m[1];
  var base = parseInt(m[2], 10);
  var count = parseInt(m[3], 10);
  var kw = m[4].split("|");
  var i = count;
  while (i--) {
    if (kw[i]) payload = payload.replace(new RegExp("\\b" + i.toString(base) + "\\b", "g"), kw[i]);
  }
  return payload;
}

function resolve1Vid(embedUrl) {
  return fetch(embedUrl, {
    headers: { "User-Agent": UA, "Referer": BASE + "/" },
    redirect: "follow"
  })
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var unpacked = unpackEval(html) || html;
      var m = unpacked.match(/https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/i);
      if (!m) return [];
      var url = m[0].replace(/\\\//g, "/");
      return [makeStream(url, "1Vid", embedUrl, /\.m3u8/i.test(url) ? "hls" : "mp4")];
    })
    .catch(function(e) { console.log("[FostaTV] 1Vid err:", e.message); return []; });
}

function resolveOkRu(embedUrl) {
  return fetch(embedUrl, {
    headers: { "User-Agent": UA, "Referer": BASE + "/" },
    redirect: "follow"
  })
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var m = html.match(/"hlsManifestUrl":"([^"]+)"/i);
      if (m) return [makeStream(m[1].replace(/\\\//g, "/"), "OK.ru", "https://ok.ru/", "hls")];
      m = html.match(/"videoUrl":"([^"]+)"/i);
      if (m) return [makeStream(m[1].replace(/\\\//g, "/"), "OK.ru", "https://ok.ru/", "mp4")];
      m = html.match(/url[0-9]{3}["']?\s*[:=]\s*["']([^"']+)["']/);
      if (m) return [makeStream(m[1].replace(/\\\//g, "/"), "OK.ru", "https://ok.ru/", "mp4")];
      return [];
    })
    .catch(function(e) { console.log("[FostaTV] OK.ru err:", e.message); return []; });
}

function resolveEmbed(embedUrl) {
  var host = hostLabel(embedUrl).toLowerCase();
  if (host.indexOf("vidmoly") !== -1) return resolveVidMoly(embedUrl);
  if (host.indexOf("playmogo") !== -1 || host.indexOf("dood") !== -1 ||
      host.indexOf("uqload") !== -1 || host.indexOf("ds2play") !== -1 ||
      host.indexOf("vidspeed") !== -1) return resolveDood(embedUrl);
  if (host.indexOf("1vid") !== -1) return resolve1Vid(embedUrl);
  if (host.indexOf("ok.ru") !== -1 || host.indexOf("okru") !== -1) return resolveOkRu(embedUrl);
  return Promise.resolve([]);
}

// Is this a real embed host or a dummy/placeholder?
function isRealEmbed(url) {
  var h = hostLabel(url).toLowerCase();
  // Known real hosts
  if (/vidmoly|playmogo|uqload|ds2play|vidspeed|dood|1vid|ok\.ru|okru|vk\.com|hgcloud|vidhidehub|listeamed|mixdrop|voe\.sx|filemoon|streamtape/.test(h)) return true;
  // Placeholder hosts to skip
  if (/^vid[0-9]+\.0$|^0\.0$|placeholder|dummy|example|localhost|127\.0\.0\.1/.test(h)) return false;
  // Unknown — keep, resolver may or may not handle it
  return true;
}

// Given a watch vid, fetch play.php → embeds → resolve → streams
function resolveVid(vid) {
  var watchUrl = BASE + "/watch.php?vid=" + vid;
  var playUrl = BASE + "/play.php?vid=" + vid;
  console.log("[FostaTV] play:", playUrl);
  return fetchText(playUrl, watchUrl).then(function(playHtml) {
    var embeds = extractEmbedUrls(playHtml).filter(isRealEmbed);
    console.log("[FostaTV] embeds:", embeds.length, "[" + embeds.map(hostLabel).join(", ") + "]");
    if (!embeds.length) return [];
    return Promise.all(embeds.map(function(e) {
      return resolveEmbed(e).catch(function() { return []; });
    })).then(function(groups) {
      var streams = [];
      var seen = {};
      groups.forEach(function(g) {
        g.forEach(function(s) {
          if (seen[s.url]) return;
          seen[s.url] = 1;
          streams.push(s);
        });
      });
      console.log("[FostaTV] resolved streams:", streams.length);
      return streams;
    });
  });
}

function getMovieStreams(tmdbId) {
  return getTmdbTitles(tmdbId, "movie").then(function(titles) {
    if (!titles.length) return [];
    return Promise.all(titles.map(function(t) {
      return searchFosta(t).catch(function() { return []; });
    })).then(function(groups) {
      var all = [], seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      console.log("[FostaTV] Total candidates:", all.length);
      if (!all.length) return [];

      // Jaccard scoring
      function jaccard(candidateTitle) {
        var cleaned = candidateTitle
          .replace(/^(مسلسل|فيلم|مسرحية|برنامج)\s+/i, "")
          .replace(/\s*الحلق[ةه].*$/i, "")
          .replace(/\s*كامل.*$/i, "")
          .replace(/\s*HD.*$/i, "")
          .trim();
        var candTokens = normalizeArabic(cleaned).split(/\s+/).filter(function(w) { return w.length > 1; });
        if (!candTokens.length) return 0;
        var setB = {};
        candTokens.forEach(function(w) { setB[w] = 1; });
        var best = 0;
        titles.forEach(function(t) {
          var titleTokens = normalizeArabic(t).split(/\s+/).filter(function(w) { return w.length > 1; });
          if (!titleTokens.length) return;
          var inter = 0;
          var setA = {};
          titleTokens.forEach(function(w) { setA[w] = 1; if (setB[w]) inter++; });
          var unionSet = {};
          titleTokens.forEach(function(w) { unionSet[w] = 1; });
          candTokens.forEach(function(w) { unionSet[w] = 1; });
          var union = Object.keys(unionSet).length;
          var j = union ? inter / union : 0;
          if (j > best) best = j;
        });
        return best;
      }

      var scored = all.map(function(r) {
        return Object.assign({}, r, { jaccard: jaccard(r.title) });
      });
      console.log("[FostaTV] Scored:",
        scored.slice(0, 5).map(function(c) { return "[" + c.jaccard.toFixed(2) + "] " + c.title.slice(0, 40); }).join(" | "));

      var filtered = scored.filter(function(c) { return c.jaccard >= 0.40; });
      console.log("[FostaTV] After filter:", filtered.length, "candidates >= 0.40");
      if (!filtered.length) return [];

      filtered.sort(function(a, b) { return b.jaccard - a.jaccard; });

      // Try top 5, return FIRST success (no leak)
      var triedVids = {};
      function tryNext(i) {
        if (i >= filtered.length || Object.keys(triedVids).length >= 5) return Promise.resolve([]);
        var c = filtered[i];
        if (triedVids[c.vid]) return tryNext(i + 1);
        triedVids[c.vid] = 1;
        console.log("[FostaTV] Trying " + c.vid + " (" + c.jaccard.toFixed(2) + ")");
        return resolveVid(c.vid).then(function(streams) {
          if (streams.length) {
            console.log("[FostaTV] ✓ " + streams.length + " streams from " + c.vid);
            return streams;
          }
          return tryNext(i + 1);
        });
      }
      return tryNext(0);
    });
  }).catch(function(err) {
    console.log("[FostaTV] Movie error:", err.message);
    return [];
  });
}

function getTvStreams(tmdbId, season, episode) {
  var wanted = Number(episode) || 1;
  return getTmdbTitles(tmdbId, "tv").then(function(titles) {
    if (!titles.length) return [];
    var searches = [];
    titles.forEach(function(t) {
      searches.push(t + " الحلقة " + wanted);
      searches.push(t);
    });
    return Promise.all(searches.map(function(q) {
      return searchFosta(q).catch(function() { return []; });
    })).then(function(groups) {
      var all = [], seen = {};
      groups.forEach(function(g) {
        g.forEach(function(r) {
          if (!seen[r.vid]) { seen[r.vid] = 1; all.push(r); }
        });
      });
      console.log("[FostaTV] TV candidates:", all.length);
      if (!all.length) return [];

      function jaccard(candidateTitle) {
        var cleaned = candidateTitle
          .replace(/^(مسلسل|فيلم|مسرحية|برنامج)\s+/i, "")
          .replace(/\s*الحلق[ةه].*$/i, "")
          .replace(/\s*كامل.*$/i, "")
          .replace(/\s*HD.*$/i, "")
          .trim();
        var candTokens = normalizeArabic(cleaned).split(/\s+/).filter(function(w) { return w.length > 1; });
        if (!candTokens.length) return 0;
        var setB = {};
        candTokens.forEach(function(w) { setB[w] = 1; });
        var best = 0;
        titles.forEach(function(t) {
          var titleTokens = normalizeArabic(t).split(/\s+/).filter(function(w) { return w.length > 1; });
          if (!titleTokens.length) return;
          var inter = 0;
          var setA = {};
          titleTokens.forEach(function(w) { setA[w] = 1; if (setB[w]) inter++; });
          var unionSet = {};
          titleTokens.forEach(function(w) { unionSet[w] = 1; });
          candTokens.forEach(function(w) { unionSet[w] = 1; });
          var union = Object.keys(unionSet).length;
          var j = union ? inter / union : 0;
          if (j > best) best = j;
        });
        return best;
      }

      var scored = all.map(function(r) {
        var j = jaccard(r.title);
        var epNum = null;
        var em = r.title.match(/الحلق[ةه]\s*([0-9\u0660-\u0669]+)/);
        if (em) {
          epNum = parseInt(em[1].replace(/[\u0660-\u0669]/g, function(d) { return String(d.charCodeAt(0) - 0x0660); }), 10);
        }
        return Object.assign({}, r, { jaccard: j, epNum: epNum });
      });

      var exact = scored.filter(function(c) { return c.jaccard >= 0.40 && c.epNum === wanted; });
      var filtered = exact.length ? exact : scored.filter(function(c) { return c.jaccard >= 0.40; });
      console.log("[FostaTV] TV after filter:", filtered.length, "(exact ep:", exact.length + ")");
      if (!filtered.length) return [];

      filtered.sort(function(a, b) { return b.jaccard - a.jaccard; });

      var triedVids = {};
      function tryNext(i) {
        if (i >= filtered.length || Object.keys(triedVids).length >= 5) return Promise.resolve([]);
        var c = filtered[i];
        if (triedVids[c.vid]) return tryNext(i + 1);
        triedVids[c.vid] = 1;
        console.log("[FostaTV] Trying " + c.vid + " (" + c.jaccard.toFixed(2) + ")");
        return resolveVid(c.vid).then(function(streams) {
          if (streams.length) {
            console.log("[FostaTV] ✓ " + streams.length + " streams from " + c.vid);
            return streams;
          }
          return tryNext(i + 1);
        });
      }
      return tryNext(0);
    });
  }).catch(function(err) {
    console.log("[FostaTV] TV error:", err.message);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[FostaTV] getStreams:", tmdbId, mediaType, season, episode);
  if (mediaType === "tv") return getTvStreams(tmdbId, season, episode);
  return getMovieStreams(tmdbId);
}

module.exports = { getStreams: getStreams };
