function parseUpstream(value) {
  if (!value) throw new Error("UPSTREAM_ORIGIN is not configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("UPSTREAM_ORIGIN must be a credential-free HTTPS origin");
  }
  url.pathname = "/";
  return url;
}

export default {
  async fetch(request, env) {
    let upstream;
    try {
      upstream = parseUpstream(env.UPSTREAM_ORIGIN);
    } catch {
      return new Response("Gateway is not configured", { status: 503 });
    }
    const incoming = new URL(request.url);
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("x-forwarded-for");
    const response = await fetch(new Request(upstream, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    }));
    const result = new Response(response.body, response);
    result.headers.set("cache-control", "no-store");
    result.headers.set("x-content-type-options", "nosniff");
    result.headers.set("referrer-policy", "no-referrer");
    return result;
  },
};
