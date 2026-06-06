---
name: feishu-prd
description: >-
  端到端生成飞书（Lark）PRD（产品需求文档）：先用多模型写前管线把正文写得像人、可落地，再渲染进飞书云文档（docx），自动处理标题编号、表格、callout、左图右文、流程图。当用户要写 / 生成 / 重写一份 PRD 并交付到飞书（Lark），或要把需求材料整理成飞书文档时使用。Generate a Feishu/Lark PRD end to end — multi-model pre-writing pipeline for the prose, then render into a Feishu cloud doc with proper headings, tables, callouts and diagrams.
---

# feishu-prd — 飞书 PRD 生成

把「写一份能直接落地飞书的 PRD」拆成两层，分别做到位：**先写好，再落地**。

## 何时用

- 用户要**写 / 生成 / 重写**一份 PRD（产品需求文档 / 功能规格），并希望**产出在飞书（Lark）文档**里。
- 用户给了需求材料（口述、零散笔记、旧文档），要整理成一份结构化、可评审、能落地的飞书 PRD。
- 用户要给已有飞书 PRD 做增量修订。

不适用：纯本地 Markdown PRD 且不进飞书（那不需要交付层）；多维表格 / 通用飞书文档（未来的 `feishu-bitable` / `feishu-doc`）。

## 两层架构

```
内容生成层（content/）──产出 delivery manifest──▶ 交付层（delivery/）──▶ 飞书 docx
   决定行文质量                                       决定能否进飞书
```

| 层 | 在哪 | 干什么 | 产物 |
|---|---|---|---|
| **内容层** | `content/*.md` | 五步写前管线把正文写对、写得像人；只管行文，不碰飞书 API | 一份 **delivery manifest**（章节树 + 类型化块） |
| **交付层** | `delivery/`（TypeScript 引擎） | 照 manifest 把内容渲染进飞书 docx：markdown 主体 + 精确 block 补插 + 图片/图表上传 | 飞书文档（doc_id / doc_url） |

两层**正交解耦**：行文质量与能否落地分别演进。中间产物（研究笔记、brief、草稿）留在 workspace，**绝不跨层进交付稿**。

## 怎么用

### 第一步 · 内容层：把正文写出来

按 `content/pipeline.md` 的五步写前管线走（**质量杠杆在「写之前」**）：

1. **研究 / 取证** —— 多视角提问，建「主张 → 证据 → 来源」证据表。
2. **大纲 + 分节 brief** —— 先搭骨架，每个 H2 写一份起草说明书（主张 + 3-5 证据点 + 过渡 + 目标字数）。
3. **分节起草** —— 一次只做一节，只喂该节 brief + `voice-rubric.md`，窄上下文防跑题。
4. **跨模型自批（CoVe）** —— 批判者**必须 ≠ 起草者**，6 题引证回答→改写。这是质量增量最大的一步。
5. **拼接 + voice 统一 + 剥脚手架** —— 单一模型整篇收口，产出 **delivery manifest**。

行文规范看 `content/writing-rules.md`（特性叙述写法、反模式、交互状态表、计算算例、后台字段表、埋点独立成章、图表决策、Out of Scope）；语气规格看 `content/voice-rubric.md`（七维风格 + 正负例 + 自检清单）。

**标题不要自己编号**——编号由交付层确定性生成（H1 一/二/三、H2 全文连续 1./2./3.）。

### 第二步 · 交付层：把 manifest 落进飞书

manifest 形状的权威定义在 `delivery/src/lib/manifest.ts`；填空模板见 `templates/prd-skeleton.json`（7 模块骨架）。

```ts
import { buildPrd } from "./delivery/src/build-prd.ts";
const { doc_id, doc_url } = await buildPrd({
  manifest,                 // 内容层产出的 PrdManifest
  workspaceRoot,            // 解析图片/图表相对路径的根（断言防 ../ 逃逸）
  expectedOpenId,           // strict-mode 账号断言：当前 lark-cli 账号必须是这个 open_id
  folderToken,              // 可选：目标文件夹
});
```

运行：`node delivery/src/build-prd.ts`（Node ≥ 22.6 原生 TS 类型剥离，零运行时依赖）；类型检查 `npx tsc --noEmit`；测试 `npm test`。

含 mermaid 块时，先 `resolveMermaidToImages(manifest, workspaceRoot, render)` 预处理（飞书不渲染 mermaid，渲成 PNG 转 image 块）；`render` 是**注入式**的，按你本机的 mermaid 工具接线。

落地细节、块类型、API 硬约束、坑表全在 **`delivery/blocks-cheatsheet.md`**。

## 文件导航

```
feishu-prd/
  SKILL.md                     ← 你在这
  content/
    pipeline.md                五步写前管线 + 多模型路由 + CoVe 模板 + 剥脚手架
    voice-rubric.md            语气规格（七维 + 正负例 + 自检）
    writing-rules.md           行文规范（吸收自此前 PRD 行文积累）
  delivery/
    blocks-cheatsheet.md       落地速查（两路径 + 块类型 + 限流 + 坑表）
    src/                       TypeScript 引擎（manifest → 飞书 docx）
    package.json tsconfig.json
  templates/
    prd-skeleton.json          7 模块 PRD 骨架（填空）
    flowchart.mmd sequence.mmd funnel.mmd   mermaid 模板
    mermaid-config.json puppeteer-config.json mermaid-style-guide.md
```

## PRD 骨架（7 模块，前→后）

`templates/prd-skeleton.json` 已按此排好，填空即可：

1. **文档信息表**（文档名 / 版本 / 作者 / 状态 / 更新时间）
2. **需求背景**（问题 + 背景 + 目标）
3. **需求清单表**（需求名 / 描述 / 所属模块 / 优先级 P0-P3）—— 早列备查
4. **全局需求与规则说明**（贯穿多需求的通用规则；重点进 callout）
5. **交互说明**（关键流程；复杂流程配 mermaid 图）
6. **数据埋点**（事件 / 触发时机 / 参数 / 上报端，独立成章）
7. **附录**（必须可点开：飞书链接 / 可达 URL；**禁本地文件名**）

## 关键不变量（详见 cheatsheet）

- **编号交给引擎**，内容层标题不带序号（防 LLM 跨章节数错）。
- **callout = 19**（不是 34）；**grid 栏宽用数组** `[40,60]`；**表格列宽逐列**改。
- **create children ≤ 50 / 请求**；**markdown 锁 v1**；docx 表格 ≠ 多维表。
- **网络**：交付层用 lark-cli 自己的应用凭据**直连飞书，无需任何代理**。内容层若调用外部模型，按你本机的环境自行接线——本 skill 不内置任何主机/代理细节。
- **账号断言**：`buildPrd` 按 `expectedOpenId` 校验当前 lark-cli 账号（按 open_id，不看显示名）。

## 来源

行文规范与 mermaid 模板吸收自此前的 PRD 行文积累（验收标准齐全但缺生成管线、行文不达标）；本 skill 用 STORM 式五步写前管线补齐生成侧，并把交付从「手写 Markdown」升级为「引擎落地飞书 docx」。
