# Delivery Cheatsheet — 飞书 docx 落地速查

交付层把一份 **delivery manifest**（见 `src/lib/manifest.ts`）渲染进飞书云文档。本表是落地时的速查：两条路径、块类型、API 硬约束、踩过的坑。

引擎入口：`buildPrd({ manifest, workspaceRoot, expectedOpenId, folderToken? })`（`src/build-prd.ts`）。运行 `node src/build-prd.ts`（Node ≥ 22.6 原生类型剥离，零运行时依赖）；类型检查 `npx tsc --noEmit`；测试 `npm test`。

## 两条交付路径

| 路径 | 用什么 | 负责什么 |
|---|---|---|
| **A · markdown** | `lark-cli docs +create --markdown -` | 文档主体：标题、段落、有序/无序列表、原生表格、超链接、内联样式。一次提交，云端转 block（自动兜底 ≤50/限流/分页）。 |
| **B · 精确 block** | `lark-cli api <METHOD> /open-apis/docx/v1/...` | markdown 表达不了的精确元素：callout、左图右文 grid、表格列宽。create 之后按章节标题锚定补插。 |
| **媒体** | `lark-cli docs +media-insert --type image\|file` | 图片/附件三步上传绑定（建空块→上传 media→替换）。 |

**为什么混合**：路径 A 一把梭省去手搓 block_map 与限流/分页；路径 B 只在 A 覆盖不到的元素上定点发力。引擎据此分工：`markdown.ts` 生成主体 → `createResilient` 建文档 → `blocks.ts` 按编号标题补插路径 B 块。

## 块类型表（实测，以此为准）

| type | 块 | type | 块 |
|---|---|---|---|
| 1 | root（block_id == doc_id） | 22 | divider |
| 2 | text（段落） | 24 | grid（分栏容器） |
| 3–9 | heading1–7 | 25 | grid_column（栏） |
| 12 | bullet（无序） | 27 | image |
| 13 | ordered（有序） | 31 | table |
| 19 | **callout**（≠ 34，旧文档表的 34 是错的） | 32 | table_cell |
| | | 43 | quote_container |

## 路径 A：markdown 能直接搞定的

- 标题 `#`–`#######`、段落、`-`/`1.` 列表、原生表格（表头行自动置位）。
- 超链接 `[文本](https://…)`、内联 **粗** *斜* `代码`。
- 表格、列表、标题层级——主体内容几乎都走这里，不必碰 block API。
- **锁 v1**：markdown 路径用 lark-cli 的 v1 API（接受废弃警告）。某些 lark-cli 版本 `--api-version v2` 是坏的，升级切 v2 前先回归测。

## 路径 B：精确 block 的 body（实测）

create 后文档顶层块按文档顺序排列；callout/grid/列宽都**按所属章节的编号标题锚定**再补插（`findBlockIdByText` 定位标题 → 在其后插入；每次插入前重新拉一遍顶层子级防 index 漂移）。

- **callout = 19**：
  ```jsonc
  { "block_type": 19,
    "callout": { "background_color": 1, "border_color": 1, "emoji_id": "pushpin" } }
  ```
  `background_color` 1–14，`border_color` 1–7，`emoji_id` 是短码（`pushpin`），**不是** unicode 字符。

- **grid 左图右文**：建 grid(24)+两个 column(25)，descendant 一次性塞进去；栏宽用**数组**：
  ```jsonc
  PATCH /blocks/{grid_id}
  { "update_grid_column_width_ratio": { "width_ratios": [40, 60] } }
  ```
  `column_id_to_width_ratio` 字典写法会报 99992402，别用。

- **表格列宽**：**逐列**改，每列一次请求：
  ```jsonc
  PATCH /blocks/{table_id}
  { "update_table_property": { "column_index": 0, "column_width": 120 } }
  ```

- **descendant 批量插入**：`POST /blocks/{parentId}/descendant {index, children_id, descendants}`，用临时 id 关联，返回 `block_id_relations` 拿真实 id。

- **图片三步**：建空 image 块(27) → multipart `POST /open-apis/drive/v1/medias/upload_all` 拿 file_token → `PATCH .../blocks/batch_update` 用 `replace_image {token,width,height}` 绑定。

## API 硬约束

- **create children ≤ 50 block/请求**（sheet block ≤ 5）——新建文档主流程卡这里。走 markdown 路径时云端已兜，手搓 block 时务必切块。
- **batch_update ≤ 200 block，且不支持 INSERT/DELETE 整块** → 新增走 create children，删除走 delete API，batch_update 只改已有块。
- **限流**：docx 写 3 QPS、上传 5 QPS（10000 calls/day）；同一 block 一次 batch 不能改多次。触发限流可能是文档级 HTTP 429，也可能是应用级 HTTP 400 + `99991400`——两者都要退避重试（引擎 `retry.ts` 已含）。
- **list blocks 默认 500 上限**，必须翻页（`has_more`/`page_token`）。
- **batch 原子性未知**：逐块校验返回，失败块单独补偿，别假设全成。

## 编号（D14，引擎确定性生成）

内容层产出的标题**不带序号**，由 `numbering.ts` 遍历标题树刷号：

- H1 → 一、二、三（中文）
- H2 → 全文连续 `1.` `2.` `3.`（**不随 H1 重起算**，有意可与 H1 不同步）
- H3 → `父H2号.子序`（1.1）；H4 → 1.1.1；H5 → 1.1.1.1

不交给 LLM 数数（防跨章节错位）。补插路径 B 块时就靠这个编号标题做锚点。

## mermaid

飞书**不渲染** mermaid。流程图/时序图先渲成 PNG 再走图片三步上传：

- 引擎侧 `resolveMermaidToImages(manifest, root, render)` 把每个 `mermaid` 块渲成 PNG 并改写成 `image` 块——`render` 是**注入式**的（`MermaidRenderFn`），引擎不内置任何渲染器/主机细节，按你本机的 mermaid 工具接线即可。
- 模板与风格见 `../templates/`（`flowchart.mmd` / `sequence.mmd` / `funnel.mmd` / `mermaid-config.json` / `mermaid-style-guide.md`）。

## 坑表

| 坑 | 说明 |
|---|---|
| callout 用 34 | 错。callout = **19**。 |
| grid 栏宽用字典 | 用**数组** `width_ratios:[L,R]`，字典写法 99992402。 |
| 表格列宽一次性传 | 列宽**逐列** PATCH，一列一次请求。 |
| 新建表格单元格出现两段 | `insert_table_row`/新建表后每格自带一个空 text 块，写完内容要把那个空块删掉。 |
| 把 docx 表格当多维表（Bitable） | docx 原生 table ≠ 多维表。需要数据库能力才用 Bitable，本 skill 只产 docx 表格。 |
| 直接用 wiki 节点 token 调 docx API | wiki 节点要先换 `obj_token` 才能当 document_id 用。 |
| 升 lark-cli 切 v2 | 某些版本 v2 是坏的，markdown 锁 v1；升级前回归测。 |
| 给交付层挂代理 | **不需要**。lark-cli 用自己的应用凭据直连飞书，交付层无需任何代理或特殊网络。 |

## manifest 形状

权威定义在 `src/lib/manifest.ts`（`PrdManifest`）。块种类：`paragraph` / `list` / `table`（可选 `columnWidths`）/ `callout` / `grid`（左图右文）/ `image` / `mermaid`（预处理转 image）。填空模板见 `../templates/prd-skeleton.json`。
