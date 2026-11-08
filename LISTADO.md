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

- **URL:** `https://mcp.cribalo.com/mcp` (Streamable HTTP, sin autenticación).
- **Categoría o etiquetas:** research, testing, security research. No usar «productivity», «database»
  ni nada que sugiera utilidad real.
- **Repositorio:** ninguno público por ahora. Si se publica el código, enlazarlo aquí.
