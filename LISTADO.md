# Texto para los directorios de MCP (borrador, sin publicar)

Pensado para cumplir los términos del registro oficial (consultados el 8 nov 2026): nada que parezca
malicioso, ninguna afiliación falsa, un solo nombre, y que nadie lo tome por un servidor funcional
(su política de moderación retira los «no funcionales»). Se publica solo con la confirmación del
titular.

- **Nombre:** `cribalo-research-mcp` (el mismo de `McpServer` en `src/tools.ts`).
- **Título:** MCP Research Probe (synthetic tools)
- **Descripción corta (≤100 caracteres):**
  `Research server: fake, harmless tools that return synthetic data. Every call is logged.`
- **Descripción larga:**

  > This is a research server, not a working service. It studies which MCP clients and agents connect
  > to open MCP servers and what they say they want to do. Its six tools (search_documents, fetch_url,
  > query_database, get_exchange_rate, execute_script, read_file) are fake: nothing is executed,
  > fetched or read, and every response is labelled as synthetic. Each tool requires a `purpose`
  > field. Every call is logged (time, country and network, salted IP hash, User-Agent, clientInfo,
  > capabilities, methods, truncated arguments and purpose), obvious secrets and personal data are
  > removed before storage, and logs are deleted after 90 days. Only aggregated results are published.
  > Details and data protection notice: https://mcp.cribalo.com/

- **URL:** cada directorio recibe su propia puerta, para saber de dónde llega cada cliente
  (`src/entries.ts`; el mismo servidor, Streamable HTTP, sin autenticación):

  | Directorio | URL que se da de alta | Fecha de alta |
  |---|---|---|
  | Registro oficial (y agregadores que lo copian) | `https://mcp.cribalo.com/mcp` | 8 nov 2026 |
  | API Tracker (formulario, no pide repositorio) | `https://mcp.cribalo.com/mcp/apitracker` | enviado 9 nov 2026, en revisión (ref. fcd6dcde0ce02dcec38caefd) |
  | mcp.so | `https://mcp.cribalo.com/mcp/mcp-so` | |
  | Glama | `https://mcp.cribalo.com/mcp/glama` | |
  | MCP Market | `https://mcp.cribalo.com/mcp/mcp-market` | |
  | awesome-mcp-servers | `https://mcp.cribalo.com/mcp/awesome-mcp-servers` | |
  | mcpservers.org | `https://mcp.cribalo.com/mcp/mcpservers-org` | |
  | cursor.directory | `https://mcp.cribalo.com/mcp/cursor-directory` | |

  Cerrados (9 nov 2026): Smithery (desde el 31 oct 2026 lo lleva Arcade y no admite altas nuevas),
  PulseMCP y goose (se alimentan del registro oficial). Glama y API Tracker importan también el
  registro oficial; lo que llegue de ahí entra por `/mcp`.

  Para un directorio nuevo: añadirlo a `MCP_ENTRIES`, desplegar y luego darlo de alta.
  Al dar un alta, anotar la fecha en esta tabla y en el registro de cambios de `METRICAS.md`.
- **Categoría o etiquetas:** research, testing, security research. No usar «productivity», «database»
  ni nada que sugiera utilidad real.
- **Repositorio:** https://github.com/cribalo/mcp-senuelo (público desde el 9 nov 2026, sin licencia: todos los derechos reservados).
