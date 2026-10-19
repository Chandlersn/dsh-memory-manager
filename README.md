**简体中文** | [English](README.en.md)

# dsh-memory-manager

把 [lantern 的 memory-function-org skill](https://github.com/Chandlersn/lantern/tree/main/skills/memory-function-org)
适配成的 **DeepSeek Harness（DSH）插件**：一套**以功能域为骨架、跨会话、跨项目**的长期记忆。

一句话区别：它不是"按项目存笔记"，而是按**功能域**（登录、构建、部署、UI 面板……）累积迭代史，
把**会重跑的操作**沉淀成 `functions/`，把**会重套的原则**蒸馏成 `insights/`，
索引只留一行摘要，并让每个会话开局就被注入这套纪律。

- 九个记忆工具 + 一段系统提示纪律 + 一条 `agent/pre-step` 主动回忆钩子 + 一个只读 Web 面板
- 写入即建档：`summary` 与 `currentState` 是必填参数，索引行不会漂移
- 带机械体检（11 类规则），坏了能被检查出来，而不是靠记性
- **粒度有闸门**：迭代块只写蒸馏结论，块 >900 字或索引行摘要 >110 字会在写入时告警并由体检 R14 点名
- 面板配色/尺寸对齐 Host 设计令牌（`--dsw-alias-*` / `--dsw-radius-*`）

## 记忆布局

根目录默认 `~/.dsh/memory/`（`DSH_HOME` 环境变量或插件配置 `memoryRoot` 可覆盖）：

```
memory/
├── MEMORY.md              # 索引：功能模块索引 + 创新优化思想索引（每行一行摘要）+ 决策共识 + 环境常量
├── functions/<功能域>.md   # 每功能一个文件，追加式迭代块（日期只是标签）
├── insights/<主题>.md      # 可迁移原则（从具体功能向上蒸馏，回链来源）
├── YYYY-MM-DD.md          # 每日记录：原始层，格式与内容不约束（任务过程的第一手数据）
└── legacy/                # 原型时代日志（须带“历史原貌”头部）
```

归口口诀：这是我会**重跑**的操作 → `functions/`；这是我会**重套**的原则 → `insights/`。
细节永远留在功能文件里，`MEMORY.md` 只写共识、环境常量和一行摘要。

## 数据流：单向四层，每层只吃上一层的产出

核心不是"按功能分文件"，而是**先有原料、后有提炼**——数据只向下流动，每一层都对上一层有据可查：

```
第 0 层 · 每日记录 YYYY-MM-DD.md（原始层，插件不约束格式）
        任务与对话过程的第一手数据：决策、对话、试错、片段，模型/harness 自主记录
        │ 归纳汲取（memory_write）
第 1 层 · functions/<功能域>.md 迭代块：动因 / 改动结论 / 判据 / 待观察（各一句）
        │ 再提取（memory_insight）
第 2 层 · insights/<主题>.md：可重套的原则（回链来源功能域）
        │ 整合展示（memory_index，功能域稳定后）
第 3 层 · MEMORY.md 索引 + 面板总览：一行摘要 + 计数，检索与呈现的派生物
```

- **每日记录是自由的原始层**：插件不规定它的内容和形式——它是任务过程的最原始数据，
  由模型与 harness 自己决策怎么记。插件只在蒸馏时读取它（`memory_read kind=daily`），
  从中归纳功能划分；每个功能域的"为什么存在"都能溯源到具体的每日记录。
- **一层比一层精炼、更普世**：每日层是过程，功能层是结论，思想层是普适原则，
  索引层是检索面。任何一层都不复制下一层的原文——同一事实只在一处为真。
- **索引是派生物不是同步物**：`memory_write` 不再自动写索引行与每日线索；
  功能域**稳定后**（≥2 个迭代块，或已可感知为独立主题）才用 `memory_index` 收进索引，
  行摘要从各迭代块的概括中提炼。
- **规模上限有出口**：功能表超过 ~40 行时按 `### 索引·<域>` 拆分子分区（如「基础设施」「业务功能」），
  `memory_index` 传 `group` 参数把行写进对应子表——分组即迁移，原来的扁平行会被自动移走，
  不会留下重复；`memory_check` 在表大而未分组时提示拆分。
- **两层闸门**：块正文 >900 字或概括 >110 字时写入告警，`memory_check` 同时报 **R14**。
  系统会收缩，而不只是增长。
- **收缩**：功能文件超 30KB 用 `memory_fold` 折叠最旧块（每块留一行：日期标签 + 标题 + 非"完成"的结果）；
  折叠后的标签仍参与同日编号（`补N` 不会撞名），早期结论留在「早期演化」段里可追溯。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_read` | 读索引 / 功能文件 / 思想文件 / 每日记录（`kind=index` 先读索引判断相关性） |
| `memory_search` | **全库排序检索**：索引一行摘要之外还能搜正文，返回命中的分区/文件/行号/小节/片段。只记得片段、说不清在哪个域或哪天时用它 |
| `memory_write` | **追加一个迭代块**（从每日原始记录蒸馏的结论），刷新头部稳定态摘要；`summary` 是本块的一句话概括。**不写索引、不碰每日记录** |
| `memory_index` | **整合层**：功能域/思想稳定后把一行收进 MEMORY.md 索引（行摘要从迭代块概括中提炼）；表大时可传 `group` 落到 `### 索引·<域>` 子分区 |
| `memory_insight` | 从功能划分中提取可迁移原则到 `insights/`，回链来源功能域，支持 `supersedes` 取代旧思想 |
| `memory_fold` | 功能文件超 30KB 时把最旧迭代块折叠成"早期演化"段（保留结论与全部日期标签） |
| `memory_rename` | 重命名 / 合并功能域，自动改写所有引用并验证死链清零 |
| `memory_check` | 体检：索引体积、缺摘要、孤儿文件、反向链接、日期乱序、死链、冷记忆、头部守卫、路径存活、块/行过详（R14）、重复行/表（R15） |
| `memory_federation` | **联邦模式**（可选）：`sync` 把各项目 `MEMORY.md` 复制进联邦层 `sources/` 并重建项目索引表；`check` 体检 F1–F5（索引存在、链接可解析、项目/副本齐全、无孤儿副本、绝对路径存活） |

系统提示里会注入一段纪律说明；`agent/pre-step` 钩子按用户输入与索引行的词元重合度打分，
把命中的索引行作为一条 `recall` 消息注入。打分是 **IDF 加权**的：几乎每行都有的词（「功能」
「记忆」）权重低，稀有词（「逐帧」「懒加载」）权重高；行名/文件名命中加倍，低于最高分 40% 的
行直接丢弃，同一文件只注入一次。同一会话同一批只注入一次；用户文本已引用的文件不再注入；
出错绝不影响该步。面板的 `/search` 与 `memory_search` 共用同一套排序。

## 安装（作为 profile bundle）

在 DSH 里用 `plugin_manager` 安装工作区里的包目录：

```
plugin_manager install_bundle  <本目录绝对路径>
```

安装成功后 `plugin_manager` 会返回 `application: applied`；面板出现在 Harness Web UI 侧栏（记忆图标）。

### 更新插件时的缓存行为（实测）

| 改了什么 | 生效方式 |
|---|---|
| `client.js`（面板） | **刷新页面即可**：宿主按 mtime/size 算出 bundle rev，变化时重组模块图并把新 `?rev=` 交给页面 |
| `server.js`（工具、路由、注入） | **需要重启 DSH**：模块生成缓存以 realpath 为键，原地改文件不会被重新加载 |

所以只有改了服务端才需要"换新物理目录 + 新包名"（更省事的做法是直接重启 dsh）。换包名时先禁用旧 bundle
再启用新的，避免同名工具重复注册。

必要时在 profile 的 `cordis.yml` 里配置：

```yml
- id: memory-manager
  name: 'dsh-memory-manager'
  config:
    memoryRoot: C:/Users/you/.dsh/memory   # 默认 ~/.dsh/memory
    newFeatureGraceDays: 3                 # 冷记忆宽限期（天）
    maxIndexBytes: 10240                   # 索引舒适线
    maxIndexHardBytes: 15360               # 索引硬上限
    maxFunctionBytes: 30720                # 功能文件上限
    dshRoot: D:/dsh                        # 一般不需要，见下
    federation:                            # 可选：三层联邦模式（不配则单根）
      root: D:/fed/memory                  # 联邦层记忆根
      projects:
        - { key: printpress, root: 'D:/个人开发/new-tools/.memory' }
        - { key: toolbox,    root: 'D:/rustbuild/.memory' }
```

### 联邦模式（三层，可选）

单个全局根在功能域几十个以后会拥挤。启用联邦后分三层，**项目细节不上升**：

| 层 | 位置 | 内容 |
|---|---|---|
| 项目真相源 | 各项目自己的记忆根 | 该项目完整的 `MEMORY.md` + `functions/` + `insights/`，细节只在这里 |
| 联邦层 | `federation.root` | `sources/<key>.MEMORY.md`（各项目索引副本）+ 一张项目索引表 + **模型手写的跨项目共识** |
| 全局 | `~/.dsh/memory` | 只放跨项目共识与环境常量，不放项目细节 |

`memory_federation(action=sync)` 刷副本与项目索引行（机械内容，不覆盖你手写的共识小节）；
`memory_federation(action=check)` 跑 F1–F5 体检：索引存在、链接可解析、项目行与副本齐全、
无孤儿副本、绝对路径仍存在。**工具只搬副本，跨项目共识需要模型蒸馏后自己写**——不做假融合。

### 插件从哪里找 Host 包

profile 安装的 bundle 是 pnpm 链接，realpath 指向工作区源码，因此**裸 import 永远解析不到 Host 的
`node_modules`**。本插件用 `createRequire` 直接 require Host 安装目录里的文件（ESM + `require(esm)`，
Node ≥ 22.12），返回的正是 Host 已加载的同一份命名空间。

安装目录**自动探测**，顺序为：插件配置 `dshRoot` → 环境变量 `DSH_INSTALL_DIR` / `DSH_ROOT` →
从进程 CLI 入口（`process.argv[1]`）向上找 → 从 `process.cwd()` 向上找 → 从 `DSH_PROFILE_DIR`
向上找 → 本文件所在树。都找不到时会给出明确报错，提示设置 `DSH_INSTALL_DIR`。

## Web 面板

侧栏"记忆管理"图标打开，**只读**，面向长期积累（几十个功能域、上百天线索）而不是文件浏览器：

- **总览**：体检徽标（FAIL/WARN/冷记忆）+ 三个分区计数卡 + **跨分区「最近改动」时间线**
  （按 mtime 倒序，带索引里的一行摘要），先看"记忆最近长成什么样"
- **功能 / 思想 / 每日**：每个文件一行卡片，直接显示索引摘要（不用点进去才知道是什么）、相对时间、体积；
  可**按时间/名称排序**、**按名称或摘要过滤**；每日区按月份分组，天多了也不会变成一堵墙
- **阅读**：功能文件按迭代块折起，默认只展开最新一块（短文件全展开），顶部日期跳转条 + "展开全部"；
  思想/每日按小节展开；索引页把"功能模块索引 / 创新优化思想索引"渲染成**可点击的导航表**，其余小节折叠
- **跳转**：正文里的 `functions/x.md`、`insights/y.md`、`YYYY-MM-DD.md` 链接在面板内跳转，不离开记忆视图
- **搜索**：顶栏全局搜索（防抖 350ms，≥2 字符），与 `memory_search` 共用同一套相关度排序；
  命中行带**命中词高亮**、分区标签、行号与小节标题；顶栏右侧的**分区筛选**（全部/索引/功能/思想/每日）
  直接带 `zone` 参数请求，只筛当前关键词的结果；某分区无命中时会提示"点全部看其它分区"而不是显示空；
  `/` 聚焦搜索框、`Esc` 清空/返回、`↑/↓` 在行间移动
- 每 30 秒静默刷新一次；面板自带的 `<style>` 只作用于面板根节点，随卸载移除
- **视觉贴合宿主**：字级 14/22、控件 36px/28px、搜索框 32px + `--dsw-alias-border-l4` + `--dsw-alias-bg-layer-1`、
  标签 11/17 且状态色走 `color-mix()`、焦点环 `--dsw-focus-ring-*`、正文链接 `--dsw-alias-link`、
  列表用宿主式细线行（不是卡片框）——都能在 `dsh-client-ui-primitives` 的 CSS 里找到同款

## 面板 HTTP API（只读）

面板数据全部来自 Host 路由 `/api/memory-org/*`。**记忆根由服务端解析，请求不能指定路径**
（不接受 `?path=`，因此无法被面板或页面请求指向任意目录）：

| 路由 | 说明 |
|---|---|
| `GET /api/memory-org/overview` | 体检结果 + 各分区文件计数（侧栏徽标用） |
| `GET /api/memory-org/check` | 仅体检 |
| `GET /api/memory-org/list?zone=functions\|insights\|daily` | 分区文件列表（每日区只列 `YYYY-MM-DD.md`，最新在前） |
| `GET /api/memory-org/file?zone=functions&name=x.md` | 读记忆文件（省略 `zone` 读索引） |
| `GET /api/memory-org/search?q=关键词` | 全库搜索 |

**两家半边约定好的字段名**（客户端只认这些；改名会让面板静默变空白，`api-test.mjs` 有专门的契约断言钉住）：

| 响应 | 字段 |
|---|---|
| `overview`（数组，单元素） | `root`、`initialized`、`failCount`、`warnCount`、**`results`**（体检条目：`level`/`rule`/`message`；不是 `problems`）、`counts{functions,insights,daily}` |
| `list` | `files[]{name,bytes,mtime}` |
| `file` | `{name,text}` |
| `search` | `hits[]{zone,name,line,heading,snippet}`（片段是 `snippet`，不是 `text`） |

## 开发与测试

```bash
DSH_INSTALL_DIR=<DSH 安装目录> npm test   # harness-test.mjs + api-test.mjs + ui-test.mjs
```

- `harness-test.mjs`：用假 ctx 捕获工具定义，在临时记忆根上跑完整闭环（写/读/思想/折叠/改名/体检/回忆）
- `api-test.mjs`：用 stub req/res 直接驱动面板 HTTP 处理器，并对真实全局记忆根做断言
- `ui-test.mjs`：给面板注入**最小 React 替身**（createElement + 静态 hooks），把六种视图渲染成标记后断言
  （索引表导航、迭代块折叠、分区摘要/排序/过滤、每日按月分组、内部链接解析）；纯解析逻辑由
  `__internalsForTest` 直接测

Host 安装目录探测不到时需要 `DSH_INSTALL_DIR`（测试进程的 CLI 入口不是 DSH 自己，所以自动探测失效）。

## 许可

MIT，见 [LICENSE](./LICENSE)。