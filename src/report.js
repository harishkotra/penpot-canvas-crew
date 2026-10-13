/**
 * The report.
 *
 * One self-contained-ish HTML file per run: every round side by side with the
 * score, the findings, and the spec changes. This is the artifact you actually
 * show someone. It is the timelapse of the argument.
 *
 * `collectRounds` rebuilds a run's rounds from disk alone, so `report` can
 * regenerate a report for a finished run without re-running anything, and so
 * that path is testable.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const SEVERITY_COLOR = { blocker: '#f43f5e', major: '#f59e0b', minor: '#64748b' };

function readText(path, fallback = undefined) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

function readJson(path, fallback = undefined) {
  const text = readText(path);
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Rebuild the rounds for a finished run, reading only what is on disk.
 * Missing files degrade to sane defaults instead of throwing.
 *
 * @param {string} dir run directory
 * @param {Array<{round: number, score: number, verdict: string}>} history
 */
export function collectRounds(dir, history) {
  return (Array.isArray(history) ? history : []).map((h) => {
    const rd = join(dir, `round-${h.round}`);
    const code = readText(join(rd, 'code.js'), '');
    return {
      round: h.round,
      codeLines: code ? code.split('\n').length : 0,
      // Only reference the PNG when the file is actually there, otherwise the
      // report renders a broken image.
      imageUrl: existsSync(join(rd, 'board.png')) ? `round-${h.round}/board.png` : undefined,
      exportError: readText(join(rd, 'export-error.txt'), '') || undefined,
      audit: readJson(join(rd, 'audit.json'), { checked: 0, failures: 0, findings: [] }),
      critique: readJson(join(rd, 'critique.json'), {
        score: h.score,
        findings: [],
        summary: '',
        strengths: [],
        visual: false,
      }),
      // Prefer the persisted arbiter decision; fall back to the critic verdict.
      verdict: readJson(join(rd, 'verdict.json'), { decision: h.verdict, rule: 'recorded', reason: '' }),
    };
  });
}

