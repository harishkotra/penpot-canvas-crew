/**
 * Unit tests for the deterministic parts of the crew.
 *
 * These are the pieces that must not depend on a language model being in a good
 * mood: contrast maths, spec repair, JSON extraction, the code guard, and the
 * arbiter's rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHex, contrastRatio, isLargeText, requiredContrast, auditSpec } from '../src/a11y.js';
import { normalizeSpec, toHex, diffSpecs, summarizeSpec } from '../src/spec.js';
import { extractJson, assertRouting, ROLE_REQUIREMENTS } from '../src/models.js';
import { extractCode, checkCodeSafety } from '../src/roles/builder.js';
import { applyRules, DECISIONS } from '../src/roles/arbiter.js';
import { normalizeCritique } from '../src/roles/critic.js';
import { parsePayload, unwrapExecuteResult, classifyToolFailure, looksLikeToolFailure, PluginFrozenError } from '../src/mcp.js';
import { INITIAL_SPEC } from './fixtures.mjs';

// --- contrast maths --------------------------------------------------------

test('parseHex handles #RGB and #RRGGBB and rejects junk', () => {
  assert.deepEqual(parseHex('#FFFFFF'), [255, 255, 255]);
  assert.deepEqual(parseHex('000000'), [0, 0, 0]);
  assert.deepEqual(parseHex('#F00'), [255, 0, 0]);
  assert.equal(parseHex('not-a-colour'), null);
  assert.equal(parseHex('#12345'), null);
});

test('contrastRatio matches the WCAG reference values', () => {
  assert.equal(Math.round(contrastRatio('#FFFFFF', '#000000')), 21);
  assert.equal(Math.round(contrastRatio('#000000', '#000000')), 1);
  // Symmetric: order must not matter.
  assert.equal(contrastRatio('#6366F1', '#0B0B0F'), contrastRatio('#0B0B0F', '#6366F1'));
  // A mid grey on near-black is the classic failure case.
  assert.ok(contrastRatio('#4B5563', '#0B0B0F') < 4.5);
  // A light grey on near-black is fine.
  assert.ok(contrastRatio('#D1D5DB', '#0B0B0F') > 4.5);
});

test('large-text thresholds follow WCAG', () => {
  assert.equal(isLargeText(24, 400), true);
  assert.equal(isLargeText(18.66, 700), true);
  assert.equal(isLargeText(18, 400), false);
  assert.equal(requiredContrast(64, 700), 3.0);
  assert.equal(requiredContrast(16, 400), 4.5);
});

test('auditSpec fails the low-contrast spec and passes the fixed one', () => {
  const bad = auditSpec(normalizeSpec(INITIAL_SPEC));
  assert.ok(bad.failures > 0, 'expected the muted colour to fail the gate');
  assert.ok(
    bad.findings.some((f) => f.severity === 'blocker' && /contrast/i.test(f.issue)),
    'expected a contrast blocker',
  );

  const fixed = JSON.parse(JSON.stringify(INITIAL_SPEC));
  fixed.palette = fixed.palette.map((c) => (c.name === 'muted' ? { ...c, hex: '#D1D5DB' } : c));
  const good = auditSpec(normalizeSpec(fixed));
  assert.equal(good.failures, 0, `expected no failures, got ${JSON.stringify(good.findings)}`);
  assert.equal(good.passed, true);
});

test('auditSpec counts every text block it checked', () => {
  const audit = auditSpec(normalizeSpec(INITIAL_SPEC));
  assert.equal(audit.checked, 4);
});

// --- spec repair -----------------------------------------------------------

test('normalizeSpec repairs a sloppy planner response instead of throwing', () => {
  const spec = normalizeSpec({
    title: 'x'.repeat(200),
    palette: [{ name: 'Bg!', hex: 'fafafa' }, { name: 'bg', hex: '#0b0b0f' }],
    sections: [{ id: 'Hero Section', height: 'tall', text: [{ role: 'h', copy: 'hi', color: 'nonexistent' }] }],
  });
  assert.equal(spec.title.length, 80);
  assert.equal(spec.board.background, '#0B0B0F');
  assert.ok(spec.palette.every((c) => /^#[0-9A-F]{6}$/.test(c.hex)));
  assert.equal(spec.sections[0].id, 'hero-section');
  assert.equal(spec.sections[0].height, 120); // defaulted from a non-number
  // An unknown colour token must resolve to a real palette entry, never pass through.
  const paletteNames = spec.palette.map((c) => c.name);
  assert.ok(paletteNames.includes(spec.sections[0].text[0].color));
});

test('normalizeSpec makes the board background agree with the bg token', () => {
  // A planner that writes board.background "#000000" while the palette says
  // bg=#0B0B0F produces two different "backgrounds" in one spec.
  const spec = normalizeSpec({
    board: { width: 1440, height: 900, background: '#000000' },
    palette: [{ name: 'bg', hex: '#0B0B0F' }, { name: 'text', hex: '#FAFAFA' }],
    sections: [{ id: 'a', height: 100, background: 'bg', text: [] }],
  });
  assert.equal(spec.board.background, '#0B0B0F');
  assert.equal(spec.palette.find((c) => c.name === 'bg').hex, spec.board.background);
});

test('normalizeSpec always provides a bg token and a type scale', () => {
  const spec = normalizeSpec({});
  assert.ok(spec.palette.some((c) => c.name === 'bg'));
  assert.ok(spec.type_scale.length >= 3);
  assert.ok(spec.sections.length >= 1);
});

test('toHex coerces and uppercases', () => {
  assert.equal(toHex('#abc'), '#AABBCC');
  assert.equal(toHex('zzz', '#123456'), '#123456');
});

test('diffSpecs reports palette and section changes', () => {
  const a = normalizeSpec(INITIAL_SPEC);
  const b = JSON.parse(JSON.stringify(INITIAL_SPEC));
  b.palette = b.palette.map((c) => (c.name === 'muted' ? { ...c, hex: '#D1D5DB' } : c));
  b.sections[0].height = 100;
  const changes = diffSpecs(a, normalizeSpec(b));
  assert.ok(changes.some((c) => c.field === 'palette.muted' && c.to === '#D1D5DB'));
  assert.ok(changes.some((c) => c.field === 'section.nav.height'));
});

test('summarizeSpec is readable and mentions the sections', () => {
  const s = summarizeSpec(normalizeSpec(INITIAL_SPEC));
  assert.match(s, /hero/);
  assert.match(s, /palette:/);
});

// --- JSON extraction -------------------------------------------------------

test('extractJson copes with fences, prose and nesting', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":[1,2]}} thanks'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  // Braces inside strings must not end the scan early.
  assert.deepEqual(extractJson('{"s":"a } b","n":2}'), { s: 'a } b', n: 2 });
  assert.equal(extractJson('no json here'), undefined);
  assert.equal(extractJson(''), undefined);
});

// --- model routing ---------------------------------------------------------

test('assertRouting catches a vision-less critic', () => {
  const models = { planner: 'glm5.3flash', builder: 'glm5.3flash', critic: 'deepseek-v4.1-flash', arbiter: 'glm5.3flash' };
  const caps = {
    'glm5.3flash': { tools: true, vision: true, json: true },
    'deepseek-v4.1-flash': { tools: true, vision: false, json: false },
  };
  const res = assertRouting(models, caps);
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /critic.*needs vision/.test(p)), JSON.stringify(res.problems));
});

test('assertRouting passes a coherent routing', () => {
  const models = { planner: 'glm5.3flash', builder: 'deepseek-v4.1-flash', critic: 'glm5.3flash', arbiter: 'glm5.3flash' };
  const caps = {
    'glm5.3flash': { tools: true, vision: true, json: true },
    'deepseek-v4.1-flash': { tools: true, vision: false, json: false },
  };
  assert.equal(assertRouting(models, caps).ok, true);
});

test('every role declares what it needs', () => {
  assert.deepEqual(Object.keys(ROLE_REQUIREMENTS).sort(), ['arbiter', 'builder', 'critic', 'planner']);
});

// --- builder guard ---------------------------------------------------------

test('extractCode strips fences and leading prose', () => {
  assert.equal(extractCode('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(extractCode('Sure! Here is the code:\nconst a = 1;'), 'const a = 1;');
  assert.equal(extractCode('   \n  '), '');
});

test('checkCodeSafety blocks code that would damage the file', () => {
  const good = "const old = penpotUtils.findShape(s => s.name === 'Crew'); if (old) old.remove();";
  assert.equal(checkCodeSafety(good, 'Crew').ok, true);

  assert.equal(checkCodeSafety('penpot.currentPage.root.remove();', 'Crew').ok, false);
  assert.equal(checkCodeSafety('penpot.closePlugin();', 'Crew').ok, false);
  assert.equal(checkCodeSafety('', 'Crew').ok, false);
  // Code that never mentions the board would build on the wrong shape.
  const wrong = checkCodeSafety('const b = penpot.createBoard(); b.name = "Other";', 'Crew');
  assert.equal(wrong.ok, false);
  assert.ok(wrong.problems.some((p) => /board name/.test(p)));
});

// --- arbiter rules ---------------------------------------------------------

const h = (round, score, blockers = 0) => ({ round, score, blockers, verdict: 'revise' });

test('arbiter accepts a clean score at or above the bar', () => {
  const r = applyRules({ history: [h(1, 9)], round: 1, maxRounds: 4, passScore: 8 });
  assert.equal(r.decision, DECISIONS.ACCEPT);
  assert.equal(r.rule, 'pass-score');
});

test('arbiter refuses to accept while blockers remain', () => {
  const r = applyRules({ history: [h(1, 9, 2)], round: 1, maxRounds: 4, passScore: 8 });
  assert.equal(r.decision, DECISIONS.REVISE);
  assert.equal(r.rule, 'blockers');
});

test('arbiter stops at the round budget regardless of score', () => {
  const r = applyRules({ history: [h(4, 2)], round: 4, maxRounds: 4, passScore: 8 });
  assert.equal(r.decision, DECISIONS.HALT);
  assert.equal(r.rule, 'budget');
});

test('arbiter stops when three rounds show no improvement', () => {
  const r = applyRules({ history: [h(1, 6), h(2, 6), h(3, 6)], round: 3, maxRounds: 6, passScore: 8 });
  assert.equal(r.decision, DECISIONS.HALT);
  assert.equal(r.rule, 'no-improvement');
});

test('arbiter stops on a big regression rather than compounding it', () => {
  const r = applyRules({ history: [h(1, 8), h(2, 4)], round: 2, maxRounds: 6, passScore: 8 });
  assert.equal(r.decision, DECISIONS.HALT);
  assert.equal(r.rule, 'regression');
});

test('arbiter keeps going when the score is improving below the bar', () => {
  assert.equal(applyRules({ history: [h(1, 5), h(2, 7)], round: 2, maxRounds: 6, passScore: 8 }), null);
});

// --- critique normalisation ------------------------------------------------

test('a computed blocker cannot be argued away by the model', () => {
  const audit = { findings: [{ severity: 'blocker', area: 'hero/subhead', issue: 'Contrast 3.2:1 below 4.5:1', fix: 'lighten' }], passed: false };
  const c = normalizeCritique({ score: 10, verdict: 'accept', findings: [] }, { audit, visual: true });
  assert.equal(c.verdict, 'revise', 'a blocker must force a revise verdict');
  assert.ok(c.blockers >= 1);
  assert.ok(c.findings.some((f) => f.area === 'hero/subhead'));
});

test('normalizeCritique clamps nonsense scores and severities', () => {
  const c = normalizeCritique({ score: 99, findings: [{ severity: 'catastrophic', area: 'x', issue: 'y' }] }, { audit: { findings: [], passed: true }, visual: false });
  assert.equal(c.score, 10);
  assert.equal(c.findings[0].severity, 'minor');
  assert.equal(c.visual, false);
  assert.equal(c.parsed, true);
});

test('an unparseable critique gets NO score, rather than a default', () => {
  // A default score is worse than no score: the loop would optimise against a
  // number nobody produced. This happened on a real run.
  const c = normalizeCritique(undefined, { audit: { findings: [], passed: true }, visual: true });
  assert.equal(c.parsed, false);
  assert.equal(c.score, null, 'an unparsed critique must not carry an invented score');
  assert.equal(c.verdict, 'revise');
  assert.equal(c.visual, true);
  assert.deepEqual(c.findings, []);
});

test('an unparsed critique still carries the computed accessibility facts', () => {
  const audit = {
    findings: [{ severity: 'blocker', area: 'hero', issue: 'Contrast 1.00:1', fix: 'lighten' }],
    passed: false,
  };
  const c = normalizeCritique(undefined, { audit, visual: true });
  assert.equal(c.parsed, false);
  assert.equal(c.blockers, 1, 'computed blockers must survive an unparseable model reply');
  assert.equal(c.verdict, 'revise');
});

// --- MCP plumbing ----------------------------------------------------------

test('parsePayload reads SSE frames and bare JSON', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  assert.deepEqual(parsePayload(sse), [{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  assert.deepEqual(parsePayload('{"jsonrpc":"2.0","id":2,"result":{"x":1}}'), [
    { jsonrpc: '2.0', id: 2, result: { x: 1 } },
  ]);
  assert.deepEqual(parsePayload('garbage'), []);
});

test('unwrapExecuteResult pulls the result out of Penpot\'s envelope', () => {
  assert.deepEqual(unwrapExecuteResult('{"result":{"boardId":"b1"},"log":""}'), { boardId: 'b1' });
  assert.equal(unwrapExecuteResult('not json'), 'not json');
});

test('classifyToolFailure turns server text into actionable errors', () => {
  const frozen = classifyToolFailure('The Penpot plugin tab has been frozen by the browser and cannot run tasks.');
  assert.ok(frozen instanceof PluginFrozenError);
  assert.match(frozen.message, /Always keep these sites active/);

  const token = classifyToolFailure('No userToken found in session context. Multi-user mode requires authentication.');
  assert.match(token.message, /userToken/);

  const missing = classifyToolFailure('Error: No Penpot plugin is connected.');
  assert.match(missing.message, /File -> MCP Server -> Connect/);
});

test('tool failures are detected even when the server omits the isError flag', () => {
  // This is the real Penpot behaviour, and reading only the flag caused every
  // MCP failure to be treated as a success.
  assert.equal(
    looksLikeToolFailure(
      'Tool execution failed: Error: No Penpot instance connected for user token. Please ensure that Penpot is connected and that the MCP client connection is using the correct token.',
    ),
    true,
  );
  assert.equal(looksLikeToolFailure('The Penpot plugin tab has been frozen by the browser and cannot run tasks.'), true);
  assert.equal(looksLikeToolFailure('No userToken found in session context.'), true);

  // Successful results must not be misread as failures.
  assert.equal(looksLikeToolFailure('{"result":{"boardId":"b1"},"log":""}'), false);
  assert.equal(looksLikeToolFailure('Exported page as png'), false);
  assert.equal(looksLikeToolFailure(''), false);
  assert.equal(looksLikeToolFailure(undefined), false);
});