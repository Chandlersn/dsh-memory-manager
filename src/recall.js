/**
 * Proactive recall: pre-step index matching + the ranked full-text search
 * shared by memory_search and the panel's /search route.
 */
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { readIfExists } from './util.js';
import { CAP_DIR, SKILL_DIR } from './constants.js';

// ---------------------------------------------------------------------------
// proactive recall: pre-step index matching (agent/pre-step waterfall)
// ---------------------------------------------------------------------------

/** Extract meaningful tokens: CJK bigrams + latin words, minus stopwords. */
export function tokensOf(text) {
	const t = String(text ?? '').toLowerCase();
	const out = new Set();
	for (const w of t.matchAll(/[a-z0-9_\-]{2,}/g)) out.add(w[0]);
	for (let i = 0; i < t.length - 1; i++) {
		const a = t[i];
		const b = t[i + 1];
		if (/[\u4e00-\u9fff]/.test(a) && /[\u4e00-\u9fff]/.test(b)) out.add(a + b);
	}
	for (const stop of ['这个', '那个', '什么', '怎么', '如何', '可以', '我们', '你们', '他们', '一个', '一下', '没有', '不是', '就是', '还有', '或者', '以及', '然后', '但是', '所以', '如果', '因为', 'the', 'and', 'for', 'with', 'this', 'that', 'have', 'not', '但', '的', '了', '吗', '呢', '吧']) {
		out.delete(stop);
	}
	return out;
}

/**
 * Score index rows against the user's tokens and return the top rows whose
 * overlap clears a small threshold. Pure and synchronous: runs in pre-step.
 *
 * v2 ranking (same cost class, much better precision):
 *  - IDF weighting: tokens shared by every row (e.g. 「功能」「记忆」) count for
 *    little; a rare token (「逐帧」「懒加载」) dominates. Without this, a query
 *    mentioning a common word outranks the row that is actually about it.
 *  - Name/slug hits are boosted: the row's own identity matching beats a
 *    passing mention inside its summary.
 *  - Relative threshold: rows scoring under 40% of the best match are dropped,
 *    so one strong hit does not drag three weak ones into the injection.
 *  - Dedupe by href (a table split into ### sub-sections can repeat a row).
 */
