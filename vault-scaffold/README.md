# Mimir vault scaffold（0.2.2 移植）

这是 `dsh-mimir-tutor` 预设配套的 Obsidian 库骨架。原仓库（`tommyhedgerow/Mimir`）已删除，这里按 `vault-craft` 技能里的字段约定重建了模板、枢纽笔记和两个 `Tools` 脚本。

## 装进你的库

把这两样复制到 Obsidian 库的**根目录**（和 `.obsidian/` 同级）：

```
Learn/
Tools/
```

如果库里已经有 `Learn/`，合并时不要覆盖已有笔记；只补缺的文件。

模板用 Obsidian 核心 **Templates** 插件的 `{{date}}` / `{{title}}` 占位符；不需要额外插件。

## 第一次会话

1. 新会话选 **Mimir 导师**，工作目录设成库根目录。
2. 先发一句："我的库已按 vault-scaffold 建好，请从探测开始。"
3. 它会创建 `Learn/Sessions/YYYY-MM-DD 主题.md`，边讲边写。

## Tools

需要 Node.js 22+，零依赖：

```bash
node Tools/vault-map.mjs            # 校验所有 graph 主干，报告漂移
node Tools/vault-map.mjs --write    # 重写笔记里的 generated mermaid 块
node Tools/vault-chart.mjs          # 给所有地图生成 Learn/Viz/<subject>-map.svg
node Tools/vault-chart.mjs --subject 真菌学
```

- `vault-map.mjs` 遇到"边指名了不存在的节点"会以退出码 1 失败；断链概念是警告。
- `vault-chart.mjs` 按概念状态上色：established 绿、learning 琥珀、fragile 红虚线、planned 灰点线；根基蓝、目标紫。
- 两个脚本都支持 `--root <vault>`，默认当前目录。

## 字段约定

会话/地图笔记的 `graph:`：

```yaml
graph:
  goal: 这一条线索要走到哪
  foundations:
    - F1 | 照字面就为真、其余由它推出来的事
  nodes:
    N1: 计划中的节点（还没变成概念笔记）
  edges:
    - F1 -> N1
    - N1 -> G
nodes:            # 节点 id → 概念笔记（或它的 short 文本）
  N1: "[[概念笔记]]"
```

`G` 是目标。`nodes:` 里的值写成 `[[笔记名]]` 时会去 `Learn/Concepts/笔记名.md` 读 `status` / `fragile` 上色；写成普通文本时按 `short` 或笔记名匹配。

## 没做的部分

- 原版的 `概览.base` / `术语表.base` 是 Obsidian Bases 视图，这里给了最小版本；Obsidian 1.9+ 才支持，旧版忽略即可。
- `publish-to-library.sh`、`export-lesson-pdf.mjs`、`anki-cards.mjs` 没有重写；发布到文库请在 Obsidian 里手动复制。
- `lesson-pane` 右栏 UI 没有重建；课程板是对话里的 markdown。
