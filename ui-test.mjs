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
	'| 功能域 | 一句话状态 / 待验证 |',
	'|---|---|',
	'| [alpha](functions/alpha.md) | alpha 已稳定，等待上线验证。 |',
	'| [beta](functions/beta.md) | beta 的状态摘要。 |',
	'',
	'## 创新优化思想索引（insights/）',
	'',
	'| 思想主题 | 一句话内涵 / 解决的权衡 |',
	'|---|---|',
	'| [gamma](insights/gamma.md) | gamma 的思想内涵。（来源：[alpha.md](functions/alpha.md)） |',
	'| [可观测性先于修 bug](insights/可观测性先于修 bug.md) | 带空格的主题名也必须渲染成链接。 |',
	'',
	'## 技能台账（可复用操作程序）（skills/）',
	'',
	'| 技能 | 一句话用途 | 状态 |',
	'|---|---|---|',
	'| [分离延迟重启](skills/分离延迟重启.md) | 会话跑在宿主内时用分离进程延迟杀旧起新 | active |',
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
	'/api/memory-org/overview?v=0': { data: [{ root: 'C:/x/memory', initialized: true, failCount: 0, warnCount: 1, results: [{ level: 'WARN', rule: 'TEMP', message: 'functions/beta.md 冷记忆' }], title: '全局记忆', path: 'C:/x/.dsh', counts: { functions: 2, insights: 1, capabilities: 0, skills: 1, daily: 2 } }], loading: false, error: null },
	'/api/memory-org/list?zone=functions&v=0': { data: { files: [{ name: 'alpha.md', bytes: fnText.length, mtime: iso(30) }, { name: 'beta.md', bytes: 900, mtime: iso(2000) }] }, loading: false, error: null },
	'/api/memory-org/list?zone=insights&v=0': { data: { files: [{ name: 'gamma.md', bytes: 500, mtime: iso(120) }] }, loading: false, error: null },
	'/api/memory-org/list?zone=skills&v=0': { data: { files: [{ name: '分离延迟重启.md', bytes: 700, mtime: iso(60) }] }, loading: false, error: null },
	// Skill library payload — 5.20.0 storage scan: the host side lists what is
	// ON DISK (bundle dirs with their file trees); no registry fields, no
	// hostDegraded (a missing root just means no bundles there).
	'/api/memory-org/skills?v=0': {
		data: {
			memory: [
				{ name: '分离延迟重启', hostName: 'detached-restart', description: '会话跑在宿主内时用分离进程延迟重启', status: 'active', scope: 'global', scopeProject: '', published: true, kind: 'memory', dir: 'C:/x/memory/skills', files: [{ rel: '', name: '分离延迟重启.md', bytes: 700 }] },
				{ name: '草稿技能', hostName: '', description: '一个还没转正的候选', status: 'candidate', scope: 'project', scopeProject: 'demo', published: false, kind: 'memory', dir: 'C:/x/memory/skills', files: [{ rel: '', name: '草稿技能.md', bytes: 300 }] },
			],
			host: [
				{ name: 'skill-creator', description: 'Guide for creating effective skills.', source: 'user-dsh', kind: 'host', dir: 'C:/x/.dsh/skills/skill-creator', files: [{ rel: '', name: 'SKILL.md', bytes: 17957 }, { rel: 'scripts/init_skill.py', name: 'init_skill.py', bytes: 11627 }, { rel: 'scripts/quick_validate.py', name: 'quick_validate.py', bytes: 2165 }] },
			],
		},
		loading: false,
		error: null,
	},
	'/api/memory-org/skill?name=skill-creator&kind=host': { data: { name: 'skill-creator', kind: 'host', text: '---\nname: skill-creator\ndescription: Guide\n---\n\n# Skill Creator\n\n先看 provider 契约。', files: [{ rel: '', name: 'SKILL.md', bytes: 60 }, { rel: 'scripts/init_skill.py', name: 'init_skill.py', bytes: 11627 }, { rel: 'scripts/quick_validate.py', name: 'quick_validate.py', bytes: 2165 }] }, loading: false, error: null },
	'/api/memory-org/skill?name=%E5%88%86%E7%A6%BB%E5%BB%B6%E8%BF%9F%E9%87%8D%E5%90%AF&kind=memory': { data: { name: '分离延迟重启', kind: 'memory', text: '---\nname: 分离延迟重启\nstatus: active\n---\n\n# 技能：分离延迟重启（指针）\n\n程序体在宿主目录包。', files: [{ rel: '', name: '分离延迟重启.md', bytes: 2221 }] }, loading: false, error: null },
	'/api/memory-org/skillfile?name=skill-creator&file=scripts%2Fquick_validate.py': { data: { name: 'skill-creator', file: 'scripts/quick_validate.py', text: '#!/usr/bin/env python3\nimport sys\n' }, loading: false, error: null },
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
ok(count(overview, 'data-dmo="nav-item"') === 7, `rail has 7 destinations (${count(overview, 'data-dmo="nav-item"')})`);
ok(overview.includes('功能') && overview.includes('思想') && overview.includes('每日') && overview.includes('索引') && overview.includes('能力') && overview.includes('技能'), 'rail labels for every zone');
ok(count(overview, 'data-dmo="growth-card"') === 3, 'overview shows three zone count cards');
ok(overview.includes('WARN 1') && overview.includes('冷记忆 1'), 'health chips carry the warning and the cold count');
ok(overview.includes('[WARN] TEMP: functions/beta.md 冷记忆'), 'the health list renders every problem from overview.results');
ok(overview.includes('2 功能 · 1 思想 · 2 日线索'), 'header summarises the memory size');
ok(count(overview, 'data-dmo="timeline-row"') === 6, `timeline merges all zones (${count(overview, 'data-dmo="timeline-row"')})`);
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
			'/api/memory-org/overview?v=0': { data: [{ root: 'C:/x/memory', initialized: true, failCount: 0, warnCount: 1, results: [{ level: 'WARN', rule: 'TEMP', message: 'functions/beta.md 冷记忆' }], counts: { functions: 2, insights: 1, capabilities: 0, skills: 1, daily: 2 }, usage: { signalCount: 12, layers: { 实验: 2, 专项: 1, 通用: 0 }, hotspots: [{ href: 'functions/beta.md', flips: 2, badRate: 0.5, uses: 3 }] } }], loading: false, error: null },
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

