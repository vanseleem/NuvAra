// ═══════════════════════════════════════════════════════════════════════
// Fibwatch.art — PlayTube CMS provider
// ═══════════════════════════════════════════════════════════════════════
var BASE_URL = 'https://fibwatch.art';
var PROVIDER_ID = 'fibwatch';
var PROVIDER_NAME = '🎬 Fibwatch';

var TMDB_API_KEY = '83d364331c40bfbe29858aeed82f45cc';

var MAX_SEARCH_RESULTS = 10;
var MAX_CANDIDATES = 3;
var SITE_TIMEOUT = 15000;
var EMBED_TIMEOUT = 12000;

var UA_SITE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
var UA_EMBED = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function log(m) { console.log('[Fibwatch] ' + m); }

// ───────────────────────── Text helpers ───────────────────────────────

function decodeEntities(str) {
  return String(str == null ? '' : str)
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function normalizeText(input) {
  return decodeEntities(input).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\u0621-\u064Aa-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function bigramMap(str) {
  var s = str.replace(/ /g, ''); var map = {}; var size = 0;
  for (var i = 0; i < s.length - 1; i++) { var g = s.substr(i, 2); map[g] = (map[g] || 0) + 1; size++; }
  return { map: map, size: size };
}

function diceScore(a, b) {
  if (a === b) return 1;
  var x = bigramMap(a), y = bigramMap(b);
  if (!x.size || !y.size) return 0;
  var common = 0;
  Object.keys(x.map).forEach(function (g) { if (y.map[g]) common += Math.min(x.map[g], y.map[g]); });
  return (2 * common) / (x.size + y.size);
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

// ───────────────────────── HTTP ───────────────────────────────────────

function asciiSafe(v) { return String(v).replace(/[^\x00-\x7F]/g, function (c) { return encodeURIComponent(c); }); }

function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== 'function') return promise;
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('timeout: ' + label)); }, ms);
    promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
  });
}

function fetchText(url, headers, timeoutMs) {
  url = asciiSafe(url);
  if (headers && headers['Referer']) headers['Referer'] = asciiSafe(headers['Referer']);
  return withTimeout(fetch(url, { method: 'GET', headers: headers, redirect: 'follow' }), timeoutMs || SITE_TIMEOUT, url.split('?')[0])
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
}

function siteGet(url, referer) {
  return fetchText(url, {
    'User-Agent': UA_SITE,
    'Referer': referer || BASE_URL + '/',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en;q=0.9'
  });
}

