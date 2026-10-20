/**
 * Functional harness for dsh-memory-manager (server.js).
 * Loads the real plugin entry, captures the registered tool definitions with a
 * fake ctx, and exercises write/index/insight/fold/rename/check/resolve/
 * supersede/recall against a temp memory root.
 *
 * Data-flow contract (layered): the daily log is the RAW layer (free-form, the
 * model maintains it), memory_write distills functions/ blocks only,
 * memory_index is the sole index writer, insights sit between, and the check
 * lints everything.
 *
 * The Host installation must be discoverable (see resolveDshRoot): set
 * DSH_INSTALL_DIR when the harness install is not the process's own ancestor.
 */
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mod = await import(new URL('./server.js', import.meta.url).href);
console.log('exports:', Object.keys(mod).join(','), '| inject:', mod.inject.join(','));

const registered = [];
const noop = () => {};
const fakeCtx = {
	tools: { register: (d) => (registered.push(d), noop) },
	on: (name, listener) => {
		if (name === 'agent/pre-step') globalThis.__preStepListener = listener;
		return noop;
	},
	inject: (names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
	systemPrompt: {
		getSectionOrder: () => 2900,
		section: (s) => (registered.push({ __section: s }), noop),
	},
};
mod.apply(fakeCtx, { dshRoot: process.env.DSH_INSTALL_DIR });
const section = registered.find((r) => r.__section)?.__section;
console.log('section:', section?.name, '| bytes:', section?.text.length, '| mentions fold:', section.text.includes('memory_fold'));

const root = await mkdtemp(path.join(tmpdir(), 'dsh-memfo-'));
const exec = {};
const statExists = async (p) => { try { await (await import('node:fs/promises')).stat(p); return true; } catch { return false; } };
// Second apply with an explicit root: this instance's tools and pre-step
// listener both read the temp index. registered now holds BOTH applies' tool
// definitions (same names), so keep only the LAST registration per name —
// the second apply's. Name-keyed dedupe (not a slice with a hardcoded count)
// so adding a tool never silently shifts the window.
// `newFeatureGraceDays: 0` disables the cold-memory grace window so the
// temperature rule can be asserted deterministically (see 11d for the grace).
const disposer2 = mod.apply(fakeCtx, { memoryRoot: root, newFeatureGraceDays: 0 });
const tools2 = Object.fromEntries(
	registered.filter((r) => r?.name && r.execute).map((t) => [t.name, t]),
);
const T = tools2;
const disposer = noop;
let failures = 0;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
};

// Index rows carry their link in the NAME cell since 5.15.0, so these helpers
// match either shape and the suite never has to know which generation wrote it.
const rowOf = (name) => name; // first cell text, resolved by firstCellOf below
const firstCellOf = (row) => {
	const first = String(row).trim().replace(/^\|/, '').split('|')[0].trim();
	const m = /^\[([^\]]+)\]\([^)]*\)$/.exec(first);
	return m ? m[1] : first;
};
const rowsFor = (text, name) => String(text ?? '').split('\n').filter((l) => l.trim().startsWith('|') && firstCellOf(l) === name);

// 1) empty root -> check reports FAIL R0
const c0 = await T.memory_check.execute({}, exec);
ok(c0.failCount === 1 && c0.results[0].rule === 'R0', `check on empty root: ${c0.results[0]?.rule}`);

