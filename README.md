# mcp-senuelo — servidor MCP de investigación

Servidor MCP público y abierto, en Cloudflare Workers, cuyas herramientas son falsas e inofensivas.
Sirve para registrar **qué clientes y agentes se conectan a un MCP abierto y a qué dicen venir**
(campo obligatorio `purpose`). Lo dice abiertamente en cada herramienta, en las `instructions`
del servidor y en la página `/`.

Estado: **probado en local, sin desplegar.** El despliegue, el registro DNS y el alta en
directorios públicos de MCP esperan la confirmación del titular.

## Arquitectura

```
cliente MCP ──HTTPS──▶ Worker (mcp.cribalo.com)
                        ├─ límite: 30 peticiones/60 s por IP con hash (binding ratelimits) → 429
                        ├─ cuerpo > 32 KiB → 413 (se registra como 'rejected')
                        ├─ /mcp  → createMcpHandler (agents) + McpServer (SDK v2), sin estado
                        ├─ /     → página que explica el servidor
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
- **Herramientas** (`src/tools.ts`): `search_documents`, `fetch_url`, `query_database` y
  `get_exchange_rate`. Ninguna hace peticiones de red ni ejecuta nada (`fetch_url` no llama a
  la URL y `query_database` no ejecuta el SQL). Devuelven datos de muestra fijos con la etiqueta
  «Synthetic response… Nothing was executed». Cada una exige `purpose` (de 1 a 500 caracteres),
  y su descripción dice que las llamadas se registran. Las respuestas no llevan instrucciones
  para el agente.
- **Origin:** el SDK rechaza (403) las peticiones de navegador desde otros dominios, para que
  ninguna web pueda usar el navegador de sus visitantes contra `/mcp`.

## Qué se guarda (tabla `events`, `migrations/0001_init.sql`)

| Campo | Contenido |
|---|---|
| `ts`, `kind` | hora UTC; `mcp`, `http` (otras rutas) o `rejected` (413) |
| `ip_hash` | HMAC-SHA256 de la IP con la sal secreta `IP_SALT`, truncado a 16 hex. **La IP en claro no se guarda** |
| `country`, `asn`, `as_org` | país y red según `request.cf` |
| `user_agent`, `http_method`, `path`, `status`, `body_bytes` | ruta **sin** query string |
| `protocol_version`, `rpc_method`, `rpc_id` | por cada mensaje JSON-RPC (como mucho 20 por lote) |
| `client_name`, `client_version`, `client_info` | `clientInfo` |
| `tool`, `args`, `purpose` | herramienta, argumentos sin `purpose` y `purpose` aparte |

Límites: `MAX_FIELD_CHARS` (2000) para argumentos, `purpose` y `clientInfo`, y 500 para el
User-Agent. Del cuerpo de las rutas no MCP solo se guarda el tamaño. Las peticiones cortadas por
el límite (429) no se registran, para que una avalancha no agote las escrituras diarias de D1.
Sin la sal `IP_SALT`, el campo vale `no-salt`: un hash de IPv4 sin sal se invierte enseguida.

**Retención:** 90 días (`RETENTION_DAYS`). La purga corre a diario con un cron. Workers Logs
está desactivado (`observability.enabled: false`), así que D1 es el único registro.

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

`npm test` (`scripts/test-client.mjs`) prueba lo siguiente:

- la página `/` y un 404 de ruta de escáner;
- un cliente del SDK con el protocolo actual: lista de herramientas, todas con `purpose`
  obligatorio y aviso de registro, y respuestas sintéticas;
- que `fetch_url` no hace la petición y que una llamada sin `purpose` se rechaza;
- un cliente de 2025 con peticiones a mano;
- el 413 por cuerpo grande y el 403 por Origin ajeno;
- que las filas llegan a D1: `clientInfo`, `purpose` separado de `args` y `ip_hash` en hexadecimal.

`--rate-limit` añade la comprobación del 429.

Resultado el 8 nov 2026: 12 de 12 pruebas pasan, y la purga del cron, probada con
`/cdn-cgi/handler/scheduled`, borra una fila de 2020 y conserva las recientes.

## Desplegar (lo hace el titular; **cada paso con su confirmación**)

1. Inicia sesión en Cloudflare (lo hace el titular):
   ```bash
   npx wrangler login
   ```
2. Crea la base en la UE:
   ```bash
   npx wrangler d1 create mcp-senuelo --jurisdiction eu
   ```
   Copia el `database_id` en `wrangler.jsonc`.
3. Crea las tablas en remoto:
   ```bash
   npx wrangler d1 migrations apply mcp-senuelo --remote
   ```
4. Guarda la sal como secreto. Usa una cadena aleatoria larga y no la guardes en el repositorio:
   ```bash
   openssl rand -hex 32 | npx wrangler secret put IP_SALT
   ```
5. Pon una dirección de contacto en `vars.CONTACT` de `wrangler.jsonc`: el RGPD exige
   identificar al responsable (véase abajo).
6. `npx wrangler deploy`. Publica el Worker en `mcp-senuelo.<cuenta>.workers.dev`.
7. **Dominio:** descomenta `routes` (`mcp.cribalo.com`, `custom_domain: true`) y vuelve a
   desplegar. Cloudflare crea el registro DNS y el certificado. Falla si ya existe un CNAME con
   ese nombre.
8. Consulta el registro:
   ```bash
   node scripts/summary.mjs --remote --days 7
   ```
   Opciones: `--days`, `--limit`.

Darlo de alta en directorios públicos de MCP es otro paso, también con confirmación.

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
- **Minimización:** no se guarda la IP en claro, ni la query string, ni el cuerpo de las rutas
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

## Pendiente antes de desplegar

- Rellenar `CONTACT` (sin él la página no muestra contacto y no cumple el art. 13).
- Decidir la retención (90 días por defecto) y el límite de peticiones (30/60 s).
- Confirmar el despliegue, el DNS de `mcp.cribalo.com` y, más adelante, el alta en directorios.
