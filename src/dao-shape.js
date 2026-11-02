/**
 * 道体的**结构契约** —— 道文件正文该由哪些节组成，每节是什么性质。
 *
 * ## 为什么需要它（2026-11-02 用户："不仅仅是修正结论，要完善机制才能治本"）
 *
 * 此前「三种形态 / 推理用法 / 依据展开 / 边界」只写在 `memory_dao` 的
 * **参数说明文字**里 —— 代码里零实现。后果可测：
 *
 * ```
 * 命题（道）      —— 世界是怎样的        ✅ 闸门检查
 * 三种形态（道）  —— 世界的结构分类      ❌ 无人检查
 * 推理用法（法/术）—— 遇到 X 先问 Y      ❌ 无人检查（且越层）
 * 依据展开（法）  —— 各条法说了什么      ❌ 无人检查（且退化成清单）
 * 边界（道）      —— 何时不成立          ✅ 新加
 * ```
 *
 * 于是一份"正文里塞满操作步骤"的道，闸门照样放行 —— 因为它只读命题那一句。
 * 写进文档的约束等于没有约束（本模块文件头早就写过这句，这次轮到道体）。
 *
 * ## 契约
 *
 * 道体**必须**含这几节，且性质各异：
 *
 * | 节 | 性质 | 判据 |
 * |---|---|---|
 * | 命题 | 描述 | 无具体标记、非操作手册（已有） |
 * | 三种形态 / 结构 | 描述 | 不得出现规范性动词 |
 * | 依据展开 | 推演 | 必须真的**推演**（多个法如何共同逼出命题），不是逐条复述 |
 * | 边界 | 描述（负向） | 必须有反面（已有） |
 *
 * **允许**一节"如何用它"（`推理用法`/`怎么用`），但它必须：
 * ① 明确标为派生（"由此推出"之类），② 不得是唯一内容 —— 道不能只剩操作指南。
 *
 * ## 与共识区的分工
 *
 * 道描述世界；"必须怎么做"属于 MEMORY.md 共识区。所以正文里的规范性动词
 * 只允许出现在**标注为派生**的那一节，其余节出现即判越层。
 *
 * @module src/dao-shape
 */

/** 描述性节（世界是怎样的）—— 不得有规范性动词。 */
export const DESCRIPTIVE_HEADINGS = ['三种形态', '结构', '形态', '表现', '机制'];

/** 推演节 —— 必须真的在推演，不是复述。 */
export const DERIVATION_HEADINGS = ['依据展开', '推演', '为什么成立', '论证'];

/** 派生节（允许有规范性动词，但必须标为派生）—— 不是道的本体。 */
export const DERIVED_HEADINGS = ['推理用法', '怎么用', '使用方式', '推论'];

/** 规范性动词（出现即说明这段在说"该怎么做"）。 */
const NORMATIVE = /(必须|应当|应该|禁止|不得|务必|只允许|先问|先做|由此推出|需要你|请)/gu;

/** 派生标记（说明这一节是从道推出来的，不是道本身）。 */
const DERIVED_MARK = /(由此推出|据此|于是|所以|可用于|用来|应用时)/u;

/**
 * 把道文件正文切成节。
 *
 * @param content 道文件全文。
 * @returns `{ heading, body }[]`（不含标题行本身）。
 */
export function daoBodySections(content) {
	const lines = String(content ?? '').split('\n');
	const sections = [];
	let current = null;
	for (const line of lines) {
		if (/^##\s+/u.test(line)) {
			current = { heading: line.replace(/^#+\s*/u, '').trim(), body: [] };
			sections.push(current);
			continue;
		}
		if (current !== null) current.body.push(line);
	}
	return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}

/**
 * 检查道体结构是否符合"道"的定义。
 *
 * @param content 道文件全文。
 * @returns `{ findings, notes }`；findings 为 `{ code, message }`。
 */
export function checkDaoBody(content) {
	const findings = [];
	const notes = [];
	const fail = (code, message) => findings.push({ code, message });
	const note = (code, message) => notes.push({ code, message });

	const sections = daoBodySections(content);
	const byKind = (headings) => sections.filter((s) => headings.some((h) => s.heading.includes(h)));

	// —— 1. 必须有描述性节：道要描述世界的结构，不能只有命题一句 ——
	const descriptive = byKind(DESCRIPTIVE_HEADINGS);
	if (descriptive.length === 0) {
		fail(
			'dao-no-structure',
			'缺描述性节（如「## 三种形态」）：道要说清"世界长什么样"，只有一句命题不足以让人照着辨认',
		);
	}
	// 描述性节不得夹带规范
	for (const s of descriptive) {
		const hits = [...s.body.matchAll(NORMATIVE)].map((m) => m[1]);
		if (hits.length > 0) {
			fail(
				'dao-descriptive-prescriptive',
				`「${s.heading}」是描述性节，却出现规范性动词（${[...new Set(hits)].join('、')}）：` +
					'道描述世界，不规定动作 —— 该怎么做属共识区或法层',
			);
		}
	}

	// —— 2. 必须有推演节，且不能是"逐条复述" ——
	const derivation = byKind(DERIVATION_HEADINGS);
	if (derivation.length === 0) {
		fail(
			'dao-no-derivation',
			'缺推演节（如「## 依据展开」）：道要说明"这几条法如何共同逼出这个命题"，否则读者只能信或不信',
		);
	}
	for (const s of derivation) {
		const items = s.body.split('\n').filter((l) => l.trim().startsWith('-') || l.trim().startsWith('*'));
		// 逐条复述的特征：条目数 == 来源法数，且每条只说了单条法
		const looksLikeList = items.length >= 5 && !DERIVED_MARK.test(s.body) && !/(共同|都指向|合起来|同构|因此|所以)/u.test(s.body);
		if (looksLikeList) {
			fail(
				'dao-derivation-is-list',
				`「${s.heading}」看起来是**逐条复述**（${items.length} 条列表，无推演连接词）：` +
					'推演要说明这些法如何**共同**指向命题，不是把它们各说一遍',
			);
		}
	}

	// —— 3. 派生节可以有，但必须标为派生 ——
	const derived = byKind(DERIVED_HEADINGS);
	for (const s of derived) {
		if (!DERIVED_MARK.test(s.body)) {
			note(
				'dao-derived-unmarked',
				`「${s.heading}」是派生用法，建议明确写成"由此推出……"：让人分得清哪句是道、哪句是从道推出来的`,
			);
		}
	}
	// 只剩派生节、没有描述节 —— 已在 1 拦住；这里补一条更强的：道不能全是操作
	if (derived.length > 0 && descriptive.length === 0 && derivation.length === 0) {
		fail(
			'dao-only-procedure',
			'道文件只有"怎么用"，没有"世界是怎样的"：那是操作手册，不是道',
		);
	}

	return { findings, notes };
}