/**
 * Minimal MCP client over Streamable HTTP, for Penpot's MCP server.
 *
 * Dependency free: Node 20+ has global fetch, and the transport is just
 * JSON-RPC posted to one endpoint with a session header.
 *
 * Penpot's server specifics, all of which cost real debugging time:
 *   - requires ?userToken=<key> on the URL (it always runs --multi-user)
 *   - replies as SSE (`event: message` then `data: {...}`)
 *   - returns a `mcp-session-id` header on initialize that must be echoed back
 *   - the plugin lives in a browser tab, so the tab can be FROZEN and every
 *     file-touching call then fails with a specific, actionable message
 */

export class PluginFrozenError extends Error {
  constructor(detail) {
    super(
      'The Penpot plugin tab has been frozen by the browser, so it cannot run tasks.\n' +
        'Fix: click into the Penpot tab to wake it, then re-run.\n' +
        'Prevent: pin the tab, and in Chrome add your Penpot site under\n' +
        '  Settings -> Performance -> "Always keep these sites active".\n' +
        `Server said: ${detail}`,
    );
    this.name = 'PluginFrozenError';
    this.frozen = true;
  }
}

export class PluginMissingError extends Error {
  constructor(detail) {
    super(
      'No Penpot plugin is connected to this MCP session.\n' +
        'Fix: open your Penpot design file, then File -> MCP Server -> Connect, and leave that tab open.\n' +
        `Server said: ${detail}`,
    );
    this.name = 'PluginMissingError';
    this.missing = true;
  }
}

let rpcId = 0;

/** Parse a Streamable HTTP reply: SSE frames if present, else bare JSON. */
export function parsePayload(text) {
  const messages = [];
  let sawSse = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith('data:')) continue;
    sawSse = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      /* partial frame, ignore */
    }
  }
  if (!sawSse && String(text).trim()) {
    try {
      messages.push(JSON.parse(text));
    } catch {
      /* not JSON, ignore */
    }
  }
  return messages;
}

export function firstResult(messages) {
  for (const m of messages) {
    if (m && typeof m === 'object' && m.result) return m.result;
  }
  return undefined;
}

export function firstError(messages) {
  for (const m of messages) {
    if (m && typeof m === 'object' && m.error) {
      const err = m.error;
      return String(err.message ?? JSON.stringify(err));
    }
  }
  return undefined;
}

/**
 * Penpot's MCP server reports tool failures as ordinary text content with the
 * `isError` flag absent, so `Boolean(result.isError)` is false and a failed
 * call looks like a successful one. That is how a broken plugin connection
 * turns into a silent no-op.
 *
 * These patterns are deliberately anchored and specific: a *successful*
 * execute_code can legitimately return data containing the word "Error".
 */
const TOOL_FAILURE_PATTERNS = [
  /^Tool execution failed/i,
  /^Error:/i,
  /No Penpot instance connected/i,
  /frozen by the browser/i,
  /No userToken found in session context/i,
];

export function looksLikeToolFailure(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return TOOL_FAILURE_PATTERNS.some((re) => re.test(t));
}

/** Classify a raw tool failure into something actionable. */
export function classifyToolFailure(text) {
  const t = String(text || '');
  if (/frozen by the browser|cannot run tasks/i.test(t)) return new PluginFrozenError(t);
  if (/no usertoken found/i.test(t)) {
    return new Error(
      'MCP rejected the call: no userToken in session context. Append ?userToken=<key> to PENPOT_MCP_URL.',
    );
  }
  if (/no penpot instance connected|plugin|precondition|not connected/i.test(t)) return new PluginMissingError(t);
  return new Error(t || 'Unknown MCP failure');
}

