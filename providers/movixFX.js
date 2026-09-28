/**
 * movix - Built from src/movix/
 * Generated: 2026-09-21T03:53:21.312Z
 */

// src/movix/index.js
var TMDB_KEY = "f3d757824f08ea2cff45eb8f47ca3a1e";
var DOMAINS_URL = "https://raw.githubusercontent.com/wooodyhood/nuvio-repo/main/domains.json";
var MOVIX_FALLBACK = "cash";
var _cachedEndpoint = null;
function detectApi() {
  if (_cachedEndpoint)
    return Promise.resolve(_cachedEndpoint);
  return fetch(DOMAINS_URL).then((res) => res.ok ? res.json() : Promise.reject()).then((data) => {
    const tld = data && data.movix ? data.movix : MOVIX_FALLBACK;
    _cachedEndpoint = {
      api: `https://api.movix.${tld}`,
      referer: `https://movix.${tld}/`
    };
    return _cachedEndpoint;
  }).catch(() => {
    _cachedEndpoint = {
      api: `https://api.movix.${MOVIX_FALLBACK}`,
      referer: `https://movix.${MOVIX_FALLBACK}/`
    };
    return _cachedEndpoint;
  });
}
function getTmdbMetadata(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_KEY}&language=fr-FR`;
  return fetch(url).then((res) => res.json()).then((data) => {
    const releaseDate = data.release_date || data.first_air_date || "";
    return {
      name: data.title || data.name || "Film",
      year: releaseDate ? releaseDate.split("-")[0] : "",
      duration: mediaType === "movie" && data.runtime ? `${data.runtime} min` : mediaType === "tv" && data.episode_run_time && data.episode_run_time.length > 0 ? `${data.episode_run_time[0]} min` : ""
    };
  }).catch(() => ({ name: "Film", year: "", duration: "" }));
}
function getEpisodeInfo(tmdbId, season, episode) {
  if (!tmdbId || !season || !episode)
    return Promise.resolve(null);
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?api_key=${TMDB_KEY}&language=fr-FR`;
  return fetch(url).then((res) => res.json()).then((data) => ({
    name: data.name || null,
    duration: data.runtime ? `${data.runtime} min` : null
  })).catch(() => null);
}
function buildTitle(meta, quality, audioType, format, p5, p6, season, episode, epInfo) {
  const cleanQuality = quality.toLowerCase().replace(/p/g, "") + "p";
  const icon = "\u26A1";
  let langLabel = "VF";
  let flag = "\u{1F3B5} \u{1F1EB}\u{1F1F7}";
  const searchContext = (String(audioType) + " " + String(quality) + " " + String(p6)).toUpperCase();
  if (searchContext.indexOf("MULTI") !== -1 || searchContext.indexOf("DUAL") !== -1) {
    langLabel = "Dual-Audio";
    flag = "\u{1F3B5} \u{1F1FA}\u{1F1F8} \u2022 \u{1F1EB}\u{1F1F7}";
  } else if (searchContext.indexOf("VOST") !== -1) {
    langLabel = "VOSTFR";
    flag = "\u{1F3B5} \u{1F1FA}\u{1F1F8} \u2022 \u{1F1EB}\u{1F1F7}";
  }
  let line1 = "\u{1F37F} ";
  if (season && episode) {
    line1 += "S" + season + " E" + episode + (epInfo && epInfo.name ? " - " + epInfo.name : "") + " | " + meta.name;
  } else {
    line1 += meta.name + (meta.year ? " - " + meta.year : "");
  }
  const line2 = icon + " " + cleanQuality + " | \u{1F4AC} " + langLabel + " | " + flag;
  const cleanFormat = (format || "M3U8").toUpperCase();
  let codec = "H.264";
  if (searchContext.indexOf("HEVC") !== -1 || searchContext.indexOf("X265") !== -1 || searchContext.indexOf("H265") !== -1) {
    codec = "H.265";
  }
  const duration = epInfo && epInfo.duration ? epInfo.duration : meta.duration;
  const durStr = duration ? " | " + duration : "";
  const line3 = "\u{1F4BF} " + cleanFormat + " \u2022 " + codec + " | \u{1F3A7} AAC" + durStr;
  return line1 + "\n" + line2 + "\n" + line3;
}
function resolveRedirect(url, referer) {
  return fetch(url, {
    method: "HEAD",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": referer
    }
  }).then((res) => res.url || url).catch(() => url);
}
function resolveEmbed(url, referer) {
  return fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": referer
    }
  }).then((res) => res.text()).then((html) => {
    const patterns = [
      /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
      /source\s+src=["']([^"']+\.m3u8[^"']*)["']/i,
      /["']([^"']*\.m3u8(?:\?[^"']*)?)["']/i
    ];
    for (let i = 0; i < patterns.length; i++) {
      const m = html.match(patterns[i]);
      if (m)
        return m[1].startsWith("//") ? "https:" + m[1] : m[1];
    }
    return null;
  }).catch(() => null);
}
function fetchPurstream(api, referer, tmdbId, mediaType, season, episode) {
  const url = mediaType === "tv" ? `${api}/api/purstream/tv/${tmdbId}/stream?season=${season || 1}&episode=${episode || 1}` : `${api}/api/purstream/movie/${tmdbId}/stream`;
  return fetch(url, { headers: { Referer: referer } }).then((res) => res.json()).then((data) => data.sources || []);
}
function fetchCpasmal(api, referer, tmdbId, mediaType, season, episode) {
  const url = mediaType === "tv" ? `${api}/api/cpasmal/tv/${tmdbId}/${season || 1}/${episode || 1}` : `${api}/api/cpasmal/movie/${tmdbId}`;
  return fetch(url, { headers: { Referer: referer } }).then((res) => res.json()).then((data) => {
    const list = [];
    ["vf", "vostfr"].forEach((lang) => {
      if (data.links && data.links[lang]) {
        data.links[lang].forEach((item) => {
          list.push({
            url: item.url,
            name: "Film",
            player: item.server,
            lang
          });
        });
      }
    });
    return list;
  });
}
function tryFetchAll(api, referer, tmdbId, mediaType, season, episode, meta, epInfo) {
  return fetchPurstream(api, referer, tmdbId, mediaType, season, episode).then((items) => {
    return Promise.all(items.map((item) => {
      return resolveRedirect(item.url, referer).then((redirectUrl) => {
        const quality = (item.name || "").indexOf("1080") !== -1 ? "1080p" : "720p";
        const audioType = (item.name || "").indexOf("VOST") !== -1 ? "VOSTFR" : (item.name || "").indexOf("VF") !== -1 ? "VF" : "Dual-Audio";
        const titleStr = buildTitle(meta, quality, audioType, item.format || "m3u8", null, null, season, episode, epInfo);
        return {
          name: "Movix | " + quality.toLowerCase() + " | " + audioType,
          title: titleStr,
          size: titleStr,
          description: titleStr,
          url: redirectUrl,
          quality: "",
          language: "",
          format: item.format || "m3u8",
          headers: { "User-Agent": "Mozilla/5.0" }
        };
      });
    }));
  }).catch(() => {
    return fetchCpasmal(api, referer, tmdbId, mediaType, season, episode).then((list) => {
      return Promise.all(list.slice(0, 5).map((item) => {
        return resolveEmbed(item.url, referer).then((embedUrl) => {
          if (!embedUrl)
            return null;
          const audioType = item.lang && item.lang.toUpperCase() === "VOSTFR" ? "VOSTFR" : "VF";
          const titleStr = buildTitle(meta, "HD", audioType, "m3u8", "", item.player, season, episode, epInfo);
          return {
            name: "Movix | hd | " + audioType,
            title: titleStr,
            size: titleStr,
            description: titleStr,
            url: embedUrl,
            quality: "",
            language: "",
            format: "m3u8",
            headers: { Referer: referer }
          };
        });
      })).then((results) => results.filter((item) => item !== null));
    });
  });
}
function getStreams(tmdbId, mediaType, season, episode) {
  return Promise.all([
    getTmdbMetadata(tmdbId, mediaType),
    mediaType === "tv" ? getEpisodeInfo(tmdbId, season, episode) : Promise.resolve(null),
    detectApi()
  ]).then((res) => {
    const meta = res[0];
    const epInfo = res[1];
    const endpoint = res[2];
    return tryFetchAll(endpoint.api, endpoint.referer, tmdbId, mediaType, season, episode, meta, epInfo);
  }).catch(() => []);
}
module.exports = { getStreams };
