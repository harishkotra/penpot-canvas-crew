#!/usr/bin/env node
/**
 * Offline demo run.
 *
 * Runs the real crew against the mock Penpot server and the mock inference
 * server, so you can see a complete run and open a real report.html without
 * needing Penpot running, a browser tab awake, or an API key.
 *
 * The mock model follows a fixed trajectory (5 -> 7 -> 9) whose first round
 * fails the computed contrast gate, so the demo shows the argument actually
 * happening: a blocker, a revision, and a convergence.
 *
 * This is a DEMO, not a design. The renders are a placeholder image.
 */

import { rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCrew } from '../src/crew.js';
import { startMockMcp } from '../test/mock-mcp.mjs';
import { startMockLlm } from '../test/mock-llm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runsDir = resolve(ROOT, 'runs', 'demo-offline');
rmSync(runsDir, { recursive: true, force: true });
mkdirSync(runsDir, { recursive: true });

const mcp = await startMockMcp();
const llm = await startMockLlm({ trajectory: [5, 7, 9] });

const config = {
  mcpUrl: mcp.url,
  baseUrl: llm.url,
  apiKey: 'offline-demo',
  models: {
    planner: 'glm5.3flash (mock)',
    builder: 'deepseek-v4.1-flash (mock)',
    critic: 'glm5.3flash (mock)',
    arbiter: 'glm5.3flash (mock)',
  },
  maxRounds: 4,
  passScore: 8,
  boardName: 'Crew',
  timeoutMs: 30_000,
  runsDir,
};

console.log('Canvas Crew — offline demo (mock Penpot + mock models)\n');

const result = await runCrew({
  config,
  brief: 'a landing page for a local-first design agent that runs entirely on your own machine',
  log: (line) => console.log(line),
});

console.log('');
console.log(`Report: ${result.reportPath}`);
console.log(`Run dir: ${result.runDir}`);

await mcp.close();
await llm.close();