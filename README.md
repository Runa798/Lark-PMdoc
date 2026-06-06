# Lark-PMdoc

> A Claude Code skill that generates Feishu (Lark) PRD documents — from a prose pipeline straight into a live docx.

**Status: v1 — `feishu-prd` skill is feature-complete and validated end-to-end against the live Feishu docx API.**

## What it does

The `feishu-prd` skill turns a product brief into a structured, well-written PRD and publishes it directly into Feishu Docs via the docx block API. It is built as two decoupled layers:

- **Content layer** — a multi-model, multi-pass writing pipeline (evidence → outline + per-section briefs → per-section draft → cross-model self-critique → voice unification). This decides *how well it reads*.
- **Delivery layer** — Feishu docx block API rendering: tables, callouts, left-image-right-text grids, images (incl. rendered mermaid), and incremental edits. This decides *whether it lands in Feishu*.

## Live demo

A real PRD generated end-to-end by this skill (P6 acceptance run, 2026-06-06):

> [claude-deep-research CLI + Onboarding PRD](https://www.feishu.cn/docx/OkiadBdnWoQaRnxsbEFcs82Bn7f)

42 sections, ~130 blocks, mermaid flowchart pre-rendered to PNG, all delivered in a single `node build.ts` call against the Feishu live API.

## How it works

### Content layer — 5-step writing pipeline

1. **Evidence gathering** — codex/CCG analyzer per section, low-hallucination structured evidence table.
2. **Outline + per-section brief** — Opus, architectural pass.
3. **Drafting** — Sonnet primary, Opus for hard sections; one Markdown draft per chapter.
4. **Cross-model critique** — non-author model self-critique with Chain-of-Verification, table-form issue list keyed to draft `file:line`.
5. **Voice unification** — single Opus pass; strip scaffolding, fix tone drift, ensure inter-chapter consistency.

### Delivery layer — Feishu docx block API

- Two rendering paths: markdown create (text-heavy blocks) and precision block update (callout / grid / image).
- Supported block kinds: paragraph, list, table, callout, grid (left-image-right-text), image. Mermaid is **pre-rendered to PNG** and inserted as image.
- Hard limits respected: ≤50 children per `create_children`, ≤200 ops per `batch_update`, deterministic numbering, pagination + rate-limit acceptance gates (R1-R4).

### 7-module PRD skeleton

document info → background → requirement list → global rules → interaction → telemetry → appendix.

## Repository layout

```
skills/feishu-prd/
  SKILL.md                     ← read this first
  content/                     ← writing pipeline + voice rubric + writing rules
  delivery/                    ← TypeScript engine (manifest → Feishu docx)
  templates/                   ← PRD skeleton + mermaid templates + style guides
LICENSE                        ← AGPL-3.0
```

## Install & use

Prerequisites:

- Node ≥ 22.6 (native TypeScript type-stripping; the delivery engine has zero runtime dependencies).
- Feishu app credentials configured for [lark-cli](https://github.com/larksuite/oapi-cli).
- A Claude Code installation that can route to skills.

The skill is consumed by Claude Code via SKILL.md routing — see `skills/feishu-prd/SKILL.md` for the full usage contract (when to invoke, 5-step pipeline call sites, delivery handoff).

## Validation status

| Stage | Status |
|---|---|
| Delivery layer R1-R4 acceptance (create ≤ 50 / batch ≤ 200 / pagination / rate-limit) | ✅ |
| End-to-end PRD production (P6 — codex+Sonnet+Opus pipeline + Feishu delivery) | ✅ live Feishu docx |

## License

AGPL-3.0 — see [LICENSE](./LICENSE).

---

中文文档见 [README.zh.md](./README.zh.md)。
