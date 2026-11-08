# mcp-senuelo — servidor MCP de investigación

Servidor MCP público y abierto, en Cloudflare Workers, cuyas herramientas son falsas e inofensivas.
Sirve para registrar **qué clientes y agentes se conectan a un MCP abierto y a qué dicen venir**
(campo obligatorio `purpose`). Lo dice abiertamente en cada herramienta, en las `instructions`
del servidor y en la página `/`.

Estado: **en producción en `https://mcp.cribalo.com` desde el 8 nov 2026.** Publicado en el
[MCP Registry oficial](https://registry.modelcontextprotocol.io/v0/servers?search=com.cribalo) como
`com.cribalo/research-mcp` (8 nov 2026), con una descripción que dice que es un señuelo de
investigación. Ficha: `server.json`. El dominio se verifica con un registro TXT en la raíz de
`cribalo.com` (`v=MCPv1; k=ed25519; p=…`); la clave privada está en el servidor, en
`/root/.config/mcp-registry/key.pem`, fuera del repositorio. Para publicar una versión nueva:
subir `version` en `server.json`, `mcp-publisher login dns --domain cribalo.com --private-key …`
y `mcp-publisher publish`. Si se borra el TXT, no se puede volver a publicar hasta reponerlo.

## Arquitectura

```
cliente MCP ──HTTPS──▶ Worker (mcp.cribalo.com)
                        ├─ límite: 30 peticiones/60 s por IP con hash (binding ratelimits) → 429
                        ├─ cuerpo > 32 KiB → 413 (se registra como 'rejected')
                        ├─ /mcp  → createMcpHandler (agents) + McpServer (SDK v2), sin estado
                        ├─ /.well-known/agent-card.json (y agent.json) → Agent Card A2A
                        ├─ /a2a  → agente A2A señuelo, JSON-RPC sin estado (src/a2a.ts)
                        ├─ /     → página que explica el servidor
                        ├─ /dash/ → panel privado en directo (contraseña); no se registra
                        └─ resto → 404, se registra (escáneres)
                        │
                        └─ ctx.waitUntil → D1 'events' (una fila por mensaje JSON-RPC o petición)
cron diario 03:17 UTC ──▶ DELETE de filas con más de RETENTION_DAYS
```

- **Versiones fijadas** (`package.json`, versiones exactas): `agents@0.33.0`,
  `@modelcontextprotocol/server@2.4.0` (SDK v2), `zod@4.6.7`, `wrangler@4.158.0`; para las
  pruebas, `@modelcontextprotocol/client@2.4.0`.
- **Por qué `createMcpHandler` y no `McpAgent`:** la documentación de `agents@0.33.0`
  (`docs/mcp-servers.md`, consultada el 8 nov 2026) marca `McpAgent` como obsoleto. El handler
  nuevo no guarda estado, no necesita Durable Objects y sirve Streamable HTTP tanto a clientes de
  la versión borrador `2026-07-28` (stateless) como a los de 2025 (`legacy: "stateless"`). Sin
  sesión, los clientes de 2025 no pueden recibir *sampling* ni *elicitation*, y el servidor no
  los usa. No hay transporte SSE independiente.
- **`clientInfo`:** los clientes de 2025 lo mandan solo en `initialize`, y los del borrador en
  `_meta["io.modelcontextprotocol/clientInfo"]` de cada petición. Se guardan los dos. El script
  de resumen asigna a cada llamada el último `clientInfo` visto con el mismo hash de IP y el
  mismo User-Agent.
- **Herramientas** (`src/tools.ts`): `search_documents`, `fetch_url`, `query_database`,
  `get_exchange_rate`, `execute_script` y `read_file` (6). Ninguna hace peticiones de red ni
  ejecuta nada (`fetch_url` no llama a la URL, `query_database` no ejecuta el SQL,
  `execute_script` responde «Execution denied» y `read_file` «Access denied»). Devuelven datos de muestra fijos con la etiqueta
  «Synthetic response… Nothing was executed». Cada una exige `purpose` (de 1 a 500 caracteres),
  y su descripción dice que las llamadas se registran. Las respuestas no llevan instrucciones
  para el agente.
- **Origin:** el SDK rechaza (403) las peticiones de navegador desde otros dominios, para que
  ninguna web pueda usar el navegador de sus visitantes contra `/mcp`.

## Capa A2A (Agent2Agent)

Segunda puerta del mismo señuelo, para agentes que **delegan tareas en otros agentes** en vez de
llamar herramientas. Está en `src/a2a.ts`, en el mismo Worker, con el mismo límite por IP, el mismo
tope de 32 KiB, la misma ocultación de secretos y la misma tabla.

- **Versiones:** habla A2A **1.0** (especificación consultada el 8 nov 2026) y **0.3**, porque
  muchos clientes siguen en 0.3. Sin cabecera `A2A-Version` se asume 0.3, como manda la 1.0. Los
  métodos en PascalCase (`SendMessage`) se responden con la forma 1.0 aunque falte la cabecera.
  Con otra versión, el error es `-32009`.
- **Agent Card** en `/.well-known/agent-card.json`, y también en la ruta antigua
  `/.well-known/agent.json`. Lleva los campos 1.0 (`supportedInterfaces`, con la 1.0 como
  preferida) y los 0.3 (`url`, `preferredTransport`, `protocolVersion`). Tiene 6 *skills* que
  replican las herramientas MCP. La descripción y cada *skill* dicen que se registra y que no se
  ejecuta nada. Se sirve con `access-control-allow-origin: *` porque es pública.
- **`/a2a`** (POST y JSON-RPC 2.0):

  | Método (1.0 / 0.3) | Respuesta |
  |---|---|
  | `SendMessage` / `message/send` | tarea `COMPLETED` / `completed` con un *artifact* de texto sintético fijo |
  | `GetTask`, `CancelTask`, `SubscribeToTask` (y sus nombres 0.3) | `-32001` TaskNotFound, porque no se guarda ninguna tarea |
  | `SendStreamingMessage` / `message/stream`, `ListTasks` | `-32004` Unsupported (la card declara `streaming: false`) |
  | métodos de *push notifications* | `-32003` |
  | `GetExtendedAgentCard` | `-32007` |

- **Navegadores:** `/a2a` exige `Content-Type` `application/json` o `application/a2a+json` (si no,
  responde 415) y no contesta a los *preflight* CORS. Así, ninguna web puede usar el navegador de
  sus visitantes contra `/a2a`. GET responde 405.
- **Registro** (`kind = 'a2a'`):
  - `purpose` guarda **el texto del mensaje**, porque en A2A el texto es la intención.
  - `tool` guarda el *skill* si viene en `metadata.skillId`, `skill_id` o `skill`.
  - `context_id` y `task_id` (migración `0003_a2a.sql`) permiten seguir conversaciones.
  - `args` guarda el resto de `params`, con los textos y los bytes de ficheros sustituidos por su tamaño.
  - `protocol_version` guarda la cabecera `A2A-Version` (`NULL` = 0.3).
  - Las lecturas de la Agent Card se guardan con `note = 'agent-card'`.
- **Panel y resumen:** el panel tiene el filtro `a2a`, el contador «mensajes A2A», una serie en la
  gráfica y la tarjeta «Mensajes A2A». `npm run summary` añade **Embudo A2A** (card → envío →
  varios turnos), **Métodos A2A y versión** y **Mensajes A2A**.

## Qué se guarda (tabla `events`, `migrations/0001_init.sql`, `0002_capabilities_redactions.sql` y `0003_a2a.sql`)

| Campo | Contenido |
|---|---|
| `ts`, `kind` | hora UTC; `mcp`, `http` (otras rutas) o `rejected` (413) |
| `ip_hash` | HMAC-SHA256 de la IP con la sal secreta `IP_SALT`, truncado a 16 hex. **La IP en claro no se guarda** |
| `country`, `asn`, `as_org` | país y red según `request.cf` |
| `user_agent`, `http_method`, `path`, `status`, `body_bytes` | ruta **sin** query string |
| `protocol_version`, `rpc_method`, `rpc_id` | por cada mensaje JSON-RPC (como mucho 20 por lote) |
| `client_name`, `client_version`, `client_info` | `clientInfo` |
| `capabilities` | `capabilities` que el cliente declara en `initialize` (JSON recortado; `NULL` en el resto) |
| `tool`, `args`, `purpose` | herramienta, argumentos sin `purpose` y `purpose` aparte |
| `context_id`, `task_id` | solo en A2A: identificadores de conversación y tarea que manda el cliente |
| `redactions` | tipos de dato ocultados en esa fila, sin repetir, ordenados y separados por comas (`NULL` si ninguno) |

Límites: `MAX_FIELD_CHARS` (2000) para argumentos, `purpose` y `clientInfo`, y 500 para el
User-Agent. Del cuerpo de las rutas no MCP solo se guarda el tamaño. Las peticiones cortadas por
el límite (429) no se registran, para que una avalancha no agote las escrituras diarias de D1.
Sin la sal `IP_SALT`, el campo vale `no-salt`: un hash de IPv4 sin sal se invierte enseguida.

### Ocultación de secretos y datos personales

Antes de guardar, `src/redact.ts` sustituye cada coincidencia por `[REDACTED:<tipo>]` en `args`
(sobre el JSON completo, antes de recortar, para que un secreto cortado a medias no se escape),
`purpose`, `capabilities`, `client_info`, el nombre y la versión del cliente, y en el cuerpo
cuando no es JSON válido. Se hace por minimización (RGPD) y para no guardar secretos de terceros
que un agente pegue sin querer. Orden y tipos:

| Tipo | Qué oculta |
|---|---|
| `private_key` | de `-----BEGIN … PRIVATE KEY-----` hasta su `END` (o hasta el final) |
| `jwt` | tres segmentos base64url que empiezan por `eyJ` |
| `bearer` | `Bearer` + token de 20 caracteres o más |
| `api_key` | `sk-…` (también `sk-ant-`, `sk-proj-`), `AKIA…`, `ghp_`/`gho_`/…, `github_pat_`, `xox?-`, `AIza…`, `glpat-` |
| `card` | 13–19 dígitos (con espacios o guiones) que pasan Luhn |
| `iban` | IBAN que pasa mod-97 |
| `email` | direcciones de correo |
| `home_path` | solo el nombre de usuario en `/Users/…`, `/home/…` y `C:\Users\…` |

Decisiones: `sk-` exige que no lo preceda una letra o dígito (si no, `task-force-…` se ocultaría);
13 dígitos seguidos sin separador no cuentan como tarjeta (son un *epoch* en milisegundos); `home_path`
no actúa si la ruta va precedida de un dominio (`example.com/home/x`). Las expresiones
son lineales o con cuantificadores acotados (el cuerpo está limitado a 32 KiB y Workers Free da
unos 10 ms de CPU). Es una red de seguridad, no una garantía: texto libre con datos personales
no evidentes (nombres, direcciones) sigue guardándose. Pruebas: `node scripts/redact-test.mjs`.

**Retención:** 90 días (`RETENTION_DAYS`). La purga corre a diario con un cron. Workers Logs
está desactivado (`observability.enabled: false`), así que D1 es el único registro.

## Panel en directo (`/dash/`)

Panel privado para ver el registro casi en tiempo real: contadores, actividad por tipo, feed con
filtro y búsqueda, detalle de cada evento, clientes MCP, herramientas con sus `purpose`,
escáneres clasificados, User-Agents y origen. Incluye una tarjeta «Embudo» (visitantes →
`initialize` → `tools/list` → `tools/call`, por hash de IP + User-Agent; el % es sobre el total
de visitantes, porque los clientes sin estado llaman a herramientas sin pasar por `initialize`) y un contador
de «datos ocultados» (filas con `redactions`). El detalle de cada evento muestra también
`capabilities` y `redactions`. Ventanas de 1 h, 24 h y 7 días.

- **Acceso:** una contraseña en el secreto `DASH_PASSWORD` (16 caracteres o más). Sin ese
  secreto, `/dash/api/*` responde 404 y el panel no carga datos. El inicio de sesión deja una
  cookie firmada con HMAC (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/dash`, 12 h). Cambiar
  la contraseña invalida todas las sesiones.
- **Seguridad:** todo lo que muestra el panel lo escribe quien llama, así que el HTML se monta solo
  con `textContent` (la prueba `app.js has no HTML-injection sinks` lo vigila) y `public/_headers`
  pone una CSP estricta (`script-src 'self'`, sin `unsafe-inline`), `frame-ancestors 'none'` y
  `no-referrer`. Las peticiones a `/dash` no se guardan en D1.
- **Lecturas de D1:** la carga inicial lee como mucho 5000 filas por el índice de `ts`, y luego
  pide cada 5 s solo las filas nuevas (`id > último`); con la pestaña oculta, para. Queda muy por
  debajo de los 5 M de lecturas diarias del plan Free.

Para activarlo en producción:
```bash
npx wrangler secret put DASH_PASSWORD
```
Y en local, `DASH_PASSWORD=` en `.dev.vars`.

## Coste

Está pensado para el plan Workers Free. Según la documentación de Cloudflare (comprobada el
8 nov 2026), al superar los límites gratuitos las peticiones fallan y no se cobran: el error
1027 en Workers y el bloqueo hasta las 00:00 UTC en D1. Los límites son 100 000 peticiones/día
y 10 ms de CPU por petición en Workers; 100 000 escrituras/día, 5 M lecturas/día y 500 MB por
base en D1; y 5 cron por cuenta. Ninguna página consultada dice si una cuenta sin plan de pago
puede llegar a pagar, pero sin método de pago ni plan Paid no hay a quién cobrar. **No actives
Workers Paid para esta cuenta.** Tampoco consta si el binding de rate limiting está en Free: si
no lo está, el código sigue funcionando sin él (falla abierto) y siguen valiendo los límites
diarios del plan. El servidor no hace llamadas salientes ni usa servicios de pago (ni Workers AI,
ni KV, ni R2, ni Durable Objects).

## Probar en local

```bash
npm ci
```
```bash
cp .dev.vars.example .dev.vars
```
```bash
npm run db:local
```
```bash
npm run dev
```
En otra terminal:
```bash
npm test
```
```bash
node scripts/test-client.mjs --rate-limit
```
```bash
npm run summary
```
```bash
node scripts/redact-test.mjs
```

`npm run summary` imprime, además de las secciones de clientes, métodos, herramientas, purposes,
escáneres, User-Agents y origen (con «cliente declarado» en los encabezados): **Embudo por cliente**
(todos y por cliente declarado: visitantes que llegan a cualquier petición, `initialize`,
`tools/list` y `tools/call`, con % sobre el total de visitantes), **Sesiones** (mismo hash de IP y
User-Agent con huecos de menos de 30 min: número, media de peticiones y de minutos, y sesiones
con `tools/call`), **Capabilities declaradas** por cliente y **Datos ocultados** por tipo y
herramienta.

`node scripts/redact-test.mjs` (56 comprobaciones, necesita Node 22.18 o superior para importar
el `.ts`) prueba positivos y negativos de cada tipo (UUID, marcas de tiempo, un número de 12 dígitos
o `sk-short` no se ocultan) y el tiempo con entradas adversas de 32 KiB.

`npm test` (`scripts/test-client.mjs`) prueba lo siguiente:

- la página `/` y un 404 de ruta de escáner;
- un cliente del SDK con el protocolo actual: lista de herramientas, todas con `purpose`
  obligatorio y aviso de registro, y respuestas sintéticas;
- que `fetch_url` no hace la petición, que `execute_script` y `read_file` deniegan y que una
  llamada sin `purpose` se rechaza;
- que una clave `sk-…`, un correo y `/Users/alice/…` mandados en `purpose` y `args` no llegan a D1
  y `redactions` vale `api_key,email,home_path`; y que `capabilities` se guarda;
- un cliente de 2025 con peticiones a mano;
- el 413 por cuerpo grande y el 403 por Origin ajeno;
- que las filas llegan a D1: `clientInfo`, `purpose` separado de `args` y `ip_hash` en hexadecimal.

- el panel: CSP, 401 sin cookie o con contraseña mala, cookie con sus atributos, eventos en
  orden, cookie manipulada rechazada, cierre de sesión y que `/dash` no llega a D1.

`--rate-limit` añade la comprobación del 429.

`npm run test:a2a` (`scripts/a2a-test.mjs`) usa el SDK oficial `@a2a-js/sdk` en dos versiones: la
1.3.0, como cliente A2A 1.0, y la 0.3.14 (alias `a2a-sdk-v03`), como cliente 0.3. Comprueba la
Agent Card en sus dos rutas, el `SendMessage` 1.0 y el `message/send` 0.3 con tarea completada
sintética, `GetTask` → TaskNotFound, los errores `-32004`, `-32601`, `-32009`, `-32602` y
`-32700`, el 405 y el 415, que no se concede CORS, y las filas en D1: texto en `purpose`, *skill*,
`context_id` y una clave `sk-ant-…` y `/home/alice` ocultadas. En local, `wrangler dev` reescribe
el Host al de la ruta, así que la card anuncia `https://mcp.cribalo.com/a2a`; la prueba redirige
esa URL al servidor local. Las dos suites seguidas superan las 30 peticiones/min: deja un minuto
entre ellas.

Resultado el 8 nov 2026: 21 de 21 pruebas pasan en local, y la purga del cron, probada con
`/cdn-cgi/handler/scheduled`, borra una fila de 2020 y conserva las recientes.

## Desplegar

**Desplegado el 8 nov 2026** en `https://mcp.cribalo.com`, en la cuenta de Cloudflare
«Femogo@gmail.com's Account» (`de3e30eb…`). Esa cuenta también tiene la zona `cribalo.com`, y
`wrangler.jsonc` la fija con `account_id`. workers.dev está desactivado: el único acceso es el
dominio. `contact@cribalo.com` se reenvía con Email Routing.

Lo que aprendimos al desplegar:

- **El Worker y la zona tienen que estar en la misma cuenta.** El primer despliegue fue a otra
  cuenta («Cribalo») y el dominio falló con el error `10083 The zone does not exist on your
  account`.
- **`wrangler login` no funciona en el LXC**, porque espera la respuesta en `localhost:8976`.
  Usa un token de API exportado como `CLOUDFLARE_API_TOKEN`, con estos permisos:
  - **Cuenta** (la de la zona): las tres casillas **Edit** de Workers, sin **Admin**, y **D1 → Edit**.
  - **Zona** `cribalo.com`: **Zone → Read** y **DNS → Edit**. Sin *Zone Read*, wrangler no ve la
    zona.

  Revoca el token al terminar y bórralo del historial
  (`sed -i '/CLOUDFLARE_API_TOKEN/d' ~/.bash_history`).
- `wrangler d1 create` pregunta si quieres añadir la base a `wrangler.jsonc`. Contesta **No** y
  pon solo el `database_id` en la entrada `DB`.

Para volver a desplegar tras un cambio de código, con un token nuevo:
```bash
npx wrangler deploy
```

Para montarlo desde cero en otra cuenta:
1. Pon el `account_id` en `wrangler.jsonc`.
2. Crea la base en la UE:
   ```bash
   npx wrangler d1 create mcp-senuelo --jurisdiction eu
   ```
   Copia el `database_id` en la entrada `DB` de `wrangler.jsonc`.
3. Crea las tablas (aplica `0001` y `0002`):
   ```bash
   npx wrangler d1 migrations apply mcp-senuelo --remote
   ```
   En una base ya en producción, aplica la migración `0002_capabilities_redactions.sql` con
   ese mismo comando **antes** de `wrangler deploy`: el código nuevo escribe las columnas
   `capabilities` y `redactions`, y sin ellas fallarían todos los registros.
4. Despliega. Esto crea el registro DNS del dominio:
   ```bash
   npx wrangler deploy
   ```
5. Guarda la sal como secreto:
   ```bash
   openssl rand -hex 32 | npx wrangler secret put IP_SALT
   ```
6. Prueba contra el dominio:
   ```bash
   node scripts/test-client.mjs https://mcp.cribalo.com
   ```
   Las pruebas dejan filas en la base. Bórralas con un `DELETE` de las filas cuyo `user_agent`
   es `node` o empieza por `senuelo-`, y de las que tienen `purpose` o `client_version` que
   empiezan por `test-`.

Para consultar el registro:
```bash
node scripts/summary.mjs --remote --days 7
```
Opciones: `--days`, `--limit`.

Darlo de alta en directorios públicos de MCP es otro paso, que hará falta confirmar.

## RGPD

*Orientación práctica, no asesoramiento jurídico.*

- **¿Hay datos personales?** Sí, probablemente. Un hash de IP con sal sigue siendo un dato
  **seudonimizado** para quien tiene la sal, no anónimo (considerando 26 y art. 4.5). El
  User-Agent, el `clientInfo` y sobre todo el texto libre de `purpose` y de los argumentos
  pueden contener datos de una persona (por ejemplo, la tarea de un usuario de un agente). Hay
  que tratarlo todo como datos personales.
- **Responsable:** el titular. Antes de desplegar hay que rellenar `CONTACT`, porque el art. 13
  exige la identidad y el contacto del responsable.
- **Base jurídica:** interés legítimo (art. 6.1.f) en investigar cómo usan los agentes de IA los
  servidores MCP abiertos. Conviene dejar por escrito una ponderación breve: el interés, la
  necesidad, el impacto bajo (datos mínimos, seudonimizados, 90 días, sin elaboración de perfiles
  ni cesión) y las expectativas razonables (quien se conecta a un servidor que declara en cada
  herramienta que registra las llamadas). Si los resultados se publican, aplica además el
  art. 89: solo agregados, sin `purpose` literales que puedan identificar a alguien.
- **Información (art. 13):** la dan la página `/` (con la base jurídica, los derechos y la
  AEPD), la descripción de cada herramienta y las `instructions` del servidor.
- **Minimización:** los secretos y datos personales evidentes se ocultan antes de guardar (ver
  «Ocultación»); no se guarda la IP en claro, ni la query string, ni el cuerpo de las rutas
  no MCP; los campos van recortados. El servidor no pide sampling, elicitation ni roots, y no
  intenta sacar datos al agente o a su usuario.
- **Conservación:** 90 días con purga automática. Si se cambia la sal, las filas antiguas ya no
  se pueden enlazar con las nuevas.
- **Derechos (arts. 15–22):** sin la IP en claro, normalmente no se puede saber qué filas son de
  quién (art. 11). Si alguien aporta su IP y la hora, se puede calcular el hash y responder o
  borrar con `wrangler d1 execute`.
- **Encargado y transferencias:** Cloudflare procesa los datos como encargado (su DPA se acepta
  con la cuenta). La base en `--jurisdiction eu` guarda los datos en la UE, aunque el Worker se
  ejecuta en el centro de datos más cercano a quien llama. Cloudflare está adherida al EU-US
  Data Privacy Framework.
- **Registro de actividades (art. 30) y EIPD:** conviene una entrada breve en el registro. Con
  datos mínimos y seudonimizados no parece hacer falta una EIPD, pero esa decisión es del titular.

## Pendiente

- Revisar la retención (90 días) y el límite de peticiones (30/60 s) cuando haya datos.
- Alta en directorios públicos de MCP, con la confirmación del titular.
