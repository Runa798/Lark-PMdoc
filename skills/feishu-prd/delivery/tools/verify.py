# -*- coding: utf-8 -*-
# 五项机械验收：过程产物清零 / 黑名单 / 字数预算 / 屏覆盖 / 截图引用。
# 用法：python3 verify.py <config.json>
# 退出码：0 = 全 PASS；1 = 有失败项或运行时错误。
#
# config 字段（详见 prd-project.example.json）：
#   sections_dir      - chapter 文件目录（相对 config 目录）
#   order             - 章号列表
#   budgets           - {章号: 字数上限}
#   v_prev            - {章号: 上一版字数}（用于减幅计算，可为 {}）
#   artifacts         - 过程产物正则列表
#   blacklist         - 主黑名单正则列表（ch99 以外各章使用）
#   blacklist_99_extra_allowed - ch99 中额外放行的黑名单正则子集（set，可为 []）
#   allowed           - 白名单子串列表（命中则对应行放行）
#   screen_inventory  - 屏 id 清单 JSON 路径（相对 config 目录）；验收条目 2
#   screenshot_manifest - 截图清单 JSON 路径（相对 config 目录）；验收条目 3
#
# 路径约定：所有相对路径均相对 config 文件所在目录解析。
import json
import os
import re
import sys

if len(sys.argv) < 2:
    sys.exit("用法：python3 verify.py <config.json>")

config_path = os.path.abspath(sys.argv[1])
if not os.path.isfile(config_path):
    sys.exit(f"FATAL: config 文件不存在：{config_path}")

with open(config_path, encoding="utf-8") as f:
    cfg = json.load(f)

BASE = os.path.dirname(config_path)


def resolve(rel: str) -> str:
    return os.path.join(BASE, rel)


# ------- 读取 config -------
sections_dir: str = cfg.get("sections_dir", "")
if not sections_dir:
    sys.exit("FATAL: config.sections_dir 不能为空")
FULL = resolve(sections_dir)

order: list[str] = cfg.get("order", [])
if not order:
    sys.exit("FATAL: config.order 不能为空")

BUDGET: dict[str, int] = cfg.get("budgets", {})
V_PREV: dict[str, int] = cfg.get("v_prev", {})
ARTIFACTS: list[str] = cfg.get("artifacts", [])
BLACK_MAIN: list[str] = cfg.get("blacklist", [])
BLACK_99_EXTRA_ALLOWED: set[str] = set(cfg.get("blacklist_99_extra_allowed", []))
ALLOWED: list[str] = cfg.get("allowed", [])

screen_inventory_path: str = cfg.get("screen_inventory", "")
screenshot_manifest_path: str = cfg.get("screenshot_manifest", "")


# ------- 提取全文本 -------
def all_text(secs: list) -> list[str]:
    out: list[str] = []
    for s in secs:
        out.append(s.get("title", ""))
        for b in s.get("blocks", []):
            k = b.get("kind")
            if k == "paragraph":
                out.append(b.get("text", ""))
            elif k == "list":
                out += b.get("list", {}).get("items", [])
            elif k == "table":
                t = b.get("table", {})
                out += t.get("header", []) + [c for r in t.get("rows", []) for c in r]
            elif k == "callout":
                out += b.get("callout", {}).get("lines", [])
            elif k == "grid":
                for gb in b.get("grid", {}).get("blocks", []):
                    if gb.get("kind") == "paragraph":
                        out.append(gb.get("text", ""))
                    elif gb.get("kind") == "list":
                        out += gb.get("items", [])
    return out


def wc(secs: list) -> int:
    return sum(len(t) for t in all_text(secs))


fail = 0
combined: dict[str, list] = {}

print("=" * 72)
print("【1】过程产物 + 黑名单 + 字数")
header = f"{'章':4} {'上版':>8} {'本版':>8} {'预算':>8} {'减幅':>7}  产物/黑名单命中"
print(header)

