/**
 * dsh-memory-manager — project memory for the DeepSeek Harness.
 *
 * Adapted from lantern's `memory-function-org` skill. The memory root holds:
 *   functions/    = per-feature iteration history (date as tag, append-only blocks)
 *   insights/     = transferable principles distilled UP from features (backlinked)
 *   MEMORY.md     = dual-table index with one-line summaries + consensus + env constants
 *   YYYY-MM-DD.md = lightweight daily decision threads (one line + link)
 *
 * Six tools — memory_read / memory_write / memory_insight / memory_fold /
 * memory_rename / memory_check — plus a system-prompt discipline section, a
 * pre-step recall hook that injects matching index rows, and a read-only HTTP
 * API (`/api/memory-org/*`) consumed by the bundled Web panel (./client).
 *
 * @module dsh-memory-manager
 */
import { readFile, writeFile, rename, unlink, mkdir, readdir, stat, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// locating the Host installation
// ---------------------------------------------------------------------------

/**
 * First-party Host packages (`defineTool`, `createUserMessage`) must come from
 * the DSH installation itself.
 *
 * A profile-installed bundle is a pnpm link whose realpath is this source
 * directory, so bare-import resolution from inside it never sees the Host's
 * node_modules. Requiring the exact Host file works: these are ESM modules
 * (Node >= 22.12 `require(esm)`), their own dependencies resolve from the
 * install's flat node_modules, and require(esm) returns the already-cached
 * namespace the Host loaded — one shared instance.
 *
 * The install root is discovered instead of hardcoded so the bundle stays
 * portable. Candidates, in order:
 *   1. plugin config `dshRoot`
 *   2. env `DSH_INSTALL_DIR` / `DSH_ROOT`
 *   3. walking up from the running CLI entry (`process.argv[1]`)
 *   4. walking up from `process.cwd()`
 *   5. walking up from `DSH_PROFILE_DIR`
 *   6. resolving the Host package from this file's own tree (regular installs)
 * A candidate counts only when it really contains the Host package.
 */
const HOST_MARKER = path.join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

function looksLikeDshRoot(dir) {
	return Boolean(dir) && existsSync(path.join(dir, HOST_MARKER));
}

function walkUpForDshRoot(seed) {
	if (!seed) return undefined;
	let dir = path.resolve(seed);
	if (!existsSync(dir)) dir = path.dirname(dir);
	for (;;) {
		if (looksLikeDshRoot(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function resolveFromOwnTree() {
	try {
		const resolved = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/lib/index.js');
		return walkUpForDshRoot(resolved);
	} catch {
		return undefined;
	}
}

function resolveDshRoot(configured) {
	const candidates = [
		typeof configured === 'string' && configured.trim() ? configured.trim() : undefined,
		process.env.DSH_INSTALL_DIR,
		process.env.DSH_ROOT,
		walkUpForDshRoot(process.argv[1]),
		walkUpForDshRoot(process.cwd()),
		walkUpForDshRoot(process.env.DSH_PROFILE_DIR),
		resolveFromOwnTree(),
	];
	for (const c of candidates) if (looksLikeDshRoot(c)) return path.resolve(c);
	throw new Error(
		'cannot locate the DSH installation (no node_modules/@deepseek-ai/dsh-tools found): ' +
			'set DSH_INSTALL_DIR to the harness install directory, or pass `dshRoot` in the plugin config',
	);
}

let hostRootOverride;
let hostModules;
/** Load (and memoize) the Host packages from the resolved install root. */
function loadHost() {
	if (!hostModules) {
		const root = resolveDshRoot(hostRootOverride);
		const req = (pkg, sub) => {
			const file = path.join(root, 'node_modules', pkg, sub);
			try {
				return createRequire(file)(file);
			} catch (err) {
				throw new Error(`cannot load ${pkg} from the DSH installation (${root}): ${err?.message ?? err}`);
			}
		};
		hostModules = {
			root,
			defineTool: req('@deepseek-ai/dsh-tools', 'lib/index.js').defineTool,
			createUserMessage: req('@deepseek-ai/dsh-llm', 'lib/index.js').createUserMessage,
		};
	}
	return hostModules;
}

// Host helpers, bound lazily so resolution happens at apply() time (when the
// plugin config is known) and never at module-import time (so tests can import
// this file without a host installation on the machine).
function defineTool(...args) {
	return loadHost().defineTool(...args);
}
function createUserMessage(...args) {
	return loadHost().createUserMessage(...args);
}

const name = 'memory-manager';
const inject = ['tools', 'systemPrompt', 'webServer'];

const DEFAULTS = {
	maxIndexBytes: 10 * 1024, // 索引舒适线
	maxIndexHardBytes: 15 * 1024, // 索引硬上限（达到即拒绝写入）
	maxFunctionBytes: 30 * 1024, // 单个功能文件上限
	newFeatureGraceDays: 3, // TEMP 冷记忆宽限期：最近改动过的不报冷
};

const FUNC_TABLE_HEADING = '## 功能模块索引';
const INSIGHT_TABLE_HEADING = '## 创新优化思想索引';
const FUNC_TABLE_HEADER = '| 功能域摘要 | 一句话状态 / 待验证 | 过程链接 | 摘要 |';
const INSIGHT_TABLE_HEADER = '| 思想主题 | 一句话内涵 / 解决的权衡 | 思想内容 | 相关（来源功能） |';
// Daily-log structure is no longer imposed: the raw layer is free-form, so the
// plugin cannot assume a fixed '今日功能线索' heading. resolveOpenItems scans the
// whole file for still-open (non-✅) lines referencing the feature instead.
const DAILY_SECTION = '## 今日功能线索'; // legacy template heading, kept for old logs
const DAILY_OPEN_SECTION = '## 今日待观察'; // legacy template heading
const RESULT_LABEL = { done: '完成', reverted: '已回滚', pending: '进行中' };
// Guard marker: a low-frequency, high-value memory that must never be judged
// cold just because it is not written to often (the "守护型" channel).
const GUARD_MARK = '🛡 守护型';
const GUARD_LINE = `> ${GUARD_MARK}：低频高价值，不做冷记忆判定（memory_write guard=true 写入，删除该行即恢复判定）。`;

// ---------------------------------------------------------------------------
// usage signals — the data that lets the memory sort itself
// ---------------------------------------------------------------------------
//
// The index/insight layer is written by the model; which rows are actually USED
// is a different signal, and the plugin never captured it. Every recall
// injection, explicit file read, correction and positive confirmation appends
// one line here, and memory_check / memory_usage turn those lines into layer
// suggestions. Kept as a dot-file so no zone listing, search or lint sees it.

function usagePath(root) {
	return path.join(root, '.usage.jsonl');
}

async function appendUsage(root, entry) {
	try {
		await mkdir(root, { recursive: true });
		await appendFile(usagePath(root), `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, 'utf8');
	} catch {
		/* usage logging must never break a step or a tool call */
	}
}

/** Usage entries newer than `days`, newest last. Bad lines are skipped. */
async function readUsage(root, days = 30) {
	const text = await readIfExists(usagePath(root));
	if (text === undefined) return [];
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	const out = [];
	for (const line of text.split('\n')) {
		const s = line.trim();
		if (!s) continue;
		try {
			const e = JSON.parse(s);
			const t = Date.parse(e.t);
			if (!Number.isFinite(t) || t < cutoff) continue;
			out.push({ ...e, ms: t });
		} catch {
			/* skip corrupt line */
		}
	}
	return out;
}

/** Aggregate usage per target and suggest a layer (实验 / 专项 / 通用). */
function summarizeUsage(entries) {
	const map = new Map();
	for (const e of entries) {
		const href = String(e.href ?? '').trim();
		if (!href) continue;
		const cur = map.get(href) ?? { href, recalls: 0, reads: 0, corrections: 0, positives: 0, last: 0 };
		if (e.kind === 'recall') cur.recalls++;
		else if (e.kind === 'read') cur.reads++;
		else if (e.kind === 'correction') cur.corrections++;
		else if (e.kind === 'positive') cur.positives++;
		cur.last = Math.max(cur.last, e.ms);
		map.set(href, cur);
	}
	const items = [...map.values()];
	for (const it of items) {
		const uses = it.recalls + it.reads;
		const badRate = uses ? it.corrections / uses : it.corrections ? 1 : 0;
		// Layer suggestion mirrors the article's data-driven promotion: usage wins,
		// confirmation gates promotion, correction rate gates generality.
		if (uses >= 10 && it.positives >= 2 && badRate < 0.2) it.layer = '通用';
		else if (uses >= 3 && it.positives >= 1) it.layer = '专项';
		else it.layer = '实验';
		it.uses = uses;
		it.badRate = Number(badRate.toFixed(2));
	}
	items.sort((a, b) => b.uses - a.uses || b.last - a.last);
	return items;
}


// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
function localDateStr(d = new Date()) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function normDate(s) {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : localDateStr();
}
const byteLen = (s) => Buffer.byteLength(s, 'utf8');
/** One-line, table-safe cell text. */
function oneLine(s) {
	return String(s ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim();
}
async function readIfExists(p) {
	try {
		return await readFile(p, 'utf8');
	} catch {
		return undefined;
	}
}
/**
 * Write text atomically: a crash or a reader can never observe a partial file.
 * `rename` replaces the destination in one step (Node uses MOVEFILE_REPLACE_
 * EXISTING on Windows); a short retry covers transient locks from readers or
 * antivirus scanning the destination.
 */
async function writeText(p, content) {
	await mkdir(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
	try {
		await writeFile(tmp, content, 'utf8');
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, p);
				return;
			} catch (err) {
				if (attempt >= 3) throw err;
				await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
			}
		}
	} catch (err) {
		try {
			await unlink(tmp);
		} catch {
			/* tmp already gone */
		}
		throw err;
	}
}
async function statExists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/** Validate a feature/theme slug used as a markdown filename. */
function safeSlug(raw) {
	// Tolerate the filename spelling callers reach for by habit ("x.md"); without
	// this, related: ["x.md"] renders as `x.md.md（未建档）` instead of a link.
	const s = String(raw ?? '').trim().replace(/\.md$/i, '');
	if (!s) throw new Error('slug must be a non-empty string');
	if (s.length > 60) throw new Error(`slug too long (max 60 chars): ${s}`);
	if (/[\\/:*?"<>|]/.test(s) || s.includes('..') || s.startsWith('.')) {
		throw new Error(`invalid slug (no path separators or dots at start): ${s}`);
	}
	if (/^memory$/i.test(s)) throw new Error('slug "MEMORY" is reserved for MEMORY.md');
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('slug must not look like a daily-log date (YYYY-MM-DD)');
	return s;
}

/**
 * Distillation limits. 原 skill 的数据流是"过程 → 蒸馏结论"：`functions/` 存
 * 具体环节精髓（动因 / 根因 / 改动结论 / 判据 / 待观察，各一句），逐条实现清单、
 * 代码级枚举、调试经过都不属于记忆。超过这个长度的块在写入时告警，并由体检
 * R14 复查——机制上保证系统会收缩，而不只是增长。
 */
const MAX_BLOCK_CHARS = 900;
/** 索引行摘要必须是一句话；超过即视为把迭代细节塞进了索引（R14）。 */
const MAX_ROW_SUMMARY_CHARS = 110;
/** Code-point length: CJK counts as 1, unlike byteLen. */
function charLen(s) {
	return [...String(s ?? '')].length;
}

/** Iteration blocks (`## [date…] title`) with their bodies, for R14 length checks. */
function splitIterationBlocks(text) {
	const out = [];
	let cur = null;
	for (const line of String(text ?? '').split('\n')) {
		if (/^##\s/.test(line)) {
			if (cur) out.push(cur);
			cur = null;
			const m = /^##\s*\[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*(.*)$/.exec(line);
			if (m) cur = { title: m[2].trim() || m[1], body: '' };
			continue;
		}
		if (cur) cur.body += `${line}\n`;
	}
	if (cur) out.push(cur);
	return out.map((b) => ({ title: b.title, body: b.body.trim() }));
}

/**
 * Resolve the harness home (same precedence as @deepseek-ai/dsh-home-paths:
 * $DSH_HOME, then ~/.dsh) without importing the package — the plugin keeps a
 * zero bare-import surface.
 */
function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === 'string' && env.trim()) return path.resolve(env.trim());
	return path.join(homedir(), '.dsh');
}
function joinDshHome(...segments) {
	return path.join(dshHome(), ...segments);
}

function resolveRoot(opts) {
	if (opts.memoryRoot) return path.resolve(opts.memoryRoot);
	// Global memory root: the harness home's memory/ directory, shared across
	// every workspace, profile, and session (~/.dsh/memory by default).
	return joinDshHome('memory');
}

function appendBlock(text, block) {
	return text.replace(/\n*$/, '\n') + block;
}

/**
 * Next same-day iteration index. Counts every `[YYYY-MM-DD]` / `[YYYY-MM-DD补N]`
 * tag in the file — not just the `## [..]` headings — because memory_fold removes
 * headings and lists the folded tags inside 「早期演化」: counting headings alone
 * would reuse an existing tag after a fold (补4 colliding with a folded 补4, which
 * also trips the R3 ordering check). Tag index: '' → 0, '补' → 1, '补N' → N;
 * returns max+1 (0 when the date has never been used).
 */
function countHeadingDate(text, date) {
	let max = -1;
	const re = new RegExp(`\\[${date}(补(\\d*))?\\]`, 'g');
	for (const m of String(text ?? '').matchAll(re)) {
		const n = m[2] === undefined ? 0 : m[2] === '' ? 1 : Number(m[2]);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max + 1;
}

// ---------------------------------------------------------------------------
// canonical file templates
// ---------------------------------------------------------------------------

function memoryIndexTemplate() {
	return [
		'# 记忆管理（索引 + 纪律）',
		'',
		'> 读取纪律：先查本索引（行内摘要足以判断相关性），再打开对应 functions/ 文件；日期不是骨架，只做迭代标签。',
		'> 数据流：每日记录（原始层，自由格式）→ memory_write 蒸馏出 functions/ 迭代块 → memory_insight 提取 insights/ 思想 → memory_index 收进本索引（整合展示层）。本文件是派生物，不与单次写入强绑。',
		'> 性质二分：可复跑的操作进 functions/，可重套的原则进 insights/（回链来源）；共识/规范与环境常量只留在本文件。',
		'',
		`${FUNC_TABLE_HEADING}（functions/）`,
		'',
		FUNC_TABLE_HEADER,
		'|---|---|---|---|',
		'',
		`${INSIGHT_TABLE_HEADING}（insights/）`,
		'',
		INSIGHT_TABLE_HEADER,
		'|---|---|---|---|',
		'',
		'## 决策共识 / 规范（跨功能、约束级）',
		'',
		'- ',
		'',
		'## 环境常量（易忘）',
		'',
		'- ',
		'',
		'## 细节指针（跨功能的详细论证存放处）',
		'',
		'- ',
		'',
	].join('\n');
}

function functionFileTemplate(feature, date, guard = false) {
	return [
		`# ${feature}迭代历程`,
		'',
		`> 范围：${feature} 的代码路径、约束与迭代决策；本文件自包含，细节不回指 MEMORY.md。`,
		...(guard ? [GUARD_LINE] : []),
		'',
		`## 当前状态摘要（截至 ${date}）`,
		'',
		'- （当前稳定行为 / 关键约束 / 隐患）',
		'',
		'---',
		'',
		'<!-- 迭代块按时间顺序追加在文件末尾：最早在上，最新在下；每块只写蒸馏结论（动因/改动/判据/待观察 各一句），过程流水留在会话与代码里 -->',
		'',
	].join('\n');
}

function dailyTemplate(date) {
	return [
		`# ${date} 记录`,
		'',
		'> 本文件是原始层：任务与对话过程的第一手数据，内容与格式由你（模型/harness）自主决策，插件不做任何约束。蒸馏时插件从这里归纳功能划分——记录得越真实，功能域的依据越扎实。',
		'',
	].join('\n');
}

function insightTemplate(theme, principle, srcLine, evolution, applicability, open, date) {
	const parts = [
		`# 创新优化思想：${theme}`,
		'',
		'> 性质：可重套的原则（不是可重跑的操作）；操作细节留在来源 functions/ 文件。',
		`> 来源：${srcLine}`,
		'',
		'## 核心原则',
		'',
		`- ${principle}`,
		'',
		'## 思想演进',
		'',
		`- ${date} 首次沉淀`,
	];
	if (evolution) parts.push(`- ${oneLine(evolution)}`);
	parts.push('', '## 适用面（超出来源功能的部分）', '');
	if (applicability) parts.push(`- ${oneLine(applicability)}`, '');
	parts.push('## 待观察', '');
	if (open) parts.push(`- ${oneLine(open)}`, '');
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// markdown surgery (index rows / sections)
// ---------------------------------------------------------------------------

function sepOf(headerRow) {
	const cols = headerRow.split('|').length - 2;
	return '|' + Array.from({ length: cols }, () => '---').join('|') + '|';
}

/**
 * Upsert one index row into the table under `headingPrefix` (first cell match).
 * Creates the section at the end when the table is missing.
 *
 * `group` (optional) writes the row into a `### 索引·<group>` sub-section — the
 * scale escape hatch: past ~40 function rows the single table is split by
 * domain, and the index must still upsert into the RIGHT sub-table instead of
 * appending to whichever table happens to come first.
 */
function upsertIndexRow(indexText, headingPrefix, headerRow, firstCell, newRow, group) {
	const lines = indexText.split('\n');
	let secStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(headingPrefix)) {
			secStart = i;
			break;
		}
	}
	if (secStart === -1) {
		const t = indexText.replace(/\n*$/, '\n');
		if (group) {
			return `${t}\n${headingPrefix}（细节在子目录）\n\n### 索引·${group}\n\n${headerRow}\n${sepOf(headerRow)}\n${newRow}\n`;
		}
		return `${t}\n${headingPrefix}（细节在子目录）\n\n${headerRow}\n${sepOf(headerRow)}\n${newRow}\n`;
	}
	// Self-heal: a heading that only STARTS WITH the anchor prefix (an older
	// template generation, e.g. `## 功能域（细节在子目录，本表只留指针）` under a
	// `## 功能域` anchor) is the same table duplicated by the fallback path.
	// Keep the first occurrence; drop every later one including its data rows,
	// so the next upsert edits the real table instead of appending a twin.
	// Generation-rename twins (heading no longer shares the prefix but carries
	// the same table header row, e.g. `## 功能域（…）` vs `## 功能模块索引…`)
	// are recognized by that header row instead of the heading text.
	for (let i = lines.length - 1; i > secStart; i--) {
		if (!lines[i].startsWith('## ')) continue;
		if (!lines[i].startsWith(headingPrefix) && lines[i + 2] !== headerRow) continue;
		let end = i + 1;
		while (end < lines.length && !lines[end].startsWith('## ')) end++;
		lines.splice(i, end - i);
	}
	// Section bounds: the next `## ` heading ends this section (a `### ` sub
	// heading does not, it belongs to the same zone).
	let secEnd = lines.length;
	for (let i = secStart + 1; i < lines.length; i++) {
		if (lines[i].startsWith('## ')) {
			secEnd = i;
			break;
		}
	}
	// Upsert into the first table inside [from, to): replace the row whose first
	// cell matches, else append after the last row. Returns false when the range
	// holds no table at all.
	const upsertIn = (from, to) => {
		let headIdx = -1;
		for (let i = from; i < to; i++) {
			if (lines[i].startsWith('|')) {
				headIdx = i;
				break;
			}
		}
		if (headIdx === -1) return false;
		let end = headIdx + 1;
		while (end < to && lines[end].startsWith('|')) end++;
		for (let i = headIdx + 1; i < end; i++) {
			const cells = lines[i].split('|');
			if (cells.length >= 2 && cells[1].trim() === firstCell) {
				lines[i] = newRow;
				return true;
			}
		}
		lines.splice(end, 0, newRow);
		return true;
	};
	if (group) {
		const subHead = `### 索引·${group}`;
		// Grouping is a MIGRATION: if the row already exists in another table of
		// this zone (typically the flat top-level table it is moving out of),
		// drop those copies first — otherwise splitting the table duplicates the
		// row and trips R15 on the very next check.
		for (let i = lines.length - 1; i > secStart; i--) {
			if (i >= secEnd) continue;
			if (!lines[i].startsWith('|')) continue;
			const cells = lines[i].split('|');
			if (cells.length >= 2 && cells[1].trim() === firstCell) lines.splice(i, 1);
		}
		// Bounds may have shifted after the purge; re-derive them.
		secEnd = lines.length;
		for (let i = secStart + 1; i < lines.length; i++) {
			if (lines[i].startsWith('## ')) {
				secEnd = i;
				break;
			}
		}
		let subStart = -1;
		for (let i = secStart + 1; i < secEnd; i++) {
			if (lines[i].startsWith(subHead)) {
				subStart = i;
				break;
			}
		}
		if (subStart === -1) {
			// New sub-section at the end of the zone (trailing blanks trimmed).
			let at = secEnd;
			while (at > secStart + 1 && lines[at - 1].trim() === '') at--;
			lines.splice(at, 0, '', subHead, '', headerRow, sepOf(headerRow), newRow);
			return lines.join('\n');
		}
		let subEnd = secEnd;
		for (let i = subStart + 1; i < secEnd; i++) {
			if (lines[i].startsWith('### ')) {
				subEnd = i;
				break;
			}
		}
		if (!upsertIn(subStart + 1, subEnd)) lines.splice(subStart + 1, 0, '', headerRow, sepOf(headerRow), newRow);
		return lines.join('\n');
	}
	let headIdx = -1;
	for (let i = secStart + 1; i < secEnd; i++) {
		if (lines[i].startsWith('|')) {
			headIdx = i;
			break;
		}
	}
	if (headIdx === -1) {
		lines.splice(secStart + 1, 0, '', headerRow, sepOf(headerRow), newRow);
		return lines.join('\n');
	}
	let end = headIdx + 1;
	while (end < lines.length && lines[end].startsWith('|')) end++;
	for (let i = headIdx + 1; i < end; i++) {
		const cells = lines[i].split('|');
		if (cells.length >= 2 && cells[1].trim() === firstCell) {
			lines[i] = newRow;
			return lines.join('\n');
		}
	}
	lines.splice(end, 0, newRow);
	return lines.join('\n');
}

/**
 * Append one bullet under `sectionHeading` (section created at end when
 * missing). An exact duplicate of an existing bullet in the same section is
 * detected and reported instead of appended — the daily thread is an audit
 * trail, so a repeated line is a data bug, not content.
 */
function appendUnderHeading(text, sectionHeading, line) {
	const lines = text.split('\n');
	let secStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(sectionHeading)) {
			secStart = i;
			break;
		}
	}
	if (secStart === -1) {
		const t = text.replace(/\n*$/, '\n');
		return { text: `${t}\n${sectionHeading}\n\n${line}\n`, duplicate: false };
	}
	let end = secStart + 1;
	while (end < lines.length && !lines[end].startsWith('## ')) end++;
	const body = lines.slice(secStart + 1, end);
	if (body.some((l) => l.trim() === line.trim())) {
		return { text: lines.join('\n'), duplicate: true };
	}
	let at = end;
	while (at > secStart + 1 && lines[at - 1].trim() === '') at--;
	lines.splice(at, 0, line);
	return { text: lines.join('\n'), duplicate: false };
}

/**
 * Mark still-open daily-log entries that reference `feature` with a ✅ resolved
 * stamp (the R2 "勾掉" move): the thread stays in the day it was raised, gains
 * a bare ✅ (no second pointer), and is never re-copied forward. The raw layer
 * is free-form, so this scans every bullet that links the feature file — no
 * fixed section heading is required. Applies to every daily log from
 * `sinceDate` to today. Returns files touched.
 */
async function resolveOpenItems(root, feature, sinceDate, today) {
	const touched = [];
	try {
		for (const f of await readdir(root)) {
			if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
			if (f.slice(0, 10) < sinceDate) continue;
			if (f.slice(0, 10) > today) continue;
			const p = path.join(root, f);
			const text = await readFile(p, 'utf8');
			const lines = text.split('\n');
			let changed = false;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes('✅')) continue;
				if (!lines[i].includes(`functions/${feature}.md`)) continue;
				// Only thread lines (raise site): a bullet that links the feature
				// file. Resolution notes are added inline at the raise site.
				if (!/^- .+→/.test(lines[i])) continue;
				// The raise-site line already ends with a link to the same file —
				// appending the full resolution pointer would duplicate the target
				// twice in one row. Stamp a bare marker instead.
				lines[i] = `${lines[i]}（✅ ${today} 已解决）`;
				changed = true;
			}
			if (changed) {
				await writeText(p, lines.join('\n'));
				touched.push(f);
			}
		}
	} catch {
		/* root absent */
	}
	return touched;
}

/** Replace the `## 当前状态摘要` heading date + bullets with fresh content. */
function refreshSummarySection(fnText, date, currentState) {
	const lines = fnText.split('\n');
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('## 当前状态摘要')) {
			start = i;
			break;
		}
	}
	const newHeading = `## 当前状态摘要（截至 ${date}）`;
	const body = currentState
		.split('\n')
		.map((s) => `- ${oneLine(s)}`)
		.filter((s) => s !== '- ');
	if (start === -1) {
		let at = lines.length;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith('## ')) {
				at = i;
				break;
			}
		}
		lines.splice(at, 0, newHeading, '', ...body, '');
		return lines.join('\n');
	}
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith('## ') && lines[end].trim() !== '---') end++;
	lines.splice(start, end - start, newHeading, '', ...body, '');
	return lines.join('\n');
}

