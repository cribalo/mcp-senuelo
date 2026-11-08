export function renderHome(contact: string, retentionDays: number): string {
  const contactLine = contact
    ? `<p>Contacto / contact: <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a></p>`
    : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Servidor MCP de investigación</title>
<style>
  body { font: 16px/1.55 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; background: #fff; }
  code { background: #f2f2f2; padding: .1em .3em; border-radius: 3px; }
  h2 { margin-top: 2rem; }
  @media (prefers-color-scheme: dark) { body { color: #eee; background: #161616; } code { background: #2a2a2a; } a { color: #8ab4f8; } }
</style>
</head>
<body>
<h1>Servidor MCP de investigación</h1>
<p><strong>Esto es un señuelo con fines de investigación.</strong> Es un servidor
<a href="https://modelcontextprotocol.io/">MCP</a> público, en <code>/mcp</code>, cuyas herramientas
son falsas: no ejecutan nada, no acceden a Internet y no dan acceso a ningún dato real. Sirve para
estudiar qué clientes y agentes de IA se conectan a servidores MCP abiertos y para qué dicen venir.</p>

<h2>Qué se registra</h2>
<ul>
  <li>Hora, país y red (ASN) según Cloudflare, y un <em>hash</em> con sal secreta de la IP (la IP en claro no se guarda).</li>
  <li>User-Agent, versión del protocolo y la información del cliente que este envía (<code>clientInfo</code>).</li>
  <li>Métodos MCP, herramienta llamada, sus argumentos (recortados) y el campo <code>purpose</code>.</li>
  <li>También las peticiones a cualquier otra ruta de este dominio (método, ruta sin parámetros, User-Agent).</li>
</ul>
<p>Los registros se borran a los ${retentionDays} días. No se usan para identificar a nadie. Antes de guardarse,
se ocultan los secretos y datos personales evidentes (claves de API y tokens, correos electrónicos, nombres de
usuario en rutas de archivos, números de tarjeta e IBAN), que se sustituyen por <code>[REDACTED:…]</code>.
Los resultados agregados pueden publicarse en informes, también en informes que se ofrezcan comercialmente;
los registros individuales nunca se ceden ni se venden. Cada herramienta pide un campo <code>purpose</code>:
rellenarlo es voluntario en el sentido de que su contenido lo decide quien llama; agradecemos que sea sincero.</p>
<p>El servidor no pide <em>sampling</em> ni <em>elicitation</em> y no devuelve instrucciones a los agentes.</p>
<h2>Protección de datos</h2>
<p>Responsable: el titular de cribalo.com (contacto abajo). Base jurídica: interés legítimo en la
investigación sobre el uso de servidores MCP por agentes de IA (art. 6.1.f RGPD). Encargado:
Cloudflare; la base de datos está en la UE. Puedes ejercer los derechos de acceso, rectificación,
supresión, oposición y limitación escribiendo al contacto. Como no se guarda la IP en claro,
para localizar tus registros indica tu IP y la hora aproximada. Puedes reclamar ante la
<a href="https://www.aepd.es/">AEPD</a>. No escribas datos personales en <code>purpose</code>.</p>
${contactLine}

<h2 lang="en">In English</h2>
<p lang="en"><strong>This is a research honeypot.</strong> The MCP endpoint at <code>/mcp</code> exposes fake,
harmless tools: nothing is executed, no outbound requests are made and no real data exists. Every call is
logged (time, Cloudflare country and ASN, salted hash of the IP, User-Agent, clientInfo, methods, tool,
truncated arguments and the <code>purpose</code> field) and kept for ${retentionDays} days, to study which MCP clients
and agents connect to open servers and why. Requests to any other path are logged too.
Obvious secrets and personal data (API keys and tokens, email addresses, user names in file paths, card numbers,
IBANs) are replaced by <code>[REDACTED:…]</code> before anything is stored. Aggregated results may be published
in reports, including reports offered commercially; individual records are never shared or sold.</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
