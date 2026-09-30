// ═══════════════════════════════════════════════════════════════════════
// RamoFlix — fmovie theme provider (Ahwak-style extractors)
// ═══════════════════════════════════════════════════════════════════════
var BASE_URL = 'https://ramoflix.net';
var PROVIDER_ID = 'ramoflix';
var PROVIDER_NAME = '🎬 RamoFlix';

var TMDB_API_KEY = '83d364331c40bfbe29858aeed82f45cc';

var MAX_SEARCH_RESULTS = 8;
var MAX_CANDIDATES = 3;
var SITE_TIMEOUT = 15000;
var EMBED_TIMEOUT = 12000;

var UA_SITE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
var UA_EMBED = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function log(m) { console.log('[RamoFlix] ' + m); }

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

function siteGet(url) {
  return fetchText(url, {
    'User-Agent': UA_SITE,
    'Referer': BASE_URL + '/',
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

function parseSearchResults(html) {
  var results = [], seen = {};
  var re = /<a\s+href=["']([^"']+\/(?:movie|tv|series|film)\/[^"'\/]+\/?)["'][^>]*>([^<]{2,120})<\/a>/gi;
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
  var url = BASE_URL + '/?s=' + encodeURIComponent(query);
  return siteGet(url).then(parseSearchResults).catch(function (e) {
    log('search failed (' + query + '): ' + e.message);
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
  log('best: ' + (best ? best.title : 'none') + ' score=' + bestScore.toFixed(2));
  return bestScore >= 0.5 ? best : null;
}

// ─────────────── fmovie Servers / Episodes extraction ────────────────

function extractServers(html) {
  var m = html.match(/var\s+Servers\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\\//g, '/')); }
  catch (e) { log('Servers parse: ' + e.message); return null; }
}

function extractServerLabels(html) {
  var labels = {};
  var re = /onclick=["']loadServer\(['"]?(\w+)['"]?\)["'][^>]*>[\s\S]{0,300}?<span>([^<]+)<\/span>/gi;
  var m;
  while ((m = re.exec(html)) !== null) labels[m[1]] = decodeEntities(m[2]).trim();
  return labels;
}

function extractEpisodes(html) {
  var m = html.match(/var\s+Episodes\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\\//g, '/')); }
  catch (e) { return null; }
}

function extractTvServerLabels(html) {
  var labels = [], seen = {};
  var re = /onclick=["']loadServer\(['"]?(\w+)['"]?\)["'][^>]*>[\s\S]{0,300}?<span>([^<]+)<\/span>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    if (!seen[m[1]]) { seen[m[1]] = 1; labels.push({ host: m[1], label: decodeEntities(m[2]).trim() }); }
  }
  return labels;
}

// ─────────────── Generic media extractors (Ahwak style) ──────────────

var QUALITY_RANK_AUTO = 1080;

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
  if (q === 'Auto') return QUALITY_RANK_AUTO;
  var n = parseInt(q, 10);
  return isNaN(n) ? 0 : n;
}

function cleanMediaUrl(url) {
  return String(url).replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
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

var BAD_ASSET = /\.(?:jpe?g|png|gif|webp|vtt|srt|css|js|json|html?)(?:[?#]|$)/i;

function scanMediaUrls(text, baseUrl) {
  var patterns = [
    /sources\s*:\s*\[\s*\{\s*["']?file["']?\s*:\s*["']([^"']+)["']/gi,
    /sources\s*:\s*\[\s*["']([^"']+)["']/gi,
    /["']?file["']?\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
    /["']hls\d*["']\s*:\s*["']([^"']+)["']/gi,
    /wurl\s*=\s*["']([^"']+)["']/gi,
    /["'](https?:\\?\/\\?\/[^"'\s]+?\.(?:m3u8|mp4)[^"'\s]*)["']/gi
  ];
  var found = [], seen = {};
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(text)) !== null) {
      var url = absoluteUrl(cleanMediaUrl(m[1]), baseUrl);
      if (!url || seen[url] || BAD_ASSET.test(url)) continue;
      seen[url] = true;
      found.push(url);
    }
  });
  return found;
}

function embedHeaders(embedUrl) {
  var origin = originOf(embedUrl);
  return { 'User-Agent': UA_EMBED, 'Referer': origin + '/', 'Origin': origin };
}

function extractGeneric(embedUrl) {
  return fetchText(embedUrl, {
    'User-Agent': UA_EMBED, 'Referer': originOf(embedUrl) + '/', 'Accept-Language': 'en;q=0.9'
  }, EMBED_TIMEOUT).then(function (html) {
    var texts = [html].concat(unpackAll(html));
    var urls = [];
    texts.forEach(function (t) {
      scanMediaUrls(t, embedUrl).forEach(function (u) { if (urls.indexOf(u) === -1) urls.push(u); });
    });
    var headers = embedHeaders(embedUrl);
    return urls.map(function (u) {
      var isHls = /\.m3u8/i.test(u);
      return { url: u, quality: isHls ? 'Auto' : (qualityFromUrl(u) || 'Unknown'), headers: headers };
    });
  });
}

function extractVk(embedUrl) {
  return fetchText(embedUrl, {
    'User-Agent': UA_EMBED, 'Referer': BASE_URL + '/', 'Accept-Language': 'en;q=0.9'
  }, EMBED_TIMEOUT).then(function (html) {
    var headers = { 'User-Agent': UA_EMBED, 'Referer': 'https://vk.com/' };
    var out = [];
    var re = /"url(\d{3,4})"\s*:\s*"(https?:[^"]+)"/g, m;
    while ((m = re.exec(html)) !== null) out.push({ url: cleanMediaUrl(m[2]), quality: m[1] + 'p', headers: headers });
    if (!out.length) {
      var hls = /"hls"\s*:\s*"(https?:[^"]+)"/.exec(html);
      if (hls) out.push({ url: cleanMediaUrl(hls[1]), quality: 'Auto', headers: headers });
    }
    return out;
  });
}

var OK_QUALITY = { mobile: '144p', lowest: '240p', low: '360p', sd: '480p', hd: '720p', full: '1080p', quad: '1440p', ultra: '2160p' };

function extractOk(embedUrl) {
  return fetchText(embedUrl, {
    'User-Agent': UA_EMBED, 'Referer': BASE_URL + '/', 'Accept-Language': 'en;q=0.9'
  }, EMBED_TIMEOUT).then(function (html) {
    var m = /data-options\s*=\s*"([^"]+)"/.exec(html);
    if (!m) return [];
    var options = JSON.parse(decodeEntities(m[1]));
    var meta = options && options.flashvars && options.flashvars.metadata;
    if (typeof meta === 'string') meta = JSON.parse(meta);
    if (!meta) return [];
    var headers = { 'User-Agent': UA_EMBED, 'Referer': 'https://ok.ru/' };
    var out = [];
    (meta.videos || []).forEach(function (v) {
      if (v && v.url) out.push({ url: cleanMediaUrl(v.url), quality: OK_QUALITY[v.name] || 'Unknown', headers: headers });
    });
    var hls = meta.hlsManifestUrl || meta.ondemandHls || meta.hlsMasterPlaylistUrl;
    if (hls) out.push({ url: cleanMediaUrl(hls), quality: 'Auto', headers: headers });
    return out;
  });
}

function resolveEmbed(embedUrl, label) {
  var host = hostOf(embedUrl);
  var job;
  if (/(^|\.)vk\.com$|(^|\.)vkvideo\.ru$/.test(host)) job = extractVk(embedUrl);
  else if (/(^|\.)ok\.ru$/.test(host)) job = extractOk(embedUrl);
  else job = extractGeneric(embedUrl);

  return job.then(function (items) {
    if (!items.length) throw new Error('no direct URL');
    return items.map(function (it) { it.server = label; return it; });
  }).catch(function () {
    var origin = originOf(embedUrl);
    return [{
      url: embedUrl,
      quality: 'Auto',
      isIframe: true,
      headers: { 'User-Agent': UA_EMBED, 'Referer': origin + '/', 'Origin': origin },
      server: label
    }];
  });
}

// ────────────────────── Stream assembly ──────────────────────────────

function buildStreams(embedList, title) {
  return Promise.all(embedList.map(function (e) {
    return resolveEmbed(e.url, e.label);
  })).then(function (groups) {
    var streams = [], seen = {};
    groups.forEach(function (items) {
      items.forEach(function (it) {
        if (seen[it.url]) return;
        seen[it.url] = true;
        streams.push({
          name: PROVIDER_NAME + ' ' + it.server + (it.quality && it.quality !== 'Unknown' ? ' ' + it.quality : ''),
          title: title,
          url: it.url,
          quality: it.quality || 'Auto',
          size: 'Unknown',
          type: it.isIframe ? 'iframe' : (/\.m3u8/i.test(it.url) ? 'hls' : 'mp4'),
          headers: it.headers,
          provider: PROVIDER_ID
        });
      });
    });
    streams.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return streams;
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
    return siteGet(match.url).then(function (html) {
      var servers = extractServers(html);
      if (!servers) { log('no Servers object'); return []; }
      var labels = extractServerLabels(html);
      var embedList = [];
      Object.keys(servers).forEach(function (k) {
        if (k === 'post_id' || k === 'id' || k === 'imdb_id' || k === 'image' ||
            k === 'vote_average' || k === 'site' || k === 'domain' || k === 'youtube_id' ||
            k === 'premium' || k === 'autoembed') return;
        var url = servers[k];
        if (!url || !/^https?:\/\//i.test(url)) return;
        var label = labels[k] || (hostOf(url).split('.').slice(-2, -1)[0] || k);
        embedList.push({ url: url, label: label });
      });
      log('embeds: ' + embedList.map(function (e) { return e.label; }).join(', '));
      return buildStreams(embedList, title);
    });
  });
}

// ───────────────────────── Series ────────────────────────────────────

function getTvStreams(meta, season, episode, title) {
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
    log('tv candidates: ' + all.length);
    if (!all.length) return [];
    var match = findBestMatch(all, meta);
    if (!match) return [];
    return siteGet(match.url).then(function (html) {
      var eps = extractEpisodes(html);
      if (!eps || !eps.post_id) { log('no Episodes object'); return []; }
      var postId = eps.post_id;
      var serverLabels = extractTvServerLabels(html);
      if (!serverLabels.length) { log('no TV servers'); return []; }
      var embedList = serverLabels.map(function (s) {
        return {
          url: BASE_URL + '/?player_tv=' + postId + '&s=' + season + '&e=' + episode + '&sv=' + encodeURIComponent(s.host) + '&tv=true',
          label: s.label
        };
      });
      log('tv embeds: ' + embedList.map(function (e) { return e.label; }).join(', '));
      return buildStreams(embedList, title);
    });
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
