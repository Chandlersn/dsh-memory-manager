/**
 * 层级自检测试（node 直跑，与本仓库其他测试同一风格）。
 *
 * 用户 2026-11-02 的要求：「每次蒸馏后，要检验蒸馏的结果是否符合它对应层级的
 * 定义，不符合就不要出随意结果。」
 *
 * 触发它的现场事故：`memory_dao` 回执说"道已沉淀"，体检 R24 却读出 **0 条来源法**。
 * 写入方按模板写、模板节在文件里、判据是 `split('## 来源法')[1]` —— 而正文里的
 * 「## 来源法逐条」把 `[1]` 抢走了。于是"我写了"与"写出的东西符合道的定义"
 * 被当成同一件事，这就是"随意结果"。
 *
 * 所以本套件重点同样是**拒绝的路径**：每条判据都要证明它真的会挡住，
 * 且挡住时说清缺什么。（与 layer-gate.test.js 同一取向：只警告不阻止 = 没有闸门。）
 */
import {
	checkArtifact,
	selfCheckLine,
	selfCheckWarnings,
	splitBlocks,
	BLOCK_MAX_CHARS,
	SUMMARY_MAX_CHARS,
} from '../src/layer-selfcheck.js';
import { daoSourceSlugs, daoSourceSection, daoReservedHeadingCollisions, DAO_SOURCE_HEADING } from '../src/layer-gate.js';

let failures = 0;
function ok(cond, label) {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
}
const has = (result, code) => result.findings.some((f) => f.code === code);

// ---------------------------------------------------------------------------
console.log('\n--- 术层：块只装结论，不搬过程 ---');

/** 造一个合法的功能域文件。 */
function fnFile(blocks = [{ date: '2026-11-02', summary: '一句话概括', keys: ['概括', '改动', '原因', '验证', '结果'] }]) {
	const body = blocks
		.map(
			(b) =>
				`## [${b.date}] 标题\n\n` +
				b.keys.map((k) => `- **${k}**：${k === '概括' ? b.summary : '内容'}`).join('\n'),
		)
		.join('\n\n');
	return `# 示例域迭代历程\n\n> 范围：示例。\n\n## 当前状态摘要（截至 2026-11-02）\n\n- 稳定在某个行为。\n\n---\n\n${body}\n`;
}

{
	const good = checkArtifact({ layer: '术', content: fnFile(), relPath: 'functions/x.md' });
	ok(good.ok, '合法文件 → 通过');
}
{
	const noHead = checkArtifact({ layer: '术', content: '## [2026-11-02] 标题\n\n- **概括**：a\n- **改动**：b\n- **原因**：c\n- **验证**：d\n- **结果**：e\n', relPath: 'functions/x.md' });
	ok(!noHead.ok && has(noHead, 'head-summary'), '缺「当前状态摘要」→ 拒绝');
}
{
	const longBody = 'x'.repeat(BLOCK_MAX_CHARS + 50);
	const long = checkArtifact({
		layer: '术',
		content: `## 当前状态摘要（截至 2026-11-02）\n\n- ok\n\n## [2026-11-02] 标题\n\n- **概括**：一句话\n- **改动**：b\n- **原因**：c\n- **验证**：d\n- **结果**：e\n\n${longBody}\n`,
		relPath: 'functions/x.md',
	});
	ok(!long.ok && has(long, 'block-overlong'), `块 > ${BLOCK_MAX_CHARS} 字 → 拒绝（过程流水该留会话）`);
}
{
	const missingKey = checkArtifact({
		layer: '术',
		content: '## 当前状态摘要（截至 2026-11-02）\n\n- ok\n\n## [2026-11-02] 标题\n\n- **概括**：一句话\n- **改动**：b\n- **原因**：c\n- **结果**：e\n',
		relPath: 'functions/x.md',
	});
	ok(missingKey.ok, '块缺 **验证** → **不失败**（API 允许可选；比体检更严的第二套判据才是病）');
	ok(missingKey.notes.some((n) => n.code === 'block-incomplete'), '  但要如实提示缺哪一节');
}
{
	const longSummary = checkArtifact({
		layer: '术',
		content: `## 当前状态摘要（截至 2026-11-02）\n\n- ok\n\n## [2026-11-02] 标题\n\n- **概括**：${'字'.repeat(SUMMARY_MAX_CHARS + 5)}\n- **改动**：b\n- **原因**：c\n- **验证**：d\n- **结果**：e\n`,
		relPath: 'functions/x.md',
	});
	ok(!longSummary.ok && has(longSummary, 'summary-overlong'), `概括 > ${SUMMARY_MAX_CHARS} 字 → 拒绝（索引行的原料）`);
}
ok(splitBlocks(fnFile()).length === 1, 'splitBlocks 认得 `## [YYYY-MM-DD]` 块头');

