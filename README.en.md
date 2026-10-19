[简体中文](README.md) | **English**

# dsh-memory-manager

A **DeepSeek Harness (DSH) plugin** adapted from
[lantern's memory-function-org skill](https://github.com/Chandlersn/lantern/tree/main/skills/memory-function-org):
long-term memory that is **built around function areas and shared across sessions and projects**.

The one-line difference: it is not "notes per project" but an **iteration history per function area**
(login, build, deploy, UI panel, …). Whatever you will **re-run** settles into `functions/`, whatever you
will **re-apply** is distilled into `insights/`, the index keeps a single line per row, and every session
starts with that discipline injected into its system prompt.

- Six memory tools + an injected system-prompt discipline + an `agent/pre-step` recall hook + a read-only Web panel
- Writing is filing: `summary` and `currentState` are required parameters, so the index row never drifts
- Eleven mechanical lint rules, so rot gets detected instead of remembered
- **Granularity gate**: iteration blocks hold distilled conclusions only; a block over 900 chars or an index
  row over 110 chars warns at write time and is named by lint rule R14
- Panel colors and sizes ride on the Host design tokens (`--dsw-alias-*` / `--dsw-radius-*`)

## Memory layout

The root defaults to `~/.dsh/memory/` (override it with the `DSH_HOME` environment variable or the plugin's
`memoryRoot` config):

```
memory/
├── MEMORY.md              # index: function-module index + innovation-insight index (one-line summary per row) + consensus + environment constants
├── functions/<area>.md    # one file per area, append-only iteration blocks (the date is just a tag)
├── insights/<theme>.md    # transferable principles, distilled upward from concrete areas, backlinked to their source
├── YYYY-MM-DD.md          # daily decision thread (one line + link; a permanent, lightweight audit log)
└── legacy/                # prototype-era logs (must carry a "historical form" header)
```

Rule of thumb: an operation I will **re-run** → `functions/`; a principle I will **re-apply** → `insights/`.
Detail always stays in the function file; `MEMORY.md` carries only consensus, environment constants and
one-line summaries.

## Data flow: each layer keeps only the conclusion of the layer below

The original skill is not about "one file per function" — it is about **granularity layers**: the process
stays in the session and in the code, memory only collects conclusions.

```
Working process in a session (step-by-step implementation / debugging / trial and error)   never enters memory
        │ distilled
        ├─→ functions/<area>.md iteration block: motivation / root cause / what changed / evidence / open questions (one line each)
        │         │ one-line summary
        │         ├─→ MEMORY.md index row ("should I open this file?")
        │         └─→ insights/<theme>.md (re-appliable principles, distilled upward with backlinks)
        └─→ YYYY-MM-DD.md: that day's decision thread (one line + link) + open observations (audit log)
```

- **The process never enters memory**: step-by-step changelists, code-level enumerations, debugging
  narratives, "ran the assertions again" — none of it belongs. Written down, it degrades into exactly the
  dated runlog the skill rejects, just parked in a different file.
- **Two gates**: `memory_write` documents its parameters as "conclusion level, 1–3 sentences"; a block body
  over 900 chars or an index row over 110 chars returns a warning, and `memory_check` reports **R14** at the
  same time. The system shrinks, it does not only grow.
- **The daily log is the audit layer** (Rule 2 of the original skill): one line of thread plus open
  observations, no how/why. Detail ends up as a **conclusion** in the function file, not as another runlog.
  One fact is true in exactly one place.
- **Compaction**: past 30KB, `memory_fold` folds the oldest iteration blocks into an "early evolution"
  paragraph (one line each: date tag + title + any result other than `done`); folded tags still take part in
  the same-day numbering (so `补N` never collides), and early conclusions stay traceable in that paragraph.

## Tools

| Tool | What it does |
|---|---|
| `memory_read` | read the index / a function file / an insight file / a daily thread (`kind=index` first, to judge relevance) |
| `memory_write` | **append one iteration block** (a distilled conclusion, not a process log) and sync the index row and today's thread; `summary` + `currentState` required, over-long input warns |
| `memory_insight` | distil a transferable principle into `insights/`, backlink its source areas, `supersedes` to replace an older idea |
| `memory_fold` | past 30KB, fold the oldest iteration blocks into an "early evolution" paragraph (conclusions and every date tag preserved) |
| `memory_rename` | rename / merge a function area, rewrite every reference and verify zero dangling links |
| `memory_check` | lint: index size, missing summaries, backlinks, date ordering, dangling links, cold memory, legacy headers, over-long blocks/rows (R14) |

A discipline section is injected into the system prompt; the `agent/pre-step` hook scores the user's input
against index rows and injects the matching rows as a single `recall` message (once per batch per session,
and a failure there never affects the step).

## Install (as a profile bundle)

Install the package directory from your workspace with `plugin_manager` inside DSH:

```
plugin_manager install_bundle  <absolute path to this directory>
```

On success `plugin_manager` returns `application: applied`, and the panel shows up in the Harness Web UI
sidebar (the memory icon).

### Cache behavior when updating the plugin (measured)

| What changed | How it takes effect |
|---|---|
| `client.js` (the panel) | **a page refresh is enough**: the host derives the bundle rev from mtime/size, recomposes the module graph when it changes and hands the new `?rev=` to the page |
| `server.js` (tools, routes, injection) | **requires a DSH restart**: the module generation cache is keyed by realpath, so editing the file in place is not reloaded |

Only server-side changes need "a new physical directory + a new package name" (simpler: just restart dsh).
When renaming the package, disable the old bundle before enabling the new one so same-named tools are not
registered twice.

Configure it in the profile's `cordis.yml` when needed:

```yml
- id: memory-manager
  name: 'dsh-memory-manager'
  config:
    memoryRoot: C:/Users/you/.dsh/memory   # default ~/.dsh/memory
    newFeatureGraceDays: 3                 # cold-memory grace window, in days
    maxIndexBytes: 10240                   # index comfort line
    maxIndexHardBytes: 15360               # index hard cap
    maxFunctionBytes: 30720                # function-file cap
    dshRoot: D:/dsh                        # usually unnecessary, see below
```

### Where the plugin finds Host packages

A profile-installed bundle is a pnpm link whose realpath points at the workspace source, so **a bare import
can never resolve the Host's `node_modules`**. This plugin uses `createRequire` to require files from the
Host installation directory (ESM + `require(esm)`, Node ≥ 22.12) and gets back the very same namespace the
Host already loaded.

The installation directory is **discovered automatically**, in this order: plugin config `dshRoot` →
environment variable `DSH_INSTALL_DIR` / `DSH_ROOT` → upward from the process CLI entry (`process.argv[1]`)
→ upward from `process.cwd()` → upward from `DSH_PROFILE_DIR` → the tree this file lives in. When none of
them matches, it fails with an explicit message telling you to set `DSH_INSTALL_DIR`.

## Web panel

Opened from the "记忆管理" (memory manager) icon in the sidebar; **read-only**, and built for long
accumulation (dozens of function areas, hundreds of daily threads) rather than as a file browser:

- **Overview**: health chips (FAIL / WARN / cold memory) + three zone count cards + a **cross-zone "recent
  changes" timeline** (mtime descending, with each row's index summary) — start by seeing how memory has been
  growing
- **Functions / Insights / Daily**: one row per file, showing the index summary directly (no need to open it
  to know what it is), relative time and size; sort by time or name, filter by name or summary; the daily zone
  groups by month, so it never turns into a wall
- **Reader**: function files fold per iteration block — only the newest is expanded by default (short files
  open fully) — with a date jump strip and "expand all"; insights and daily files open per section; the index
  page renders the function-module and innovation-insight index tables as **clickable navigation tables** and folds the rest
- **Navigation**: `functions/x.md`, `insights/y.md` and `YYYY-MM-DD.md` links inside a body navigate within
  the panel, without leaving the memory view
- **Search**: global search in the header (350 ms debounce, ≥2 characters) with a snippet per hit; `/` focuses
  the field, `Esc` clears or goes back, `↑`/`↓` move between rows
- A silent refresh every 30 seconds; the panel's own `<style>` applies only to the panel root and is removed
  on unmount
- **Visually host-native**: 14/22 type scale, 36/28px controls, a 32px search field on `--dsw-alias-border-l4`
  + `--dsw-alias-bg-layer-1`, 11/17 tags with `color-mix()` status tones, the `--dsw-focus-ring-*` focus ring,
  body links on `--dsw-alias-link`, and host-style hairline list rows instead of card boxes — you can find the
  same values in `dsh-client-ui-primitives`' CSS

## Panel HTTP API (read-only)

All panel data comes from the Host route `/api/memory-org/*`. **The memory root is resolved server-side; a
request cannot point anywhere else** (no `?path=`, so neither the panel nor a page request can be aimed at an
arbitrary directory):

| Route | What it does |
|---|---|
| `GET /api/memory-org/overview` | health findings + per-zone file counts (for the sidebar badges) |
| `GET /api/memory-org/check` | health only |
| `GET /api/memory-org/list?zone=functions\|insights\|daily` | zone file listing (the daily zone lists only `YYYY-MM-DD.md`, newest first) |
| `GET /api/memory-org/file?zone=functions&name=x.md` | read a memory file (omit `zone` to read the index) |
| `GET /api/memory-org/search?q=keyword` | search the whole root |

**The field names the two halves agreed on** (the client reads only these; renaming one would silently blank
the panel, so `api-test.mjs` pins them with contract assertions):

| Response | Fields |
|---|---|
| `overview` (array, single element) | `root`, `initialized`, `failCount`, `warnCount`, **`results`** (findings: `level`/`rule`/`message`; not `problems`), `counts{functions,insights,daily}` |
| `list` | `files[]{name,bytes,mtime}` |
| `file` | `{name,text}` |
| `search` | `hits[]{zone,name,line,heading,snippet}` (the snippet is `snippet`, not `text`) |

## Development and tests

```bash
DSH_INSTALL_DIR=<dsh install dir> npm test   # harness-test.mjs + api-test.mjs + ui-test.mjs
```

- `harness-test.mjs`: captures the tool definitions with a fake ctx and runs the full loop on a temp memory
  root (write / read / insight / fold / rename / check / recall)
- `api-test.mjs`: drives the panel HTTP handlers with stub req/res and asserts against the real global memory root
- `ui-test.mjs`: injects a **minimal React shim** (createElement + static hooks) into the panel, renders the
  six views to markup and asserts (index-table navigation, iteration-block folding, zone summary/sort/filter,
  daily month grouping, internal link resolution); pure parsing logic is tested directly via
  `__internalsForTest`

`DSH_INSTALL_DIR` is needed when the Host installation cannot be discovered (the test process's CLI entry is
not DSH itself, so auto-discovery fails).

## License

MIT, see [LICENSE](./LICENSE).