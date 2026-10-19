/**
 * Functional harness for dsh-memory-manager (server.js).
 * Loads the real plugin entry, captures the registered tool definitions with a
 * fake ctx, and exercises write/read/insight/fold/rename/check/resolve/
 * supersede against a temp memory root.
 *
 * The Host installation must be discoverable (see resolveDshRoot): set
 * DSH_INSTALL_DIR when the harness install is not the process's own ancestor.
 */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
// Second apply with an explicit root: this instance's tools and pre-step
// listener both read the temp index. registered now holds BOTH applies' tool
// definitions (same names), so take the LAST six — the second apply's.
// `newFeatureGraceDays: 0` disables the cold-memory grace window so the
// temperature rule can be asserted deterministically (see 11d for the grace).
const disposer2 = mod.apply(fakeCtx, { memoryRoot: root, newFeatureGraceDays: 0 });
const tools2 = Object.fromEntries(
	registered.filter((r) => r?.name && r.execute).slice(-6).map((t) => [t.name, t]),
);
const T = tools2;
const disposer = noop;
let failures = 0;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
};

// 1) empty root -> check reports FAIL R0
const c0 = await T.memory_check.execute({}, exec);
ok(c0.failCount === 1 && c0.results[0].rule === 'R0', `check on empty root: ${c0.results[0]?.rule}`);

// 2) first write -> creates function file + index + daily
const w1 = await T.memory_write.execute(
	{ feature: '测试功能', title: '第一次迭代', summary: '验证插件写入闭环', currentState: '初始状态', change: '写入测试', verification: '本测试', result: 'done', open: '待验证遗留项' },
	exec,
);
ok(w1.createdFunctionFile === true, 'write creates function file');
ok(w1.warnings.length === 0, `no warnings (${w1.warnings.join('; ')})`);

// 3) index contains the row
const idx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(idx.found && idx.content.includes('测试功能'), 'index row present');

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

// 6) resolve: second feature with an open item, then resolve it
await T.memory_write.execute(
	{ feature: '遗留功能', title: '引入遗留', summary: '有遗留项的功能', result: 'pending' },
	exec,
);
const d0 = await T.memory_read.execute({ kind: 'daily' }, exec);
ok(d0.content.includes('## 今日待观察'), 'daily has 待观察 section');
const w5 = await T.memory_write.execute(
	{ feature: '测试功能', title: '解决遗留项', summary: '勾掉遗留功能的待观察', resolve: '遗留功能', result: 'done' },
	exec,
);
const d1 = await T.memory_read.execute({ kind: 'daily' }, exec);
ok(d1.content.includes('✅') && d1.content.includes('functions/遗留功能.md'), `resolve marks open item (logs: ${w5.resolvedDailyLogs.join(',')})`);

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
// insights, so it must NOT be cold; 前方无引用的功能域 would be.
await T.memory_write.execute({ feature: '无引用功能', title: '孤立块', summary: '没有任何其他文件引用此功能', result: 'done' }, exec);
const c2 = await T.memory_check.execute({}, exec);
const cold = c2.results.filter((r) => r.rule === 'TEMP');
ok(cold.some((r) => r.message.includes('无引用功能')), `cold flagged: ${cold.map((r) => r.message.split('：')[0]).join('; ')}`);
ok(!cold.some((r) => r.message.includes('测试功能')), 'referenced feature not flagged cold');

// 11c) dedupe: writing a summary highly overlapping another row's warns
const w6 = await T.memory_write.execute(
	{ feature: '相近功能', title: '疑似重复写入', summary: '没有任何其他文件引用此功能的孤立块', result: 'done' },
	exec,
);
ok(w6.warnings.some((x) => x.includes('疑似与已有功能域')), `dedupe warning: ${w6.warnings.join(' | ').slice(0, 80)}`);

