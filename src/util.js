/**
 * Small shared helpers: dates, atomic file writes, slugs, iteration-block
 * parsing and memory-root resolution. No Host dependency, no side effects.
 */
import { readFile, writeFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';

const pad2 = (n) => String(n).padStart(2, '0');

export function localDateStr(d = new Date()) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function normDate(s) {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : localDateStr();
}

export const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** Code-point length: CJK counts as 1, unlike byteLen. */
export const charLen = (s) => [...String(s ?? '')].length;

/** One-line, table-safe cell text. */
export function oneLine(s) {
	return String(s ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim();
}

export async function readIfExists(p) {
	try {
		return await readFile(p, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * Write text atomically: a crash or a reader can never observe a partial file.
 * `rename` replaces the destination in one step (Node uses MOVEFILE_REPLACE_
 * EXISTING on Windows); a short retry covers transient locks from readers or
 * antivirus scanning the destination.
 */
export async function writeText(p, content) {
	await mkdir(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
	try {
		await writeFile(tmp, content, 'utf8');
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, p);
				return;
			} catch (err) {
				if (attempt >= 3) throw err;
				await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
			}
		}
	} catch (err) {
		try {
			await unlink(tmp);
		} catch {
			/* tmp already gone */
		}
		throw err;
	}
}

export async function statExists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/** Validate a feature/theme slug used as a markdown filename. */
export function safeSlug(raw) {
	// Tolerate the filename spelling callers reach for by habit ("x.md"); without
	// this, related: ["x.md"] renders as `x.md.md（未建档）` instead of a link.
	const s = String(raw ?? '').trim().replace(/\.md$/i, '');
	if (!s) throw new Error('slug must be a non-empty string');
	if (s.length > 60) throw new Error(`slug too long (max 60 chars): ${s}`);
	if (/[\\/:*?"<>|]/.test(s) || s.includes('..') || s.startsWith('.')) {
		throw new Error(`invalid slug (no path separators or dots at start): ${s}`);
	}
	if (/^memory$/i.test(s)) throw new Error('slug "MEMORY" is reserved for MEMORY.md');
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('slug must not look like a daily-log date (YYYY-MM-DD)');
	return s;
}

/** Iteration blocks (`## [date…] title`) with their bodies, for R14 length checks. */
export function splitIterationBlocks(text) {
	const out = [];
	let cur = null;
	for (const line of String(text ?? '').split('\n')) {
		if (/^##\s/.test(line)) {
			if (cur) out.push(cur);
			cur = null;
			const m = /^##\s*\[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*(.*)$/.exec(line);
			if (m) cur = { title: m[2].trim() || m[1], body: '' };
			continue;
		}
		if (cur) cur.body += `${line}\n`;
	}
	if (cur) out.push(cur);
	return out.map((b) => ({ title: b.title, body: b.body.trim() }));
}

/**
 * Resolve the harness home (same precedence as @deepseek-ai/dsh-home-paths:
 * $DSH_HOME, then ~/.dsh) without importing the package — the plugin keeps a
 * zero bare-import surface.
 */
export function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === 'string' && env.trim()) return path.resolve(env.trim());
	return path.join(homedir(), '.dsh');
}

export function joinDshHome(...segments) {
	return path.join(dshHome(), ...segments);
}

export function resolveRoot(opts) {
	if (opts.memoryRoot) return path.resolve(opts.memoryRoot);
	// Global memory root: the harness home's memory/ directory, shared across
	// every workspace, profile, and session (~/.dsh/memory by default).
	return joinDshHome('memory');
}

export function appendBlock(text, block) {
	return text.replace(/\n*$/, '\n') + block;
}

/**
 * Next same-day iteration index. Counts every `[YYYY-MM-DD]` / `[YYYY-MM-DD补N]`
 * tag in the file — not just the `## [..]` headings — because memory_fold removes
 * headings and lists the folded tags inside 「早期演化」: counting headings alone
 * would reuse an existing tag after a fold (补4 colliding with a folded 补4, which
 * also trips the R3 ordering check).
 */
export function countHeadingDate(text, date) {
	let max = -1;
	const re = new RegExp(`\\[${date}(补(\\d*))?\\]`, 'g');
	for (const m of String(text ?? '').matchAll(re)) {
		const n = m[2] === undefined ? 0 : m[2] === '' ? 1 : Number(m[2]);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max + 1;
}
