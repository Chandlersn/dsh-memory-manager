/**
 * 层级自检 —— **萃取/结晶落盘后，立刻拿它对照该层自己的定义**。
 *
 * ## 为什么需要这一步（2026-11-02 用户要求）
 *
 * 用户原话：「每次蒸馏后，要检验蒸馏的结果是否符合它对应层级的定义，
 * 不符合就不要出随意结果。」
 *
 * 触发它的现场事故：`memory_dao` 回执说"道已沉淀"，而体检的 R24 读出
 * **0 条来源法**、报"道的依据不足"。两边都"没错"：写入方按模板写、模板
 * 追加的节在文件里；读取方的锚被正文撞了前缀。**写入方报的是"我写了"，
 * 不是"写出来的东西符合道的定义"** —— 这就是"随意结果"。
 *
 * ## 这一层与三件事的分工
 *
 * - `layer-gate.js` 管**准入**：写入*前*，输入的形状对不对（缺 5 条法就拒绝写）。
 * - 本模块管**落地**：写入*后*，**从磁盘读回来的产物**是否符合该层定义。
 * - `memory_check`（R14/R24 等）管**体检**：整个记忆根的长期健康，事后发现。
 *
 * 三者判据同源（都调 layer-gate 的纯函数），但**时机与对象不同**：
 * 准入看输入、自检看产物、体检看全局。只做准入会漏"写进去的东西读不出来"
 * 这一类；只做体检则要等到下一次体检，中间这段时间账是假的。
 *
 * ## 判据必须自外而内
 *
 * 自检**不采信写入方的内存中间态**，一律 `readFile` 回来的字节：
 * 能读出来才算数 —— 与 R24 读的是同一份字节、同一套锚。这正是
 * 「绿灯不携带信息」在工具层的落地：写者不能给自己的产物背书。
 *
 * 纯函数：输入 `{ layer, content, relPath }`，输出 `{ ok, layer, findings }`。
 * 不碰文件系统（读字节由调用方做），所以可穷举测试。
 */

import { concreteMarkersOf, looksLikeProcedure, daoSourceSlugs, MIN_DAO_SOURCES, MIN_FA_SOURCES } from './layer-gate.js';

/** 各层定义里的硬阈值（与体检 R14 同源，改一处要同时改体检）。 */
export const BLOCK_MAX_CHARS = 900;
export const SUMMARY_MAX_CHARS = 110;

/**
 * 层名（与记忆根目录一一对应）。
 *
 * - `术` = functions/ 迭代块：一个域"怎么做"的完整迭代史
 * - `法` = insights/ 跨域可重套原则（单源降级为「专项」，不算失败）
 * - `道` = dao/ 最抽象命题，≥5 条法萃取
 * - `器` = capabilities/ 外部能力台账（怎么调用、前提、踩过的坑）
 * - `技能` = skills/<name>/SKILL.md 可调用程序（宿主目录包）
 */
export const LAYERS = ['术', '法', '道', '器', '技能'];

/** 迭代块的必需小节（缺哪一项，这个块就说不清"发生了什么"）。 */
const BLOCK_KEYS = ['概括', '改动', '原因', '验证', '结果'];

/**
 * 把文本切成迭代块（`## [YYYY-MM-DD...]` 开头的节）。
 *
 * @param text 功能域文件全文。
 * @returns `{ heading, body }[]`。
 */
