/**
 * OpenAI-compatible inference client + model capability registry.
 *
 * The registry matters more than the client. Every role in the crew needs a
 * different capability, and cheap models are not interchangeable:
 *
 *   planner -> JSON mode          (structured brief -> structured spec)
 *   builder -> tool calling       (emits Plugin API JavaScript)
 *   critic  -> VISION             (looks at the exported PNG)
 *   arbiter -> JSON mode
 *
 * Measured on a Particle.ai key (2026-10):
 *   deepseek-v4.1-flash : tools yes | vision NO  | json NO
 *   glm5.3flash         : tools yes | vision YES | json YES
 *
 * Rather than trust a hardcoded table, `probeCapabilities` measures it, and
 * `assertRouting` refuses to start a run whose roles cannot be served.
 */

export class ModelError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ModelError';
    this.detail = detail;
  }
}

/** Known capabilities. Anything absent is probed at runtime. */
export const KNOWN_CAPABILITIES = {
  'deepseek-v4.1-flash': { tools: true, vision: false, json: false },
  'glm5.3flash': { tools: true, vision: true, json: true },
};

/** A 2x2 PNG split left/right red and blue, used to actually test vision. */
export function probeImageDataUrl() {
  // Verified bytes: 2x2, 8-bit RGB, left column red (#FF0000), right column blue (#0000FF).
  // Generated with zlib and round-trip decoded, not typed from memory.
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4zwAE/xkgFAAb8gP9PpddpAAAAABJRU5ErkJggg==';
  return `data:image/png;base64,${png}`;
}

export class ChatClient {
  /**
   * @param {{baseUrl: string, apiKey: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
   */
  constructor(opts) {
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.calls = 0;
  }

  /**
   * @param {Record<string, unknown>} payload
   * @param {{retries?: number, timeoutMs?: number, retryOnEmpty?: boolean}} [opts]
   * @returns {Promise<any>} the raw chat completion object
   *
   * Empty-content retry: this endpoint serves reasoning models that emit a
   * `reasoning_content` field, and reasoning tokens are drawn from the same
   * `max_tokens` budget. With a small budget the model can spend everything on
   * reasoning and return an empty `content` string. That is not a failure of
   * the request, so we retry with a larger budget instead of reporting an
   * empty answer. Measured directly: identical prompts at max_tokens=80 return
   * "" intermittently and valid JSON at max_tokens=400.
   */
  async chat(payload, { retries = 2, timeoutMs, retryOnEmpty = true } = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    let lastErr;
    let body = { ...payload };
    let lastParsed;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
      try {
        this.calls++;
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          // 4xx other than 429 will not fix themselves: fail fast and loudly.
          if (res.status < 500 && res.status !== 429) {
            throw new ModelError(
              `Inference call failed with HTTP ${res.status} for model ${payload.model}.`,
              text.slice(0, 400),
            );
          }
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const parsed = JSON.parse(text);
        lastParsed = parsed;

        const choice = parsed?.choices?.[0];
        const msg = choice?.message;
        const empty = !contentOf(parsed) && !msg?.tool_calls?.length;
        // A response cut off at the token ceiling is just as unusable as an
        // empty one, and it is not a capability signal either. Retry bigger.
        const truncated = choice?.finish_reason === 'length';
        if (retryOnEmpty && (empty || truncated) && attempt < retries) {
          if (typeof body.max_tokens === 'number') {
            body = { ...body, max_tokens: Math.min(body.max_tokens * 3, 48_000) };
          }
          continue;
        }
        return parsed;
      } catch (err) {
        lastErr = err;
        if (err instanceof ModelError) throw err;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastParsed) return lastParsed;
    throw new ModelError(`Inference call failed after retries for model ${payload.model}.`, String(lastErr?.message ?? lastErr));
  }

  /**
   * Plain text completion, with usage. Usage matters: on these endpoints
   * reasoning tokens are billed against the same budget as the answer, so
   * `reasoning_tokens === max_tokens` with empty content means the model spent
   * the whole budget thinking. That is a budgeting bug, not a model failure.
   */
  async textWithUsage({ model, system, user, maxTokens = 2000, temperature = 0.4 }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const res = await this.chat({ model, messages, max_tokens: maxTokens, temperature });
    return { text: contentOf(res), usage: res.usage };
  }

  /** Plain text completion. */
  async text(opts) {
    return (await this.textWithUsage(opts)).text;
  }

  /** Ask for JSON. Uses response_format when the model supports it. */
  async json({ model, system, user, maxTokens = 2000, temperature = 0.2, supportsJsonMode = true }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const payload = { model, messages, max_tokens: maxTokens, temperature };
    if (supportsJsonMode) payload.response_format = { type: 'json_object' };

    let res = await this.chat(payload);
    let raw = contentOf(res);

    // If json mode produced nothing usable, ask again without it. Some
    // endpoints accept response_format and then return an empty body.
    if (supportsJsonMode && extractJson(raw) === undefined) {
      const retry = await this.chat({ model, messages, max_tokens: Math.max(maxTokens, 2000), temperature });
      const retryRaw = contentOf(retry);
      if (extractJson(retryRaw) !== undefined) {
        res = retry;
        raw = retryRaw;
      }
    }

    const parsed = extractJson(raw);
    if (parsed === undefined) {
      throw new ModelError(
        `Model ${model} did not return parseable JSON for a structured role.`,
        String(raw).slice(0, 400),
      );
    }
    return { value: parsed, raw, usage: res.usage };
  }

