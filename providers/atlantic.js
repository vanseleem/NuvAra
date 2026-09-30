var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => { try { step(generator.next(value)); } catch (e) { reject(e); } };
    var rejected = (value) => { try { step(generator.throw(value)); } catch (e) { reject(e); } };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// ---- Settings (edit here) ----
const API_BASE = "https://cdn.hls.lol";
const SITE = "https://atlantic.st";
const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
const SERVER_LABEL = "Aphrodite";
const CACHE_TTL_MS = 3 * 60 * 1000;   // successful responses are reused for 3 minutes
const FAIL_TTL_MS = 60 * 1000;        // a failed/blocked URL is not requested again for 60 seconds
const MAX_RETRIES = 1;                // one retry, network errors and 5xx only (never 403/429)
const RETRY_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CACHE_ENTRIES = 200;

const cache = new Map();      // url -> { at, value }
const failures = new Map();   // url -> { at, status }
const inflight = new Map();   // url -> Promise (identical simultaneous requests share one call)

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error("timeout after " + ms + "ms")); }, ms);
    promise.then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); }
    );
  });
}

function trimMaps(now) {
  for (const [k, v] of cache) {
    if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  for (const [k, v] of failures) {
    if (now - v.at >= FAIL_TTL_MS) failures.delete(k);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

// Returns { kind: "ok" | "missing" | "fail", value?, status? }
function fetchWithRetry(url) {
  return __async(this, null, function* () {
    let attempt = 0;
    for (;;) {
      let res = null;
      let netError = "";
      try {
        res = yield withTimeout(fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Referer": SITE + "/",
            "Origin": SITE
          },
          redirect: "follow"
        }), REQUEST_TIMEOUT_MS);
      } catch (e) {
        netError = (e && e.message) || "network error";
      }

      if (res) {
        const status = res.status;
        if (status === 403 || status === 429) return { kind: "fail", status: status };  // blocked: never retry
        if (status === 404) return { kind: "missing" };
        if (status < 500) {
          if (!res.ok) return { kind: "fail", status: status };
          try {
            const data = yield res.json();
            return { kind: "ok", value: data };
          } catch (e) {
            return { kind: "fail", status: "BAD_JSON" };
          }
        }
        // 5xx falls through to the retry logic below
      }

      // reached only for network errors and 5xx
      if (attempt < MAX_RETRIES) {
        attempt++;
        console.log("[Atlantic] retry", attempt, res ? "HTTP " + res.status : netError);
        yield sleep(RETRY_DELAY_MS);
        continue;
      }
      return { kind: "fail", status: res ? res.status : "ERR" };
    }
  });
}

function requestJson(url) {
  const now = Date.now();
  trimMaps(now);

  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    console.log("[Atlantic] cache hit");
    return Promise.resolve(hit.value);
  }

  const bad = failures.get(url);
  if (bad && now - bad.at < FAIL_TTL_MS) {
    console.log("[Atlantic] skipped (recent failure:", bad.status + ")");
    return Promise.resolve(null);
  }

  if (inflight.has(url)) {
    console.log("[Atlantic] joining in-flight request");
    return inflight.get(url);
  }

  const p = fetchWithRetry(url).then(
    function (r) {
      inflight.delete(url);
      const t = Date.now();
      if (r.kind === "ok") {
        cache.set(url, { at: t, value: r.value });
        failures.delete(url);
        return r.value;
      }
      if (r.kind === "missing") {
        cache.set(url, { at: t, value: null });
        return null;
      }
      failures.set(url, { at: t, status: r.status });
      console.log("[Atlantic] request failed:", r.status);
      return null;
    },
    function (e) {
      inflight.delete(url);
      failures.set(url, { at: Date.now(), status: "ERR" });
      return null;
    }
  );
  inflight.set(url, p);
  return p;
}

function buildPath(mediaType, tmdbId, season, episode) {
  const id = encodeURIComponent(String(tmdbId));
  if (mediaType === "tv" || mediaType === "series") {
    return "/content/tv/" + id + "/" + (Number(season) || 1) + "/" + (Number(episode) || 1);
  }
  return "/content/movie/" + id;
}