// --- skill library: one destination, two sides behind a toggle ---------------
// The tab is NAVIGATION state (view.tab), so each side renders deterministically
// without a live useState — exactly why the panel test can assert both halves.
// 5.20.0: the payload is a STORAGE scan — rows carry their file lists, the
// detail view renders SKILL.md plus a clickable file tree (scripts/...).
const skillMem = render({ kind: 'zone', zone: 'skills', tab: 'memory' });
ok(count(skillMem, 'data-dmo="skill-tab"') === 2, 'the library offers two toggle tabs');
ok(skillMem.includes('结晶技能 2') && skillMem.includes('系统技能 1'), 'tabs carry per-side counts');
ok(skillMem.includes('分离延迟重启') && skillMem.includes('草稿技能'), 'memory tab lists every lifecycle state');
ok(skillMem.includes('已发布宿主'), 'a published skill carries its publish badge');
ok(skillMem.includes('active') && skillMem.includes('candidate'), 'lifecycle statuses render');
ok(skillMem.includes('global') && skillMem.includes('project:demo'), 'scope renders, project keeps its key');
ok(!skillMem.includes('skill-creator'), 'the memory tab does not leak host rows');
const skillHost = render({ kind: 'zone', zone: 'skills', tab: 'host' });
ok(skillHost.includes('skill-creator') && skillHost.includes('user-dsh'), 'host tab lists stored bundles with their root source');
ok(skillHost.includes('3 文件'), 'a bundle row shows its stored file count');
ok(!skillHost.includes('分离延迟重启'), 'the host tab does not leak memory rows');
ok(count(skillHost, 'data-dmo="skill-row"') === 1, `host tab rows == host payload length (${count(skillHost, 'data-dmo="skill-row"')})`);
// The detail view renders the STORED SKILL.md and the bundle's file tree; each
// stored file is one click away (a name + a relative file, never a client path).
const hostRead = render({ kind: 'hostskill', name: 'skill-creator' });
ok(hostRead.includes('先看 provider 契约') && hostRead.includes('存储内容 · 只读'), 'the stored SKILL.md renders, read-only');
ok(hostRead.includes('文件 3') && hostRead.includes('scripts/init_skill.py') && hostRead.includes('scripts/quick_validate.py'), 'the bundle file tree is listed (SKILL.md + scripts)');
const hostFile = render({ kind: 'hostskill', name: 'skill-creator', file: 'scripts/quick_validate.py' });
ok(hostFile.includes('#!/usr/bin/env python3'), 'a stored resource file renders its raw text');
ok(hostFile.includes('scripts/quick_validate.py'), 'the file view titles the selected resource');
// Lifecycle controls on the crystallized side (5.21.0): an enable switch per
// row (state reflects the lifecycle) and a delete button — the host side has
// none (bundles are managed in their own repos).
ok(count(skillMem, 'data-dmo="skill-toggle"') === 2, 'every crystallized row carries an enable switch');
// The shim's serializer does not carry aria-*, so switch state is asserted via
// the class the renderer derives it from: exactly one switch is ON (active),
// the other stays default (candidate).
ok(count(skillMem, 'dmo-switch on') === 1, 'exactly one switch renders ON (the active skill)');
ok(count(skillMem, 'title="停用（retire）"') === 1 && count(skillMem, 'title="启用（activate）"') === 1, 'switch titles reflect each row\'s lifecycle');
ok(count(skillMem, 'data-dmo="skill-delete"') === 2, 'every crystallized row carries a delete button');
ok(count(skillHost, 'data-dmo="skill-toggle"') === 0 && count(skillHost, 'data-dmo="skill-delete"') === 0, 'host rows carry no lifecycle controls');
// The crystallized detail view mirrors the host one: stored body + file list.
const memRead = render({ kind: 'memskill', name: '分离延迟重启' });
ok(memRead.includes('程序体在宿主目录包。') && memRead.includes('存储内容 · 只读'), 'the crystallized detail renders its stored content');
ok(memRead.includes('文件 1') && memRead.includes('分离延迟重启.md'), 'the crystallized detail lists its own file');
ok(hostRead.includes('返回技能库'), 'the detail view offers the way back');

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
ok(count(idxRead, 'dmo-idx-row') === 4, `index renders 4 clickable navigation rows (${count(idxRead, 'dmo-idx-row')})`);
ok(idxRead.includes('alpha 已稳定') && idxRead.includes('gamma 的思想内涵'), 'both index tables render');
// A theme slug with a space (「可观测性先于修 bug」) is a legal filename: its
// link must render as a button, not degrade to raw `[text](href)` text —
// the old [^)\s] href pattern made the path appear twice and read as a dupe.
ok(idxRead.includes('带空格的主题名也必须渲染成链接。'), 'spaced theme row renders its summary');
ok(count(idxRead, 'title="insights/可观测性先于修 bug.md"') >= 1, 'spaced theme link renders as a button (not raw markdown)');
ok(!/\[insights\/[^\]]*\]\(insights\//.test(idxRead), 'no raw markdown link survives inside the index tables');
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
ok(count(searchView, 'data-dmo="search-zone"') === 7, `search offers a zone filter (${count(searchView, 'data-dmo="search-zone"')} chips)`);
ok(searchView.includes('技能'), 'the search zone chips include the skills zone');
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
// 5.15.0 dropped the link column, so a row is now name+summary (2 cells) — the
// nav panel must not skip those (the old 3-cell floor silently dropped them).
const mixed = [
	'## 功能模块索引（functions/）',
	'',
	'| 功能域 | 一句话状态 / 待验证 |',
	'|---|---|',
	'| [新版行](functions/新版行.md) | 两列的当前形态。 |',
	'| 旧版行 | 四列的历史形态。 | [functions/旧版行.md](functions/旧版行.md) |',
].join('\n');
const mixedTables = T.parseIndexTables(mixed);
ok(mixedTables.functions['新版行']?.summary === '两列的当前形态。' && mixedTables.functions['新版行']?.href === 'functions/新版行.md', 'parseIndexTables reads 2-column rows');
ok(mixedTables.functions['旧版行']?.href === 'functions/旧版行.md', 'parseIndexTables still reads legacy 4-column rows');
ok(T.parseIndexTables('| [孤儿](functions/孤儿.md) | 没有标题的行 |').functions['孤儿'] === undefined, 'rows outside a table heading are ignored');
const split = T.splitSections(fnText);
ok(split.sections.length === 4 && split.sections[3].date === '2026-10-18', 'splitSections extracts dated blocks');
ok(split.preamble.includes('当前状态摘要'), 'splitSections keeps the head summary as preamble');
ok(T.defaultOpen('functions', split.sections, fnText)[0] === true && T.defaultOpen('functions', split.sections, fnText)[3] === false, 'fold policy opens the newest block only (reversed order: index 0 is newest)');
ok(T.defaultOpen('insights', split.sections, 'short')[0] === true, 'fold policy opens everything in short files');
const idxSections = T.splitSections(indexText).sections;
// With the skills table added, sections are: 功能 / 思想 / 技能 / 环境常量 / 细节指针 —
// the three tables open, the prose sections fold.
const idxOpen = T.defaultOpen('index', idxSections, indexText);
ok(idxOpen[0] === true && idxOpen[2] === true && idxOpen[3] === false, 'index opens the tables and folds the rest');
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