export function matchIndexRows(indexText, userTokens, limit = 3) {
	const candidates = [];
	for (const raw of indexText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('|') || s.includes('---')) continue;
		const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
		if (cells.length < 3 || !cells[1]) continue;
		// rows: [name, summary, link, (extra summary)] — link cell carries zone.
		const link = cells[2] || '';
		const zm = link.match(/\(([^)]+\.md)\)/);
		if (!zm) continue;
		const href = zm[1];
		const zone = href.startsWith('skills/') ? 'skill' : href.startsWith('insights/') ? 'insight' : href.startsWith('functions/') ? 'function' : null;
		if (!zone) continue;
		// A skill row carries its lifecycle in the 4th cell (status). Only ACTIVE
		// skills are recallable — a candidate is an unverified procedure and must
		// not shadow the reasoning it was distilled from.
		if (zone === 'skill' && cells[3] && cells[3] !== 'active') continue;
		const name = href.split('/').pop().replace(/\.md$/, '');
		candidates.push({
			name,
			summary: cells[1],
			href,
			zone,
			nameTokens: tokensOf(name),
			bodyTokens: tokensOf(`${cells[1]} ${cells[3] ?? ''}`),
		});
	}
	if (!candidates.length) return [];
	// Document frequency per token across rows → IDF weights.
	const df = new Map();
	for (const c of candidates) {
		for (const tk of new Set([...c.nameTokens, ...c.bodyTokens])) df.set(tk, (df.get(tk) ?? 0) + 1);
	}
	const n = candidates.length;
	const idf = (tk) => 1 + Math.log(n / Math.max(1, df.get(tk) ?? n));
	const scored = [];
	for (const c of candidates) {
		let score = 0;
		for (const tk of userTokens) {
			if (c.nameTokens.has(tk)) score += 2 * idf(tk);
			else if (c.bodyTokens.has(tk)) score += idf(tk);
		}
		if (score > 0) scored.push({ name: c.name, summary: c.summary, href: c.href, zone: c.zone, score });
	}
	scored.sort((a, b) => b.score - a.score);
	const best = scored[0]?.score ?? 0;
	const seen = new Set();
	const out = [];
	for (const r of scored) {
		if (r.score < best * 0.4) break;
		if (seen.has(r.href)) continue;
		seen.add(r.href);
		out.push(r);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Ranked full-text search over the whole memory root. Shared by the
 * `memory_search` tool and the panel's /search route so both rank identically
 * (the panel used to do a naive indexOf, whose order was file order).
 */
export async function searchMemory(root, rawQuery, { zone = 'all', limit = 20 } = {}) {
	const q = String(rawQuery ?? '').trim().toLowerCase();
	if (q.length < 2) return [];
	const tokens = tokensOf(q);
	const zones = zone === 'all' ? ['index', 'functions', 'insights', 'capabilities', 'skills', 'daily'] : [zone];
	const files = [];
	if (zones.includes('index')) files.push({ zone: 'index', name: 'MEMORY.md', file: path.join(root, 'MEMORY.md') });
	for (const z of ['functions', 'insights', 'capabilities', 'skills']) {
		if (!zones.includes(z)) continue;
		let names = [];
		try {
			names = (await readdir(path.join(root, z))).filter((n) => n.endsWith('.md')).sort();
		} catch {
			/* zone absent */
		}
		for (const n of names) files.push({ zone: z, name: n, file: path.join(root, z, n) });
	}
	if (zones.includes('daily')) {
		let names = [];
		try {
			names = (await readdir(root)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse();
		} catch {
			/* root absent */
		}
		for (const n of names) files.push({ zone: 'daily', name: n, file: path.join(root, n) });
	}
	const hits = [];
	for (const f of files) {
		const text = await readIfExists(f.file);
		if (text === undefined) continue;
		// Split on CRLF too: files written by other tools (or on Windows) carry
		// \r, and `.` never matches \r — a `^#{1,3}\s+(.+)$` test on a raw CRLF
		// line silently fails, which left every daily hit without its heading.
		const lines = text.split(/\r?\n/);
		const nameHit = f.name.toLowerCase().includes(q) || tokensOf(f.name).size && [...tokens].some((t) => tokensOf(f.name).has(t));
		let heading = '';
		const fileHits = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lower = line.toLowerCase();
			const hm = lower.match(/^#{1,3}\s+(.+)$/);
			if (hm) heading = hm[1].trim();
			let score = 0;
			if (lower.includes(q)) score += 3;
			if (heading && heading.toLowerCase().includes(q)) score += 2;
			let tokenHits = 0;
			for (const tk of tokens) if (lower.includes(tk)) tokenHits++;
			score += tokenHits;
			if (score === 0) continue;
			fileHits.push({
				zone: f.zone,
				name: f.name,
				line: i + 1,
				heading: heading.slice(0, 60),
				snippet: line.trim().slice(0, 160),
				score: score + (nameHit ? 2 : 0),
			});
		}
		// At most 3 lines per file: one file should not monopolise the ranking.
		fileHits.sort((a, b) => b.score - a.score);
		hits.push(...fileHits.slice(0, 3));
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit).map(({ zone: z, name, line, heading, snippet }) => ({ zone: z, name, line, heading, snippet }));
}

/** Build one recall UserMessage (form 'recall', plugin producer kind). */
export function buildRecallMessage(lines) {
	const hasSkill = lines.some((l) => l.zone === 'skill');
	const text = [
		'### 记忆召回（memory-manager）',
		'',
		'本轮用户输入与以下已有记忆的索引行相关。**先查后写**：涉及这些主题时先读对应文件再行动，不要凭空重推已有结论；如确属新工作，正常进行即可：',
		'',
		...lines.map((l) => `- ${l.zone === 'skill' ? '⭐ 已结晶技能：' : ''}${l.summary} → [${l.href}](${l.href})${l.zone === 'skill' ? '（先读程序按步骤走，不要再现场推导）' : ''}`),
		'',
		hasSkill ? 'ℹ 命中 active 技能：这是过去反复验证过的操作程序，优先直接执行其步骤；执行结果与预期不符时，回到来源功能域重新推导。' : '',
	].filter((s) => s !== '').join('\n');
	return {
		role: 'user',
		content: [{ type: 'text', text }],
		source: {
			kind: 'memory-manager/recall',
			form: 'recall',
		},
	};
}