function makeStream(url) {
  return {
    name: "Atlantic",
    title: "Atlantic \u2022 " + SERVER_LABEL + " (HLS)",
    url: url,
    quality: "Auto",
    type: "application/x-mpegURL",
    referer: SITE + "/",
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": SITE + "/",
      "Origin": SITE
    }
  };
}

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    if (!tmdbId) return [];
    if (mediaType !== "movie" && mediaType !== "tv" && mediaType !== "series") return [];

    const path = buildPath(mediaType, tmdbId, season, episode);
    console.log("[Atlantic] Request:", path);

    const data = yield requestJson(API_BASE + path);
    if (!data || !data.found) {
      console.log("[Atlantic] no stream available");
      return [];
    }

    const link = data.hls || (data.type === "hls" ? data.url : "");
    if (!link || !/^https?:\/\//i.test(link)) {
      console.log("[Atlantic] response has no usable hls link");
      return [];
    }

    console.log("[Atlantic] Final streams: 1");
    return [makeStream(link)];
  });
}

module.exports = { getStreams };
EOF

node --check providers/atlantic.js && echo "SYNTAX OK"

echo "========== HERMES CHECK =========="
grep -nE "AbortSignal|new URL|Buffer|async function|await |node-fetch|require\(" providers/atlantic.js || true
echo "=================================="

node - <<'NODE'
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
if (!m.scrapers.some(s => s.id === "atlantic")) {
  m.scrapers.push({
    id: "atlantic",
    name: "Atlantic",
    description: "Movies and TV streaming provider (HLS)",
    version: "1.0.0",
    author: "vanseleem",
    supportedTypes: ["movie", "tv"],
    filename: "providers/atlantic.js",
    enabled: true,
    formats: ["m3u8"],
    contentLanguage: ["en"],
    limited: false,
    supportsExternalPlayer: true
  });
  fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n");
  console.log("manifest: atlantic added");
} else {
  console.log("manifest: atlantic already present");
}
NODE

node - <<'NODE'
const realFetch = global.fetch;
const p = require('./providers/atlantic.js');

async function peek(url, headers) {
  try {
    const r = await realFetch(url, { headers: headers });
    const t = await r.text();
    return r.status + " | " + t.slice(0, 160).replace(/\s+/g, " ");
  } catch (e) { return "ERR " + e.message; }
}

(async () => {
  console.log("\n=== LIVE: movie 533535 ===");
  const m = await p.getStreams("533535", "movie");
  console.log("STREAM COUNT:", m.length);
  for (const s of m) { console.log(s.title); console.log(s.url); console.log(JSON.stringify(s.headers)); }
  if (m[0]) {
    console.log("playlist WITH provider headers:", await peek(m[0].url, m[0].headers));
    console.log("playlist WITHOUT headers      :", await peek(m[0].url, {}));
  }

  for (const t of [["1396", "Breaking Bad"], ["66732", "Stranger Things"]]) {
    console.log("\n=== LIVE: TV " + t[1] + " S1E1 ===");
    const s = await p.getStreams(t[0], "tv", 1, 1);
    console.log("STREAM COUNT:", s.length);
    for (const x of s) console.log(x.url);
  }

  console.log("\n=== RULES: dedupe + cache (expect 1 network call) ===");
  let n = 0;
  global.fetch = function (u, o) { if (String(u).indexOf("/content/") !== -1) n++; return realFetch(u, o); };
  await Promise.all([p.getStreams("27205", "movie"), p.getStreams("27205", "movie")]);
  await p.getStreams("27205", "movie");
  console.log("network calls for 3 requests:", n);

  console.log("\n=== RULES: retry + failure cache (offline stub) ===");
  const calls = {};
  global.fetch = async function (u) {
    const id = String(u).match(/\/content\/movie\/(\d+)$/)[1];
    calls[id] = (calls[id] || 0) + 1;
    if (id === "1001") return { ok: false, status: 503, json: async () => ({}) };
    if (id === "1002") return { ok: false, status: 403, json: async () => ({}) };
    throw new Error("ECONNRESET");
  };
  for (const id of ["1001", "1002", "1003"]) {
    await p.getStreams(id, "movie");
    await p.getStreams(id, "movie");
  }
  console.log("calls per id:", JSON.stringify(calls), "(expect 1001:2  1002:1  1003:2)");
})().catch(err => { console.error(err); process.exit(1); });