// 11d) grace period: a brand-new feature file has had no chance to be
// backlinked, so the default window suppresses the cold flag for it.
mod.apply(fakeCtx, { memoryRoot: root });
const tools3 = Object.fromEntries(
	registered.filter((r) => r?.name && r.execute).slice(-6).map((t) => [t.name, t]),
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
	const idxNow13 = await readFile(await (async () => w1.indexFile)(), 'utf8');
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
ok(w8.warnings.some((x) => x.includes('索引行摘要')), 'write warns on an over-long index summary');
const c4 = await T.memory_check.execute({}, exec);
const r14 = c4.results.filter((r) => r.rule === 'R14');
ok(r14.some((r) => r.message.includes('冗长功能')), `R14 flags the un-distilled block (${r14.length} R14)`);
ok(r14.some((r) => r.message.includes('摘要过长功能')), 'R14 flags the over-long index row');
ok(c4.failCount === 0, 'R14 is advisory (WARN), never a FAIL');

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

// 15) daily-thread dedupe: the SECOND write with the same title + feature on
// the same day is recognized as an identical audit line — it warns and the
// daily file keeps exactly one copy (the function file is append-only and
// still receives the block; the audit thread is the deduped surface).
const w12 = await T.memory_write.execute(
	{ feature: '测试功能', title: '重复写入审计行', summary: '验证每日线索去重', result: 'done' },
	exec,
);
ok(!w12.warnings.some((x) => x.includes('重复写入被跳过')), 'first write of the title is not deduped');
const w12b = await T.memory_write.execute(
	{ feature: '测试功能', title: '重复写入审计行', summary: '验证每日线索去重', result: 'done' },
	exec,
);
ok(w12b.warnings.some((x) => x.includes('重复写入被跳过')), `repeat write warns: ${w12b.warnings.join(' | ').slice(0, 60)}`);
const dAfter = await T.memory_read.execute({ kind: 'daily' }, exec);
const dupsAfter = dAfter.content.split('\n').filter((l) => l.includes('- 重复写入审计行 →'));
ok(dupsAfter.length === 1, `daily line appears exactly once (${dupsAfter.length})`);
// a different title on the same day still appends normally
const w13 = await T.memory_write.execute(
	{ feature: '测试功能', title: '同日不同标题照常入账', summary: '不同结论不受去重影响', result: 'done' },
	exec,
);
ok(!w13.warnings.some((x) => x.includes('重复写入被跳过')), 'distinct title not deduped');
const dAfter2 = await T.memory_read.execute({ kind: 'daily' }, exec);
ok(dAfter2.content.includes('- 同日不同标题照常入账'), 'distinct daily line appended');

// 15b) R15: duplicated index rows and duplicated table sections are flagged.
// Simulate the fallback-table twin by hand-editing the index. The twin row
// carries the twin's own summary, so the upsert's column-2 refresh cannot
// absorb the duplicate — only the section self-heal (or a manual fix) removes it.
const idxPath = w1.indexFile;
const idxNow = await readFile(idxPath, 'utf8');
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
// the self-healing upsert removes the twin table on the next write
const w14 = await T.memory_write.execute(
	{ feature: '测试功能', title: '触发自愈的写入', summary: 'upsert 后重复表消失', result: 'done' },
	exec,
);
ok(!w14.warnings.some((x) => x.includes('表')), 'self-heal write raises no duplicate-table warning');
const idxHealed = await readFile(idxPath, 'utf8');
ok(!idxHealed.includes('## 功能域（细节在子目录'), 'twin table removed by upsert self-heal');
const rows = (idxHealed.match(/^\| 测试功能 \|/gm) ?? []).length;
ok(rows === 1, `index has exactly one 测试功能 row (rows=${rows})`);
const c6 = await T.memory_check.execute({}, exec);
ok(c6.results.every((r) => r.rule !== 'R15'), `R15 clean after self-heal (${c6.results.filter((r) => r.rule === 'R15').length})`);

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
const idxPath16 = w1.indexFile;
const idxText16 = await readFile(idxPath16, 'utf8');
await writeFile(idxPath16, idxText16 + '\n- 旧工具链：`Z:/definitely/gone/tool.cmd`', 'utf8');
const c9 = await T.memory_check.execute({}, exec);
ok(c9.results.some((r) => r.rule === 'R16' && r.message.includes('Z:/definitely/gone')), 'R16 flags a dead env-constant path');
// a live path must NOT be flagged
await writeFile(idxPath16, idxText16 + '\n- 临时目录：' + '`' + root.replace(/\\/g, '/') + '`', 'utf8');
const c10 = await T.memory_check.execute({}, exec);
ok(!c10.results.some((r) => r.rule === 'R16'), 'R16 silent on live paths');

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