// ---------------------------------------------------------------------------
console.log('\n--- 法层：来源 ≥2 才算法；单源降级是"说明"不是"失败" ---');

const faFile = (srcCount, principle = '判据要先量分布再定，不先发明指标') =>
	[
		'# 某法',
		'',
		'> 性质：可重套的原则。',
		`> 来源：${Array.from({ length: srcCount }, (_, i) => `[functions/域${i + 1}.md](functions/域${i + 1}.md)`).join('、')}`,
		'',
		'## 核心原则',
		'',
		`- ${principle}`,
		'',
	].join('\n');

{
	ok(checkArtifact({ layer: '法', content: faFile(2), relPath: 'insights/x.md' }).ok, '双来源 → 通过');
}
{
	const single = checkArtifact({ layer: '法', content: faFile(1), relPath: 'insights/x.md' });
	ok(single.ok, '单来源 → **不失败**（「专项」是定义允许的落点）');
	ok(single.notes.some((n) => n.code === 'downgraded-special'), '  但必须说明它只是专项，不得作萃取来源');
	ok(selfCheckWarnings(single).length === 0, '  该说明**不进 warnings**（干净写入不产告警是既有契约），留在 selfCheck.notes');
}
{
	const noSrc = checkArtifact({ layer: '法', content: '# 某法\n\n## 核心原则\n\n- 判据先量分布\n', relPath: 'insights/x.md' });
	ok(!noSrc.ok && has(noSrc, 'no-source'), '缺「> 来源：」行 → 拒绝');
}
{
	const noPrinciple = checkArtifact({ layer: '法', content: '# 某法\n\n> 来源：[a](functions/a.md)、[b](functions/b.md)\n\n## 核心原则\n\n', relPath: 'insights/x.md' });
	ok(!noPrinciple.ok && has(noPrinciple, 'no-principle'), '只有「核心原则」标题、没有本体 → 拒绝');
}
{
	const procedure = checkArtifact({ layer: '法', content: faFile(2, '1. 先跑测试 2. 再提交'), relPath: 'insights/x.md' });
	ok(!procedure.ok && has(procedure, 'principle-is-procedure'), '原则写成步骤 → 拒绝（那是术）');
}

// ---------------------------------------------------------------------------
console.log('\n--- 道层：命题 + ≥5 条来源法；锚必须扛住正文撞前缀 ---');

const daoFile = (name = '某道', links = 5, extraHeading = '', proposition = '失败多半不是做错，而是做不成却不告诉你') =>
	[
		`# 道 · ${name}`,
		'',
		'> 性质：**道层**。',
		`> 萃取自 ${links} 条法。`,
		'',
		'## 命题',
		'',
		proposition,
		'',
		extraHeading,
		'',
		DAO_SOURCE_HEADING,
		'',
		Array.from({ length: links }, (_, i) => `- [法${i + 1}](../insights/法${i + 1}.md)`).join('\n'),
		'',
	].join('\n');

{
	ok(checkArtifact({ layer: '道', content: daoFile(), relPath: 'dao/x.md' }).ok, '命题 + 5 条来源法 → 通过');
}
{
	const short = checkArtifact({ layer: '道', content: daoFile('某道', 4), relPath: 'dao/x.md' });
	ok(!short.ok && has(short, 'source-section-unreadable'), '< 5 条来源法 → 拒绝');
}
{
	const noProp = checkArtifact({ layer: '道', content: '# 道 · 某道\n\n## 来源法\n\n- [a](../insights/a.md)\n', relPath: 'dao/x.md' });
	ok(!noProp.ok && has(noProp, 'no-proposition'), '缺「## 命题」正文 → 拒绝');
}
{
	const concrete = checkArtifact({ layer: '道', content: daoFile('某道', 5, '', '改了 package.json 里的字段后记得重启宿主进程'), relPath: 'dao/x.md' });
	ok(!concrete.ok && has(concrete, 'concrete-in-proposition'), '命题含具体标记 → 拒绝（那是法伪装成道）');
}

