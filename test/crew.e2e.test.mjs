/**
 * Offline end-to-end run of the whole crew.
 *
 * Drives the real orchestrator, the real MCP client, the real accessibility
 * gate, the real report generator, and the real CLI plumbing against a mock
 * Penpot server and a mock inference server. No network, no Penpot, no keys.
 *
 * The mock model deliberately produces a trajectory (5 -> 7 -> 9) whose first
 * round fails the computed contrast gate, so this test proves the loop actually
 * argues and actually converges, not just that the functions return.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCrew } from '../src/crew.js';
import { McpClient } from '../src/mcp.js';
import { ChatClient, probeCapabilities, assertRouting } from '../src/models.js';
import { startMockMcp } from './mock-mcp.mjs';
import { startMockLlm } from './mock-llm.mjs';

function baseConfig(runsDir, overrides = {}) {
  return {
    mcpUrl: '',
    baseUrl: '',
    apiKey: 'test-key',
    models: {
      planner: 'glm5.3flash',
      builder: 'deepseek-v4.1-flash',
      critic: 'glm5.3flash',
      arbiter: 'glm5.3flash',
    },
    maxRounds: 4,
    passScore: 8,
    boardName: 'Crew',
    timeoutMs: 30_000,
    runsDir,
    // Keep connection retries instant in tests.
    retry: { attempts: 2, delayMs: 1 },
    ...overrides,
  };
}

test('the crew argues, revises, and converges on a passing design', async (t) => {
  const mcp = await startMockMcp();
  const llm = await startMockLlm({ trajectory: [5, 7, 9] });
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-e2e-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url });
  const result = await runCrew({ config, brief: 'a landing page for a local-first design agent' });

  // --- the argument actually happened ---------------------------------------
  assert.equal(result.history.length, 3, `expected 3 rounds, got ${JSON.stringify(result.history)}`);
  assert.deepEqual(result.history.map((h) => h.score), [5, 7, 9]);
  assert.ok(result.history[0].blockers >= 1, 'round 1 must carry the computed contrast blocker');
  assert.equal(result.history[2].blockers, 0);

  // --- and it stopped for the right reason ---------------------------------
  assert.equal(result.verdict.decision, 'accept');
  assert.equal(result.verdict.rule, 'pass-score');

  // --- the spec was revised twice, not regenerated blindly ------------------
  assert.equal(llm.reviseCount, 2, 'expected the planner to be asked to revise twice');
  assert.equal(llm.critiqueCount, 3, 'expected three critiques');

  // --- the canvas was actually driven --------------------------------------
  const toolNames = mcp.calls.map((c) => c.name);
  assert.ok(toolNames.filter((n) => n === 'execute_code').length >= 3, 'expected one render per round');
  assert.ok(toolNames.includes('export_shape'), 'expected the board to be exported for the critic');

  // --- the critic was shown the render, WITH its output contract -----------
  // Omitting the system prompt on the vision path was a real bug: the model
  // answered in prose, the parse failed, and a default score was invented.
  const visionCalls = llm.calls.filter((c) => c.hasImage);
  assert.ok(visionCalls.length >= 3, `expected the render to be shown each round, got ${visionCalls.length}`);
  assert.ok(
    visionCalls.every((c) => /You are the Critic/.test(c.sys)),
    'the vision path must send the critic system prompt, which carries the JSON contract',
  );

  // --- artifacts landed on disk --------------------------------------------
  for (const f of [
    'brief.txt',
    'spec.v1.json',
    'spec.v2.json',
    'spec.v3.json',
    'history.json',
    'verdict.json',
    'transcript.md',
    'report.html',
  ]) {
    assert.ok(existsSync(join(result.runDir, f)), `missing artifact ${f}`);
  }
  for (const round of [1, 2, 3]) {
    for (const f of ['code.js', 'audit.json', 'critique.json', 'board.png']) {
      assert.ok(existsSync(join(result.runDir, `round-${round}`, f)), `missing round-${round}/${f}`);
    }
  }

  // --- the gate separated the bad round from the good ones -----------------
  const audit1 = JSON.parse(readFileSync(join(result.runDir, 'round-1', 'audit.json'), 'utf8'));
  const audit3 = JSON.parse(readFileSync(join(result.runDir, 'round-3', 'audit.json'), 'utf8'));
  assert.ok(audit1.failures > 0, 'round 1 should fail the contrast gate');
  assert.equal(audit3.failures, 0, 'round 3 should pass the contrast gate');

  // --- the exported PNG is a real image ------------------------------------
  const png = readFileSync(join(result.runDir, 'round-1', 'board.png'));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'board.png must be a real PNG');

  // --- the report is a real page with every round in it --------------------
  const html = readFileSync(result.reportPath, 'utf8');
  assert.match(html, /Canvas Crew/);
  assert.match(html, /Round 1/);
  assert.match(html, /Round 3/);
  assert.match(html, /round-1\/board\.png/);
  assert.match(html, /title="round 1: 5\/10">5</); // the trajectory is rendered

  // --- the transcript narrates the argument --------------------------------
  assert.match(result.transcript, /Arbiter: ACCEPT/);
  assert.match(result.transcript, /Planner revised the spec/);
});

test('a planner that changes nothing stops the run instead of burning a round', async (t) => {
  // Re-rendering an identical spec produces an identical canvas and an
  // identical critique, so the extra round cannot help.
  const mcp = await startMockMcp();
  const llm = await startMockLlm({ reviseNoChange: true });
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-nochange-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url });
  const result = await runCrew({ config, brief: 'a landing page for a local-first design agent' });

  assert.equal(result.verdict.decision, 'halt');
  assert.equal(result.verdict.rule, 'no-spec-change');
  assert.equal(result.history.length, 1, 'it must stop after the first fruitless revision');
  assert.match(result.transcript, /0 change\(s\)/);
  assert.match(result.verdict.reason, /spec cannot express/);
});

test('an empty builder reply is diagnosed as a token budget problem, with the raw reply kept', async (t) => {
  // Reproduces the real failure: a reasoning model spent its whole budget
  // thinking and returned zero characters of code. The old code reported a
  // bare "Generated code is empty." and saved nothing, which was undebuggable.
  const mcp = await startMockMcp();
  const llm = await startMockLlm({ builderEmpty: true });
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-emptybuild-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url });
  const result = await runCrew({ config, brief: 'a landing page for a local-first design agent' });

  assert.equal(result.verdict.decision, 'halt');
  assert.equal(result.verdict.rule, 'build-failure');
  assert.match(result.verdict.reason, /reasoning tokens/, 'the reason must name the real cause');
  assert.match(result.transcript, /reasoning tokens/);

  // The token accounting and the raw reply must both be on disk.
  const err = JSON.parse(readFileSync(join(result.runDir, 'round-1', 'build-error.json'), 'utf8'));
  assert.equal(err.usage.completion_tokens, 16000);
  assert.equal(err.usage.completion_tokens_details.reasoning_tokens, 16000);
  assert.ok(existsSync(join(result.runDir, 'round-1', 'builder-raw.txt')));
});

test('a frozen Penpot tab stops the run before planning, with the fix', async (t) => {
  const mcp = await startMockMcp({ mode: 'frozen' });
  const llm = await startMockLlm();
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-frozen-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url });
  const result = await runCrew({ config, brief: 'anything' });

  assert.equal(result.verdict.decision, 'halt');
  // The precondition catches it before a single model call is spent.
  assert.equal(result.verdict.rule, 'plugin-unavailable');
  assert.match(result.verdict.reason, /frozen/i);
  assert.match(result.transcript, /Always keep these sites active/);
  assert.equal(llm.calls.length, 0, 'no model call should be spent when the plugin is dead');
  assert.ok(!existsSync(join(result.runDir, 'round-1')), 'no round should have started');
});

test('a critic that replies in prose halts instead of inventing a score', async (t) => {
  // Reproduces the real failure from a live run: the vision model answered in
  // markdown, the JSON parse failed, and the loop carried on against a made-up
  // 5/10. It must stop instead, and say why.
  const mcp = await startMockMcp();
  const llm = await startMockLlm({ criticProse: true });
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-prose-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url });
  const result = await runCrew({ config, brief: 'a landing page for a local-first design agent' });

  assert.equal(result.verdict.decision, 'halt');
  assert.equal(result.verdict.rule, 'critique-unparsed');

  // No invented score anywhere.
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].score, null, 'a score must not be invented');
  assert.equal(result.history[0].parsed, false);

  // The render is still saved, so the run is inspectable.
  assert.ok(existsSync(join(result.runDir, 'round-1', 'board.png')));
  const critique = JSON.parse(readFileSync(join(result.runDir, 'round-1', 'critique.json'), 'utf8'));
  assert.equal(critique.score, null);
  assert.match(String(critique.raw), /# Critique/, 'the raw prose reply must be preserved');

  assert.match(result.transcript, /NOT parseable JSON/);
  assert.ok(readFileSync(result.reportPath, 'utf8').includes('?'), 'the trajectory must show no score');
});

test('the round budget is respected when the design never satisfies the critic', async (t) => {
  const mcp = await startMockMcp();
  const llm = await startMockLlm({ trajectory: [4, 5, 6, 7, 8] }); // never reaches 8 in time
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-budget-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url, maxRounds: 3 });
  const result = await runCrew({ config, brief: 'anything' });

  assert.equal(result.history.length, 3);
  assert.equal(result.verdict.decision, 'halt');
  assert.equal(result.verdict.rule, 'budget');
});

test('capability probing works end to end against the mock models', async (t) => {
  const llm = await startMockLlm();
  t.after(async () => llm.close());

  const client = new ChatClient({ baseUrl: llm.url, apiKey: 'test', timeoutMs: 10_000 });
  const caps = await probeCapabilities(client, 'glm5.3flash');
  assert.equal(caps.tools, true);
  assert.equal(caps.vision, true);
  assert.equal(caps.json, true);

  const routing = assertRouting(
    { planner: 'glm5.3flash', builder: 'deepseek-v4.1-flash', critic: 'glm5.3flash', arbiter: 'glm5.3flash' },
    { 'glm5.3flash': caps, 'deepseek-v4.1-flash': { tools: true, vision: false, json: false } },
  );
  assert.equal(routing.ok, true, JSON.stringify(routing.problems));
});

test('the MCP client surfaces a frozen plugin as a typed error', async (t) => {
  const mcp = await startMockMcp({ mode: 'frozen' });
  t.after(async () => mcp.close());

  const client = new McpClient(mcp.url, { timeoutMs: 10_000 });
  await client.open();
  await assert.rejects(
    () => client.executeCode('return 1;'),
    (err) => err.frozen === true && /Always keep these sites active/.test(err.message),
  );
});

test('a failure the server did not flag is still raised as an error', async (t) => {
  // Real Penpot puts tool failures in a text block and leaves isError unset.
  // Before this was handled, every failed MCP call looked like a success.
  const mcp = await startMockMcp({ mode: 'soft-fail' });
  t.after(async () => mcp.close());

  const client = new McpClient(mcp.url, { timeoutMs: 10_000 });
  await client.open();
  await assert.rejects(
    () => client.executeCode('return 1;'),
    (err) => err.missing === true,
    'an unflagged failure must still be classified',
  );
});

test('a failed export is recorded, not swallowed, and the critic says it could not see', async (t) => {
  // Regression guard for the live bug: export_shape returned no image, the crew
  // treated it as success, and the report looked healthy while the critic had
  // never seen a pixel.
  const mcp = await startMockMcp({ mode: 'export-fail' });
  const llm = await startMockLlm({ trajectory: [5, 7, 9] });
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-exportfail-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url });
  const result = await runCrew({ config, brief: 'a landing page for a local-first design agent' });

  // The render still happened; only the export broke.
  assert.ok(result.history.length >= 1);
  assert.ok(mcp.calls.some((c) => c.name === 'execute_code'), 'the canvas should still have been driven');

  // The failure is visible in the transcript and in the artifacts.
  assert.match(result.transcript, /Export failed/);
  assert.ok(!existsSync(join(result.runDir, 'round-1', 'board.png')), 'no PNG should be written');
  assert.ok(result.rounds[0].exportError, 'the round must carry the export error');

  // And the critic must not claim it looked at the design.
  assert.equal(result.rounds[0].critique.visual, false);

  // The report must not reference an image that does not exist.
  const html = readFileSync(result.reportPath, 'utf8');
  assert.ok(!html.includes('round-1/board.png'), 'the report must not link a missing PNG');
  assert.match(html, /No render captured/);
});

test('every round persists its own verdict so reports can be regenerated', async (t) => {
  const mcp = await startMockMcp();
  const llm = await startMockLlm({ trajectory: [5, 7, 9] });
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-perround-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url });
  const result = await runCrew({ config, brief: 'a landing page for a local-first design agent' });

  for (const h of result.history) {
    const v = JSON.parse(readFileSync(join(result.runDir, `round-${h.round}`, 'verdict.json'), 'utf8'));
    assert.ok(['accept', 'revise', 'halt'].includes(v.decision), `round ${h.round} verdict.json`);
    assert.ok(v.rule, `round ${h.round} verdict must record which rule decided`);
    // And the last round's decision must match the run verdict.
  }
  const last = JSON.parse(readFileSync(join(result.runDir, `round-${result.history.length}`, 'verdict.json'), 'utf8'));
  assert.equal(last.decision, result.verdict.decision);
});

test('an unexpected error still leaves a complete, diagnosable run on disk', async (t) => {
  // The crew must never lose a run: a crash has to leave the transcript,
  // verdict, history and report behind, or there is nothing to debug.
  const mcp = await startMockMcp();
  const llm = await startMockLlm({ failPlanner: true });
  const runsDir = mkdtempSync(join(tmpdir(), 'crew-crash-'));
  t.after(async () => {
    await mcp.close();
    await llm.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  const config = baseConfig(runsDir, { mcpUrl: mcp.url, baseUrl: llm.url });
  const result = await runCrew({ config, brief: 'this run will fail during planning' });

  assert.equal(result.verdict.decision, 'halt');
  assert.equal(result.verdict.rule, 'unexpected-error');
  assert.match(result.verdict.reason, /HTTP 400/);

  for (const f of ['brief.txt', 'transcript.md', 'verdict.json', 'history.json', 'report.html']) {
    assert.ok(existsSync(join(result.runDir, f)), `a failed run must still write ${f}`);
  }
  assert.match(result.transcript, /unexpected error/i);
  const html = readFileSync(result.reportPath, 'utf8');
  assert.ok(html.includes('unexpected-error'), 'the report must name the rule that stopped the run');
  assert.ok(html.includes('HTTP 400'), 'the report must carry the underlying reason');
});