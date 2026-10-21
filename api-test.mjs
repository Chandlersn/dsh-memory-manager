/**
 * API-route test: drives the panel HTTP handlers with stub req/res objects
 * against the plugin's real (global) memory root.
 *
 * The handlers resolve the memory root server-side, so a client-supplied
 * `?path=` must have no effect — that is one of the assertions below.
 *
 * Requires the Host installation (for `defineTool`): set DSH_INSTALL_DIR when
 * the harness install is not discoverable from this process (see README).
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';

const mod = await import(new URL('./server.js', import.meta.url).href);

let routeHandler = null;
const noop = () => {};
const fakeCtx = {
	tools: { register: () => noop },
	on: () => noop,
	inject(names, fn) {
		fn({
			webServer: {
				register(route) {
					if (route.path === '/api/memory-org') routeHandler = route.handler;
					return noop;
				},
			},
			// cordis scoped context = services + effect; effect(fn) runs immediately here.
			effect: (f) => f(),
		});
	},
	systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
};
mod.apply(fakeCtx, {});
if (!routeHandler) throw new Error('route was not registered');

const root = mod.resolveRoot({});
const pluginDir = path.dirname(fileURLToPath(import.meta.url));

async function call(pathname) {
	const url = new URL(pathname, 'http://localhost');
	const req = { url: url.pathname + url.search };
	let captured;
	const res = {
		writeHead(status) {
			captured = { status };
		},
		end(body) {
			captured.body = body;
		},
	};
	await routeHandler(req, res);
	return captured;
}

// POST with a JSON body (the panel's write channel). The stub req is an async
// iterable of one Buffer, mirroring Node's request stream closely enough.
async function post(pathname, body) {
	const url = new URL(pathname, 'http://localhost');
	const payload = Buffer.from(JSON.stringify(body), 'utf8');
	const req = { method: 'POST', url: url.pathname + url.search, async *[Symbol.asyncIterator]() { yield payload; } };
	let captured;
	const res = {
		writeHead(status) {
			captured = { status };
		},
		end(b) {
			captured.body = b;
		},
	};
	await routeHandler(req, res);
	return captured;
}

let failures = 0;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
};
const encoded = encodeURIComponent;

console.log(`memory root: ${root}`);

const info = await call('/api/memory-org');
ok(info.status === 200 && String(info.body).includes('memory-manager'), 'index info page');

// --- memory root is server-resolved -----------------------------------------
const missingName = await call('/api/memory-org/file');
ok(missingName.status === 400, 'missing name rejected');

const foreignRead = await call(`/api/memory-org/file?path=${encoded(pluginDir)}&name=README.md`);
ok(foreignRead.status !== 200, `client ?path= cannot widen the root (${foreignRead.status})`);

for (const [url, label] of [
	['/api/memory-org/file?zone=../../etc&name=MEMORY.md', 'file zone traversal'],
	['/api/memory-org/list?zone=../../etc', 'list zone traversal'],
	['/api/memory-org/list?zone=legacy', 'unknown zone'],
]) {
	const r = await call(url);
	ok(r.status === 400, `${label} rejected (${r.status})`);
}

const traversal = await call('/api/memory-org/file?name=..%2F..%2FMEMORY.md');
ok(traversal.status === 400, `separator in name rejected (${traversal.status})`);

// --- health / listing --------------------------------------------------------
const real = await call('/api/memory-org/check');
ok(real.status === 200 && JSON.parse(real.body).root === root, 'check on the global memory root');
const parsed = JSON.parse(real.body);
console.log(`    check: initialized=${parsed.initialized} FAIL=${parsed.failCount} WARN=${parsed.warnCount}`);

const list = await call('/api/memory-org/list?zone=functions');
ok(list.status === 200 && Array.isArray(JSON.parse(list.body).files), 'zone listing');

// Daily zone must expose ONLY decision threads — the index (MEMORY.md) belongs
// to its own section and must never show up under 每日.
const daily = await call('/api/memory-org/list?zone=daily');
ok(daily.status === 200, 'daily listing 200');
const dailyFiles = JSON.parse(daily.body).files.map((f) => f.name);
ok(dailyFiles.every((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)), `daily listing holds only dated threads (${dailyFiles.join(', ') || 'empty'})`);
ok(!dailyFiles.includes('MEMORY.md'), 'MEMORY.md excluded from daily zone');
const dailyFile = await call('/api/memory-org/file?zone=daily&name=MEMORY.md');
ok(dailyFile.status === 400, `daily zone refuses the index file (${dailyFile.status})`);

const file = await call('/api/memory-org/file?name=MEMORY.md');
ok(file.status === 200 || file.status === 404, `read MEMORY.md (${file.status})`);
if (file.status === 200) ok(JSON.parse(file.body).text.includes('记忆管理'), 'MEMORY.md content');
else console.log('    （全局根尚未建档——正常，等首次 memory_write 建立）');

// --- skill library (5.24.0: ONE storage — host bundles) ----------------------
// Skills live only as bundles under <dshHome>/skills/<kebab>/SKILL.md. The two
// groups are a VIEW of that one store: `agent_created` bundles are ours
// (结晶技能), everything else is an installed skill (系统技能).
const skillLib = await call('/api/memory-org/skills');
ok(skillLib.status === 200, `/skills answers 200 (${skillLib.status})`);
const sl = JSON.parse(skillLib.body);
ok(Array.isArray(sl.memory) && Array.isArray(sl.host), 'skills payload splits crystallized + system groups');
ok(!('hostDegraded' in sl), 'no hostDegraded field: a missing root just means no bundles there');
const sepRow = (sl.memory ?? []).find((s) => s.name === 'detached-restart');
ok(!!sepRow, 'our crystallized bundle appears in the crystallized group');
if (sepRow) {
	const SK = ['name', 'status', 'scope', 'description', 'kind', 'files'];
	const missSK = SK.filter((k) => !(k in sepRow));
	ok(missSK.length === 0, `crystallized row carries its panel fields (missing: ${missSK.join(',') || 'none'})`);
	ok(sepRow.kind === 'memory' && Array.isArray(sepRow.files) && sepRow.files.some((f) => f.rel === 'SKILL.md'), 'a crystallized skill is a bundle with SKILL.md');
	ok(sepRow.files.some((f) => f.rel === 'scripts/restart-relay.mjs'), 'the bundle file tree carries its scripts');
}
// Host rows are STORAGE bundles: dir bundles with their real file trees.
const scRow = (sl.host ?? []).find((s) => s.name === 'skill-creator');
ok(!!scRow && scRow.kind === 'host', 'the installed skill-creator bundle is listed as a system skill');
if (scRow) {
	ok(scRow.source === 'user-dsh', `host row carries its root source (${scRow.source})`);
	ok(Array.isArray(scRow.files) && scRow.files.some((f) => f.rel === 'SKILL.md') && scRow.files.some((f) => f.rel === 'scripts/quick_validate.py'), `bundle file tree includes SKILL.md + scripts (${scRow.files.length} files)`);
	// Runtime artifacts are not skill assets: this machine really has a
	// __pycache__ inside that bundle (the validator was run), so the LIVE
	// answer — not a fixture — proves the filter.
	ok(!scRow.files.some((f) => /(^|\/)__pycache__\//.test(f.rel) || f.name.endsWith('.pyc')), 'the file tree excludes __pycache__ runtime artifacts');
	ok(!scRow.files.some((f) => /(^|\/)node_modules\//.test(f.rel)), 'the file tree excludes node_modules');
}
// /skill reads a STORED main file; kind picks the root; traversal is a 400.
const memBody = await call(`/api/memory-org/skill?name=detached-restart`);
ok(memBody.status === 200 && JSON.parse(memBody.body).text.includes('Procedure'), 'crystallized skill body reads from its bundle');
ok(JSON.parse(memBody.body).kind === 'memory', 'an agent_created bundle reports kind=memory');
const badName = await call(`/api/memory-org/skill?name=${encoded('../server')}`);
ok(badName.status === 400, 'skill route rejects traversal in the name');
const missHost = await call('/api/memory-org/skill?name=ghost-skill');
ok(missHost.status === 404, 'an unknown bundle is 404');
// /skillfile reads a stored RESOURCE inside a bundle; rel paths are validated
// (no .., no backslash) and resolved server-side from the root.
const pyFile = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('scripts/quick_validate.py')}`);
ok(pyFile.status === 200 && JSON.parse(pyFile.body).text.includes('validate_skill'), 'a stored resource file reads through /skillfile');
const badRel = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('../quick_validate.py')}`);
ok(badRel.status === 400, 'skillfile rejects .. in the relative path');
const badRel2 = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('scripts\\x.py')}`);
ok(badRel2.status === 400, 'skillfile rejects backslashes in the relative path');
// --- panel write channel (5.21.0) --------------------------------------------
// The only mutating route. It runs the memory_skill tool's real executor, so
// the same guards hold; crystallize is deliberately NOT reachable here.
// These assertions use a THROWAWAY bundle and never touch the user's real
// skills: the earlier version retired/activated/deleted a live skill, which is
// exactly the kind of side effect a test must not have.
const getOnly = await call('/api/memory-org/skill-action');
ok(getOnly.status === 405, 'skill-action is POST-only');
const badAct = await post('/api/memory-org/skill-action', { action: 'crystallize', name: 'x' });
ok(badAct.status === 400, 'crystallize is not reachable from the panel (model judgement)');
const noName = await post('/api/memory-org/skill-action', { action: 'activate' });
ok(noName.status === 400, 'a missing name is rejected');
const badSlug = await post('/api/memory-org/skill-action', { action: 'activate', name: 'Bad_Name' });
ok(badSlug.status === 400, 'a non-kebab name is rejected (it is a bundle dir name)');
// A real lifecycle round trip, on a bundle this test plants and removes itself.
const probe = 'api-probe-skill';
// The host user skill root (where bundles live now) — the SAME helper the
// plugin uses, so the test and the running code agree on the location.
const { dshHome } = await import(new URL('./src/util.js', import.meta.url).href);
const probeDir = path.join(dshHome(), 'skills', probe);
await mkdir(probeDir, { recursive: true });
await writeFile(
	path.join(probeDir, 'SKILL.md'),
	`---\nname: ${probe}\ndescription: "当面板写通道回归时使用本技能：临时探针"\nagent_created: true\nscope: global\nstatus: active\n---\n\n# ${probe}\n\n## 何时使用\n\n- x\n\n## 调用步骤\n\n1. a\n2. b\n`,
	'utf8',
);
try {
	const ret = await post('/api/memory-org/skill-action', { action: 'retire', name: probe });
	ok(ret.status === 200 && JSON.parse(ret.body).status === 'retired', 'panel retire returns the new status');
	const afterRet = JSON.parse((await call('/api/memory-org/skills')).body).memory.find((s) => s.name === probe);
	ok(afterRet.status === 'retired', 'a retired bundle reports its new lifecycle');
	const act = await post('/api/memory-org/skill-action', { action: 'activate', name: probe });
	ok(act.status === 200 && JSON.parse(act.body).status === 'active', 'panel activate restores it');
	const afterAct = JSON.parse((await call('/api/memory-org/skills')).body).memory.find((s) => s.name === probe);
	ok(afterAct.status === 'active', 'reactivated bundle reports active again');
	const del = await post('/api/memory-org/skill-action', { action: 'delete', name: probe });
	ok(del.status === 200, 'panel delete succeeds');
	const fileGone = await stat(path.join(probeDir, 'SKILL.md')).then(() => false, () => true);
	ok(fileGone, 'the bundle file is gone');
	const idxText = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
	ok(!idxText.includes(probe), 'MEMORY.md carries no dangling row for the deleted skill');
} finally {
	await rm(probeDir, { recursive: true, force: true });
}
const delMissing = await post('/api/memory-org/skill-action', { action: 'delete', name: 'no-such-skill-xyz' });
ok(delMissing.status === 400, 'deleting a missing skill is a 400, not a 500');
// hot reload (5.25.0): POST-only, and a host WITHOUT loader/registry degrades
// to 501 with a message — this file's fakeCtx IS exactly such a host (the
// legacy-generation branch, tested with the legacy artifact per the rule).
const reloadGet = await call('/api/memory-org/reload');
ok(reloadGet.status === 405, 'reload is POST-only');
const reloadNoLoader = await post('/api/memory-org/reload', {});
ok(reloadNoLoader.status === 501 && JSON.parse(reloadNoLoader.body).error.includes('不支持热重启'), 'a host without loader/registry answers 501, never half-swaps');
// The real loader branch end-to-end: an apply() WITH loader/registry must get a
// reload that actually re-imports. A live host is not available here, so the
// loader is faked with the two primitives the swap really uses (internal.load
// Cache + import/unwrapExports) and a fiber-shaped ctx; the assertion is that
// the fresh module object arrives (cache purge → re-evaluation), not a 501.
{
	const { selfReload } = await import(new URL('./src/reload.js', import.meta.url).href);
	const pkgUrl = new URL('./', import.meta.url).href;
	const entry = new URL('./server.js', import.meta.url).href;
	const { pathToFileURL } = await import('node:url');
	// Seed Node's ESM loadCache shape with THIS package's real module URLs, so the
	// purge has genuine keys to remove (what a loaded plugin looks like).
	const cache = new Map();
	for (const f of ['server.js', 'src/reload.js']) {
		cache.set(new URL(`./${f}`, import.meta.url).href, { id: f });
	}
	const oldApply = () => {};
	const newApply = () => {};
	const importLog = [];
	const loader = {
		internal: { loadCache: cache },
		async import(url) {
			importLog.push(url);
			// unwrapExports in the real host turns the namespace into the exports
			// object; a plugin entry exports apply().
			return { apply: newApply };
		},
		unwrapExports: (m) => m,
	};
	const newFiber = { uid: 'f2', await: async () => {} };
	const oldFiber = {
		uid: 'f1',
		await: async () => {},
		inject: {},
		entry: undefined,
		_config: {},
		parent: { registry: { plugin: () => ({ ctx: { fiber: newFiber } }) } },
	};
	const registry = {
		get: (p) => (p === oldApply ? { fibers: [oldFiber], name: 'dsh-memory-manager', Config: undefined } : undefined),
		delete: () => true,
	};
	const res = await selfReload({ loader, registry, fiber: { ...oldFiber, runtime: { callback: oldApply } } }, { packageUrl: pkgUrl, entryUrl: entry, logger: { info: () => {}, warn: () => {} } });
	ok(res.ok === true && res.fibers === 1, `selfReload completes against a loader-shaped host (ok=${res.ok}${res.error ? ' err=' + res.error : ''})`);
	ok(importLog.length >= 1 && importLog[0].includes('server.js'), 'the entry is re-imported through the host loader');
	ok(!cache.has(entry) || importLog[importLog.length - 1] !== entry, 'a purged cache did not silently serve the old module');
	// The failure path must ROLLBACK: an entry that throws on re-import restores
	// the caches and returns restored:true with the old code still in place.
	const cache2 = new Map([[entry, { id: 'server' }]]);
	const loader2 = { internal: { loadCache: cache2 }, async import() { throw new Error('boom'); }, unwrapExports: (m) => m };
	const failRes = await selfReload({ loader: loader2, registry: { get: () => ({ fibers: [oldFiber] }), delete: () => true }, fiber: { ...oldFiber, runtime: { callback: oldApply } } }, { packageUrl: pkgUrl, entryUrl: entry, logger: { info: () => {}, warn: () => {} } });
	ok(failRes.ok === false && failRes.restored === true && cache2.has(entry), 'a failed re-import restores the cache and reports the rollback');
}

// --- overview / counts -------------------------------------------------------
const idx = await call('/api/memory-org/overview');
ok(idx.status === 200 && Array.isArray(JSON.parse(idx.body)) && JSON.parse(idx.body).length === 1, 'overview returns a single global root');
const o = JSON.parse(idx.body)[0];
console.log(`    overview: title=${o.title} root=${o.root}`);
ok(o.root.endsWith('memory'), 'overview root is the global memory dir');
ok(o.counts && ['functions', 'insights', 'daily'].every((z) => Number.isInteger(o.counts[z])), `overview carries zone counts (${JSON.stringify(o.counts)})`);
if (o.counts) {
	const fnList = JSON.parse(list.body).files.length;
	ok(o.counts.functions === fnList, `functions count matches its listing (${o.counts.functions} vs ${fnList})`);
	ok(o.counts.daily === dailyFiles.length, `daily count matches its listing (${o.counts.daily} vs ${dailyFiles.length})`);
}

// --- search ------------------------------------------------------------------
const search = await call('/api/memory-org/search?q=' + encodeURIComponent('插件'));
ok(search.status === 200 && Array.isArray(JSON.parse(search.body).hits), 'search endpoint returns hits array');
console.log(`    search "插件": ${JSON.parse(search.body).hits.length} hits`);
const shortQ = await call('/api/memory-org/search?q=a');
ok(shortQ.status === 200 && JSON.parse(shortQ.body).hits.length === 0, 'sub-2-char query returns empty');

// --- recall preview (MemOS borrow ②) ---------------------------------------
// Same pipeline the pre-step hook runs, exposed for debugging: "what would this
// input recall, and why". Short queries must not error out (the panel calls it
// on every keystroke-ish interaction).
const prevShort = await call('/api/memory-org/recall-preview?q=a');
ok(prevShort.status === 200 && JSON.parse(prevShort.body).rows.length === 0, 'recall-preview tolerates a sub-2-char query');
const prev = await call('/api/memory-org/recall-preview?q=' + encodeURIComponent('记忆 插件'));
ok(prev.status === 200, `recall-preview 200 (${prev.status})`);
const pv = JSON.parse(prev.body);
ok(Array.isArray(pv.rows) && Array.isArray(pv.tokens), 'recall-preview returns rows + tokens');
console.log(`    recall-preview "记忆 插件": ${pv.rows.length} rows, ${pv.usageSignals ?? 0} usage signals`);
// Contract the panel will read: each row explains itself (reasons) and carries
// the fused score, so ranking is inspectable instead of guessed at.
if (pv.rows.length) {
	const r0 = pv.rows[0];
	ok(typeof r0.href === 'string' && Array.isArray(r0.reasons), 'preview row carries href + reasons');
	ok(typeof r0.fusedScore === 'number', 'preview row carries its fused score');
} else {
	ok(true, 'preview row contract (no hits on this root — shape untested)');
}

// --- response contract the panel client reads --------------------------------
// The panel is a separate half that only sees these JSON shapes; a renamed field
// silently blanks a chip or a snippet (that is how "UI 和系统没匹配上" happens).
// Pin the exact keys both halves agreed on.
const OV_KEYS = ['initialized', 'failCount', 'warnCount', 'results', 'counts'];
const missingOv = OV_KEYS.filter((k) => !(k in o));
ok(missingOv.length === 0, `overview keeps the panel's fields (missing: ${missingOv.join(',') || 'none'})`);
ok(Array.isArray(o.results), 'health findings travel as `results` (not `problems`)');
if (o.results?.length) {
	const rk = ['level', 'rule', 'message'];
	const missR = rk.filter((k) => !(k in o.results[0]));
	ok(missR.length === 0, `each finding keeps level/rule/message (missing: ${missR.join(',') || 'none'})`);
} else console.log('    （当前无体检发现——契约键位仍已断言）');

const hit = JSON.parse(search.body).hits[0];
if (hit) {
	const HK = ['zone', 'name', 'line', 'heading', 'snippet'];
	const missH = HK.filter((k) => !(k in hit));
	ok(missH.length === 0, `search hits keep the panel's fields (missing: ${missH.join(',') || 'none'})`);
	ok(typeof hit.snippet === 'string' && !('text' in hit), 'hit text travels as `snippet` (not `text`)');
} else {
	const empty = await call('/api/memory-org/search?q=' + encodeURIComponent('记忆'));
	const h0 = JSON.parse(empty.body).hits[0];
	ok(!!h0 && ['zone', 'name', 'line', 'heading', 'snippet'].every((k) => k in h0), 'search hits keep zone/name/line/heading/snippet');
}
const listKeys = Object.keys(JSON.parse(list.body).files[0] ?? {});
ok(['name', 'bytes', 'mtime'].every((k) => listKeys.includes(k)), `listing files keep name/bytes/mtime (${listKeys.join(',')})`);
const fileKeys = Object.keys(JSON.parse(file.body));
ok(fileKeys.includes('name') && fileKeys.includes('text'), `file reads keep name/text (${fileKeys.join(',')})`);

console.log(failures === 0 ? 'API ALL PASS' : `${failures} API FAILURES`);
process.exit(failures === 0 ? 0 : 1);