// 校验 manifest：引擎 validateManifest（含标题层级跳级检查）+ 块类型 + 媒体文件存在性。
// 用法：node validate.mjs <manifest.json> [mediaRoot]   （mediaRoot 默认 = manifest 所在目录）
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestArg = process.argv[2];
if (!manifestArg) {
  console.error("usage: node validate.mjs <manifest.json> [mediaRoot]");
  process.exit(1);
}
const manifestPath = resolve(process.cwd(), manifestArg);
const mediaRoot = process.argv[3]
  ? resolve(process.cwd(), process.argv[3])
  : dirname(manifestPath);
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const { validateManifest } = await import(resolve(__dirname, "../src/lib/validate.ts"));

try {
  validateManifest(m);
  console.log("validateManifest: OK");
} catch (e) {
  console.error("validateManifest FAILED:");
  console.error(e.message);
  process.exit(1);
}

const ok = new Set(["paragraph", "list", "table", "callout", "grid", "image"]);
let bad = 0, missing = 0;
for (const s of m.sections) {
  for (const b of s.blocks ?? []) {
    if (!ok.has(b.kind)) { console.log("UNSUPPORTED kind:", s.title, b.kind); bad++; }
    const p = b.kind === "image" ? b.image?.path : b.kind === "grid" ? b.grid?.image?.path : null;
    if (p && !existsSync(resolve(mediaRoot, p))) { console.log("MISSING media:", p); missing++; }
  }
}
console.log(`sections=${m.sections.length} unsupported=${bad} missing_media=${missing}`);
if (bad || missing) process.exit(1);
console.log("ALL CHECKS PASS");
