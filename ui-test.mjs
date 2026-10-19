/**
 * Panel view test: drives the client half without a browser.
 *
 * No React is installable on a Host-only machine (the Web app bundles its own),
 * so this test supplies a minimal React-compatible shim: createElement plus
 * static hooks. Components are then executed once and serialized to a tiny
 * markup string, which is enough to assert the panel's information
 * architecture, per-kind folding, index tables and in-panel links.
 *
 * `props.__apiFixtures` is the documented test seam that replaces fetch, and
 * `__internalsForTest` exposes the pure parsing/folding logic.
 */
import { readFile } from 'node:fs/promises';

let failures = 0;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
};

// --- minimal React shim -----------------------------------------------------
const FakeReact = {
	createElement(type, props, ...children) {
		const flat = children.length === 1 ? children[0] : children.length ? children : undefined;
		return { type, props: { ...(props ?? {}), children: flat } };
	},
	useState(init) {
		return [typeof init === 'function' ? init() : init, () => {}];
	},
	useEffect() {},
	useRef(value) {
		return { current: value };
	},
};

globalThis.window = { __ModuleLoader__: { load: (m) => (globalThis.__clientModule = m) } };
await import(new URL('./client.js', import.meta.url).href);
const mod = globalThis.__clientModule;
ok(Boolean(mod) && typeof mod.factory === 'function', 'client module registers a factory');
ok(mod?.id === 'dsh-memory-manager', `module id = ${mod?.id}`);

const instance = mod.factory((name) => (name === 'react' ? FakeReact : undefined));
const T = instance.__internalsForTest;

// --- slot registration ------------------------------------------------------
const registered = [];
const fakeCtx = {
	slots: {
		inject: (slot, fn) => fn(),
		register: (opts, component) => registered.push({ opts, component }),
	},
};
instance.apply(fakeCtx);
ok(registered.length === 2, `apply registers 2 slots (${registered.length})`);
ok(
	registered.some((r) => r.opts.name === 'sidebar.panellist' && r.opts.id === 'memory-panel'),
	'sidebar.panellist id = memory-panel',
);
ok(registered.some((r) => r.opts.name === 'main' && r.opts.key === 'memory-panel'), 'main panel key = memory-panel');
const MemoryPanel = registered.find((r) => r.opts.name === 'main').component;

