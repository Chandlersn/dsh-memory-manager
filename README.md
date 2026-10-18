# dsh-memory-manager

把 [lantern 的 memory-function-org skill](https://github.com/Chandlersn/lantern/tree/main/skills/memory-function-org)
适配成的 **DeepSeek Harness（DSH）插件**：一套**以功能域为骨架、跨会话、跨项目**的长期记忆。

一句话区别：它不是"按项目存笔记"，而是按**功能域**（登录、构建、部署、UI 面板……）累积迭代史，
把**会重跑的操作**沉淀成 `functions/`，把**会重套的原则**蒸馏成 `insights/`，
索引只留一行摘要，并让每个会话开局就被注入这套纪律。

- 六个记忆工具 + 一段系统提示纪律 + 一条 `agent/pre-step` 主动回忆钩子 + 一个只读 Web 面板
- 写入即建档：`summary` 与 `currentState` 是必填参数，索引行不会漂移
- 带机械体检（11 类规则），坏了能被检查出来，而不是靠记性
- **粒度有闸门**：迭代块只写蒸馏结论，块 >900 字或索引行摘要 >110 字会在写入时告警并由体检 R14 点名
- 面板配色/尺寸对齐 Host 设计令牌（`--dsw-alias-*` / `--dsw-radius-*`）

## 记忆布局

根目录默认 `~/.dsh/memory/`（`DSH_HOME` 环境变量或插件配置 `memoryRoot` 可覆盖）：

```
memory/
├── MEMORY.md              # 索引：功能表 + 思想表（每行一行摘要）+ 决策共识 + 环境常量
├── functions/<功能域>.md   # 每功能一个文件，追加式迭代块（日期只是标签）
├── insights/<主题>.md      # 可迁移原则（从具体功能向上蒸馏，回链来源）
├── YYYY-MM-DD.md          # 每日决策线索（一行 + 链接，永久轻量审计日志）
└── legacy/                # 原型时代日志（须带“历史原貌”头部）
```

归口口诀：这是我会**重跑**的操作 → `functions/`；这是我会**重套**的原则 → `insights/`。
细节永远留在功能文件里，`MEMORY.md` 只写共识、环境常量和一行摘要。

## 数据流：每一层只保留上一层的结论

原 skill 的核心不是"按功能分文件"，而是**粒度分层**——过程留在会话与代码里，记忆只收结论：

```
会话中的工作过程（逐条实现 / 调试 / 试错）          不进记忆
        │ 蒸馏
        ├─→ functions/<功能域>.md 迭代块：动因 / 根因 / 改动结论 / 判据 / 待观察（各一句）
        │         │ 一句话摘要
        │         ├─→ MEMORY.md 索引行（判断"要不要打开这个文件"）
        │         └─→ insights/<主题>.md（可重套的原则，向上蒸馏并回链来源）
        └─→ YYYY-MM-DD.md：当日决策脉络（一行 + 链接）+ 跨日待观察（审计日志）
```

- **过程不入记忆**：逐条实现清单、代码级枚举、调试经过、"又把断言跑了一遍"都不写。写进去就退化成被否定的
  "日期流水账"，只是换了个文件放。
- **两层闸门**：`memory_write` 的参数按"结论级、1-3 句"描述；块正文 >900 字或索引行摘要 >110 字时写入返回
  直接告警，`memory_check` 同时报 **R14**。这样系统会收缩，而不只是增长。
- **每日日志是审计层**（原 skill Rule 2）：一行脉络 + 未决观察，不写 how/why；细节的归宿是功能文件里的
  **结论**，不是另一份流水账。同一事实只在一处为真。
- **收缩**：功能文件超 30KB 用 `memory_fold` 折叠最旧块（每块留一行：日期标签 + 标题 + 非"完成"的结果）；
  折叠后的标签仍参与同日编号（`补N` 不会撞名），早期结论留在「早期演化」段里可追溯。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_read` | 读索引 / 功能文件 / 思想文件 / 每日线索（`kind=index` 先读索引判断相关性） |
| `memory_write` | **追加一个迭代块**（蒸馏结论，不是过程流水），并同步索引行与当日线索；`summary` + `currentState` 必填，超长会告警 |
| `memory_insight` | 沉淀可迁移原则到 `insights/`，回链来源功能域，支持 `supersedes` 取代旧思想 |
| `memory_fold` | 功能文件超 30KB 时把最旧迭代块折叠成"早期演化"段（保留结论与全部日期标签） |
| `memory_rename` | 重命名 / 合并功能域，自动改写所有引用并验证死链清零 |
| `memory_check` | 体检：索引体积、缺摘要、反向链接、日期乱序、死链、冷记忆、legacy 头部、块/行过详（R14） |

系统提示里会注入一段纪律说明；`agent/pre-step` 钩子按用户输入与索引行的词元重合度，
把命中的索引行作为一条 `recall` 消息注入（同一会话同一批只注入一次，出错绝不影响该步）。

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
```

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
  思想/每日按小节展开；索引页把"功能域表 / 思想表"渲染成**可点击的导航表**，其余小节折叠
- **跳转**：正文里的 `functions/x.md`、`insights/y.md`、`YYYY-MM-DD.md` 链接在面板内跳转，不离开记忆视图
- **搜索**：顶栏全局搜索（防抖 350ms，≥2 字符），命中行带片段；`/` 聚焦搜索框、`Esc` 清空/返回、
  `↑/↓` 在行间移动
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

---

## English

`dsh-memory-manager` is a [DeepSeek Harness](https://github.com/deepseek-ai) plugin for
**function-area long-term memory**. Memory is organized by what you re-run (`functions/`) and what
you re-apply (`insights/`), never per project. It ships six tools
(`memory_read` / `memory_write` / `memory_insight` / `memory_fold` / `memory_rename` / `memory_check`),
a system-prompt discipline section, a pre-step recall hook, and a read-only Web panel.

- `memory_write` requires both `summary` and `currentState`, so the index row never drifts
- Iteration blocks are distilled conclusions (动因 / 改动 / 判据 / 待观察, one line each): a block over
  900 chars or an index row over 110 chars warns at write time and is flagged by lint rule R14 —
  process logs stay in the session and the code, never in memory
- `memory_check` enforces eleven mechanical rules (index size, missing summaries, backlinks, date
  ordering, dangling links, cold areas, legacy headers, un-distilled blocks/rows)
- The panel is built for growth: a cross-zone recent-changes timeline, one-line summaries pulled from
  the index, per-kind section folding, in-panel `.md` links and `/` search
- Panel visuals are copied from the shipped primitives (14/22 type, 36/28px controls, 32px inputs on
  `--dsw-alias-border-l4` + `--dsw-alias-bg-layer-1`, `color-mix()` tag tones, `--dsw-focus-ring-*`),
  and the panel API field names are pinned by a contract assertion in `api-test.mjs` (`results`,
  `counts`, `snippet`, `heading`) so the two halves cannot drift apart silently
- The panel API resolves the memory root server-side; client-supplied paths are ignored
- Host packages are located by discovery (config → env → CLI entry → cwd → profile), never hardcoded
- Client-only edits take effect on a page refresh; server edits need a DSH restart
- `npm test` runs three suites: the tool loop, the panel HTTP handlers, and a render test of the panel
  views (a minimal React shim stands in for the browser)

Install it into the current profile with `plugin_manager install_bundle <this-directory>`.
Node ≥ 22.12 is required (`require(esm)`). Licensed under MIT.