// 2) first write -> creates the function file only (index + daily are separate
// layers now; the raw daily log is the model's to maintain)
const w1 = await T.memory_write.execute(
	{ feature: '测试功能', title: '第一次迭代', summary: '验证插件写入闭环', currentState: '初始状态', change: '写入测试', verification: '本测试', result: 'done', open: '待验证遗留项' },
	exec,
);
ok(w1.createdFunctionFile === true, 'write creates function file');
ok(w1.warnings.length === 0, `no warnings (${w1.warnings.join('; ')})`);
ok(w1.indexFile === undefined && w1.dailyFile === undefined, 'write touches neither index nor daily log');
const today = w1.appendedHeading.match(/\[(\d{4}-\d{2}-\d{2})/)[1];
const fn1 = await readFile(w1.featureFile, 'utf8');
ok(fn1.includes('- **概括**：验证插件写入闭环'), 'block carries the summary as 概括');

// 3) index does NOT auto-sync; the file doesn't even exist until memory_index
let idx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(!idx.found && rowsFor(idx.content, '测试功能').length === 0, 'index row absent until memory_index');
const ix1 = await T.memory_index.execute(
	{ zone: 'functions', name: '测试功能', summary: '验证插件写入闭环的测试功能' },
	exec,
);
ok(ix1.created === true, 'memory_index creates the row');
idx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(idx.found && idx.content.includes('| [测试功能](functions/测试功能.md) |'), 'index row present with a clickable name cell');
const ix2 = await T.memory_index.execute(
	{ zone: 'functions', name: '测试功能', summary: '更新后的功能一句话' },
	exec,
);
ok(ix2.created === false, 'memory_index upserts (created=false on update)');

// 3b) memory_search: ranked retrieval over the whole root (bodies, not just
// index summaries). A rare token must win over a token every row shares.
await T.memory_write.execute(
	{ feature: '检索目标', title: '逐帧渲染静默失败的三类事故', summary: '检索测试素材', change: '写一段只有这里才有的稀有词：逐帧渲染。', result: 'done' },
	exec,
);
const s1 = await T.memory_search.execute({ q: '逐帧' }, exec);
ok(s1.count >= 1 && s1.hits[0].name === '检索目标.md', `search finds the rare token (${s1.hits[0]?.name})`);
ok(s1.hits.every((h) => ['zone', 'name', 'line', 'heading', 'snippet'].every((k) => k in h)), 'search hits carry zone/name/line/heading/snippet');
ok(s1.hits[0].line > 0 && s1.hits[0].snippet.includes('逐帧'), 'search hit carries line number + snippet');
const s2 = await T.memory_search.execute({ q: '逐帧', zone: 'insights' }, exec);
ok(s2.count === 0, 'search honours the zone filter');
const s3 = await T.memory_search.execute({ q: '完全不存在的词条xyzzy' }, exec);
ok(s3.count === 0, 'search returns empty for a miss');
let searchThrew = false;
try {
	await T.memory_search.execute({ q: 'x' }, exec);
} catch {
	searchThrew = true;
}
ok(searchThrew, 'search rejects a query shorter than 2 chars');
// CRLF regression: a daily log written by another tool carries \r, and `.` does
// not match \r — a naive `^#{1,3}\s+(.+)$` leaves every hit heading-less.
const crlfDay = path.join(root, '1999-01-01.md');
await writeFile(crlfDay, '# 1999-01-01 记录\r\n\r\n## 今日线索\r\n\r\n- 冷启动 关键字只在换行风格异常的文件里\r\n', 'utf8');
const s4 = await T.memory_search.execute({ q: '冷启动' }, exec);
ok(s4.count >= 1 && s4.hits[0].heading === '今日线索', `search survives CRLF input (heading=${JSON.stringify(s4.hits[0]?.heading)})`);
await rm(crlfDay, { force: true });
// Ranking: a token shared by most rows must not beat a rare token. With 5 rows
// where 4 share 「记忆/面板」 and 1 owns 「逐帧/渲染」, IDF gives the rare row
// roughly twice the weight per token, so it must rank first — and the common
// row must still survive the 40%-of-best threshold.
const rankIndex = [
	'| 甲域 | 记忆 面板 是通用词 | [functions/甲域.md](functions/甲域.md) |',
	'| 乙域 | 记忆 面板 也是通用词 | [functions/乙域.md](functions/乙域.md) |',
	'| 丙域 | 记忆 面板 还是通用词 | [functions/丙域.md](functions/丙域.md) |',
	'| 丁域 | 记忆 面板 一样通用词 | [functions/丁域.md](functions/丁域.md) |',
	'| 戊域 | 逐帧 渲染 稀有词 | [functions/戊域.md](functions/戊域.md) |',
].join('\n');
const ranked = mod.matchIndexRows(rankIndex, mod.tokensOf('记忆 面板 逐帧 渲染'));
ok(ranked[0]?.name === '戊域', `IDF ranking prefers the rare-token row (${ranked[0]?.name})`);
ok(ranked.length >= 2, `relative threshold keeps the strong common row too (${ranked.length} rows)`);

// 3c) Decision-repair (MemOS borrow ④): the recent-correction signal that only
// fed R18's circuit breaker now also decides what gets force-recalled NEXT step.
// Pure function first — thresholds are the contract.
const repItems = [
	{ href: 'functions/常错域.md', corrections: 4, uses: 6, badRate: 0.67 },
	{ href: 'functions/偶错域.md', corrections: 1, uses: 10, badRate: 0.09 },
	{ href: 'functions/干净域.md', corrections: 0, uses: 12, badRate: 0 },
];
const repTargets = mod.decisionRepairTargets(repItems);
ok(repTargets.length === 1 && repTargets[0].href === 'functions/常错域.md', `decision-repair picks the repeatedly-corrected area (${repTargets.length})`);
ok(!repTargets.some((r) => r.href === 'functions/偶错域.md'), 'decision-repair ignores a single correction');
// The repair row must be visibly marked in the injected message, otherwise the
// model cannot tell a forced recall from a topical hit.
const repairMsg = mod.buildRecallMessage([
	{ name: '常错域', summary: '反复判错的地方', href: 'functions/常错域.md', zone: 'function', repair: { corrections: 4, badRate: 0.67 } },
]).content[0].text;
ok(repairMsg.includes('决策修复') && repairMsg.includes('纠正 4 次'), 'repair row is marked with its correction count');
ok(repairMsg.includes('未被打断'), 'repair note says the current step was not interrupted');
// 3d) Recall budget (MemOS borrow ⑤): every non-empty turn attempts a recall,
// but under an absolute foreground budget. Config may shorten, never extend.
ok(mod.DEFAULTS.recallTimeoutMs === 3000, `recall budget default is 3s (${mod.DEFAULTS.recallTimeoutMs})`);
ok(mod.resolveRecallBudget(undefined) === 3000, 'missing config -> default budget');
ok(mod.resolveRecallBudget(60_000) === 3000, 'config cannot EXTEND the budget past the ceiling');
ok(mod.resolveRecallBudget(200) === 200, 'config can shorten the budget');
ok(mod.resolveRecallBudget(-5) === 0, 'negative budget clamps to 0 (still bounded)');

// 3e) Passive capture (MemOS borrow ⑥): OFF by default — the raw layer belongs
// to the model, so blind logging of every turn must be opt-in. Pure function
// first: truncation + exact-duplicate guard + the off switch.
ok(mod.DEFAULTS.captureUserTurns === false, 'passive capture is OFF by default (privacy/noise)');
ok(mod.captureLineFor('记一下', '', { enabled: false }) === null, 'disabled capture records nothing');
ok(mod.captureLineFor('  a   b  ', '', { enabled: true }) === '- a b', 'whitespace is normalized in the captured line');
const truncated = mod.captureLineFor('x'.repeat(400), '', { enabled: true, maxChars: 160 });
ok(truncated === `- ${'x'.repeat(160)}…`, `long turns are truncated (len=${truncated?.length})`);
ok(mod.captureLineFor('同一条请求', '- 同一条请求', { enabled: true }) === null, 'an exact repeat is not appended twice');
ok(mod.captureLineFor('', '', { enabled: true }) === null, 'empty turns are not captured');

// indexRowsOf turns an href into a recallable row (used by the repair hook).
const idxRows = mod.indexRowsOf('| 甲域 | 摘要甲 | [functions/甲域.md](functions/甲域.md) |');
ok(idxRows.some((r) => r.href === 'functions/甲域.md' && r.zone === 'function'), 'indexRowsOf lists index rows by href');
// rank, so a topically-relevant row that is also heavily used outranks one that
// is merely relevant. Without a usage map the behavior must stay lexical.
const fusionIndex = [
	'| 冷门域 | 逐帧 渲染 稀有词 | [functions/冷门域.md](functions/冷门域.md) |',
	'| 热门域 | 逐帧 渲染 也稀有 | [functions/热门域.md](functions/热门域.md) |',
].join('\n');
const noUsage = mod.matchIndexRows(fusionIndex, mod.tokensOf('逐帧 渲染'), 3);
ok(noUsage.length === 2, `no usage map -> pure lexical ranking (${noUsage.length} rows)`);
const usageMap = new Map([['functions/热门域.md', { uses: 20, positives: 3, badRate: 0 }]]);
const fused = mod.matchIndexRows(fusionIndex, mod.tokensOf('逐帧 渲染'), 3, usageMap);
ok(fused[0]?.href === 'functions/热门域.md', `usage fusion promotes the heavily-used row (${fused[0]?.href})`);
// A row that keeps getting corrected is demoted even when used often (R18's raw
// material, now feeding ranking instead of only the circuit breaker).
const badUsage = new Map([
	['functions/热门域.md', { uses: 20, positives: 0, badRate: 0.8 }],
	['functions/冷门域.md', { uses: 10, positives: 2, badRate: 0 }],
]);
const demoted = mod.matchIndexRows(fusionIndex, mod.tokensOf('逐帧 渲染'), 3, badUsage);
ok(demoted[0]?.href === 'functions/冷门域.md', `high correction rate demotes a hot row (${demoted[0]?.href})`);

// 4) second write same day -> 补 suffix
const w2 = await T.memory_write.execute(
	{ feature: '测试功能', title: '第二次迭代', summary: '同日第二块加补后缀', currentState: '两块后仍稳定', result: 'pending' },
	exec,
);
ok(w2.appendedHeading.includes('补'), `补 suffix: ${w2.appendedHeading}`);

// 5) insight with valid source
const i1 = await T.memory_insight.execute(
	{ theme: '闭环验证', principle: '测试原则', summary: '测试内涵', sources: ['测试功能'], open: '待验证点' },
	exec,
);
ok(i1.linkedSources.length === 1 && i1.skippedSources.length === 0, `insight backlink: ${i1.linkedSources.join(',')}`);
ok(i1.indexBytes === undefined && i1.dailyFile === undefined, 'insight touches neither index nor daily log');
// Contract: the output schema must not require what execute no longer returns —
// the 5.10 data-flow flip dropped indexBytes from the return but the schema kept
// it required, so the HOST rejected every memory_insight result even though the
// insight file was written ("missing required property value.indexBytes").
ok(!('indexBytes' in (T.memory_insight.output?.schema?.properties ?? {})), 'memory_insight schema does not require indexBytes');

// 5b) related: existing = bare sibling link; missing = plain text
const w3 = await T.memory_write.execute(
	{ feature: '测试功能', title: '相关链接写法验证', summary: 'related 链接必须是裸文件名', related: ['测试功能'], result: 'done' },
	exec,
);
const fn3 = await readFile(w3.featureFile, 'utf8');
ok(fn3.includes('相关：[测试功能.md](测试功能.md)') || fn3.includes('相关：（无）'), 'self-related filtered');
const w4 = await T.memory_write.execute(
	{ feature: '测试功能', title: '未建档相关渲染', summary: '不存在的 related 渲染为纯文本', related: ['另一功能'], result: 'done' },
	exec,
);
const fn4 = await readFile(w4.featureFile, 'utf8');
ok(fn4.includes('另一功能（未建档）'), 'missing related renders as plain text');
ok(!fn4.includes('](另一功能.md)'), 'no dangling href for missing related');

// 6) resolve: second feature with an open item, then resolve it. The raw daily
// layer is free-form — simulate the model recording an open item itself.
await T.memory_write.execute(
	{ feature: '遗留功能', title: '引入遗留', summary: '有遗留项的功能', result: 'pending' },
	exec,
);
const dailyPath0 = path.join(root, `${today}.md`);
await writeFile(dailyPath0, `# ${today} 记录\n\n- 遗留功能有个开放风险 → [functions/遗留功能.md](functions/遗留功能.md)\n`, 'utf8');
const w5 = await T.memory_write.execute(
	{ feature: '测试功能', title: '解决遗留项', summary: '勾掉遗留功能的待观察', resolve: '遗留功能', result: 'done' },
	exec,
);
const d1 = await T.memory_read.execute({ kind: 'daily' }, exec);
ok(d1.content.includes('✅') && d1.content.includes('functions/遗留功能.md'), `resolve stamps the open item (logs: ${w5.resolvedDailyLogs.join(',')})`);
ok(!d1.content.includes('已解决 → ['), 'bare ✅ stamp, no second pointer');

// 7) supersede: new insight replaces the old one
const i2 = await T.memory_insight.execute(
	{ theme: '闭环验证2', principle: '更好的测试原则', summary: '取代旧原则', sources: ['测试功能'], supersedes: '闭环验证' },
	exec,
);
ok(i2.supersededFile && i2.supersededFile.includes('闭环验证'), 'supersede stamped old file');
const oldInsight = await T.memory_read.execute({ kind: 'insight', name: '闭环验证' }, exec);
ok(oldInsight.content.includes('已被取代') && oldInsight.content.includes('闭环验证2'), 'old insight stamped with successor link');

// 7b) updating an insight must refresh its applicability too, and the result
// must never carry an `undefined` property (the Host rejects non-lossless JSON
// even after the write succeeded).
ok(!('supersededFile' in i1), 'insight result omits supersededFile when nothing was superseded');
const i3 = await T.memory_insight.execute(
	{ theme: '闭环验证2', principle: '再迭代一次的原则', summary: '可迁移原则更新', sources: ['测试功能'], applicability: '刷新后的适用面文案' },
	exec,
);
ok(i3.supersededFile === undefined && !('supersededFile' in i3), 'no undefined field in an insight update result');
const insightText = await readFile(i3.insightFile, 'utf8');
ok(insightText.includes('刷新后的适用面文案'), 'applicability refreshed on insight update');

// 8) fold: create a file with many blocks, fold keeping 2
await T.memory_write.execute({ feature: '折叠目标', title: '块一', summary: 's1', result: 'reverted', open: '教训一' }, exec);
await T.memory_write.execute({ feature: '折叠目标', title: '块二', summary: 's2', result: 'done' }, exec);
await T.memory_write.execute({ feature: '折叠目标', title: '块三', summary: 's3', result: 'done' }, exec);
await T.memory_write.execute({ feature: '折叠目标', title: '块四', summary: 's4', result: 'done' }, exec);
await T.memory_write.execute({ feature: '折叠目标', title: '块五', summary: 's5', result: 'done' }, exec);
const fold1 = await T.memory_fold.execute({ feature: '折叠目标', keep: 2 }, exec);
ok(fold1.foldedBlocks === 3 && fold1.keptBlocks === 2, `fold counts: ${fold1.foldedBlocks}/${fold1.keptBlocks}`);
ok(fold1.bytesAfter < fold1.bytesBefore, `fold shrinks: ${fold1.bytesBefore} -> ${fold1.bytesAfter}`);
const foldedFile = await T.memory_read.execute({ kind: 'function', name: '折叠目标' }, exec);
ok(foldedFile.content.includes('早期演化'), 'folded file has evolution paragraph');
ok(foldedFile.content.includes('块一') && foldedFile.content.includes('块五'), 'folded history names oldest, kept names newest');
ok(foldedFile.content.includes('## ['), 'kept blocks remain');
// 8b) a fold must not recycle a same-day tag: the folded tags live on in the
// 「早期演化」 list, so the next write continues the sequence (补4 → 补5) instead
// of colliding with a folded 补2 and tripping the R3 ordering check.
const w11 = await T.memory_write.execute({ feature: '折叠目标', title: '折叠后新块', summary: '折叠后编号不撞名', result: 'done' }, exec);
ok(w11.appendedHeading.includes('补5'), `post-fold tag continues the sequence: ${w11.appendedHeading}`);

// 9) rename: bare rename rewrites references everywhere
await T.memory_write.execute({ feature: '旧名功能', title: '重命名前', summary: '将被重命名', result: 'done' }, exec);
await T.memory_write.execute(
	{ feature: '测试功能', title: '引用旧名', summary: '含旧名相关链接', related: ['旧名功能'], result: 'done' },
	exec,
);
await T.memory_index.execute({ zone: 'functions', name: '旧名功能', summary: '将被重命名的功能' }, exec);
const r1 = await T.memory_rename.execute({ from: '旧名功能', to: '新名功能' }, exec);
ok(r1.mode === 'renamed', `rename mode: ${r1.mode}`);
ok(r1.danglingAfter === 0, `dangling after rename: ${r1.danglingAfter}`);
const refFile = await T.memory_read.execute({ kind: 'function', name: '测试功能' }, exec);
ok(refFile.content.includes('新名功能.md') && !refFile.content.includes('旧名功能.md'), 'references rewritten to new name');
const oldGone = await T.memory_read.execute({ kind: 'function', name: '旧名功能' }, exec);
ok(!oldGone.found, 'old file gone after rename');
const newIdx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(newIdx.content.includes('新名功能'), 'index row renamed');

// 10) merge: fold 待并入 into 测试功能
await T.memory_write.execute({ feature: '待并入', title: '并入前块', summary: '将被合并', result: 'done' }, exec);
await T.memory_index.execute({ zone: 'functions', name: '待并入', summary: '将被合并的功能' }, exec);
const r2 = await T.memory_rename.execute({ from: '待并入', to: '测试功能' }, exec);
ok(r2.mode === 'merged', `merge mode: ${r2.mode}`);
ok(r2.danglingAfter === 0, `dangling after merge: ${r2.danglingAfter}`);
const mergedFile = await T.memory_read.execute({ kind: 'function', name: '测试功能' }, exec);
ok(mergedFile.content.includes('并入前块'), 'merged blocks appended to target');
const mergedIdx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(!mergedIdx.content.includes('| 待并入 |'), 'merged source row removed from index');

// 11) full check now passes (no FAIL)
const c1 = await T.memory_check.execute({}, exec);
ok(c1.failCount === 0, `check clean (FAIL=${c1.failCount}, WARN=${c1.warnCount})`);
for (const r of c1.results) console.log(`    [${r.level}] ${r.rule}: ${r.message}`);

// 11b) temperature: a feature nobody references is flagged as cold; a heavily
// referenced one is not. At this point 测试功能 is referenced by the index and
// insights, so it must NOT be cold; 无引用功能 would be.
await T.memory_write.execute({ feature: '无引用功能', title: '孤立块', summary: '没有任何其他文件引用此功能', result: 'done' }, exec);
const c2 = await T.memory_check.execute({}, exec);
const cold = c2.results.filter((r) => r.rule === 'TEMP');
ok(cold.some((r) => r.message.includes('无引用功能')), `cold flagged: ${cold.map((r) => r.message.split('：')[0]).join('; ')}`);
ok(!cold.some((r) => r.message.includes('测试功能')), 'referenced feature not flagged cold');

// 11c) dedupe: writing a summary highly overlapping an INDEXED row's warns.
// In the layered flow the index only carries stabilized features, so dedupe
// compares against indexed rows — index 无引用功能 first.
await T.memory_index.execute({ zone: 'functions', name: '无引用功能', summary: '没有任何其他文件引用此功能' }, exec);
const w6 = await T.memory_write.execute(
	{ feature: '相近功能', title: '疑似重复写入', summary: '没有任何其他文件引用此功能的孤立块', result: 'done' },
	exec,
);
ok(w6.warnings.some((x) => x.includes('疑似与已有功能域')), `dedupe warning: ${w6.warnings.join(' | ').slice(0, 80)}`);

// 11d) grace period: a brand-new feature file has had no chance to be
// backlinked, so the default window suppresses the cold flag for it.
mod.apply(fakeCtx, { memoryRoot: root });
const tools3 = Object.fromEntries(
	registered.filter((r) => r?.name && r.execute).slice(-11).map((t) => [t.name, t]),
);
const c3 = await tools3.memory_check.execute({}, exec);
ok(!c3.results.some((r) => r.rule === 'TEMP'), `grace window suppresses cold flag on fresh files (TEMP=${c3.results.filter((r) => r.rule === 'TEMP').length})`);

// 12) bad slug rejected
let threw = false;
try {
	await T.memory_write.execute({ feature: '../逃逸', title: 'x', summary: 's' }, exec);
} catch {
	threw = true;
}
ok(threw, 'path-escape slug rejected');

// 13) proactive recall: pre-step listener matches index rows
const ps = globalThis.__preStepListener;
ok(typeof ps === 'function', 'pre-step listener registered');
if (typeof ps === 'function') {
	const fakeAgent = { id: 'sess-test' };
	const nextEnter = () => Promise.resolve({ kind: 'enter', messages: [] });
	// 13a) hit: user text overlapping an index row (测试功能 exists in the index)
	const hit = await ps(
		{ agent: fakeAgent, messages: [{ role: 'user', content: [{ type: 'text', text: '接下来处理测试功能的待观察项' }] }], turn: 1, step: 1, signal: new AbortController().signal },
		nextEnter,
	);
	ok(hit.kind === 'enter' && hit.messages.length === 1 && hit.messages[0].source?.form === 'recall', `recall injected on hit (${hit.messages?.length})`);
	ok(hit.messages[0].content[0].text.includes('测试功能'), 'recall cites the matching row');
	// 13b) dedupe: same batch again -> no second recall
	const dedup = await ps(
		{ agent: fakeAgent, messages: [{ role: 'user', content: [{ type: 'text', text: '接下来处理测试功能的待观察项' }] }], turn: 1, step: 2, signal: new AbortController().signal },
		nextEnter,
	);
	ok(dedup.kind === 'enter' && dedup.messages.length === 0, 'dedupe suppresses repeat recall');
	// 13c) miss: unrelated text -> no recall
	const miss = await ps(
		{ agent: fakeAgent, messages: [{ role: 'user', content: [{ type: 'text', text: '今天天气怎么样' }], }], turn: 2, step: 1, signal: new AbortController().signal },
		nextEnter,
	);
	ok(miss.kind === 'enter' && miss.messages.length === 0, 'no recall on unrelated input');
	// 13d) pointer dedupe: user text already cites the file (e.g. quoting an
	// earlier recall) -> that row is NOT injected again. Other rows may still be
	// (generic bigrams can match unrelated rows); the cited one must be gone.
	const agent2 = { id: 'sess-quote' };
	const cited = await ps(
		{ agent: agent2, messages: [{ role: 'user', content: [{ type: 'text', text: 'functions/测试功能.md 这个文件怎么样' }] }], turn: 1, step: 1, signal: new AbortController().signal },
		nextEnter,
	);
	const citedText = cited.messages?.[0]?.content?.[0]?.text ?? '';
	ok(citedText.length === 0 || !citedText.includes('functions/测试功能.md'), 'user-cited pointer not re-injected');
	// mixed: one cited row + one uncited hit -> only the uncited one stays
	const mixed = await ps(
		{ agent: agent2, messages: [{ role: 'user', content: [{ type: 'text', text: '看看 insights/闭环验证.md 和无引用功能 的记忆' }] }], turn: 2, step: 1, signal: new AbortController().signal },
		nextEnter,
	);
	const mixedText = mixed.messages?.[0]?.content?.[0]?.text ?? '';
	ok(mixed.kind === 'enter' && !mixedText.includes('insights/闭环验证.md') && mixedText.includes('无引用功能'), `cited row dropped, uncited kept (${mixed.messages?.length} msgs)`);
}

// 14) distillation gate (R14): a block is a conclusion, not a process log —
// flagged both at write time and by the health check, but only as a WARN.
const longChange = '实现细节逐条流水。'.repeat(110); // 990 chars > MAX_BLOCK_CHARS
const w7 = await T.memory_write.execute(
	{ feature: '冗长功能', title: '未蒸馏的块', summary: '用来验证蒸馏闸门', change: longChange, result: 'done' },
	exec,
);
ok(w7.warnings.some((x) => x.includes('本块正文')), 'write warns on an over-long block');
const longSummary = '这一段索引摘要故意写得非常长'.repeat(12); // 168 chars > MAX_ROW_SUMMARY_CHARS
const w8 = await T.memory_write.execute(
	{ feature: '摘要过长功能', title: '摘要过长', summary: longSummary, change: '简短改动', result: 'done' },
	exec,
);
ok(w8.warnings.some((x) => x.includes('索引行摘要')), 'write warns on an over-long summary');
// R14's index-row check reads MEMORY.md table rows, so push the over-long
// summary through memory_index and expect the health check to flag it.
await T.memory_index.execute({ zone: 'functions', name: '摘要过长功能', summary: longSummary }, exec);
const c4 = await T.memory_check.execute({}, exec);
const r14 = c4.results.filter((r) => r.rule === 'R14');
ok(r14.some((r) => r.message.includes('冗长功能')), `R14 flags the un-distilled block (${r14.length} R14)`);
ok(r14.some((r) => r.message.includes('摘要过长功能')), 'R14 flags the over-long index row');
// R14 measures the SENTENCE, not the markdown: a folded source-link tail
// (`（来源：[x.md](functions/x.md)）`) is href noise — since 5.15.0 insight
// rows carry it, and counting it flagged a 34-char principle as 129.
const shortPrinciple = '跨功能写入接口必须成对实现进退两方向，否则副本与主行并存。'; // 35 chars
await T.memory_insight.execute(
	{ theme: '带长来源的主题', principle: shortPrinciple, summary: shortPrinciple, sources: ['测试功能', '冗长功能'] },
	exec,
);
await T.memory_index.execute(
	{ zone: 'insights', name: '带长来源的主题', summary: shortPrinciple, sources: ['测试功能', '冗长功能', '摘要过长功能', '无引用功能'] },
	exec,
);
const c4b = await T.memory_check.execute({}, exec);
const r14b = c4b.results.filter((r) => r.rule === 'R14');
ok(!r14b.some((r) => r.message.includes('带长来源的主题')), 'R14 strips source links before measuring the summary');
ok(r14b.some((r) => r.message.includes('摘要过长功能')), 'a genuinely over-long plain-text summary is STILL flagged');
ok(c4b.failCount === 0, 'R14 is advisory (WARN), never a FAIL');

// 14b) related: "x.md" is accepted as the slug (no `x.md.md（未建档）`)
const w9 = await T.memory_write.execute(
	{ feature: '测试功能', title: 'related 带 .md 后缀', summary: 'related 容忍 .md 后缀', related: ['冗长功能.md'], result: 'done' },
	exec,
);
const fn9 = await readFile(w9.featureFile, 'utf8');
ok(fn9.includes('](冗长功能.md)') && !fn9.includes('冗长功能.md.md'), 'related "x.md" resolves to the sibling file');

// 14c) a distilled block raises no verbosity warning
const w10 = await T.memory_write.execute(
	{ feature: '测试功能', title: '蒸馏块不告警', summary: '结论级块不触发蒸馏闸门', change: '改动一句', reason: '原因一句', verification: '验证一句', result: 'done', open: '待观察一句' },
	exec,
);
ok(!w10.warnings.some((x) => x.includes('本块正文')), 'a distilled block raises no verbosity warning');

// 15) memory_index is idempotent: indexing twice keeps exactly one row
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: '幂等索引' }, exec);
const idxPath = path.join(root, 'MEMORY.md');
const idxNow = await readFile(idxPath, 'utf8');
ok(rowsFor(idxNow, '测试功能').length === 1, 'memory_index is idempotent (one row)');