export class McpClient {
  /**
   * @param {string} url endpoint including ?userToken=
   * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [opts]
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sessionId = undefined;
    this.serverInfo = undefined;
  }

  async post(body, timeoutMs, sessionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, sessionId: res.headers.get('mcp-session-id') ?? undefined, text };
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(
          `MCP request timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            'If this was execute_code, the Penpot plugin is probably not connected, or the tab is asleep.',
        );
      }
      throw new Error(`Cannot reach the MCP endpoint (${this.url.split('?')[0]}): ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** initialize + notifications/initialized. */
  async open() {
    const init = await this.post(
      {
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'penpot-canvas-crew', version: '1.0.0' },
        },
      },
      20_000,
      undefined,
    );
    if (init.status >= 400) {
      throw new Error(`MCP initialize failed with HTTP ${init.status}: ${init.text.slice(0, 300)}`);
    }
    const messages = parsePayload(init.text);
    const err = firstError(messages);
    if (err) throw new Error(`MCP initialize error: ${err}`);
    const result = firstResult(messages);
    if (!result) {
      throw new Error(
        'MCP initialize returned no result. Check the URL points at /mcp/stream and includes ?userToken=<key>.',
      );
    }
    this.sessionId = init.sessionId;
    this.serverInfo = result.serverInfo;
    if (this.sessionId) {
      await this.post(
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        20_000,
        this.sessionId,
      ).catch(() => undefined);
    }
    return { sessionId: this.sessionId, serverInfo: this.serverInfo, instructions: result.instructions };
  }

  async listTools() {
    const res = await this.post(
      { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} },
      20_000,
      this.sessionId,
    );
    const messages = parsePayload(res.text);
    const err = firstError(messages);
    if (err) throw new Error(`tools/list error: ${err}`);
    return firstResult(messages)?.tools ?? [];
  }

  /**
   * Call a tool. Returns { isError, text, image, raw }.
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {{timeoutMs?: number}} [opts]
   */
  async callTool(name, args, opts = {}) {
    const res = await this.post(
      { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
      opts.timeoutMs ?? this.timeoutMs,
      this.sessionId,
    );
    const messages = parsePayload(res.text);
    const err = firstError(messages);
    if (err) return { isError: true, text: err, raw: messages };
    const result = firstResult(messages);
    if (!result) {
      return { isError: true, text: `Tool "${name}" returned no result (HTTP ${res.status}).`, raw: messages };
    }
    const blocks = result.content ?? [];
    const texts = [];
    let image;
    for (const block of blocks) {
      if (block?.type === 'image' && block.data) {
        image = { data: block.data, mimeType: block.mimeType ?? 'image/png' };
      } else if (typeof block?.text === 'string') {
        texts.push(block.text);
      }
    }
    const text = texts.join('\n');
    // Detect failure from the content, not just the flag: Penpot omits isError.
    const isError = Boolean(result.isError) || looksLikeToolFailure(text);
    return { isError, text, image, raw: result };
  }

  /**
   * Run Plugin API JavaScript. Throws a classified error on failure so the
   * caller can tell "your tab is asleep" from "your code was wrong".
   */
  async executeCode(code, opts = {}) {
    const res = await this.callTool('execute_code', { code }, opts);
    if (res.isError) throw classifyToolFailure(res.text);
    return res;
  }

  /** Export a shape (or the whole page) as an image. */
  async exportShape(shapeId, format = 'png', opts = {}) {
    const res = await this.callTool('export_shape', { shapeId, format, mode: 'shape' }, opts);
    if (res.isError) throw classifyToolFailure(res.text);
    return res;
  }
}

/**
 * Penpot's execute_code returns {"result": <value>, "log": ""} as a JSON
 * *string* inside a text block. Unwrap it when possible.
 */
export function unwrapExecuteResult(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'result' in parsed) return parsed.result;
    return parsed;
  } catch {
    return text;
  }
}

/** Turn a tool result into a data URL, if it carried an image. */
export function imageDataUrl(result) {
  if (result?.image) return `data:${result.image.mimeType};base64,${result.image.data}`;
  const text = String(result?.text ?? '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  const b64 = text.match(/^[A-Za-z0-9+/=\s]{512,}$/);
  if (b64) return `data:image/png;base64,${b64[0].replace(/\s+/g, '')}`;
  return undefined;
}

/** Convenience: open a session and confirm a plugin is actually attached. */
export async function connect(url, opts = {}) {
  const client = new McpClient(url, opts);
  await client.open();
  return client;
}