# Lark-PMdoc

> 一个生成飞书（Lark）产品需求文档（PRD）的 Claude Code skill —— 从行文管线直达飞书在线文档。

**状态：开发中。** 完整文档将随首个版本发布。

## 它做什么

`feishu-prd` skill 把产品需求输入转成结构化、行文讲究的 PRD，并通过飞书 docx block API 直接写入飞书文档。采用两层解耦架构：

- **内容生成层** —— 多模型、多 pass 的写前管线（研究 → 大纲+分节 brief → 分节起草 → 跨模型自批 → voice 统一）。决定**行文质量**。
- **飞书交付层** —— 飞书 docx block API 落地：表格、高亮块、左图右文分栏、图表、增量编辑。决定**能否进飞书**。

## 安装

_首个版本发布时补充。_

## 许可

MIT —— 见 [LICENSE](./LICENSE)。

---

English docs: [README.md](./README.md).