// 15a) grouping for scale: past ~40 rows the index splits into `### 索引·<域>`.
// memory_index must land each row in its own sub-table, upsert within it, and
// the health check must nag while a big table is still flat.
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: '基础设施域的一行', group: '基础设施' }, exec);
await T.memory_index.execute({ zone: 'functions', name: '检索目标', summary: '业务域的一行', group: '业务功能' }, exec);
const grouped = await readFile(idxPath, 'utf8');
ok(grouped.includes('### 索引·基础设施') && grouped.includes('### 索引·业务功能'), 'memory_index creates per-group sub-sections');
const infraStart = grouped.indexOf('### 索引·基础设施');
const bizStart = grouped.indexOf('### 索引·业务功能');
const infraBlock = grouped.slice(infraStart, bizStart === -1 ? undefined : bizStart);
ok(rowsFor(infraBlock, '测试功能').length === 1 && rowsFor(infraBlock, '检索目标').length === 0, 'each row lands in its own group block');
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: '基础设施域更新后的一行', group: '基础设施' }, exec);
const grouped2 = await readFile(idxPath, 'utf8');
ok(rowsFor(grouped2, '测试功能').length === 1, 'grouped upsert is idempotent');
ok(grouped2.includes('基础设施域更新后的一行'), 'grouped upsert replaced the summary');
// R15 must NOT flag the shared header row: every `### 索引·<域>` sub-table reuses
// FUNC_TABLE_HEADER by design, so a repeated header is structure, not a stale row.
const cGroup = await T.memory_check.execute({}, exec);
ok(
	cGroup.results.every((r) => !(r.rule === 'R15' && r.message.includes('功能域摘要'))),
	`R15 ignores shared group headers (${cGroup.results.filter((r) => r.rule === 'R15').length} R15)`
);
// Ungrouping is the OTHER half of the migration: a later upsert WITHOUT group
// must move the row back to the flat table and drop the emptied sub-section —
// otherwise the row lives in two tables and R15 fires on the next check.
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: '回到总表的一行' }, exec);
const ungrouped = await readFile(idxPath, 'utf8');
ok(rowsFor(ungrouped, '测试功能').length === 1, 'ungrouped upsert leaves exactly one row');
ok(ungrouped.includes('回到总表的一行'), 'ungrouped upsert wrote the new summary into the flat table');
ok(!ungrouped.includes('### 索引·基础设施'), 'the emptied group section was removed');
ok(ungrouped.includes('### 索引·业务功能') && rowsFor(ungrouped, '检索目标').length === 1, 'a sibling group that still has rows survives');
// R5 scaling hint: 41 flat rows and no ### 索引· -> WARN
const flatRows = Array.from({ length: 41 }, (_, i) => `| 域${i} | 第 ${i} 个功能的一句话 | [functions/域${i}.md](functions/域${i}.md) |`).join('\n');
const flatIndex = ['# 索引', '', '## 功能模块索引（functions/）', '', '| 功能域摘要 | 一句话状态 | 过程链接 | 摘要 |', '|---|---|---|---|', flatRows, '', '## 创新优化思想索引（insights/）', '', '| 思想主题 | 内涵 | 思想内容 | 相关 |', '|---|---|---|---|'].join('\n');
const flatRoot = await mkdtemp(path.join(tmpdir(), 'dsh-flat-'));
await writeFile(path.join(flatRoot, 'MEMORY.md'), flatIndex, 'utf8');
const flatHealth = await mod.runHealthCheck(flatRoot, { maxIndexBytes: 64 * 1024, maxIndexHardBytes: 96 * 1024, maxFunctionBytes: 30 * 1024, newFeatureGraceDays: 0 });
ok(flatHealth.results.some((r) => r.rule === 'R5' && r.message.includes('拆分子分区')), `R5 flags a big flat function table (${flatHealth.results.filter((r) => r.rule === 'R5').length} R5)`);
await rm(flatRoot, { recursive: true, force: true });

