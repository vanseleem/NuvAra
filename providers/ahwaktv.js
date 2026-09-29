'use strict';

var BASE_URL = 'https://yam.ahwaktv.net';
var TMDB_API_KEY = '83d364331c40bfbe29858aeed82f45cc';

var USER_AGENT =
  'Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

var HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ar,en-US;q=0.8,en;q=0.6'
};

function clean(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ').replace(/&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ').replace(/&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function normalizeArabic(value) {
  return clean(decodeHtml(value)).toLowerCase()
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ء/g, '').replace(/ـ/g, '')
    .replace(/[،؛؟ـ]/g, ' ')
    .replace(/[()[\]{}.,:;!?'"“”‘’\-_/\\|+*=#@%^&$]/g, ' ')
    .replace(/\b(مسلسل|فيلم|movie|film|series|tv|episode|الحلقة)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function words(value) {
  return normalizeArabic(value).split(' ').filter(function (word) { return word.length > 1; });
}

function hasArabic(value) {
  return /[\u0600-\u06FF]/.test(String(value || ''));
}

function unique(values) {
  var result = [];
  values.forEach(function (value) {
    if (!value) return;
    if (result.indexOf(value) === -1) result.push(value);
  });
  return result;
}

function absoluteUrl(url) {
  if (!url) return null;
  url = decodeHtml(url.trim());
  if (url.indexOf('//') === 0) return 'https:' + url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.charAt(0) === '/') return BASE_URL + url;
  return BASE_URL + '/' + url;
}

function titleScore(wanted, candidate) {
  var a = words(wanted);
  var b = words(candidate);
  if (!a.length || !b.length) return 0;
  var hits = 0;
  a.forEach(function (word) { if (b.indexOf(word) !== -1) hits++; });
  var coverageWanted = hits / a.length;
  var coverageCandidate = hits / b.length;
  if (normalizeArabic(wanted) === normalizeArabic(candidate)) return 1.0;
  return Math.max(coverageWanted * 0.75, coverageCandidate * 0.50);
}

function rankCandidate(wantedTitles, candidateTitle, url) {
  var best = 0;
  wantedTitles.forEach(function (wanted) {
    var score = titleScore(wanted, candidateTitle);
    if (score > best) best = score;
  });
  if (hasArabic(candidateTitle)) best += 0.10;
  if (/watch\.php/i.test(url)) best += 0.05;
  if (/mos|series|serial/i.test(url)) best += 0.02;
  return Math.min(best, 1.0);
}

function extractAnchors(html) {
  var results = [];
  var regex = /<a\b([^>]*)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = regex.exec(html)) !== null) {
    var attributes = String(match[1] || '') + ' ' + String(match[3] || '');
    var href = match[2];
    var inner = match[4];
    var title = clean(decodeHtml(inner));
    var attrTitle = '';
    var titleMatch = attributes.match(/\b(?:title|alt|data-title)\s*=\s*["']([^"']+)["']/i);
    if (titleMatch) attrTitle = clean(decodeHtml(titleMatch[1]));
    var finalTitle = title || attrTitle;
    if (!href) continue;
    results.push({ url: absoluteUrl(href), title: finalTitle });
  }
  return results;
}

function fetchText(url) {
  return fetch(url, { method: 'GET', headers: HEADERS })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
      return response.text();
    });
}

function tmdbUrl(path, params) {
  var query = [];
  query.push('api_key=' + encodeURIComponent(TMDB_API_KEY));
  query.push('language=ar-SA');
  Object.keys(params || {}).forEach(function (key) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
      query.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
    }
  });
  return 'https://api.themoviedb.org/3' + path + '?' + query.join('&');
}

function getTMDBMovie(tmdbId) {
  return fetch(tmdbUrl('/movie/' + encodeURIComponent(tmdbId), {}))
    .then(function (response) {
      if (!response.ok) throw new Error('TMDB movie HTTP ' + response.status);
      return response.json();
    });
}

