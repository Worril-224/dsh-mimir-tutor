# Mimir 导师 · DeepSeek Harness 0.2.2 移植

> 这是**非官方社区移植**，不是原作者发布。原项目、原始预设、教学法与索引资料全部列在下面，请先读这一节。

## 来源与署名（请先读）

### 1. 原作者与原项目

- **原作者**：**tommyhedgerow**（GitHub）
- **原仓库**：<https://github.com/tommyhedgerow/Mimir>
- **当前状态**：截至 2026-11-13，原仓库与 `tommyhedgerow` 账号均不可公开访问（返回 404）。本仓库是根据作者公开发布的预设包做的 **DSH 0.2.2 兼容移植**，不是原作者发布，也不代表作者认可。

### 2. 原始预设（DSH Desktop Preset 广场）

本移植以 Preset 广场上由 **citruswizard** 发布的 `.dshpreset` 为源包：

| 条目 | presetId | 大小 | SHA-256 | 备注 |
| --- | --- | --- | --- | --- |
| [Mimir 导师（简体中文）](https://dshdesktop.com/preset/zh/p/mimir-tutor-simplified-chinese-51a04d) | `mimir-tutor-zh` | 69,874 B | `7714fb49fded8d21774dbbda7115bcdc05e7914c13f5318b94233e40f867417a` | 本仓库的主要源包；9 个技能 + 7 个组合声明，不含课程栏插件 |
| [Mimir 导师（完整变体）](https://dshdesktop.com/preset/zh/p/mimir-tutor-chinese-582526) | `mimir-tutor-zh` | 131,883 B | `2f4e77c3e2a1b0c563bddf28bcc5b813f79e7709599e5a354b8209fc5742fb4d` | 额外包含 `preset/lesson-pane/`（host.mjs + 浏览器 bundle）；本移植参考了它的结构，但没有移植课程栏 |
| 英文版 `mimir-tutor-english-5e09de` | `mimir-tutor` | 62,099 B | — | 同广场的英文变体，仅作对照 |

两个源包的 `sourceDshVersion` 都是 `0.1.2-rc.1`，导出时间为 2026-09-17 / 2026-09-19。同广场还有葡萄牙语等变体，未逐一列出。

### 3. 教学法来源

- **amosblomqvist/learn** — <https://github.com/amosblomqvist/learn>（"My AI learning system"）
- 原预设的 `mimir-teaching` 等技能明确说明其方法建立在这个项目之上：**先讲无条件真理**，并追问 **"我当初怎么可能自己发现这件事？"**，顺序是探测 → 计划 → 讲授。
- 该仓库未声明许可证；本仓库只引用其教学理念，没有复制其代码。

### 4. 插件索引与资料页

- DeepSeek Harness 插件导读：<https://deepseekharness.io/zh/plugins/mimir/>
- DSH Get：<https://dshget.com/plugins/tommyhedgerow/Mimir~h~mimir-skin>
- FindHarness：<https://findharness.com/zh/plugins/tommyhedgerow-mimir-preset-mimir-skin>
- dsh-market：<https://dshmarket.com/zh/p/tommyhedgerow/Mimir--preset-mimir-skin/>
- dshfind（education 分类）：<https://dshfind.com/zh/plugins/t/education>
- awesome-dsh-plugin：<https://github.com/hnjm/awesome-dsh-plugin>
- 平台本身：<https://github.com/deepseek-ai/deepseek-harness>

这些页面只用于确认来源与描述，不构成对任何行为的背书；页面内容可能随时变化。

### 5. 本仓库做了什么

本仓库**不是**原仓库的镜像，而是按 DSH `0.2.2-rc.2` 的 agent preset 机制重写的移植：

- 六个专家子代理原本用 `persona` / `toolFilter` 内联在 `tool-subagent` 行里；0.2.2 已明确拒绝这两个字段。本移植把它们拆成六个**独立的 agent preset**，导师通过 `agentPreset:` 引用。
- 删除 0.2.2 已不存在的 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 行（该工具改由 control 主插件注册）。
- 删除 `backgroundMode` / `enableRunInBackground`；技能里的委派语义改为异步 + `wait_agent`。
- 删除 `{{cwd}}` 提示词变量（0.2.2 只注册 `model` / `provider`，未知变量会让系统提示组装直接抛错）。
- 课程板从缺失的 `mimir_board` 工具 / `lesson-pane` 浏览器插件改为**对话内 markdown 课程板**。
- 技能随包发布，`customSkillDirs` 用 `createRequire(baseUrl).resolve(...)` 定位。
- 原仓库缺失的 `Learn/` 模板与 `Tools/` 脚本，在 `vault-scaffold/` 里按技能中的字段约定重建。

### 6. 许可与版权

- **原插件**：据 dshget 条目标注为 **MIT**；原始 `.dshpreset` 的 `manifest.json` 本身没有许可证字段。若原项目实际采用其他许可，以原项目为准。
- **本仓库**：以 **MIT** 发布，见 [LICENSE](LICENSE)。
- **`skills/`**：是原预设文本的衍生作品，版权归原作者 tommyhedgerow；本仓库只做了 0.2.2 语义所需的最小改写。
- **`cordis.patch.yml`、`index.js`、`README.md`、`vault-scaffold/`**：0.2.2 兼容改写与重建由本仓库维护者（Worril）完成。
- **amosblomqvist/learn**：未声明许可证；仅引用教学理念，不复制代码。

### 7. 非官方声明与下架

本仓库与 tommyhedgerow、citruswizard、DeepSeek 官方均无隶属关系。社区配方未经 DSH 官方安全审计，安装第三方代码等于在你的机器上运行它，风险自负。

如果原作者认为本仓库的署名、许可或使用方式有问题，请开 issue，我会立即调整、补正或下架。

---

## 这是什么

一个 DSH **bundle**，安装后向当前 profile 注册 **7 个 agent preset**：

| preset id | 名称 | 作用 |
| --- | --- | --- |
| `mimir-tutor` | Mimir 导师 | 主导师：探测 → 计划 → 逐节点讲授；9 项方法技能 |
| `mimir-researcher` | Mimir · 核查员 | 维基百科优先、8 次调用上限的事实核查 |
| `mimir-cartographer` | Mimir · 制图员 | 规划前测绘主题的依赖结构 |
| `mimir-diagram-maker` | Mimir · 绘图员 | 把图写进 `Learn/Viz/` |
| `mimir-examiner` | Mimir · 出题员 | 探测题、检查题、复习题 |
| `mimir-sophist` | Mimir · 诘问者 | 对抗性攻击主张或课程计划 |
| `mimir-librarian` | Mimir · 管理员 | 维护会话、概念、图谱、复习队列 |

六个专家是独立的 agent preset，导师通过 `tool-subagent` 的 `agentPreset:` 引用；`maxDepth: 1` 保证专家不能再往下递归。

## 安装

要求：DSH `0.2.2-rc.2` 或兼容的 0.2.x。

```text
plugin_manager  action: install_bundle  target: /绝对路径/dsh-mimir-tutor
```

或：

```bash
dsh plugin --profile web add github:Worril-224/dsh-mimir-tutor
```

安装后重启 Host（Desktop 重开应用或 `dsh web`），新会话的预设选择器里会出现 **Mimir 导师**。

> 如果目标 profile 里已有 `git+https://` 依赖且当前网络拉不动 GitHub，`install_bundle` 的 pnpm 阶段可能失败在那些依赖上（不是本包）。这时可以先把本包软链进 `~/.dsh/profiles/<profile>/node_modules/dsh-mimir-tutor`，再用 `plugin_manager action: set_bundle target: dsh-mimir-tutor enabled: true` 启用；详见 [vault-scaffold/README.md](vault-scaffold/README.md) 的说明。

## 使用

1. 把 `vault-scaffold/Learn` 和 `vault-scaffold/Tools` 复制到你的 Obsidian 库根目录（和 `.obsidian/` 同级）。
2. DSH 新建会话：**工作目录 = 库根目录**，预设选 **Mimir 导师**，权限建议 `workspace-write`。
3. 开场：

```text
我想系统学「真菌学入门」。我的背景：只记得高中生物，没学过分类学。
请先探测我已经会什么，不要直接开讲；然后给我一张依赖图计划，等我确认后再一个节点一个节点地讲。
库已经按 vault-scaffold 建好，Tools 也在，可以直接用。
```

4. 它会先探测、再给依赖图、等你点头后逐节点讲授，并往 `Learn/Sessions/`、`Learn/Concepts/` 等写回。

> 列表里还会出现 6 个 `Mimir · …` 子预设，那是给导师内部委派用的，不需要手动选。

## 与 0.1.2 原版的差异

| 方面 | 原版（0.1.2-rc.1） | 本移植（0.2.2） |
| --- | --- | --- |
| 专家人格/工具白名单 | `persona` / `toolFilter` 内联在 `tool-subagent` | 拆成 6 个独立 preset，`agentPreset:` 引用 |
| `list-agents` | 单独的 `tool-subagent-control/list-agents` 行 | 删除；control 主插件已注册 |
| 委派模式 | `backgroundMode` / `enableRunInBackground` | 字段已移除；所有调用异步，结果走完成通知，必要时 `wait_agent` |
| 提示词变量 | 使用 `{{cwd}}` | 已移除（0.2.2 会拒绝未知变量） |
| 课程板 | `mimir_board` 工具 / `lesson-pane` 浏览器插件 | 对话内 markdown 课程板 |
| 技能目录 | 预设相对 `skills/` | 包内 `skills/`，经 `createRequire(baseUrl)` 定位 |
| 模板与 Tools | 原仓库自带 | `vault-scaffold/` 重建；`vault-map.mjs`、`vault-chart.mjs` 为重新实现，发布/PDF/Anki 脚本未包含 |

## 验证状态

- 7 个预设声明行已在 DSH Desktop `0.2.2-rc.2` 上注册，`fiberPhase: active`。
- 包结构、YAML、插件包名、技能目录表达式已静态校验。
- **完整的探测 → 计划 → 讲授流程请在目标环境按上面的“使用”步骤验证**；不同 DSH 小版本、不同库骨架都可能暴露差异。
- 课程栏（lesson-pane）与 `publish-to-library.sh`、导出 PDF/Anki 的脚本**没有**移植。

## 仓库结构

```text
.
├── package.json          # bundle 清单（dsh.bundle.patch）
├── index.js              # 仅用于包解析的 ESM 入口
├── cordis.patch.yml      # 7 个 agent preset 声明
├── skills/               # 9 项方法技能
├── vault-scaffold/       # 配套的 Learn/ 模板与 Tools/ 脚本（可选）
├── README.md
└── LICENSE
```

`vault-scaffold/` 不属于插件包本体；`package.json` 的 `files` 不包含它，安装时不会进入 profile。

## 开发与重建

- `cordis.patch.yml` 由脚本从原 `.dshpreset` 的 `agent.cordis.yml` 生成，再做 0.2.2 改写；生成脚本不随仓库发布，避免把原始预设全文再分发。
- 重新安装：`plugin_manager action: remove_bundle target: dsh-mimir-tutor`，再 `install_bundle`。
- 提交改动前请至少跑一遍 `vault-scaffold/Tools/vault-map.mjs` 的示例库测试。

## 许可证

[MIT](LICENSE)。`skills/` 的版权归原作者；详见上面的“来源与署名”。
