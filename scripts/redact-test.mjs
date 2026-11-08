// Unit tests for src/redact.ts. Run: node scripts/redact-test.mjs (needs Node >= 22.18 or 23.6 to import .ts).
import assert from "node:assert/strict";
import { redact } from "../src/redact.ts";

let passed = 0;
function hides(kind, input, expectedText) {
  const r = redact(input);
  assert.ok(r.kinds.includes(kind), `${kind} not detected in: ${input}`);
  assert.ok(r.text.includes(`[REDACTED:${kind}]`), `no marker for ${kind}: ${r.text}`);
  if (expectedText !== undefined) assert.equal(r.text, expectedText);
  passed++;
}
function keeps(input) {
  const r = redact(input);
  assert.deepEqual(r.kinds, [], `wrongly hidden (${r.kinds}): ${input} -> ${r.text}`);
  assert.equal(r.text, input);
  passed++;
}

// api_key
for (const k of [
  "sk-ant-api03-ABCDEFGHIJKLMNOP1234", "sk-proj-abcdefghijklmnop1234_-", "sk-abcdefghijklmnop1234",
  "AKIAIOSFODNN7EXAMPLE", "ghp_" + "a1".repeat(18), "github_pat_" + "A1_".repeat(12),
  "xoxb-1234567890-abcdefghij", "AIza" + "a1B_-".repeat(7), "glpat-abcdefghij1234567890"
]) hides("api_key", `key=${k} end`, "key=[REDACTED:api_key] end");
for (const n of ["sk-short", "task-force-abcdefghijklmnopqrst", "AKIA123", "ghp_short", "xoxb-1"]) keeps(n);
// bearer / jwt
hides("bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", "Authorization: [REDACTED:bearer]");
hides("bearer", "authorization: bearer abcdefghijklmnopqrstuvwxyz0123");
keeps("Bearer short");
keeps("the bearer of bad news");
hides("jwt", "t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghijk_-x;", "t=[REDACTED:jwt];");
keeps("eyJhbGci.short.x");
// private_key
hides("private_key", "a -----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY----- b", "a [REDACTED:private_key] b");
hides("private_key", "x -----BEGIN PRIVATE KEY-----\nMIIEvQ truncated, no end", "x [REDACTED:private_key]");
keeps("-----BEGIN CERTIFICATE-----\nMIIE\n-----END CERTIFICATE-----");
// email
hides("email", "write to bob.smith+x@mail.example.co.uk now", "write to [REDACTED:email] now");
keeps("not an email: @handle and a@b");
// home_path
hides("home_path", "/Users/alice/Documents/x.txt", "/Users/[REDACTED:home_path]/Documents/x.txt");
hides("home_path", "cat /home/bob/.bashrc", "cat /home/[REDACTED:home_path]/.bashrc");
hides("home_path", "C:\\Users\\Carol\\Desktop", "C:\\Users\\[REDACTED:home_path]\\Desktop");
hides("home_path", JSON.stringify({ p: "C:\\Users\\Carol\\Desktop" }), '{"p":"C:\\\\Users\\\\[REDACTED:home_path]\\\\Desktop"}');
keeps("https://example.com/home/page");
keeps("/usr/local/bin and /etc/passwd");
// card (Luhn)
hides("card", "pay 4111 1111 1111 1111 now", "pay [REDACTED:card] now");
hides("card", "4111-1111-1111-1111");
hides("card", "4111111111111111");
hides("card", "378282246310005"); // 15 digits, Amex test number
keeps("4111 1111 1111 1112"); // fails Luhn
keeps("123456789012"); // 12 digits
keeps("1731000000000"); // 13-digit epoch ms, no separators
keeps("2026-11-08T12:00:00.000Z");
keeps("550e8400-e29b-41d4-a716-446655440000"); // UUID
keeps("1".repeat(25)); // too long
// iban (mod 97)
hides("iban", "IBAN ES9121000418450200051332 ok", "IBAN [REDACTED:iban] ok");
hides("iban", "GB82 WEST 1234 5698 7654 32");
hides("iban", "DE89370400440532013000");
keeps("ES9121000418450200051333"); // bad checksum
keeps("HELLO12WORLD3456");
// dni / nie (check letter)
hides("dni", "mi DNI es 12345678Z, gracias", "mi DNI es [REDACTED:dni], gracias");
hides("dni", "NIE X1234567L y DNI 12345678-z");
keeps("pedido 12345678A");
keeps("ref X1234567A");
keeps("hash ab12345678Zq");
// phone
hides("phone", "llámame al +34 612 345 678 hoy", "llámame al [REDACTED:phone] hoy");
hides("phone", "tel:+34612345678");
hides("phone", "call 0044 20 7946 0958");
hides("phone", "(+1 415-555-0132)");
hides("phone", "fijo 91 123 45 67 o móvil 612-345-678");
keeps("server at 80.58.61.250 port 8080");
keeps("version 9.12.3 and v612.345.678");
keeps("id 612345678");
keeps("2026-11-08T17:22:47Z");
keeps("total 600 000 eur");
keeps("UTC+01:00 and +100 points");

// kinds list: distinct and sorted
{
  const r = redact("a@b.com c@d.org /Users/zed/x sk-abcdefghijklmnop1234");
  assert.deepEqual(r.kinds, ["api_key", "email", "home_path"]);
  passed++;
}
// non-overlap: already hidden text is not hidden again
{
  const once = redact("bob@example.com").text;
  assert.deepEqual(redact(once).kinds, []);
  passed++;
}
// speed on adversarial 32 KiB inputs
for (const [name, s] of [
  ["a-run", "a".repeat(32768)],
  ["digits", "1 ".repeat(16384)],
  ["dash-digits", "1-".repeat(16384)],
  ["sk-chain", "sk-".repeat(10900)],
  ["bearer-spaces", "Bearer" + " ".repeat(32000)],
  ["dots", "a.".repeat(16384) + "@"],
  ["begin-no-end", "-----BEGIN PRIVATE KEY-----".repeat(1200)],
  ["mixed", "ES91 2100 0418 4502 0005 1332 ".repeat(1000)]
]) {
  const t = performance.now();
  redact(s);
  const ms = performance.now() - t;
  assert.ok(ms < 100, `${name} took ${ms.toFixed(1)} ms`);
  console.log(`speed ${name}: ${ms.toFixed(1)} ms`);
  passed++;
}
console.log(`\n${passed} redact checks ok`);
