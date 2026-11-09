// Tell IndexNow search engines (Bing, Yandex, Seznam, Naver…) that the public page changed.
// Run after a deploy: npm run indexnow. Sends only the public URLs below, nothing else.
import { readFileSync } from "node:fs";

const HOST = "mcp.cribalo.com";
const URLS = [`https://${HOST}/`, `https://${HOST}/llms.txt`];
const key = /INDEXNOW_KEY = "([0-9a-f]{32})"/.exec(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"))[1];

const live = await fetch(`https://${HOST}/${key}.txt`);
if (!live.ok || (await live.text()).trim() !== key) {
  console.error(`The key file is not live at https://${HOST}/${key}.txt: deploy first.`);
  process.exit(1);
}
const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: URLS })
});
console.log(`IndexNow: HTTP ${res.status} ${res.status === 200 || res.status === 202 ? "(accepted)" : await res.text()}`);
if (res.status !== 200 && res.status !== 202) process.exitCode = 1;
