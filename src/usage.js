/**
 * Usage signals — the data that lets the memory sort itself.
 *
 * The index/insight layer is written by the model; which rows are actually USED
 * is a different signal. Every recall injection, explicit file read, correction
 * and positive confirmation appends one line to <root>/.usage.jsonl (a dot-file
 * so no zone listing, search or lint sees it), and memory_check / memory_usage
 * turn those lines into layer suggestions.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { readIfExists } from './util.js';

export function usagePath(root) {
	return path.join(root, '.usage.jsonl');
}

export async function appendUsage(root, entry) {
	try {
		await mkdir(root, { recursive: true });
		await appendFile(usagePath(root), `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, 'utf8');
	} catch {
		/* usage logging must never break a step or a tool call */
	}
}

/** Usage entries newer than `days`, newest last. Bad lines are skipped. */
export async function readUsage(root, days = 30) {
	const text = await readIfExists(usagePath(root));
	if (text === undefined) return [];
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	const out = [];
	for (const line of text.split('\n')) {
		const s = line.trim();
		if (!s) continue;
		try {
			const e = JSON.parse(s);
			const t = Date.parse(e.t);
			if (!Number.isFinite(t) || t < cutoff) continue;
			out.push({ ...e, ms: t });
		} catch {
			/* skip corrupt line */
		}
	}
	return out;
}

/** Aggregate usage per target and suggest a layer (实验 / 专项 / 通用). */
export function summarizeUsage(entries) {
	const map = new Map();
	// Keep the correction/positive order per href so a flip (positive -> correction
	// or the other way round) can be counted: a memory that keeps being confirmed
	// and then overturned is not the same as one that is simply used.
	const verdicts = new Map();
	for (const e of entries) {
		const href = String(e.href ?? '').trim();
		if (!href) continue;
		const cur = map.get(href) ?? { href, recalls: 0, reads: 0, corrections: 0, positives: 0, last: 0 };
		if (e.kind === 'recall') cur.recalls++;
		else if (e.kind === 'read') cur.reads++;
		else if (e.kind === 'correction') cur.corrections++;
		else if (e.kind === 'positive') cur.positives++;
		if (e.kind === 'correction' || e.kind === 'positive') {
			const seq = verdicts.get(href) ?? [];
			seq.push({ kind: e.kind, ms: e.ms });
			verdicts.set(href, seq);
		}
		cur.last = Math.max(cur.last, e.ms);
		map.set(href, cur);
	}
	const items = [...map.values()];
	for (const it of items) {
		const uses = it.recalls + it.reads;
		const badRate = uses ? it.corrections / uses : it.corrections ? 1 : 0;
		// Layer suggestion mirrors the article's data-driven promotion: usage wins,
		// confirmation gates promotion, correction rate gates generality.
		if (uses >= 10 && it.positives >= 2 && badRate < 0.2) it.layer = '通用';
		else if (uses >= 3 && it.positives >= 1) it.layer = '专项';
		else it.layer = '实验';
		it.uses = uses;
		it.badRate = Number(badRate.toFixed(2));
		const seq = (verdicts.get(it.href) ?? []).sort((a, b) => a.ms - b.ms);
		let flips = 0;
		for (let i = 1; i < seq.length; i++) if (seq[i].kind !== seq[i - 1].kind) flips++;
		it.flips = flips;
	}
	items.sort((a, b) => b.uses - a.uses || b.last - a.last);
	return items;
}

/**
 * Insight trust from usage evidence (Hindsight-borrowed: beliefs carry proof
 * counts, and new evidence REFINES rather than silently replaces).
 *
 *   positives 0, corrections 0  → 待验证（沉淀了但还没被用过/验证过）
 *   corrections >= positives>0  → 动摇（被纠正追平了认可：该精炼或取代了）
 *   positives >= 3              → 稳固（反复被确认）
 *   positives >= 1              → 已验证
 */
export function insightTrust(item) {
	const p = item?.positives ?? 0;
	const c = item?.corrections ?? 0;
	if (p === 0) return { level: '待验证', positives: 0, corrections: c };
	if (c >= p) return { level: '动摇', positives: p, corrections: c };
	if (p >= 3) return { level: '稳固', positives: p, corrections: c };
	return { level: '已验证', positives: p, corrections: c };
}

/** The head line written into every insight file; the panel renders it for free. */
export function trustLineFor(trust) {
	return `> 信任：${trust.level}（认可 ${trust.positives} · 纠正 ${trust.corrections}，由 memory_insight 按 .usage.jsonl 自动刷新）`;
}

/**
 * Replace or insert the trust line right after the `> 性质：` head line.
 * BOTH branches matter: files created by the 5.16.1 template already carry the
 * line (replace), files written by an earlier generation do not (insert) — and
 * the insert needs the `m` flag, or `^` anchors at the very start of the body
 * (the `# 标题` line) and silently never matches. An insight update must never
 * return without its trust line: the recall marker and R22 both key on it.
 */
export function refreshTrustLine(text, line) {
	if (/^> 信任：.*$/m.test(text)) return text.replace(/^> 信任：.*$/m, line);
	const withInsert = text.replace(/^(> 性质：[^\n]*\n)/m, `$1${line}\n`);
	if (withInsert !== text) return withInsert;
	// No `> 性质：` head at all (a hand-written or truncated file): put the line
	// under the title instead of dropping it.
	const afterTitle = text.replace(/^(#[^\n]*\n\n?)/m, `$1${line}\n`);
	if (afterTitle !== text) return afterTitle;
	return `${line}\n${text}`;
}
