// Standalone cross-reference pass for an already-built docx document.
//
// Use this when a full delivery run completed the create+path-B insertion
// phases but failed during the path-A ref rewrite pass (e.g. due to a doc
// materialization race or a now-fixed locator bug). Re-running the full
// delivery would create a duplicate doc; this tool resumes the ref pass
// against the existing one.
//
// Usage:
//   LARK_CLI_NO_PROXY=1 node tools/apply-refs.mjs <manifest.json> <doc_id> <doc_url>
//
// Behavior:
//   1. read the manifest
//   2. render numbered titles via renderManifestMarkdown (no markdown is sent)
//   3. poll the doc until block materialization is stable, then map
//      anchorId -> heading-block URL via buildAnchorUrlMapForDoc
//   4. invoke applyManifestRefs, treating path-B (callout / grid) refs as
//      already resolved during the prior build — those blocks were inserted
//      with their links baked in and are not re-touched by this pass
//   5. print refStats; exit 1 with diagnostics on failure
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.argv.length < 5) {
  console.error("Usage: node apply-refs.mjs <manifest.json> <doc_id> <doc_url>");
  process.exit(1);
}

const manifestPath = resolve(process.cwd(), process.argv[2]);
const docId = process.argv[3];
const docUrl = process.argv[4];

const MARKDOWN_MOD = resolve(__dirname, "../src/lib/markdown.ts");
const REF_PASS_MOD = resolve(__dirname, "../src/lib/ref-pass.ts");

// Count refs inside callout / grid blocks. During a normal build those refs
// are resolved by path-B insertion (links baked into the inserted blocks),
// so this standalone resume path must supply the same count to keep the
// post-pass `resolvedRefs === totalRefs` invariant honest. If the original
// build failed BEFORE path-B insertion, this count would be an overestimate
// and the FATAL message will still flag mismatched totals downstream.
function countPathBRefs(manifest) {
  const REF_RE = /\[\[ref:[^\]|]+\|[^\]]+\]\]/g;
  let n = 0;
  const inc = (s) => {
    if (typeof s !== "string") return;
    const matches = s.match(REF_RE);
    if (matches !== null) n += matches.length;
  };
  const walkPathB = (b) => {
    if (b.kind === "callout") {
      const lines = b.callout?.lines ?? (b.callout?.text !== undefined ? b.callout.text.split(/\r?\n/) : []);
      for (const l of lines) inc(l);
      return;
    }
    if (b.kind === "grid") {
      if (b.grid?.blocks !== undefined) {
        for (const rb of b.grid.blocks) {
          if (rb.kind === "paragraph") inc(rb.text);
          else if (rb.kind === "list") for (const it of rb.items) inc(it);
        }
      } else {
        const ps = b.grid?.paragraphs ?? (b.grid?.text !== undefined ? b.grid.text.split(/\r?\n/) : []);
        for (const p of ps) inc(p);
      }
    }
  };
  if (Array.isArray(manifest.preamble)) for (const b of manifest.preamble) walkPathB(b);
  for (const s of manifest.sections) for (const b of s.blocks) walkPathB(b);
  return n;
}

async function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  console.log(`Manifest:  ${manifestPath}`);
  console.log(`Title:     ${manifest.title}`);
  console.log(`Sections:  ${manifest.sections.length}`);
  console.log(`doc_id:    ${docId}`);
  console.log(`doc_url:   ${docUrl}`);

  const { renderManifestMarkdown } = await import(MARKDOWN_MOD);
  const { applyManifestRefs, buildAnchorUrlMapForDoc } = await import(REF_PASS_MOD);

  const { numbered } = renderManifestMarkdown(manifest);
  const numberedTitles = numbered.map((n) => n.numbered);

  const built = { doc_id: docId, doc_url: docUrl };

  console.log("\nBuilding anchorId -> URL map (polling for doc materialization)...");
  const anchorUrlMap = await buildAnchorUrlMapForDoc(manifest, built, numberedTitles);
  console.log(`Anchored sections mapped: ${anchorUrlMap.size}`);

  const pathBResolvedCount = countPathBRefs(manifest);
  console.log(`Path-B refs treated as already resolved: ${pathBResolvedCount}`);

  console.log("\nApplying ref pass...");
  const start = Date.now();
  const refStats = await applyManifestRefs({
    manifest,
    built,
    numberedTitles,
    anchorUrlMap,
    pathBResolvedCount,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== REF PASS COMPLETE (${elapsed}s) ===`);
  console.log(`totalRefs:     ${refStats.totalRefs}`);
  console.log(`resolvedRefs:  ${refStats.resolvedRefs}`);
  console.log(`patchedBlocks: ${refStats.patchedBlocks}`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message || e);
  if (e.detail) {
    const d = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
    console.error("Detail:", d.slice(0, 1500));
  }
  process.exit(1);
});