export function buildReport({ brief, config, rounds, history, verdict, transcript }) {
  const safeRounds = Array.isArray(rounds) ? rounds : [];
  const safeHistory = Array.isArray(history) ? history : [];
  const v = verdict ?? {};

  const scores = safeHistory.map((h) => h.score).filter((n) => Number.isFinite(n));
  const first = scores[0];
  const last = scores[scores.length - 1];
  const delta = first !== undefined && last !== undefined ? last - first : 0;

  const roundCards = safeRounds
    .map((r) => {
      const c = r.critique ?? {};
      const audit = r.audit ?? {};
      const rv = r.verdict ?? {};
      const findingList = Array.isArray(c.findings) ? c.findings : [];
      const strengths = Array.isArray(c.strengths) ? c.strengths : [];

      const findings = findingList
        .map(
          (f) => `<li><span class="sev" style="background:${SEVERITY_COLOR[f.severity] ?? '#64748b'}">${escapeHtml(
            f.severity,
          )}</span> <b>${escapeHtml(f.area)}</b> ${escapeHtml(f.issue)}<br><span class="fix">fix: ${escapeHtml(
            f.fix,
          )}</span></li>`,
        )
        .join('');

      const image = r.imageUrl
        ? `<img src="${escapeHtml(r.imageUrl)}" alt="round ${r.round} render">`
        : `<div class="noimg">No render captured${
            r.exportError ? `<br><small>${escapeHtml(String(r.exportError).split('\n')[0])}</small>` : ''
          }</div>`;

      return `<section class="round">
  <header>
    <h2>Round ${r.round}</h2>
    <div class="score">${escapeHtml(c.score ?? '?')}<span>/10</span></div>
    <div class="badges">
      <span class="badge">${r.codeLines} lines of canvas code</span>
      <span class="badge">${c.visual ? 'critic saw the render' : 'spec-only review'}</span>
      <span class="badge">${audit.checked ?? 0} contrast pairs, ${audit.failures ?? 0} fail</span>
      <span class="badge arb">${escapeHtml(rv.decision ?? '?')} / ${escapeHtml(rv.rule ?? '?')}</span>
    </div>
  </header>
  <div class="body">
    <div class="img">${image}</div>
    <div class="notes">
      <p class="summary">${escapeHtml(c.summary)}</p>
      ${strengths.length ? `<p class="strengths"><b>Strengths:</b> ${strengths.map(escapeHtml).join('; ')}</p>` : ''}
      ${findings ? `<ul class="findings">${findings}</ul>` : '<p class="clean">No findings.</p>'}
      ${rv.reason ? `<p class="reason"><b>Arbiter:</b> ${escapeHtml(rv.reason)}</p>` : ''}
    </div>
  </div>
</section>`;
    })
    .join('\n');

  const trajectory = safeHistory
    .map((h) => {
      const shown = Number.isFinite(h.score) ? h.score : '?';
      return `<span class="dot" title="round ${h.round}: ${shown}/10">${shown}</span>`;
    })
    .join('<span class="arrow">→</span>');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canvas Crew — ${escapeHtml(String(brief ?? '').slice(0, 60))}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; background:#0B0B0F; color:#E5E7EB;
         font:15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
  h1 { font-size:26px; margin:0 0 4px; letter-spacing:-0.02em; }
  h2 { font-size:18px; margin:0; }
  .meta { color:#94A3B8; font-size:13px; }
  .brief { margin:20px 0 28px; padding:16px 18px; background:#14141B; border:1px solid #23232E; border-radius:10px; }
  .verdict { display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin:0 0 28px; }
  .trajectory { display:flex; align-items:center; gap:6px; }
  .dot { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px;
         border-radius:50%; background:#1E1E29; border:1px solid #2E2E3C; font-weight:600; }
  .arrow { color:#475569; }
  .delta { font-weight:700; }
  .up { color:#34D399; } .down { color:#F43F5E; } .flat { color:#94A3B8; }
  .round { margin:0 0 26px; background:#111118; border:1px solid #23232E; border-radius:12px; overflow:hidden; }
  .round > header { display:flex; align-items:center; gap:14px; padding:14px 18px; background:#16161E;
                    border-bottom:1px solid #23232E; flex-wrap:wrap; }
  .score { font-size:26px; font-weight:700; color:#A5B4FC; }
  .score span { font-size:14px; color:#64748B; font-weight:400; }
  .badges { display:flex; gap:8px; flex-wrap:wrap; margin-left:auto; }
  .badge { font-size:11px; padding:3px 9px; border-radius:999px; background:#1E1E29; border:1px solid #2E2E3C; color:#94A3B8; }
  .badge.arb { background:#1E1B4B; border-color:#312E81; color:#A5B4FC; }
  .body { display:grid; grid-template-columns:minmax(280px, 1fr) minmax(320px, 1fr); gap:0; }
  @media (max-width: 900px) { .body { grid-template-columns:1fr; } }
  .img { padding:18px; background:#0E0E14; display:flex; align-items:flex-start; justify-content:center; }
  .img img { max-width:100%; border-radius:6px; border:1px solid #23232E; }
  .noimg { color:#64748B; font-size:13px; padding:40px; text-align:center; }
  .notes { padding:18px; border-left:1px solid #23232E; }
  .summary { margin:0 0 12px; }
  .strengths, .reason { color:#94A3B8; font-size:13px; }
  .clean { color:#34D399; }
  ul.findings { list-style:none; padding:0; margin:0 0 14px; }
  ul.findings li { padding:9px 0; border-top:1px solid #1E1E29; font-size:13px; }
  .sev { font-size:10px; text-transform:uppercase; padding:2px 7px; border-radius:999px; color:#0B0B0F; font-weight:700; }
  .fix { color:#7DD3A8; font-size:12px; }
  details { margin-top:28px; }
  summary { cursor:pointer; color:#94A3B8; }
  pre { background:#0E0E14; border:1px solid #23232E; border-radius:8px; padding:16px; overflow:auto; font-size:12px; }
  footer { margin-top:32px; color:#475569; font-size:12px; }
</style>
</head>
<body>
  <h1>Canvas Crew</h1>
  <p class="meta">${safeRounds.length} round(s) · planner ${escapeHtml(
    config?.models?.planner ?? '?',
  )} · builder ${escapeHtml(config?.models?.builder ?? '?')} · critic ${escapeHtml(
    config?.models?.critic ?? '?',
  )} · arbiter ${escapeHtml(config?.models?.arbiter ?? '?')}</p>

  <div class="brief"><b>Brief.</b> ${escapeHtml(brief)}</div>

  <div class="verdict">
    <div class="trajectory">${trajectory || '<span class="meta">no rounds</span>'}</div>
    <div class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}">${
      delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${delta}`
    }</div>
    <div class="meta">Final: <b>${escapeHtml(String(v.decision ?? '?').toUpperCase())}</b> by rule <b>${escapeHtml(
      v.rule ?? '?',
    )}</b> — ${escapeHtml(v.reason)}</div>
  </div>

  ${roundCards || '<p class="meta">No rounds were completed.</p>'}

  <details>
    <summary>Full transcript</summary>
    <pre>${escapeHtml(transcript)}</pre>
  </details>

  <footer>Generated by penpot-canvas-crew. The canvas is a projection of the spec; the exported PNG is the oracle.</footer>
</body>
</html>`;
}