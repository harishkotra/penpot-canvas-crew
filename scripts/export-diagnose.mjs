/**
 * Diagnostic: why does export_shape come back without an image?
 * Prints the raw MCP result for each attempt.
 */
import { loadDotEnv, loadConfig } from '../src/config.js';
import { McpClient, unwrapExecuteResult } from '../src/mcp.js';

loadDotEnv();
const config = loadConfig();
const mcp = new McpClient(config.mcpUrl, { timeoutMs: 120_000 });
await mcp.open();

const boardName = config.boardName;

// 1. Find the board and report what is actually on the canvas.
const find = await mcp.executeCode(`
  const s = penpotUtils.findShape(x => x.name === ${JSON.stringify(boardName)});
  return s ? { boardId: s.id, name: s.name, type: s.type, w: s.width, h: s.height, children: s.children.length } : null;
`);
console.log('board lookup:', JSON.stringify(unwrapExecuteResult(find.text)));

const info = unwrapExecuteResult(find.text);
const boardId = info && typeof info === 'object' ? info.boardId : undefined;
console.log('resolved boardId:', boardId);

async function tryExport(label, shapeId, extra = {}) {
  const res = await mcp.callTool('export_shape', { shapeId, format: 'png', ...extra });
  const blocks = (res.raw?.content ?? []).map((b) => `${b.type}${b.type === 'image' ? `(${b.mimeType}, ${b.data?.length ?? 0} b64 chars)` : ''}`);
  console.log(`\n--- ${label} (shapeId=${shapeId}, ${JSON.stringify(extra)}) ---`);
  console.log('  isError:', res.isError);
  console.log('  blocks:', blocks.join(', ') || '(none)');
  console.log('  image present:', Boolean(res.image));
  console.log('  text:', JSON.stringify(String(res.text).slice(0, 300)));
  return res;
}

if (boardId) {
  await tryExport('board by id, mode shape', boardId);
  await tryExport('board by id, mode fill', boardId, { mode: 'fill' });
}
await tryExport('whole page', 'page');
await tryExport('selection', 'selection');