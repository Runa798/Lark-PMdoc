# Lark-PMdoc

> 一个生成飞书（Lark）产品需求文档（PRD）的 Claude Code skill —— 从行文管线直达飞书在线文档。

**状态：v2 —— 经两轮生产级 PRD 工程实战检验（单文档最高 347 sections / 125 grid / 131 图），配齐规模化编排方法、填空模板与参数化验收工具链。已通过陌生项目 dry-run：新项目只读 skill 文件即可走通全链路。**

## 它做什么

`feishu-prd` skill 把产品需求输入转成结构化、行文讲究的 PRD，并通过飞书 docx block API 直接写入飞书文档。采用两层解耦架构：

- **内容生成层** —— 多模型、多 pass 的写前管线（取证 → 大纲 + 分节 brief → 分节起草 → 跨模型自批 → voice 统一），外加面向 10+ 章大型 PRD 的**规模化编排方法**：共用简报单一事实源、逐章 spec 机械生成、N 并行起草 + 单一修复波。决定**行文质量**。
- **飞书交付层** —— 飞书 docx block API 落地：表格、高亮块（callout）、左图右文分栏（grid，右栏支持富块）、图片（含 mermaid 渲染后的 PNG）、增量编辑，外加**参数化验收工具链**（`delivery/tools/`）：gen-manifest → validate → wordcount → verify → deliver → readback 直方图对账。决定**能否可验证地进飞书**。

## 在线演示

由本 skill 端到端生成的真实 PRD（P6 验收运行，2026-06-06）：

> [claude-deep-research CLI + Onboarding PRD](https://www.feishu.cn/docx/OkiadBdnWoQaRnxsbEFcs82Bn7f)

42 个章节、约 130 个 block、mermaid 流程图预渲染成 PNG，全部由一次 `node build.ts` 调用直接落到飞书 live API。

## 怎么工作

### 内容生成层 —— 五步写前管线

1. **取证** —— codex / CCG analyzer 按节取证，低幻觉的结构化 evidence table。
2. **大纲 + 分节 brief** —— Opus 做架构 pass。
3. **起草** —— Sonnet 主写，难节给 Opus；每章一份 Markdown 草稿。
4. **跨模型自批** —— 非作者模型做 Chain-of-Verification 自批，issue 列表按草稿 `file:line` 定位。
5. **Voice 统一** —— Opus 单趟统稿：剥脚手架、修语气漂移、保章节间一致。

### 规模化编排（10+ 章大型 PRD）

见 `content/pipeline.md` §6：基线先行反写 → 批量拍板 → 共用简报（`templates/briefing-template.md`，方法引用 skill 文件、项目事实内联）→ 逐章 spec（`templates/chapter-spec-template.md`：字数预算 + 截图授权表 + 改写点矩阵）→ N 并行子任务产出裸 `PrdSection[]` → 编排者独立复核（绝不信「已自检通过」声明）→ **单一修复波**（绝不发现一个补一个）。支撑压缩的写法（差异式逐态、图代文、过程产物清零、黑白名单、逐章预算）在 `content/writing-rules.md`——一轮生产级重写在零屏/态覆盖损失下压掉 39% 字符。

### 飞书交付层 —— 飞书 docx block API

- 两条渲染路径：markdown 创建（文本类块）+ 精确块更新（callout / grid / image）。
- 支持的 block 类型：paragraph、list、table、callout、grid（左图右文，右栏支持富块）、image。mermaid **预渲染成 PNG** 后以 image 块插入。
- 硬限严守：`create_children` ≤ 50 个 child / 次、`batch_update` ≤ 200 个 op / 次、编号确定性、标题层级跳级校验、异步建档恢复、分页 + 限流验收门（R1-R4）。
- `delivery/tools/`：项目 config 驱动的验收链 —— manifest 拼装（含流程图 splice）、交付前校验、统一字数口径、五项机械验收门（过程产物清零 / 黑名单 / 预算 / 屏覆盖 / 截图引用）、交付后 API 回读直方图对账。交付 runbook 与坑表见 `delivery/blocks-cheatsheet.md`。

### 7 模块 PRD 骨架

文档信息 → 需求背景 → 需求清单 → 全局需求与规则 → 交互说明 → 数据埋点 → 附录。

## 仓结构

```
skills/feishu-prd/
  SKILL.md                     ← 先读这个
  content/                     ← 写前管线（+§6 规模化编排）+ voice 规格 + 行文规范（17 节）
  delivery/                    ← TypeScript 引擎（manifest → 飞书 docx）
    tools/                     ← 参数化验收工具链（gen-manifest / validate / verify / wordcount / readback / deliver）
  templates/                   ← PRD 骨架 + 共用简报/逐章 spec 填空模板 + mermaid 模板
LICENSE                        ← AGPL-3.0
```

## 安装与使用

前置：

- Node ≥ 22.6（原生 TypeScript type-stripping；交付层引擎运行时零依赖）。
- 飞书应用凭据（已为 [lark-cli](https://github.com/larksuite/oapi-cli) 配置好）。
- 装有 Claude Code 且能路由到 skills 的开发环境。

本 skill 由 Claude Code 通过 SKILL.md 路由自动调用 —— 完整使用契约（触发时机、五步管线调用点、交付层握手）见 `skills/feishu-prd/SKILL.md`。

## 验证状态

| 阶段 | 状态 |
|---|---|
| 交付层 R1-R4 验收（create ≤ 50 / batch ≤ 200 / 分页 / 限流） | ✅ |
| 端到端 PRD 生产（P6 —— codex+Sonnet+Opus 管线 + 飞书交付） | ✅ 真飞书 docx |
| 生产级实战（某商业化 10 章 PRD：全量重写 373 sections，再修订 347 sections / 125 grid / 131 图，−39% 字符、零覆盖损失） | ✅ 回读直方图 PASS |
| `delivery/tools/` 真实产物回放（manifest 重生成语义相等 / verify 逐行一致 / readback 6/6） | ✅ |
| 陌生项目 dry-run（虚构项目、只读 skill 文件、gen-manifest → validate → wordcount → verify 全链路） | ✅ 全部 exit 0 |

## 许可

AGPL-3.0 —— 见 [LICENSE](./LICENSE)。

---

English docs: [README.md](./README.md).