// --- fixtures ---------------------------------------------------------------
const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
const longBlock = (n) => Array.from({ length: 8 }, (_, i) => `- 第 ${n} 块的要点 ${i + 1}：${'细节说明'.repeat(48)}`).join('\n');
const fnText = [
	'# 功能域：alpha',
	'',
	'> 当前状态摘要：alpha 已稳定，等待上线验证。',
	'',
	'## [2026-09-01] 第一次迭代',
	'',
	longBlock(1),
	'',
	'## [2026-09-20] 第二次迭代',
	'',
	longBlock(2),
	'',
	'## [2026-10-10] 第三次迭代',
	'',
	longBlock(3),
	'',
	'## [2026-10-18补] 第四次迭代',
	'',
	longBlock(4),
	'',
	'相关：[beta.md](beta.md)',
].join('\n');
const indexText = [
	'# 记忆管理（索引 + 纪律）',
	'',
	'> 读取纪律：先查索引。',
	'',
	'## 功能模块索引（functions/）',
	'',
	'| 功能域摘要 | 一句话状态 / 待验证 | 过程链接 | 摘要 |',
	'|---|---|---|---|',
	'| alpha | alpha 已稳定，等待上线验证。 | [functions/alpha.md](functions/alpha.md) |',
	'| beta | beta 的状态摘要。 | [functions/beta.md](functions/beta.md) |',
	'',
	'## 创新优化思想索引（insights/）',
	'',
	'| 思想主题 | 一句话内涵 / 解决的权衡 | 思想内容 | 相关（来源功能） |',
	'|---|---|---|---|',
	'| gamma | gamma 的思想内涵。 | [insights/gamma.md](insights/gamma.md) | [functions/alpha.md](functions/alpha.md) |',
	'',
	'## 环境常量（易忘）',
	'',
	'- 记忆根：`C:/x/memory`',
	'',
	'## 细节指针（跨功能的详细论证存放处）',
	'',
	'- ',
].join('\n');
const fixtures = {
	'/api/memory-org/overview?v=0': { data: [{ root: 'C:/x/memory', initialized: true, failCount: 0, warnCount: 1, results: [{ level: 'WARN', rule: 'TEMP', message: 'functions/beta.md 冷记忆' }], title: '全局记忆', path: 'C:/x/.dsh', counts: { functions: 2, insights: 1, daily: 2 } }], loading: false, error: null },
	'/api/memory-org/list?zone=functions&v=0': { data: { files: [{ name: 'alpha.md', bytes: fnText.length, mtime: iso(30) }, { name: 'beta.md', bytes: 900, mtime: iso(2000) }] }, loading: false, error: null },
	'/api/memory-org/list?zone=insights&v=0': { data: { files: [{ name: 'gamma.md', bytes: 500, mtime: iso(120) }] }, loading: false, error: null },
	'/api/memory-org/list?zone=daily&v=0': { data: { files: [{ name: '2026-10-18.md', bytes: 400, mtime: iso(5) }, { name: '2026-09-30.md', bytes: 800, mtime: iso(18_000) }] }, loading: false, error: null },
	'/api/memory-org/file?name=MEMORY.md&v=0': { data: { name: 'MEMORY.md', text: indexText }, loading: false, error: null },
	'/api/memory-org/file?zone=functions&name=alpha.md': { data: { name: 'alpha.md', text: fnText }, loading: false, error: null },
	'/api/memory-org/file?zone=insights&name=gamma.md': { data: { name: 'gamma.md', text: '> 性质：可重套的原则。\n\n## 核心原则\n\n- 原则本体。\n\n## 思想演进\n\n- 2026-10-18 首次沉淀。\n\n## 适用面（超出来源功能的部分）\n\n- 适用面正文。\n\n## 待观察\n\n- 待观察正文。' }, loading: false, error: null },
	'/api/memory-org/file?zone=daily&name=2026-10-18.md': { data: { name: '2026-10-18.md', text: '## 今日线索\n\n- 功能：alpha → [functions/alpha.md](functions/alpha.md)（✅ 2026-10-19 已解决 → [functions/alpha.md](functions/alpha.md)）\n\n## 今日待观察\n\n- 待验证项' }, loading: false, error: null },
	// Shapes below mirror the live API byte for byte (see the contract block in
	// api-test.mjs): overview carries `results`, search hits carry `snippet` +
	// `heading`. Fixtures that invent field names hide exactly the mismatch a user
	// sees as "the panel and the system don't agree".
	'/api/memory-org/search?q=%E5%86%B7%E8%AE%B0%E5%BF%86': { data: { hits: [{ zone: 'functions', name: 'beta.md', line: 3, heading: '今日待观察', snippet: '…冷记忆相关命中…' }] }, loading: false, error: null },
};