function hostOf(url) { var m = /^https?:\/\/([^\/?#:]+)/i.exec(url); return m ? m[1].toLowerCase().replace(/^www\./, '') : ''; }
function originOf(url) { var m = /^(https?:\/\/[^\/?#]+)/i.exec(url); return m ? m[1] : ''; }

function absoluteUrl(url, baseUrl) {
  var u = decodeEntities(url).trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.charAt(0) === '/') return originOf(baseUrl) + u;
  return '';
}

// ───────────────────────── TMDB ───────────────────────────────────────

function fetchTmdb(tmdbId, type) {
  var url = 'https://api.themoviedb.org/3/' + type + '/' + encodeURIComponent(tmdbId) +
    '?api_key=' + TMDB_API_KEY + '&language=en&append_to_response=translations,alternative_titles';
  return fetchText(url, { 'Accept': 'application/json' }).then(function (b) { return JSON.parse(b); });
}

function buildMeta(data, type) {
  var isTv = type === 'tv';
  var raw = [isTv ? data.name : data.title, isTv ? data.original_name : data.original_title];
  var trs = (data.translations && data.translations.translations) || [];
  trs.forEach(function (t) { if (t.iso_639_1 === 'en' && t.data) raw.push(isTv ? t.data.name : t.data.title); });
  if (!isTv) {
    var alts = (data.alternative_titles && data.alternative_titles.titles) || [];
    alts.forEach(function (a) { if (a.title) raw.push(a.title); });
  }
  var dateStr = isTv ? data.first_air_date : data.release_date;
  var year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;
  var seen = {}, titles = [];
  raw.forEach(function (t) {
    if (!t) return;
    var n = normalizeText(t);
    if (!n || seen[n]) return;
    seen[n] = true;
    titles.push(t);
  });
  return { titles: titles, targets: titles.map(normalizeText), year: isNaN(year) ? null : year };
}

// ───────────────────────── Search ────────────────────────────────────
// FIXED: regex now matches BOTH relative and absolute /watch/ URLs

function parseSearchResults(html) {
  var results = [], seen = {};
  var re = /<a\s+href="((?:https?:\/\/[^"]+)?\/watch\/[^"]+\.html)"[^>]*>([^<]{2,200})<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = absoluteUrl(decodeEntities(m[1]), BASE_URL);
    var title = decodeEntities(m[2]).trim();
    if (!url || !title || seen[url]) continue;
    seen[url] = 1;
    results.push({ url: url, title: title });
  }
  return results.slice(0, MAX_SEARCH_RESULTS);
}

function searchSite(query) {
  var url = BASE_URL + '/page_loading.php?link1=search&keyword=' + encodeURIComponent(query);
  log('Search: ' + query);
  return siteGet(url, BASE_URL + '/').then(function (html) {
    var results = parseSearchResults(html);
    log('Search results: ' + results.length);
    return results;
  }).catch(function (e) {
    log('Search failed (' + query + '): ' + e.message);
    return [];
  });
}

function findBestMatch(results, meta) {
  var best = null, bestScore = 0;
  results.forEach(function (r) {
    var s = 0;
    meta.targets.forEach(function (t) {
      var sc = diceScore(normalizeText(r.title), t);
      if (sc > s) s = sc;
    });
    if (s > bestScore) { bestScore = s; best = r; }
  });
  log('Best: ' + (best ? best.title : 'none') + ' score=' + bestScore.toFixed(2));
  return bestScore >= 0.4 ? best : null;
}

// ─────────────────── Video source extraction ─────────────────────────

function qualityFromUrl(url) {
  var s = String(url).toLowerCase();
  if (/2160|4k/.test(s)) return '2160p';
  if (/1440/.test(s)) return '1440p';
  if (/1080/.test(s)) return '1080p';
  if (/720/.test(s)) return '720p';
  if (/480/.test(s)) return '480p';
  if (/360/.test(s)) return '360p';
  if (/240/.test(s)) return '240p';
  var m = /(\d{3,4})p\b/i.exec(s);
  return m ? m[1] + 'p' : null;
}

function qualityRank(q) {
  if (q === 'Auto') return 1080;
  var n = parseInt(q, 10);
  return isNaN(n) ? 0 : n;
}

function cleanMediaUrl(url) {
  return String(url)
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

function scanMediaUrls(text, baseUrl) {
  var patterns = [
    /sources\s*:\s*\[\s*\{\s*["']?file["']?\s*:\s*["']([^"']+)["']/gi,
    /sources\s*:\s*\[\s*["']([^"']+)["']/gi,
    /["']?file["']?\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
    /["']hls\d*["']\s*:\s*["']([^"']+)["']/gi,
    /wurl\s*=\s*["']([^"']+)["']/gi,
    /["'](https?:\\?\/\\?\/[^"'\s]+?\.(?:m3u8|mp4)[^"'\s]*)["']/gi,
    /data-(?:url|src|video|file)\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
    /(https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*)/gi
  ];
  var found = [], seen = {};
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) {
      var url = absoluteUrl(cleanMediaUrl(m[1]), baseUrl);
      if (!url || seen[url]) continue;
      if (/\.(?:jpe?g|png|gif|webp|vtt|srt|css|js|json)(?:[?#]|$)/i.test(url)) continue;
      seen[url] = true;
      found.push(url);
    }
  });
  return found;
}

function unpackAll(text) {
  var out = [];
  if (text.indexOf('p,a,c,k,e') === -1) return out;
  var digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var patterns = [
    /\}\(\s*'((?:[^'\\]|\\[\s\S])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\[\s\S])*)'\s*\.split\(\s*'\|'\s*\)/g,
    /\}\(\s*"((?:[^"\\]|\\[\s\S])*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\[\s\S])*)"\s*\.split\(\s*"\|"\s*\)/g
  ];
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) {
      var radix = parseInt(m[2], 10), words = m[4].split('|');
      var payload = m[1].replace(/\\\\/g, '\\').replace(/\\'/g, "'").replace(/\\"/g, '"');
      out.push(payload.replace(/\b\w+\b/g, function (w) {
        var n = 0;
        for (var i = 0; i < w.length; i++) {
          var d = digits.indexOf(w.charAt(i));
          if (d < 0 || d >= radix) return w;
          n = n * radix + d;
        }
        return words[n] ? words[n] : w;
      }));
    }
  });
  return out;
}

// ─────────────────── Watch page + stream resolution ──────────────────

function resolveWatchPage(watchUrl, title) {
  return siteGet(watchUrl, BASE_URL + '/').then(function (html) {
    var texts = [html].concat(unpackAll(html));
    var urls = [];
    texts.forEach(function (t) {
      scanMediaUrls(t, watchUrl).forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
    });

    if (urls.length) {
      log('direct URLs found: ' + urls.length);
      return urls.map(function (u) {
        var isHls = /\.m3u8/i.test(u);
        var q = isHls ? 'Auto' : (qualityFromUrl(u) || 'Unknown');
        return {
          name: PROVIDER_NAME + ' ' + (q !== 'Unknown' ? q : 'Auto'),
          title: title + ' ' + (q !== 'Unknown' ? q : 'Auto'),
          url: u,
          quality: q,
          size: 'Unknown',
          type: isHls ? 'hls' : 'mp4',
          headers: { 'User-Agent': UA_EMBED, 'Referer': BASE_URL + '/' },
          provider: PROVIDER_ID
        };
      });
    }

    // Fallback: look for embed iframes
    var iframeRe = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
    var iframes = [], m;
    while ((m = iframeRe.exec(html)) !== null) {
      var u = absoluteUrl(m[1], watchUrl);
      if (u && iframes.indexOf(u) === -1) iframes.push(u);
    }
    if (iframes.length) {
      log('iframe fallback: ' + iframes.length);
      return iframes.map(function (u) {
        var origin = originOf(u);
        return {
          name: PROVIDER_NAME + ' (iframe)',
          title: title,
          url: u,
          quality: 'Auto',
          size: 'Unknown',
          type: 'iframe',
          headers: { 'User-Agent': UA_EMBED, 'Referer': origin + '/' },
          behaviorHints: { notWebReady: true },
          provider: PROVIDER_ID
        };
      });
    }

    // Second fallback: return the watch page itself for external playback
    log('no stream found — returning watch page as fallback');
    return [{
      name: PROVIDER_NAME + ' (page)',
      title: title,
      url: watchUrl,
      quality: 'Auto',
      size: 'Unknown',
      type: 'iframe',
      headers: { 'User-Agent': UA_EMBED, 'Referer': BASE_URL + '/' },
      behaviorHints: { notWebReady: true },
      provider: PROVIDER_ID
    }];
  });
}

// ───────────────────────── Movies ────────────────────────────────────

function getMovieStreams(meta, title) {
  var all = [], seen = {}, qi = 0;
  var queries = meta.titles.slice(0, 3);
  function next() {
    if (qi >= queries.length) return Promise.resolve();
    return searchSite(queries[qi++]).then(function (rs) {
      rs.forEach(function (r) { if (!seen[r.url]) { seen[r.url] = 1; all.push(r); } });
      return next();
    });
  }
  return next().then(function () {
    log('movie candidates: ' + all.length);
    if (!all.length) return [];
    var match = findBestMatch(all, meta);
    if (!match) return [];
    return resolveWatchPage(match.url, title);
  });
}

// ───────────────────────── Series ────────────────────────────────────

function getTvStreams(meta, season, episode, title) {
  var all = [], seen = {}, qi = 0;
  var queries = [];
  meta.titles.slice(0, 2).forEach(function (t) {
    queries.push(t + ' S' + pad2(season) + 'E' + pad2(episode));
    queries.push(t + ' Season ' + season + ' Episode ' + episode);
    queries.push(t);
  });
  function next() {
    if (qi >= queries.length) return Promise.resolve();
    return searchSite(queries[qi++]).then(function (rs) {
      rs.forEach(function (r) { if (!seen[r.url]) { seen[r.url] = 1; all.push(r); } });
      return next();
    });
  }
  return next().then(function () {
    log('tv candidates: ' + all.length);
    if (!all.length) return [];
    var epRe = new RegExp('(?:S0?' + season + '\\s*E0?' + episode + '|Season\\s*' + season + '.*Episode\\s*' + episode + '|' + season + 'x0?' + episode + ')', 'i');
    var withEp = all.filter(function (r) { return epRe.test(r.title); });
    var pool = withEp.length ? withEp : all;
    var match = findBestMatch(pool, meta);
    if (!match) return [];
    return resolveWatchPage(match.url, title);
  });
}

// ───────────────────────── Entry ─────────────────────────────────────

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;

  if (!TMDB_API_KEY || TMDB_API_KEY === 'YOUR_TMDB_API_KEY') {
    log('TMDB_API_KEY not set'); return Promise.resolve([]);
  }

  return fetchTmdb(tmdbId, type).then(function (data) {
    var meta = buildMeta(data, type);
    if (!meta.titles.length) { log('no title for TMDB ' + tmdbId); return []; }

    var title = type === 'tv'
      ? meta.titles[0] + ' S' + pad2(season) + 'E' + pad2(episode)
      : meta.titles[0] + (meta.year ? ' (' + meta.year + ')' : '');

    log(type + ' "' + meta.titles[0] + '" year=' + meta.year + ' queries=' + JSON.stringify(meta.titles.slice(0, 3)));

    return type === 'tv'
      ? getTvStreams(meta, season, episode, title)
      : getMovieStreams(meta, title);
  }).catch(function (err) {
    log('error: ' + (err && err.message));
    return [];
  });
}

module.exports = { getStreams: getStreams };