function getTMDBTV(tmdbId) {
  return fetch(tmdbUrl('/tv/' + encodeURIComponent(tmdbId), {}))
    .then(function (response) {
      if (!response.ok) throw new Error('TMDB TV HTTP ' + response.status);
      return response.json();
    });
}

function movieTitles(meta) {
  return unique([meta.title, meta.original_title, meta.name, meta.original_name].filter(Boolean));
}

function tvTitles(meta) {
  return unique([meta.name, meta.original_name, meta.title, meta.original_title].filter(Boolean));
}

/* ============================================================
 * THE ONLY FUNCTION THAT CHANGED — keywords= added first
 * ============================================================ */
function buildSearchUrls(title) {
  var q = encodeURIComponent(title);
  return unique([
    BASE_URL + '/search.php?keywords=' + q,
    BASE_URL + '/search.php?search=' + q,
    BASE_URL + '/search.php?q=' + q
  ]);
}

function searchOneTitle(title) {
  var urls = buildSearchUrls(title);
  var index = 0;
  var all = [];
  function next() {
    if (index >= urls.length) return Promise.resolve(all);
    var url = urls[index++];
    return fetchText(url)
      .then(function (html) {
        all = all.concat(extractAnchors(html));
        return next();
      })
      .catch(function () { return next(); });
  }
  return next();
}

function searchAhwak(titles) {
  var index = 0;
  var all = [];
  function next() {
    if (index >= titles.length) return Promise.resolve(all);
    var title = titles[index++];
    return searchOneTitle(title).then(function (results) {
      all = all.concat(results);
      return next();
    });
  }
  return next();
}

function isLikelyMoviePage(candidate) {
  var url = candidate.url || '';
  return /watch\.php/i.test(url) || /movie/i.test(url) || /film/i.test(url);
}

function isLikelyTVPage(candidate) {
  var url = candidate.url || '';
  return /mos/i.test(url) || /series/i.test(url) || /serial/i.test(url) || /watch\.php/i.test(url);
}

function chooseBestCandidate(candidates, titles, mediaType) {
  var filtered = [];
  candidates.forEach(function (candidate) {
    if (!candidate.url || !candidate.title) return;
    if (mediaType === 'movie' && !isLikelyMoviePage(candidate)) return;
    if (mediaType === 'tv' && !isLikelyTVPage(candidate)) return;
    var score = rankCandidate(titles, candidate.title, candidate.url);
    if (score < 0.70) return;
    filtered.push({ url: candidate.url, title: candidate.title, score: score });
  });
  filtered.sort(function (a, b) { return b.score - a.score; });
  return filtered.length ? filtered[0] : null;
}

/* ============================================================
 * VIDEO EXTRACTION (added earlier, unchanged)
 * ============================================================ */

