/**
 * 层级准入闸门测试（node 直跑，与本仓库其他测试同一风格）。
 *
 * 用户 2026-10-27 的要求：「各层级之间的萃取或者结晶，要形成固定的函数调用
 * 机制，把条件包含和描述包含在其中，而非仅靠语义和提示词的文字描述来成型。」
 *
 * 所以重点不是「通过的路径」，而是**拒绝的路径**：
 * 每条硬条件都要证明它真的会挡住，并且说清缺什么。
 * 一个只警告不阻止的闸门，等于没有闸门。
 */
import {
	MIN_DAO_SOURCES,
	MAX_DAO_ENTRIES,
	MIN_FA_SOURCES,
	gateDao,
	gateFa,
	concreteMarkersOf,
	looksLikeProcedure,
	extractableClusters,
} from '../src/layer-gate.js';

let failures = 0;
function ok(cond, label) {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
}

/** 造一批合法的来源法名。 */
function laws(n = MIN_DAO_SOURCES) {
	return Array.from({ length: n }, (_, i) => `法${i + 1}`);
}

console.log('\n--- 道层：≥5 条法才允许萃取 ---');
ok(gateDao({ name: 'a', proposition: '失败多半不是做错，而是做不成却不告诉你', extractedFrom: laws() }).ok, `${MIN_DAO_SOURCES} 条法 → 通过`);
{
	const r = gateDao({ name: 'a', proposition: '失败多半不是做错，而是做不成却不告诉你', extractedFrom: laws(MIN_DAO_SOURCES - 1) });
	ok(!r.ok, `${MIN_DAO_SOURCES - 1} 条法 → 拒绝`);
	// 错误消息必须可操作：告诉模型差几条，否则它只会反复试错
	ok(r.reason.includes(`至少需要 ${MIN_DAO_SOURCES} 条`), '  拒绝理由点名阈值');
	ok(r.reason.includes('缺 1 条'), '  拒绝理由说清还缺几条');
	ok(r.reason.includes('单条抽取只是换了个说法'), '  拒绝理由解释了为什么');
}
ok(!gateDao({ name: 'a', proposition: '某抽象命题', extractedFrom: [] }).ok, '0 条法 → 拒绝');
ok(!gateDao({ name: 'a', proposition: '某抽象命题' }).ok, '未传 extractedFrom → 拒绝');

console.log('\n--- 道层：命题必须够抽象 ---');
{
	const r = gateDao({ name: 'a', proposition: 'cordis 的服务注册要显式', extractedFrom: laws() });
	ok(!r.ok, '含具体技术名 → 拒绝');
	ok(r.reason.includes('cordis'), '  拒绝理由点名命中了什么');
}
ok(!gateDao({ name: 'a', proposition: 'MEMORY.md 的索引要短', extractedFrom: laws() }).ok, '含具体文件名 → 拒绝');
ok(!gateDao({ name: 'a', proposition: '改 functions/ 里的块要留结论', extractedFrom: laws() }).ok, '含具体目录 → 拒绝');
ok(!gateDao({ name: 'a', proposition: 'clis 的探针只报增量', extractedFrom: laws() }).ok, '含项目名 → 拒绝');
for (const p of [
	'系统的失败多数不是做错了，而是做不成却不告诉你',
	'一个东西是否成立只能由它真正被使用时的那条路径回答',
	'矛盾的两面互为条件，单边求解必失败',
]) {
	ok(gateDao({ name: 'a', proposition: p, extractedFrom: laws() }).ok, `纯抽象命题通过：${p.slice(0, 12)}…`);
}
ok(concreteMarkersOf('工具与系统之间的边界').length === 0, 'concreteMarkersOf 不误伤中性词');
ok(concreteMarkersOf('cordis 服务').includes('cordis'), 'concreteMarkersOf 抓到技术名');

console.log('\n--- 道层：命题不能是操作手册 ---');
{
	const r = gateDao({ name: 'a', proposition: '第一步先测量，第二步再改参数', extractedFrom: laws() });
	ok(!r.ok, '含步骤句式 → 拒绝');
	ok(r.reason.includes('操作手册'), '  拒绝理由说明原因');
}
ok(!gateDao({ name: 'a', proposition: '先观察再动手然后复盘', extractedFrom: laws() }).ok, '含「先…再…然后」→ 拒绝');
ok(looksLikeProcedure('1. 打开文件') === true, 'looksLikeProcedure 认步骤');
ok(looksLikeProcedure('运行 `npm test`') === true, 'looksLikeProcedure 认命令行');
ok(looksLikeProcedure('失败时不发声比发声更危险') === false, 'looksLikeProcedure 不误伤抽象句');

console.log('\n--- 道层：数量上限 7 ---');
{
	const r = gateDao({ name: 'a', proposition: '某抽象命题', extractedFrom: laws(), existing: MAX_DAO_ENTRIES });
	ok(!r.ok, `已有 ${MAX_DAO_ENTRIES} 条 → 拒绝`);
	ok(r.reason.includes(`上限 ${MAX_DAO_ENTRIES}`), '  拒绝理由点名上限');
	ok(r.reason.includes('道多了就不是道'), '  拒绝理由解释了为什么');
}
ok(gateDao({ name: 'a', proposition: '某抽象命题', extractedFrom: laws(), existing: MAX_DAO_ENTRIES - 1 }).ok, '第 7 条仍允许');

console.log('\n--- 法层：单源合法但降级为专项 ---');
{
	const r = gateFa({ principle: '判据要落在真实路径上', sources: ['a', 'b'] });
	ok(r.ok && r.tier === '法', `${MIN_FA_SOURCES} 源 → 法`);
}
{
	const r = gateFa({ principle: '某条单域经验', sources: ['a'] });
	ok(r.ok && r.tier === '专项', '1 源 → 专项（不拒绝）');
	ok(r.warnings.join().includes('补第二个无关来源域'), '  明说怎么升格');
}
{
	const r = gateFa({ principle: '无来源的原则', sources: [] });
	ok(!r.ok, '0 源 → 拒绝');
	ok(r.reason.includes('回链'), '  拒绝理由点明回链是唯一证据');
}
ok(gateFa({ principle: 'p', sources: ['a', 'a'] }).tier === '专项', '重复来源去重后只算一个');
{
	const r = gateFa({ principle: '1. 先跑测试 2. 再提交', sources: ['a', 'b'] });
	ok(r.ok && r.warnings.join().includes('操作手册'), '操作手册句式 → 法层警告（不拒绝）');
}

console.log('\n--- 可萃取簇：系统主动提示"该萃道了" ---');
{
	const c = extractableClusters(laws(6).map((s) => ({ slug: s, tags: ['静默失效'] })));
	ok(c.length === 1 && c[0].count === 6, '≥5 条法共享标签 → 提名');
}
ok(extractableClusters(laws(4).map((s) => ({ slug: s, tags: ['x'] }))).length === 0, '<5 条 → 不提名');
{
	const c = extractableClusters([
		...laws(5).map((s) => ({ slug: `a${s}`, tags: ['小簇'] })),
		...laws(8).map((s) => ({ slug: `b${s}`, tags: ['大簇'] })),
	]);
	ok(c[0].tag === '大簇' && c[1].tag === '小簇', '多簇按成员数降序');
}
ok(extractableClusters([{ slug: 'x' }, { slug: 'y', tags: [] }]).length === 0, '无标签条目被忽略');

console.log(failures === 0 ? '\nlayer-gate: ALL PASS' : `\nlayer-gate: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
