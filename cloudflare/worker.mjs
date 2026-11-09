// Edge cache in front of the Render origin: the worker URL IS the demo URL
// (pages, bundle, API — everything edge-served; VITE_API_URL stays unset so
// the app calls the same origin relatively). Judged URLs keep hitting origin
// directly — freeze-safe. /api/* uses the origin's s-maxage (entities/flows
// ~ file-cache TTL, quotes 24h). /assets/* are Vite content-hashed, so they
// are stored immutable for a year regardless of origin headers. /health is
// never cached so the pinger always reaches origin. Errors are never cached.
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!env.ORIGIN) {
      console.error("[edge] ORIGIN is not set — add it via deploy.mjs or dashboard Variables");
      return new Response("edge origin not configured", { status: 500 });
    }
    const origin = new URL(url.pathname + url.search, env.ORIGIN);
    // Bundle too, not just API: /assets/* are content-hashed (immutable),
    // / is the shell (honors origin headers, so deploys flow through).
    // /health stays a passthrough so the pinger always reaches origin.
    const cacheable =
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/assets/") ||
      url.pathname === "/" ||
      url.pathname === "/index.html";
    if (req.method !== "GET" || !cacheable) {
      return fetch(new Request(origin, req));
    }
    // Standard shape: clean cache key, original request forwarded so the
    // origin sees validators and can answer 304. Refreshes may report
    // DYNAMIC while revalidating — that label is fine; bytes are the
    // metric that matters, and revalidations move almost none.
    const cache = caches.default;
    const key = new Request(origin, { method: "GET" });
    const tag = `${url.pathname}${url.search}`;
    const colo = req.cf?.colo ?? "?";
    const hit = await cache.match(key);
    if (hit) {
      console.log(`[edge:${colo}] HIT ${tag}`);
      return hit;
    }
    // Far edges miss independently (cache is per-location), so their first
    // fetch crosses the world to a possibly-sleeping origin — the single
    // most failure-prone request in the system. Retry it once after a short
    // pause: the second attempt almost always finds origin awake.
    const fetchOrigin = () => fetch(new Request(origin, req));
    const retryable = (r) => r === null || r.status === 502 || r.status === 503 || r.status === 504;
    let res = await fetchOrigin().catch((err) => {
      console.error(`[edge:${colo}] MISS ${tag} -> origin unreachable (${err})`);
      return null;
    });
    if (retryable(res)) {
      console.log(`[edge:${colo}] MISS ${tag} -> retrying origin (${res === null ? "fetch failed" : `HTTP ${res.status}`})`);
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetchOrigin().catch((err) => {
        console.error(`[edge:${colo}] MISS ${tag} -> retry failed (${err})`);
        return null;
      });
    }
    if (res === null) {
      return new Response("origin unreachable", { status: 502 });
    }
    if (!res.ok) {
      console.error(`[edge:${colo}] MISS ${tag} -> origin ${res.status}`);
      return res;
    }
    // Hashed assets can never change contents: store them immutable for a
    // year no matter what the origin says. Everything else keeps the
    // origin's own freshness headers.
    let out = res;
    if (url.pathname.startsWith("/assets/")) {
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      const body = await res.clone().arrayBuffer();
      out = new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    }
    console.log(`[edge] MISS ${tag} -> origin ${res.status}, stored`);
    // clones: one to the edge, one to the visitor.
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
};
