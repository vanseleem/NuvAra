// ─────────────────────────────────────────────────────────────────────
// ShahidMosalsalat — AhwakTV architecture (replica)
// ─────────────────────────────────────────────────────────────────────
var BASE_URL = 'https://v5.shahidmosalsalat.business';
var SEARCH_BASE = 'https://r.shahidmosalsalat.me';
var PROVIDER_ID = 'shahidmosalsalat';
var PROVIDER_NAME = '⚜️ ShahidMosalsalat';

// Free key from https://www.themoviedb.org/settings/api
var TMDB_API_KEY = '83d364331c40bfbe29858aeed82f45cc';

// ───────────────────────── Content language filter ─────────────────────
// 'arabic'  = only Arabic-original content
// 'english' = only English-original content
// 'both'    = both Arabic and English content (default)
var CONTENT_LANG = 'both';

// true  = skip dubbed / subtitled uploads for Arabic content
var SKIP_DUB_SUB_ARABIC = true;

var MAX_SEARCH_PAGES = 3;
var MAX_MOVIE_CANDIDATES = 3;
var MAX_EPISODE_CANDIDATES = 2;
var SITE_TIMEOUT = 15000;
var EMBED_TIMEOUT = 12000;

var UA_SITE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
var UA_EMBED = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─────────────────────────────── Logging ──────────────────────────────

function log(message) {
  console.log('[ShahidMosalsalat] ' + message);
}

// ───────────────────────────── Text helpers ───────────────────────────

