import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// Every tool is fake: no network access, no code execution, no real data.
// Responses say so in plain words; they never carry instructions for the agent.

const NOTICE =
  "Research server: calls are logged (time, hashed IP, client, tool, arguments, purpose). " +
  "Nothing is executed and all data is synthetic. Details: https://mcp.cribalo.com/";

const purpose = z
  .string()
  .min(1)
  .max(500)
  .describe("Briefly describe what you need this for (logged for research).");

const SYNTHETIC_FOOTER = "\n\n[Synthetic response from a research server. Nothing was executed.]";

function text(body: string) {
  return { content: [{ type: "text" as const, text: body + SYNTHETIC_FOOTER }] };
}

const SAMPLE_DOCS = [
  { id: "doc-001", title: "Quarterly planning notes (sample)", snippet: "Placeholder text for testing search clients." },
  { id: "doc-002", title: "Onboarding checklist (sample)", snippet: "Step 1: read the handbook. Step 2: set up your editor." },
  { id: "doc-003", title: "Glossary of terms (sample)", snippet: "MCP: Model Context Protocol. LLM: large language model." }
];

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "cribalo-research-mcp", version: "0.1.0" },
    {
      instructions:
        `${NOTICE} Each tool requires a 'purpose' argument; please describe your task honestly. ` +
        "There is no real data behind these tools."
    }
  );

  server.registerTool(
    "search_documents",
    {
      description: `Search a small index of sample documents. ${NOTICE}`,
      inputSchema: {
        query: z.string().max(500).describe("Search terms"),
        limit: z.number().int().min(1).max(10).optional(),
        purpose
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ query, limit }) => {
      const hits = SAMPLE_DOCS.slice(0, limit ?? 3);
      return text(`Results for "${query.slice(0, 100)}":\n${JSON.stringify(hits, null, 2)}`);
    }
  );

  server.registerTool(
    "fetch_url",
    {
      description: `Pretends to fetch a web page; it never contacts the URL. ${NOTICE}`,
      inputSchema: { url: z.string().max(2000).describe("URL to fetch"), purpose },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => text("The URL was not fetched. This server does not make outbound requests.")
  );

  server.registerTool(
    "query_database",
    {
      description: `Run a read-only SQL query against a tiny synthetic sample table 'customers'. ${NOTICE}`,
      inputSchema: { sql: z.string().max(2000).describe("SQL query"), purpose },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () =>
      text(
        "The query was not executed. Fixed sample rows:\n" +
          JSON.stringify(
            [
              { id: 1, name: "Example Ltd", country: "XX" },
              { id: 2, name: "Sample Inc", country: "YY" }
            ],
            null,
            2
          )
      )
  );

  server.registerTool(
    "get_exchange_rate",
    {
      description: `Return a placeholder exchange rate between two currencies (not real market data). ${NOTICE}`,
      inputSchema: {
        base: z.string().length(3).describe("ISO 4217 code, e.g. EUR"),
        quote: z.string().length(3).describe("ISO 4217 code, e.g. USD"),
        purpose
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ base, quote }) =>
      text(`${base.toUpperCase()}/${quote.toUpperCase()} = 1.0000 (placeholder, not a real rate)`)
  );

  server.registerTool(
    "execute_script",
    {
      description: `Pretends to run a script; it never executes anything. ${NOTICE}`,
      inputSchema: {
        language: z.enum(["python", "bash", "javascript"]).describe("Script language"),
        code: z.string().max(4000).describe("Source code"),
        purpose
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => text("Execution denied: this research server never runs code. Nothing was executed.")
  );

  server.registerTool(
    "read_file",
    {
      description: `Pretends to read a file; this server has no file system. ${NOTICE}`,
      inputSchema: { path: z.string().max(500).describe("File path"), purpose },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => text("Access denied: this research server has no file system. Nothing was read.")
  );

  return server;
}
