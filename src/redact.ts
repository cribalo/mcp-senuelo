// Hides secrets and obvious personal data before anything is stored.
// Every pattern uses bounded quantifiers or is linear per start position: bodies are
// capped at 32 KiB and Workers Free allows ~10 ms of CPU.

const MARK = (kind: string) => `[REDACTED:${kind}]`;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanOk(s: string): boolean {
  const c = s.replace(/ /g, "");
  if (c.length < 15 || c.length > 34) return false;
  const rearranged = c.slice(4) + c.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    rem = (v > 9 ? rem * 100 + v : rem * 10 + v) % 97;
  }
  return rem === 1;
}

type Rule = { kind: string; re: RegExp; valid?: (m: string) => boolean; group?: boolean };

const RULES: Rule[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g },
  { kind: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer", re: /Bearer\s{1,20}[A-Za-z0-9._~+/=-]{20,}/gi },
  {
    kind: "api_key",
    re: new RegExp(
      [
        "(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}",
        "AKIA[0-9A-Z]{16}",
        "gh[pousr]_[A-Za-z0-9]{30,}",
        "github_pat_[A-Za-z0-9_]{30,}",
        "xox[abposr]-[A-Za-z0-9-]{10,}",
        "AIza[0-9A-Za-z_-]{35}",
        "glpat-[A-Za-z0-9_-]{20,}"
      ].join("|"),
      "g"
    )
  },
  {
    kind: "card",
    re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    valid: (m) => {
      const d = m.replace(/[ -]/g, "");
      // 13 bare digits look like an epoch in milliseconds; only accept 13 with separators.
      if (d.length < 13 || d.length > 19 || (d.length === 13 && d === m)) return false;
      return luhn(d);
    }
  },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, valid: ibanOk },
  {
    kind: "email",
    re: /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}/g
  },
  // Only the user name is hidden; the rest of the path is kept. The lookbehind avoids URLs like example.com/home/x.
  {
    kind: "home_path",
    re: /(?<![A-Za-z0-9.-])((?:\/Users\/|\/home\/|C:\\{1,2}Users\\{1,2}))([^\/\\\s"'<>:*?|[\]]{1,64})/gi,
    group: true
  }
];

export function redact(s: string): { text: string; kinds: string[] } {
  const kinds = new Set<string>();
  let text = s;
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args: any[]) => {
      const m = args[0] as string;
      if (rule.valid && !rule.valid(m)) return m;
      kinds.add(rule.kind);
      return rule.group ? (args[1] as string) + MARK(rule.kind) : MARK(rule.kind);
    });
  }
  return { text, kinds: [...kinds].sort() };
}