function decodeEntities(str) {
  return String(str == null ? '' : str)
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function toWesternDigits(str) {
  return String(str)
    .replace(/[\u0660-\u0669]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
    .replace(/[\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
}

function normalizeText(input) {
  var s = toWesternDigits(decodeEntities(input)).toLowerCase();
  if (typeof s.normalize === 'function') {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  s = s
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A')
    .replace(/\u0686/g, '\u062C')
    .replace(/\u067E/g, '\u0628')
    .replace(/\u06A4/g, '\u0641')
    .replace(/[\u06AF\u06A9]/g, '\u0643')
    .replace(/\u06CC/g, '\u064A');
  return s.replace(/[^\u0621-\u064Aa-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizedSet(words) {
  var set = {};
  words.forEach(function (w) { set[normalizeText(w)] = true; });
  return set;
}

function cleanQuery(text) {
  return decodeEntities(text)
    .replace(/[\u060C\u061B\u061F\u066A-\u066D\u06D4]/g, ' ')
    .replace(/[!-\/:-@\[-`{-~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasArabicScript(text) {
  return /[\u0600-\u06FF]/.test(text);
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// ────────────────────────── Title vocabulary ──────────────────────────

var KIND_BY_WORD = {};
[
  ['فيلم', 'movie'], ['مسرحية', 'play'], ['مسلسل', 'series'], ['انمي', 'series'], ['برنامج', 'show'],
  ['movie', 'movie'], ['film', 'movie'], ['play', 'play'], ['series', 'series'], ['show', 'show'], ['anime', 'series']
].forEach(function (p) { KIND_BY_WORD[normalizeText(p[0])] = p[1]; });

var DUB_WORDS = normalizedSet(['مدبلج', 'مدبلجة', 'dubbed', 'dub']);
var SUB_WORDS = normalizedSet(['مترجم', 'مترجمة', 'subtitled', 'subbed', 'sub']);
var SEASON_WORDS = normalizedSet(['الموسم', 'الجزء', 'season']);
var EPISODE_WORDS = normalizedSet(['الحلقة', 'episode', 'ep']);
var NOISE_WORDS = normalizedSet([
  'كامل', 'كاملة', 'hd', 'fhd', 'uhd', '4k', 'bluray', 'hdrip', 'webrip', '720p', '1080p',
  'بجودة', 'جودة', 'عالية', 'اون', 'لاين', 'اونلاين', 'مشاهدة', 'مباشرة', 'يوتيوب',
  'complete', 'full', 'watch', 'online', 'streaming', 'blu-ray', 'web-rip',
  'quality', 'high', 'youtube'
]);

var ORDINALS = {};
[
  ['الاول', 1], ['الاولى', 1], ['الثاني', 2], ['الثانية', 2], ['الثالث', 3], ['الثالثة', 3],
  ['الرابع', 4], ['الرابعة', 4], ['الخامس', 5], ['الخامسة', 5], ['السادس', 6], ['السادسة', 6],
  ['السابع', 7], ['السابعة', 7], ['الثامن', 8], ['الثامنة', 8], ['التاسع', 9], ['التاسعة', 9],
  ['العاشر', 10], ['العاشرة', 10]
].forEach(function (p) { ORDINALS[normalizeText(p[0])] = p[1]; });

function numberFromToken(token) {
  if (/^\d{1,3}$/.test(token)) return parseInt(token, 10);
  return ORDINALS[token] || null;
}

function parseTitle(raw) {
  var info = { kind: null, name: '', year: null, season: null, episode: null, dubbed: false, subbed: false };
  var tokens = normalizeText(raw).split(' ').filter(Boolean);

  // Scan first few tokens for kind word (handles "مشاهدة فيلم ..." prefixes)
  var kindIdx = -1;
  for (var k = 0; k < Math.min(tokens.length, 3); k++) {
    if (KIND_BY_WORD[tokens[k]]) { kindIdx = k; break; }
  }
  if (kindIdx !== -1) {
    info.kind = KIND_BY_WORD[tokens[kindIdx]];
    tokens.splice(kindIdx, 1);
  }

  tokens = tokens.filter(function (t) {
    if (DUB_WORDS[t]) { info.dubbed = true; return false; }
    if (SUB_WORDS[t]) { info.subbed = true; return false; }
    return true;
  });

  if (info.kind === 'series' || info.kind === 'show') {
    var epIdx = -1;
    for (var e = 0; e < tokens.length; e++) {
      if (EPISODE_WORDS[tokens[e]]) { epIdx = e; break; }
    }
    if (epIdx !== -1) {
      if (/^\d+$/.test(tokens[epIdx + 1] || '')) info.episode = parseInt(tokens[epIdx + 1], 10);
      tokens = tokens.slice(0, epIdx);
    }
    for (var i = 0; i < tokens.length - 1; i++) {
      var n = SEASON_WORDS[tokens[i]] ? numberFromToken(tokens[i + 1]) : null;
      if (n) { info.season = n; tokens.splice(i, 2); break; }
    }
  } else {
    for (var j = tokens.length - 1; j >= 0; j--) {
      if (/^(19|20)\d\d$/.test(tokens[j])) {
        if (tokens.length > 1) { info.year = parseInt(tokens[j], 10); tokens.splice(j, 1); }
        break;
      }
    }
  }

  info.name = tokens.filter(function (t) { return !NOISE_WORDS[t]; }).join(' ');
  return info;
}

// ─────────────────────────── Fuzzy comparison ─────────────────────────

function bigramMap(str) {
  var s = str.replace(/ /g, '');
  var map = {};
  var size = 0;
  for (var i = 0; i < s.length - 1; i++) {
    var g = s.substr(i, 2);
    map[g] = (map[g] || 0) + 1;
    size++;
  }
  return { map: map, size: size };
}

function diceScore(a, b) {
  if (a === b) return 1;
  var x = bigramMap(a);
  var y = bigramMap(b);
  if (!x.size || !y.size) return 0;
  var common = 0;
  Object.keys(x.map).forEach(function (g) {
    if (y.map[g]) common += Math.min(x.map[g], y.map[g]);
  });
  return (2 * common) / (x.size + y.size);
}

function numberTokens(str) {
  return (str.match(/\d+/g) || []).join(',');
}

// ──────────────────────────────── HTTP ────────────────────────────────

function asciiSafe(value) {
  return String(value).replace(/[^\x00-\x7F]/g, function (c) { return encodeURIComponent(c); });
}

function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== 'function') return promise;
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('timeout: ' + label)); }, ms);
    promise.then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); }
    );
  });
}

function fetchText(url, headers, timeoutMs) {
  url = asciiSafe(url);
  if (headers && headers['Referer']) headers['Referer'] = asciiSafe(headers['Referer']);
  return withTimeout(fetch(url, { method: 'GET', headers: headers, redirect: 'follow' }), timeoutMs, url.split('?')[0])
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.split('?')[0]);
      return res.text();
    });
}

function siteGet(url, referer) {
  return fetchText(url, {
    'User-Agent': UA_SITE,
    'Referer': referer || BASE_URL + '/',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ar,en;q=0.9'
  }, SITE_TIMEOUT);
}

function searchGet(url) {
  return fetchText(url, {
    'User-Agent': UA_SITE,
    'Referer': SEARCH_BASE + '/',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ar,en;q=0.9'
  }, SITE_TIMEOUT);
}

function hostOf(url) {
  var m = /^https?:\/\/([^\/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

function originOf(url) {
  var m = /^(https?:\/\/[^\/?#]+)/i.exec(url);
  return m ? m[1] : '';
}

function absoluteUrl(url, baseUrl) {
  var u = decodeEntities(url).trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.charAt(0) === '/') return originOf(baseUrl) + u;
  return '';
}

// ─────────────────────────── HTML extraction ──────────────────────────

function getAttr(tag, name) {
  var m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
}

function parseWatchAnchors(html) {
  var byVid = {};
  var out = [];
  var re = /<a\b[^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var tag = m[0];
    var idMatch = /watch\.php\?vid=([A-Za-z0-9]+)/.exec(decodeEntities(getAttr(tag, 'href')));
    if (!idMatch) continue;
    var vid = idMatch[1];
    var title = decodeEntities(getAttr(tag, 'title')).trim();
    var closeAt = html.indexOf('</a>', re.lastIndex);
    var inner = closeAt === -1 ? '' : html.slice(re.lastIndex, Math.min(closeAt, re.lastIndex + 400));
    var text = decodeEntities(inner.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (byVid[vid]) {
      if (!byVid[vid].title && title) byVid[vid].title = title;
      continue;
    }
    byVid[vid] = { vid: vid, title: title, text: text, index: m.index };
    out.push(byVid[vid]);
  }
  return out;
}

function parseMaxPage(html) {
  var max = 1;
  var re = /[?&;]page=(\d+)/g;
  var m;
  while ((m = re.exec(html)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return max;
}

// ──────────────────────────────── TMDB ────────────────────────────────

function fetchTmdb(tmdbId, type) {
  var url = 'https://api.themoviedb.org/3/' + type + '/' + encodeURIComponent(tmdbId) +
    '?api_key=' + TMDB_API_KEY + '&language=ar&append_to_response=translations,alternative_titles';
  return fetchText(url, { 'Accept': 'application/json' }, SITE_TIMEOUT).then(function (body) {
    return JSON.parse(body);
  });
}

function buildMeta(data, type) {
  var isTv = type === 'tv';
  var raw = [isTv ? data.name : data.title, isTv ? data.original_name : data.original_title];

  var translations = (data.translations && data.translations.translations) || [];
  translations.forEach(function (t) {
    if (t.iso_639_1 === 'ar' && t.data) raw.push(isTv ? t.data.name : t.data.title);
    if (t.iso_639_1 === 'en' && t.data) raw.push(isTv ? t.data.name : t.data.title);
  });

  if (!isTv) {
    var alts = (data.alternative_titles && data.alternative_titles.titles) || [];
    alts.forEach(function (a) { raw.push(a.title); });
  }

  var arabic = data.original_language === 'ar';
  var english = data.original_language === 'en';

  var processable = true;
  if (CONTENT_LANG === 'arabic' && !arabic) processable = false;
  if (CONTENT_LANG === 'english' && !english) processable = false;

  var seenNorm = {};
  var titles = [];
  raw.forEach(function (t) {
    if (!t) return;
    if (arabic && !hasArabicScript(t)) return;
    var norm = normalizeText(t);
    if (!norm || seenNorm[norm]) return;
    seenNorm[norm] = true;
    titles.push({ raw: t, norm: norm });
  });

  var dateStr = isTv ? data.first_air_date : data.release_date;
  var year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;

  return {
    type: type,
    arabic: arabic,
    english: english,
    processable: processable,
    year: isNaN(year) ? null : year,
    displayTitle: titles.length ? titles[0].raw : (isTv ? data.name : data.title),
    targets: titles.map(function (t) { return t.norm; }),
    queries: titles.slice(0, 3).map(function (t) { return cleanQuery(t.raw); }).filter(Boolean)
  };
}

// ─────────────────────────────── Search ───────────────────────────────

function searchPage(query, page) {
  var url = SEARCH_BASE + '/search.php?keywords=' + encodeURIComponent(query) + (page > 1 ? '&page=' + page : '');
  return searchGet(url).then(function (html) {
    return {
      entries: parseWatchAnchors(html).filter(function (a) { return a.title; }),
      maxPage: parseMaxPage(html)
    };
  });
}

function searchPages(query, onEntries) {
  var page = 1;
  function step() {
    return searchPage(query, page).then(function (res) {
      if (onEntries(res.entries)) return true;
      if (page >= MAX_SEARCH_PAGES || page >= res.maxPage) return false;
      page += 1;
      return step();
    }).catch(function (err) {
      log('search failed (' + query + ' p' + page + '): ' + (err && err.message));
      return false;
    });
  }
  return step();
}

function searchQueries(queries, onEntries, afterQuery) {
  var qi = 0;
  function nextQuery() {
    if (qi >= queries.length) return Promise.resolve(false);
    return searchPages(queries[qi++], onEntries).then(function (stop) {
      if (stop || (afterQuery && afterQuery())) return true;
      return nextQuery();
    });
  }
  return nextQuery();
}

// ─────────────────────────────── Movies ───────────────────────────────

function scoreMovieEntry(entry, meta) {
  var info = parseTitle(entry.title);
  if (info.kind !== 'movie' && info.kind !== 'play') return null;

  if (meta.arabic && SKIP_DUB_SUB_ARABIC && (info.dubbed || info.subbed)) return null;

  var yearDiff = meta.year && info.year ? Math.abs(meta.year - info.year) : null;
  if (yearDiff !== null && yearDiff > 1) return null;

  var base = 0;
  meta.targets.forEach(function (target) {
    if (info.name === target) {
      base = Math.max(base, 100);
    } else if (yearDiff !== null && numberTokens(info.name) === numberTokens(target) && diceScore(info.name, target) >= 0.9) {
      base = Math.max(base, 80);
    }
  });
  if (!base) return null;

  return {
    vid: entry.vid,
    title: entry.title,
    year: info.year,
    score: base + (yearDiff === 0 ? 10 : yearDiff === 1 ? 5 : 0),
    confident: base === 100 && (yearDiff !== null || !meta.year)
  };
}

function findMovieCandidates(meta) {
  var found = [];
  var seen = {};
  var queries = [];
  meta.queries.forEach(function (q, i) {
    queries.push(q);
    if (i === 0 && meta.year) queries.push(q + ' ' + meta.year);
  });

  function onEntries(entries) {
    var confident = false;
    entries.forEach(function (entry) {
      if (seen[entry.vid]) return;
      var scored = scoreMovieEntry(entry, meta);
      if (!scored) return;
      seen[entry.vid] = true;
      scored.order = found.length;
      found.push(scored);
      if (scored.confident) confident = true;
    });
    return confident;
  }

  return searchQueries(queries, onEntries, function () { return found.length > 0; }).then(function () {
    return found.sort(function (a, b) { return (b.score - a.score) || (a.order - b.order); });
  });
}

function yearAcceptable(candidate, meta) {
  if (candidate.year || !meta.year) return Promise.resolve(true);
  return siteGet(BASE_URL + '/watch.php?vid=' + candidate.vid).then(function (html) {
    var head = [];
    var desc = /<meta[^>]+name=["']description["'][^>]*>/i.exec(html);
    var title = /<title>([^<]*)<\/title>/i.exec(html);
    if (desc) head.push(getAttr(desc[0], 'content'));
    if (title) head.push(title[1]);
    var years = (toWesternDigits(decodeEntities(head.join(' '))).match(/\b(?:19|20)\d\d\b/g) || []).map(Number);
    if (!years.length) return true;
    return years.some(function (y) { return Math.abs(y - meta.year) <= 1; });
  }).catch(function () { return true; });
}

function getMovieStreams(meta, title) {
  return findMovieCandidates(meta).then(function (candidates) {
    log('movie candidates: ' + candidates.map(function (c) { return c.vid + ' (' + c.score + ')'; }).join(', '));
    var list = candidates.slice(0, MAX_MOVIE_CANDIDATES);
    var i = 0;
    function next() {
      if (i >= list.length) return Promise.resolve([]);
      var cand = list[i++];
      return yearAcceptable(cand, meta).then(function (ok) {
        if (!ok) return next();
        return getServerStreams(cand.vid, title).catch(function (err) {
          log('servers failed for ' + cand.vid + ': ' + (err && err.message));
          return [];
        }).then(function (streams) {
          return streams.length ? streams : next();
        });
      });
    }
    return next();
  });
}

// ─────────────────────────────── Series ───────────────────────────────

function matchSeriesName(name, targets) {
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    if (name === t) return { matched: true, trailingSeason: null };
    if (name.indexOf(t + ' ') === 0) {
      var rest = name.slice(t.length + 1);
      if (/^\d{1,2}$/.test(rest)) return { matched: true, trailingSeason: parseInt(rest, 10) };
    }
  }
  return { matched: false, trailingSeason: null };
}

function findSeriesEntries(meta, season) {
  var matched = [];
  var seen = {};

  function onEntries(entries) {
    entries.forEach(function (entry) {
      if (seen[entry.vid]) return;
      var info = parseTitle(entry.title);
      if (info.kind !== 'series' && info.kind !== 'show') return;
      if (info.episode === null) return;
      if (meta.arabic && SKIP_DUB_SUB_ARABIC && (info.dubbed || info.subbed)) return;
      var m = matchSeriesName(info.name, meta.targets);
      if (!m.matched) return;
      var entrySeason = info.season || m.trailingSeason || null;
      if (entrySeason !== null && entrySeason !== season) return;
      seen[entry.vid] = true;
      matched.push({ vid: entry.vid, title: entry.title, info: info, entrySeason: entrySeason });
    });
    return matched.length > 0;
  }

  return searchQueries(meta.queries, onEntries).then(function () { return matched; });
}

function parseSeasons(html) {
  var headings = [];
  var hre = />\s*الموسم\s*([0-9\u0660-\u0669]+)\s*</g;
  var m;
  while ((m = hre.exec(html)) !== null) {
    headings.push({ index: m.index, season: parseInt(toWesternDigits(m[1]), 10) });
  }

  var anchors = parseWatchAnchors(html);
  var sections = [];
  var bySeason = {};
  anchors.forEach(function (a) {
    var season = 1;
    headings.forEach(function (h) { if (h.index < a.index) season = h.season; });
    var episode = a.title ? parseTitle(a.title).episode : null;
    if (episode === null) {
      var n = /\d+/.exec(toWesternDigits(a.text));
      episode = n ? parseInt(n[0], 10) : null;
    }
    if (episode === null) return;
    if (!bySeason[season]) {
      bySeason[season] = { season: season, episodes: [] };
      sections.push(bySeason[season]);
    }
    bySeason[season].episodes.push({ episode: episode, vid: a.vid });
  });

  var ambiguous = false;
  for (var i = 0; i < headings.length - 1; i++) {
    var between = anchors.filter(function (a) {
      return a.index > headings[i].index && a.index < headings[i + 1].index;
    });
    if (!between.length) ambiguous = true;
  }
  return { sections: sections, ambiguous: ambiguous };
}

function sliceEpisodeBlock(html) {
  var start = html.indexOf('المواسم والحلقات');
  if (start === -1) return '';
  var end = html.length;
  ['pm-user-header', 'pm-video-posting-info', 'pm-video-description'].forEach(function (marker) {
    var i = html.indexOf(marker, start);
    if (i !== -1 && i < end) end = i;
  });
  return html.slice(start, end);
}

function fetchSeriesSections(vid) {
  var watchUrl = BASE_URL + '/watch.php?vid=' + vid;
  return siteGet(watchUrl).then(function (html) {
    var fromWatchPage = function () { return parseSeasons(sliceEpisodeBlock(html)); };
    var link = /href\s*=\s*["']([^"']*view-serie\.php\?[^"']+)["']/i.exec(html);
    var serieUrl = link ? absoluteUrl(link[1], BASE_URL) : '';
    if (!serieUrl) return fromWatchPage();
    return siteGet(serieUrl, watchUrl).then(function (serieHtml) {
      var parsed = parseSeasons(serieHtml);
      return parsed.sections.length ? parsed : fromWatchPage();
    }, fromWatchPage);
  });
}

function pickFromSections(parsed, season, episode, entrySeason) {
  if (!parsed || parsed.ambiguous) return null;
  var section = null;
  parsed.sections.forEach(function (s) { if (s.season === season) section = s; });
  if (!section && parsed.sections.length === 1 && (season === 1 || entrySeason === season)) {
    section = parsed.sections[0];
  }
  if (!section) return null;
  for (var i = 0; i < section.episodes.length; i++) {
    if (section.episodes[i].episode === episode) return section.episodes[i];
  }
  return null;
}

function resolveEpisodeVids(matched, season, episode) {
  var direct = matched.filter(function (e) {
    return e.info.episode === episode && (e.entrySeason === season || (e.entrySeason === null && season === 1));
  });
  if (direct.length === 1) return Promise.resolve([direct[0].vid]);

  var rep = matched[0];
  matched.forEach(function (e) { if (rep.entrySeason !== season && e.entrySeason === season) rep = e; });

  return fetchSeriesSections(rep.vid).then(function (parsed) {
    var hit = pickFromSections(parsed, season, episode, rep.entrySeason);
    if (hit) return [hit.vid];
    if (parsed.ambiguous) log('season layout not understood on the series page');
    return direct.map(function (e) { return e.vid; });
  }).catch(function (err) {
    log('series page failed: ' + (err && err.message));
    return direct.map(function (e) { return e.vid; });
  });
}

function getSeriesStreams(meta, season, episode, title) {
  return findSeriesEntries(meta, season).then(function (matched) {
    log('series entries matched: ' + matched.length);
    if (!matched.length) return [];
    return resolveEpisodeVids(matched, season, episode).then(function (vids) {
      var list = vids.slice(0, MAX_EPISODE_CANDIDATES);
      var i = 0;
      function next() {
        if (i >= list.length) return Promise.resolve([]);
        var vid = list[i++];
        return getServerStreams(vid, title).catch(function (err) {
          log('servers failed for ' + vid + ': ' + (err && err.message));
          return [];
        }).then(function (streams) {
          return streams.length ? streams : next();
        });
      }
      return next();
    });
  });
}

// ──────────────────────── Servers (embed extraction) ──────────────────

function fetchEmbedUrls(vid) {
  return siteGet(BASE_URL + '/watch.php?vid=' + vid, BASE_URL + '/').then(function (html) {
    var urls = [];
    var seen = {};
    function collect(re) {
      var m;
      while ((m = re.exec(html)) !== null) {
        var url = absoluteUrl(m[1], BASE_URL);
        if (!url || seen[url] || hostOf(url) === hostOf(BASE_URL)) continue;
        seen[url] = true;
        urls.push(url);
      }
    }
    collect(/<iframe\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi);
    collect(/data-embed-url\s*=\s*["']([^"']+)["']/gi);
    collect(/embed_url:\s*["']([^"']+)["']/gi);
    collect(/contentUrl["'][^>]*content=["']([^"']+)["']/gi);
    return urls;
  });
}

function serverLabel(host) {
  if (/(^|\.)vk\.com$|vkvideo\.ru$/.test(host)) return 'VK';
  if (/(^|\.)ok\.ru$/.test(host)) return 'OK.ru';
  if (/uqload/.test(host)) return 'Uqload';
  if (/vidmoly/.test(host)) return 'Vidmoly';
  if (/1vid/.test(host)) return '1vid';
  if (/mixdrop|mxdrop/.test(host)) return 'Mixdrop';
  if (/vidspeed/.test(host)) return 'Vidspeed';
  if (/hgcloud/.test(host)) return 'HGCloud';
  if (/vidhide/.test(host)) return 'VidHide';
  return host.split('.').slice(-2, -1)[0] || host;
}

// ───────────────────────────── Extractors ─────────────────────────────

var QUALITY_RANK_AUTO = 1080;

function qualityFromUrl(url) {
  var m = /(\d{3,4})p\b/i.exec(url);
  return m ? m[1] + 'p' : null;
}

function cleanMediaUrl(url) {
  return String(url)
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
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
      var radix = parseInt(m[2], 10);
      var words = m[4].split('|');
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
  var found = [];
  var seen = {};
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
  return fetchText(embedUrl, { 'User-Agent': UA_EMBED, 'Referer': BASE_URL + '/', 'Accept-Language': 'ar,en;q=0.9' }, EMBED_TIMEOUT)
    .then(function (html) {
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
  return fetchText(embedUrl, { 'User-Agent': UA_EMBED, 'Referer': BASE_URL + '/', 'Accept-Language': 'ar,en;q=0.9' }, EMBED_TIMEOUT)
    .then(function (html) {
      var headers = { 'User-Agent': UA_EMBED, 'Referer': 'https://vk.com/' };
      var out = [];
      var re = /"url(\d{3,4})"\s*:\s*"(https?:[^"]+)"/g;
      var m;
      while ((m = re.exec(html)) !== null) {
        out.push({ url: cleanMediaUrl(m[2]), quality: m[1] + 'p', headers: headers });
      }
      if (!out.length) {
        var hls = /"hls"\s*:\s*"(https?:[^"]+)"/.exec(html);
        if (hls) out.push({ url: cleanMediaUrl(hls[1]), quality: 'Auto', headers: headers });
      }
      return out;
    });
}

var OK_QUALITY = { mobile: '144p', lowest: '240p', low: '360p', sd: '480p', hd: '720p', full: '1080p', quad: '1440p', ultra: '2160p' };

function extractOk(embedUrl) {
  return fetchText(embedUrl, { 'User-Agent': UA_EMBED, 'Referer': BASE_URL + '/', 'Accept-Language': 'ar,en;q=0.9' }, EMBED_TIMEOUT)
    .then(function (html) {
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

function resolveEmbed(embedUrl) {
  var host = hostOf(embedUrl);
  var job;
  if (/(^|\.)vk\.com$|(^|\.)vkvideo\.ru$/.test(host)) job = extractVk(embedUrl);
  else if (/(^|\.)ok\.ru$/.test(host)) job = extractOk(embedUrl);
  else job = extractGeneric(embedUrl);
  return job.then(function (items) {
    var label = serverLabel(host);
    return items.map(function (it) { it.server = label; return it; });
  }).catch(function (err) {
    log(serverLabel(host) + ' failed: ' + (err && err.message));
    return [];
  });
}

// ─────────────────────────── Stream assembly ──────────────────────────

function qualityRank(q) {
  if (q === 'Auto') return QUALITY_RANK_AUTO;
  var n = parseInt(q, 10);
  return isNaN(n) ? 0 : n;
}

function getServerStreams(vid, title) {
  return fetchEmbedUrls(vid).then(function (embedUrls) {
    log('servers for ' + vid + ': ' + embedUrls.length);
    return Promise.all(embedUrls.map(resolveEmbed));
  }).then(function (groups) {
    var streams = [];
    var seen = {};
    groups.forEach(function (items) {
      items.forEach(function (it) {
        if (seen[it.url]) return;
        seen[it.url] = true;
        streams.push({
          name: PROVIDER_NAME + ' ' + it.server + (it.quality !== 'Unknown' ? ' ' + it.quality : ''),
          title: title,
          url: it.url,
          quality: it.quality,
          size: 'Unknown',
          headers: it.headers,
          provider: PROVIDER_ID
        });
      });
    });
    streams.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return streams;
  });
}

// ───────────────────────────── Entry point ────────────────────────────

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;

  if (!TMDB_API_KEY || TMDB_API_KEY === 'YOUR_TMDB_API_KEY') {
    log('TMDB_API_KEY is not set');
    return Promise.resolve([]);
  }

  return fetchTmdb(tmdbId, type).then(function (data) {
    var meta = buildMeta(data, type);
    if (!meta.processable) {
      log('skipped (content filter=' + CONTENT_LANG + '): ' + meta.displayTitle + ' [' + (meta.arabic ? 'ar' : 'en') + ']');
      return [];
    }
    if (!meta.targets.length) {
      log('no usable title for TMDB ' + tmdbId);
      return [];
    }
    var title = type === 'tv'
      ? meta.displayTitle + ' S' + pad2(season) + 'E' + pad2(episode)
      : meta.displayTitle + (meta.year ? ' (' + meta.year + ')' : '');
    log(type + ' "' + meta.displayTitle + '" lang=' + (meta.arabic ? 'ar' : 'en') + ' queries=' + JSON.stringify(meta.queries));
    return type === 'tv' ? getSeriesStreams(meta, season, episode, title) : getMovieStreams(meta, title);
  }).catch(function (err) {
    log('error: ' + (err && err.message));
    return [];
  });
}

module.exports = { getStreams: getStreams };