// 15b) R15: duplicated index rows and duplicated table sections are flagged.
// Simulate the fallback-table twin by hand-editing the index. The twin row
// carries the twin's own summary, so the upsert's column-2 refresh cannot
// absorb the duplicate — only the section self-heal (or a manual fix) removes it.
const twinSection = [
	'## 功能域（细节在子目录，本表只留指针）',
	'',
	'| 功能域摘要 | 一句话状态 / 待验证 | 过程链接 | 摘要 |',
	'|---|---|---|---|',
	'| 测试功能 | 旧代兜底表里的一行 | [functions/测试功能.md](functions/测试功能.md) |',
	'',
].join('\n');
await writeFile(idxPath, idxNow + '\n' + twinSection, 'utf8');
const c5 = await T.memory_check.execute({}, exec);
const r15 = c5.results.filter((r) => r.rule === 'R15');
ok(r15.some((r) => r.message.includes('测试功能')), `R15 flags the duplicated row (${r15.length} R15)`);
ok(r15.some((r) => r.message.includes('出现 2 次')), 'R15 flags the duplicated section');
// the self-healing upsert removes the twin table on the next memory_index call
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: 'upsert 后重复表消失' }, exec);
const idxHealed = await readFile(idxPath, 'utf8');
ok(!idxHealed.includes('## 功能域（细节在子目录'), 'twin table removed by upsert self-heal');
const rows = rowsFor(idxHealed, '测试功能').length;
ok(rows === 1, `index has exactly one 测试功能 row (rows=${rows})`);
const c6 = await T.memory_check.execute({}, exec);
ok(c6.results.every((r) => r.rule !== 'R15'), `R15 clean after self-heal (${c6.results.filter((r) => r.rule === 'R15').length})`);
// R10 must not silently skip links whose target contains a SPACE: safeSlug
// allows spaces, so 「可观测性先于修 bug.md」 is a real filename shape. The old
// [^)\s] href pattern matched zero links like this — a dangling one never
// tripped the lint, and the panel rendered the raw markdown as "duplicated" text.
await writeFile(idxPath, idxHealed + '\n- 空格悬空测试 → [insights/不存在的 主题.md](insights/不存在的 主题.md)\n', 'utf8');
const cSpaced = await T.memory_check.execute({}, exec);
ok(
	cSpaced.results.some((r) => r.rule === 'R10' && r.message.includes('不存在的 主题.md')),
	`R10 flags a spaced dangling href (${cSpaced.results.filter((r) => r.rule === 'R10').length} R10)`,
);
await writeFile(idxPath, idxHealed, 'utf8');

