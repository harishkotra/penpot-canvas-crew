/**
 * Tests for reading a finished run back off disk.
 *
 * This is the path `npm run report` uses, and it was where the report could
 * link a PNG that did not exist. It reads files a user may have moved or
 * deleted, so every missing file has to degrade rather than throw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectRounds, buildReport } from '../src/report.js';

function makeRun() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-report-'));
  // Round 1: complete, with a real PNG.
  const r1 = join(dir, 'round-1');
  mkdirSync(r1, { recursive: true });
  writeFileSync(join(r1, 'code.js'), 'const a = 1;\nconst b = 2;');
  writeFileSync(join(r1, 'board.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(
    join(r1, 'audit.json'),
    JSON.stringify({ checked: 4, failures: 1, findings: [{ severity: 'blocker', area: 'hero', issue: 'x', fix: 'y' }] }),
  );
  writeFileSync(
    join(r1, 'critique.json'),
    JSON.stringify({ score: 5, findings: [], summary: 'first pass', strengths: ['ok'], visual: true }),
  );
  writeFileSync(join(r1, 'verdict.json'), JSON.stringify({ decision: 'revise', rule: 'blockers', reason: 'one blocker' }));

  // Round 2: export failed, so no board.png, and only code.js survived.
  const r2 = join(dir, 'round-2');
  mkdirSync(r2, { recursive: true });
  writeFileSync(join(r2, 'code.js'), 'const c = 3;');
  writeFileSync(join(r2, 'export-error.txt'), 'export_shape returned no image block.');

  return dir;
}

test('collectRounds reads a complete round faithfully', (t) => {
  const dir = makeRun();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const rounds = collectRounds(dir, [
    { round: 1, score: 5, verdict: 'revise' },
    { round: 2, score: 7, verdict: 'revise' },
  ]);

  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].imageUrl, 'round-1/board.png');
  assert.equal(rounds[0].codeLines, 2);
  assert.equal(rounds[0].audit.failures, 1);
  assert.equal(rounds[0].critique.visual, true);
  // The persisted arbiter decision wins over the critic verdict.
  assert.equal(rounds[0].verdict.decision, 'revise');
  assert.equal(rounds[0].verdict.rule, 'blockers');
});

test('collectRounds never references a PNG that is not on disk', (t) => {
  const dir = makeRun();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const rounds = collectRounds(dir, [{ round: 2, score: 7, verdict: 'revise' }]);
  assert.equal(rounds[0].imageUrl, undefined, 'round 2 has no board.png so it must not be linked');
  assert.match(rounds[0].exportError, /no image block/);
});

test('collectRounds degrades to defaults for a round with missing files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-report-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const rounds = collectRounds(dir, [{ round: 1, score: 6, verdict: 'revise' }]);
  assert.equal(rounds[0].codeLines, 0);
  assert.deepEqual(rounds[0].critique.findings, []);
  assert.equal(rounds[0].audit.checked, 0);
  assert.equal(rounds[0].verdict.rule, 'recorded');
});

test('collectRounds tolerates corrupt JSON instead of throwing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-report-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r1 = join(dir, 'round-1');
  mkdirSync(r1, { recursive: true });
  writeFileSync(join(r1, 'audit.json'), '{ this is not json');
  writeFileSync(join(r1, 'critique.json'), 'nor is this');

  const rounds = collectRounds(dir, [{ round: 1, score: 4, verdict: 'revise' }]);
  assert.equal(rounds[0].audit.checked, 0);
  assert.deepEqual(rounds[0].critique.findings, []);
});

test('buildReport renders a run whose rounds are all missing data', () => {
  const html = buildReport({
    brief: 'nothing',
    config: { models: {} },
    rounds: [],
    history: [],
    verdict: {},
    transcript: '',
  });
  assert.match(html, /No rounds were completed/);
  assert.match(html, /Canvas Crew/);
});

test('buildReport does not crash on a partially populated round', () => {
  const html = buildReport({
    brief: 'partial',
    config: { models: { planner: 'p', builder: 'b', critic: 'c', arbiter: 'a' } },
    rounds: [{ round: 1, codeLines: 0 }],
    history: [{ round: 1, score: 3 }],
    verdict: { decision: 'halt', rule: 'budget', reason: 'out of rounds' },
    transcript: 'x',
  });
  assert.match(html, /Round 1/);
  assert.match(html, /No findings/);
  assert.match(html, /No render captured/);
});