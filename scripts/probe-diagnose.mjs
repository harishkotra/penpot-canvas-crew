/**
 * Diagnostic: run the real capability probe with the raw responses printed.
 * Throwaway tool, not part of the crew.
 */
import { loadDotEnv, loadConfig } from '../src/config.js';
import { ChatClient, probeImageDataUrl, extractJson } from '../src/models.js';

loadDotEnv();
const config = loadConfig();
const client = new ChatClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 90_000 });

for (const model of ['glm5.3flash', 'deepseek-v4.1-flash']) {
  console.log(`\n===== ${model} =====`);

  // Vision, exactly as the probe does it.
  try {
    const res = await client.vision({
      model,
      prompt: 'One word: what are the two colours, left then right?',
      imageUrl: probeImageDataUrl(),
      maxTokens: 40,
    });
    console.log('vision raw content:', JSON.stringify(res.text));
    console.log('vision regex pass:', /red/i.test(res.text) && /blue/i.test(res.text));
  } catch (e) {
    console.log('vision threw:', e.message);
  }

  // JSON, exactly as the probe does it (max_tokens 80, json_object).
  for (let i = 0; i < 2; i++) {
    try {
      const res = await client.chat({
        model,
        max_tokens: 80,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Return JSON with keys board and layers_count for a login screen.' }],
      });
      const c = res?.choices?.[0]?.message?.content;
      console.log(`json try ${i + 1}: len=${c?.length ?? 0} parsed=${extractJson(c) !== undefined} head=${JSON.stringify(c)?.slice(0, 80)}`);
    } catch (e) {
      console.log(`json try ${i + 1} threw:`, e.message);
    }
  }
}