# Lark-PMdoc

> 一个生成飞书（Lark）产品需求文档（PRD）的 Claude Code skill —— 从行文管线直达飞书在线文档。

**状态：v1 —— `feishu-prd` skill 已功能完整，并完成针对飞书 docx live API 的端到端验证。**

## 它做什么

`feishu-prd` skill 把产品需求输入转成结构化、行文讲究的 PRD，并通过飞书 docx block API 直接写入飞书文档。采用两层解耦架构：

- **内容生成层** —— 多模型、多 pass 的写前管线（取证 → 大纲 + 分节 brief → 分节起草 → 跨模型自批 → voice 统一）。决定**行文质量**。
- **飞书交付层** —— 飞书 docx block API 落地：表格、高亮块（callout）、左图右文分栏（grid）、图片（含 mermaid 渲染后的 PNG）、增量编辑。决定**能否进飞书**。

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

### 飞书交付层 —— 飞书 docx block API

- 两条渲染路径：markdown 创建（文本类块）+ 精确块更新（callout / grid / image）。
- 支持的 block 类型：paragraph、list、table、callout、grid（左图右文）、image。mermaid **预渲染成 PNG** 后以 image 块插入。
- 硬限严守：`create_children` ≤ 50 个 child / 次、`batch_update` ≤ 200 个 op / 次、编号确定性、分页 + 限流验收门（R1-R4）。

### 7 模块 PRD 骨架

文档信息 → 需求背景 → 需求清单 → 全局需求与规则 → 交互说明 → 数据埋点 → 附录。

## 仓结构

```
skills/feishu-prd/
  SKILL.md                     ← 先读这个
  content/                     ← 写前管线 + voice 规格 + 行文规范
  delivery/                    ← TypeScript 引擎（manifest → 飞书 docx）
  templates/                   ← PRD 骨架 + mermaid 模板 + 风格指南
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

## 许可

AGPL-3.0 —— 见 [LICENSE](./LICENSE)。

---

English docs: [README.md](./README.md).