total_prev = total_cur = 0
for ch in order:
    p = os.path.join(FULL, f"chapter-{ch}.sections.json")
    if not os.path.isfile(p):
        print(f"{ch:4} 文件缺失 FAIL")
        fail += 1
        continue
    try:
        secs = json.load(open(p, encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"{ch:4} JSON 解析失败: {e}")
        fail += 1
        continue
    combined[ch] = secs
    texts = all_text(secs)
    hits: list[tuple[str, str, str, str]] = []

    # ch99 放行额外黑名单条目
    if ch == "99":
        black = [b for b in BLACK_MAIN if b not in BLACK_99_EXTRA_ALLOWED]
    else:
        black = BLACK_MAIN

    for t in texts:
        if any(a in t for a in ALLOWED):
            continue
        for pat in ARTIFACTS:
            for m in re.findall(pat, t):
                hits.append(("产物", pat, m, t))
        for pat in black:
            for m in re.findall(pat, t):
                hits.append(("黑名单", pat, m, t))

    n = wc(secs)
    prev_n = V_PREV.get(ch, 0)
    budget_n = BUDGET.get(ch, 0)
    total_prev += prev_n
    total_cur += n
    over = "⚠超预算" if budget_n and n > budget_n else ""
    ratio = f"{1 - n / prev_n:>6.0%}" if prev_n else "    N/A"
    print(f"{ch:4} {prev_n:>8,} {n:>8,} {budget_n:>8,} {ratio}  {len(hits)} {over}")
    if hits:
        fail += 1
        for kind, pat, m_str, t in hits[:10]:
            print(f"      [{kind}] {pat} -> {m_str} | {t[:80]}")
        if len(hits) > 10:
            print(f"      ... 共 {len(hits)} 处")

total_budget = sum(BUDGET.values())
total_ratio = f"{1 - total_cur / total_prev:>6.0%}" if total_prev else "    N/A"
print(f"{'合计':4} {total_prev:>8,} {total_cur:>8,} {total_budget:>8,} {total_ratio}")

# ------- 【2】屏覆盖 -------
print("=" * 72)
print("【2】屏覆盖")
if not screen_inventory_path:
    print("  SKIP（config.screen_inventory 未配置）")
elif not os.path.isfile(resolve(screen_inventory_path)):
    print(f"  SKIP（文件不存在：{resolve(screen_inventory_path)}）")
else:
    inv = json.load(open(resolve(screen_inventory_path), encoding="utf-8"))
    blob_all = "\n".join(t for secs in combined.values() for t in all_text(secs))
    # 筛选一期屏（非二期、非 cover）
    p1_screens = [s for s in inv if not s.get("phase2") and not s.get("isCover")]
    missing = [s["id"] for s in p1_screens if s["id"] not in blob_all]
    total_p1 = len(p1_screens)
    if missing:
        print(f"缺屏 {len(missing)}/{total_p1}:", missing)
        fail += 1
    else:
        print(f"{total_p1}/{total_p1} 屏全部出现 OK")

# ------- 【3】截图引用 -------
print("=" * 72)
print("【3】grid/image 引用 vs 截图清单")
if not screenshot_manifest_path:
    print("  SKIP（config.screenshot_manifest 未配置）")
elif not os.path.isfile(resolve(screenshot_manifest_path)):
    print(f"  SKIP（文件不存在：{resolve(screenshot_manifest_path)}）")
else:
    shots = json.load(open(resolve(screenshot_manifest_path), encoding="utf-8"))
    p1files: set[str] = {e["file"] for e in shots if e.get("phase") == 1}
    used: set[str] = set()
    for secs in combined.values():
        for s in secs:
            for b in s.get("blocks", []):
                img_path = None
                if b.get("kind") == "grid":
                    img_path = ((b.get("grid") or {}).get("image") or {}).get("path")
                elif b.get("kind") == "image":
                    img_path = (b.get("image") or {}).get("path")
                if img_path:
                    used.add(os.path.basename(img_path))

    # 放行流程图文件（不在截图清单中，属于 diagrams）
    diagram_files: set[str] = set(cfg.get("diagram_files_allowed", []))
    unknown = used - p1files - diagram_files
    unused = p1files - used
    if unknown:
        print("引用了清单外文件:", sorted(unknown))
        fail += 1
    print(f"清单内未引用（应为 0）: {len(unused)}", sorted(unused) if unused else "")
    if unused:
        fail += 1
    print(f"已引用截图数: {len(used & p1files)} / {len(p1files)}")

print("=" * 72)
print("FAIL 项:", fail)
sys.exit(1 if fail else 0)
