// HSTS on HTML pages: one year, no includeSubDomains and no preload until the whole zone is ready for it.
export const HSTS = "max-age=31536000";

// The only inline content of the page; the CSP allows it by hash (homeHeaders) and nothing else.
const STYLE = `
  body { font: 16px/1.55 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; background: #fff; }
  code { background: #f2f2f2; padding: .1em .3em; border-radius: 3px; }
  h2 { margin-top: 2rem; }
  @media (prefers-color-scheme: dark) { body { color: #eee; background: #161616; } code { background: #2a2a2a; } a { color: #8ab4f8; } }
`;

let csp: Promise<string> | undefined;
export async function homeHeaders(): Promise<Record<string, string>> {
  csp ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)).then((d) => {
    const hash = btoa(String.fromCharCode(...new Uint8Array(d)));
    return `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  });
  return {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": await csp,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "strict-transport-security": HSTS
  };
}

export function renderHome(contact: string, retentionDays: number): string {
  const mail = contact ? escapeHtml(contact) : "";
  const contactLine = mail ? `<p>Contact: <a href="mailto:${mail}">${mail}</a></p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open MCP and A2A research honeypot — Cribalo</title>
<meta name="description" content="A public, declared research decoy: an open MCP server and A2A agent with fake, harmless tools, used to study which AI clients and agents connect and what they ask for.">
<link rel="canonical" href="https://mcp.cribalo.com/">
<meta property="og:type" content="website">
<meta property="og:url" content="https://mcp.cribalo.com/">
<meta property="og:title" content="Open MCP and A2A research honeypot">
<meta property="og:description" content="Which AI agents connect to an open MCP server, and what do they say they want? A declared research decoy with fake tools.">
<meta name="twitter:card" content="summary">
<style>${STYLE}</style>
</head>
<body>
<h1>Research MCP server</h1>
<p><strong>This is a research decoy (honeypot).</strong> It is a public
<a href="https://modelcontextprotocol.io/">MCP</a> server at <code>/mcp</code> whose tools are fake: they execute
nothing, make no outbound requests and give access to no real data. It exists to study which AI clients and
agents connect to open MCP servers, and what they say they come for.</p>
<p>There is also an equally fake <a href="https://a2a-protocol.org/">A2A</a> (Agent2Agent) agent: its card is at
<code>/.well-known/agent-card.json</code> and it receives messages at <code>/a2a</code>. It always answers with
synthetic text that says so, and executes nothing.</p>

<h2>What is logged</h2>
<ul>
  <li>Time, country and network (ASN) as reported by Cloudflare, and a salted hash of the IP address (the IP itself is not stored).</li>
  <li>User-Agent, protocol version and the client information the client sends (<code>clientInfo</code>).</li>
  <li>MCP methods, the tool called, its arguments (truncated) and the <code>purpose</code> field.</li>
  <li>For A2A: method, protocol version, the text of each message (truncated), the requested skill and the context and task ids.</li>
  <li>Each synthetic result carries its own reference link (<code>/c/…</code>); visits to it are logged, to see whether agents act on results.</li>
  <li>Requests to any other path on this domain (method, path without query string, User-Agent).</li>
</ul>
<p>Records are deleted after ${retentionDays} days and are not used to identify anyone. Daily aggregate counts
(for example, requests per country or per declared client) are kept beyond that; they hold no IP hashes,
User-Agents, arguments or texts. Before anything is stored,
obvious secrets and personal data (API keys and tokens, email addresses, user names in file paths, card numbers,
IBANs, Spanish ID numbers and phone numbers) are replaced by <code>[REDACTED:…]</code>.
Aggregated results may be published in reports, including reports offered commercially; individual records are
never shared or sold. Every tool asks for a <code>purpose</code> field: what goes in it is up to the caller, and we
appreciate an honest answer.</p>
<p>The server does not request <em>sampling</em> or <em>elicitation</em> and returns no instructions to agents.</p>
<p>Aggregate figures (totals only, no IP hashes or texts) are published at <a href="/stats.json">/stats.json</a>,
refreshed every 5 minutes. They feed the live figures on <a href="https://criba.cribalo.com/">criba</a>.</p>

<h2>Data protection</h2>
<p>Controller: the owner of cribalo.com (contact below). Legal basis: legitimate interest in research on how AI
agents use MCP servers (GDPR art. 6.1.f). Processor: Cloudflare; the database is in the EU. You can exercise your
rights of access, rectification, erasure, objection and restriction by writing to the contact address. Since the IP
address is not stored in clear, include your IP and the approximate time so we can find your records. You can
complain to the Spanish data protection authority (<a href="https://www.aepd.es/">AEPD</a>). Do not put personal
data in <code>purpose</code>.</p>
${contactLine}

<h2 lang="es">En español</h2>
<p lang="es">Esto es un señuelo con fines de investigación: las herramientas MCP y el agente A2A son falsos y no
ejecutan nada. Se registran las peticiones (hora, país y red, un hash de la IP, User-Agent, métodos, herramienta,
argumentos recortados y el campo <code>purpose</code>) durante ${retentionDays} días, ocultando antes secretos y
datos personales evidentes. Después se conservan solo recuentos diarios agregados, sin hashes de IP, User-Agents
ni textos. Base jurídica: interés legítimo en la investigación (art. 6.1.f RGPD). Encargado:
Cloudflare (UE). Derechos de acceso, rectificación, supresión, oposición y limitación: escribe al contacto${mail ? ` (<a href="mailto:${mail}">${mail}</a>)` : ""}
indicando tu IP y la hora aproximada. Puedes reclamar ante la <a href="https://www.aepd.es/">AEPD</a>.</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
