/**
 * Diagnostic: (1) the exact JSON probe payload, printed raw, and
 * (2) a real planner run against each model, to see which one actually
 * produces a usable specification. Throwaway tool.
 */
import { loadDotEnv, loadConfig } from '../src/config.js';
import { ChatClient, extractJson } from '../src/models.js';
import { PLANNER_SYSTEM, plannerUser } from '../src/prompts.js';
import { normalizeSpec } from '../src/spec.js';

loadDotEnv();
const config = loadConfig();
const client = new ChatClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 120_000 });

const BRIEF = 'a landing page for a local-first design agent that runs entirely on your own machine';

for (const model of ['glm5.3flash', 'deepseek-v4.1-flash']) {
  console.log(`\n################ ${model} ################`);

  // (1) The JSON probe payload, verbatim.
  for (let i = 0; i < 2; i++) {
    const res = await client.chat({
      model,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'Return a JSON object with keys "board" and "layers_count" for a login screen.' }],
    });
    const c = res?.choices?.[0]?.message?.content ?? '';
    console.log(
      `  probe-json try ${i + 1}: len=${c.length} finish=${res?.choices?.[0]?.finish_reason} ` +
        `parsed=${extractJson(c) !== undefined} head=${JSON.stringify(c.slice(0, 100))}`,
    );
  }

  // (2) The real planner prompt.
  const t0 = Date.now();
  try {
    const { value, raw, usage } = await client.json({
      model,
      system: PLANNER_SYSTEM,
      user: plannerUser(BRIEF),
      maxTokens: 3000,
      temperature: 0.35,
      supportsJsonMode: true,
    });
    const spec = normalizeSpec(value, { boardName: 'Crew' });
    console.log(`  planner: ${((Date.now() - t0) / 1000).toFixed(1)}s, raw ${raw.length} chars, usage ${JSON.stringify(usage?.completion_tokens_details ?? {})}`);
    console.log(`  top-level keys: ${JSON.stringify(Object.keys(value))}`);
    console.log(`  normalised: ${spec.sections.length} sections, ${spec.palette.length} colours, ${spec.type_scale.length} type steps`);
    console.log(`  palette: ${spec.palette.map((c) => `${c.name}=${c.hex}`).join(', ')}`);
    console.log(`  section ids: ${spec.sections.map((s) => s.id).join(', ')}`);
    console.log(`  first section text: ${JSON.stringify(spec.sections[0].text.slice(0, 2))}`);
  } catch (e) {
    console.log(`  planner FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
    if (e.detail) console.log(`     detail: ${String(e.detail).slice(0, 200)}`);
  }
}