export function splitBlocks(text) {
	const lines = String(text ?? '').split('\n');
	const blocks = [];
	let current = null;
	for (const line of lines) {
		if (/^##\s+\[?\d{4}-\d{2}-\d{2}/u.test(line)) {
			current = { heading: line.replace(/^#+\s*/u, '').trim(), body: [] };
			blocks.push(current);
			continue;
		}
		if (current !== null) current.body.push(line);
	}
	return blocks.map((b) => ({ heading: b.heading, body: b.body.join('\n').trim() }));
}

/**
 * 检查一件刚落盘的产物是否符合它所在层的定义。
 *
 * @param input.layer 层名（`术`/`法`/`道`/`器`/`技能`）。
 * @param input.content 从磁盘读回的全文。
 * @param input.relPath 相对记忆根的路径（只用于报错定位）。
 * @returns `{ ok, layer, findings }`；findings 每项 `{ code, message }`。
 */
export function checkArtifact(input) {
	const layer = String(input.layer ?? '');
	const content = String(input.content ?? '');
	const relPath = String(input.relPath ?? '');
	const findings = [];
	const notes = [];
	const fail = (code, message) => findings.push({ code, message });
	const note = (code, message) => notes.push({ code, message });

	if (!content.trim()) fail('empty', `${relPath} 读回来是空的：落盘失败或路径不对`);

	if (layer === '术') {
		if (!/^##\s*当前状态摘要/mu.test(content)) {
			fail('head-summary', '缺「## 当前状态摘要」：没有它，文件头部说不清现在稳定在什么行为');
		}
		const blocks = splitBlocks(content);
		if (!blocks.length) fail('no-block', '没有任何迭代块（`## [YYYY-MM-DD]`）：功能域文件靠块记录"发生了什么"');
		for (const b of blocks) {
			if ([...b.body].length > BLOCK_MAX_CHARS) {
				fail('block-overlong', `块「${b.heading.slice(0, 24)}」${[...b.body].length} 字 > ${BLOCK_MAX_CHARS}：那是过程不是结论，压成动因/改动/判据/待观察`);
			}
			for (const key of BLOCK_KEYS) {
				if (!b.body.includes(`**${key}**`)) {
					// **不算失败**：`memory_write` 的 API 里 reason/change/verification
					// 是可选的，体检 R14 也只强制长度与概括。把"缺小节"升级成硬失败
					// 会造出比体检更严的第二套判据（同一件事两处实现 —— 这个记忆根
					// 反复吃亏的形态）。如实提示，让人自己决定补不补。
					note('block-incomplete', `块「${b.heading.slice(0, 24)}」缺 **${key}** —— 块要说清动因/改动/原因/验证/结果`);
					break;
				}
			}
			const summary = b.body.match(/\*\*概括\*\*[：:]\s*([^\n]+)/u)?.[1] ?? '';
			if (summary && [...summary].length > SUMMARY_MAX_CHARS) {
				fail('summary-overlong', `块「${b.heading.slice(0, 24)}」概括 ${[...summary].length} 字 > ${SUMMARY_MAX_CHARS}：概括是索引行的原料，超了会被体检打回`);
			}
		}
	}

	if (layer === '法') {
		const srcLine = content.match(/^>\s*来源[：:].*$/mu)?.[0] ?? '';
		if (!srcLine) {
			fail('no-source', '缺「> 来源：」行：回链是这条法唯一的证据，没有它降不成法');
		} else {
			// 计数必须**按来源域去重**：真实的 `> 来源：` 行里同一个域出现两次
			// （链接标签 + href），按出现次数会算成 2 个来源 —— 单源的专项会被
			// 误判成法。判据落在 slug 集合上，与 R24(d) 的认领统计同一口径。
			const slugs = [...srcLine.matchAll(/(?:\.\.\/)?functions\/([^/()\s、]+?)\.md/g)].map((m) => m[1]);
			const count = new Set(slugs).size;
			if (count === 0) fail('no-source-link', '「> 来源：」行里没有任何 functions/*.md 回链');
			else if (count < MIN_FA_SOURCES) {
				// 单源**不失败**：它落在「专项」是定义允许的落点。但要说清它
				// 不是普适原则 —— 否则下一步就会有人拿它去萃道、跨域引用。
				note('downgraded-special', `只有 ${count} 个来源域 → 它是「专项」不是「法」：不要跨域引用，也不得作为道的萃取来源`);
			}
		}
		const principle = content.match(/^##\s*核心原则\s*\n+\s*[-*]\s*([^\n]+)/mu)?.[1] ?? '';
		if (!principle) fail('no-principle', '缺「## 核心原则」的正文本体：只有标题没有内容等于没写');
		else if (looksLikeProcedure(principle)) {
			fail('principle-is-procedure', '核心原则是操作手册句式：能改写成步骤的是术，不是法');
		}
	}

	if (layer === '道') {
		const proposition = content.match(/##\s*命题\s*\n+\s*\n?([^\n]+)/u)?.[1] ?? '';
		if (!proposition) fail('no-proposition', '缺「## 命题」正文：道必须能用一句话说出来');
		else {
			const markers = concreteMarkersOf(proposition);
			if (markers.length) {
				fail('concrete-in-proposition', `命题含具体标记（${markers.slice(0, 3).join('、')}）：那是法伪装成道，换领域后应依然成立`);
			}
		}
		const slugs = daoSourceSlugs(content);
		if (slugs.length < MIN_DAO_SOURCES) {
			fail('source-section-unreadable', `来源法节读出 ${slugs.length} 条（< ${MIN_DAO_SOURCES}）：要么真缺依据，要么节标题被正文撞了前缀导致读不到`);
		}
	}

	if (layer === '器') {
		if (!/^##\s*调用方式/mu.test(content)) {
			fail('no-invocation', '缺「## 调用方式」：台账的价值就是下次不必重新摸索，没有它这份记录没用');
		} else {
			const section = content.split(/^##\s*调用方式/mu)[1] ?? '';
			if (!/^\s*[-*]\s*\S/mu.test(section)) fail('empty-invocation', '「## 调用方式」下没有任何条目');
		}
	}

	if (layer === '技能') {
		const fm = content.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
		if (!fm) fail('no-frontmatter', '缺 YAML frontmatter：宿主技能靠它登记（name/description/status）');
		else {
			const name = fm.match(/^name:\s*(.+)$/mu)?.[1]?.trim() ?? '';
			if (!name) fail('no-name', 'frontmatter 缺 name');
			else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) {
				fail('name-not-kebab', `name「${name}」不是 kebab-case：它同时是宿主目录名`);
			}
			const desc = fm.match(/^description:\s*(.+)$/mu)?.[1]?.trim() ?? '';
			if (!desc) fail('no-description', 'frontmatter 缺 description：触发词就写在它里面');
			else if (desc.split(/\s+/u).length > 80) {
				fail('description-overlong', `description ${desc.split(/\s+/u).length} 词 > 80：过长会被截断，触发词会失效`);
			}
			if (!/^status:\s*(candidate|active|retired)\s*$/mu.test(fm)) {
				fail('no-status', 'frontmatter 的 status 缺失或不是 candidate|active|retired');
			}
		}
	}

	return { ok: findings.length === 0, layer, relPath, findings, notes };
}

/**
 * 把自检结果压成一行给工具回执用（合格时说一句，不合格时点名缺什么）。
 *
 * @param result `checkArtifact` 的返回。
 * @returns 单行文本。
 */
export function selfCheckLine(result) {
	if (result.ok) {
		const head = result.notes?.[0];
		return head ? `${result.layer}层自检通过（${head.message}）` : `${result.layer}层自检通过`;
	}
	const first = result.findings[0];
	return `${result.layer}层自检**未过**：${first.message}` + (result.findings.length > 1 ? `（另有 ${result.findings.length - 1} 项）` : '');
}

/**
 * 自检结果 → 可直接并进工具 `warnings` 的字符串数组。
 *
 * 未过 → 以 ⛔ 开头（**不许当成功**）；通过但有提示（如"这条其实只是专项"）→ ℹ。
 * 单列这个函数是为了让五个写入工具的接法完全一致 —— 免得某一层漏推提示，
 * 那层就又变回"报了绿灯但没说清落在哪一层"。
 *
 * @param result `checkArtifact` 的返回。
 * @returns 告警字符串数组（可能为空）。
 */
export function selfCheckWarnings(result) {
	// 只把**未过**抬成告警。通过但有提示（"这条其实只是专项""块缺某一节"）留在
	// 结构化的 `selfCheck.notes` 里 —— 工具的 warnings 有一条既有契约：
	// 形状合法的成功写入不产生告警（harness-test 断言 no warnings）。
	// 让可选字段的提示去污染那条契约，等于把"正常"和"有瑕疵"again 混成一个信号。
	if (result.ok) return [];
	return [`⛔ ${selfCheckLine(result)} —— 已落盘但不符合${result.layer}层定义，请按上面点名的项修正后重写（不要当它已经可用）`];
}