  /**
   * Ask about an image. Requires a vision-capable model.
   *
   * `system` matters: without it a vision model has no output contract and
   * replies with prose, which then cannot be parsed. That was a real bug.
   */
  async vision({ model, system, prompt, imageUrl, maxTokens = 1200, temperature = 0.2 }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    });
    const res = await this.chat({ model, messages, max_tokens: maxTokens, temperature });
    return { text: contentOf(res), usage: res.usage };
  }
}

function contentOf(res) {
  const msg = res?.choices?.[0]?.message;
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/**
 * Tolerant JSON extraction: strips markdown fences and prose, then takes the
 * first balanced object or array. Models wrap JSON in prose constantly.
 */
export function extractJson(text) {
  if (text === undefined || text === null) return undefined;
  let s = String(text).trim();
  const fenced = s.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  if (fenced?.[1]) s = fenced[1].trim();

  const start = firstIndexOf(s, ['{', '[']);
  if (start === -1) return undefined;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function firstIndexOf(s, chars) {
  let best = -1;
  for (const c of chars) {
    const i = s.indexOf(c);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/** Measure what a model can actually do. Real calls, generous budgets. */
export async function probeCapabilities(client, model) {
  const caps = { model, tools: false, vision: false, json: false, errors: {} };

  // Note on budgets: these were originally tiny (40/80 tokens) and produced
  // false negatives, because reasoning tokens share the max_tokens budget and
  // an empty content string looks exactly like a missing capability. Budgets
  // here are deliberately generous so the probe measures the model, not the cap.

  try {
    const res = await client.chat({
      model,
      max_tokens: 200,
      tools: [
        {
          type: 'function',
          function: {
            name: 'set_fill',
            description: 'Set a shape fill colour',
            parameters: {
              type: 'object',
              properties: { shape: { type: 'string' }, hex: { type: 'string' } },
              required: ['shape', 'hex'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'Make the header shape pure white. Use the tool.' }],
    });
    caps.tools = Boolean(res?.choices?.[0]?.message?.tool_calls?.length);
  } catch (e) {
    caps.errors.tools = String(e.message ?? e);
  }

  try {
    // Two attempts: empty content is intermittent on this class of endpoint.
    for (let attempt = 0; attempt < 2 && !caps.vision; attempt++) {
      const { text } = await client.vision({
        model,
        prompt: 'One word: what are the two colours, left then right?',
        imageUrl: probeImageDataUrl(),
        maxTokens: 200,
      });
      caps.vision = /red/i.test(text) && /blue/i.test(text);
      if (!caps.vision && attempt === 0) caps.errors.vision = `attempt 1 returned ${JSON.stringify(text).slice(0, 80)}`;
      else if (caps.vision) delete caps.errors.vision;
    }
  } catch (e) {
    caps.errors.vision = String(e.message ?? e);
  }

  try {
    // Ask for the smallest possible object. The first version of this probe
    // asked for a "login screen" description, which models answered with a
    // 1600-character object that got truncated at the token ceiling and then
    // read as "no JSON support". Test the capability, not the token budget.
    for (let attempt = 0; attempt < 2 && !caps.json; attempt++) {
      const res = await client.chat({
        model,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok": true}' },
        ],
      });
      const content = contentOf(res);
      caps.json = extractJson(content) !== undefined;
      if (!caps.json) {
        caps.errors.json = `finish=${res?.choices?.[0]?.finish_reason} content=${JSON.stringify(content).slice(0, 80)}`;
      } else {
        delete caps.errors.json;
      }
    }
  } catch (e) {
    caps.errors.json = String(e.message ?? e);
  }

  return caps;
}

/** What each role needs. Used to validate routing before spending money. */
export const ROLE_REQUIREMENTS = {
  planner: ['json'],
  builder: ['tools'],
  critic: ['vision'],
  arbiter: ['json'],
};

/**
 * Check that the configured model for every role has the capability it needs.
 * Returns { ok, problems, warnings }.
 */
export function assertRouting(models, capabilities) {
  const problems = [];
  const warnings = [];
  for (const [role, needs] of Object.entries(ROLE_REQUIREMENTS)) {
    const model = models[role];
    const caps = capabilities[model];
    if (!caps) {
      warnings.push(`Role "${role}" uses ${model}, which was not probed. Run \`npm run check\`.`);
      continue;
    }
    for (const need of needs) {
      if (!caps[need]) {
        problems.push(
          `Role "${role}" needs ${need}, but ${model} does not support it. ` +
            `Pick a different CREW_${role.toUpperCase()}_MODEL.`,
        );
      }
    }
  }
  return { ok: problems.length === 0, problems, warnings };
}