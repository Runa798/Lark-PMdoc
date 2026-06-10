# Lark-PMdoc

> A Claude Code skill that generates Feishu (Lark) PRD documents — from a prose pipeline straight into a live docx.

**Status: v2 — battle-tested on two production-scale PRD runs (up to 347 sections / 125 grids / 131 images per doc), with a scaled-orchestration playbook, fill-in templates, and a parametrized acceptance toolchain. Greenfield dry-run verified: a fresh project can complete the full chain reading only skill files.**

## What it does

The `feishu-prd` skill turns a product brief into a structured, well-written PRD and publishes it directly into Feishu Docs via the docx block API. It is built as two decoupled layers:

- **Content layer** — a multi-model, multi-pass writing pipeline (evidence → outline + per-section briefs → per-section draft → cross-model self-critique → voice unification), plus a **scaled-orchestration playbook** for 10+-chapter PRDs: shared briefing as single source of truth, mechanical per-chapter specs, N parallel drafting agents, one consolidated fix wave. This decides *how well it reads*.
- **Delivery layer** — Feishu docx block API rendering: tables, callouts, left-image-right-text grids, images (incl. rendered mermaid), and incremental edits — plus a **parametrized acceptance toolchain** (`delivery/tools/`): gen-manifest → validate → wordcount → verify → deliver → readback histogram reconciliation. This decides *whether it lands in Feishu, verifiably*.

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

### Scaled orchestration (10+-chapter PRDs)

`content/pipeline.md` §6: baseline-first rewrite → batch decision sign-off → shared briefing (`templates/briefing-template.md`, methods referenced from skill files, project facts inlined) → per-chapter specs (`templates/chapter-spec-template.md`: char budget + screenshot authorization table + rewrite-point matrix) → N parallel drafting agents emitting bare `PrdSection[]` → orchestrator-side independent verification (never trust an agent's "self-checked" claim) → **one consolidated fix wave** (never patch-as-you-find). Writing rules that make this compressible without coverage loss (differential per-state writing, image-replaces-text, process-artifact zeroing, black/whitelist gating, per-chapter char budgets) live in `content/writing-rules.md` — a production rewrite went −39% chars with zero screen/state coverage loss under these rules.

### Delivery layer — Feishu docx block API

- Two rendering paths: markdown create (text-heavy blocks) and precision block update (callout / grid / image).
- Supported block kinds: paragraph, list, table, callout, grid (left-image-right-text, with rich right-column blocks), image. Mermaid is **pre-rendered to PNG** and inserted as image.
- Hard limits respected: ≤50 children per `create_children`, ≤200 ops per `batch_update`, deterministic numbering, heading-hierarchy validation (no level jumps), async-create recovery, pagination + rate-limit acceptance gates (R1-R4).
- `delivery/tools/`: project-config-driven acceptance chain — manifest assembly with diagram splicing, pre-flight validation, unified char counting, five mechanical verification gates (process-artifact zeroing / blacklist / budgets / screen coverage / screenshot references), post-delivery API readback with block-type histogram reconciliation. Delivery runbook and pitfall table in `delivery/blocks-cheatsheet.md`.

### 7-module PRD skeleton

document info → background → requirement list → global rules → interaction → telemetry → appendix.

## Repository layout

```
skills/feishu-prd/
  SKILL.md                     ← read this first
  content/                     ← writing pipeline (+§6 scaled orchestration) + voice rubric + writing rules (17 sections)
  delivery/                    ← TypeScript engine (manifest → Feishu docx)
    tools/                     ← parametrized acceptance toolchain (gen-manifest / validate / verify / wordcount / readback / deliver)
  templates/                   ← PRD skeleton + briefing & chapter-spec fill-in templates + mermaid templates
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
| Production-scale runs (commercial 10-chapter PRD: full rewrite 373 sections, then revision 347 sections / 125 grids / 131 images, −39% chars, zero coverage loss) | ✅ readback histogram PASS |
| `delivery/tools/` replay against production artifacts (manifest regen semantic-equal / verify line-identical / readback 6/6) | ✅ |
| Greenfield dry-run (fictional project, skill files only, full chain gen-manifest → validate → wordcount → verify) | ✅ all exit 0 |

## License

AGPL-3.0 — see [LICENSE](./LICENSE).

---

中文文档见 [README.zh.md](./README.zh.md)。