/** Replace one section's body (up to the next `## ` heading) with `body`. */
function replaceSection(text, heading, body) {
	const lines = text.split('\n');
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(heading)) {
			start = i;
			break;
		}
	}
	if (start === -1) return text;
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith('## ')) end++;
	lines.splice(start + 1, end - start - 1, '', body, '');
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// shared checker pieces (ported from lantern's check_memory.py)
// ---------------------------------------------------------------------------

function stripCode(text) {
	return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

async function checkLinks(text, filePath, root, add) {
	const stripped = stripCode(text);
	const base = path.dirname(filePath);
	const rootAbs = path.resolve(root);
	const seen = new Set();
	for (const m of stripped.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
		const rel = m[1].split('#')[0].trim();
		if (!rel || rel.startsWith('/') || rel.startsWith('http') || rel.includes('attachments')) continue;
		const resolved = path.resolve(base, rel);
		const key = `${filePath}→${resolved}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const exists = await statExists(resolved);
		const label = path.relative(rootAbs, filePath).split(path.sep).join('/') || 'MEMORY.md';
		if (!exists) add('FAIL', 'R10', `dangling link in ${label} -> ${rel}`);
		else if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
			add('WARN', 'R10e', `link in ${label} escapes memory root -> ${rel}`);
		}
	}
}

const REVERSE_DETAIL_FULL = /详见\s*MEMORY\.md[（(][^）)]{2,}[）)]/;
const REVERSE_DETAIL_VAGUE = /详见\s*MEMORY\.md(?!\s*[（(])/;
const DATE_TAG = /^##\s*\[(\d{4})-(\d{2})-(\d{2})/gm;

// ---------------------------------------------------------------------------
// shared health check (memory_check tool + panel API)
// ---------------------------------------------------------------------------

async function runHealthCheck(root, opts) {
	const results = [];
	const add = (level, rule, message) => results.push({ level, rule, message });

	const memPath = path.join(root, 'MEMORY.md');
	const memText = await readIfExists(memPath);
	if (memText === undefined) {
		add('FAIL', 'R0', `MEMORY.md not found under ${root}：先用 memory_write 记录第一次迭代`);
		return { root, results, warnCount: 0, failCount: 1 };
	}
	const memSize = byteLen(memText);
	if (memSize > opts.maxIndexHardBytes) add('FAIL', 'R5', `MEMORY.md ${memSize}B > 硬上限 ${opts.maxIndexHardBytes}B`);
	else if (memSize > opts.maxIndexBytes) add('WARN', 'R5', `MEMORY.md ${memSize}B > 舒适线 ${opts.maxIndexBytes}B`);

	let emptySummary = 0;
	const longRows = [];
	for (const raw of memText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('|')) continue;
		const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
		// Both tables put the one-line summary in column 2: 功能行是 3 列
		// （名称/摘要/链接），思想行是 4 列（主题/内涵/思想内容/来源）。
		if (cells.length < 3) continue;
		if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
		const summary = cells[1];
		if (!summary) emptySummary++;
		else if (charLen(summary) > MAX_ROW_SUMMARY_CHARS) longRows.push(`${cells[0]}（${charLen(summary)} 字）`);
	}
	if (emptySummary) add('WARN', 'R5', `${emptySummary} 个索引行缺少一行摘要（摘要列是索引判断相关性的唯一依据）`);
	if (longRows.length) {
		add('WARN', 'R14', `索引行摘要过长（摘要是一句话，细节应留在功能文件）：${longRows.join('、')}`);
	}

	// R5 scaling: past ~40 function rows a single flat table costs too much to
	// scan. The escape hatch is `### 索引·<域>` sub-sections plus memory_index's
	// `group` argument; flag a big ungrouped table so the split happens before
	// the index gets uncomfortable rather than after.
	{
		const at = memText.indexOf(FUNC_TABLE_HEADING);
		if (at !== -1) {
			const rest = memText.slice(at);
			const stop = rest.indexOf('\n## ', 1);
			const section = stop === -1 ? rest : rest.slice(0, stop);
			const rows = section.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !l.includes('---')).length - 1;
			if (rows > 40 && !section.includes('### 索引·')) {
				add('WARN', 'R5', `功能表已 ${rows} 行（>40）：按「### 索引·<域>」拆分子分区，并在 memory_index 传 group 参数落对表`);
			}
		}
	}

	// R15: duplicated rows / duplicated table sections. The index is a lookup
	// surface; a repeated row (same slug cell) or a repeated table heading makes
	// recall inject the same fact twice and hides which row is authoritative.
	const rowSlugCount = new Map();
	let dupeRows = 0;
	for (const raw of memText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('|')) continue;
		const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
		if (cells.length < 3 || cells.every((c) => /^[-: ]*$/.test(c))) continue;
		const slug = cells[0];
		rowSlugCount.set(slug, (rowSlugCount.get(slug) ?? 0) + 1);
	}
	for (const [slug, n] of rowSlugCount) {
		if (n > 1) {
			dupeRows++;
			add('WARN', 'R15', `索引行「${slug}」出现 ${n} 次（同一事实只在一处为真）：确认哪一行是现状，删掉其余行`);
		}
	}
	const headingCount = new Map();
	for (const raw of memText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('## ')) continue;
		headingCount.set(s, (headingCount.get(s) ?? 0) + 1);
	}
	for (const [h, n] of headingCount) {
		if (n > 1) add('WARN', 'R15', `索引小节「${h}」出现 ${n} 次（多为模板换代后锚点失配的兜底产物）：保留第一处，删除其余小节`);
	}

	await checkLinks(memText, memPath, root, add);

	// R16 (ported from the workbuddy skill's F4): env-constant lines often carry
	// absolute backtick paths (install dirs, DB files, scripts). A moved or
	// renamed path silently poisons every future recall that trusts it — check
	// they still exist. Only the index is scanned: it is the env-constants home.
	const checkedPaths = new Set();
	for (const m of memText.matchAll(/`([^`\n|]+)`/g)) {
		const raw = m[1].trim();
		const pm = /^([A-Za-z]:[\\/].*)$/.exec(raw);
		if (!pm) continue;
		const p = pm[1].replace(/[/\\]+$/, '');
		const key = p.toLowerCase();
		if (checkedPaths.has(key)) continue;
		checkedPaths.add(key);
		if (!(await statExists(p))) {
			add('WARN', 'R16', `环境常量引用的路径已不存在 -> ${p}（索引里的环境常量被未来召回盲信，确认新路径后更新）`);
		}
	}

	// Collected during the pass below so the temperature analysis can reuse these
	// reads instead of hitting the disk a second time for every file.
	const fnTexts = new Map();
	const fnMtimes = new Map();
	const insightTexts = [];

	for (const zone of ['functions', 'insights']) {
		const dir = path.join(root, zone);
		let files = [];
		try {
			files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
		} catch {
			/* zone absent */
		}
		for (const f of files.sort()) {
			const fp = path.join(dir, f);
			const text = await readFile(fp, 'utf8');
			const stripped = stripCode(text);
			if (zone === 'functions') {
				const slug = f.replace(/\.md$/, '');
				fnTexts.set(slug, text);
				try {
					fnMtimes.set(slug, (await stat(fp)).mtimeMs);
				} catch {
					/* mtime is best-effort */
				}
				const size = byteLen(text);
				if (size > opts.maxFunctionBytes) {
					const fname = f.replace(/\.md$/, '');
					add('WARN', 'R9', `functions/${f} ${size}B > ${opts.maxFunctionBytes}B — 调用 memory_fold(feature="${fname}") 折叠最旧块`);
				}
				if (REVERSE_DETAIL_FULL.test(stripped)) {
					add('FAIL', 'R8', `functions/${f} 反向链接 MEMORY.md 的细节块：细节应移回本文件，MEMORY.md 只留指针`);
				} else if (REVERSE_DETAIL_VAGUE.test(stripped)) {
					add('WARN', 'R8', `functions/${f} “详见 MEMORY.md”目标不明（人工确认）`);
				}
				const dates = [...stripped.matchAll(DATE_TAG)].map((m) => `${m[1]}${m[2]}${m[3]}`);
				for (let i = 1; i < dates.length; i++) {
					if (dates[i] < dates[i - 1]) {
						add('WARN', 'R3', `functions/${f} 迭代日期标签非递增（不是追加写入）`);
						break;
					}
				}
				// R3 head guardrail (from the workbuddy skill variant): the head
				// 「当前状态摘要（截至 date）」 must not be older than the newest
				// iteration block — appending without refreshing the head is exactly
				// the "改头忘尾" drift this check makes visible.
				const mHead = /当前状态摘要（截至\s*(\d{4})-(\d{2})-(\d{2})/.exec(stripped);
				if (mHead && dates.length) {
					const head = `${mHead[1]}${mHead[2]}${mHead[3]}`;
					const newest = dates[dates.length - 1];
					if (head < newest) {
						add('WARN', 'R3', `functions/${f} 头部状态摘要截至 ${mHead.slice(1).join('-')} 早于最新迭代块 ${newest.slice(0, 4)}-${newest.slice(4, 6)}-${newest.slice(6)}：追加迭代须成对刷新头部摘要`);
					}
				} else if (!mHead && dates.length) {
					add('WARN', 'R3', `functions/${f} 缺少「当前状态摘要（截至 YYYY-MM-DD）」头部摘要`);
				}
				// R14: an iteration block is a distilled conclusion, not a process log.
				for (const b of splitIterationBlocks(text)) {
					const n = charLen(b.body);
					if (n > MAX_BLOCK_CHARS) {
						add('WARN', 'R14', `functions/${f} 迭代块「${b.title}」正文 ${n} 字 > ${MAX_BLOCK_CHARS}（未蒸馏）：压成 动因/改动结论/判据/待观察 各一句，过程留在会话与代码里`);
						break; // one report per file is enough
					}
				}
			} else {
				insightTexts.push(text);
			}
			await checkLinks(text, fp, root, add);
		}
	}

	try {
		for (const f of await readdir(root)) {
			if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
			await checkLinks(await readFile(path.join(root, f), 'utf8'), path.join(root, f), root, add);
		}
	} catch {
		/* root absent */
	}

	try {
		for (const f of await readdir(path.join(root, 'legacy'))) {
			if (!f.endsWith('.md')) continue;
			const text = await readFile(path.join(root, 'legacy', f), 'utf8');
			if (!text.includes('历史原貌')) add('WARN', 'R13', `legacy/${f} 缺少“历史原貌”头部（不得并入当前 functions/）`);
		}
	} catch {
		/* no legacy dir */
	}

	// Memory temperature (cold-area candidates): for every function file count
	// inbound references from OTHER function files (related links) and insight
	// backlinks. The index row and daily threads are excluded — both are
	// auto-generated for every write, so they carry no signal. Zero deep
	// references means nothing ever linked back: brand new or going cold.
	// Files touched within `newFeatureGraceDays` are skipped: a feature written
	// today has had no chance to be backlinked yet, so flagging it is noise.
	try {
		const fnNames = [...fnTexts.keys()];
		const graceMs = Math.max(0, opts.newFeatureGraceDays) * 24 * 60 * 60 * 1000;
		if (fnNames.length > 1) {
			const refText = [...insightTexts, ...fnTexts.values()].join('\n');
			for (const name of fnNames) {
				const mtime = fnMtimes.get(name);
				if (graceMs > 0 && typeof mtime === 'number' && Date.now() - mtime < graceMs) continue;
				const own = fnTexts.get(name) ?? '';
				// Guarded memories opt out: a low-frequency, high-value area (security
				// audit, a兜底 rule) must not be judged cold for being quiet.
				if (own.includes(GUARD_MARK)) continue;
				// Two link spellings exist: index-style `functions/<name>.md` and
				// bare sibling `](<name>.md)` inside functions/ files. Count both,
				// minus the file's own occurrences.
				const idxStyle = refText.split(`functions/${name}.md`).length - 1 - (own.split(`functions/${name}.md`).length - 1);
				const bareStyle = refText.split(`](${name}.md)`).length - 1 - (own.split(`](${name}.md)`).length - 1);
				const inbound = idxStyle + bareStyle;
				if (inbound === 0) {
					add('WARN', 'TEMP', `functions/${name}.md 除索引行外没有任何其他记忆引用（冷记忆）：确认它是仍在活跃维护，还是应并入相关功能域（memory_rename）或折叠（memory_fold）；低频高价值的记忆请用 memory_write guard=true 标为守护型`);
				}
			}
		}
	} catch {
		/* temperature analysis is best-effort */
	}

	// R18 (circuit breaker): a function area that keeps getting corrected is not
	// "another iteration" — the article's rule is that a hot area whose error
	// rate spikes should stop automatic appends and be rebuilt instead. Uses the
	// usage log (correction signals) when it exists; silent without signals.
	try {
		const usage = await readUsage(root, 7);
		if (usage.length) {
			const perHref = new Map();
			for (const e of usage) {
				const href = String(e.href ?? '');
				if (!href.startsWith('functions/')) continue;
				const cur = perHref.get(href) ?? { uses: 0, corrections: 0 };
				if (e.kind === 'recall' || e.kind === 'read') cur.uses++;
				else if (e.kind === 'correction') cur.corrections++;
				perHref.set(href, cur);
			}
			for (const [href, c] of perHref) {
				if (c.corrections >= 3 && c.corrections / Math.max(1, c.uses + c.corrections) > 0.4) {
					add('WARN', 'R18', `${href} 近 7 天被纠正 ${c.corrections} 次、使用 ${c.uses} 次（纠正率 > 40%）：熔断——先重构该域再继续追加迭代，别把问题压进历史`);
				}
			}
		}
	} catch {
		/* usage log is optional */
	}

	const warnCount = results.filter((r) => r.level === 'WARN').length;
	const failCount = results.filter((r) => r.level === 'FAIL').length;
	return { root, results, warnCount, failCount };
}

/**
 * Panel presentation view of a health result: an uninitialized memory root
 * (the only problem is R0) is a neutral "not yet started" state, not a FAIL —
 * the agent-facing memory_check keeps R0 as FAIL to prompt the first write.
 */
function panelizeHealth(health) {
	const uninit = health.results.length === 1 && health.results[0].rule === 'R0';
	return {
		root: health.root,
		initialized: !uninit,
		failCount: uninit ? 0 : health.failCount,
		warnCount: uninit ? 0 : health.warnCount,
		results: uninit ? [] : health.results,
	};
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

function memoryReadTool(opts) {
	return defineTool({
		name: 'memory_read',
		description:
			'Read the function-area project memory. Start with kind=index (MEMORY.md: dual tables whose one-line summaries let you judge relevance without opening files, plus consensus and env constants), then open the exact function/insight file you need. Daily logs are one-line decision threads (kind=daily defaults to the latest day). kind=function/insight WITHOUT a name lists that directory with sizes.',
		parameters: {
			kind: {
				type: 'string',
				required: true,
				enum: ['index', 'function', 'insight', 'daily'],
				description: 'index=MEMORY.md; function=functions/<name>.md; insight=insights/<name>.md; daily=YYYY-MM-DD.md (latest when date omitted).',
			},
			name: {
				type: 'string',
				description: 'Feature or theme slug (no .md). Required for reading one file; omit to list the directory.',
			},
			date: { type: 'string', description: 'YYYY-MM-DD for kind=daily; defaults to the latest daily log.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					found: { type: 'boolean', required: true },
					path: { type: 'string', required: true },
					content: { type: 'string', required: true },
					listing: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string', required: true },
								bytes: { type: 'integer', required: true },
								mtime: { type: 'string', required: true },
							},
						},
					},
				},
			},
			render: (_args, v) => {
				if (!v.found && v.listing.length === 0) {
					return [{ type: 'text', text: `未找到：${v.path}。记忆还是空的——先用 memory_write 记录第一次迭代。` }];
				}
				if (v.content) return [{ type: 'text', text: v.content }];
				if (v.listing.length) {
					return [{ type: 'text', text: v.listing.map((e) => `- ${e.name}（${e.bytes}B，更新于 ${e.mtime}）`).join('\n') }];
				}
				return [{ type: 'text', text: `${v.path} 存在但为空。` }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Read memory: ${args.kind}${args.name ? `/${args.name}` : ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			if (args.kind === 'index') {
				const p = path.join(root, 'MEMORY.md');
				const text = await readIfExists(p);
				return { found: text !== undefined, path: p, content: text ?? '', listing: [] };
			}
			if (args.kind === 'function' || args.kind === 'insight') {
				const dir = path.join(root, args.kind === 'function' ? 'functions' : 'insights');
				if (!args.name) {
					const listing = await listMdDir(dir);
					return { found: listing.length > 0, path: dir, content: '', listing };
				}
				const slug = safeSlug(args.name);
				const p = path.join(dir, `${slug}.md`);
				const text = await readIfExists(p);
				if (text === undefined) {
					const listing = await listMdDir(dir);
					return { found: false, path: p, content: '', listing };
				}
				await appendUsage(root, { href: `${args.kind === 'function' ? 'functions' : 'insights'}/${slug}.md`, kind: 'read' });
				return { found: true, path: p, content: text, listing: [] };
			}
			// daily
			if (typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date.trim())) {
				const p = path.join(root, `${args.date.trim()}.md`);
				const text = await readIfExists(p);
				if (text !== undefined) await appendUsage(root, { href: `${args.date.trim()}.md`, kind: 'read' });
				return { found: text !== undefined, path: p, content: text ?? '', listing: [] };
			}
			let latest;
			try {
				for (const f of await readdir(root)) {
					if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f) && (!latest || f > latest)) latest = f;
				}
			} catch {
				/* root missing */
			}
			const p = latest ? path.join(root, latest) : path.join(root, `${localDateStr()}.md`);
			const text = latest ? await readIfExists(p) : undefined;
			return { found: text !== undefined, path: p, content: text ?? '', listing: [] };
		},
	});
}

// ---------------------------------------------------------------------------
// memory_search — on-demand ranked retrieval over the whole memory root
// ---------------------------------------------------------------------------

function memorySearchTool(opts) {
	return defineTool({
		name: 'memory_search',
		description:
			'Ranked full-text search across the ENTIRE memory root (index, functions/, insights/, daily logs) and return the best matching lines with their zone, file, line number, section heading and a snippet. Use it when you remember something was recorded but cannot tell which function area or which day: memory_read kind=index only scans one-line summaries, while this scans the bodies. Ranking is lexical (query substring, token hits, section heading, file name) with per-file caps, so a broad keyword does not return one file\'s whole history. Read the file afterwards with memory_read before re-deriving anything.',
		parameters: {
			q: { type: 'string', required: true, description: '检索词：一个词或短句（≥2 字符）。中文子串与英文单词都支持。' },
			zone: { type: 'string', enum: ['all', 'functions', 'insights', 'daily'], description: '限定检索分区，缺省 all（含索引）。' },
			limit: { type: 'integer', description: '最多返回多少条命中（默认 20，最大 50）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					count: { type: 'integer', required: true },
					hits: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								zone: { type: 'string', required: true },
								name: { type: 'string', required: true },
								line: { type: 'integer', required: true },
								heading: { type: 'string', required: true },
								snippet: { type: 'string', required: true },
							},
						},
					},
				},
			},
			render: (_args, v) => {
				if (!v.count) return [{ type: 'text', text: '没有命中：换一个更具体的关键词，或先 memory_read kind=index 看分区摘要。' }];
				const lines = [`命中 ${v.count} 条（按相关度排序）：`];
				for (const h of v.hits) {
					lines.push(`- [${h.zone}] ${h.name}:${h.line}${h.heading ? ` · ${h.heading}` : ''} — ${h.snippet}`);
				}
				lines.push('调用 memory_read 打开命中文件确认上下文，再决定是否追加迭代。');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Search memory: ${args.q ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const q = oneLine(args.q);
			if (charLen(q) < 2) throw new Error('q must be at least 2 characters');
			const zone = ['functions', 'insights', 'daily'].includes(args.zone) ? args.zone : 'all';
			const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50);
			const hits = await searchMemory(root, q, { zone, limit });
			return { count: hits.length, hits };
		},
	});
}

// ---------------------------------------------------------------------------
// federation (three-tier mode): project truth sources -> federation layer -> global
// ---------------------------------------------------------------------------

const FED_TABLE_HEADING = '## 项目索引（联邦层）';
const FED_TABLE_HEADER = '| 项目 | 记忆规模 | 来源副本 |';
const FED_CONSENSUS_HEADING = '## 跨项目共识';

/** Read + validate the federation config; throws with an explicit fix-it message. */
function federationConfig(opts) {
	const fed = opts.federation;
	if (!fed || typeof fed !== 'object') {
		throw new Error('未配置联邦模式：在插件配置里给出 federation: { root, projects: [{ key, root }] }');
	}
	if (!fed.root || typeof fed.root !== 'string') throw new Error('federation.root 缺失（联邦层记忆根目录）');
	const projects = Array.isArray(fed.projects) ? fed.projects : [];
	if (!projects.length) throw new Error('federation.projects 为空：至少列出 { key, root } 两个字段');
	const seen = new Set();
	const out = projects.map((p) => {
		const key = String(p?.key ?? '').trim();
		if (!key) throw new Error('federation.projects 每一项都需要 key');
		if (!/^[\w\u4e00-\u9fff.-]{1,40}$/.test(key)) throw new Error(`项目 key 不合法（不要带路径分隔符）：${key}`);
		const lower = key.toLowerCase();
		if (seen.has(lower)) throw new Error(`项目 key 重复：${key}`);
		seen.add(lower);
		if (!p?.root || typeof p.root !== 'string') throw new Error(`项目 ${key} 缺 root（该项目记忆根目录）`);
		return { key, root: path.resolve(p.root) };
	});
	return { root: path.resolve(fed.root), projects: out };
}

/** Mechanical federation index: one row per project (no semantic fusion here). */
function federationIndexText(rows) {
	return [
		'# 联邦记忆（跨项目索引）',
		'',
		'> 本层只做**跨项目整合**：项目真相源留在各项目自己的记忆根，这里存它们 `MEMORY.md` 的副本与一张项目索引。',
		'> `memory_federation(action=sync)` 刷新副本与索引行；跨项目共识由模型蒸馏后写在下方小节，不自动生成。',
		'',
		FED_TABLE_HEADING,
		'',
		FED_TABLE_HEADER,
		'|---|---|---|',
		...rows,
		'',
		FED_CONSENSUS_HEADING,
		'',
		'- ',
		'',
	].join('\n');
}

// ---------------------------------------------------------------------------
// memory_usage — usage signals and data-driven layer suggestions
// ---------------------------------------------------------------------------

function memoryUsageTool(opts) {
	return defineTool({
		name: 'memory_usage',
		description:
			'Record and read USAGE signals, the data that lets the memory sort itself. action=record logs one event against a memory file (kind: correction = the user corrected / rejected what was recalled or written; positive = explicit confirmation like "对了/就是这个"; recall/read are logged automatically). action=report aggregates the last N days per file and suggests a layer: 实验 (<3 uses), 专项 (>=3 uses + >=1 confirmation), 通用 (>=10 uses + >=2 confirmations + correction rate <20%). Layers are suggestions for the model to act on — this tool never moves files.',
		parameters: {
			action: { type: 'string', required: true, enum: ['record', 'report'], description: 'record=记一次信号；report=按天聚合出分层建议。' },
			href: { type: 'string', description: 'record 必填：目标记忆文件，如 `functions/批印坊工程加固.md`、`insights/逐帧渲染取帧三闸.md`、`2026-10-18.md`。' },
			kind: { type: 'string', enum: ['correction', 'positive', 'recall', 'read'], description: 'record 必填：correction=用户纠正/否定，positive=用户明确认可，recall/read 一般由插件自动记录。' },
			note: { type: 'string', description: 'record 可选：一句话说明（例如用户原话），便于日后复盘。' },
			days: { type: 'integer', description: 'report 的统计窗口（天，默认 30）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					days: { type: 'integer', required: true },
					items: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								href: { type: 'string', required: true },
								uses: { type: 'integer', required: true },
								recalls: { type: 'integer', required: true },
								reads: { type: 'integer', required: true },
								corrections: { type: 'integer', required: true },
								positives: { type: 'integer', required: true },
								badRate: { type: 'number', required: true },
								layer: { type: 'string', required: true },
								lastUsed: { type: 'string', required: true },
							},
						},
					},
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				if (!v.items.length) return [{ type: 'text', text: '还没有使用信号。信号来自召回注入、memory_read、以及你用 memory_usage(action=record) 记录的纠正/认可。' }];
				const lines = [`近 ${v.days} 天使用信号（按使用次数排序）：`];
				for (const it of v.items) {
					lines.push(`- [${it.layer}] ${it.href} · 用 ${it.uses}（召回 ${it.recalls}/读 ${it.reads}）· 纠正 ${it.corrections} · 认可 ${it.positives} · 纠正率 ${it.badRate}`);
				}
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				lines.push('层只是建议：通用=可进默认推荐，专项=常规池，实验=仍在小范围验证。');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory usage: ${args.action ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const days = Math.min(Math.max(1, Number(args.days) || 30), 365);
			const warnings = [];
			if (args.action === 'record') {
				const href = oneLine(args.href);
				if (!/^(functions|insights)\/[^/]+\.md$/.test(href) && !/^\d{4}-\d{2}-\d{2}\.md$/.test(href)) {
					throw new Error('href 必须是 functions/<名>.md、insights/<名>.md 或 YYYY-MM-DD.md');
				}
				const kind = ['correction', 'positive', 'recall', 'read'].includes(args.kind) ? args.kind : null;
				if (!kind) throw new Error('kind 必须是 correction / positive / recall / read');
				await appendUsage(root, { href, kind, note: oneLine(args.note ?? '') || undefined });
				return { action: 'record', days, items: [], warnings: [`已记录：${kind} → ${href}${args.note ? `（${oneLine(args.note)}）` : ''}`] };
			}
			const entries = await readUsage(root, days);
			const items = summarizeUsage(entries).map((it) => ({
				href: it.href,
				uses: it.uses,
				recalls: it.recalls,
				reads: it.reads,
				corrections: it.corrections,
				positives: it.positives,
				badRate: it.badRate,
				layer: it.layer,
				lastUsed: new Date(it.last).toISOString(),
			}));
			const hot = items.filter((it) => it.layer === '通用').length;
			if (hot) warnings.push(`${hot} 条已达到「通用」建议线：可考虑在索引行里标明它是标配工具，或让它进默认推荐`);
			const bad = items.filter((it) => it.uses >= 3 && it.badRate > 0.4);
			for (const b of bad) warnings.push(`${b.href} 纠正率 ${Math.round(b.badRate * 100)}%（>40%）：先重构这条记忆，别继续往上叠迭代`);
			return { action: 'report', days, items, warnings };
		},
	});
}

function memoryFederationTool(opts) {
	return defineTool({
		name: 'memory_federation',
		description:
			'Three-tier federation mode (opt-in via plugin config `federation: { root, projects: [{ key, root }] }`). action=sync copies every configured project\'s MEMORY.md into `<federation.root>/sources/<key>.MEMORY.md` and rebuilds the federation index table (one mechanical row per project: size + link). action=check lints the federation layer: missing index, dangling links, missing project roots, missing/orphan copies, and env-constant absolute paths that no longer exist. Project truth sources are never edited by this tool, and cross-project consensus is NOT auto-distilled — the model writes that section itself.',
		parameters: {
			action: { type: 'string', required: true, enum: ['sync', 'check'], description: 'sync=刷新副本与索引行；check=只读体检（F1–F5）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					federationRoot: { type: 'string', required: true },
					projects: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								key: { type: 'string', required: true },
								copied: { type: 'boolean', required: true },
								bytes: { type: 'integer', required: true },
								functions: { type: 'integer', required: true },
								insights: { type: 'integer', required: true },
								daily: { type: 'integer', required: true },
							},
						},
					},
					findings: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								level: { type: 'string', required: true, enum: ['WARN', 'FAIL'] },
								rule: { type: 'string', required: true },
								message: { type: 'string', required: true },
							},
						},
					},
					failCount: { type: 'integer', required: true },
					warnCount: { type: 'integer', required: true },
				},
			},
			render: (_args, v) => {
				const lines = [
					`联邦层：${v.federationRoot}（${v.action}）`,
					...v.projects.map((p) => `- ${p.key}: ${p.copied ? '已同步' : '未同步'} · ${p.bytes}B · ${p.functions} 功能 / ${p.insights} 思想 / ${p.daily} 日线索`),
				];
				if (!v.findings.length) lines.push('体检：全部通过（F1–F5）');
				else {
					lines.push(`体检：${v.failCount} FAIL，${v.warnCount} WARN`);
					for (const f of v.findings) lines.push(`  [${f.level}] ${f.rule}: ${f.message}`);
				}
				if (v.action === 'sync') lines.push('ℹ 跨项目共识不会自动生成——需要时把蒸馏结论写进「跨项目共识」小节。');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory federation: ${args.action ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const fed = federationConfig(opts);
			const findings = [];
			const add = (level, rule, message) => findings.push({ level, rule, message });
			const sourcesDir = path.join(fed.root, 'sources');
			await mkdir(sourcesDir, { recursive: true });
			const projects = [];
			for (const p of fed.projects) {
				const memPath = path.join(p.root, 'MEMORY.md');
				const text = await readIfExists(memPath);
				const counts = await zoneCounts(p.root);
				if (text === undefined) {
					add('FAIL', 'F3', `项目 ${p.key} 的记忆根里没有 MEMORY.md：${p.root}`);
					projects.push({ key: p.key, copied: false, bytes: 0, ...counts });
					continue;
				}
				const bytes = byteLen(text);
				let copied = false;
				if (args.action === 'sync') {
					await writeText(path.join(sourcesDir, `${p.key}.MEMORY.md`), text);
					copied = true;
				} else {
					copied = await statExists(path.join(sourcesDir, `${p.key}.MEMORY.md`));
					if (!copied) add('FAIL', 'F3', `缺少来源副本 sources/${p.key}.MEMORY.md（先 action=sync）`);
				}
				projects.push({ key: p.key, copied, bytes, ...counts });
			}
			const indexPath = path.join(fed.root, 'MEMORY.md');
			if (args.action === 'sync') {
				const rows = projects.map((p) => `| ${p.key} | ${p.functions} 功能 · ${p.insights} 思想 · ${p.daily} 日线索 · ${p.bytes}B | [sources/${p.key}.MEMORY.md](sources/${p.key}.MEMORY.md) |`);
				const existing = await readIfExists(indexPath);
				let next = federationIndexText(rows);
				if (existing !== undefined) {
					// Keep everything the model distilled (consensus + notes) and only
					// replace this tool's own table block.
					next = existing.replace(/\n## 项目索引（联邦层）[\s\S]*?(?=\n## |$)/, `\n${FED_TABLE_HEADING}\n\n${[FED_TABLE_HEADER, '|---|---|---|', ...rows].join('\n')}\n`);
					if (!next.includes(FED_TABLE_HEADING)) next = federationIndexText(rows);
				}
				await writeText(indexPath, next);
			} else {
				// F1: federation index exists
				const idxText = await readIfExists(indexPath);
				if (idxText === undefined) {
					add('FAIL', 'F1', `联邦层没有 MEMORY.md：${indexPath}（先 action=sync）`);
				} else {
					// F2: in-tree links resolve (the shared link scanner reports R10/R10e;
					// remap it to the federation rule names so findings read coherently).
					await checkLinks(idxText, indexPath, fed.root, (level, rule, message) => add(level, rule.startsWith('R10') ? 'F2' : rule, message));
					for (const m of idxText.matchAll(/`([^`\n|]+)`/g)) {
						const p0 = m[1].trim().replace(/[/\\]+$/, '');
						if (!/^[A-Za-z]:[\\/]/.test(p0) && !p0.startsWith('/')) continue;
						if (!(await statExists(p0))) add('WARN', 'F4', `联邦层引用的绝对路径已不存在 -> ${p0}`);
					}
					// F5: orphan copies
					let copies = [];
					try {
						copies = (await readdir(sourcesDir)).filter((n) => n.endsWith('.MEMORY.md'));
					} catch {
						/* none */
					}
					for (const c of copies) {
						if (!fed.projects.some((p) => `${p.key}.MEMORY.md` === c)) {
							add('WARN', 'F5', `孤儿副本 sources/${c} 不对应任何已配置项目（移走或补配置）`);
						}
					}
					for (const p of fed.projects) {
						if (!idxText.includes(`sources/${p.key}.MEMORY.md`)) add('FAIL', 'F3', `项目索引表缺少 ${p.key} 一行（重新 sync）`);
					}
				}
			}
			const failCount = findings.filter((f) => f.level === 'FAIL').length;
			const warnCount = findings.filter((f) => f.level === 'WARN').length;
			return { action: args.action, federationRoot: fed.root, projects, findings, failCount, warnCount };
		},
	});
}

