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
