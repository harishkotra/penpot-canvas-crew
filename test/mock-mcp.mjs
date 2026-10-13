/**
 * A mock Penpot MCP server.
 *
 * Implements just enough of the Streamable HTTP transport to exercise the crew
 * offline: initialize, notifications/initialized, tools/list, tools/call for
 * execute_code and export_shape. Replies as SSE, like the real server.
 *
 * Modes:
 *   normal      - a fake canvas that accepts board-building code
 *   frozen      - reproduces Penpot's "plugin tab has been frozen" failure (isError set)
 *   missing     - reproduces "no plugin connected" (isError set)
 *   soft-fail   - every tool fails but WITHOUT the isError flag, which is what the
 *                 real Penpot server actually does. Regression guard.
 *   export-fail - execute_code works, export_shape soft-fails. Isolates the
 *                 export path so a silent no-op cannot come back.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** Verified 2x2 PNG (left column red, right column blue). */
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4zwAE/xkgFAAb8gP9PpddpAAAAABJRU5ErkJggg==';

function sse(body) {
  return `event: message\ndata: ${JSON.stringify(body)}\n\n`;
}

export function startMockMcp({ mode = 'normal', boardName = 'Crew' } = {}) {
  const calls = [];
  const state = { board: null };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let msg = {};
      try {
        msg = JSON.parse(raw || '{}');
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }

      // Notifications get an empty 202, exactly like the real server.
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }

      const reply = (result, { session = true } = {}) => {
        const headers = { 'Content-Type': 'text/event-stream' };
        if (session) headers['mcp-session-id'] = state.sessionId;
        res.writeHead(200, headers).end(sse({ jsonrpc: '2.0', id: msg.id, result }));
      };

      if (msg.method === 'initialize') {
        state.sessionId = randomUUID();
        reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'penpot', version: '1.0.0-mock' },
          instructions: 'Mock server. Read the high-level overview first.',
        });
        return;
      }

      if (msg.method === 'tools/list') {
        reply({
          tools: [
            { name: 'execute_code', description: 'Executes JavaScript in the plugin context.' },
            { name: 'high_level_overview', description: 'Static instructions.' },
            { name: 'penpot_api_info', description: 'API docs.' },
            { name: 'export_shape', description: 'Exports a shape as PNG or SVG.' },
          ],
        });
        return;
      }

      if (msg.method === 'tools/call') {
        const { name, arguments: args } = msg.params ?? {};
        calls.push({ name, args });

        if (mode === 'frozen') {
          reply({
            content: [
              {
                type: 'text',
                text: 'Tool execution failed: Error: The Penpot plugin tab has been frozen by the browser and cannot run tasks. Please click/focus the Penpot tab to wake it, then retry.',
              },
            ],
            isError: true,
          });
          return;
        }
        if (mode === 'missing') {
          reply({
            content: [{ type: 'text', text: 'Tool execution failed: Error: No Penpot plugin is connected.' }],
            isError: true,
          });
          return;
        }
        // Real Penpot omits the isError flag entirely and puts the failure in a
        // text block. A client that only checks the flag sees a success.
        if (mode === 'soft-fail') {
          reply({
            content: [
              {
                type: 'text',
                text: 'Tool execution failed: Error: No Penpot instance connected for user token. Please ensure that Penpot is connected and that the MCP client connection is using the correct token.',
              },
            ],
          });
          return;
        }
        if (mode === 'export-fail' && name === 'export_shape') {
          reply({
            content: [
              {
                type: 'text',
                text: 'Tool execution failed: Error: No Penpot instance connected for user token. Please ensure that Penpot is connected and that the MCP client connection is using the correct token.',
              },
            ],
          });
          return;
        }

        if (name === 'execute_code') {
          const code = String(args?.code ?? '');
          // Record the board if the code creates one, so export_shape can find it.
          const created = code.match(/name\s*=\s*['"]([^'"]+)['"]/);
          if (created) state.board = created[1];
          const looksLikeLookup = /return\s+s\s*\?\s*\{/.test(code);
          const value = looksLikeLookup
            ? { boardId: 'mock-board-1' }
            : { board: state.board ?? boardName, boardId: 'mock-board-1', sections: 5, children: [] };
          reply({ content: [{ type: 'text', text: JSON.stringify({ result: value, log: '' }) }] });
          return;
        }

        if (name === 'export_shape') {
          reply({
            content: [
              { type: 'text', text: `Exported ${args?.shapeId ?? 'page'} as ${args?.format ?? 'png'}` },
              { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
            ],
          });
          return;
        }

        reply({ content: [{ type: 'text', text: 'static' }] });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(
        sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/mcp/stream?userToken=mock-token`,
        calls,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}