// 回归：正文带「## 来源法逐条」时，读取方必须仍读到模板追加的那一节（7 条）
{
	const collision = daoFile('绿灯不携带信息', 7, '## 来源法逐条\n\n- 法甲：a\n- 法乙：b\n');
	const result = checkArtifact({ layer: '道', content: collision, relPath: 'dao/x.md' });
	ok(result.ok, '正文带「## 来源法逐条」→ 自检仍通过（锚取整行精确匹配 + 最后一个）');
	ok(daoSourceSlugs(collision).length === 7, `  读到 ${daoSourceSlugs(collision).length} 条而非 0 条——这正是 2026-11-02 的那个 bug`);
	ok(daoSourceSection(collision).includes('../insights/法7.md'), '  取到的是模板追加的那一节');
}
{
	const onlyPrefix = '# 道 · x\n\n## 命题\n\na\n\n## 来源法逐条\n\n- [a](../insights/a.md)\n- [b](../insights/b.md)\n- [c](../insights/c.md)\n- [d](../insights/d.md)\n- [e](../insights/e.md)\n';
	ok(daoSourceSlugs(onlyPrefix).length === 0, '只有「## 来源法逐条」时读 0 条 → 自检会拒绝（登记依据必须用模板那一节）');
	ok(!checkArtifact({ layer: '道', content: onlyPrefix, relPath: 'dao/x.md' }).ok, '  该形态被判不合格');
}
{
	ok(daoReservedHeadingCollisions('## 来源法逐条\n\ntext').length === 1, '撞车检测认出「## 来源法逐条」');
	ok(daoReservedHeadingCollisions('## 来源法\n\ntext').length === 1, '撞车检测认出「## 来源法」整行');
	ok(daoReservedHeadingCollisions('## 依据展开\n\ntext').length === 0, '「## 依据展开」不撞车（这正是推荐改成的名字）');
}

// ---------------------------------------------------------------------------
console.log('\n--- 器层 / 技能层 ---');

{
	ok(checkArtifact({ layer: '器', content: '# 某工具\n\n## 调用方式\n\n- `tool --flag`\n', relPath: 'capabilities/x.md' }).ok, '器：有调用方式 → 通过');
	ok(!checkArtifact({ layer: '器', content: '# 某工具\n\n## 说明\n\ntext\n', relPath: 'capabilities/x.md' }).ok, '器：缺调用方式 → 拒绝（台账的价值就是下次不用摸索）');
	ok(!checkArtifact({ layer: '器', content: '# 某工具\n\n## 调用方式\n\n', relPath: 'capabilities/x.md' }).ok, '器：调用方式空节 → 拒绝');
}
{
	const fm = (name, desc, status) => `---\nname: ${name}\ndescription: ${desc}\nstatus: ${status}\n---\n\n# body\n`;
	ok(checkArtifact({ layer: '技能', content: fm('detached-restart', 'Restart the DSH host from inside a session.', 'active'), relPath: 'skills/x/SKILL.md' }).ok, '技能：规范 frontmatter → 通过');
	ok(!checkArtifact({ layer: '技能', content: fm('Detached_Restart', 'x', 'active'), relPath: 'skills/x/SKILL.md' }).ok, '技能：name 非 kebab-case → 拒绝（它同时是宿主目录名）');
	ok(!checkArtifact({ layer: '技能', content: fm('ok-name', 'x', 'pending'), relPath: 'skills/x/SKILL.md' }).ok, '技能：status 非法 → 拒绝');
	ok(!checkArtifact({ layer: '技能', content: '# 没有 frontmatter\n', relPath: 'skills/x/SKILL.md' }).ok, '技能：缺 frontmatter → 拒绝（宿主不会发现它）');
	ok(!checkArtifact({ layer: '技能', content: fm('ok-name', Array.from({ length: 90 }, () => 'w').join(' '), 'active'), relPath: 'skills/x/SKILL.md' }).ok, '技能：description > 80 词 → 拒绝（触发词会被截断）');
}
{
	const empty = checkArtifact({ layer: '道', content: '   ', relPath: 'dao/x.md' });
	ok(!empty.ok && has(empty, 'empty'), '空产物 → 拒绝（落盘失败不该被当成通过）');
}

// ---------------------------------------------------------------------------
console.log('\n--- 回执压行：未过必须带 ⛔ 且点名缺什么 ---');
{
	const bad = checkArtifact({ layer: '道', content: '# 道 · x\n\n## 命题\n\na\n', relPath: 'dao/x.md' });
	const lines = selfCheckWarnings(bad);
	ok(lines.length === 1 && lines[0].startsWith('⛔'), '未过 → 一条 ⛔ 告警');
	ok(lines[0].includes('来源法节读出'), '  告警点名具体缺项');
	ok(selfCheckLine(bad).includes('未过'), '  selfCheckLine 明说未过');
}

console.log(failures === 0 ? '\nlayer-selfcheck: ALL PASS' : `\nlayer-selfcheck: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);