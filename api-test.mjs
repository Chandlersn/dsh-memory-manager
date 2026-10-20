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
import { fileURLToPath } from 'node:url';

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

// --- skill library (5.20.0 storage scan) --------------------------------------
// The endpoint scans DISK (memory single-file skills + host bundle roots), NOT
// the registry — the panel shows what is stored; invocation policy stays the
// machine's surface. Two paths still covered: this fakeCtx has no skill
// service at all (irrelevant now — storage scan never touches the registry),
// and the real host roots on this machine carry real bundles.
const skillLib = await call('/api/memory-org/skills');
ok(skillLib.status === 200, `/skills answers 200 (${skillLib.status})`);
const sl = JSON.parse(skillLib.body);
ok(Array.isArray(sl.memory) && Array.isArray(sl.host), 'skills payload splits memory + host groups');
ok(!('hostDegraded' in sl), 'no hostDegraded field: a missing root just means no bundles there');
const sepRow = (sl.memory ?? []).find((s) => s.name === '分离延迟重启');
ok(!!sepRow, 'crystallized skill from the real root appears in the memory group');
if (sepRow) {
	const SK = ['name', 'status', 'published', 'scope', 'description', 'kind', 'files'];
	const missSK = SK.filter((k) => !(k in sepRow));
	ok(missSK.length === 0, `memory skill row carries its panel fields (missing: ${missSK.join(',') || 'none'})`);
	ok(sepRow.kind === 'memory' && Array.isArray(sepRow.files) && sepRow.files.length === 1, 'a memory skill stores exactly its own file');
}
// Host rows are STORAGE bundles: dir bundles with their real file trees.
const scRow = (sl.host ?? []).find((s) => s.name === 'skill-creator');
ok(!!scRow && scRow.kind === 'host', 'the installed skill-creator bundle is listed');
if (scRow) {
	ok(scRow.source === 'user-dsh', `host row carries its root source (${scRow.source})`);
	ok(Array.isArray(scRow.files) && scRow.files.some((f) => f.rel === 'SKILL.md') && scRow.files.some((f) => f.rel === 'scripts/quick_validate.py'), `bundle file tree includes SKILL.md + scripts (${scRow.files.length} files)`);
}
// /skill reads a STORED main file; kind picks the root; traversal is a 400.
const memBody = await call(`/api/memory-org/skill?name=${encoded('分离延迟重启')}&kind=memory`);
ok(memBody.status === 200 && JSON.parse(memBody.body).text.includes('程序体'), 'memory skill body reads from storage');
const badName = await call(`/api/memory-org/skill?name=${encoded('../server')}`);
ok(badName.status === 400, 'skill route rejects traversal in the name');
const missHost = await call('/api/memory-org/skill?name=ghost-skill&kind=host');
ok(missHost.status === 404, 'an unknown host bundle is 404');
// /skillfile reads a stored RESOURCE inside a host bundle; rel paths are
// validated (no .., no backslash) and resolved server-side from the root.
const pyFile = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('scripts/quick_validate.py')}`);
ok(pyFile.status === 200 && JSON.parse(pyFile.body).text.includes('validate_skill'), 'a stored resource file reads through /skillfile');
const badRel = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('../quick_validate.py')}`);
ok(badRel.status === 400, 'skillfile rejects .. in the relative path');
const badRel2 = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('scripts\\x.py')}`);
ok(badRel2.status === 400, 'skillfile rejects backslashes in the relative path');

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