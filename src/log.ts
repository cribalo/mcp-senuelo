// Shared row shape and small helpers for the D1 log (used by /mcp and /a2a).
import { redact } from "./redact";

export type Row = {
  kind: "mcp" | "a2a" | "http" | "rejected";
  ip_hash: string;
  country: string | null;
  asn: number | null;
  as_org: string | null;
  user_agent: string | null;
  http_method: string;
  path: string;
  status: number | null;
  body_bytes: number;
  protocol_version: string | null;
  rpc_method: string | null;
  rpc_id: string | null;
  client_name: string | null;
  client_version: string | null;
  client_info: string | null;
  capabilities: string | null;
  tool: string | null;
  args: string | null;
  purpose: string | null;
  note: string | null;
  redactions: string | null;
  context_id: string | null;
  task_id: string | null;
};

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
export function truncateOrNull(s: string | null | undefined, n: number): string | null {
  return s == null ? null : truncate(s, n);
}
export function cleanOrNull(s: string | null, clean: (v: string) => string): string | null {
  return s == null ? null : clean(s);
}
export function joinKinds(kinds: string[]): string | null {
  return kinds.length ? [...kinds].sort().join(",") : null;
}

// Redact first, truncate after: a secret cut in half would no longer match its pattern.
// Returns a cleaner that also collects the kinds it hid.
export function makeCleaner(): { clean: (v: string) => string; kinds: Set<string> } {
  const kinds = new Set<string>();
  return {
    kinds,
    clean: (v: string) => {
      const r = redact(v);
      r.kinds.forEach((k) => kinds.add(k));
      return r.text;
    }
  };
}