// 16) R3 head guardrail: a head summary whose 截至 date is older than the newest
// iteration block is flagged (append must pair with head refresh); a missing
// head summary is flagged too. R16: env-constant absolute paths must exist.
const fnPath15 = w1.featureFile;
const fnText15 = await readFile(fnPath15, 'utf8');
const staleHead = fnText15.replace(/当前状态摘要（截至\s*\d{4}-\d{2}-\d{2}/, '当前状态摘要（截至 2000-01-01');
await writeFile(fnPath15, staleHead, 'utf8');
const c7 = await T.memory_check.execute({}, exec);
ok(c7.results.some((r) => r.rule === 'R3' && r.message.includes('早于最新迭代块')), `R3 flags a stale head summary (${c7.results.filter((r) => r.rule === 'R3').length} R3)`);
await writeFile(fnPath15, fnText15.replace(/当前状态摘要（截至\s*\d{4}-\d{2}-\d{2}/, '当前状态摘要（截至'), 'utf8');
const c8 = await T.memory_check.execute({}, exec);
ok(c8.results.some((r) => r.rule === 'R3' && r.message.includes('缺少')), 'R3 flags a missing head summary');
// R16: a dead absolute path in the index's env-constants is flagged.
const idxText16 = await readFile(idxPath, 'utf8');
await writeFile(idxPath, idxText16 + '\n- 旧工具链：`Z:/definitely/gone/tool.cmd`', 'utf8');
const c9 = await T.memory_check.execute({}, exec);
ok(c9.results.some((r) => r.rule === 'R16' && r.message.includes('Z:/definitely/gone')), 'R16 flags a dead env-constant path');
// a live path must NOT be flagged
await writeFile(idxPath, idxText16 + '\n- 临时目录：' + '`' + root.replace(/\\/g, '/') + '`', 'utf8');
const c10 = await T.memory_check.execute({}, exec);
ok(!c10.results.some((r) => r.rule === 'R16'), 'R16 silent on live paths');

