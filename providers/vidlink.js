var PROVIDER_ID = "vidlink";
var PROVIDER_NAME = "VidLink";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
var TMDB_API_KEY = "83d364331c40bfbe29858aeed82f45cc";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_API = "https://vidlink.pro/api/b";
var VIDLINK_BASE = "https://vidlink.pro";

// Sent on the VidLink API call. Without it the API returns bcdn MP4s that answer 429 to non-browser clients.
var PLAYBACK_ENV = "webkit";

var FETCH_TIMEOUT_MS = 12000;

function log(m) { console.log("[VidLink] " + m); }

// ---------------------------------------------------------------- http
function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== "function") return promise;
  return new Promise(function(resolve, reject) {
    var done = false;
    var t = setTimeout(function() {
      if (!done) { done = true; reject(new Error((label || "request") + " timeout")); }
    }, ms);
    promise.then(function(v) {
      if (!done) { done = true; clearTimeout(t); resolve(v); }
    }, function(e) {
      if (!done) { done = true; clearTimeout(t); reject(e); }
    });
  });
}

function fetchText(url, headers, timeoutMs) {
  headers = headers || {};
  return withTimeout(
    fetch(url, { method: "GET", headers: headers, redirect: "follow" }).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }),
    timeoutMs || FETCH_TIMEOUT_MS,
    url.split("?")[0]
  );
}

function fetchJson(url, headers, timeoutMs) {
  return fetchText(url, headers, timeoutMs).then(function(t) {
    try { return JSON.parse(t); } catch (e) { throw new Error("invalid JSON"); }
  });
}

// ---------------------------------------------------------------- TMDB
function fetchTmdb(tmdbId, type) {
  var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
    "?api_key=" + TMDB_API_KEY + "&language=en";
  return fetchJson(url, { "Accept": "application/json" });
}

// ---------------------------------------------------------------- encryption
function encodeTmdbId(tmdbId) {
  var url = ENC_API + "?text=" + encodeURIComponent(String(tmdbId));
  log("Encoding TMDB ID: " + tmdbId);
  return fetchJson(url, { "Accept": "application/json" }).then(function(data) {
    var result = data && (data.result || data.encoded || data.data);
    if (!result) throw new Error("enc-vidlink returned no result");
    log("Encoded: " + String(result).slice(0, 20) + "...");
    return result;
  });
}

