# -*- coding: utf-8 -*-
# 通用 manifest 生成器：按章节 ORDER 拼装 sections，按 diagrams 表 splice 流程图。
# 用法：python3 gen-manifest.py <config.json>
# 退出码：0 = 成功写出 manifest；1 = 任何 FATAL 错误。
#
# config 字段（详见 prd-project.example.json）：
#   title           - 文档标题（字符串）
#   sections_dir    - chapter-NN.sections.json 所在目录（相对 config 文件目录）
#   order           - 章号列表，如 ["00","01",...,"99"]
#   diagrams        - anchorKey → {file, caption}；可为 {} 表示无流程图
#   img_dir         - 流程图相对目录（相对 config 文件目录），diagrams 为空时可省略
#   output          - 输出 manifest 路径（相对 config 文件目录）
#
# 路径约定：所有相对路径均相对 config 文件所在目录解析。
import json
import os
import sys

if len(sys.argv) < 2:
    sys.exit("用法：python3 gen-manifest.py <config.json>")

config_path = os.path.abspath(sys.argv[1])
if not os.path.isfile(config_path):
    sys.exit(f"FATAL: config 文件不存在：{config_path}")

with open(config_path, encoding="utf-8") as f:
    cfg = json.load(f)

# config 文件所在目录作为相对路径基准
BASE = os.path.dirname(config_path)


def resolve(rel: str) -> str:
    """将相对 config 目录的路径解析为绝对路径。"""
    return os.path.join(BASE, rel)


# ------- 读取必填字段 -------
title: str = cfg.get("title", "")
if not title:
    sys.exit("FATAL: config.title 不能为空")

sections_dir: str = cfg.get("sections_dir", "")
if not sections_dir:
    sys.exit("FATAL: config.sections_dir 不能为空")
FULL = resolve(sections_dir)

order: list[str] = cfg.get("order", [])
if not order:
    sys.exit("FATAL: config.order 不能为空")

diagrams_raw: dict = cfg.get("diagrams", {})
img_dir: str = cfg.get("img_dir", "")
output: str = cfg.get("output", "manifest.json")
# file_pattern：章文件名模板（{ch} 占位符），默认 chapter-{ch}.sections.json
file_pattern: str = cfg.get("file_pattern", "chapter-{ch}.sections.json")


# ------- 加载单章 -------
def load(ch: str) -> list:
    p = os.path.join(FULL, file_pattern.replace("{ch}", ch))
    if not os.path.isfile(p):
        sys.exit(f"FATAL: 章文件缺失 {ch} -> {p}")
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        sys.exit(f"FATAL: {ch} JSON 解析失败：{e}")
    if not isinstance(data, list):
        sys.exit(f"FATAL: {ch} 顶层不是数组")
    if not data:
        sys.exit(f"FATAL: {ch} 为空数组")
    first = data[0]
    if not isinstance(first, dict) or first.get("level") != 1:
        sys.exit(f"FATAL: {ch} 首元素 level 必须为 1")
    return data


# ------- 构造图片 block -------
def make_image_block(filename: str, caption: str) -> dict:
    if not img_dir:
        sys.exit(f"FATAL: config.img_dir 未配置，但 diagrams 非空（图：{filename}）")
    path = os.path.join(img_dir, filename)  # 保持相对路径写进 manifest（相对 config 目录）
    abspath = resolve(path)
    if not os.path.isfile(abspath):
        sys.exit(f"FATAL: 流程图缺失 {abspath}")
    return {"kind": "image", "image": {"path": path, "caption": caption}}


# ------- splice 流程图 -------
def splice_diagrams_by_anchor(sections: list, diagrams: dict) -> None:
    pending = dict(diagrams)  # anchorKey → {file, caption}
    for s in sections:
        ak = s.get("anchorKey")
        if ak and ak in pending:
            entry = pending.pop(ak)
            s.setdefault("blocks", []).append(make_image_block(entry["file"], entry["caption"]))
            print(f"  插图 [{ak}] -> '{s.get('title', '')}' (image: {entry['file']})")
    if pending:
        print("FATAL: 以下 anchorKey 未找到，无法 splice 流程图：", file=sys.stderr)
        for ak, entry in pending.items():
            print(f"  - {ak} (期望图: {entry['file']})", file=sys.stderr)
        sys.exit(1)


# ------- 收集/验证媒体路径 -------
def collect_media_paths(sections: list) -> list[str]:
    paths = []
    for s in sections:
        for b in s.get("blocks", []):
            kind = b.get("kind")
            if kind == "image":
                p = (b.get("image") or {}).get("path")
                if p:
                    paths.append(p)
            elif kind == "grid":
                p = ((b.get("grid") or {}).get("image") or {}).get("path")
                if p:
                    paths.append(p)
    return paths


def verify_media_exists(paths: list[str]) -> None:
    missing = [p for p in paths if not os.path.exists(resolve(p))]
    if missing:
        print("FATAL: 以下媒体引用文件不存在：", file=sys.stderr)
        for p in missing:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)


def verify_anchor_keys_unique(sections: list) -> None:
    seen: dict[str, str] = {}
    dups = []
    for s in sections:
        ak = s.get("anchorKey")
        if not ak:
            continue
        if ak in seen:
            dups.append((ak, seen[ak], s.get("title", "")))
        else:
            seen[ak] = s.get("title", "")
    if dups:
        print("FATAL: 检测到重复 anchorKey：", file=sys.stderr)
        for ak, t1, t2 in dups:
            print(f"  - {ak}  ('{t1}' 与 '{t2}')", file=sys.stderr)
        sys.exit(1)


# ------- 主流程 -------
sections: list = []
for ch in order:
    chap = load(ch)
    sections.extend(chap)
    print(f"+ chapter-{ch}: {len(chap)} sections")

print("---- splice diagrams ----")
splice_diagrams_by_anchor(sections, diagrams_raw)
verify_anchor_keys_unique(sections)
verify_media_exists(collect_media_paths(sections))

manifest = {"title": title, "sections": sections}
out_path = resolve(output)
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

# 统计摘要
g = i = c = t = lst = p = 0
for s in sections:
    for b in s.get("blocks", []):
        k = b.get("kind")
        if k == "grid":
            g += 1
        elif k == "image":
            i += 1
        elif k == "callout":
            c += 1
        elif k == "table":
            t += 1
        elif k == "list":
            lst += 1
        elif k == "paragraph":
            p += 1

print("=" * 50)
print(f"chapters={len(order)} sections={len(sections)}")
print(f"blocks: paragraph={p} list={lst} table={t} callout={c} grid={g} image={i}")
print(f"media refs={len(collect_media_paths(sections))}")
print(out_path)