// 17) federation (three-tier): project truth sources -> federation layer.
// Two throwaway project roots, one throwaway federation root; sync copies each
// MEMORY.md into sources/ and builds the mechanical project table; check lints
// the layer (F1 missing index, F2 dangling link, F3 missing copy/row, F5 orphan).
const fedRoot = await mkdtemp(path.join(tmpdir(), 'dsh-fed-'));
const projA = await mkdtemp(path.join(tmpdir(), 'dsh-proj-a-'));
const projB = await mkdtemp(path.join(tmpdir(), 'dsh-proj-b-'));
for (const [dir, label] of [[projA, 'A'], [projB, 'B']]) {
	await writeFile(path.join(dir, 'MEMORY.md'), `# ${label} 项目记忆\n\n## 功能模块索引（functions/）\n\n| 功能域摘要 | 一句话状态 | 过程链接 | 摘要 |\n|---|---|---|---|\n| ${label}功能 | ${label} 的一句话 | [functions/${label}功能.md](functions/${label}功能.md) |\n`, 'utf8');
	await mkdir(path.join(dir, 'functions'), { recursive: true });
	await writeFile(path.join(dir, 'functions', `${label}功能.md`), '# x\n', 'utf8');
}
mod.apply(fakeCtx, { memoryRoot: root, federation: { root: fedRoot, projects: [{ key: 'proj-a', root: projA }, { key: 'proj-b', root: projB }] } });
const FED = Object.fromEntries(registered.filter((r) => r?.name && r.execute).slice(-11).map((t) => [t.name, t]));
ok(typeof FED.memory_federation?.execute === 'function', 'memory_federation registered');
const synced = await FED.memory_federation.execute({ action: 'sync' }, exec);
ok(synced.projects.length === 2 && synced.projects.every((p) => p.copied), 'sync copies every project index');
ok(await statExists(path.join(fedRoot, 'sources', 'proj-a.MEMORY.md')), 'sources/proj-a.MEMORY.md written');
const fedIndex = await readFile(path.join(fedRoot, 'MEMORY.md'), 'utf8');
ok(fedIndex.includes('## 项目索引（联邦层）') && fedIndex.includes('sources/proj-b.MEMORY.md'), 'federation index table links each copy');
ok(fedIndex.includes('## 跨项目共识'), 'federation index keeps a consensus section for the model');
const check1 = await FED.memory_federation.execute({ action: 'check' }, exec);
ok(check1.failCount === 0 && check1.warnCount === 0, `federation check clean (${check1.failCount} FAIL / ${check1.warnCount} WARN)`);
// re-sync must preserve a hand-written consensus line (model-owned section)
await writeFile(path.join(fedRoot, 'MEMORY.md'), fedIndex.replace('- \n', '- 两个项目共用 Node 22 与 pnpm 工作流\n'), 'utf8');
await FED.memory_federation.execute({ action: 'sync' }, exec);
const fedIndex2 = await readFile(path.join(fedRoot, 'MEMORY.md'), 'utf8');
ok(fedIndex2.includes('两个项目共用 Node 22'), 'sync preserves the model-written consensus section');
// orphan copy -> F5 WARN
await writeFile(path.join(fedRoot, 'sources', 'ghost.MEMORY.md'), '# ghost\n', 'utf8');
const check2 = await FED.memory_federation.execute({ action: 'check' }, exec);
ok(check2.findings.some((f) => f.rule === 'F5' && f.message.includes('ghost')), 'F5 flags an orphan copy');
await rm(path.join(fedRoot, 'sources', 'ghost.MEMORY.md'), { force: true });
// missing project MEMORY.md -> F3 FAIL
await rm(path.join(projB, 'MEMORY.md'), { force: true });
const check3 = await FED.memory_federation.execute({ action: 'check' }, exec);
ok(check3.failCount >= 1 && check3.findings.some((f) => f.rule === 'F3' && f.message.includes('proj-b')), 'F3 flags a project without MEMORY.md');
// dangling link in the federation index -> F2 FAIL
await writeFile(path.join(fedRoot, 'MEMORY.md'), fedIndex2 + '\n- 参考：[不存在](sources/nope.MEMORY.md)\n', 'utf8');
const check4 = await FED.memory_federation.execute({ action: 'check' }, exec);
ok(check4.findings.some((f) => f.rule === 'F2'), 'F2 flags a dangling federation link');
// unconfigured federation -> explicit error, not silence
mod.apply(fakeCtx, { memoryRoot: root });
// Name-keyed (not count-based): adding a tool must never shift this window.
const NOFED = Object.fromEntries(registered.filter((r) => r?.name && r.execute).map((t) => [t.name, t]));
let fedThrew = null;
try {
	await NOFED.memory_federation.execute({ action: 'check' }, exec);
} catch (e) {
	fedThrew = String(e.message);
}
ok(fedThrew && fedThrew.includes('federation'), `unconfigured federation fails loud (${fedThrew?.slice(0, 40)})`);
await rm(fedRoot, { recursive: true, force: true });
await rm(projA, { recursive: true, force: true });
await rm(projB, { recursive: true, force: true });

// 18) usage signals -> self-sorting layers, guard channel, circuit breaker.
// The article's model: usage frequency + correction frequency decide the layer,
// and a low-frequency/high-value memory must be able to opt out of the cold
// judgement entirely.
const US = T.memory_usage;
ok(typeof US?.execute === 'function', 'memory_usage registered');
// guard: a marked file is skipped by the TEMP cold rule
const gw = await T.memory_write.execute(
	{ feature: '守护域', title: '低频高价值的兜底规则', summary: '安全审计类低频高价值记忆', result: 'done', guard: true },
	exec,
);
const guardText = await readFile(gw.featureFile, 'utf8');
ok(guardText.includes('🛡 守护型'), 'guard=true writes the guard marker');
const cg = await T.memory_check.execute({}, exec);
const coldNames = cg.results.filter((r) => r.rule === 'TEMP').map((r) => r.message).join(' ');
ok(!coldNames.includes('守护域'), 'guarded file is exempt from the cold-memory rule');
// un-guarded control file IS flagged
await T.memory_write.execute({ feature: '普通冷域', title: '没人引用的块', summary: '会被判冷的普通域', result: 'done' }, exec);
const cg2 = await T.memory_check.execute({}, exec);
ok(cg2.results.some((r) => r.rule === 'TEMP' && r.message.includes('普通冷域')), 'unguarded cold file still flagged');
// usage recording: recalls from the pre-step hook are logged automatically
const psH = globalThis.__preStepListener;
ok(typeof psH === 'function', 'pre-step listener available for usage logging');
const usageLog = await readFile(path.join(root, '.usage.jsonl'), 'utf8').catch(() => '');
ok(usageLog.length > 0 && usageLog.includes('recall'), 'recall injections are logged as usage');
// manual record: correction + positive, then report layers
await US.execute({ action: 'record', href: 'functions/检索目标.md', kind: 'correction', note: '用户说不对' }, exec);
await US.execute({ action: 'record', href: 'functions/检索目标.md', kind: 'positive', note: '这次对了' }, exec);
const rep = await US.execute({ action: 'report', days: 30 }, exec);
const target = rep.items.find((i) => i.href === 'functions/检索目标.md');
ok(target && target.corrections >= 1 && target.positives >= 1, `usage report aggregates correction/positive (${target?.corrections}/${target?.positives})`);
ok(target.layer === '专项' || target.layer === '实验', `layer suggestion present (${target?.layer})`);
ok(rep.items.some((i) => i.href.startsWith('functions/')), 'report lists function targets');
// circuit breaker: 3 corrections with few uses trips R18
await US.execute({ action: 'record', href: 'functions/熔断域.md', kind: 'correction' }, exec);
await US.execute({ action: 'record', href: 'functions/熔断域.md', kind: 'correction' }, exec);
await US.execute({ action: 'record', href: 'functions/熔断域.md', kind: 'correction' }, exec);
await T.memory_write.execute({ feature: '熔断域', title: '反复被纠正的域', summary: '用来验证熔断规则', result: 'pending' }, exec);
const cg3 = await T.memory_check.execute({}, exec);
ok(cg3.results.some((r) => r.rule === 'R18' && r.message.includes('熔断')), `R18 trips on a repeatedly corrected area (${cg3.results.filter((r) => r.rule === 'R18').length} R18)`);
// bad href / bad kind are rejected loudly
let usageThrew = 0;
for (const args of [{ action: 'record', href: '../escape.md', kind: 'correction' }, { action: 'record', href: 'functions/x.md', kind: 'bogus' }]) {
	try {
		await US.execute(args, exec);
	} catch {
		usageThrew++;
	}
}
ok(usageThrew === 2, 'invalid usage records are rejected');
// record must return a visible receipt: the renderer used to fall through to the
// "no signals yet" placeholder for a successful record (items is empty by design).
const recRes = await US.execute({ action: 'record', href: 'functions/回执测试.md', kind: 'positive', note: '这次对了' }, exec);
ok(recRes.action === 'record' && recRes.warnings.length > 0, 'record returns a receipt');
const renderedRec = US.output.render({}, recRes).map((b) => b.text).join('\n');
ok(renderedRec.includes('已记录') && !renderedRec.includes('还没有使用信号'), `record receipt is rendered (${renderedRec.slice(0, 30)})`);

// 19) 道层验证闸门 (P0): a transferable principle must clear the mechanically
// checkable half of the four gates — >=2 unrelated source areas, and no
// operation-manual phrasing. Consensus entries (the binding layer) must carry
// evidence and stay one sentence; usage flips expose unstable conclusions.
const i4 = await T.memory_insight.execute({ theme: '单源原则', principle: '只有一个来源的原则', summary: '单源测试', sources: ['测试功能'] }, exec);
ok(i4.warnings.some((w) => w.includes('跨域闸门')), 'insight warns when it has only one source area');
const i5 = await T.memory_insight.execute({ theme: '双源原则', principle: '两个来源支持的原则', summary: '双源测试', sources: ['测试功能', '检索目标'] }, exec);
ok(!i5.warnings.some((w) => w.includes('跨域闸门')), 'no cross-domain warning with two source areas');
const i6 = await T.memory_insight.execute({ theme: '步骤原则', principle: '1. 先运行 npm test；2. 再部署上线', summary: '步骤测试', sources: ['测试功能'] }, exec);
ok(i6.warnings.some((w) => w.includes('可降级')), 'insight warns when the principle reads like a procedure');
const longPrinciple = '这是一个非常长的原则句子用来验证长度闸门'.repeat(12);
const i7 = await T.memory_insight.execute({ theme: '超长原则', principle: longPrinciple, summary: '超长测试', sources: ['测试功能'] }, exec);
ok(i7.warnings.some((w) => w.includes('字 >')), 'insight warns when the principle is too long');
// R19: consensus section — long entry / no evidence / cross-domain claim on one source
const memPath19 = path.join(root, 'MEMORY.md');
const memBefore19 = await readFile(memPath19, 'utf8');
const consensusHeading = '## 决策共识 / 规范（跨功能、约束级）';
const injected = [
	'## 决策共识 / 规范（跨功能、约束级）',
	'',
	`- ${'这条共识非常长'.repeat(20)}`,
	'- 没有依据的共识：靠感觉定规矩',
	'- 跨功能结论只有单来源 [functions/测试功能.md](functions/测试功能.md)',
	'- 两条来源的跨功能结论 [functions/测试功能.md](functions/测试功能.md)、[insights/双源原则.md](insights/双源原则.md)',
	'',
].join('\n');
const memAfter19 = memBefore19.includes(consensusHeading)
	? memBefore19.replace(new RegExp(`${consensusHeading}[\\s\\S]*?(?=\\n## )`), injected)
	: `${memBefore19}\n${injected}\n`;
