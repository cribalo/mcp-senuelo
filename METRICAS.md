# Métricas del primer informe — lista cerrada

Fijada el **8 nov 2026, antes de publicar el servidor en directorios** y antes de que haya
tráfico real. Lo que está aquí no cambia después de ver datos. Si un cambio fuera imprescindible,
se anota al final con fecha y motivo, y lo afectado pasa a exploratorio. El informe separa lo
**confirmatorio** (esta lista) de lo **exploratorio** (todo lo demás que se nos ocurra al mirar).

## Periodo y unidades

- **Periodo:** los 60 días siguientes al alta en el primer directorio (la fecha se anota abajo).
  Queda por debajo de la retención de 90 días.
- **Visitante:** mismo `ip_hash` y mismo `user_agent`. **Sesión:** peticiones de un visitante con
  huecos de menos de 30 min. Son aproximaciones: una IP compartida o un UA que cambia las rompen, y
  el informe lo dice.
- **Cliente declarado:** `clientInfo.name` tal cual lo manda el cliente (o heredado del último
  `initialize` del mismo visitante). Es una declaración, no una identificación: el informe dice
  siempre «declarado».
- **Fuera:** las filas de nuestras pruebas (UA `node`, `senuelo-*`, `purpose` o versión que empiezan
  por `test-`) y las peticiones a `/dash`, que no se registran.

## Preguntas y métricas confirmatorias

| # | Pregunta | Métrica |
|---|---|---|
| M1 | ¿Cuánto del tráfico es MCP? | % de peticiones con `kind = 'mcp'`; % de visitantes con algún mensaje MCP |
| M2 | ¿Cuántos que llegan usan el servidor? | Por visitante: cuántos llegan a `initialize`, a `tools/list` y a `tools/call`, con % sobre el total de visitantes y sobre los visitantes con algún mensaje MCP. No es un embudo en orden: los clientes sin estado (protocolo 2026-07-28) llaman sin `initialize` |
| M3 | ¿Quién se conecta? | Clientes declarados distintos; reparto de visitantes y de `tools/call` por cliente; versiones de protocolo |
| M4 | ¿Rellenan `purpose` con algo útil? | De las `tools/call`, % con `purpose` que no es trivial (más de 3 palabras y distinto del nombre de la herramienta o de un argumento); los clasifica a mano una persona con un esquema escrito antes de mirar: tarea de un usuario, prueba o desarrollo, escáner o automatismo, vacío o de relleno |
| M5 | ¿Llaman a herramientas peligrosas de un servidor desconocido? | % de visitantes con `tools/call` que llaman a `execute_script` o `read_file`, frente al % que llama a las otras cuatro; y qué piden (`language`, tipo de ruta) |
| M6 | ¿Filtran datos de su usuario? | % de `tools/call` con `redactions` no vacío, por tipo (`api_key`, `email`, `home_path`, etc.) y por cliente declarado |
| M7 | ¿Intentan SSRF o SQL peligroso? | % de llamadas a `fetch_url` con IP privada, de metadatos (`169.254.169.254`) o `file:`; % de `query_database` con `DROP`, `DELETE`, `UPDATE`, `INSERT` o varias sentencias |
| M8 | ¿Qué buscan los escáneres que conocen MCP? | Peticiones a `/.well-known/*`, `POST /`, `server/discover`, rutas con «mcp» distintas de `/mcp`, por tipo y por red (ASN) |
| M9 | ¿Qué anuncian los clientes? | Reparto de `capabilities` declaradas (`roots`, `sampling`, `elicitation`) por cliente declarado |

## Reglas del análisis

- **Solo descriptivo.** Conteos, porcentajes e intervalos de Wilson del 95 % para las proporciones.
  No hay contrastes de hipótesis: no hay una población de la que esto sea una muestra aleatoria, y
  el informe lo dice.
- **Grupos pequeños:** ninguna celda publicada con menos de 5 visitantes; se juntan en «otros». No se
  cruzan país, red, cliente y hora en una misma tabla.
- **Sin `purpose` literales identificables.** Como mucho, ejemplos parafraseados o recortados, revisados
  a mano para que no identifiquen a nadie.
- **Umbral de interpretación:** si en el periodo hay menos de **30 visitantes que lleguen a
  `tools/call`**, M4–M7 se publican como recuento de casos, sin porcentajes, y el informe se presenta
  como piloto. Un resultado de «casi nadie usa un MCP abierto» vale y se publica igual.
- **Escáneres:** M8 se publica aparte; no se mezcla con M2–M7.

## Exploratorio (no confirmatorio)

Sesiones (duración, peticiones por sesión), orden de los métodos, tiempo hasta la primera
`tools/call`, comparación entre directorios de origen y cualquier patrón que aparezca al mirar.

## Registro de cambios

- 8 nov 2026: versión inicial.
- Fecha de alta en el primer directorio: **8 nov 2026** (MCP Registry oficial, `com.cribalo/research-mcp`).
  El periodo de 60 días va del 8 nov 2026 al 7 ene 2027.
- 9 nov 2026: la portada `/` deja de llevar `noindex`, tiene sitemap y se da de alta en Google Search
  Console, Bing Webmaster Tools e IndexNow. No cambia ninguna métrica, pero desde esta fecha llegarán
  más visitas web (personas y rastreadores de buscadores). Eso baja el % de M1 sin que cambie el uso de MCP:
  el informe da M1 antes y después de esta fecha, además del total.
- 9 nov 2026: puertas de entrada por directorio (`/mcp/<directorio>`, lista fija en `src/entries.ts`),
  que sirven el mismo servidor y guardan su ruta. M8 («rutas con mcp distintas de `/mcp`») excluye
  ahora esas rutas cuando llegan como MCP (`kind = 'mcp'`), porque son el servidor y no un escaneo.
  Cualquier otra `/mcp/...` sigue siendo un 404 y cuenta en M8. Todavía no se había publicado ninguna puerta,
  así que no se ha perdido ningún dato. Aun así, M8 se interpreta con esta regla desde el principio.
  La comparación entre directorios sigue siendo exploratoria: el registro oficial y los agregadores
  que lo copian entran todos por `/mcp` y no se pueden separar.
- 9 nov 2026: solicitud de alta en API Tracker (`/mcp/apitracker`), pendiente de revisión editorial.
  Si la aprueban, se anota aquí la fecha de publicación.
