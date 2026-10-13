#!/usr/bin/env node
/**
 * Canvas Crew CLI.
 *
 *   node src/cli.js check                       probe MCP + model capabilities
 *   node src/cli.js run --brief "..."           run the crew
 *   node src/cli.js report <runDir>             regenerate the HTML report from disk
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadDotEnv, loadConfig, assertRunnable } from './config.js';
import { ChatClient, probeCapabilities, assertRouting, KNOWN_CAPABILITIES } from './models.js';
import { McpClient } from './mcp.js';
import { runCrew } from './crew.js';
import { buildReport, collectRounds } from './report.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

/** Read `--name value`. Returns true when the flag is present with no value. */
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const log = (line) => process.stdout.write(`${line}\n`);

/** Read a file, returning a fallback instead of throwing when it is absent. */
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

loadDotEnv();

async function cmdCheck() {
  const config = loadConfig();
  log('Canvas Crew self-check');
  log('======================');

  if (!config.mcpUrl) {
    log('MCP: PENPOT_MCP_URL is not set. Copy .env.example to .env first.');
  } else {
    log(`MCP: ${config.mcpUrl.split('?')[0]}`);
    log(`  userToken: ${/userToken=/.test(config.mcpUrl) ? 'present' : 'MISSING (every file call will fail)'}`);
    try {
      const client = new McpClient(config.mcpUrl, { timeoutMs: 30_000 });
      const info = await client.open();
      log(`  connected: ${info.serverInfo?.name ?? '?'} ${info.serverInfo?.version ?? ''}`);
      const tools = await client.listTools();
      log(`  tools: ${tools.map((t) => t.name).join(', ')}`);
      try {
        await client.executeCode('return { ok: true, file: penpot.currentFile.name };');
        log('  plugin: CONNECTED and responsive');
      } catch (err) {
        log(`  plugin: NOT USABLE - ${String(err.message).split('\n')[0]}`);
        log('    (this is the state to fix before running the crew)');
      }
    } catch (err) {
      log(`  FAILED: ${String(err.message).split('\n')[0]}`);
    }
  }

  log('');
  if (!config.apiKey) {
    log('Models: PARTICLE_API_KEY is not set, skipping capability probe.');
    return;
  }

  const client = new ChatClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 60_000 });
  const unique = [...new Set(Object.values(config.models))];
  log(`Models at ${config.baseUrl} (probing ${unique.length} unique model(s))`);
  const capabilities = {};
  for (const model of unique) {
    try {
      const caps = await probeCapabilities(client, model);
      capabilities[model] = caps;
      log(
        `  ${model.padEnd(22)} tools=${caps.tools ? 'yes' : 'NO '} vision=${caps.vision ? 'yes' : 'NO '} json=${
          caps.json ? 'yes' : 'NO '
        }`,
      );
      for (const [k, v] of Object.entries(caps.errors)) {
        log(`      ${k} probe note: ${String(v).split('\n')[0]}`);
      }
    } catch (err) {
      log(`  ${model}: probe failed - ${String(err.message).split('\n')[0]}`);
    }
  }

  log('');
  const routing = assertRouting(config.models, capabilities);
  if (routing.ok) {
    log('Routing: OK, every role has the capability it needs.');
  } else {
    log('Routing: PROBLEMS');
    for (const p of routing.problems) log(`  - ${p}`);
  }
  for (const w of routing.warnings) log(`  warning: ${w}`);

  const known = Object.keys(KNOWN_CAPABILITIES).filter((m) => !unique.includes(m));
  if (known.length) log(`\nNote: ${known.join(', ')} known but not routed to any role.`);
}

async function cmdRun() {
  const config = loadConfig();
  assertRunnable(config);

  const brief = flag('brief');
  if (!brief || brief === true) {
    throw new Error('Usage: node src/cli.js run --brief "a landing page for a local-first design agent"');
  }

  const rounds = flag('rounds');
  if (rounds !== undefined && rounds !== true) {
    const n = Number(rounds);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      throw new Error(`--rounds must be a whole number from 1 to 10 (got "${rounds}").`);
    }
    config.maxRounds = n;
  }

  const board = flag('board');
  if (board && board !== true) {
    const name = String(board).trim();
    if (!name) throw new Error('--board must not be empty.');
    config.boardName = name;
  }

  const result = await runCrew({ config, brief: String(brief), log });
  log('');
  log(`Run directory: ${result.runDir}`);
  log(`Report:        ${result.reportPath}`);
  log(`Verdict:       ${result.verdict.decision.toUpperCase()} (${result.verdict.rule})`);
  log(`Scores:        ${result.history.map((h) => h.score).join(' -> ') || '(none)'}`);
  if (result.verdict.rule === 'unexpected-error') {
    log(`Error:         ${result.verdict.reason}`);
  }
  if (result.verdict.decision !== 'accept') process.exitCode = 1;
}

/** Rebuild report.html for a finished run, reading only what is on disk. */
async function cmdReport() {
  const dir = resolve(args[1] ?? '');
  if (!args[1]) throw new Error('Usage: node src/cli.js report <runDir>');
  if (!existsSync(dir)) throw new Error(`No such run directory: ${dir}`);

  const brief = readText(join(dir, 'brief.txt'), '');
  const history = readJson(join(dir, 'history.json'));
  const verdict = readJson(join(dir, 'verdict.json'));
  const transcript = readText(join(dir, 'transcript.md'), '');
  if (!history || !verdict) {
    throw new Error(`${dir} does not look like a run directory (history.json or verdict.json missing).`);
  }

  const config = loadConfig();
  const rounds = collectRounds(dir, history);

  const out = join(dir, 'report.html');
  writeFileSync(out, buildReport({ brief, config, rounds, history, verdict, transcript }));
  log(`Wrote ${out} (${rounds.length} round(s))`);
}

function usage() {
  log(`Canvas Crew

  node src/cli.js check                          probe MCP and model capabilities
  node src/cli.js run --brief "..." [--rounds N] [--board NAME]
  node src/cli.js report <runDir>                regenerate report.html from a run directory
`);
}

try {
  if (command === 'check') await cmdCheck();
  else if (command === 'run') await cmdRun();
  else if (command === 'report') await cmdReport();
  else usage();
} catch (err) {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exitCode = 2;
}