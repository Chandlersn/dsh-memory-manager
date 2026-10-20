/**
 * Host skill bridge (5.17.0).
 *
 * Registers a `ctx.skills` provider over the plugin's OWN memory-root `skills/`
 * folder: an ACTIVE crystallized skill that carries a kebab-case `hostName`
 * joins the host catalog and becomes callable through the host `skill` tool —
 * the merge point between the memory lifecycle (candidate→active→retired) and
 * the host's provider registry (@deepseek-ai/dsh-skill).
 *
 * Everything here is OPTIONAL by design: a host without the skill service, a
 * root without skills, or files without hostName all mean "no contribution",
 * never a crash — the plugin's own pre-step recall keeps serving every skill
 * regardless. The provider only admits skills the plugin itself marked safe
 * to publish (active + valid hostName), which is the memory layer's version of
 * the host's invocation policy.
 */
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

/** Host grammar mirror: dsh-skill SKILL_NAME (drift-guarded in harness-test). */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isSkillName = (name) => typeof name === 'string' && SKILL_NAME_RE.test(name);

/**
 * Provider-local rank for memory-root skills. Lower ranks WIN duplicate names
 * inside one layer (registry contract), so this sits ABOVE the host's
 * BUNDLED_SKILL_RANK (600): a hand-curated skill with the same name always
 * wins over a memory export — the bridge never overrides the user.
 */
const MEMORY_SKILL_RANK = 700;
const PROVIDER_NAME = 'dsh-memory-manager';

/** Minimal frontmatter split: `---` block at the very top, then the body. */
export function parseSkillText(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text ?? ''));
	if (!m) return { fields: {}, body: String(text ?? '') };
	const fields = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
		if (!kv) continue;
		let v = kv[2].trim();
		if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
		fields[kv[1]] = v;
	}
	return { fields, body: text.slice(m[0].length).trim() };
}

/** The publish gate: active lifecycle AND a legal host name. */
function publishable(fields) {
	return fields.status === 'active' && isSkillName(fields.hostName ?? '');
}

/**
 * Register the bridge on the host context. Returns `{ invalidate, dispose }`,
 * or `undefined` when the host exposes no skill registry (the plugin keeps
 * running on its own recall — this seam must never be load-bearing).
 */
export function registerMemorySkillBridge(ctx, { skillsDir }) {
	let registry;
	try {
		registry = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
		if (!registry) registry = ctx.skills;
	} catch {
		registry = undefined;
	}
	if (!registry || typeof registry.registerProvider !== 'function') return undefined;

	const dir = skillsDir;
	const readPublishable = async () => {
		let names = [];
		try {
			names = (await readdir(dir)).filter((n) => n.endsWith('.md'));
		} catch {
			return [];
		}
		const out = [];
		for (const f of names.sort()) {
			const file = path.join(dir, f);
			let text;
			try {
				text = await readFile(file, 'utf8');
			} catch {
				continue;
			}
			const { fields, body } = parseSkillText(text);
			if (!publishable(fields) || !fields.description) continue;
			out.push({ file, fields, body });
		}
		return out;
	};

	const provider = {
		name: PROVIDER_NAME,
		async list(options) {
			options?.signal?.throwIfAborted?.();
			const found = await readPublishable();
			return found.map(({ file, fields, body }) => ({
				name: fields.hostName,
				description: fields.description,
				...(fields.whenToUse ? { whenToUse: fields.whenToUse } : {}),
				path: file,
				invocation: { modelInvocable: true, userInvocable: true },
				source: 'custom',
				provider: PROVIDER_NAME,
				rank: MEMORY_SKILL_RANK,
				locator: file,
				_body: body,
				_when: fields.whenToUse,
				_summary: fields.description,
			}));
		},
		async get(candidate, options) {
			options?.signal?.throwIfAborted?.();
			// Reload from disk: the catalog caches nothing about bodies (host rule:
			// "definitions are never cached"), and a retire between list and get
			// must not still be loadable.
			const text = await readFile(String(candidate.locator), 'utf8').catch(() => undefined);
			if (text === undefined) return undefined;
			const { fields, body } = parseSkillText(text);
			if (!publishable(fields)) return undefined;
			return {
				name: fields.hostName,
				description: fields.description,
				...(fields.whenToUse ? { whenToUse: fields.whenToUse } : {}),
				path: String(candidate.locator),
				content: body,
				invocation: { modelInvocable: true, userInvocable: true },
				source: 'custom',
				provider: PROVIDER_NAME,
				resourceBase: { kind: 'directory', path: dir },
			};
		},
	};

	let control;
	const dispose = registry.registerProvider((c) => {
		control = c;
		return provider;
	});
	return {
		invalidate: () => {
			try {
				control?.invalidate?.();
			} catch {
				/* registration already gone — nothing to refresh */
			}
		},
		dispose,
	};
}