function extractSeeUrl(html) {
  var m = html.match(/https?:\/\/[a-z0-9.-]*\/see\.php\?vid=[A-Za-z0-9]+/i);
  if (m) return m[0];
  var m2 = html.match(/['"]((?:https?:)?\/\/[^"']*\/see\.php\?vid=[A-Za-z0-9]+)['"]/i);
  if (m2) { var u = m2[1]; if (u.indexOf('//') === 0) u = 'https:' + u; return u; }
  var m3 = html.match(/['"]([^"']*\/see\.php\?vid=[A-Za-z0-9]+)['"]/i);
  if (m3) {
    var u3 = m3[1];
    if (u3.indexOf('//') === 0) u3 = 'https:' + u3;
    else if (!/^https?:/i.test(u3)) u3 = BASE_URL + (u3.charAt(0) === '/' ? u3 : '/' + u3);
    return u3;
  }
  return null;
}

function extractEmbedUrls(html) {
  var out = [];
  var seen = {};
  function add(u) {
    u = decodeHtml(String(u || '').trim());
    if (u.indexOf('//') === 0) u = 'https:' + u;
    else if (u.charAt(0) === '/') u = BASE_URL + u;
    if (!/^https?:/i.test(u)) return;
    if (/googletagmanager|google\.|facebook|histats|pamphiltre|cloudflare|adcash|monetag|propeller|popads|amazon|gstatic|jquery|w3\.org|schema\.org/i.test(u)) return;
    if (seen[u]) return;
    seen[u] = true;
    out.push(u);
  }
  var m;
  var reIf = /<iframe[^>]*src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) !== null) add(m[1]);
  var reData = /data-[a-z0-9_-]+=["'](https?:\/\/[^"']+)["']/gi;
  while ((m = reData.exec(html)) !== null) add(m[1]);
  var reAny = /https?:\/\/[^"'\s<>]*(?:1vid|vidmoly|playmogo|uqload|dood|voe|streamtape|filemoon|upstream|mp4upload|sendvid|sibnet|mixdrop|ds2play|vidspeed|ok\.ru|vk\.com)[^"'\s<>]*/gi;
  while ((m = reAny.exec(html)) !== null) add(m[0]);
  return out;
}

function hostLabel(url) {
  var m = String(url || '').match(/^https?:\/\/(?:www\.)?([^\.\/]+)/i);
  return m ? m[1] : 'Server';
}

function makeStream(url, label, referer, type) {
  if (url.indexOf('http://') === 0) url = 'https://' + url.slice(7);
  var t = type || 'iframe';
  if (/\.m3u8/i.test(url)) t = 'hls';
  else if (/\.mp4/i.test(url)) t = 'mp4';
  return {
    name: '🌙 AhwakTV',
    title: '🌙 AhwakTV • ' + label,
    url: url,
    quality: 'Auto',
    type: t,
    referer: referer || (BASE_URL + '/'),
    headers: { 'User-Agent': USER_AGENT, 'Referer': referer || (BASE_URL + '/') }
  };
}

function resolveVidMoly(embedUrl) {
  return fetch(embedUrl, { headers: { 'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/' }, redirect: 'follow' })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/i);
      if (!m) m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      if (!m) return [];
      return [makeStream(m[1].replace(/\\\//g, '/'), 'VidMoly', 'https://vidmoly.to/', 'hls')];
    })
    .catch(function (e) { console.log('[Ahwak] VidMoly err:', e.message); return []; });
}

function resolveDood(embedUrl) {
  return fetch(embedUrl, { headers: { 'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/' }, redirect: 'follow' })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var pm = html.match(/["'](\/pass_md5\/[^"']+)["']/i);
      if (!pm) return [];
      var tkMatch = pm[1].match(/\/pass_md5\/([^\/]+)/);
      var token = tkMatch ? tkMatch[1] : '';
      var exMatch = html.match(/[?&]expiry=([0-9]+)/i);
      var expiry = exMatch ? exMatch[1] : String(Math.floor(Date.now() / 1000) + 3600);
      var originMatch = embedUrl.match(/^(https?:\/\/[^\/]+)/);
      var origin = originMatch ? originMatch[1] : '';
      return fetch(origin + pm[1], { headers: { 'User-Agent': USER_AGENT, 'Referer': embedUrl }, redirect: 'follow' })
        .then(function (pr) { return pr.text(); })
        .then(function (base) {
          if (!base || base.length < 10) return [];
          var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          var rnd = '';
          for (var i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
          return [makeStream(base + rnd + '?token=' + token + '&expiry=' + expiry, 'Dood', embedUrl, 'mp4')];
        });
    })
    .catch(function (e) { console.log('[Ahwak] Dood err:', e.message); return []; });
}

function unpackEval(html) {
  var m = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  var payload = m[1];
  var base = parseInt(m[2], 10);
  var count = parseInt(m[3], 10);
  var kw = m[4].split('|');
  var i = count;
  while (i--) {
    if (kw[i]) payload = payload.replace(new RegExp('\\b' + i.toString(base) + '\\b', 'g'), kw[i]);
  }
  return payload;
}

function resolve1Vid(embedUrl) {
  return fetch(embedUrl, { headers: { 'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/' }, redirect: 'follow' })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var unpacked = unpackEval(html) || html;
      var m = unpacked.match(/https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/i);
      if (!m) return [];
      var url = m[0].replace(/\\\//g, '/');
      return [makeStream(url, '1Vid', embedUrl, /\.m3u8/i.test(url) ? 'hls' : 'mp4')];
    })
    .catch(function (e) { console.log('[Ahwak] 1Vid err:', e.message); return []; });
}

