# Lark-PMdoc

> A Claude Code skill that generates Feishu (Lark) PRD documents — from a prose pipeline straight into a live docx.

**Status: under active development.** Full documentation lands with the first release.

## What it does

The `feishu-prd` skill turns a product brief into a structured, well-written PRD and publishes it directly into Feishu Docs via the docx block API. It is built as two decoupled layers:

- **Content layer** — a multi-model, multi-pass writing pipeline (research → outline + per-section briefs → per-section draft → cross-model self-critique → voice unification). This decides *how well it reads*.
- **Delivery layer** — Feishu docx block API rendering: tables, callouts, left-image-right-text grids, charts, and incremental edits. This decides *whether it lands in Feishu*.

## Install

_TBD on first release._

## License

AGPL-3.0 — see [LICENSE](./LICENSE).

---

中文文档见 [README.zh.md](./README.zh.md)。