await writeFile(memPath19, memAfter19, 'utf8');
const c19 = await T.memory_check.execute({}, exec);
const r19 = c19.results.filter((r) => r.rule === 'R19');
ok(r19.length >= 3, `R19 flags long / evidence-free / single-source consensus (${r19.length} R19)`);
ok(!r19.some((r) => r.message.includes('两条来源的跨功能结论')), 'a properly sourced consensus entry is not flagged');
// usage flips: positive -> correction -> positive is two verdict changes
await US.execute({ action: 'record', href: 'functions/翻转域.md', kind: 'positive' }, exec);
await US.execute({ action: 'record', href: 'functions/翻转域.md', kind: 'correction' }, exec);
await US.execute({ action: 'record', href: 'functions/翻转域.md', kind: 'positive' }, exec);
const rep2 = await US.execute({ action: 'report', days: 30 }, exec);
const flipItem = rep2.items.find((i) => i.href === 'functions/翻转域.md');
ok(flipItem && flipItem.flips >= 2, `usage report counts verdict flips (${flipItem?.flips})`);
ok(rep2.warnings.some((w) => w.includes('反复推翻')), 'a flip warning surfaces for unstable conclusions');

// 20) capability ledger: a CLI/MCP tool the agent actually used gets recorded
// once (one file per tool, updated in place) with its exact invocation,
// prerequisites and what it solved; record keeps the index row in sync.
const cap1 = await T.memory_capability.execute(
	{ action: 'record', name: 'ffmpeg', kind: 'cli', invocation: 'ffmpeg -f image2pipe -i pipe.png -c:v libx264 out.mp4', prereq: '已装 ffmpeg 7.x，PATH 可用', solved: 'OpenMontage 出片：静帧序列转 1920×1080 H.264', summary: '静帧序列转视频的渲染器' },
	exec,
);
ok(cap1.created === true && cap1.file.replace(/\\/g, '/').includes('capabilities/ffmpeg.md'), 'capability record creates a ledger file');
const capText = await readFile(cap1.file, 'utf8');
ok(capText.includes('## 调用方式') && capText.includes('ffmpeg -f image2pipe'), 'ledger keeps the exact invocation');
ok(capText.includes('> 摘要：静帧序列转视频的渲染器'), 'summary lands in the head line');
const cap2 = await T.memory_capability.execute(
	{ action: 'record', name: 'ffmpeg', kind: 'cli', invocation: 'ffmpeg -f image2pipe -i pipe.png -c:v libx264 -pix_fmt yuv420p out.mp4', solved: '批印坊 v2 成片 96s' },
	exec,
);
ok(cap2.created === false && cap2.file === cap1.file, 'record updates in place (one file per tool)');
const capText2 = await readFile(cap1.file, 'utf8');
ok(capText2.includes('-pix_fmt yuv420p'), 'invocation refreshed to the newer command');
ok(capText2.split('OpenMontage 出片').length === 2 && capText2.includes('批印坊 v2 成片 96s'), 'solved entries accumulate (ledger, not journal)');
const idxCap = await T.memory_read.execute({ kind: 'index' }, exec);
ok(rowsFor(idxCap.content, 'ffmpeg').length === 1 && idxCap.content.includes('capabilities/ffmpeg.md'), 'capability row lands in the index table');
// 5.15.2 heading: one bracket pair, meaning first — and an old-generation
// heading is renamed IN PLACE by the next upsert (no twin table).
ok(idxCap.content.includes('## 能力台账 细节子目录（可用工具 / MCP / CLI）'), 'capability heading is the new single-paren form');
ok(!idxCap.content.includes('（可用工具 / MCP / CLI）（'), 'no doubled paren after the rename');
{
	const idxP = path.join(root, 'MEMORY.md');
	const pre = await readFile(idxP, 'utf8');
	await writeFile(idxP, pre.replace('## 能力台账 细节子目录（可用工具 / MCP / CLI）', '## 能力台账（可用工具 / MCP / CLI）'), 'utf8');
	// Re-record the SAME slug with its invocation kept verbatim: upsertIndexRow
	// runs (heading must be migrated) yet the ledger body still contains the
	// image2pipe string a later search assertion depends on.
	await T.memory_capability.execute({ action: 'record', name: 'ffmpeg', kind: 'cli', invocation: 'ffmpeg -f image2pipe -i pipe.png -c:v libx264 -pix_fmt yuv420p out.mp4', solved: '迁移断言用的再记一次' }, exec);
	const post = await readFile(idxP, 'utf8');
	ok(post.includes('## 能力台账 细节子目录（可用工具 / MCP / CLI）'), 'legacy capability heading is migrated in place');
	ok((post.match(/^## 能力台账/gm) ?? []).length === 1, 'migration leaves exactly one capability table');
	ok(rowsFor(post, 'ffmpeg').length === 1, 'row count survives the heading migration');
}
const capList = await T.memory_capability.execute({ action: 'list' }, exec);
ok(capList.items.length === 1 && capList.items[0].name === 'ffmpeg' && capList.items[0].kind === 'cli', `list returns ledger entries (${capList.items.length})`);
const capRead = await T.memory_capability.execute({ action: 'read', name: 'ffmpeg' }, exec);
ok(capRead.content.includes('## 调用方式'), 'read returns the full ledger');
let capThrew = 0;
for (const args of [{ action: 'record', name: 'bad', kind: 'cli' }, { action: 'read', name: '不存在的能力' }]) {
	try {
		await T.memory_capability.execute(args, exec);
	} catch {
		capThrew++;
	}
}
ok(capThrew === 2, 'capability record/read validate their inputs');
// Boundary (user correction 2026-10-19): the ledger is for EXTERNAL tools only.
// The tool description and the injected discipline must both name what does NOT
// belong — harness built-ins and the project's own scripts/API — or agents
// re-file system capabilities as "discoveries" and the ledger becomes noise.
ok(/EXTERNAL CAPABILITY/.test(T.memory_capability.description), 'tool description scopes the ledger to external tools');
ok(/built-in/.test(T.memory_capability.description) && /own scripts/.test(T.memory_capability.description), 'tool description names the two excluded classes');
const capDisc = mod.DISCIPLINE_TEXT ?? '';
ok(capDisc.includes('外部工具') && capDisc.includes('harness 自带工具'), 'discipline text names the ledger boundary (external tools only)');
const capViaRead = await T.memory_read.execute({ kind: 'capability', name: 'ffmpeg' }, exec);
ok(capViaRead.found && capViaRead.content.includes('调用方式'), 'memory_read kind=capability works');
const capSearch = await T.memory_search.execute({ q: 'image2pipe' }, exec);
ok(capSearch.count >= 1 && capSearch.hits.some((h0) => h0.zone === 'capabilities'), `search covers capabilities (${capSearch.count} hits)`);
const capSearchZone = await T.memory_search.execute({ q: 'image2pipe', zone: 'capabilities' }, exec);
ok(capSearchZone.count >= 1 && capSearchZone.hits.every((h0) => h0.zone === 'capabilities'), 'capabilities zone filter works');
const cCap = await T.memory_check.execute({}, exec);
ok(!cCap.results.some((r) => r.message.includes('ffmpeg') && r.level === 'FAIL'), 'capability files do not trip the linter');

// 22b) memory defence (Hindsight-borrowed): credentials are redacted at the
// write choke point; the health check reports what the redactor cannot reach
// (the RAW daily layer, pre-defence files) and personal identifiers (tier 2)
// are reported, NEVER rewritten — facts must not be silently mangled.
{
	const wSec = await T.memory_write.execute(
		{ feature: '防线测试', title: '带密钥的迭代', summary: '验证写侧 redact', change: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 已配置', result: 'done' },
		exec,
	);
	ok(wSec.warnings.some((x) => x.includes('凭据材料') && x.includes('github-token')), 'write warns which credential was redacted');
	const secFn = await readFile(path.join(root, 'functions', '防线测试.md'), 'utf8');
	ok(secFn.includes('[REDACTED:github-token]') && !secFn.includes('ghp_abcdefghijklmnopqrstuvwxyz'), 'credential never reaches disk');
	// A credential arriving via the plugin's own index path is redacted too.
	await T.memory_index.execute({ zone: 'functions', name: '防线测试', summary: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456 混进摘要' }, exec);
	const secIdx = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
	ok(!secIdx.includes('sk-proj-abcdefghijklmnopqrstuvwxyz') && secIdx.includes('[REDACTED:'), 'index path is redacted as well');
	// Tier-2: an ID number in the daily RAW layer is reported, never rewritten.
	await writeFile(path.join(root, '2026-10-20.md'), '# 原始层\n\n- 用户身份证 11010519491231002X 已核对\n', 'utf8');
	const cSec = await T.memory_check.execute({}, exec);
	ok(cSec.results.some((r) => r.rule === 'R21' && r.level === 'WARN' && r.message.includes('cn-id')), 'R21 reports ID in the RAW layer');
	const stillThere = await readFile(path.join(root, '2026-10-20.md'), 'utf8');
	ok(stillThere.includes('11010519491231002X'), 'tier-2 is never rewritten');
	// A fenced code example is documentation, not a leak (no false positive).
	await T.memory_write.execute(
		{ feature: '防线测试', title: '代码块示例', summary: '验证误报边界', change: '示例见下\n\n```bash\nexport OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\n```\n\n正文结束', result: 'done' },
		exec,
	);
	const cSec2 = await T.memory_check.execute({}, exec);
	ok(!cSec2.results.some((r) => r.rule === 'R21' && r.level === 'FAIL' && r.message.includes('防线测试')), 'fenced credential example is not a leak');
}

// 23) memory_skill — the crystallization layer (MemOS-borrowed, file-discipline
// adapted): nomination is mechanical over the usage ledger, crystallization is
// the model's judgement, and the lifecycle candidate→active→retired decides what
// proactive recall is allowed to trust. Signals recorded via memory_usage(record)
// (awaited) so the ledger is complete before nomination runs.
// The nominated area gets a real function file first: a skill must cite a
// source that exists (else R10 dangles), and the same slug as the nominated
// href is what proves de-nomination is keyed on the EVIDENCE, not the name.
await T.memory_write.execute({ feature: '分离延迟重启', title: '建立被提名域', summary: '反复重跑的操作，等待结晶', result: 'done' }, exec);
for (let i = 0; i < 8; i++) await US.execute({ action: 'record', href: 'functions/分离延迟重启.md', kind: i < 2 ? 'positive' : 'recall' }, exec);
for (let i = 0; i < 4; i++) await US.execute({ action: 'record', href: 'functions/弱信号域.md', kind: 'recall' }, exec);
await US.execute({ action: 'record', href: 'functions/弱信号域.md', kind: 'correction' }, exec);
const sk1 = await T.memory_skill.execute({ action: 'candidates' }, exec);
ok(sk1.candidates.some((c) => c.href === 'functions/分离延迟重启.md' && c.uses >= 6 && c.positives >= 1), `nomination lists a high-usage confirmed area (${sk1.candidates.length})`);
ok(!sk1.candidates.some((c) => c.href === 'functions/弱信号域.md'), 'nomination skips low-usage / corrected areas');
const skCry = await T.memory_skill.execute(
	{
		action: 'crystallize',
		name: '分离延迟重启',
		summary: '会话跑在宿主内时用分离进程延迟杀旧起新',
		when: '需要让 DSH server 半新代码生效、而当前会话正运行在该宿主里时',
		procedure: ['写独立脚本：Start-Sleep 数秒 → Stop-Process 旧 PID → 启动 start-web.cmd', '会话内以分离后台任务启动脚本并立即结束当前回合', '刷新页面确认新 PID 启动时间晚于新提交'],
		pitfalls: '旧代进程可能在重启窗口写入过期数据，重启后复核',
		verification: 'overview 返回 200 且新 PID 创建时间晚于目标提交',
		sources: ['functions/分离延迟重启.md'],
	},
	exec,
);
ok(skCry.created && skCry.status === 'candidate' && skCry.file.replace(/\\/g, '/').includes('skills/分离延迟重启.md'), 'crystallize writes a candidate skill file');
const skText = await readFile(skCry.file, 'utf8');
ok(skText.includes('## 调用步骤') && /^\s*1[.、]/m.test(skText), 'skill body has numbered procedure steps');
ok(skText.includes('../functions/分离延迟重启.md'), 'skill backlinks its evidence source');
// The frontmatter router (skill-creator lesson): description carries the WHEN.
ok(/^---\nname: 分离延迟重启\n/m.test(skText) && /^description: "当.*时使用本技能/m.test(skText), 'skill file is frontmatter-shaped with a router description');
ok(skText.includes('agent_created: true') && skText.includes('status: candidate'), 'frontmatter carries agent_created + status');
const skIdx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(rowsFor(skIdx.content, '分离延迟重启').length === 1 && skIdx.content.includes('skills/分离延迟重启.md'), 'skill row lands in the index table');
// A crystallized area must drop out of nomination (support is now filed).
const sk2 = await T.memory_skill.execute({ action: 'candidates' }, exec);
ok(!sk2.candidates.some((c) => c.href === 'functions/分离延迟重启.md'), 'already-crystallized area is not re-nominated');
// Recall gate: candidate is NOT recallable, active is, retired is not.
const qTok = mod.tokensOf('分离延迟重启 宿主');
const rowsCand = mod.matchIndexRows(skIdx.content, qTok);
ok(!rowsCand.some((r) => r.zone === 'skill'), 'candidate skill is filtered out of recall');
const skAct = await T.memory_skill.execute({ action: 'activate', name: '分离延迟重启', note: '真实任务照做成功（本会话）' }, exec);
ok(skAct.status === 'active', 'activate flips lifecycle to active');
const idxAfterAct = (await T.memory_read.execute({ kind: 'index' }, exec)).content;
const rowsActive = mod.matchIndexRows(idxAfterAct, qTok);
ok(rowsActive.some((r) => r.zone === 'skill' && r.href === 'skills/分离延迟重启.md'), 'active skill is recallable');
const actMsgText = mod.buildRecallMessage(rowsActive).content[0].text;
ok(actMsgText.includes('⭐ 已结晶技能') && actMsgText.includes('按步骤走'), 'recall message marks the active skill with a do-not-rederive hint');
const skRet = await T.memory_skill.execute({ action: 'retire', name: '分离延迟重启', note: '宿主改为热重载，程序失效' }, exec);
ok(skRet.status === 'retired', 'retire flips lifecycle to retired');
const idxAfterRet = (await T.memory_read.execute({ kind: 'index' }, exec)).content;
ok(!mod.matchIndexRows(idxAfterRet, mod.tokensOf('分离延迟重启 宿主')).some((r) => r.zone === 'skill'), 'retired skill leaves recall');
// Lint + input guards.
let skThrew = 0;
for (const a of [
	{ action: 'crystallize', name: 'x', summary: 's', when: 'w', procedure: ['only one step'], verification: 'v', sources: ['functions/a.md'] },
	{ action: 'crystallize', name: 'x', summary: 's', when: 'w', procedure: ['a', 'b'], verification: 'v' },
	{ action: 'activate', name: '不存在技能' },
]) {
	try {
		await T.memory_skill.execute(a, exec);
	} catch {
		skThrew++;
	}
}
ok(skThrew === 3, `crystallize/activate validate their inputs (${skThrew}/3)`);
await mkdir(path.join(root, 'skills'), { recursive: true });
await writeFile(path.join(root, 'skills', '空壳技能.md'), '# 技能：空壳技能\n\n> 状态：weird · 首次结晶：2026-10-19\n\n## 调用步骤\n\n- \n', 'utf8');
const cSk = await T.memory_check.execute({}, exec);
const r20 = cSk.results.filter((r) => r.rule === 'R20' || r.rule === 'R20e');
ok(r20.some((r) => r.message.includes('状态「weird」非法')), 'R20 flags an illegal status');
ok(r20.some((r) => r.message.includes('调用步骤')), 'R20 flags an empty procedure');
ok(r20.some((r) => r.message.includes('何时使用')), 'R20 flags a missing trigger section');
await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);