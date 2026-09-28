var BASE = "https://akwam.ss";
var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";

function fetchText(url, referer) {
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };

  if (referer)
    headers["Referer"] = referer;

  return fetch(url, {
    headers: headers,
    redirect: "follow"
  }).then(function(r) {
    if (!r.ok)
      throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(str) {
  return decodeHtml(String(str || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  a = normalizeTitle(a);
  b = normalizeTitle(b);

  if (!a || !b)
    return 0;

  if (a === b)
    return 1;

  if (a.includes(b) || b.includes(a))
    return 0.85;

  var aa = new Set(a.split(" "));
  var bb = new Set(b.split(" "));
  var common = 0;

  aa.forEach(function(x) {
    if (bb.has(x))
      common++;
  });

  return common / Math.max(aa.size, bb.size);
}

function getSearchTitle(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var url =
    "https://www.themoviedb.org/" +
    type +
    "/" +
    encodeURIComponent(tmdbId);

  return fetchText(url).then(function(html) {
    if (!html)
      throw new Error("TMDB page returned empty response");

    var title = null;
    var m = html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i
    );

    if (m)
      title = decodeHtml(m[1]);

    if (!title) {
      m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (m)
        title = decodeHtml(m[1]);
    }

    if (!title)
      throw new Error("Could not extract TMDB title");

    title = title
      .replace(/\s*\|\s*TMDB\s*$/i, "")
      .replace(/\s*-\s*The Movie Database\s*$/i, "")
      .trim();

    console.log("[Akwam] TMDB title:", title);

    return {
      title: title
    };
  });
}

function extractSearchResults(html) {
  var results = [];
  var seen = new Set();

  var re =
    /<a\b[^>]*href=["']([^"']*\/(?:movie|series)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  var m;

  while ((m = re.exec(html)) !== null) {
    var url = decodeHtml(m[1]);
    var block = m[2];

    if (seen.has(url))
      continue;

    var title = "";

    var titleMatch =
      block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
      block.match(
        /class=["'][^"']*(?:entry-title|title|text-white)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
      );

    if (titleMatch)
      title = stripHtml(titleMatch[1]);

    if (!title || title === "-->" || title.length < 2) {
      var pathMatch = url.match(
        /\/(?:movie|series)\/[^\/]+\/([^?#"']+)/i
      );

      if (pathMatch) {
        try {
          title = decodeURIComponent(pathMatch[1]);
        } catch (e) {
          title = pathMatch[1];
        }

        title = title
          .replace(/[-_]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }

    if (!title || title === "-->" || title.length < 2)
      continue;

    var absolute = url.startsWith("http")
      ? url
      : BASE + url;

    seen.add(url);

    results.push({
      url: absolute,
      title: title
    });
  }

  return results;
}

function searchAkwam(title) {
  var url =
    BASE +
    "/search?q=" +
    encodeURIComponent(title);

  console.log("[Akwam] Search:", url);

  return fetchText(url, BASE).then(function(html) {
    var results = extractSearchResults(html);

    console.log("[Akwam] Search results:", results.length);

    return results;
  });
}

function chooseResult(results, wantedTitle) {
  if (!results || !results.length)
    return null;

  var best = null;
  var bestScore = 0;

  results.forEach(function(result) {
    var score = similarity(result.title, wantedTitle);

    console.log(
      "[Akwam] Candidate:",
      result.title,
      "score:",
      score.toFixed(3)
    );

    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  });

  if (best && bestScore >= 0.35) {
    console.log(
      "[Akwam] Selected:",
      best.title,
      best.url,
      "score:",
      bestScore.toFixed(3)
    );

    return best;
  }

  console.log("[Akwam] No suitable result");

  return null;
}

function extractWatchUrls(html) {
  var urls = [];
  var seen = new Set();

  var re =
    /href=["']([^"']*\/watch\/[^"']+)["']/gi;

  var m;

  while ((m = re.exec(html)) !== null) {
    var url = decodeHtml(m[1]);

    var absolute = url.startsWith("http")
      ? url
      : BASE + url;

    if (!seen.has(absolute)) {
      seen.add(absolute);
      urls.push(absolute);
    }
  }

  return urls;
}

function extractSources(html) {
  var streams = [];
  var seen = new Set();

  var re = /<source\b[^>]*>/gi;
  var tag;

  while ((tag = re.exec(html)) !== null) {
    var source = tag[0];

    var srcMatch =
      source.match(/\bsrc=["']([^"']+)["']/i);

    if (!srcMatch)
      continue;

    var url = decodeHtml(srcMatch[1]).trim();

    if (!url)
      continue;

    if (url.startsWith("//")) {
      url = "https:" + url;
    } else if (url.startsWith("/")) {
      url = BASE + url;
    }

    if (seen.has(url))
      continue;

    seen.add(url);

    var qualityMatch =
      source.match(/\bsize=["']([^"']+)["']/i) ||
      source.match(/\blabel=["']([^"']+)["']/i);

    var quality =
      qualityMatch
        ? qualityMatch[1]
        : "Unknown";

    streams.push({
      name: "Akwam",
      title:
        quality === "Unknown"
          ? "Akwam"
          : "Akwam " + quality,
      url: url,
      quality: quality
    });
  }

  return streams;
}

function getMovieStreams(tmdbId) {
  return getSearchTitle(tmdbId, "movie")
    .then(function(meta) {
      return searchAkwam(meta.title)
        .then(function(results) {
          var result =
            chooseResult(results, meta.title);

          if (!result)
            return [];

          return fetchText(result.url, BASE)
            .then(function(html) {
              var watchUrls =
                extractWatchUrls(html);

              console.log(
                "[Akwam] Watch pages:",
                watchUrls.length
              );

              return Promise.all(
                watchUrls.map(function(watchUrl) {
                  return fetchText(
                    watchUrl,
                    result.url
                  )
                    .then(function(watchHtml) {
                      return extractSources(
                        watchHtml
                      );
                    })
                    .catch(function() {
                      return [];
                    });
                })
              ).then(function(groups) {
                return groups.flat();
              });
            });
        });
    })
    .catch(function(err) {
      console.error(
        "[Akwam] Movie error:",
        err.message
      );

      return [];
    });
}

function getTvStreams(tmdbId, season, episode) {
  return getSearchTitle(tmdbId, "tv")
    .then(function(meta) {
      return searchAkwam(meta.title)
        .then(function(results) {
          var result =
            chooseResult(results, meta.title);

          if (!result)
            return [];

          return fetchText(result.url, BASE)
            .then(function(html) {
              var episodeLinks = [];
              var seen = new Set();

              var re =
                /href=["']([^"']*\/episode\/[^"']+)["']/gi;

              var m;

              while ((m = re.exec(html)) !== null) {
                var url = decodeHtml(m[1]);

                var absolute =
                  url.startsWith("http")
                    ? url
                    : BASE + url;

                if (!seen.has(absolute)) {
                  seen.add(absolute);
                  episodeLinks.push(absolute);
                }
              }

              var wanted =
                Number(episode);

              var selected =
                episodeLinks.filter(function(url) {
                  var match =
                    url.match(
                      /episode[^0-9]*([0-9]+)/i
                    );

                  return (
                    match &&
                    Number(match[1]) === wanted
                  );
                });

              return Promise.all(
                selected.map(function(url) {
                  return fetchText(
                    url,
                    result.url
                  )
                    .then(function(epHtml) {
                      var watchUrls =
                        extractWatchUrls(epHtml);

                      return Promise.all(
                        watchUrls.map(function(watchUrl) {
                          return fetchText(
                            watchUrl,
                            url
                          )
                            .then(function(watchHtml) {
                              return extractSources(
                                watchHtml
                              );
                            })
                            .catch(function() {
                              return [];
                            });
                        })
                      );
                    })
                    .then(function(groups) {
                      return groups.flat();
                    })
                    .catch(function() {
                      return [];
                    });
                })
              ).then(function(groups) {
                return groups.flat();
              });
            });
        });
    })
    .catch(function(err) {
      console.error(
        "[Akwam] TV error:",
        err.message
      );

      return [];
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(
    "[Akwam] getStreams:",
    tmdbId,
    mediaType,
    season,
    episode
  );

  if (mediaType === "tv") {
    return getTvStreams(
      tmdbId,
      season,
      episode
    );
  }

  return getMovieStreams(tmdbId);
}

module.exports = {
  getStreams: getStreams
};