// ---------------------------------------------------------------- quality helpers
function qualityToNumber(q) {
  if (!q) return 0;
  var s = String(q).toLowerCase();
  if (s === "4k" || s === "2160") return 2160;
  if (s === "auto" || s === "unknown") return 0;
  var n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function qualityLabel(q) {
  if (!q) return "Auto";
  var s = String(q).toLowerCase();
  if (s === "4k" || s === "2160") return "4K";
  if (s === "auto" || s === "unknown") return "Auto";
  var n = parseInt(s, 10);
  return isNaN(n) ? String(q) : n + "p";
}

// Stream type: trust the response's own "type" first. VidLink proxy URLs often
// end in "-m3u8" or have no extension at all, so only ".mp4" / ".mpd" are special-cased.
function detectType(declared, url) {
  var d = String(declared || "").toLowerCase();
  if (d.indexOf("dash") !== -1 || d.indexOf("mpd") !== -1) return "dash";
  if (d.indexOf("hls") !== -1 || d.indexOf("m3u8") !== -1) return "hls";
  if (d.indexOf("mp4") !== -1) return "mp4";
  if (/\.mpd(\?|#|$)/i.test(url)) return "dash";
  if (/\.mp4(\?|#|$)/i.test(url)) return "mp4";
  return "hls";
}

// ---------------------------------------------------------------- stream builder
// embedPageUrl is used as Referer/Origin so the CDN accepts segment requests.
// signedHeaders (stream.playlistHeaders, e.g. a CloudFront Cookie) are sent as-is, with only a User-Agent.
function buildStreams(qualities, displayTitle, embedPageUrl, signedHeaders) {
  var streams = [];
  var browserHeaders = {
    "User-Agent": UA,
    "Referer": embedPageUrl,
    "Origin": VIDLINK_BASE,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin"
  };

  var streamHeaders = browserHeaders;
  if (signedHeaders && typeof signedHeaders === "object" && Object.keys(signedHeaders).length) {
    streamHeaders = { "User-Agent": UA };
    Object.keys(signedHeaders).forEach(function(k) { streamHeaders[k] = signedHeaders[k]; });
  }

  Object.keys(qualities || {}).forEach(function(key) {
    var entry = qualities[key];
    if (!entry) return;
    var url = entry.url || entry.playlist || entry.file || entry.src;
    if (!url || url.indexOf("http") !== 0) return;

    var kind = detectType(entry.type, url);
    var qLabel = qualityLabel(key);
    log("  quality " + qLabel + " [" + kind + "] -> " + url.slice(0, 100) + "...");

    streams.push({
      name: PROVIDER_NAME + " " + qLabel,
      title: displayTitle + " • " + qLabel,
      url: url,
      quality: qLabel,
      size: "Unknown",
      type: kind,
      headers: streamHeaders,
      provider: PROVIDER_ID
    });
  });

  streams.sort(function(a, b) {
    return qualityToNumber(b.quality) - qualityToNumber(a.quality);
  });
  return streams;
}

// ---------------------------------------------------------------- manifest expansion (one link per quality)
function absUrl(base, rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  var clean = base.split("#")[0].split("?")[0];
  var m = /^(https?:\/\/[^\/]+)(\/.*)?$/i.exec(clean);
  if (!m) return rel;
  var origin = m[1];
  if (rel.charAt(0) === "/") return origin + rel;
  var parts = (m[2] || "/").split("/");
  parts.pop();
  rel.split("/").forEach(function(seg) {
    if (seg === "..") { if (parts.length > 1) parts.pop(); }
    else if (seg !== ".") parts.push(seg);
  });
  return origin + parts.join("/");
}

// HLS master -> [{height, bandwidth, url}] (skipped when audio is a separate rendition)
function expandHls(masterUrl, text) {
  if (/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/i.test(text)) return [];
  var lines = text.split(/\r?\n/);
  var byHeight = {};
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (l.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
    var res = /RESOLUTION=(\d+)x(\d+)/i.exec(l);
    var bw = /BANDWIDTH=(\d+)/i.exec(l);
    var uri = null;
    for (var j = i + 1; j < lines.length; j++) {
      var n = lines[j].trim();
      if (n && n.charAt(0) !== "#") { uri = n; break; }
    }
    if (!uri) continue;
    var h = res ? parseInt(res[2], 10) : 0;
    var b = bw ? parseInt(bw[1], 10) : 0;
    var key = h || ("bw" + b);
    if (!byHeight[key] || b > byHeight[key].bandwidth) {
      byHeight[key] = { height: h, bandwidth: b, url: absUrl(masterUrl, uri) };
    }
  }
  return Object.keys(byHeight).map(function(k) { return byHeight[k]; });
}

var REP_RE = /<Representation\b[^>]*?(?:\/>|>[\s\S]*?<\/Representation>)/g;

// Make segment paths absolute so the MPD still resolves when served as a data: URL.
function absolutizeMpd(mpd, mpdUrl) {
  var had = false;
  mpd = mpd.replace(/<BaseURL>([^<]*)<\/BaseURL>/g, function(m, u) {
    had = true;
    return "<BaseURL>" + absUrl(mpdUrl, u.trim()) + "</BaseURL>";
  });
  if (!had) {
    var dir = absUrl(mpdUrl, "./");
    mpd = mpd.replace(/(<MPD\b[^>]*>)/, function(m) { return m + "<BaseURL>" + dir + "</BaseURL>"; });
  }
  return mpd;
}

// Drop every video Representation except the requested height.
function filterMpd(mpd, keep) {
  return mpd.replace(REP_RE, function(block) {
    var open = /^<Representation\b[^>]*>/.exec(block);
    var h = open && /\sheight=["'](\d+)["']/.exec(open[0]);
    return (h && parseInt(h[1], 10) !== keep) ? "" : block;
  });
}

// DASH MPD -> [{height, bandwidth, url}] where url is a single-quality MPD (data: URL)
function expandDash(mpdUrl, mpd) {
  var heights = {};
  var tagRe = /<Representation\b[^>]*>/g;
  var m;
  while ((m = tagRe.exec(mpd))) {
    var h = /\sheight=["'](\d+)["']/.exec(m[0]);
    if (h) heights[h[1]] = true;
  }
  var list = Object.keys(heights).map(Number).sort(function(a, b) { return b - a; });
  if (list.length < 2) return [];
  var base = absolutizeMpd(mpd, mpdUrl);
  return list.map(function(h) {
    return {
      height: h,
      bandwidth: 0,
      url: "data:application/dash+xml;charset=utf-8," + encodeURIComponent(filterMpd(base, h))
    };
  });
}

// Auto link first (the proven one), then one link per quality found in the manifest.
function buildPlaylistStreams(stream, displayTitle, embedPageUrl) {
  var base = buildStreams(
    { "auto": { url: stream.playlist, type: stream.type } },
    displayTitle, embedPageUrl, stream.playlistHeaders
  );
  if (!base.length) return Promise.resolve(base);
  var auto = base[0];

  if (auto.type !== "dash" && auto.type !== "hls") return Promise.resolve(base);

  return fetchText(auto.url, auto.headers).then(function(text) {
    var variants = auto.type === "dash" ? expandDash(auto.url, text) : expandHls(auto.url, text);
    log("Manifest variants: " + variants.length);
    if (!variants.length) return [auto];

    variants.sort(function(a, b) {
      return (b.height - a.height) || (b.bandwidth - a.bandwidth);
    });

    var extra = variants.map(function(v) {
      var label = v.height ? qualityLabel(v.height) : (Math.round(v.bandwidth / 1000) + "kbps");
      return {
        name: PROVIDER_NAME + " " + label,
        title: displayTitle + " • " + label,
        url: v.url,
        quality: label,
        size: "Unknown",
        type: auto.type,
        headers: auto.headers,
        provider: PROVIDER_ID
      };
    });
    return [auto].concat(extra);
  }).catch(function(e) {
    log("Manifest expand failed: " + (e && e.message));
    return [auto];
  });
}

// ---------------------------------------------------------------- core
function getStreamsFor(tmdbId, mediaType, season, episode) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var displayTitle;
  var embedPageUrl;

  // Build the embed page URL — this is what VidLink's own player uses
  if (type === "movie") {
    embedPageUrl = VIDLINK_BASE + "/movie/" + tmdbId;
  } else {
    embedPageUrl = VIDLINK_BASE + "/tv/" + tmdbId + "/" + season + "/" + episode;
  }

  return fetchTmdb(tmdbId, type).then(function(data) {
    var title = type === "movie" ? (data.title || data.original_title) : (data.name || data.original_name);
    var year = type === "movie" ? (data.release_date || "") : (data.first_air_date || "");
    if (type === "movie") {
      displayTitle = title + (year ? " (" + year.slice(0, 4) + ")" : "");
    } else {
      var p2 = function(n) { return n < 10 ? "0" + n : String(n); };
      displayTitle = title + " S" + p2(season) + "E" + p2(episode);
    }
    log(type + ' "' + title + '" — Referer will be: ' + embedPageUrl);
  }).catch(function() {
    displayTitle = type === "movie" ? ("TMDB " + tmdbId) : ("TMDB " + tmdbId + " S" + season + "E" + episode);
  }).then(function() {
    return encodeTmdbId(tmdbId);
  }).then(function(encodedId) {
    var url;
    if (type === "movie") {
      url = VIDLINK_API + "/movie/" + encodeURIComponent(encodedId) + "?multiLang=0";
    } else {
      url = VIDLINK_API + "/tv/" + encodeURIComponent(encodedId) + "/" +
        encodeURIComponent(season) + "/" + encodeURIComponent(episode) + "?multiLang=0";
    }
    log("API: " + url.split("?")[0]);

    return fetchJson(url, {
      "User-Agent": UA,
      "Referer": embedPageUrl,
      "Origin": VIDLINK_BASE,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "x-playback-environment": PLAYBACK_ENV
    }).then(function(data) {
      var stream = data && data.stream;
      if (!stream) {
        log("No stream object in response");
        return [];
      }
      log("deliveryType: " + stream.deliveryType);
      var qualities = stream.qualities;
      if (!qualities) {
        if (stream.playlist) {
          log("Playlist format detected (type: " + stream.type + ")");
          return buildPlaylistStreams(stream, displayTitle, embedPageUrl).then(function(streams) {
            log("Returned " + streams.length + " stream(s)");
            return streams;
          });
        }
        log("No qualities in stream");
        return [];
      }
      var streams = buildStreams(qualities, displayTitle, embedPageUrl);
      log("Returned " + streams.length + " stream(s)");
      return streams;
    });
  });
}

// ---------------------------------------------------------------- entry point
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;
  log("getStreams: " + tmdbId + " " + type + " S" + season + "E" + episode);

  return getStreamsFor(tmdbId, type, season, episode).catch(function(err) {
    log("error: " + (err && err.message));
    return [];
  });
}

module.exports = { getStreams: getStreams };
