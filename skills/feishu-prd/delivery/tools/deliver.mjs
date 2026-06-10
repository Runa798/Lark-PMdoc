// 通用飞书 PRD 交付脚本。
// 用法：LARK_CLI_NO_PROXY=1 node deliver.mjs <manifest.json> <config.json>
//   manifest.json  - 要交付的 manifest（相对调用目录或绝对路径）
//   config.json    - 项目 config（含 expectedOpenId、folderToken 字段）
// 退出码：0 = 交付成功；1 = FATAL 错误。
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.argv.length < 4) {
  console.error("用法：node deliver.mjs <manifest.json> <config.json>");
  process.exit(1);
}

const manifestPath = resolve(process.cwd(), process.argv[2]);
const configPath = resolve(process.cwd(), process.argv[3]);

// 引擎入口：相对 skill 仓内部路径（delivery/tools/ -> delivery/src/build-prd.ts）
const ENGINE = resolve(__dirname, "../src/build-prd.ts");

async function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));

  const expectedOpenId = cfg.expectedOpenId ?? "";
  const folderToken = cfg.folderToken ?? "";
  // workspaceRoot：manifest 所在目录，供引擎解析相对媒体路径
  const workspaceRoot = dirname(manifestPath);

  console.log(`Title:          ${manifest.title}`);
  console.log(`Sections:       ${manifest.sections.length}`);
  console.log(`expectedOpenId: ${expectedOpenId || "(not set)"}`);
  console.log(`folderToken:    ${folderToken || "(not set)"}`);

  let g = 0, i = 0, c = 0, t = 0;
  for (const s of manifest.sections) {
    for (const b of s.blocks) {
      if (b.kind === "grid") g++;
      if (b.kind === "image") i++;
      if (b.kind === "callout") c++;
      if (b.kind === "table") t++;
    }
  }
  console.log(`Blocks:         ${g} grids, ${i} images, ${c} callouts, ${t} tables\n`);

  const { buildPrd } = await import(ENGINE);
  console.log("Starting delivery...");
  const start = Date.now();
  const result = await buildPrd({
    manifest,
    workspaceRoot,
    ...(expectedOpenId ? { expectedOpenId } : {}),
    ...(folderToken ? { folderToken } : {}),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== DELIVERY COMPLETE (${elapsed}s) ===`);
  console.log(`doc_id:  ${result.doc_id}`);
  console.log(`doc_url: ${result.doc_url}`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message || e);
  if (e.detail) {
    const d = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
    console.error("Detail:", d.slice(0, 1500));
  }
  process.exit(1);
});
