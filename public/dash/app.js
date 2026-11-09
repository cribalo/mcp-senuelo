"use strict";
// Every event field is attacker-controlled: nodes are built with createElement/textContent only.
(function () {
  const MAX_EVENTS = 5000, FEED_ROWS = 200, POLL_MS = 5000, MAX_BACKOFF = 60000;
  const WINDOWS = { "1h": { ms: 3600e3, bucket: 60e3 }, "24h": { ms: 86400e3, bucket: 900e3 }, "7d": { ms: 604800e3, bucket: 7200e3 } };
  const $ = (id) => document.getElementById(id);
  const state = { events: [], maxId: 0, win: "24h", kind: "all", q: "", selected: null, failures: 0, timer: null, seen: new Set(), capped: false, polling: false, token: 0 };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
  const fmtTime = (ts) => { const d = new Date(ts); return isNaN(d) ? "" : d.toLocaleTimeString("es-ES", { hour12: false }); };
  const fmtDateTime = (ts) => { const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString("es-ES", { hour12: false }); };
  function flag(cc) {
    if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return cc || "–";
    return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ---- auth ----
  async function api(path, opts) { return fetch("/dash/api/" + path, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts)); }
  function showLogin() {
    stopPolling();
    $("app").hidden = true; $("login").hidden = false; $("drawer").hidden = true; $("scrim").hidden = true;
    $("password").value = ""; $("password").focus();
  }
  async function showApp() {
    $("login").hidden = true; $("app").hidden = false;
    await initialLoad();
  }
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").hidden = true; $("login-btn").disabled = true;
    try {
      const res = await api("login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $("password").value }) });
      if (res.status === 204) return showApp();
      $("login-error").textContent = res.status === 401 ? "Contraseña incorrecta." : "No se pudo entrar (" + res.status + ").";
    } catch { $("login-error").textContent = "Sin conexión."; }
    finally { $("login-btn").disabled = false; }
    $("login-error").hidden = false;
  });
  $("logout").addEventListener("click", async () => { await api("logout", { method: "POST" }).catch(() => {}); state.events = []; showLogin(); });

  // ---- data ----
  async function initialLoad() {
    stopPolling(); // bumps state.token, so older in-flight loads drop their result
    const token = state.token;
    const since = new Date(Date.now() - WINDOWS[state.win].ms).toISOString();
    try {
      const res = await api("events?limit=5000&since=" + encodeURIComponent(since));
      if (token !== state.token) return;
      if (res.status === 401) return showLogin();
      if (!res.ok) throw new Error("status " + res.status);
      const data = await res.json();
      state.events = data.events; state.maxId = data.max_id; state.capped = !!data.capped;
      state.seen = new Set(); state.failures = 0;
      $("capped").hidden = !state.capped;
      markUpdated(); setLive(true); render(true);
    } catch { state.failures++; setLive(false, "sin red"); }
    schedule();
  }
  async function poll() {
    if (state.polling || document.hidden) return;
    state.polling = true;
    const token = state.token;
    let again = false;
    try {
      const res = await api("events?after=" + state.maxId);
      if (token !== state.token) return;
      if (res.status === 401) return showLogin();
      if (!res.ok) throw new Error("status " + res.status);
      const data = await res.json();
      state.failures = 0;
      if (data.events.length) {
        state.events.push(...data.events);
        if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
        state.maxId = data.max_id;
        render(false);
      }
      again = data.events.length >= 500;
      markUpdated(); setLive(true);
    } catch { state.failures++; setLive(false, "sin red"); }
    finally { state.polling = false; }
    if (again) setTimeout(poll, 0); else schedule();
  }
  function schedule() {
    clearTimeout(state.timer);
    if (document.hidden || $("app").hidden) return;
    const delay = state.failures ? Math.min(MAX_BACKOFF, POLL_MS * Math.pow(2, state.failures)) : POLL_MS;
    state.timer = setTimeout(poll, delay);
  }
  function stopPolling() { clearTimeout(state.timer); state.token++; }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(state.timer); setLive(false, "pausado"); }
    else if (!$("app").hidden) { setLive(true); poll(); }
  });
  function setLive(on, text) { $("live").classList.toggle("off", !on); $("live-text").textContent = on ? "en directo" : text || "pausado"; }
  function markUpdated() { $("updated").textContent = new Date().toLocaleTimeString("es-ES", { hour12: false }); }

  // ---- derived ----
  function windowed() {
    const cutoff = Date.now() - WINDOWS[state.win].ms;
    return state.events.filter((e) => Date.parse(e.ts) >= cutoff);
  }
  // Same inheritance as scripts/summary.mjs: stateless clients send clientInfo only on initialize.
  function withClients(list) {
    const last = new Map();
    return list.map((e) => {
      const key = e.ip_hash + "|" + (e.user_agent || "");
      if (e.client_name) last.set(key, { name: e.client_name, version: e.client_version });
      const inh = e.client_name ? { name: e.client_name, version: e.client_version } : last.get(key);
      return { e, cname: inh ? inh.name : null, cver: inh ? inh.version : null };
    });
  }
  function topN(list, keyFn, n) {
    const m = new Map();
    for (const x of list) { const k = keyFn(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  const SCAN_CATS = [
    ["MCP/IA-aware", (p, e) => /^\/\.well-known\/(oauth|mcp|agent)/i.test(p) || p === "/a2a" || (e.http_method === "POST" && p === "/") || e.rpc_method === "server/discover" || (/mcp/i.test(p) && p !== "/mcp" && e.kind !== "mcp")],
    ["secretos", (p) => /(\.env|\.git|\.ssh|\.npmrc|secrets|\.bash_history|credentials|server\.key|\.vscode|\.svn|_vti_pvt)/i.test(p)],
    ["backups/BD", (p) => /(\.sql|backup|dump|\.tar\.gz|\.zip)/i.test(p)],
    ["PHP/WordPress", (p) => /(wp-|\.php|phpinfo)/i.test(p)],
    ["Java/infra", (p) => /(actuator|docker-compose|config\.xml|heapdump)/i.test(p)],
    ["web3", (p) => /(solana|farcaster|atproto|actions\.json)/i.test(p)]
  ];
  function category(e) { for (const [name, test] of SCAN_CATS) if (test(e.path || "", e)) return name; return "otros"; }
  const CAT_CHIP = { "MCP/IA-aware": "aware" };

  // ---- render ----
  let renderQueued = false;
  function render(full) {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; doRender(full); });
  }
  function doRender() {
    const list = windowed();
    const withC = withClients(list);
    renderCounters(list);
    renderFunnel(list);
    drawChart(list);
    renderFeed(list);
    renderClients(withC);
    renderTools(withC);
    renderA2a(list);
    renderScanners(list);
    renderOrigin(list);
    renderUas(list);
  }
  function renderCounters(list) {
    const ips = new Set(list.map((e) => e.ip_hash)).size;
    const items = [
      ["peticiones", list.length, "--text"], ["IPs distintas", ips, "--text"],
      ["mensajes MCP", list.filter((e) => e.kind === "mcp").length, "--mcp"],
      ["mensajes A2A", list.filter((e) => e.kind === "a2a" && e.rpc_method).length, "--a2a"],
      ["llamadas a herramientas", list.filter((e) => e.tool).length, "--mcp"],
      ["purposes", list.filter((e) => e.purpose).length, "--aware"],
      ["escáneres", list.filter((e) => e.kind === "http").length, "--http"],
      ["datos ocultados", list.filter((e) => e.redactions).length, "--rejected"]
    ];
    const box = $("counters"); box.replaceChildren();
    for (const [label, n, v] of items) {
      const c = el("div", "counter"); c.style.setProperty("--c", "var(" + v + ")");
      c.append(el("b", null, n.toLocaleString("es-ES")), el("span", null, label)); box.append(c);
    }
  }
  // Per visitor (hashed IP + User-Agent): how far each one got. Percentages are over the previous step.
  function renderFunnel(list) {
    const steps = [["visitantes", null], ["initialize", "initialize"], ["tools/list", "tools/list"], ["tools/call", "tools/call"]];
    const sets = steps.map(() => new Set());
    for (const e of list) {
      const key = e.ip_hash + "|" + (e.user_agent || "");
      sets[0].add(key);
      for (let i = 1; i < steps.length; i++) if (e.rpc_method === steps[i][1]) sets[i].add(key);
    }
    const box = el("div"); const top = sets[0].size;
    steps.forEach(([label], i) => {
      // % over all visitors, not the previous step: stateless clients call tools without initialize.
      const n = sets[i].size;
      const row = el("div", "bar");
      const track = el("span", "track"); const f = el("span", "fill");
      f.style.width = (top ? Math.max(n ? 2 : 0, (n / top) * 100) : 0) + "%"; track.append(f);
      const pct = i === 0 ? "" : (top ? Math.round((n / top) * 100) : 0) + "% · ";
      row.append(el("span", "lbl", label), track, el("span", null, pct + n.toLocaleString("es-ES")));
      box.append(row);
    });
    if (!top) box.append(el("p", "empty", "Sin datos."));
    fill("p-funnel", box);
  }
  function kindChip(kind) { return el("span", "chip " + kind, kind); }

  function renderFeed(list) {
    const q = state.q.trim().toLowerCase();
    const rows = [];
    for (let i = list.length - 1; i >= 0 && rows.length < FEED_ROWS; i--) {
      const e = list[i];
      if (state.kind !== "all" && e.kind !== state.kind) continue;
      if (q && !Object.values(e).some((v) => v !== null && String(v).toLowerCase().includes(q))) continue;
      rows.push(e);
    }
    const first = state.seen.size === 0;
    const body = document.createElement("tbody");
    for (const e of rows) {
      const tr = document.createElement("tr");
      if (!first && !state.seen.has(e.id)) tr.className = "new";
      const what = e.rpc_method || (e.http_method + " " + e.path);
      const cells = [fmtTime(e.ts), null, flag(e.country), what, e.tool || "", e.client_name ? e.client_name + (e.client_version ? " " + e.client_version : "") : "", clip(e.purpose, 60), e.status ?? ""];
      cells.forEach((c, idx) => {
        const td = document.createElement("td");
        if (idx === 1) td.append(kindChip(e.kind)); else td.textContent = c;
        if (idx === 2 && e.country) td.title = e.country;
        tr.append(td);
      });
      tr.addEventListener("click", () => openDrawer(e));
      body.append(tr);
    }
    if (!rows.length) { const tr = el("tr"); const td = el("td", "empty", "Sin eventos."); td.colSpan = 8; tr.append(td); body.append(tr); }
    $("feed").replaceChild(body, $("feed").tBodies[0]);
    for (const e of rows) state.seen.add(e.id);
  }

  function table(headers, rows) {
    const t = el("table"); const tr = el("tr");
    headers.forEach((h) => tr.append(el("th", null, h)));
    const th = el("thead"); th.append(tr); t.append(th);
    const tb = el("tbody");
    rows.forEach((r) => { const row = el("tr"); r.forEach((c, i) => { const td = el("td", i > 0 && typeof c === "number" ? "num" : null); if (c instanceof Node) td.append(c); else { td.textContent = c; td.title = String(c); } row.append(td); }); tb.append(row); });
    t.append(tb); return t;
  }
  function renderClients(withC) {
    const m = new Map();
    for (const { e, cname, cver } of withC) {
      if (e.kind !== "mcp" || !cname) continue;
      const k = cname + "\u0000" + (cver || "");
      let r = m.get(k); if (!r) { r = { name: cname, ver: cver || "", msgs: 0, calls: 0, ips: new Set(), last: "" }; m.set(k, r); }
      r.msgs++; if (e.tool) r.calls++; r.ips.add(e.ip_hash); if (e.ts > r.last) r.last = e.ts;
    }
    const rows = [...m.values()].sort((a, b) => b.msgs - a.msgs).map((r) => [r.name + (r.ver ? " " + r.ver : ""), r.msgs, r.calls, r.ips.size, fmtTime(r.last)]);
    fill("p-clients", rows.length ? table(["cliente declarado", "msgs", "llamadas", "IPs", "última"], rows) : el("p", "empty", "Sin clientes."));
  }
  function renderTools(withC) {
    const byTool = new Map();
    for (const x of withC) if (x.e.tool) { const a = byTool.get(x.e.tool) || []; a.push(x); byTool.set(x.e.tool, a); }
    const box = document.createDocumentFragment();
    [...byTool.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([tool, xs]) => {
      const row = el("div", "tool-row"); row.append(el("b", null, tool), el("span", "muted", xs.length + " llamadas"));
      box.append(row);
      const quotes = el("div", "quotes");
      xs.filter((x) => x.e.purpose).slice(-6).reverse().forEach((x) => {
        const q = el("blockquote", "quote");
        q.append(el("span", null, "“" + clip(x.e.purpose, 240) + "”"), el("small", null, (x.cname || "cliente desconocido") + " · " + fmtDateTime(x.e.ts)));
        quotes.append(q);
      });
      if (quotes.children.length) box.append(quotes);
    });
    if (!byTool.size) box.append(el("p", "empty", "Sin llamadas a herramientas."));
    fill("p-tools", box);
  }
  function renderA2a(list) {
    const xs = list.filter((e) => e.kind === "a2a");
    const box = document.createDocumentFragment();
    const cards = xs.filter((e) => e.note === "agent-card").length;
    const sends = xs.filter((e) => e.rpc_method === "SendMessage" || e.rpc_method === "message/send");
    const row = el("div", "tool-row");
    row.append(el("b", null, "Agent Card"), el("span", "muted", cards + " lecturas"), el("b", null, "mensajes"), el("span", "muted", sends.length + " enviados · " + (xs.filter((e) => e.rpc_method).length - sends.length) + " otros métodos"));
    box.append(row);
    const quotes = el("div", "quotes");
    sends.filter((e) => e.purpose).slice(-8).reverse().forEach((e) => {
      const q = el("blockquote", "quote");
      const who = [e.tool ? "skill " + e.tool : null, e.protocol_version ? "A2A " + e.protocol_version : "A2A 0.3 (sin cabecera)", clip(e.user_agent || "sin user-agent", 60), fmtDateTime(e.ts)].filter(Boolean).join(" · ");
      q.append(el("span", null, "“" + clip(e.purpose, 240) + "”"), el("small", null, who));
      quotes.append(q);
    });
    if (quotes.children.length) box.append(quotes);
    else box.append(el("p", "empty", "Sin mensajes A2A."));
    fill("p-a2a", box);
  }
  function renderScanners(list) {
    const m = new Map();
    for (const e of list) {
      if (e.kind === "mcp" && e.rpc_method !== "server/discover") continue;
      if (e.kind === "a2a" && e.note !== "agent-card") continue;
      const k = e.http_method + " " + e.path; let r = m.get(k);
      if (!r) { r = { key: k, n: 0, cat: category(e) }; m.set(k, r); } r.n++;
    }
    const rows = [...m.values()].sort((a, b) => b.n - a.n).slice(0, 25).map((r) => {
      const chip = el("span", "chip " + (CAT_CHIP[r.cat] || "http"), r.cat); return [r.key, chip, r.n];
    });
    fill("p-scanners", rows.length ? table(["ruta", "categoría", "n"], rows) : el("p", "empty", "Sin escáneres."));
  }
  function bars(entries, label) {
    const box = el("div"); const max = entries.length ? entries[0][1] : 1;
    entries.forEach(([k, n]) => {
      const row = el("div", "bar"); const lbl = el("span", "lbl", label ? label(k) : k); lbl.title = k;
      const track = el("span", "track"); const fillEl = el("span", "fill"); fillEl.style.width = Math.max(2, (n / max) * 100) + "%"; track.append(fillEl);
      row.append(lbl, track, el("span", null, n)); box.append(row);
    });
    if (!entries.length) box.append(el("p", "empty", "Sin datos."));
    return box;
  }
  function renderOrigin(list) {
    const wrap = el("div", "origin-cols"); const a = el("div"), b = el("div");
    a.append(el("h3", null, "países"), bars(topN(list, (e) => e.country, 10), (c) => flag(c) + " " + c));
    b.append(el("h3", null, "redes"), bars(topN(list, (e) => e.as_org, 10)));
    wrap.append(a, b); fill("p-origin", wrap);
  }
  function renderUas(list) {
    const rows = topN(list, (e) => e.user_agent, 20).map(([k, n]) => [k, n]);
    fill("p-uas", rows.length ? table(["user-agent", "n"], rows) : el("p", "empty", "Sin datos."));
  }
  function fill(id, node) { $(id).replaceChildren(node); }

  // ---- chart ----
  const chartState = { buckets: [], geo: null };
  function drawChart(list) {
    const cv = $("chart"), cfg = WINDOWS[state.win];
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const end = Math.ceil(Date.now() / cfg.bucket) * cfg.bucket, n = Math.round(cfg.ms / cfg.bucket), start = end - n * cfg.bucket;
    const buckets = Array.from({ length: n }, (_, i) => ({ t: start + i * cfg.bucket, mcp: 0, a2a: 0, http: 0, rejected: 0 }));
    for (const e of list) { const i = Math.floor((Date.parse(e.ts) - start) / cfg.bucket); if (i >= 0 && i < n && buckets[i][e.kind] !== undefined) buckets[i][e.kind]++; }
    const max = Math.max(1, ...buckets.map((b) => b.mcp + b.a2a + b.http + b.rejected));
    const L = 38, B = 20, T = 6, R = 6, cw = w - L - R, ch = h - B - T, bw = cw / n;
    const colors = { mcp: cssVar("--mcp"), a2a: cssVar("--a2a"), http: cssVar("--http"), rejected: cssVar("--rejected") };
    ctx.font = "11px " + cssVar("--mono"); ctx.fillStyle = cssVar("--muted"); ctx.strokeStyle = cssVar("--line");
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = T + ch - (ch * i) / 4; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.fillText(String(Math.round((max * i) / 4)), L - 5, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(cw / 70))));
    buckets.forEach((b, i) => {
      let y = T + ch;
      for (const k of ["mcp", "a2a", "http", "rejected"]) {
        const hh = (b[k] / max) * ch; if (!hh) continue;
        ctx.fillStyle = colors[k]; ctx.fillRect(L + i * bw + Math.min(1, bw * 0.1), y - hh, Math.max(1, bw - Math.min(2, bw * 0.2)), hh); y -= hh;
      }
      if (i % step === 0) {
        const d = new Date(b.t); ctx.fillStyle = cssVar("--muted");
        ctx.fillText(state.win === "7d" ? d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" }) + " " + String(d.getHours()).padStart(2, "0") + "h" : d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false }), L + i * bw + bw / 2, h - B + 4);
      }
    });
    chartState.buckets = buckets; chartState.geo = { L, bw, n, w };
  }
  $("chart").addEventListener("mousemove", (ev) => {
    const g = chartState.geo; if (!g) return;
    const r = $("chart").getBoundingClientRect(), i = Math.floor((ev.clientX - r.left - g.L) / g.bw), tip = $("tip");
    if (i < 0 || i >= g.n) { tip.hidden = true; return; }
    const b = chartState.buckets[i];
    tip.replaceChildren(el("div", null, fmtDateTime(b.t)), el("div", null, "mcp " + b.mcp + " · a2a " + b.a2a + " · http " + b.http + " · rejected " + b.rejected));
    tip.hidden = false;
    tip.style.left = Math.min(ev.clientX - r.left + 12, g.w - tip.offsetWidth - 4) + "px"; tip.style.top = "8px";
  });
  $("chart").addEventListener("mouseleave", () => { $("tip").hidden = true; });
  window.addEventListener("resize", () => { if (!$("app").hidden) render(true); });
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => render(true));

  // legend
  [["mcp", "--mcp"], ["a2a", "--a2a"], ["http", "--http"], ["rejected", "--rejected"]].forEach(([k, v]) => {
    const s = el("span"); const sw = el("span", "sw"); sw.style.background = "var(" + v + ")"; s.append(sw, document.createTextNode(k)); $("legend").append(s);
  });

  // ---- drawer ----
  const FIELDS = ["id", "ts", "kind", "ip_hash", "country", "asn", "as_org", "user_agent", "http_method", "path", "status", "body_bytes", "protocol_version", "rpc_method", "rpc_id", "client_name", "client_version", "client_info", "capabilities", "tool", "args", "purpose", "note", "redactions", "context_id", "task_id"];
  function openDrawer(e) {
    $("drawer-id").textContent = "#" + e.id;
    const dl = el("dl");
    for (const f of FIELDS) {
      const wrap = el("div", "field"); wrap.append(el("dt", null, f));
      const v = e[f];
      const dd = el("dd");
      if ((f === "client_info" || f === "args" || f === "capabilities") && v) {
        let text = v; try { text = JSON.stringify(JSON.parse(v), null, 2); } catch { /* keep raw */ }
        dd.append(el("pre", null, text));
      } else dd.textContent = v === null || v === undefined ? "–" : String(v);
      wrap.append(dd); dl.append(wrap);
    }
    $("drawer-body").replaceChildren(dl); $("drawer").hidden = false; $("scrim").hidden = false;
  }
  function closeDrawer() { $("drawer").hidden = true; $("scrim").hidden = true; }
  $("drawer-close").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  // ---- controls ----
  $("window").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-w]"); if (!b) return;
    state.win = b.dataset.w; [...$("window").children].forEach((c) => c.classList.toggle("on", c === b)); initialLoad();
  });
  $("kinds").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]"); if (!b) return;
    state.kind = b.dataset.k; [...$("kinds").children].forEach((c) => c.classList.toggle("on", c === b)); state.seen = new Set(); render(true);
  });
  $("search").addEventListener("input", (e) => { state.q = e.target.value; state.seen = new Set(); render(true); });

  // ---- boot ----
  api("session").then((r) => (r.status === 204 ? showApp() : showLogin())).catch(showLogin);
})();