function resolveOkRu(embedUrl) {
  return fetch(embedUrl, { headers: { 'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/' }, redirect: 'follow' })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var m = html.match(/"hlsManifestUrl":"([^"]+)"/i);
      if (m) return [makeStream(m[1].replace(/\\\//g, '/'), 'OK.ru', 'https://ok.ru/', 'hls')];
      m = html.match(/"videoUrl":"([^"]+)"/i);
      if (m) return [makeStream(m[1].replace(/\\\//g, '/'), 'OK.ru', 'https://ok.ru/', 'mp4')];
      m = html.match(/url[0-9]{3}["']?\s*[:=]\s*["']([^"']+)["']/);
      if (m) return [makeStream(m[1].replace(/\\\//g, '/'), 'OK.ru', 'https://ok.ru/', 'mp4')];
      return [];
    })
    .catch(function (e) { console.log('[Ahwak] OK.ru err:', e.message); return []; });
}

function resolveEmbed(embedUrl) {
  var host = hostLabel(embedUrl).toLowerCase();
  if (host.indexOf('vidmoly') !== -1) return resolveVidMoly(embedUrl);
  if (host.indexOf('playmogo') !== -1 || host.indexOf('dood') !== -1 ||
      host.indexOf('uqload') !== -1 || host.indexOf('ds2play') !== -1 ||
      host.indexOf('vidspeed') !== -1) return resolveDood(embedUrl);
  if (host.indexOf('1vid') !== -1) return resolve1Vid(embedUrl);
  if (host.indexOf('ok.ru') !== -1 || host.indexOf('okru') !== -1) return resolveOkRu(embedUrl);
  return Promise.resolve([]);
}

function extractStreamsFromPage(pageUrl, referer) {
  console.log('[Ahwak] Extract from:', pageUrl);
  return fetchText(pageUrl)
    .then(function (watchHtml) {
      var seeUrl = extractSeeUrl(watchHtml);
      if (!seeUrl) { console.log('[Ahwak] No see.php found'); return []; }
      console.log('[Ahwak] see.php:', seeUrl);
      return fetchText(seeUrl).then(function (seeHtml) {
        var embeds = extractEmbedUrls(seeHtml);
        console.log('[Ahwak] Embeds:', embeds.length, '[' + embeds.map(hostLabel).join(', ') + ']');
        if (!embeds.length) return [];
        return Promise.all(embeds.map(function (e) {
          return resolveEmbed(e).catch(function () { return []; });
        })).then(function (groups) {
          var streams = [];
          var seen = {};
          groups.forEach(function (group) {
            group.forEach(function (s) {
              if (seen[s.url]) return;
              seen[s.url] = true;
              streams.push(s);
            });
          });
          console.log('[Ahwak] Streams resolved:', streams.length);
          return streams;
        });
      });
    })
    .catch(function (e) { console.log('[Ahwak] Extract error:', e.message); return []; });
}

function resolveMovie(tmdbId) {
  return getTMDBMovie(tmdbId).then(function (meta) {
    var titles = movieTitles(meta);
    if (!titles.length) throw new Error('TMDB returned no usable movie title');
    console.log('[Ahwak] Movie titles: ' + JSON.stringify(titles));
    return searchAhwak(titles).then(function (results) {
      var candidate = chooseBestCandidate(results, titles, 'movie');
      if (!candidate) { console.log('[Ahwak] No sufficiently strong movie match'); return null; }
      console.log('[Ahwak] MOVIE MATCH: ' + candidate.title + ' -> ' + candidate.url + ' score=' + candidate.score);
      return { type: 'movie', tmdbId: String(tmdbId), title: candidate.title, url: candidate.url, score: candidate.score };
    });
  });
}

function resolveTV(tmdbId, season, episode) {
  return getTMDBTV(tmdbId).then(function (meta) {
    var titles = tvTitles(meta);
    if (!titles.length) throw new Error('TMDB returned no usable TV title');
    console.log('[Ahwak] TV titles: ' + JSON.stringify(titles));
    return searchAhwak(titles).then(function (results) {
      var candidate = chooseBestCandidate(results, titles, 'tv');
      if (!candidate) { console.log('[Ahwak] No sufficiently strong TV match'); return null; }
      console.log('[Ahwak] SERIES MATCH: ' + candidate.title + ' -> ' + candidate.url + ' score=' + candidate.score);
      return fetchText(candidate.url).then(function (seriesHtml) {
        var episodeCandidate = findEpisode(seriesHtml, season, episode);
        if (!episodeCandidate) { console.log('[Ahwak] Series found but exact episode ' + season + 'x' + episode + ' was not verified'); return null; }
        console.log('[Ahwak] EPISODE MATCH: ' + season + 'x' + episode + ' -> ' + episodeCandidate.url);
        return {
          type: 'tv', tmdbId: String(tmdbId), title: candidate.title,
          seriesUrl: candidate.url, episodeUrl: episodeCandidate.url,
          episodeTitle: episodeCandidate.title, season: season, episode: episode,
          score: candidate.score
        };
      });
    });
  });
}

function findEpisode(html, season, episode) {
  var anchors = extractAnchors(html);
  var seasonNumber = String(season);
  var episodeNumber = String(episode);
  var patterns = [
    new RegExp('\\bS?0?' + seasonNumber + '\\s*E?0?' + episodeNumber + '\\b', 'i'),
    new RegExp('الموسم\\s*' + seasonNumber + '[^\\d]{0,30}' + 'الحلق[ةه]\\s*' + episodeNumber, 'i'),
    new RegExp('season\\s*' + seasonNumber + '[^\\d]{0,30}' + 'episode\\s*' + episodeNumber, 'i'),
    new RegExp('episode\\s*' + episodeNumber, 'i'),
    new RegExp('الحلق[ةه]\\s*' + episodeNumber, 'i')
  ];
  var matches = [];
  anchors.forEach(function (anchor) {
    var haystack = normalizeArabic(anchor.title) + ' ' + normalizeArabic(anchor.url);
    var found = false;
    patterns.forEach(function (pattern) { if (pattern.test(haystack)) found = true; });
    if (!found) return;
    if (!/watch\.php/i.test(anchor.url)) return;
    matches.push(anchor);
  });
  if (!matches.length) return null;
  matches.sort(function (a, b) {
    var aScore = /watch\.php/i.test(a.url) ? 2 : 0;
    var bScore = /watch\.php/i.test(b.url) ? 2 : 0;
    if (new RegExp('0?' + episodeNumber + '\\b').test(a.title)) aScore++;
    if (new RegExp('0?' + episodeNumber + '\\b').test(b.title)) bScore++;
    return bScore - aScore;
  });
  return matches[0];
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log('[Ahwak] Request:', String(tmdbId), String(mediaType), String(season), String(episode));
  if (!tmdbId) return Promise.resolve([]);

  if (mediaType === 'movie') {
    return resolveMovie(tmdbId).then(function (resolved) {
      if (!resolved) return [];
      console.log('[Ahwak] VERIFIED MOVIE PAGE: ' + resolved.url);
      return extractStreamsFromPage(resolved.url, BASE_URL + '/');
    }).catch(function (error) {
      console.log('[Ahwak] Movie error: ' + error.message);
      return [];
    });
  }

  if (mediaType === 'tv') {
    if (season === null || season === undefined || episode === null || episode === undefined) {
      return Promise.resolve([]);
    }
    return resolveTV(tmdbId, season, episode).then(function (resolved) {
      if (!resolved) return [];
      console.log('[Ahwak] VERIFIED EPISODE PAGE: ' + resolved.episodeUrl);
      return extractStreamsFromPage(resolved.episodeUrl, BASE_URL + '/');
    }).catch(function (error) {
      console.log('[Ahwak] TV error: ' + error.message);
      return [];
    });
  }

  return Promise.resolve([]);
}

module.exports = { getStreams: getStreams };
