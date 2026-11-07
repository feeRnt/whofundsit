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
    // Refresh-proofing: browsers send revalidation directives on reload
    // (Cache-Control: max-age=0, If-None-Match...), which make Cloudflare
    // bypass the edge and report DYNAMIC forever. This API is fully public
    // (no cookies/auth/personalization), so strip those directives: a
    // refresh becomes indistinguishable from a fresh GET and hits the edge.
    // Everything else (Accept-Encoding for gzip variants, etc.) passes
    // through untouched.
    const fwd = new Headers(req.headers);
    fwd.delete("cache-control");
    fwd.delete("pragma");
    fwd.delete("if-none-match");
    fwd.delete("if-modified-since");
    fwd.delete("if-range");
    const cache = caches.default;
    const key = new Request(origin, { method: "GET", headers: fwd });
    const hit = await cache.match(key);
    const tag = `${url.pathname}${url.search}`;
    if (hit) {
      console.log(`[edge] HIT ${tag}`);
      return hit;
    }
    const res = await fetch(key);
    if (!res.ok) {
      console.error(`[edge] MISS ${tag} -> origin ${res.status}`);
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