// --- tiny renderer ----------------------------------------------------------
function serialize(node) {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string') return node;
	if (typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(serialize).join('');
	const { type, props } = node;
	if (typeof type === 'function') {
		if (!type.name) return '';
		return serialize(type(props ?? {}));
	}
	// The component-local <style> sheet would otherwise pollute substring counts.
	if (type === 'style') return '<style/>';
	const attrs = [];
	if (props?.className) attrs.push(`class="${props.className}"`);
	if (props?.['data-dmo']) attrs.push(`data-dmo="${props['data-dmo']}"`);
	if (props?.title) attrs.push(`title="${String(props.title).slice(0, 40)}"`);
	if (props?.placeholder) attrs.push(`placeholder="${props.placeholder}"`);
	if (typeof props?.onClick === 'function') attrs.push('clickable');
	const inner = serialize(props?.children);
	return `<${type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${inner}</${type}>`;
}

const render = (initialView) => serialize(FakeReact.createElement(MemoryPanel, { __apiFixtures: fixtures, initialView }));
const count = (s, needle) => s.split(needle).length - 1;

// --- overview ---------------------------------------------------------------
const overview = render({ kind: 'overview' });
ok(count(overview, 'data-dmo="nav-item"') === 5, `rail has 5 destinations (${count(overview, 'data-dmo="nav-item"')})`);
ok(overview.includes('功能') && overview.includes('思想') && overview.includes('每日') && overview.includes('索引'), 'rail labels for every zone');
ok(count(overview, 'data-dmo="growth-card"') === 3, 'overview shows three zone count cards');
ok(overview.includes('WARN 1') && overview.includes('冷记忆 1'), 'health chips carry the warning and the cold count');
ok(overview.includes('[WARN] TEMP: functions/beta.md 冷记忆'), 'the health list renders every problem from overview.results');
ok(overview.includes('2 功能 · 1 思想 · 2 日线索'), 'header summarises the memory size');
ok(count(overview, 'data-dmo="timeline-row"') === 5, `timeline merges all zones (${count(overview, 'data-dmo="timeline-row"')})`);
const tl = overview.slice(overview.indexOf('data-dmo="timeline-row"'));
ok(tl.indexOf('2026-10-18') < tl.indexOf('beta'), 'timeline is newest-first');
ok(overview.includes('alpha 已稳定'), 'timeline rows carry the index one-line summary');
ok(overview.includes('刚刚') || overview.includes('分钟前'), 'timeline shows relative time');
// overview usage card: fixtures have no usage field -> the empty state explains
// where signals come from instead of rendering a broken chart
ok(overview.includes('还没有使用信号'), 'usage card explains itself when there are no signals');
ok(count(overview, 'dmo-card') >= 3, `overview renders health + usage + timeline cards (${count(overview, 'dmo-card')})`);
// with usage data, the layer histogram + hotspots render
const overviewWithUsage = serialize(
	FakeReact.createElement(MemoryPanel, {
		__apiFixtures: {
			...fixtures,
			'/api/memory-org/overview?v=0': { data: [{ root: 'C:/x/memory', initialized: true, failCount: 0, warnCount: 1, results: [{ level: 'WARN', rule: 'TEMP', message: 'functions/beta.md 冷记忆' }], counts: { functions: 2, insights: 1, daily: 2 }, usage: { signalCount: 12, layers: { 实验: 2, 专项: 1, 通用: 0 }, hotspots: [{ href: 'functions/beta.md', flips: 2, badRate: 0.5, uses: 3 }] } }], loading: false, error: null },
		},
		initialView: { kind: 'overview' },
	}),
);
ok(overviewWithUsage.includes('实验 2') && overviewWithUsage.includes('专项 1'), 'usage card renders the layer histogram');
ok(overviewWithUsage.includes('30 天 12 条信号'), 'usage card shows the signal count');
ok(overviewWithUsage.includes('结论反复推翻（翻转 2）'), 'hotspots name flip-heavy memories');
ok(overviewWithUsage.includes('纠正率 50%'), 'hotspots name high correction rates');

// --- zone list --------------------------------------------------------------
const funList = render({ kind: 'zone', zone: 'functions' });
ok(count(funList, 'data-dmo="row"') === 2, 'functions list renders one row per file');
ok(funList.includes('alpha 已稳定，等待上线验证。'), 'list rows show the index summary (no need to open the file)');
ok(funList.includes('按时间 ↓') && funList.includes('切换排序'), 'sort toggle offered for named zones');
ok(funList.includes('按名称或摘要过滤'), 'filter input offered');
ok(funList.indexOf('alpha') < funList.indexOf('beta'), 'newest file first by default');
const dailyList = render({ kind: 'zone', zone: 'daily' });
ok(dailyList.includes('2026-10-18') && !dailyList.includes('按名称'), 'daily zone lists dates, no name sort');
ok(count(dailyList, 'class="dmo-month"') === 2, `daily zone groups days by month (${count(dailyList, 'class="dmo-month"')})`);
ok(dailyList.indexOf('2026-10') < dailyList.indexOf('2026-09'), 'months run newest-first');

// --- reader: long function file folds to the newest block -------------------
// Sections render newest-first (the file is append-only oldest-first; the
// reader flips the order so the top card is always the latest state).
const fnRead = render({ kind: 'file', zone: 'functions', name: 'alpha.md' });
ok(count(fnRead, 'data-dmo="section"') === 4, `function file shows 4 iteration blocks (${count(fnRead, 'data-dmo="section"')})`);
ok(count(fnRead, 'dmo-sec-body') === 1, 'only the newest block is expanded by default');
ok(fnRead.indexOf('第四次迭代') < fnRead.indexOf('第一次迭代'), 'blocks render newest-first');
ok(count(fnRead, 'data-dmo="toc-chip"') === 4, 'jump strip lists every block');
ok(fnRead.indexOf('2026-10-18') < fnRead.indexOf('2026-09-01'), 'jump strip is newest-first');
ok(fnRead.includes('当前状态摘要'), 'head summary stays visible above the blocks');
ok(fnRead.includes('返回') && fnRead.includes('展开全部') && fnRead.includes('复制路径'), 'reader toolbar complete');
ok(count(fnRead, 'clickable') > 4, 'rows and chips are interactive');

// --- reader: index renders navigation tables instead of raw text ------------
const idxRead = render({ kind: 'file', zone: '', name: null });
ok(count(idxRead, 'dmo-idx-row') === 3, `index renders 3 clickable navigation rows (${count(idxRead, 'dmo-idx-row')})`);
ok(idxRead.includes('alpha 已稳定') && idxRead.includes('gamma 的思想内涵'), 'both index tables render');
ok(count(idxRead, 'data-dmo="section"') === 0, 'index tables are not duplicated as section cards');
ok(idxRead.includes('记忆根'), 'remaining index sections (env constants) render as cards');
ok(idxRead.includes('clickable'), 'index rows open their target file in-panel');

// --- reader: insight + daily open every section ----------------------------
const insRead = render({ kind: 'file', zone: 'insights', name: 'gamma.md' });
ok(count(insRead, 'data-dmo="section"') === 4 && count(insRead, 'dmo-sec-body') === 4, 'insight sections all open (short file)');
ok(insRead.includes('核心原则') && insRead.includes('适用面'), 'insight section titles render');
const dayRead = render({ kind: 'file', zone: 'daily', name: '2026-10-18.md' });
ok(dayRead.includes('今日线索') && dayRead.includes('今日待观察'), 'daily threads render their sections');
ok(dayRead.includes('clickable'), 'daily bullet links navigate in-panel');
// The ✅ resolution stamp collapses into one compact chip (not a second inline
// pointer), and a repeated pointer to the same target degrades to plain text.
ok(count(dayRead, 'dmo-resolve') === 1, `resolution stamp renders as one chip (${count(dayRead, 'dmo-resolve')})`);
ok(!dayRead.includes('（✅ 2026-10-19 已解决 →'), 'raw stamp text is gone');
const raiseIdx = dayRead.indexOf('功能：alpha');
const dupIdx = dayRead.indexOf('功能：alpha', raiseIdx + 1);
ok(raiseIdx !== -1, 'raise-site link present');
const linkBtns = dayRead.split('class="dmo-link"').length - 1;
ok(linkBtns === 1, `alpha is a clickable link exactly once in the row (buttons=${linkBtns}, secondTextIdx=${dupIdx})`);
// Daily bullet lines flip to newest-first inside the reader (the file is an
// append-only audit trail; the latest situation must sit on top). The fixture
// body has alpha's bullet before 待观察's; after the flip 待观察 must come first.
const dayBody = dayRead.slice(dayRead.indexOf('今日线索'));
ok(dayBody.indexOf('待验证项') < dayBody.lastIndexOf('alpha'), `daily bullets render newest-first (${dayBody.indexOf('待验证项')} < ${dayBody.lastIndexOf('alpha')})`);
ok(dayBody.indexOf('今日待观察') < dayBody.lastIndexOf('功能：alpha'), 'daily section order unchanged, only bullet order flips');

// --- search results use the API's snippet + heading --------------------------
let searchZoneCalls = 0;
const searchView = serialize(
	FakeReact.createElement(T.SearchPane, {
		res: fixtures['/api/memory-org/search?q=%E5%86%B7%E8%AE%B0%E5%BF%86'],
		q: '冷记忆',
		zone: 'all',
		setZone: () => searchZoneCalls++,
		onOpen() {},
	}),
);
ok(searchView.includes('相关命中'), 'search hits render the API snippet text');
ok(searchView.includes('dmo-mark') && searchView.includes('冷记忆'), 'the query is highlighted inside the snippet');
ok(searchView.includes('今日待观察'), 'search hits show their section heading');
ok(searchView.includes('第 3 行'), 'search hits show the line number');
ok(count(searchView, 'data-dmo="search-zone"') === 5, `search offers a zone filter (${count(searchView, 'data-dmo="search-zone"')} chips)`);
ok(searchView.includes('dmo-chip btn active'), 'the active zone chip is marked');
// a filtered empty result explains itself instead of looking broken
const emptyFiltered = serialize(
	FakeReact.createElement(T.SearchPane, {
		res: { data: { hits: [] }, loading: false, error: null },
		q: '冷记忆',
		zone: 'insights',
		setZone: () => {},
		onOpen() {},
	}),
);
ok(emptyFiltered.includes('这个分区没有命中'), 'empty zone-filtered result explains the filter');
// highlight() splits the text around the match and marks it
const hl = T.highlight('abc冷记忆def', '冷记忆');
ok(hl.length === 3 && hl[0] === 'abc' && hl[1]?.type === 'mark' && hl[1].props.children === '冷记忆' && hl[2] === 'def', 'highlight marks the matched span');
const noQ = T.highlight('纯文本', '');
ok(noQ.length === 1 && noQ[0] === '纯文本', 'highlight is a no-op without a query');

// --- pure logic -------------------------------------------------------------
const tables = T.parseIndexTables(indexText);
ok(tables.functions.alpha?.summary === 'alpha 已稳定，等待上线验证。', 'parseIndexTables maps slug -> summary');
ok(tables.insights.gamma?.href === 'insights/gamma.md', 'parseIndexTables keeps the target href');
const split = T.splitSections(fnText);
ok(split.sections.length === 4 && split.sections[3].date === '2026-10-18', 'splitSections extracts dated blocks');
ok(split.preamble.includes('当前状态摘要'), 'splitSections keeps the head summary as preamble');
ok(T.defaultOpen('functions', split.sections, fnText)[0] === true && T.defaultOpen('functions', split.sections, fnText)[3] === false, 'fold policy opens the newest block only (reversed order: index 0 is newest)');
ok(T.defaultOpen('insights', split.sections, 'short')[0] === true, 'fold policy opens everything in short files');
const idxSections = T.splitSections(indexText).sections;
ok(T.defaultOpen('index', idxSections, indexText)[0] === true && T.defaultOpen('index', idxSections, indexText)[2] === false, 'index opens the tables and folds the rest');
ok(T.resolveHref('../functions/alpha.md', 'insights')?.zone === 'functions', 'insight backlinks resolve to functions');
ok(T.resolveHref('insights/gamma.md', 'functions')?.zone === 'insights', 'insights hrefs resolve');
ok(T.resolveHref('2026-10-18.md', 'daily')?.zone === 'daily', 'daily hrefs resolve');
ok(T.resolveHref('MEMORY.md', 'functions')?.zone === '', 'MEMORY.md resolves to the index');
ok(T.resolveHref('beta.md', 'functions')?.zone === 'functions', 'bare sibling links stay in their zone');
ok(T.resolveHref('https://example.com', 'functions') === null, 'external links are not treated as memory files');
ok(T.plain('[x.md](x.md) **状态**') === 'x.md 状态', 'plain() strips markdown for summaries');
ok(T.relTime(new Date(Date.now() - 3600_000).toISOString()) === '1 小时前', 'relTime renders hours');

console.log(failures === 0 ? 'UI ALL PASS' : `${failures} UI FAILURES`);
process.exit(failures === 0 ? 0 : 1);