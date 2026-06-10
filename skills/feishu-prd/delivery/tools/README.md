# delivery/tools/ — 参数化 PRD 工具箱

每个工具接收项目 config JSON，把项目相关数据（章节表、黑白名单、预算、openId 等）与通用逻辑分离。

> **路径约定**：所有 config 内的相对路径均相对 **config 文件所在目录** 解析，工具代码按此约定实现。

---

## gen-manifest.py

**用途**：按章节 ORDER 拼装 `sections/full/chapter-NN.sections.json`，按 `diagrams` 表 splice 流程图，输出 `manifest.json`。

**用法**：
```bash
python3 gen-manifest.py <config.json>
```

**退出码**：0 = 成功写出 manifest；1 = 任何 FATAL 错误（文件缺失 / JSON 解析失败 / anchorKey 未找到）。

---

## validate.mjs

**用途**：交付前 manifest 校验——引擎 `validateManifest`（schema + 标题层级跳级检查）+ 块类型 + 媒体文件存在性。**gen-manifest 之后、deliver 之前必跑**。

**用法**：
```bash
node validate.mjs <manifest.json> [mediaRoot]   # mediaRoot 默认 = manifest 所在目录
```

**退出码**：0 = ALL CHECKS PASS；1 = 任何失败。

---

## verify.py

**用途**：五项机械验收——①过程产物清零 ②黑名单 ③字数预算 ④屏覆盖 ⑤截图引用。黑白名单、预算数字、屏清单路径全部从 config 读，逻辑一字不改。

**用法**：
```bash
python3 verify.py <config.json>
```

**退出码**：0 = 全 PASS；1 = 有失败项。

---

## wordcount.py

**用途**：统一字数口径统计（body / grid / table / callout / title / TOTAL）。接受单章 sections 数组或完整 manifest（自动检测）。

**用法**：
```bash
python3 wordcount.py <sections.json 或 manifest.json>
```

**退出码**：0 = 正常输出；1 = 错误。

---

## readback.py

**用途**：API 回读飞书文档全部 block，输出类型直方图并与 manifest 预期比对（headings / grid / image / callout / table 六项）。翻页走 `--params` 模式，含 token 重复断路（>30 页 abort）。

**用法**：
```bash
LARK_CLI_NO_PROXY=1 python3 readback.py <doc_id> <manifest.json>
```

⚠ 跑此工具时禁止并发任何其他 lark-cli 调用（会导致线程崩溃 + 触发限流）。

**退出码**：0 = READBACK PASS；1 = FAIL 或运行时错误。

---

## deliver.mjs

**用途**：调用 skill 引擎 `delivery/src/build-prd.ts` 将 manifest 交付为飞书文档。`expectedOpenId` 和 `folderToken` 从 config 读；manifest 路径走 argv。

**用法**：
```bash
LARK_CLI_NO_PROXY=1 node deliver.mjs <manifest.json> <config.json>
```

**退出码**：0 = 交付成功；1 = FATAL 错误。

---

## prd-project.example.json — config 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 文档标题（写入 manifest.title） |
| `sections_dir` | string | 章文件目录（chapter-NN.sections.json 所在，相对 config 目录） |
| `order` | string[] | 章号列表，gen-manifest 按此顺序拼装 |
| `file_pattern` | string | 章文件名模板（`{ch}` 占位符），默认 `chapter-{ch}.sections.json` |
| `img_dir` | string | 流程图图片目录（diagrams 非空时必填） |
| `diagrams` | object | anchorKey → `{file, caption}`；无流程图时置为 `{}` |
| `output` | string | gen-manifest 输出路径（相对 config 目录） |
| `budgets` | object | 章号 → 字数预算上限；无约束可置为 `{}` |
| `v_prev` | object | 章号 → 上一版字数（verify 减幅列用）；无对比置为 `{}` |
| `artifacts` | string[] | 过程产物正则列表（命中 = FAIL） |
| `blacklist` | string[] | 业务范围黑名单正则列表（本期不做的功能名） |
| `blacklist_99_extra_allowed` | string[] | 仅 ch99 附录中可自然名出现的黑名单条目 |
| `allowed` | string[] | 白名单子串（命中行跳过产物/黑名单检查） |
| `screen_inventory` | string | 屏 id 清单 JSON 路径（验收②屏覆盖；不需要则留空） |
| `screenshot_manifest` | string | 截图清单 JSON 路径（验收③截图引用；不需要则留空） |
| `diagram_files_allowed` | string[] | 流程图文件名（verify 截图引用检查时放行） |
| `expectedOpenId` | string | 交付断言用操作人 openId（deliver.mjs） |
| `folderToken` | string | 交付目标飞书文件夹 token（deliver.mjs） |
