/**
 * Diagnostic: reproduce the builder call against a real spec and print the raw
 * response shape. Throwaway tool for tracking down an empty code response.
 */
import { readFileSync } from 'node:fs';

import { loadDotEnv, loadConfig } from '../src/config.js';
import { ChatClient } from '../src/models.js';
import { builderSystem, builderUser } from '../src/prompts.js';
import { extractCode } from '../src/roles/builder.js';

loadDotEnv();
const config = loadConfig();
const client = new ChatClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 300_000 });

const specPath = process.argv[2] ?? '/tmp/his-spec.json';
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const boardName = 'Crew';

console.log(`spec: ${specPath} (${JSON.stringify(spec).length} bytes, ${spec.sections?.length} sections)`);
console.log(`builder model: ${config.models.builder}`);
console.log('');

const system = builderSystem(boardName);
const user = builderUser(spec);
console.log(`prompt: system ${system.length} chars, user ${user.length} chars`);
console.log('');

for (const maxTokens of [4000, 16000]) {
  console.log(`=== max_tokens ${maxTokens} ===`);
  const started = Date.now();
  let res;
  try {
    res = await client.chat({
      model: config.models.builder,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    });
  } catch (err) {
    console.log(`  request failed: ${err.message}`);
    continue;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const choice = res?.choices?.[0];
  const msg = choice?.message ?? {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const reasoning = msg.reasoning_content ?? msg.reasoning ?? '';

  console.log(`  ${secs}s  finish_reason=${choice?.finish_reason}`);
  console.log(`  message keys: ${Object.keys(msg).join(', ')}`);
  console.log(`  usage: ${JSON.stringify(res?.usage ?? {})}`);
  console.log(`  content: ${content.length} chars`);
  console.log(`  reasoning: ${String(reasoning).length} chars`);
  console.log(`  extractCode -> ${extractCode(content).length} chars`);
  console.log(`  content head: ${JSON.stringify(content.slice(0, 160))}`);
  console.log('');
}