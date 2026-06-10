# -*- coding: utf-8 -*-
# API 回读验收：读取飞书文档全部 block，输出类型直方图并与 manifest 预期比对。
# 用法：LARK_CLI_NO_PROXY=1 python3 readback.py <doc_id> <manifest.json>
# 退出码：0 = READBACK PASS；1 = READBACK FAIL 或运行时错误。
import json
import subprocess
import sys

if len(sys.argv) < 3:
    sys.exit("用法：python3 readback.py <doc_id> <manifest.json>")

doc_id = sys.argv[1]
manifest_path = sys.argv[2]

TYPE_NAMES = {
    1: "page", 2: "text", 3: "h1", 4: "h2", 5: "h3", 6: "h4", 7: "h5", 8: "h6",
    12: "bullet", 13: "ordered", 19: "callout", 22: "divider",
    24: "grid", 25: "grid_column", 27: "image", 31: "table", 32: "table_cell",
}

# ------- 翻页拉取全部 block -------
blocks = []
page_token = ""
seen_tokens: set[str] = set()
pages = 0

while True:
    pages += 1
    if pages > 30:
        sys.exit("FATAL: >30 pages, abort")
    if page_token:
        if page_token in seen_tokens:
            sys.exit("FATAL: page_token repeated, pagination loop")
        seen_tokens.add(page_token)

    params: dict[str, object] = {"page_size": 500}
    if page_token:
        params["page_token"] = page_token

    out = subprocess.run(
        [
            "lark-cli", "api", "GET",
            f"/open-apis/docx/v1/documents/{doc_id}/blocks",
            "--params", json.dumps(params),
        ],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        sys.exit(f"lark-cli FAIL: {out.stderr[:500]}")

    payload = out.stdout
    start = payload.find("{")
    data = json.loads(payload[start:])
    items = data.get("data", data).get("items", [])
    blocks += items
    print(f"page {pages}: +{len(items)} blocks (total {len(blocks)})", file=sys.stderr, flush=True)

    pt = data.get("data", data).get("page_token") or ""
    if not (data.get("data", data).get("has_more") and pt):
        break
    page_token = pt

# ------- 直方图 -------
from collections import Counter
hist: Counter[int] = Counter(b.get("block_type") for b in blocks)
print(f"total blocks={len(blocks)}")
for t, n in sorted(hist.items()):
    print(f"  type {t:>3} {TYPE_NAMES.get(t, '?'):12} = {n}")

# ------- 与 manifest 比对 -------
with open(manifest_path, encoding="utf-8") as f:
    m = json.load(f)

secs = m["sections"]
g = i = c = t_ = 0
for s in secs:
    for b in s.get("blocks", []):
        k = b.get("kind")
        if k == "grid":
            g += 1
        elif k == "image":
            i += 1
        elif k == "callout":
            c += 1
        elif k == "table":
            t_ += 1

headings = sum(hist.get(x, 0) for x in range(3, 12))
checks = [
    ("headings = sections",       headings,        len(secs)),
    ("grid",                      hist.get(24, 0), g),
    ("grid_column",               hist.get(25, 0), g * 2),
    ("image (grid内+独立)",        hist.get(27, 0), g + i),
    ("callout",                   hist.get(19, 0), c),
    ("table",                     hist.get(31, 0), t_),
]

fail = 0
print("---- 与 manifest 比对 ----")
for name, got, want in checks:
    ok = "OK" if got == want else "MISMATCH"
    if got != want:
        fail += 1
    print(f"  {name}: doc={got} manifest={want} {ok}")

print("READBACK", "PASS" if fail == 0 else f"FAIL({fail})")
sys.exit(1 if fail else 0)
