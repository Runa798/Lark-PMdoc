# -*- coding: utf-8 -*-
# 统一字数口径统计。
# 用法（单章）：python3 wordcount.py <chapter.sections.json>
# 用法（整份）：python3 wordcount.py <manifest.json>      （自动按 sections 字段检测）
# 退出码：0 = 正常输出；1 = 错误。
#
# 字数口径（与 wordcount-v43.py 完全一致，一字不改）：
#   body    = paragraph 文本 + list items
#   grid    = grid.blocks 中的 paragraph 文本与 list items
#   table   = header cells + row cells
#   callout = callout.lines
#   title   = 每个 section 的标题字符
#   TOTAL   = body + grid + table + callout + title
import json
import sys

if len(sys.argv) < 2:
    sys.exit("用法：python3 wordcount.py <sections.json 或 manifest.json>")


def grid_chars(g: dict) -> int:
    """统计 grid 右栏字符数（paragraph text + list items）。"""
    n = 0
    for b in g.get("blocks", []):
        if b.get("kind") == "paragraph":
            n += len(b.get("text", ""))
        elif b.get("kind") == "list":
            n += sum(len(item) for item in b.get("items", []))
    return n


def count_sections(secs: list) -> tuple[int, int, int, int, int, int]:
    """返回 (total, body, grid, table, callout, title)。"""
    body = grid = table = callout = title = 0
    for s in secs:
        title += len(s.get("title", ""))
        for b in s.get("blocks", []):
            k = b.get("kind")
            if k == "paragraph":
                body += len(b.get("text", ""))
            elif k == "list":
                body += sum(len(i) for i in b.get("list", {}).get("items", []))
            elif k == "table":
                t = b.get("table", {})
                table += sum(len(c) for c in t.get("header", [])) + sum(
                    len(c) for r in t.get("rows", []) for c in r
                )
            elif k == "callout":
                callout += sum(len(l) for l in b.get("callout", {}).get("lines", []))
            elif k == "grid":
                grid += grid_chars(b.get("grid", {}))
    total = body + grid + table + callout + title
    return total, body, grid, table, callout, title


with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)

# 自动检测：manifest（含 title + sections 键）还是裸 sections 数组
if isinstance(data, dict) and "sections" in data:
    secs = data["sections"]
elif isinstance(data, list):
    secs = data
else:
    sys.exit("FATAL: 输入文件既不是 manifest（含 sections 键的 dict）也不是裸 sections 数组")

total, body, grid, table, callout, title = count_sections(secs)
print(
    f"sections={len(secs)} body={body} grid={grid} table={table} "
    f"callout={callout} title={title} TOTAL={total}"
)
