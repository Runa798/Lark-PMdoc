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

## 内链（[[ref:]] 交叉引用）

- 写法：任意 inline 文本里 `[[ref:anchorId|显示文本]]`；anchorId 来自目标 section 的 `anchorId` 字段（建议所有 section 都带）。
- 解析：交付时引擎先等文档物化（轮询：顶层标题数达标 + 总块数稳定，10s × 30），再按「编号后标题 → heading block_id」建 anchorId → URL 映射；URL 形如 `docUrl#blockId`，**原样存储、不做 percent-encode**（飞书服务端原样保存 URL，编码过的反而无法跳转）。
- 路径 B 块（callout / grid 内文本）的 ref 在插入时直接生成带链接的 text_run；路径 A 块（段落 / 列表 / 表格单元格）先以纯文本落地，交付尾段按「渲染后明文」匹配定位再 PATCH 回写链接——manifest 里的 `**` 与成对反引号在文档中是样式不是字符，匹配时已剥离；落单 `*` 按字面保留。
- ref 可与 `**粗体**`、行内代码（成对反引号）共存（含双向嵌套）；与其它行内标记混用会直接 FAIL 拒绝重建——先扩展解析器再把这种组合写进 manifest。
- 任何未解析 ref = 构建 FAIL（fail-hard）。
- 续跑：文档已建好但链接未打上（或 ref pass 中途失败）时，跑 `delivery/tools/apply-refs.mjs <manifest.json> <doc_id> <doc_url>` 单独补打 ref pass，无需整篇重交付。

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

---

## 交付 runbook（大文档交付操作序）

### 交付前

- **代理环境**：若宿主环境设有全局代理变量（`HTTPS_PROXY` 等），lark-cli 会检测并使用，导致 EOF 错误。必须在调用前设 `LARK_CLI_NO_PROXY=1`。交付层只需应用凭据直连飞书，无需任何代理。
- **线程配额**：在 pid/线程数受限的执行环境（如容器 cgroup 限额接近上限）运行 Go 或 Node CLI 时，加 `GOMAXPROCS=2 UV_THREADPOOL_SIZE=2` 降低线程申请量，可在紧张配额下存活。
- **manifest 校验**：交付前先跑 `validate`（`src/lib/validate.ts` 或等价校验脚本）。重点检查**标题层级跳级（LEVEL JUMP）**：H4 出现前必须先有 H3，引擎遇到跳级会 FATAL 退出。校验通过再启动正式交付，杜绝半成品 doc 产生。

### 交付中

- **禁止并发**：正式交付进行期间，**绝不并发任何其他 lark-cli 调用**（含查询）。实测并发会触发线程崩溃和 `99991400` 限流，导致部分块丢失或文档损坏。
- **耗时预期**：百节+大量图片的文档，单次交付耗时在分钟级（实测 700–1000 秒），属正常。中途不要因为"没有输出"就中断。

### 失败处置（partial doc 协议）

交付中断会在飞书留下半成品文档（含全量 markdown 但缺媒体或块不完整）。

**处置流程**：

1. 不修补、不续写 partial doc。
2. 按 doc token 删除：
   ```
   lark-cli api DELETE "/open-apis/drive/v1/files/{token}" --params '{"type":"docx"}'
   ```
3. 从头重跑完整交付流程。

瞬时错误（如 `code 2200` token scope 超限）：先单独重试一次，若仍失败再深查原因。

### 交付后验收

- **API 回读对账**：交付完成后，用 API 回读文档全量 block，做类型直方图并与 manifest 预期比对。对账六项：`headings`（= sections 数）、`grid`、`grid_column`（= grid × 2）、`image`（grid 内 + 独立）、`callout`、`table`。
- **翻页必须用 `--params` 传 page_token JSON**：page_token 含非 ASCII 字符，裸拼 URL 参数不编码，会永远返回第一页，形成死循环。正确做法：
  ```
  lark-cli api GET "/open-apis/docx/v1/documents/{doc_id}/blocks" \
    --params '{"page_size":500,"page_token":"<token>"}'
  ```
  同时加页数上限（如 `pages > 30` 时 abort）和 token 重复检测断路，防止死循环静默跑完。

---

## 内容生产坑表（增补）

| 坑 | 说明 |
|---|---|
| 一次性大 Write 超时断连 | 大段文本写入（经验阈值 ≈ 单次 200+ 行 / 8KB）会触发 socket 超时断连，任务中断。**分段写入**：先写骨架，再逐段 Edit 补齐，每段 ≤ 150 行 / 几 KB。 |
| 用文档声明数字当计数权威 | 屏/态/图等数量口径以**渲染实测**（vm 沙箱真执行脚本代码，或等价的 DOM 统计）为权威。文档里写定的数字可能是旧口径或估算，两轮交付都靠实测纠正过。不要拿文档里声明的数字直接写进验收基线。 |
| 标题层级跳级 | H4 出现前必须先有 H3（即层级深度每次最多 +1）。这是引擎硬约束（已上游进 validate），但动笔分章时仍要避免"L2 直挂 L4"的结构，否则必须修层级才能通过校验。 |
| 特殊页面 selector 假设统一容器 | 动态生成内容的特殊屏（如 sitemap 从全局变量渲染卡片网格），其容器 selector 与标准产品屏不同。截图/harness 脚本不要假设全站容器统一，针对此类屏单独处理 selector 和依赖注入。 |