async function listMdDir(dir) {
	let entries = [];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const out = [];
	for (const f of entries.filter((n) => n.endsWith('.md')).sort()) {
		const st = await stat(path.join(dir, f));
		out.push({ name: f.replace(/\.md$/, ''), bytes: st.size, mtime: st.mtime.toISOString() });
	}
	// Newest-first: every listing consumer (model recall, panel) wants the
	// latest state at the top, not a file-manager's alphabetical order.
	out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
	return out;
}

function memoryWriteTool(opts) {
	return defineTool({
		name: 'memory_write',
		description:
			'Append ONE iteration block to functions/<feature>.md (distilled conclusion, not a process log; dates are tags, blocks are append-only) and refresh the file-head stable-state summary via `currentState`. The daily log (YYYY-MM-DD.md) is the RAW layer — the model/harness records whatever it wants there with any means; this tool never touches it. The MEMORY.md index row is written separately (memory_index) once a feature area stabilizes, so distillation flows daily → functions → index, one direction per step. A block is a DISTILLED conclusion (动因 / 改动 / 判据 / 待观察, one line each): per-step changelists, code-level enumerations and debugging process stay in the session, the daily log and the code — writing them into the block is the failure R14 flags.',
		parameters: {
			feature: { type: 'string', required: true, description: '功能域 slug（文件名，不含 .md）：这个迭代属于哪个功能/模块；不确定就先 memory_read kind=index。' },
			title: { type: 'string', required: true, description: '一句话结论式标题，如“修复 config 加载顺序导致的空指针”；不要“优化了一些问题”这类空话。' },
			change: { type: 'string', description: '改动（结论级，1-3 句）：现在是什么行为 / 改了什么。不写过程——逐条实现清单、代码级枚举、调试经过都不进记忆（留在会话与代码/提交里）。' },
			reason: { type: 'string', description: '原因（一句话）：为什么必须改（用户诉求 / 缺陷根因）。' },
			verification: { type: 'string', description: '验证（一句话 + 关键数字）：测试名/命令/实测现象；不要复述全部断言细节。' },
			result: { type: 'string', enum: ['done', 'reverted', 'pending'], description: '结果：done=完成 / reverted=已回滚 / pending=进行中。' },
			open: { type: 'string', description: '待观察（一句话）：遗留风险或下一步要确认什么。' },
			guard: { type: 'boolean', description: '守护型标记：低频高价值、绝不能因为"很久没写"被判冷记忆的记忆（安全审计、关键踩坑、兜底规则）。写入后文件头带 🛡 标记，体检 TEMP 跳过它；传 false 不解除已有标记（删掉文件头那行才真正解除）。' },
			related: { type: 'array', description: '相关功能域 slug 列表，渲染为迭代块内的“相关”链接。', items: { type: 'string' } },
			summary: { type: 'string', required: true, description: '本块的一句话概括（≤60 字）：从每日原始记录蒸馏本迭代时，它回答“这次迭代做了什么/解决了什么”。功能域稳定后由 memory_index 把它收进索引行。' },
			currentState: { type: 'string', description: '刷新文件头部“当前状态摘要”：只写当前稳定行为/关键约束/隐患（3-5 条），不写历史与过程。' },
			date: { type: 'string', description: '迭代日期 YYYY-MM-DD；缺省今天。同日第二个迭代自动加“补”后缀。' },
			replace: {
				type: 'string',
				description: '可选：写完迭代块后在本功能文件内做字面替换（全部出现）。JSON 形式 {"oldString":"...","newString":"..."} 或其数组；找不到目标时报错。用于修正既往迭代块笔误/死链，审计上等价于追加一次修正迭代。',
			},
			resolve: {
				type: 'string',
				description: '可选：功能域 slug，声明本迭代解决了该功能遗留的待观察项。自动把各每日日志“今日待观察”里指向该功能的条目标记 ✅ 已解决（勾掉语义，不重抄）。',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					featureFile: { type: 'string', required: true },
					appendedHeading: { type: 'string', required: true },
					createdFunctionFile: { type: 'boolean', required: true },
					functionBytes: { type: 'integer', required: true },
					resolvedDailyLogs: { type: 'array', required: true, items: { type: 'string' } },
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [
					`已写入：${v.appendedHeading}`,
					`功能文件：${v.featureFile}（${v.functionBytes}B${v.createdFunctionFile ? '，新建' : ''}）`,
				];
				if (v.resolvedDailyLogs.length) lines.push(`✅ 已勾掉待观察项：${v.resolvedDailyLogs.join('、')}`);
				lines.push('ℹ 索引行未自动写入——功能域稳定后用 memory_index 收进索引；每日记录是原始层，由模型自主维护。');
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory write: ${args.feature ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const feature = safeSlug(args.feature);
			const date = normDate(args.date);
			const title = oneLine(args.title);
			if (!title) throw new Error('title is required');
			const summary = oneLine(args.summary);
			if (!summary) throw new Error('summary is required: the MEMORY.md index row must carry a one-line summary');
			const warnings = [];

			const indexPath = path.join(root, 'MEMORY.md');
			const indexNow = await readIfExists(indexPath);
			if (indexNow !== undefined && byteLen(indexNow) >= opts.maxIndexHardBytes) {
				throw new Error(
					`MEMORY.md 已 ${byteLen(indexNow)}B ≥ 硬上限 ${opts.maxIndexHardBytes}B：先压缩索引行或按 ### 子分区拆分（拒绝写入以保护索引扫描成本）`,
				);
			}

			// 0) duplicate suspicion (dedupe aid): compare the new summary with
			// every existing index row via token overlap. High overlap on a
			// DIFFERENT feature warns the model to confirm add-vs-update first.
			if (indexNow !== undefined) {
				const sumTokens = tokensOf(summary);
				for (const raw of indexNow.split('\n')) {
					const s = raw.trim();
					if (!s.startsWith('|') || s.includes('---')) continue;
					const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
					if (cells.length < 3 || !cells[1]) continue;
					const rowName = cells[0];
					if (rowName === feature) continue; // updating its own row is fine
					const rowTokens = tokensOf(`${cells[1]} ${cells[3] ?? ''}`);
					let hit = 0;
					for (const tk of sumTokens) if (rowTokens.has(tk)) hit++;
					if (sumTokens.size > 0 && hit / sumTokens.size >= 0.6) {
						warnings.push(`疑似与已有功能域「${rowName}」重复（摘要重合 ${(hit / sumTokens.size * 100) | 0}%）：先 memory_read kind=index 确认这是新功能还是对既有功能的更新；若为更新，直接对 ${rowName} 追加迭代`);
						break;
					}
				}
			}

			// 1) function file: create / refresh head summary / append iteration block
			const fnPath = path.join(root, 'functions', `${feature}.md`);
			let fnText = await readIfExists(fnPath);
			const created = fnText === undefined;
			if (created) fnText = functionFileTemplate(feature, date, args.guard === true);
			if (args.guard === true && !fnText.includes(GUARD_MARK)) {
				// Marking an existing file as guarded: insert the marker line right
				// after the scope line so the head reads top-down without surprises.
				const lines = fnText.split('\n');
				const scopeAt = lines.findIndex((l) => l.startsWith('> 范围：'));
				lines.splice(scopeAt === -1 ? 2 : scopeAt + 1, 0, GUARD_LINE);
				fnText = lines.join('\n');
			}
			if (args.currentState !== undefined) {
				const cs = String(args.currentState).trim();
				if (cs) fnText = refreshSummarySection(fnText, date, cs);
			}
			const suffixCount = countHeadingDate(fnText, date);
			const suffix = suffixCount === 0 ? '' : suffixCount === 1 ? '补' : `补${suffixCount}`;
			const heading = `## [${date}${suffix}] ${title}`;
			const bullets = [`- **概括**：${summary}`];
			if (args.change !== undefined && oneLine(args.change)) bullets.push(`- **改动**：${oneLine(args.change)}`);
			if (args.reason !== undefined && oneLine(args.reason)) bullets.push(`- **原因**：${oneLine(args.reason)}`);
			if (args.verification !== undefined && oneLine(args.verification)) bullets.push(`- **验证**：${oneLine(args.verification)}`);
			if (args.result !== undefined) bullets.push(`- **结果**：${RESULT_LABEL[args.result] ?? oneLine(args.result)}`);
			if (args.open !== undefined && oneLine(args.open)) bullets.push(`- **待观察**：${oneLine(args.open)}`);
			if (Array.isArray(args.related) && args.related.length) {
				// Sibling links: the host file already lives in functions/, so the
				// href must be bare `<name>.md`. Slugs without an existing file are
				// listed as plain text instead of dangling markdown links.
				const rels = [...new Set(args.related.map((r) => safeSlug(r)))].filter((r) => r !== feature);
				const rendered = [];
				for (const r of rels) {
					rendered.push(
						(await statExists(path.join(root, 'functions', `${r}.md`)))
							? `[${r}.md](${r}.md)`
							: `${r}（未建档）`,
					);
				}
				bullets.push(`- 相关：${rendered.length ? rendered.join('、') : '（无）'}`);
			}
			// Distillation gate: warn at write time instead of letting a process log
			// land silently (the same limits are re-checked by R14 in memory_check).
			const blockBody = bullets.join('\n');
			const blockChars = charLen(blockBody);
			if (blockChars > MAX_BLOCK_CHARS) {
				warnings.push(
					`本块正文 ${blockChars} 字 > ${MAX_BLOCK_CHARS}：迭代块只写结论（动因/改动/判据/待观察 各一句），逐条实现清单与调试过程留在会话/代码里；体检 R14 也会复查`,
				);
			}
			const summaryChars = charLen(args.summary);
			if (summaryChars > MAX_ROW_SUMMARY_CHARS) {
				warnings.push(`索引行摘要 ${summaryChars} 字 > ${MAX_ROW_SUMMARY_CHARS}：摘要是一句话（用来判断相关性），迭代细节留在功能文件`);
			}
			fnText = appendBlock(fnText, `\n${heading}\n\n${blockBody}\n`);
			if (typeof args.replace === 'string' && args.replace.trim()) {
				let pairs;
				try {
					const parsed = JSON.parse(args.replace);
					pairs = Array.isArray(parsed) ? parsed : [parsed];
				} catch {
					pairs = null;
				}
				if (!Array.isArray(pairs) || !pairs.length) {
					throw new Error('replace must be JSON: {"oldString":"...","newString":"..."} or an array of those');
				}
				for (const p of pairs) {
					if (typeof p?.oldString !== 'string' || !p.oldString || typeof p?.newString !== 'string') {
						throw new Error('each replace entry needs non-empty oldString and newString');
					}
					const count = fnText.split(p.oldString).length - 1;
					if (count === 0) throw new Error(`replace target not found in functions/${feature}.md: ${p.oldString.slice(0, 60)}`);
					fnText = fnText.split(p.oldString).join(p.newString);
				}
			}
			await writeText(fnPath, fnText);
			const fnBytes = byteLen(fnText);
			if (fnBytes > opts.maxFunctionBytes) {
				warnings.push(`functions/${feature}.md ${fnBytes}B > ${opts.maxFunctionBytes}B：调用 memory_fold(feature="${feature}") 折叠最旧块为早期演化段`);
			}

			// 2) index row is NOT auto-written anymore: the MEMORY.md index is the
			// integration layer (memory_index), written once a feature area
			// stabilizes — distillation flows daily → functions → index.

			// 3) the daily log is the RAW layer: the model/harness records there
			// freely with any means; this tool never touches it.

			// 4) resolve open items (R2 勾掉): mark still-open daily entries for
			// the resolved feature across logs from the day it was first raised.
			let resolvedIn = [];
			if (typeof args.resolve === 'string' && args.resolve.trim()) {
				const target = safeSlug(args.resolve);
				resolvedIn = await resolveOpenItems(root, target, '0000-01-01', date);
				if (!resolvedIn.length) warnings.push(`resolve: ${target} 在每日日志的待观察区没有未解决条目（可能已勾掉或不存在）`);
			}

			return {
				featureFile: fnPath,
				appendedHeading: heading,
				createdFunctionFile: created,
				functionBytes: fnBytes,
				resolvedDailyLogs: resolvedIn,
				warnings,
			};
		},
	});
}

function memoryInsightTool(opts) {
	return defineTool({
		name: 'memory_insight',
		description:
			'Distill a TRANSFERABLE PRINCIPLE (something you would RE-APPLY, not an operation you would re-run) into insights/<theme>.md with backlinks to its source feature files, and sync the MEMORY.md insights table. Consensus/rules and env constants belong in MEMORY.md instead; how-to steps belong in functions/. Writing the same idea into both zones is a rule violation.',
		parameters: {
			theme: { type: 'string', required: true, description: '思想主题 slug（文件名，不含 .md），如“等待策略”。' },
			principle: { type: 'string', required: true, description: '原则本体，具体地一句话说清（不要“注意性能”这类空话）。' },
			summary: { type: 'string', required: true, description: '索引行的一行内涵：这个原则解决什么权衡。' },
			sources: { type: 'array', required: true, description: '来源功能域 slug 列表（必须已存在于 functions/，用于回链）。', items: { type: 'string' } },
			evolution: { type: 'string', description: '思想演进：取代了什么旧做法 / 为什么。' },
			applicability: { type: 'string', description: '适用面：超出来源功能还适用于哪里。' },
			open: { type: 'string', description: '待观察：下一步要验证什么。' },
			supersedes: {
				type: 'string',
				description: '可选：被本思想取代的旧主题 slug（须已存在于 insights/）。自动给旧文件加“已取代”头部并链接到本主题（不删除，保留历史）。',
			},
			date: { type: 'string', description: 'YYYY-MM-DD；缺省今天。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					insightFile: { type: 'string', required: true },
					linkedSources: { type: 'array', required: true, items: { type: 'string' } },
					skippedSources: { type: 'array', required: true, items: { type: 'string' } },
					supersededFile: { type: 'string' },
					indexBytes: { type: 'integer', required: true },
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [`思想已沉淀：${v.insightFile}`];
				if (v.linkedSources.length) lines.push(`回链来源：${v.linkedSources.join('、')}`);
				if (v.skippedSources.length) lines.push(`⚠ 来源不存在，未回链：${v.skippedSources.join('、')}`);
				if (v.supersededFile) lines.push(`⚠️ 旧思想已标记取代：${v.supersededFile}`);
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory insight: ${args.theme ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			await mkdir(path.join(root, 'insights'), { recursive: true });
			const theme = safeSlug(args.theme);
			const principle = oneLine(args.principle);
			if (!principle) throw new Error('principle is required');
			const summary = oneLine(args.summary);
			if (!summary) throw new Error('summary is required: the insights index row must carry a one-line 内涵');
			const date = normDate(args.date);
			const warnings = [];

			const sources = (Array.isArray(args.sources) ? args.sources : []).map((s) => safeSlug(s));
			if (!sources.length) throw new Error('sources is required: at least one existing functions/ file to backlink');
			const linked = [];
			const skipped = [];
			for (const s of sources) {
				if (await statExists(path.join(root, 'functions', `${s}.md`))) linked.push(s);
				else skipped.push(s);
			}
			if (skipped.length) warnings.push(`来源不存在，未回链：${skipped.join('、')}（先用 memory_write 建立功能文件）`);
			const srcLine = linked.length ? linked.map((s) => `[functions/${s}.md](../functions/${s}.md)`).join('、') : '（来源缺失）';

			// 1) insight file
			const p = path.join(root, 'insights', `${theme}.md`);
			const existing = await readIfExists(p);
			let text;
			if (existing === undefined) {
				text = insightTemplate(theme, principle, srcLine, args.evolution, args.applicability, args.open, date);
			} else {
				text = replaceSection(existing, '## 核心原则', `- ${principle}`);
				const evo = `- ${date} 调整为：${principle}${args.evolution ? `（${oneLine(args.evolution)}）` : ''}`;
				text = appendUnderHeading(text, '## 思想演进', evo).text;
				text = text.replace(/^> 来源：.*$/m, `> 来源：${srcLine}`);
				// applicability is refreshed too: an evolved principle usually widens,
				// narrows, or replaces the scope it applies to.
				if (args.applicability !== undefined && oneLine(args.applicability)) {
					text = replaceSection(text, '## 适用面', `- ${oneLine(args.applicability)}`);
				}
				if (args.open !== undefined && oneLine(args.open)) text = appendUnderHeading(text, '## 待观察', `- ${oneLine(args.open)}`).text;
			}
			await writeText(p, text);

			// 1b) supersede (R12): stamp the old insight without deleting it.
			let supersededFile;
			if (typeof args.supersedes === 'string' && args.supersedes.trim()) {
				const oldTheme = safeSlug(args.supersedes);
				if (oldTheme === theme) throw new Error('supersedes must reference a DIFFERENT theme');
				const oldPath = path.join(root, 'insights', `${oldTheme}.md`);
				const oldText = await readIfExists(oldPath);
				if (oldText === undefined) {
					warnings.push(`supersedes: insights/${oldTheme}.md 不存在，未打标`);
				} else if (oldText.includes('> ⚠️ 已被取代')) {
					warnings.push(`supersedes: insights/${oldTheme}.md 已带有取代标记（检查链是否正确）`);
				} else {
					// The old file lives in insights/, so the successor href is a bare
					// sibling link (insights/-prefixed hrefs resolve to insights/insights/).
					const stamp =
						`> ⚠️ 已被取代 → [${theme}.md](${theme}.md)（${date}）。以下内容保留作为决策历史。`;
					const stamped = oldText.replace(/^/, `${stamp}\n\n`);
					await writeText(oldPath, appendUnderHeading(stamped, '## 思想演进', `- ${date} 被 [${theme}.md](${theme}.md) 取代`).text);
					supersededFile = oldPath;
				}
			}

			// 2) index row is NOT auto-written: insights land in the index via
			// memory_index when the theme stabilizes (same integration layer as
			// function areas).

			// 3) the daily log is the raw layer; this tool never touches it.

			// Omit `supersededFile` entirely when nothing was superseded: an
			// `undefined` property makes the tool result non-lossless JSON, which
			// the Host rejects even though the write already succeeded.
			const out = {
				insightFile: p,
				linkedSources: linked.map((s) => `functions/${s}.md`),
				skippedSources: skipped.map((s) => `functions/${s}.md`),
				warnings,
			};
			if (supersededFile) out.supersededFile = supersededFile;
			return out;
		},
	});
}

function memoryFoldTool(opts) {
	return defineTool({
		name: 'memory_fold',
		description:
			'Compress a function file (R9): fold the OLDEST iteration blocks into a single "早期演化" paragraph (keeps 结论 only — title, result, key lesson — drops step-by-step detail), keeping the head state summary and the most recent blocks verbatim. Use it when memory_check reports R9 or a write warns about size. The folded history stays recoverable: the paragraph names every folded date tag.',
		parameters: {
			feature: { type: 'string', required: true, description: '功能域 slug（functions/ 下的既有文件）。' },
			keep: { type: 'integer', description: '从最新块往回保留的块数（默认 3，最小 1）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					file: { type: 'string', required: true },
					foldedBlocks: { type: 'integer', required: true },
					keptBlocks: { type: 'integer', required: true },
					bytesBefore: { type: 'integer', required: true },
					bytesAfter: { type: 'integer', required: true },
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [
					`已折叠：${v.file}`,
					`折叠 ${v.foldedBlocks} 块为早期演化段，保留最近 ${v.keptBlocks} 块完整`,
					`体积 ${v.bytesBefore}B → ${v.bytesAfter}B`,
				];
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Fold memory: ${args.feature ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const feature = safeSlug(args.feature);
			const warnings = [];
			const p = path.join(root, 'functions', `${feature}.md`);
			const text = await readIfExists(p);
			if (text === undefined) throw new Error(`functions/${feature}.md 不存在`);
			const bytesBefore = byteLen(text);

			// Collect iteration blocks (## [date...] up to the next ## heading).
			const lines = text.split('\n');
			const headEnd = (() => {
				// The body starts after the first `---` separator (template) or at the
				// first iteration heading, whichever comes first.
				const sep = lines.findIndex((l) => l.trim() === '---');
				return sep === -1 ? lines.findIndex((l) => /^## \[/.test(l)) : sep + 1;
			})();
			const blockStarts = [];
			for (let i = Math.max(0, headEnd); i < lines.length; i++) {
				if (/^##\s*\[\d{4}-\d{2}-\d{2}/.test(lines[i])) blockStarts.push(i);
			}
			if (blockStarts.length === 0) throw new Error('没有可折叠的迭代块（文件里没有 [YYYY-MM-DD] 块）');
			const keep = Math.max(1, Math.min(Number.isFinite(args.keep) ? args.keep : 3, blockStarts.length - 1));
			if (blockStarts.length <= keep) throw new Error(`只有 ${blockStarts.length} 个迭代块，keep=${keep} 无需折叠`);

			const foldCount = blockStarts.length - keep;
			const foldFrom = blockStarts[0];
			const foldTo = blockStarts[foldCount]; // first kept block start
			const foldedLines = lines.slice(foldFrom, foldTo);
			const keptLines = lines.slice(foldTo);

			// Extract per-block: heading (date + title) and its bullets' key info.
			const summaries = [];
			let cur = null;
			for (const l of foldedLines) {
				const hm = l.match(/^##\s*\[([^\]]+)\]\s*(.+)$/);
				if (hm) {
					if (cur) summaries.push(cur);
					cur = { tag: hm[1], title: hm[2].trim(), results: [], lessons: [] };
				} else if (cur) {
					const rm = l.match(/^-\s*\*\*结果\*\*[:：]\s*(.+)$/);
					const om = l.match(/^-\s*\*\*待观察\*\*[:：]\s*(.+)$/);
					if (rm) cur.results.push(rm[1].trim());
					else if (om) cur.lessons.push(om[1].trim());
					else if (l.startsWith('- 相关：')) cur.lessons.push(l.trim());
				}
			}
			if (cur) summaries.push(cur);

			const evoLines = summaries.map((s) => {
				// One short line per folded block: tag + title, plus the result only
				// when it is informative (reverted/pending), never a bare "完成".
				const res = s.results.find((r) => r !== '完成');
				return `- [${s.tag}] ${s.title}${res ? `（${res}）` : ''}`;
			});
			const evoBlock = [
				`## 早期演化（${foldCount} 块已折叠：${summaries.map((s) => s.tag).join('→')}）`,
				'',
				...evoLines,
				'',
			];

			const newText = [...lines.slice(0, foldFrom), ...evoBlock, ...keptLines].join('\n');
			await writeText(p, newText);
			const bytesAfter = byteLen(newText);
			if (bytesAfter > opts.maxFunctionBytes) {
				warnings.push(`折叠后仍 ${bytesAfter}B > ${opts.maxFunctionBytes}B：再降低 keep 或压缩状态摘要`);
			}
			return {
				file: p,
				foldedBlocks: foldCount,
				keptBlocks: keep,
				bytesBefore,
				bytesAfter,
				warnings,
			};
		},
	});
}

function memoryRenameTool(opts) {
	return defineTool({
		name: 'memory_rename',
		description:
			'Rename or merge a function area (R10): moves functions/<from>.md to functions/<to>.md (merge = fold the old file\'s blocks under the target\'s head, when <to> already exists), rewrites EVERY in-memory-root reference (index row, related links in other function files, insight backlinks, daily logs), and verifies zero dangling links afterwards. The target file is canonical; a merged file is deleted after its content moves.',
		parameters: {
			from: { type: 'string', required: true, description: '现有功能域 slug。' },
			to: { type: 'string', required: true, description: '目标 slug：不存在 = 重命名；已存在 = 合并（旧块追加到目标文件末尾）。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					mode: { type: 'string', required: true, enum: ['renamed', 'merged'] },
					fromFile: { type: 'string', required: true },
					toFile: { type: 'string', required: true },
					rewrittenFiles: { type: 'array', required: true, items: { type: 'string' } },
					danglingAfter: { type: 'integer', required: true },
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [
					v.mode === 'renamed' ? `已重命名：${v.fromFile} → ${v.toFile}` : `已合并：${v.fromFile} 并入 ${v.toFile}`,
					`改写引用的文件：${v.rewrittenFiles.length ? v.rewrittenFiles.join('、') : '（无）'}`,
					`改写后死链数：${v.danglingAfter}`,
				];
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Rename memory: ${args.from ?? ''} → ${args.to ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const from = safeSlug(args.from);
			const to = safeSlug(args.to);
			if (from === to) throw new Error('from 与 to 相同');
			const warnings = [];
			const fromPath = path.join(root, 'functions', `${from}.md`);
			const toPath = path.join(root, 'functions', `${to}.md`);
			const fromText = await readIfExists(fromPath);
			if (fromText === undefined) throw new Error(`functions/${from}.md 不存在`);
			const toText = await readIfExists(toPath);
			const merging = toText !== undefined;

			// 1) move / merge content
			let finalToText;
			if (!merging) {
				finalToText = fromText;
				await writeText(toPath, finalToText);
				await (await import('node:fs/promises')).unlink(fromPath);
			} else {
				// Append the old file's iteration blocks under the target's head,
				// then rewrite intra-file links from `from` to `to` inside the moved
				// blocks; the source file is deleted (R10: no absorbed leftovers).
				const fromLines = fromText.split('\n');
				const firstBlock = fromLines.findIndex((l) => /^##\s*\[\d{4}-\d{2}-\d{2}/.test(l));
				const blockPart = firstBlock === -1 ? '' : fromText.slice(fromText.indexOf(fromLines[firstBlock]));
				const relinked = blockPart.split(`](${from}.md)`).join(`](${to}.md)`);
				finalToText = toText.replace(/\n*$/, '\n') + relinked;
				await writeText(toPath, finalToText);
				await (await import('node:fs/promises')).unlink(fromPath);
			}

			// 2) rewrite every reference across the memory root. Four spellings
			// exist: index link `functions/<from>.md`, bare sibling links
			// `](<from>.md)` inside functions/, `functions/<from>.md` prose, and
			// the index row's first cell `| <from> |`.
			const rewritten = [];
			const rewriteIn = async (fp) => {
				const before = await readIfExists(fp);
				if (before === undefined) return;
				let after = before
					// Label + href pairs first (both spellings), then bare prose.
					.split(`[${from}.md](${from}.md)`).join(`[${to}.md](${to}.md)`)
					.split(`[${from}.md](functions/${from}.md)`).join(`[${to}.md](functions/${to}.md)`)
					.split(`](${from}.md)`).join(`](${to}.md)`)
					.split(`](functions/${from}.md)`).join(`](functions/${to}.md)`)
					.split(`functions/${from}.md`).join(`functions/${to}.md`)
					.split(`| ${from} |`).join(`| ${to} |`);
				if (merging) {
					// A merged source's index row must go; the target row remains.
					// Order matters: the replace above already renamed the source row's
					// first cell to `to` (the replacement `| ${from} |` runs before this
					// filter), so match by the pre-rename spelling is impossible here.
					// Identify the stale row instead by its href: it still points at the
					// now-deleted `functions/${from}.md`… which the replace ALSO renamed.
					// The only stable trait left is the row's position: it sits in the
					// SAME table as the target's row and carries a different summary.
					// Simplest correct move: drop rows whose first cell is `to` beyond
					// the first occurrence — the kept one is whichever appears first.
					const lines = after.split('\n');
					let seenTarget = false;
					const cleaned = lines.filter((l) => {
						if (!l.startsWith('|')) return true;
						const cell0 = l.split('|')[1]?.trim();
						if (cell0 === to) {
							if (seenTarget) return false; // extra row created by the rename
							seenTarget = true;
						}
						return true;
					});
					after = cleaned.join('\n');
				}
				if (after !== before) {
					await writeText(fp, after);
					rewritten.push(path.relative(root, fp).split(path.sep).join('/'));
				}
			};
			await rewriteIn(path.join(root, 'MEMORY.md'));
			for (const zone of ['functions', 'insights']) {
				let names = [];
				try {
					names = (await readdir(path.join(root, zone))).filter((n) => n.endsWith('.md'));
				} catch {
					/* zone absent */
				}
				for (const n of names) await rewriteIn(path.join(root, zone, n));
			}
			try {
				for (const n of await readdir(root)) {
					if (/^\d{4}-\d{2}-\d{2}\.md$/.test(n)) await rewriteIn(path.join(root, n));
				}
			} catch {
				/* root absent */
			}

			// 3) verify: run the real checker and count dangling links
			const health = await runHealthCheck(root, opts);
			const danglingAfter = health.results.filter((r) => r.rule === 'R10' && r.level === 'FAIL').length;
			if (danglingAfter > 0) warnings.push(`改写后仍有 ${danglingAfter} 条死链（见 memory_check 输出，可再用 replace 修正残余字面量）`);
			if (merging) warnings.push(`合并完成：${from} 的块已追加到 ${to} 末尾，来源文件已删除；请确认 target 的状态摘要仍准确`);

			return {
				mode: merging ? 'merged' : 'renamed',
				fromFile: fromPath,
				toFile: toPath,
				rewrittenFiles: rewritten,
				danglingAfter,
				warnings,
			};
		},
	});
}

// ---------------------------------------------------------------------------
// proactive recall: pre-step index matching (agent/pre-step waterfall)
// ---------------------------------------------------------------------------

/** Extract meaningful tokens: CJK bigrams + latin words, minus stopwords. */
function tokensOf(text) {
	const t = String(text ?? '').toLowerCase();
	const out = new Set();
	for (const w of t.matchAll(/[a-z0-9_\-]{2,}/g)) out.add(w[0]);
	for (let i = 0; i < t.length - 1; i++) {
		const a = t[i];
		const b = t[i + 1];
		if (/[\u4e00-\u9fff]/.test(a) && /[\u4e00-\u9fff]/.test(b)) out.add(a + b);
	}
	for (const stop of ['这个', '那个', '什么', '怎么', '如何', '可以', '我们', '你们', '他们', '一个', '一下', '没有', '不是', '就是', '还有', '或者', '以及', '然后', '但是', '所以', '如果', '因为', 'the', 'and', 'for', 'with', 'this', 'that', 'have', 'not', '但', '的', '了', '吗', '呢', '吧']) {
		out.delete(stop);
	}
	return out;
}

/**
 * Score index rows against the user's tokens and return the top rows whose
 * overlap clears a small threshold. Pure and synchronous: runs in pre-step.
 *
 * v2 ranking (same cost class, much better precision):
 *  - IDF weighting: tokens shared by every row (e.g. 「功能」「记忆」) count for
 *    little; a rare token (「逐帧」「懒加载」) dominates. Without this, a query
 *    mentioning a common word outranks the row that is actually about it.
 *  - Name/slug hits are boosted: the row's own identity matching beats a
 *    passing mention inside its summary.
 *  - Relative threshold: rows scoring under 40% of the best match are dropped,
 *    so one strong hit does not drag three weak ones into the injection.
 *  - Dedupe by href (a table split into ### sub-sections can repeat a row).
 */
function matchIndexRows(indexText, userTokens, limit = 3) {
	const candidates = [];
	for (const raw of indexText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('|') || s.includes('---')) continue;
		const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
		if (cells.length < 3 || !cells[1]) continue;
		// rows: [name, summary, link, (extra summary)] — link cell carries zone.
		const link = cells[2] || '';
		const zm = link.match(/\(([^)]+\.md)\)/);
		if (!zm) continue;
		const href = zm[1];
		const zone = href.startsWith('insights/') ? 'insight' : href.startsWith('functions/') ? 'function' : null;
		if (!zone) continue;
		const name = href.split('/').pop().replace(/\.md$/, '');
		candidates.push({
			name,
			summary: cells[1],
			href,
			zone,
			nameTokens: tokensOf(name),
			bodyTokens: tokensOf(`${cells[1]} ${cells[3] ?? ''}`),
		});
	}
	if (!candidates.length) return [];
	// Document frequency per token across rows → IDF weights.
	const df = new Map();
	for (const c of candidates) {
		for (const tk of new Set([...c.nameTokens, ...c.bodyTokens])) df.set(tk, (df.get(tk) ?? 0) + 1);
	}
	const n = candidates.length;
	const idf = (tk) => 1 + Math.log(n / Math.max(1, df.get(tk) ?? n));
	const scored = [];
	for (const c of candidates) {
		let score = 0;
		for (const tk of userTokens) {
			if (c.nameTokens.has(tk)) score += 2 * idf(tk);
			else if (c.bodyTokens.has(tk)) score += idf(tk);
		}
		if (score > 0) scored.push({ name: c.name, summary: c.summary, href: c.href, zone: c.zone, score });
	}
	scored.sort((a, b) => b.score - a.score);
	const best = scored[0]?.score ?? 0;
	const seen = new Set();
	const out = [];
	for (const r of scored) {
		if (r.score < best * 0.4) break;
		if (seen.has(r.href)) continue;
		seen.add(r.href);
		out.push(r);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Ranked full-text search over the whole memory root. Shared by the
 * `memory_search` tool and the panel's /search route so both rank identically
 * (the panel used to do a naive indexOf, whose order was file order).
 */
async function searchMemory(root, rawQuery, { zone = 'all', limit = 20 } = {}) {
	const q = String(rawQuery ?? '').trim().toLowerCase();
	if (q.length < 2) return [];
	const tokens = tokensOf(q);
	const zones = zone === 'all' ? ['index', 'functions', 'insights', 'daily'] : [zone];
	const files = [];
	if (zones.includes('index')) files.push({ zone: 'index', name: 'MEMORY.md', file: path.join(root, 'MEMORY.md') });
	for (const z of ['functions', 'insights']) {
		if (!zones.includes(z)) continue;
		let names = [];
		try {
			names = (await readdir(path.join(root, z))).filter((n) => n.endsWith('.md')).sort();
		} catch {
			/* zone absent */
		}
		for (const n of names) files.push({ zone: z, name: n, file: path.join(root, z, n) });
	}
	if (zones.includes('daily')) {
		let names = [];
		try {
			names = (await readdir(root)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse();
		} catch {
			/* root absent */
		}
		for (const n of names) files.push({ zone: 'daily', name: n, file: path.join(root, n) });
	}
	const hits = [];
	for (const f of files) {
		const text = await readIfExists(f.file);
		if (text === undefined) continue;
		// Split on CRLF too: files written by other tools (or on Windows) carry
		// \r, and `.` never matches \r — a `^#{1,3}\s+(.+)$` test on a raw CRLF
		// line silently fails, which left every daily hit without its heading.
		const lines = text.split(/\r?\n/);
		const nameHit = f.name.toLowerCase().includes(q) || tokensOf(f.name).size && [...tokens].some((t) => tokensOf(f.name).has(t));
		let heading = '';
		const fileHits = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lower = line.toLowerCase();
			const hm = lower.match(/^#{1,3}\s+(.+)$/);
			if (hm) heading = hm[1].trim();
			let score = 0;
			if (lower.includes(q)) score += 3;
			if (heading && heading.toLowerCase().includes(q)) score += 2;
			let tokenHits = 0;
			for (const tk of tokens) if (lower.includes(tk)) tokenHits++;
			score += tokenHits;
			if (score === 0) continue;
			fileHits.push({
				zone: f.zone,
				name: f.name,
				line: i + 1,
				heading: heading.slice(0, 60),
				snippet: line.trim().slice(0, 160),
				score: score + (nameHit ? 2 : 0),
			});
		}
		// At most 3 lines per file: one file should not monopolise the ranking.
		fileHits.sort((a, b) => b.score - a.score);
		hits.push(...fileHits.slice(0, 3));
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit).map(({ zone: z, name, line, heading, snippet }) => ({ zone: z, name, line, heading, snippet }));
}

/** Build one recall UserMessage (form 'recall', plugin producer kind). */
function buildRecallMessage(lines) {
	const text = [
		'### 记忆召回（memory-manager）',
		'',
		'本轮用户输入与以下已有记忆的索引行相关。**先查后写**：涉及这些主题时先读对应文件再行动，不要凭空重推已有结论；如确属新工作，正常进行即可：',
		'',
		...lines.map((l) => `- ${l.summary} → [${l.href}](${l.href})`),
		'',
	].join('\n');
	return {
		role: 'user',
		content: [{ type: 'text', text }],
		source: {
			kind: 'memory-manager/recall',
			form: 'recall',
		},
	};
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

function memoryCheckTool(opts) {	return defineTool({
		name: 'memory_check',
		description:
			'Lint the memory root (read-only): MEMORY.md size caps + rows missing one-line summaries (R5), dangling / root-escaping links (R10), function files reverse-linking to MEMORY.md detail (R8), function-file size (R9), over-detailed iteration blocks and index rows that were not distilled (R14), duplicated index rows or table sections (R15), head stable-state summary older than the newest iteration block or missing (R3), env-constant absolute paths that no longer exist (R16), a function area corrected over 40% of the time in the last 7 days (R18 circuit breaker), iteration date tags not append-ordered (R3), legacy/ files missing the 历史原貌 header (R13). Guarded files (🛡 守护型) are exempt from the cold-memory rule. Run it after batch memory edits or when memory_check has never run on this root.',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					root: { type: 'string', required: true },
					results: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								level: { type: 'string', required: true, enum: ['WARN', 'FAIL'] },
								rule: { type: 'string', required: true },
								message: { type: 'string', required: true },
							},
						},
					},
					warnCount: { type: 'integer', required: true },
					failCount: { type: 'integer', required: true },
				},
			},
			render: (_args, v) => {
				const lines = [`memory_check — ${v.root}：${v.failCount} FAIL，${v.warnCount} WARN`];
				for (const r of v.results) lines.push(`  [${r.level}] ${r.rule}: ${r.message}`);
				if (!v.results.length) lines.push('  全部通过');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: 'Lint memory structure', kind: 'other', rawInput: args }),
		async execute(_args, exec) {
			return runHealthCheck(resolveRoot(opts), opts);
		},
	});
}

/**
 * memory_index — the INTEGRATION layer (data-flow layer 3). Function areas and
 * insights are written by memory_write / memory_insight; this tool is the ONLY
 * writer of the MEMORY.md dual tables, invoked once a feature/theme has
 * stabilized. Keeps the index a derived, curated surface instead of a
 * write-time side effect.
 */
function memoryIndexTool(opts) {
	return defineTool({
		name: 'memory_index',
		description:
			'Upsert ONE row into the MEMORY.md index (the integration layer). Call it when a feature area or insight theme has STABILIZED (>=2 iteration blocks, or clearly a standalone topic) — not per write. The row summary is distilled from the area\'s iteration-block summaries: one sentence saying what this feature IS. Zones: zone=functions or zone=insights. Unindexed-but-existing files are surfaced by memory_check (R5 orphan) so nothing silently falls out of the index.',
		parameters: {
			zone: { type: 'string', required: true, enum: ['functions', 'insights'], description: '收进哪张索引表。' },
			name: { type: 'string', required: true, description: '功能域或思想主题 slug（functions/ 或 insights/ 下的既有文件名，不含 .md）。' },
			summary: { type: 'string', required: true, description: '索引行摘要：一句话（≤60 字）说清"这是什么/解决什么"，供检索时判断相关性；从各迭代块的概括中提炼，不复制细节。' },
			group: { type: 'string', description: '可选：功能表已按 `### 索引·<域>` 分组时，指定这一行落到哪个子分区（如「基础设施」「业务功能」）；缺省写入无标题的总表。' },
			sources: { type: 'array', description: 'zone=insights 必填：来源功能域 slug 列表（渲染进"相关（来源功能）"列）。', items: { type: 'string' } },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					indexFile: { type: 'string', required: true },
					zone: { type: 'string', required: true },
					name: { type: 'string', required: true },
					created: { type: 'boolean', required: true },
					indexBytes: { type: 'integer', required: true },
					warnings: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, v) => {
				const lines = [
					`索引已更新：${v.zone}/${v.name}${v.created ? '（新行）' : '（更新）'}`,
					`索引文件：${v.indexFile}（${v.indexBytes}B）`,
				];
				for (const w of v.warnings) lines.push(`⚠ ${w}`);
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		presentCall: (args) => ({ card: 'generic', title: `Memory index: ${args.zone ?? ''}/${args.name ?? ''}`, kind: 'other', rawInput: args }),
		async execute(args, exec) {
			const root = resolveRoot(opts);
			const zone = args.zone === 'insights' ? 'insights' : 'functions';
			const name = safeSlug(args.name);
			const summary = oneLine(args.summary);
			if (!summary) throw new Error('summary is required: the index row must carry a one-line summary');
			const warnings = [];
			if (charLen(summary) > MAX_ROW_SUMMARY_CHARS) {
				warnings.push(`索引行摘要 ${charLen(summary)} 字 > ${MAX_ROW_SUMMARY_CHARS}：摘要是一句话，细节留在功能文件`);
			}
			const indexPath = path.join(root, 'MEMORY.md');
			let indexText = (await readIfExists(indexPath)) ?? memoryIndexTemplate();
			const created = !indexText.includes(`| ${name} |`);

			let row;
			if (zone === 'insights') {
				const srcs = (Array.isArray(args.sources) ? args.sources : []).map((s) => safeSlug(s)).filter((s) => s !== name);
				if (!srcs.length) throw new Error('zone=insights requires sources: the insights table carries a source-feature column');
				const relatedCell = srcs.map((s) => `[${s}.md](functions/${s}.md)`).join('、');
				row = `| ${name} | ${summary} | [insights/${name}.md](insights/${name}.md) | ${relatedCell} |`;
				if (!(await statExists(path.join(root, 'insights', `${name}.md`)))) {
					warnings.push(`insights/${name}.md 尚不存在——索引行先建了，记得用 memory_insight 沉淀文件本体`);
				}
			} else {
				row = `| ${name} | ${summary} | [functions/${name}.md](functions/${name}.md) |`;
				if (!(await statExists(path.join(root, 'functions', `${name}.md`)))) {
					warnings.push(`functions/${name}.md 尚不存在——索引行先建了，记得用 memory_write 落第一个迭代块`);
				}
			}
			indexText = upsertIndexRow(
				indexText,
				zone === 'insights' ? INSIGHT_TABLE_HEADING : FUNC_TABLE_HEADING,
				zone === 'insights' ? INSIGHT_TABLE_HEADER : FUNC_TABLE_HEADER,
				name,
				row,
				zone === 'functions' && typeof args.group === 'string' && args.group.trim() ? oneLine(args.group).slice(0, 20) : undefined,
			);
			await writeText(indexPath, indexText);
			const indexBytes = byteLen(indexText);
			if (indexBytes > opts.maxIndexBytes) {
				warnings.push(`MEMORY.md ${indexBytes}B > ${opts.maxIndexBytes}B 舒适线：压缩各行摘要，或把功能表拆成 ### 子分区`);
			}
			return {
				indexFile: indexPath,
				zone,
				name,
				created,
				indexBytes,
				warnings,
			};
		},
	});
}

// ---------------------------------------------------------------------------
// system-prompt discipline section
// ---------------------------------------------------------------------------

const DISCIPLINE_TEXT = [
	'## 持久记忆纪律（memory-manager）',
	'',
	'本 Harness 维护**全局**跨会话记忆（`~/.dsh/memory/`，即 dshHome 的 memory/ 目录；十个工具：memory_read / memory_search / memory_write / memory_index / memory_insight / memory_fold / memory_rename / memory_check / memory_usage / memory_federation；结构见 memory/MEMORY.md）。记忆对全部项目、全部会话通用，按功能域组织而非按项目隔离。**数据流单向四层，每层只吃上一层的产出**：',
	'',
	'- **第 0 层 · 每日记录（原始层）**：`YYYY-MM-DD.md` 是任务与对话过程的第一手数据，**本插件不约束其内容与格式**——用任何工具、任何方式自由记录（决策、对话、试错、片段都行）。它是一切蒸馏的原料；同一事实只在这里是"过程"，其余层只见结论。',
	'- **第 1 层 · 功能域（memory_write）**：从每日原始记录中**归纳汲取**功能划分——一次实质工作 = 一个 functions/<功能域>.md 迭代块（蒸馏结论：动因/改动/判据/待观察 各一句）。`summary` 是本块的一句话概括；功能域该新建还是并入既有的，判断依据就是每日记录里反复出现的主题。',
	'- **第 2 层 · 创新思想（memory_insight）**：从功能划分中**再提取**可迁移原则（会重套的、不绑定单一功能机制的），回链来源功能域；取代旧思想传 `supersedes`。',
	'- **第 3 层 · 索引与总览（memory_index）**：**整合层**——功能域稳定后（有 ≥2 个迭代块，或用户可感知为独立主题时）用 memory_index 把它收进 MEMORY.md 索引；索引行摘要 = 从各迭代块的概括中提炼的"这个功能是什么"。索引是展示与检索的派生物，不与单次写入强绑。',
	'- **先查后写**：涉及"项目里怎么做 / 为什么这么做 / 环境常量"时，先 `memory_read kind=index`（行内摘要判断相关性，再打开对应文件）；只记得片段、说不清在哪个域或哪天时用 `memory_search`（全库排序检索，返回命中的分区/文件/行号/小节/片段）。不要凭空重推已有结论。',
	'- **蒸馏不搬过程**：迭代块只写结论；逐条实现清单、调试经过属于每日原始层与会话/代码。块 >900 字或概括 >110 字写入告警，体检 R14 复查。',
	'- **经验二分**：会**重跑**的操作进 functions/；会**重套**的原则用 memory_insight 进 insights/；跨功能共识与环境常量只在 MEMORY.md。',
	'- **使用信号让记忆自己排序**：召回命中与 memory_read 会自动记信号；用户纠正/明确认可时用 `memory_usage(action=record, kind=correction|positive)` 记一笔（这是分层判断里唯一不能自动获得的信号）。`memory_usage(action=report)` 给出 实验/专项/通用 建议；某域近 7 天纠正率 >40% 时体检 R18 报熔断——先重构再追加。',
	'- **守护型**：低频但高价值的记忆（安全审计、关键踩坑、兜底规则）用 `memory_write(guard=true)` 标记，体检的冷记忆规则会跳过它——不要因为"很久没写"就删掉兜底经验。',
	'- **项目归属**：涉及特定项目的记忆，在功能域 slug 或正文里注明项目名（如 `toolbox-login`）。功能域多到单根过大时，可启用**联邦模式**（`federation: { root, projects }`）：项目真相源留在各项目记忆根，`memory_federation` 负责刷副本与跨项目索引，项目细节不上升。',
	'- **收缩机制**：功能文件超 30KB 用 `memory_fold` 折叠最旧块；MEMORY.md 超线按 ### 子分区拆分；重命名/合并用 `memory_rename`（自动改写引用并验证死链清零）。',
	'- 批量改动记忆后跑 `memory_check` 体检。',
	'- 归属口诀：会**重跑**的操作（functions/）、会**重套**的原则（insights/）；原始过程永远只留在每日记录。',
].join('\n');

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

const MIME_PLAIN = { 'Content-Type': 'text/plain; charset=utf-8' };
const MIME_HTML = { 'Content-Type': 'text/html; charset=utf-8' };

function json(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

function htmlPage(res, status, title, body) {
	res.writeHead(status, MIME_HTML);
	res.end(
		`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head>` +
			`<body style="font-family:system-ui;margin:2rem;line-height:1.7"><h1>${title}</h1>${body}` +
			`<p style="color:#888;font-size:.9em">memory-manager 面板 API</p></body></html>`,
	);
}

/** Zone file counts for the rail badges (directory listing only, no reads). */
async function zoneCounts(root) {
	const count = async (dir, test) => {
		try {
			return (await readdir(dir)).filter(test).length;
		} catch {
			return 0;
		}
	};
	return {
		functions: await count(path.join(root, 'functions'), (n) => n.endsWith('.md')),
		insights: await count(path.join(root, 'insights'), (n) => n.endsWith('.md')),
		daily: await count(root, (n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)),
	};
}

/**
 * Build the panel API handler. The memory root is global and always resolved
 * server-side, so a request can never widen it: there is deliberately no
 * client-supplied `?path=`.
 */
function memoryPanelApi(opts) {
	return async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		const seg = url.pathname.slice('/api/memory-org'.length).replace(/^\//, '');
		const root = resolveRoot(opts);
		try {
			if (seg === 'overview') {
				const health = panelizeHealth(await runHealthCheck(root, opts));
				return json(res, 200, [{ ...health, title: '全局记忆', path: joinDshHome(), counts: await zoneCounts(root) }]);
			}
			if (seg === 'file') {
				const name = url.searchParams.get('name');
				if (!name || /[\\/]|\.\./.test(name) || !name.endsWith('.md')) {
					return json(res, 400, { error: 'invalid file name' });
				}
				const zone = url.searchParams.get('zone') ?? '';
				if (!['', 'functions', 'insights', 'daily'].includes(zone)) {
					return json(res, 400, { error: 'invalid zone' });
				}
				if (zone === 'daily' && !/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
					return json(res, 400, { error: 'daily zone accepts only YYYY-MM-DD.md' });
				}
				// zone is whitelisted and name rejects separators, so the join can
				// only land inside the memory root.
				const full = zone === 'daily' ? path.join(root, name) : path.join(root, zone, name);
				const text = await readIfExists(full);
				if (text === undefined) return json(res, 404, { error: 'file not found' });
				return json(res, 200, { name, text });
			}
			if (seg === 'list') {
				const zone = url.searchParams.get('zone');
				if (!['functions', 'insights', 'daily'].includes(zone)) return json(res, 400, { error: 'invalid zone' });
				const dir = zone === 'daily' ? root : path.join(root, zone);
				let names = [];
				try {
					names = (await readdir(dir)).filter((n) => n.endsWith('.md'));
				} catch {
					/* zone absent */
				}
				// Daily zone lists ONLY decision threads (YYYY-MM-DD.md). The index
				// (MEMORY.md) has its own zone and must never appear under 每日,
				// and neither may stray non-dated files at the root. Newest first.
				if (zone === 'daily') names = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
				names.sort(zone === 'daily' ? (a, b) => b.localeCompare(a) : undefined);
				const files = [];
				for (const n of names) {
					const st = await stat(path.join(dir, n));
					files.push({ name: n, bytes: st.size, mtime: st.mtime.toISOString() });
				}
				// Newest-first for every zone (the panel and any other consumer
				// display the top row first). Names were pre-sorted per zone, so
				// this single mtime pass makes the order uniform.
				files.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
				return json(res, 200, { files });
			}
			if (seg === 'check') {
				return json(res, 200, panelizeHealth(await runHealthCheck(root, opts)));
			}
			if (seg === 'search') {
				const q = (url.searchParams.get('q') ?? '').trim();
				if (q.length < 2) return json(res, 200, { hits: [] });
				// Same ranker as the memory_search tool: the panel used to scan in
				// file order, so a hit in the first file always outranked a better
				// one further down.
				const zoneParam = url.searchParams.get('zone');
				const zone = ['functions', 'insights', 'daily'].includes(zoneParam) ? zoneParam : 'all';
				const hits = await searchMemory(root, q, { zone, limit: 60 });
				return json(res, 200, { hits });
			}
			htmlPage(
				res,
				200,
				'memory-manager',
				'<p>该插件的可视面板在 Harness Web UI 的侧栏（记忆图标）。此只读 API 供面板取数；记忆根由服务端解析，请求不能指定路径：</p>' +
					'<ul><li><code>GET /api/memory-org/overview</code> — 全局记忆体检 + 各分区计数</li>' +
					'<li><code>GET /api/memory-org/check</code> — 体检</li>' +
					'<li><code>GET /api/memory-org/list?zone=functions|insights|daily</code> — 分区文件列表</li>' +
					'<li><code>GET /api/memory-org/file?zone=functions&amp;name=&lt;file&gt;.md</code> — 读记忆文件（省略 zone 即索引）</li>' +
					'<li><code>GET /api/memory-org/search?q=&lt;关键词&gt;</code> — 全库搜索</li></ul>',
			);
		} catch (err) {
			json(res, 500, { error: String(err?.message ?? err) });
		}
	};
}

export function apply(ctx, config) {
	// The Host install may be pointed at explicitly; otherwise it is discovered
	// (env / CLI entry / cwd / profile). Loading eagerly fails fast with an
	// actionable message instead of breaking the first tool call.
	hostRootOverride = typeof config?.dshRoot === 'string' && config.dshRoot.trim() ? config.dshRoot.trim() : undefined;
	loadHost();

	const opts = {
		memoryRoot: typeof config?.memoryRoot === 'string' && config.memoryRoot.trim() ? config.memoryRoot.trim() : undefined,
		maxIndexBytes: Number.isFinite(config?.maxIndexBytes) ? config.maxIndexBytes : DEFAULTS.maxIndexBytes,
		maxIndexHardBytes: Number.isFinite(config?.maxIndexHardBytes) ? config.maxIndexHardBytes : DEFAULTS.maxIndexHardBytes,
		maxFunctionBytes: Number.isFinite(config?.maxFunctionBytes) ? config.maxFunctionBytes : DEFAULTS.maxFunctionBytes,
		newFeatureGraceDays: Number.isFinite(config?.newFeatureGraceDays) ? config.newFeatureGraceDays : DEFAULTS.newFeatureGraceDays,
		// Opt-in three-tier federation: { root, projects: [{ key, root }] }.
		federation: config?.federation && typeof config.federation === 'object' ? config.federation : undefined,
	};

	const disposers = [
		ctx.tools.register(memoryReadTool(opts)),
		ctx.tools.register(memorySearchTool(opts)),
		ctx.tools.register(memoryWriteTool(opts)),
		ctx.tools.register(memoryIndexTool(opts)),
		ctx.tools.register(memoryInsightTool(opts)),
		ctx.tools.register(memoryFoldTool(opts)),
		ctx.tools.register(memoryRenameTool(opts)),
		ctx.tools.register(memoryCheckTool(opts)),
		ctx.tools.register(memoryUsageTool(opts)),
		ctx.tools.register(memoryFederationTool(opts)),
	];

	// Proactive recall: on every proposed step, match the batch's user text
	// against the memory index and prepend one recall message when the overlap
	// clears the threshold. Waterfall listener returning next() unchanged when
	// nothing matches or the batch was already served a recall (per-agent
	// signature dedupe). Registration is global; dispatch is agent-scoped.
	const recallServed = new Map(); // agentId -> signature of last served batch
	const indexCache = { text: undefined, at: 0 };
	const readIndexCached = async () => {
		const now = Date.now();
		if (indexCache.text === undefined || now - indexCache.at > 10_000) {
			indexCache.text = (await readIfExists(path.join(resolveRoot(opts), 'MEMORY.md'))) ?? '';
			indexCache.at = now;
		}
		return indexCache.text;
	};
	disposers.push(
		ctx.on('agent/pre-step', async (payload, next) => {
			// Build the recall candidate first; a recall failure must never break a
			// step, so ONLY this block is guarded. `next()` runs exactly once,
			// outside the guard, so a downstream error propagates (instead of the
			// waterfall being re-entered by a catch that calls next() again).
			let recall = null;
			try {
				const batch = payload.messages ?? [];
				const userText = batch
					.flatMap((m) => (m?.role === 'user' ? m.content : []))
					.filter((b) => b?.type === 'text')
					.map((b) => b.text)
					.join('\n');
				const signature = `${payload.agent.id}:${userText.slice(0, 400)}`;
				if (userText.trim() && recallServed.get(payload.agent.id) !== signature) {
					const indexText = await readIndexCached();
					if (indexText) {
						const rows = matchIndexRows(indexText, tokensOf(userText))
							// Pointer dedupe: when the user's own text already cites a memory
							// file (they quoted an earlier recall or wrote the link), re-
							// injecting the same row just echoes what is already on screen.
							.filter((l) => !userText.includes(l.href));
						recallServed.set(payload.agent.id, signature);
						if (rows.length) {
							recall = createUserMessage(buildRecallMessage(rows));
							// Usage signal: what recall actually put in front of the model
							// is the demand side of the memory's popularity. Fire and
							// forget — logging must never delay or break the step.
							for (const r of rows) void appendUsage(resolveRoot(opts), { href: r.href, kind: 'recall' });
						}
					}
				}
			} catch {
				recall = null; // degrade to plain admission
			}
			const decision = await next();
			if (!recall || decision.kind !== 'enter') return decision;
			return { ...decision, messages: [recall, ...decision.messages] };
		}, { prepend: true }),
	);
	const sp = ctx.systemPrompt;
	disposers.push(
		sp.section({
			name: 'memory-manager:discipline',
			order: sp.getSectionOrder('TOOL_REPORT') + 5,
			interpolate: false,
			text: DISCIPLINE_TEXT,
		}),
	);

	// Panel API: optional — without a web server the tools keep working and the
	// panel page shows its fallback text. Resolved lazily via ctx.inject because
	// webServer may not be provided yet at apply time. The memory root is global
	// (~/.dsh/memory), so workspaceRegistry is no longer needed here.
	ctx.inject(['webServer'], (scoped) => {
		const server = scoped.webServer;
		if (server) {
			scoped.effect(() =>
				server.register({ kind: 'prefix', path: '/api/memory-org', handler: memoryPanelApi(opts) }),
			);
		}
	});

	return () => {
		for (const d of disposers.reverse()) d();
	};
}

export { name, inject, dshHome, joinDshHome, resolveRoot, resolveDshRoot, runHealthCheck, panelizeHealth, zoneCounts, tokensOf, matchIndexRows };
