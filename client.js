/**
 * Client half of dsh-memory-manager: the Memory panel.
 *
 * sidebar.panellist icon (id: memory-panel) -> main panel keyed 'memory-panel'.
 * Data comes from the Host route /api/memory-org/* (read-only; the memory root
 * is resolved server-side).
 *
 * Information architecture (built for long-lived memory, not a file browser):
 *   rail   = 总览 / 功能 / 思想 / 每日 / 索引, each with a live count
 *   总览   = health + "最近改动" timeline across every zone + zone counts
 *   分区   = rows with a one-line index summary, relative time and size,
 *            sortable (时间/名称) and filterable — the list stays readable as
 *            the memory grows
 *   阅读   = section cards (iteration blocks / principle sections / day
 *            threads / index tables), newest block expanded first, with a
 *            jump strip and expand-all; internal .md links navigate in-panel
 *
 * Visual language deliberately mirrors the host primitives (Button / Tag /
 * Input / SidebarRoot panelRow): --dsw-alias-* colors, --dsw-radius-* scale,
 * .5px border hairlines, interactive-bg hover, the 2px focus ring, 28/32px
 * control heights. Styles ship as one <style> element inside the panel root
 * (component-local, removed on unmount) so :hover/:focus-visible behave like
 * the host's CSS modules.
 */
