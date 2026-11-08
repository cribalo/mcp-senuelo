// Private live dashboard API. Requests here are never written to D1.
const COOKIE = "dash_session";
const MAX_AGE = 43200;
const enc = new TextEncoder();

export function dashEnabled(env: Env): boolean {
  return typeof env.DASH_PASSWORD === "string" && env.DASH_PASSWORD.length >= 16;
}

export async function handleDash(request: Request, url: URL, env: Env, body: string): Promise<Response> {
  if (!url.pathname.startsWith("/dash/api/") || !dashEnabled(env)) {
    return new Response("Not found\n", { status: 404 });
  }
  const res = await route(request, url, env, body);
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", "no-store");
  return res;
}

async function route(request: Request, url: URL, env: Env, body: string): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (path === "/dash/api/login" && method === "POST") return login(request, env, body);
  if (path === "/dash/api/logout" && method === "POST") {
    return new Response(null, { status: 204, headers: { "set-cookie": cookie("", 0) } });
  }
  if (path === "/dash/api/session" && method === "GET") {
    return new Response(null, { status: (await validSession(request, env)) ? 204 : 401 });
  }
  if (path === "/dash/api/events" && method === "GET") {
    if (!(await validSession(request, env))) return new Response(null, { status: 401 });
    return events(url, env);
  }
  return new Response("Not found\n", { status: 404 });
}

async function login(request: Request, env: Env, body: string): Promise<Response> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return new Response(null, { status: 415 });
  let password = "";
  try {
    const parsed = JSON.parse(body) as { password?: unknown };
    if (typeof parsed.password === "string") password = parsed.password;
  } catch {
    // treated as a wrong password
  }
  // Compare MACs, not the strings: fixed length and no early exit on the first differing byte.
  const fixed = await hmacKey(enc.encode("dash-compare-v1"));
  const a = new Uint8Array(await crypto.subtle.sign("HMAC", fixed, enc.encode(password)));
  const b = new Uint8Array(await crypto.subtle.sign("HMAC", fixed, enc.encode(env.DASH_PASSWORD!)));
  if (!bytesEqual(a, b)) {
    await new Promise((r) => setTimeout(r, 300));
    return new Response(null, { status: 401 });
  }
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const sig = await sign(env, exp);
  return new Response(null, { status: 204, headers: { "set-cookie": cookie(`${exp}.${sig}`, MAX_AGE) } });
}

function cookie(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/dash; Max-Age=${maxAge}`;
}

async function sessionKey(env: Env): Promise<CryptoKey> {
  // Derived from the password, so changing it invalidates every session.
  const root = await hmacKey(enc.encode(env.DASH_PASSWORD!));
  const raw = await crypto.subtle.sign("HMAC", root, enc.encode("dash-session-key-v1"));
  return hmacKey(new Uint8Array(raw));
}

async function sign(env: Env, exp: number): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(`dash:${exp}`));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function validSession(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("cookie") ?? "";
  const part = header.split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="));
  if (!part) return false;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(part.slice(COOKIE.length + 1));
  if (!m) return false;
  const exp = Number(m[1]);
  const expected = await sign(env, exp);
  if (!bytesEqual(enc.encode(expected), enc.encode(m[2]))) return false;
  return exp > Date.now() / 1000;
}

function hmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function events(url: URL, env: Env): Promise<Response> {
  const afterParam = url.searchParams.get("after");
  let rows: Record<string, unknown>[];
  let capped = false;
  if (afterParam !== null) {
    const after = Math.max(0, Math.floor(Number(afterParam)) || 0);
    const r = await env.DB.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT 500").bind(after).all();
    rows = r.results as Record<string, unknown>[];
  } else {
    const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get("limit"))) || 5000, 1), 5000);
    const sinceDate = new Date(url.searchParams.get("since") ?? Date.now() - 86400000);
    const since = (isNaN(sinceDate.getTime()) ? new Date(Date.now() - 86400000) : sinceDate).toISOString();
    // ORDER BY ts uses idx_events_ts and stops at the window edge; ORDER BY id would scan
    // the whole table when the window holds fewer rows than the limit (D1 bills rows read).
    const r = await env.DB.prepare("SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
      .bind(since, limit + 1).all();
    const desc = r.results as Record<string, unknown>[];
    capped = desc.length > limit;
    rows = desc.slice(0, limit).sort((x, y) => Number(x.id) - Number(y.id));
  }
  let maxId = rows.length ? Number(rows[rows.length - 1].id) : Number(afterParam) || 0;
  if (!rows.length && afterParam === null) {
    const m = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").first<{ m: number }>();
    maxId = m?.m ?? 0;
  }
  return Response.json({ events: rows, max_id: maxId, capped });
}
