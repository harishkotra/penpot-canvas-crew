/**
 * Configuration.
 *
 * Zero dependencies on purpose: a 20-line .env reader beats pulling dotenv
 * into a project whose whole selling point is that it runs on your machine
 * with nothing installed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse a .env file into an object. Missing file is not an error. */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, if present.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load .env (if present) without clobbering real environment variables. */
export function loadDotEnv(path = resolve(ROOT, '.env')) {
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    mcpUrl: env.PENPOT_MCP_URL || '',
    baseUrl: env.PARTICLE_BASE_URL || 'https://api.particle.ai/v1',
    apiKey: env.PARTICLE_API_KEY || env.OPENAI_API_KEY || '',
    models: {
      planner: env.CREW_PLANNER_MODEL || 'glm5.3flash',
      builder: env.CREW_BUILDER_MODEL || 'deepseek-v4.1-flash',
      critic: env.CREW_CRITIC_MODEL || 'glm5.3flash',
      arbiter: env.CREW_ARBITER_MODEL || 'glm5.3flash',
    },
    maxRounds: num(env.CREW_MAX_ROUNDS, 4),
    passScore: num(env.CREW_PASS_SCORE, 8),
    boardName: env.CREW_BOARD_NAME || 'Crew',
    timeoutMs: num(env.CREW_TIMEOUT_MS, 180_000),
    // The Penpot plugin drops when its tab loses focus, which is what happens
    // when you launch the crew from a terminal on the same machine. The default
    // retry window is about 75 seconds, long enough for a human to click back.
    retry: {
      attempts: num(env.CREW_RETRY_ATTEMPTS, 6),
      delayMs: num(env.CREW_RETRY_DELAY_MS, 5000),
    },
    // Token ceilings per role. These are generous because on endpoints that
    // serve reasoning models, reasoning tokens are drawn from the SAME budget
    // as the answer. A 7-section spec made the builder burn 16000 tokens
    // thinking and return zero characters of code at a 4000 budget.
    maxTokens: {
      planner: num(env.CREW_PLANNER_MAX_TOKENS, 8000),
      builder: num(env.CREW_BUILDER_MAX_TOKENS, 16000),
      critic: num(env.CREW_CRITIC_MAX_TOKENS, 4000),
      arbiter: num(env.CREW_ARBITER_MAX_TOKENS, 1200),
    },
    runsDir: env.CREW_RUNS_DIR || resolve(ROOT, 'runs'),
  };
}

/** Fail fast with a message that says what to fix, not just what is wrong. */
export function assertRunnable(config) {
  const problems = [];
  if (!config.mcpUrl) {
    problems.push('PENPOT_MCP_URL is not set. Copy .env.example to .env and paste your Penpot MCP URL (with ?userToken=...).');
  } else if (!/userToken=/.test(config.mcpUrl)) {
    problems.push('PENPOT_MCP_URL has no ?userToken=. Penpot always runs the MCP server in multi-user mode, so every file-touching call fails without it.');
  }
  if (!config.apiKey) {
    problems.push('PARTICLE_API_KEY is not set.');
  }
  if (problems.length) {
    throw new Error(`Cannot start:\n  - ${problems.join('\n  - ')}`);
  }
}