window.__ModuleLoader__.load({
	id: 'dsh-memory-manager',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useRef } = React;

		const API = '/api/memory-org';
		const enc = encodeURIComponent;

		const NAV = [
			{ key: 'overview', label: '总览', icon: '⌂' },
			{ key: 'index', label: '索引', icon: '☰' },
			{ key: 'functions', label: '功能', icon: '⬡' },
			{ key: 'insights', label: '思想', icon: '✦' },
			{ key: 'capabilities', label: '能力', icon: '⚒' },
			{ key: 'daily', label: '每日', icon: '🕘' },
		];
		const ZONE_LABEL = { functions: '功能', insights: '思想', capabilities: '能力', daily: '每日', '': '索引' };
		const ZONE_DIR = { functions: 'functions', insights: 'insights', capabilities: 'capabilities', daily: '' };

		const css = `
/* Host-aligned visuals: metrics and tokens are copied from the shipped primitives
   so the panel reads as a native surface beside host pages — base type 14/22,
   Button md 36px / sm 28px, Input 32px + border-l4 + bg-layer-1 with a
   state-business focus border, Tag 11/17 with color-mix tones, markdown links on
   --dsw-alias-link, code on --ds-font-family-code, and the host's
   --dsw-focus-ring-* pair. Lists use the host's hairline rows, not border boxes. */
.dmo-root{height:100%;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dmo-header{display:flex;align-items:center;gap:10px;padding:14px 20px 10px}
.dmo-title{font-size:16px;line-height:24px;font-weight:600;margin:0}
.dmo-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dmo-search{display:inline-flex;align-items:center;gap:6px;height:32px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);min-width:200px}
.dmo-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.dmo-search input{flex:1;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;min-width:0}
.dmo-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dmo-kbd{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:0 4px}
.dmo-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px;height:36px;transition:background .15s ease}
.dmo-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-btn:active{background:var(--dsw-alias-interactive-bg-active)}
.dmo-btn.outline{border:.5px solid var(--dsw-alias-border-l3)}
.dmo-btn.sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.dmo-btn.link{padding:0 2px;height:auto;color:var(--dsw-alias-link);font-weight:500;text-decoration:none}
.dmo-btn.link:hover{background:transparent;text-decoration:underline dotted var(--dsw-alias-link);text-underline-offset:3px}
.dmo-btn:disabled{opacity:.4;cursor:not-allowed}
.dmo-btn:focus-visible,.dmo-row:focus-visible,.dmo-tl-row:focus-visible,.dmo-gcard:focus-visible,.dmo-nav:focus-visible,.dmo-sec-head:focus-visible,.dmo-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dmo-body{flex:1;display:flex;min-height:0;padding:0 20px 16px;gap:16px}
.dmo-rail{width:184px;flex-shrink:0;display:flex;flex-direction:column;gap:1px;overflow-y:auto;border-right:.5px solid var(--dsw-alias-border-l2);padding-right:8px}
.dmo-nav{display:flex;align-items:center;gap:8px;width:100%;padding:0 8px;height:32px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:14px;text-align:left}
.dmo-nav:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-nav.active{background:var(--dsw-alias-interactive-bg-active);font-weight:600}
.dmo-nav .ico{width:16px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dmo-nav .cnt{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dmo-main{flex:1;min-width:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px}
.dmo-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
.dmo-card.tight{padding:8px 10px}
.dmo-h2{font-size:14px;line-height:22px;font-weight:600;margin:0 0 8px}
.dmo-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dmo-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);background:transparent;cursor:default}
.dmo-chip.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);border-color:transparent;color:var(--dsw-alias-state-success-primary)}
.dmo-chip.warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-color:transparent;color:var(--dsw-alias-state-warn-primary)}
.dmo-chip.fail{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:transparent;color:var(--dsw-alias-state-error-primary)}
.dmo-chip.btn{cursor:pointer}
.dmo-chip.btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-chip.active{background:var(--dsw-alias-interactive-bg-active);border-color:transparent;color:var(--dsw-alias-label-primary);font-weight:600}
.dmo-mark{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent);color:inherit;border-radius:3px;padding:0 2px}
.dmo-resolve{display:inline-flex;align-items:center;padding:0 8px;border-radius:999px;font-size:11px;line-height:18px;font-weight:500;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary);vertical-align:1px}
.dmo-tl{display:flex;flex-direction:column}
.dmo-tl-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.dmo-tl-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-tl-when{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);width:76px;flex-shrink:0;font-variant-numeric:tabular-nums}
.dmo-tl-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;flex-shrink:0}
.dmo-tl-sum{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmo-zone-tag{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:0 4px;flex-shrink:0}
.dmo-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmo-toolbar .grow{flex:1;min-width:120px}
.dmo-filter{height:32px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;width:100%}
.dmo-filter::placeholder{color:var(--dsw-alias-label-dimmed)}
.dmo-filter:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dmo-rows{display:flex;flex-direction:column}
.dmo-group{display:flex;flex-direction:column}
.dmo-month{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;margin:8px 0 2px}
.dmo-row{display:block;width:100%;text-align:left;padding:10px 8px;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;cursor:pointer;font:inherit}
.dmo-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-row-top{display:flex;align-items:baseline;gap:8px}
.dmo-row-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:14px;line-height:22px}
.dmo-row-meta{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex-shrink:0;font-variant-numeric:tabular-nums}
.dmo-row-sum{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dmo-crumbs{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px}
.dmo-crumb-sep{color:var(--dsw-alias-label-tertiary)}
.dmo-doc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmo-doc-title{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:14px;font-weight:600}
.dmo-toc{display:flex;flex-wrap:wrap;gap:4px}
.dmo-toc-chips{display:flex;flex-wrap:wrap;gap:4px}
.dmo-sec{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dmo-sec-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:14px;text-align:left}
.dmo-sec-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-sec-head .caret{color:var(--dsw-alias-label-tertiary);width:10px;flex-shrink:0;font-size:10px}
.dmo-sec-date{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex-shrink:0}
.dmo-sec-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmo-sec-body{padding:4px 12px 10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dmo-md{margin:6px 0;line-height:22px;font-size:14px;color:var(--dsw-alias-label-primary);word-break:break-word}
.dmo-md p{margin:6px 0}
.dmo-md ul{margin:6px 0;padding-left:20px}
.dmo-md li{margin:2px 0}
.dmo-md h3,.dmo-md h4{margin:10px 0 4px;font-size:14px;font-weight:600}
.dmo-md blockquote{margin:6px 0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dmo-md pre{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px;overflow-x:auto;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px}
.dmo-md code{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm);padding:0 3px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px}
.dmo-md hr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 0}
.dmo-link{color:var(--dsw-alias-link);cursor:pointer;text-decoration:none;border:none;background:transparent;font:inherit;padding:0;font-weight:500}
.dmo-link:hover{text-decoration:underline dotted var(--dsw-alias-link);text-underline-offset:3px}
.dmo-table{width:100%;border-collapse:collapse;font-size:14px;margin:6px 0}
.dmo-table th,.dmo-table td{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:6px 8px;text-align:left;vertical-align:top}
.dmo-table th{font-weight:600;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dmo-idx-row{cursor:pointer}
.dmo-idx-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-idx-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap}
.dmo-snippet{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dmo-empty{color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;padding:18px 2px}
.dmo-mono{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dmo-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dmo-probs{margin:6px 0 0;padding-left:20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dmo-growth{display:flex;gap:8px;flex-wrap:wrap}
.dmo-gcard{flex:1 1 120px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:8px 10px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);text-align:left;color:inherit;font:inherit}
.dmo-gcard:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-gnum{font-size:20px;line-height:28px;font-weight:600}
@media (max-width:720px){.dmo-body{flex-direction:column;padding:0 12px 12px}.dmo-rail{width:auto;flex-direction:row;overflow-x:auto;border-right:none;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:0 0 6px}}
`;

		// ---------------------------------------------------------------------
		// pure helpers
		// ---------------------------------------------------------------------

		/** "3 小时前" style relative time; falls back to the date for old items. */
		function relTime(iso) {
			const t = Date.parse(iso ?? '');
			if (!Number.isFinite(t)) return '';
			const diff = Date.now() - t;
			if (diff < 60_000) return '刚刚';
			if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
			if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
			if (diff < 2 * 86_400_000) return `昨天 ${new Date(t).toTimeString().slice(0, 5)}`;
			if (diff < 8 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
			return new Date(t).toISOString().slice(0, 10);
		}

		function fmtBytes(n) {
			if (!Number.isFinite(n)) return '';
			return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
		}

		/** Strip inline markdown for one-line summaries. */
		function plain(s) {
			return String(s ?? '')
				.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
				.replace(/[*`]/g, '')
				.replace(/\s+/g, ' ')
				.trim();
		}

		/**
		 * Read the two navigation tables out of MEMORY.md: slug -> one-line
		 * summary. This is what makes a zone list readable without opening every
		 * file, and it works from the index the panel already fetches.
		 */
		function parseIndexTables(text) {
			const out = { functions: {}, insights: {}, capabilities: {} };
			let zone = null;
			for (const raw of String(text ?? '').split('\n')) {
				const line = raw.trim();
				if (line.startsWith('## ')) {
					zone = line.includes('功能模块') ? 'functions' : line.includes('思想') ? 'insights' : line.includes('能力') ? 'capabilities' : null;
					continue;
				}
				if (!zone || !line.startsWith('|')) continue;
				const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
				if (cells.length < 3) continue;
				if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
				const slug = plain(cells[0]);
				if (!slug || /^(功能域|思想主题|主题|功能域摘要|能力)/.test(slug)) continue;
				const href = cells.map((c) => /\]\(([^)]+\.md)\)/.exec(c)?.[1]).find(Boolean) ?? '';
				out[zone][slug] = { summary: plain(cells[1] ?? ''), href };
			}
			return out;
		}

		/** Split a memory file into its head summary + `## ` sections. */
		function splitSections(text) {
			const preamble = [];
			const sections = [];
			let cur = null;
			for (const line of String(text ?? '').split('\n')) {
				if (/^##\s/.test(line)) {
					if (cur) sections.push(cur);
					cur = { heading: line.replace(/^##\s*/, '').trim(), lines: [] };
				} else if (cur) cur.lines.push(line);
				else preamble.push(line);
			}
			if (cur) sections.push(cur);
			return {
				preamble: preamble.join('\n').trim(),
				sections: sections.map((s) => ({
					heading: s.heading,
					body: s.lines.join('\n').trim(),
					date: (s.heading.match(/\[(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null,
				})),
			};
		}

		/** Which memory file (if any) an internal markdown href points at. */
		function resolveHref(href, zone) {
			const clean = String(href ?? '').split('#')[0].trim();
			if (!clean || /^(https?:|mailto:|#)/.test(clean)) return null;
			const p = clean.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
			if (p.startsWith('functions/')) return { zone: 'functions', name: p.slice(10) };
			if (p.startsWith('insights/')) return { zone: 'insights', name: p.slice(9) };
			if (/^\d{4}-\d{2}-\d{2}\.md$/.test(p)) return { zone: 'daily', name: p };
			if (p === 'MEMORY.md') return { zone: '', name: null };
			if (/^[^/]+\.md$/.test(p) && zone !== undefined) return { zone, name: p };
			return null;
		}

		/** Per-kind first-open policy: never dump 20KB of history on the reader. */
		function defaultOpen(kind, sections, text) {
			const open = {};
			const small = String(text ?? '').length < 4000;
			sections.forEach((s, i) => {
				if (kind === 'functions') open[i] = small || i === 0; // reversed: index 0 is the newest
				else if (kind === 'index') open[i] = /功能模块|思想|能力/.test(s.heading);
				else open[i] = true;
			});
			return open;
		}

		// ---------------------------------------------------------------------
		// data
		// ---------------------------------------------------------------------

		/**
		 * GET a JSON endpoint with abort-on-unmount. `fixtures` is a test seam:
		 * when it carries the URL the value is returned synchronously (the UI
		 * test renders every view without a server).
		 */
		function useApi(url, fixtures) {
			const [state, setState] = useState({ data: null, loading: Boolean(url), error: null });
			useEffect(() => {
				if (!url) {
					setState({ data: null, loading: false, error: null });
					return undefined;
				}
				const ac = new AbortController();
				setState((s) => ({ ...s, loading: true }));
				fetch(url, { signal: ac.signal })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
					.then((d) => setState({ data: d, loading: false, error: null }))
					.catch((e) => {
						if (e?.name === 'AbortError') return;
						setState({ data: null, loading: false, error: String(e?.message ?? e) });
					});
				return () => ac.abort();
			}, [url]);
			if (fixtures && url && Object.prototype.hasOwnProperty.call(fixtures, url)) return fixtures[url];
			return state;
		}

		// ---------------------------------------------------------------------
		// primitives
		// ---------------------------------------------------------------------

		function Btn({ children, onClick, tone, sm, title, disabled }) {
			return h(
				'button',
				{
					type: 'button',
					className: `dmo-btn${tone ? ` ${tone}` : ''}${sm ? ' sm' : ''}`,
					onClick,
					title,
					disabled,
				},
				children,
			);
		}

		function Chip({ children, tone, onClick, title }) {
			const cls = `dmo-chip${tone ? ` ${tone}` : ''}${onClick ? ' btn' : ''}`;
			return onClick
				? h('button', { type: 'button', className: cls, onClick, title, 'data-dmo': 'chip' }, children)
				: h('span', { className: cls, title, 'data-dmo': 'chip' }, children);
		}

		function Card({ children, tight, className }) {
			return h('div', { className: `dmo-card${tight ? ' tight' : ''}${className ? ` ${className}` : ''}` }, children);
		}

		function CardTitle({ children, right }) {
			return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h('h3', { className: 'dmo-h2', style: { margin: 0 } }, children), right ? h('span', { style: { marginLeft: 'auto' } }, right) : null);
		}

		// ---------------------------------------------------------------------
		// markdown rendering (links navigate inside the panel)
		// ---------------------------------------------------------------------

		function inline(text, keyBase, zone, onNavigate) {
			const src = String(text ?? '');
			const out = [];
			// One pointer per row: the same target rendered twice in a single line
			// (raise-site link + ✅ resolution pointer) reads as a stutter — repeats
			// collapse to plain text. The ✅ marker itself is collapsed into a chip
			// tag (see the fourth token branch).
			const seenTargets = new Set();
			const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]*\]\([^)\s]+\)|（✅[^）]*）)/g;
			let last = 0;
			let m;
			let n = 0;
			while ((m = re.exec(src))) {
				if (m.index > last) out.push(src.slice(last, m.index));
				const tok = m[1];
				const key = `${keyBase}-${n++}`;
				if (tok.startsWith('**')) out.push(h('strong', { key }, tok.slice(2, -2)));
				else if (tok.startsWith('`')) out.push(h('code', { key }, tok.slice(1, -1)));
				else if (tok.startsWith('（✅')) {
					// Resolution stamp → a compact, non-repeating chip. Any link inside
					// stays reachable as the chip's click target instead of a second
					// inline pointer.
					const linkM = /\[([^\]]*)\]\(([^)]+)\)/.exec(tok);
					const label = tok
						.replace(/^[（(]/, '')
						.replace(/[）)]$/, '')
						.replace(/\s*→\s*\[[^\]]*\]\([^)]*\)/, '')
						.trim();
					const target = linkM ? resolveHref(linkM[2], zone) : null;
					const jump = target && onNavigate ? () => onNavigate(target) : undefined;
					out.push(h('span', { key, className: 'dmo-resolve', onClick: jump, title: jump ? `打开 ${target.name}` : undefined }, label));
				} else {
					const mm = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(tok);
					const label = mm[1] || mm[2];
					const target = resolveHref(mm[2], zone);
					if (target && seenTargets.has(target.zone + ':' + target.name)) {
						out.push(label);
					} else if (target) {
						seenTargets.add(target.zone + ':' + target.name);
						out.push(
							h(
								'button',
								{
									key, type: 'button', className: 'dmo-link', title: mm[2],
									onClick: () => onNavigate(target),
								},
								label,
							),
						);
					} else if (/^https?:/.test(mm[2])) {
						out.push(h('a', { key, className: 'dmo-link', href: mm[2], target: '_blank', rel: 'noreferrer' }, label));
					} else out.push(label);
				}
				last = m.index + tok.length;
			}
			if (last < src.length) out.push(src.slice(last));
			return out.filter((x) => x !== '');
		}

		function MarkdownBody({ text, zone, onNavigate }) {
			const lines = String(text ?? '').split('\n');
			const blocks = [];
			let i = 0;
			let k = 0;
			while (i < lines.length) {
				const line = lines[i];
				if (line.trim() === '') {
					i++;
					continue;
				}
				if (/^```/.test(line.trim())) {
					const buf = [];
					i++;
					while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
					i++;
					blocks.push(h('pre', { key: `b${k++}` }, buf.join('\n')));
					continue;
				}
				if (/^\|/.test(line.trim())) {
					const rows = [];
					while (i < lines.length && /^\|/.test(lines[i].trim())) rows.push(lines[i++].trim());
					const parsed = rows
						.map((r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
						.filter((cells) => !cells.every((c) => /^[-: ]*$/.test(c)));
					const head = parsed.shift();
					blocks.push(
						h(
							'table',
							{ key: `b${k++}`, className: 'dmo-table' },
							[
								head ? h('thead', { key: 'th' }, h('tr', null, head.map((c, x) => h('th', { key: x }, inline(c, `h${x}`, zone, onNavigate))))) : null,
								h(
									'tbody',
									{ key: 'tb' },
									parsed.map((cells, y) => h('tr', { key: y }, cells.map((c, x) => h('td', { key: x }, inline(c, `c${y}-${x}`, zone, onNavigate))))),
								),
							],
						),
					);
					continue;
				}
				if (/^\s*[-*]\s+/.test(line)) {
					const items = [];
					while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
					blocks.push(h('ul', { key: `b${k++}` }, items.map((t, x) => h('li', { key: x }, inline(t, `i${x}`, zone, onNavigate)))));
					continue;
				}
				if (/^#{3,4}\s/.test(line)) {
					const level = line.match(/^#+/)[0].length >= 4 ? 'h4' : 'h3';
					blocks.push(h(level, { key: `b${k++}` }, inline(line.replace(/^#+\s*/, ''), `h${k}`, zone, onNavigate)));
					i++;
					continue;
				}
				if (/^>\s?/.test(line)) {
					const buf = [];
					while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
					blocks.push(h('blockquote', { key: `b${k++}` }, inline(buf.join(' '), `q${k}`, zone, onNavigate)));
					continue;
				}
				if (/^-{3,}$/.test(line.trim())) {
					blocks.push(h('hr', { key: `b${k++}` }));
					i++;
					continue;
				}
				const buf = [];
				while (i < lines.length && lines[i].trim() !== '' && !/^(\||\s*[-*]\s|#{3,4}\s|>|```|-{3,}$)/.test(lines[i])) buf.push(lines[i++]);
				blocks.push(h('p', { key: `b${k++}` }, inline(buf.join(' '), `p${k}`, zone, onNavigate)));
			}
			return h('div', { className: 'dmo-md' }, blocks);
		}

		/** MEMORY.md navigation tables: each row opens its target file. */
		function IndexTables({ text, onNavigate }) {
			const { sections } = splitSections(text);
			const wanted = sections.filter((s) => /功能模块|思想|能力/.test(s.heading));
			if (!wanted.length) return null;
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 10 } },
				wanted.map((s) => {
					const rows = s.body
						.split('\n')
						.map((l) => l.trim())
						.filter((l) => l.startsWith('|'))
						.map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
						.filter((cells) => cells.length >= 2 && !cells.every((c) => /^[-: ]*$/.test(c)));
					const head = rows.shift() ?? [];
					return h(
						'section',
						{ key: s.heading },
						h('h3', { className: 'dmo-h2' }, s.heading.replace(/^[^ ]*\s*/, '').replace(/⌃.*$/, '').trim() || s.heading),
						h(
							'table',
							{ className: 'dmo-table' },
							[
								h('thead', { key: 'h' }, h('tr', null, head.map((c, x) => h('th', { key: x }, plain(c))))),
								h(
									'tbody',
									{ key: 'b' },
									rows.map((cells, y) => {
										const href = cells.map((c) => /\]\(([^)]+\.md)\)/.exec(c)?.[1]).find(Boolean);
										const target = href ? resolveHref(href, '') : null;
										return h(
											'tr',
											{
												key: y, className: target ? 'dmo-idx-row' : undefined,
												onClick: target && onNavigate ? () => onNavigate(target) : undefined,
												title: target ? `打开 ${target.name}` : undefined,
											},
											cells.map((c, x) => h('td', { key: x, className: x === 0 ? 'dmo-idx-name' : undefined }, inline(c, `r${y}-${x}`, '', onNavigate))),
										);
									}),
								),
							],
						),
					);
				}),
			);
		}

		// ---------------------------------------------------------------------
		// reader
		// ---------------------------------------------------------------------

		function Section({ index, section, open, onToggle, zone, onNavigate, registerRef }) {
			return h(
				'div',
				{ className: 'dmo-sec', 'data-dmo': 'section', ref: (el) => registerRef(index, el) },
				h(
					'button',
					{ type: 'button', className: 'dmo-sec-head', onClick: () => onToggle(index), 'data-dmo': 'section-head' },
					h('span', { className: 'caret' }, open ? '▾' : '▸'),
					section.date ? h('span', { className: 'dmo-sec-date' }, section.date) : null,
					h('span', { className: 'dmo-sec-title' }, section.heading),
					h('span', { className: 'dmo-meta', style: { marginLeft: 'auto' } }, `${section.body.length}B`),
				),
				open ? h('div', { className: 'dmo-sec-body' }, h(MarkdownBody, { text: reverseBullets(section.body), zone, onNavigate })) : null,
			);
		}

		/**
		 * Daily threads are append-only audit trails (oldest line first on disk),
		 * but every time-ordered surface reads newest-first — flip the bullet
		 * order of a section body for display. Non-bullet lines (headings, prose,
		 * tables) keep their positions so structure never shuffles.
		 */
		function reverseBullets(body) {
			const lines = String(body ?? '').split('\n');
			const idx = lines.map((l, i) => (/^\s*[-*]\s/.test(l) ? i : -1)).filter((i) => i >= 0);
			if (idx.length < 2) return body;
			const out = lines.slice();
			idx.forEach((orig, k) => {
				out[orig] = lines[idx[idx.length - 1 - k]];
			});
			return out.join('\n');
		}

		function Reader({ view, text, meta, kind, root, onBack, onNavigate }) {
			const { preamble, sections } = splitSections(text ?? '');
			const [open, setOpen] = useState(() => defaultOpen(kind, sections, text));
			const [allOpen, setAllOpen] = useState(false);
			const refs = useRef(new Map());
			const fileName = view.zone === '' ? 'MEMORY.md' : view.name;

			useEffect(() => {
				setOpen(defaultOpen(kind, sections, text));
				setAllOpen(false);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [view.zone, fileName, text]);

			const registerRef = (i, el) => {
				if (el) refs.current.set(i, el);
				else refs.current.delete(i);
			};
			const jump = (i) => {
				setOpen((m) => ({ ...m, [i]: true }));
				if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => refs.current.get(i)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
			};
			const toggleAll = () => {
				const next = !allOpen;
				setAllOpen(next);
				const m = {};
				sections.forEach((s, i) => (m[i] = next));
				setOpen(m);
			};
			const copyPath = () => {
				const rel = view.zone === '' ? 'MEMORY.md' : `${ZONE_DIR[view.zone] ? `${ZONE_DIR[view.zone]}/` : ''}${fileName}`;
				const full = root ? `${root}/${rel}`.replace(/\\/g, '/') : rel;
				try {
					navigator.clipboard?.writeText(full);
				} catch {
					/* clipboard unavailable */
				}
			};

			// Every time-ordered surface reads newest-first: the section cards are
			// rendered in reverse file order (file stays append-only oldest-first;
			// the reader flips it), so the top card is always the latest state.
			// Index maps (`open[i]`, `refs`, `jump(i)`) keep the ORIGINAL section
			// indices — only the render order changes.
			const shown = sections.map((s, i) => ({ s, i })).reverse();
			const chipRows = kind === 'functions' ? shown.map(({ s, i }) => ({ i, label: s.date ? `${s.date}${/补$/.test(s.heading) ? '补' : ''}` : `#${i + 1}` })) : shown.map(({ s, i }) => ({ i, label: s.heading.slice(0, 14) }));

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 10 } },
				h(
					'div',
					{ className: 'dmo-crumbs' },
					h(Btn, { sm: true, onClick: onBack, title: '返回列表' }, '← 返回'),
					view.zone !== '' ? h('span', { className: 'dmo-meta' }, ZONE_LABEL[view.zone]) : null,
					view.zone !== '' ? h('span', { className: 'dmo-crumb-sep' }, '/') : null,
					h('span', { className: 'dmo-mono', style: { fontSize: 12 }, 'data-dmo': 'crumb' }, fileName),
				),
				h(
					'div',
					{ className: 'dmo-doc-head' },
					meta
						? h('span', { className: 'dmo-meta' }, [fmtBytes(meta.bytes), relTime(meta.mtime), sections.length ? `${sections.length} 个片段` : null].filter(Boolean).join(' · '))
						: h('span', { className: 'dmo-meta' }, sections.length ? `${sections.length} 个片段` : ''),
					h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
						sections.length > 1 ? h(Btn, { sm: true, tone: 'outline', onClick: toggleAll }, allOpen ? '仅看最新' : '展开全部') : null,
						h(Btn, { sm: true, tone: 'outline', onClick: copyPath, title: '复制文件路径' }, '复制路径'),
					),
				),
				sections.length > 3
					? h(
							'div',
							{ className: 'dmo-toc' },
							chipRows.map((c) =>
								h(
									'button',
									{ key: c.i, type: 'button', className: 'dmo-chip btn', onClick: () => jump(c.i), title: sections[c.i].heading, 'data-dmo': 'toc-chip' },
									c.label,
								),
							),
						)
					: null,
				kind === 'index' ? h(IndexTables, { text: text ?? '', onNavigate }) : null,
				preamble && kind !== 'index'
					? h(Card, { tight: true }, h(MarkdownBody, { text: preamble, zone: view.zone, onNavigate }))
					: null,
				kind === 'index'
					? h(
							'div',
							{ style: { display: 'flex', flexDirection: 'column', gap: 6 } },
							sections
								.filter((s) => !/功能模块|思想|能力/.test(s.heading))
								.map((s, i) => h(Card, { key: `x${i}`, tight: true }, h('h3', { className: 'dmo-h2' }, s.heading), h(MarkdownBody, { text: s.body, zone: '', onNavigate }))),
						)
					: h(
							'div',
							{ style: { display: 'flex', flexDirection: 'column', gap: 6 } },
							shown.map(({ s, i }) => h(Section, { key: `${s.heading}-${i}`, index: i, section: s, open: Boolean(open[i]), onToggle: (x) => setOpen((m) => ({ ...m, [x]: !m[x] })), zone: view.zone, onNavigate, registerRef })),
						),
			);
		}

		// ---------------------------------------------------------------------
		// overview / lists / search
		// ---------------------------------------------------------------------

		function Overview({ health, counts, timeline, usage, onOpen, onZone }) {
			const problems = health?.results ?? [];
			const fails = problems.filter((p) => p.level === 'FAIL');
			const warns = problems.filter((p) => p.level === 'WARN');
			const cold = problems.filter((p) => p.rule === 'TEMP');
			const usageLayer = usage?.layers ?? {};
			const hotspots = usage?.hotspots ?? [];
			const hasSignals = (usage?.signalCount ?? 0) > 0;
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 12 } },
				h(
					Card,
					null,
					h(
						'div',
						{ className: 'dmo-chips' },
						h(Chip, { tone: fails.length ? 'fail' : 'ok' }, fails.length ? `FAIL ${fails.length}` : '无 FAIL'),
						h(Chip, { tone: warns.length ? 'warn' : null }, warns.length ? `WARN ${warns.length}` : '无 WARN'),
						cold.length ? h(Chip, { tone: 'warn' }, `❄ 冷记忆 ${cold.length}`) : null,
					),
					problems.length
						? h('ul', { className: 'dmo-probs' }, problems.slice(0, 12).map((p, i) => h('li', { key: i }, `[${p.level}] ${p.rule}: ${p.message}`)))
						: h('div', { className: 'dmo-meta', style: { marginTop: 6 } }, '体检通过：索引体积、摘要、反向链接、日期顺序、死链、冷记忆均正常。'),
				),
				h(
					'div',
					{ className: 'dmo-growth' },
					[
						{ zone: 'functions', label: '功能模块' },
						{ zone: 'insights', label: '创新优化思想' },
						{ zone: 'daily', label: '当日线索' },
					].map((g) =>
						h(
							'button',
							{ key: g.zone, type: 'button', className: 'dmo-gcard', onClick: () => onZone(g.zone), 'data-dmo': 'growth-card' },
							h('div', { className: 'dmo-gnum' }, String(counts[g.zone] ?? 0)),
							h('div', { className: 'dmo-meta' }, g.label),
						),
					),
				),
				h(
					Card,
					null,
					h(CardTitle, null, '使用信号'),
					!hasSignals
						? h('div', { className: 'dmo-meta' }, '还没有使用信号。召回命中与 memory_read 会自动记录；纠正/认可用 memory_usage(record) 记一笔。')
						: h(
								'div',
								{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
								h(
									'div',
									{ className: 'dmo-chips', 'data-dmo': 'usage-layers' },
									h(Chip, null, `实验 ${usageLayer['实验'] ?? 0}`),
									h(Chip, { tone: 'ok' }, `专项 ${usageLayer['专项'] ?? 0}`),
									h(Chip, { tone: 'ok' }, `通用 ${usageLayer['通用'] ?? 0}`),
									h('span', { className: 'dmo-meta' }, `30 天 ${usage.signalCount} 条信号`),
								),
								hotspots.length
									? h(
											'ul',
											{ className: 'dmo-probs' },
											hotspots.map((h0, i) =>
												h('li', { key: i }, [
													h0.flips >= 2 ? `结论反复推翻（翻转 ${h0.flips}）` : null,
													h0.badRate > 0.4 ? `纠正率 ${Math.round(h0.badRate * 100)}%` : null,
													` — ${h0.href}`,
												].filter(Boolean).join(' · ')),
											),
										)
									: h('div', { className: 'dmo-meta' }, '无热点：没有反复推翻或高纠正率的记忆。'),
							),
				),
				h(
					Card,
					null,
					h(CardTitle, null, '最近改动'),
					timeline.length
						? h(
								'div',
								{ className: 'dmo-tl' },
								timeline.map((t, i) =>
									h(
										'button',
										{ key: i, type: 'button', className: 'dmo-tl-row', onClick: () => onOpen(t.zone, t.name), 'data-dmo': 'timeline-row', title: t.name },
										h('span', { className: 'dmo-tl-when' }, relTime(t.mtime)),
										h('span', { className: 'dmo-zone-tag' }, ZONE_LABEL[t.zone]),
										h('span', { className: 'dmo-tl-name' }, t.zone === 'daily' ? t.name.replace(/\.md$/, '') : t.name.replace(/\.md$/, '')),
										t.summary ? h('span', { className: 'dmo-tl-sum' }, t.summary) : null,
									),
								),
							)
						: h('div', { className: 'dmo-meta' }, '还没有记忆文件。'),
				),
			);
		}

		function ZoneList({ zone, rows, sort, setSort, filter, setFilter, onOpen }) {
			const label = ZONE_LABEL[zone] ?? zone;
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
				h(
					'div',
					{ className: 'dmo-toolbar' },
					h('span', { style: { fontSize: 14, fontWeight: 600 } }, label),
					h('span', { className: 'dmo-meta' }, `${rows.length} 项`),
					zone !== 'daily' ? h(Btn, { sm: true, tone: 'outline', onClick: () => setSort(sort === 'time' ? 'name' : 'time'), title: '切换排序' }, sort === 'time' ? '按时间 ↓' : '按名称 ↑') : h('span', { className: 'dmo-meta' }, '按时间 ↓'),
					h('span', { className: 'grow' }),
					h('input', { className: 'dmo-filter', style: { width: 180 }, placeholder: zone === 'daily' ? '过滤日期…' : '按名称或摘要过滤…', value: filter, onChange: (e) => setFilter(e.target.value) }),
				),
				rows.length
					? h(
							'div',
							{ className: 'dmo-rows' },
							rows.map((f, i) => {
								// Daily threads accumulate one file per day, so months get a
								// sticky-ish separator: 100 days stay scannable.
								const month = f.name.slice(0, 7);
								const newMonth = zone === 'daily' && (i === 0 || rows[i - 1].name.slice(0, 7) !== month);
								return h(
									'div',
									{ key: f.name, className: 'dmo-group' },
									newMonth ? h('div', { key: 'm', className: 'dmo-month' }, month) : null,
									h(
										'button',
										{ key: 'r', type: 'button', className: 'dmo-row', onClick: () => onOpen(zone, f.name), title: f.name, 'data-dmo': 'row' },
										h(
											'div',
											{ className: 'dmo-row-top' },
											h('span', { className: 'dmo-row-name' }, zone === 'daily' ? f.name.replace(/\.md$/, '') : f.name.replace(/\.md$/, '')),
											h('span', { className: 'dmo-row-meta' }, `${relTime(f.mtime)} · ${fmtBytes(f.bytes)}`),
										),
										f.summary ? h('div', { className: 'dmo-row-sum' }, f.summary) : null,
									),
								);
							}),
						)
					: h('div', { className: 'dmo-empty' }, filter ? '没有匹配的条目。' : `${label}区还没有文件。`),
			);
		}

		/** Mark every occurrence of the query inside a snippet (case-insensitive). */
		function highlight(text, q) {
			const src = String(text ?? '');
			const needle = String(q ?? '').trim();
			if (!needle) return [src];
			const out = [];
			const lower = src.toLowerCase();
			const needleLower = needle.toLowerCase();
			let at = 0;
			let i = 0;
			for (;;) {
				const next = lower.indexOf(needleLower, at);
				if (next === -1) break;
				if (next > at) out.push(src.slice(at, next));
				out.push(h('mark', { key: `m${i++}`, className: 'dmo-mark' }, src.slice(next, next + needle.length)));
				at = next + needle.length;
			}
			if (at < src.length) out.push(src.slice(at));
			return out;
		}

		function SearchPane({ res, q, zone, setZone, onOpen }) {
			const hits = res.data?.hits ?? [];
			const zones = [
				{ key: 'all', label: '全部' },
				{ key: 'index', label: '索引' },
				{ key: 'functions', label: '功能' },
				{ key: 'insights', label: '思想' },
				{ key: 'capabilities', label: '能力' },
				{ key: 'daily', label: '每日' },
			];
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
				h(
					'div',
					{ className: 'dmo-toolbar' },
					h('span', { style: { fontSize: 14, fontWeight: 600 } }, `搜索“${q}”`),
					h('span', { className: 'dmo-meta' }, `${hits.length} 处命中`),
					h('span', { className: 'grow' }),
					setZone
						? h(
								'div',
								{ className: 'dmo-chips' },
								zones.map((z) =>
									h(
										'button',
										{
											key: z.key, type: 'button',
											className: `dmo-chip btn${(zone ?? 'all') === z.key ? ' active' : ''}`,
											'data-dmo': 'search-zone',
											onClick: () => setZone(z.key),
										},
										z.label,
									),
								),
							)
						: null,
				),
				res.loading ? h('div', { className: 'dmo-empty' }, '搜索中…') : null,
				res.error ? h('div', { className: 'dmo-empty' }, `搜索失败：${res.error}`) : null,
				h(
					'div',
					{ className: 'dmo-rows' },
					hits.map((hit, i) =>
						h(
							'button',
							{ key: i, type: 'button', className: 'dmo-row', onClick: () => onOpen(hit.zone, hit.name), 'data-dmo': 'row' },
							h(
								'div',
								{ className: 'dmo-row-top' },
								h('span', { className: 'dmo-zone-tag' }, ZONE_LABEL[hit.zone] ?? hit.zone),
								h('span', { className: 'dmo-row-name' }, hit.name.replace(/\.md$/, '')),
								hit.line ? h('span', { className: 'dmo-row-meta' }, `第 ${hit.line} 行`) : null,
							),
							(hit.snippet ?? hit.text) ? h('div', { className: 'dmo-snippet' }, highlight(hit.heading ? `${hit.heading} · ${hit.snippet ?? hit.text}` : (hit.snippet ?? hit.text), q)) : null,
						),
					),
				),
				!res.loading && !hits.length
					? h(
							'div',
							{ className: 'dmo-empty' },
							(zone ?? 'all') === 'all' ? '没有命中。换个关键词试试（≥2 字符，支持中文）。' : '这个分区没有命中——点「全部」看其它分区。',
						)
					: null,
			);
		}

		// ---------------------------------------------------------------------
		// panel
		// ---------------------------------------------------------------------

		function MemoryPanel(props) {
			const fixtures = props?.__apiFixtures;
			const [view, setView] = useState(props?.initialView ?? { kind: 'overview' });
			const [sort, setSort] = useState('time');
			const [filter, setFilter] = useState('');
			const [query, setQuery] = useState('');
			const [live, setLive] = useState('');
			const [searchZone, setSearchZone] = useState('all');
			const [tick, setTick] = useState(0);
			const searchRef = useRef(null);
			const mainRef = useRef(null);

			const overview = useApi(`${API}/overview?v=${tick}`, fixtures);
			const funcs = useApi(`${API}/list?zone=functions&v=${tick}`, fixtures);
			const insights = useApi(`${API}/list?zone=insights&v=${tick}`, fixtures);
			const caps = useApi(`${API}/list?zone=capabilities&v=${tick}`, fixtures);
			const dailies = useApi(`${API}/list?zone=daily&v=${tick}`, fixtures);
			const indexFile = useApi(`${API}/file?name=MEMORY.md&v=${tick}`, fixtures);
			const search = useApi(live.length >= 2 ? `${API}/search?q=${enc(live)}${searchZone !== 'all' ? `&zone=${searchZone}` : ''}` : null, fixtures);

			const ws = overview.data?.[0];
			const counts = ws?.counts ?? {};
			// The panel API answers with `results` (see runHealthCheck); accept the
			// older `problems` spelling too so a stale server half cannot blank the
			// health chips silently.
			const health = ws ? { initialized: ws.initialized, failCount: ws.failCount, warnCount: ws.warnCount, results: ws.results ?? ws.problems ?? [] } : null;
			const indexText = indexFile.data?.text ?? '';
			const tables = parseIndexTables(indexText);
			const lists = { functions: funcs.data?.files ?? [], insights: insights.data?.files ?? [], capabilities: caps.data?.files ?? [], daily: dailies.data?.files ?? [] };

			useEffect(() => {
				const t = setTimeout(() => setLive(query.trim()), 350);
				return () => clearTimeout(t);
			}, [query]);
			useEffect(() => {
				const t = setInterval(() => setTick((n) => n + 1), 30_000);
				return () => clearInterval(t);
			}, []);

			const summaryOf = (zone, name) => {
				const slug = String(name ?? '').replace(/\.md$/, '');
				const table = zone === 'functions' ? tables.functions : zone === 'insights' ? tables.insights : zone === 'capabilities' ? tables.capabilities : null;
				return table?.[slug]?.summary ?? '';
			};
			const rowsOf = (zone) => {
				const q = filter.trim().toLowerCase();
				let rows = lists[zone].map((f) => ({ ...f, summary: summaryOf(zone, f.name) }));
				if (q) rows = rows.filter((f) => f.name.toLowerCase().includes(q) || (f.summary ?? '').toLowerCase().includes(q));
				if (zone !== 'daily' && sort === 'name') rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
				else rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
				return rows;
			};

			let timeline = [];
			for (const zone of ['functions', 'insights', 'capabilities', 'daily'])
				for (const f of lists[zone]) timeline.push({ zone, name: f.name, bytes: f.bytes, mtime: f.mtime, summary: summaryOf(zone, f.name) });
			timeline.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
			timeline = timeline.slice(0, 12);

			const openFile = (zone, name) => {
				setView({ kind: 'file', zone: zone ?? '', name: name ?? null });
				setQuery('');
				setLive('');
			};
			const navigate = (target) => openFile(target.zone, target.name);
			const back = () => {
				if (view.kind === 'file' && view.zone) setView({ kind: 'zone', zone: view.zone });
				else setView({ kind: 'overview' });
			};

			const opened = view.kind === 'file' ? view : null;
			const fileUrl = !opened ? null : opened.zone === '' ? null : `${API}/file?zone=${opened.zone}&name=${enc(opened.name)}`;
			const fileRes = useApi(fileUrl, fixtures);
			const fileMeta = !opened ? null : opened.zone === '' ? null : (lists[opened.zone] ?? []).find((f) => f.name === opened.name) ?? null;
			const fileText = opened ? (opened.zone === '' ? indexText : fileRes.data?.text ?? null) : null;
			const kind = !opened ? null : opened.zone === '' ? 'index' : opened.zone === 'functions' ? 'functions' : opened.zone === 'insights' ? 'insights' : 'daily';

			const activeKey = view.kind === 'overview' ? 'overview' : view.kind === 'zone' ? view.zone : view.zone === '' ? 'index' : view.zone;

			const onKeyDown = (e) => {
				const tag = e.target?.tagName;
				const typing = tag === 'INPUT' || tag === 'TEXTAREA';
				if (e.key === '/' && !typing) {
					e.preventDefault();
					searchRef.current?.focus();
					return;
				}
				if (e.key === 'Escape') {
					if (query || live) {
						setQuery('');
						setLive('');
					} else if (view.kind !== 'overview') back();
					return;
				}
				if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && mainRef.current) {
					const rows = [...mainRef.current.querySelectorAll('[data-dmo="row"],[data-dmo="timeline-row"]')];
					if (!rows.length) return;
					e.preventDefault();
					const at = rows.indexOf(document.activeElement);
					const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
					rows[next === -1 ? 0 : next]?.focus();
				}
			};

			let main = null;
			if (live.length >= 2) main = h(SearchPane, { res: search, q: live, zone: searchZone, setZone: setSearchZone, onOpen: openFile });
			else if (!ws && overview.loading) main = h('div', { className: 'dmo-empty' }, '读取记忆体检…');
			else if (overview.error) main = h('div', { className: 'dmo-empty' }, `API 不可用：${overview.error}`);
			else if (!ws) main = h('div', { className: 'dmo-empty' }, '没有已注册的 workspace。');
			else if (!health?.initialized) main = h('div', { className: 'dmo-empty' }, '记忆还没有建立（`~/.dsh/memory/` 尚未创建）。让 Agent 做一次实质工作，它就会用 memory_write 写下第一份迭代。');
			else if (view.kind === 'overview') main = h(Overview, { health, counts, timeline, usage: overview.data?.[0]?.usage, onOpen: openFile, onZone: (z) => setView({ kind: 'zone', zone: z }) });
			else if (view.kind === 'zone') main = h(ZoneList, { zone: view.zone, rows: rowsOf(view.zone), sort, setSort, filter, setFilter, onOpen: openFile });
			else if (fileText) main = h(Reader, { view, text: fileText, meta: fileMeta, kind, root: ws.root, onBack: back, onNavigate: navigate });
			else main = h('div', { className: 'dmo-empty' }, fileRes.loading ? '读取文件…' : fileRes.error ? `读取失败：${fileRes.error}` : '文件为空。');

			const searchIcon = h(
				'svg',
				{ viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': true },
				[h('circle', { key: 'c', cx: 11, cy: 11, r: 7 }), h('path', { key: 'l', d: 'm20 20-3.5-3.5' })],
			);

			return h(
				'div',
				{ className: 'dmo-root', onKeyDown, 'data-dmo': 'root' },
				h('style', null, css),
				h(
					'div',
					{ className: 'dmo-header' },
					h('h1', { className: 'dmo-title' }, '记忆管理'),
					h('span', { className: 'dmo-sub' }, `${counts.functions ?? 0} 功能 · ${counts.insights ?? 0} 思想 · ${counts.daily ?? 0} 日线索`),
					h(
						'label',
						{ className: 'dmo-search', style: { marginLeft: 'auto', width: 240 } },
						searchIcon,
						h('input', {
							ref: searchRef, type: 'search', placeholder: '搜索全部记忆', value: query,
							onChange: (e) => setQuery(e.target.value), 'data-dmo': 'search',
						}),
						h('span', { className: 'dmo-kbd' }, '/'),
					),
					h(Btn, { tone: 'outline', onClick: () => setTick((n) => n + 1), title: '重新读取记忆' }, '刷新'),
				),
				h(
					'div',
					{ className: 'dmo-body' },
					h(
						'div',
						{ className: 'dmo-rail' },
						NAV.map((n) => {
							const count = n.key === 'functions' || n.key === 'insights' || n.key === 'daily' ? counts[n.key] : null;
							return h(
								'button',
								{
									key: n.key, type: 'button', 'data-dmo': 'nav-item',
									className: `dmo-nav${activeKey === n.key ? ' active' : ''}`,
									onClick: () => (n.key === 'overview' ? setView({ kind: 'overview' }) : n.key === 'index' ? openFile('', null) : setView({ kind: 'zone', zone: n.key })),
								},
								h('span', { className: 'ico' }, n.icon),
								n.label,
								Number.isFinite(count) && count > 0 ? h('span', { className: 'cnt' }, String(count)) : null,
							);
						}),
						health?.initialized && (health.results ?? []).length
							? h('div', { style: { marginTop: 8, borderTop: '.5px solid var(--dsw-alias-border-l2)', paddingTop: 8 } },
									h('button', { type: 'button', className: 'dmo-nav', onClick: () => setView({ kind: 'overview' }) }, h('span', { className: 'ico' }, '⚠'), '体检有提示', h('span', { className: 'cnt' }, String((health.results ?? []).length))))
							: null,
					),
					h('div', { className: 'dmo-main', ref: mainRef, 'data-dmo': 'main' }, main),
				),
			);
		}

		function MemoryIcon({ size = 16 } = {}) {
			return h(
				'svg',
				{ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true },
				[
					h('path', { key: 'f', d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5.5Z' }),
					h('path', { key: 'l', d: 'M8 12h8M8 16h5' }),
				],
			);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				// Sidebar icon; its registration id doubles as the main-panel dispatch
				// key (Plugin Manager's pattern). The icon renders as a bare 16px svg
				// so the shell's panelRow glyph (current-color, 28/36px button) owns
				// color and geometry.
				ctx.slots.inject('sidebar.panellist', () =>
					ctx.slots.register(
						{ name: 'sidebar.panellist', id: 'memory-panel', order: 50, label: '记忆管理' },
						MemoryIcon,
					),
				);
				ctx.slots.inject('main', () =>
					ctx.slots.register({ name: 'main', key: 'memory-panel' }, MemoryPanel),
				);
			},
			// Pure view logic, exposed so ui-test.mjs can assert the panel's
			// parsing/folding behaviour without a browser.
			__internalsForTest: { relTime, plain, parseIndexTables, splitSections, resolveHref, defaultOpen, SearchPane, reverseBullets, highlight },
		};
	},
});