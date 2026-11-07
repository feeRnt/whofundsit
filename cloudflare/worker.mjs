// Edge cache in front of the Render origin. Deploy as a NEW hostname for
// the traction demo (judged URLs keep hitting origin directly — freeze-safe).
// Only GET /api/* responses are cached; the origin's s-maxage decides the
// TTL (entities/flows ~ origin file-cache TTL, quotes 24h, /health no-store
// so the pinger always reaches origin). Errors are never cached. Set ORIGIN
// to the Render service URL in the dashboard (or wrangler vars).
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = new URL(url.pathname + url.search, env.ORIGIN);
    if (req.method !== "GET" || !url.pathname.startsWith("/api/")) {
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
    if (hit) {
      return hit;
    }
    const res = await fetch(key);
    if (!res.ok) {
      return res;
    }
    // clones: one to the edge, one to the visitor.
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};
