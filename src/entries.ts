// Per-directory entry points: the same MCP server at /mcp/<slug>, so the logged path says which
// listing a client came from. Only this fixed list is served; any other /mcp/... is a 404 (scanner).
export const MCP_ENTRIES = [
  "apitracker", "mcp-so", "glama", "mcp-market", "awesome-mcp-servers", "mcpservers-org", "cursor-directory"
] as const;

const PATHS = new Set<string>(["/mcp", ...MCP_ENTRIES.map((s) => `/mcp/${s}`)]);
export const isMcpEntry = (path: string) => PATHS.has(path);
