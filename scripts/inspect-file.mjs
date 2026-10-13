/**
 * Read-only look at the currently open Penpot file. Prints what is there
 * before the crew touches anything.
 */
import { loadDotEnv, loadConfig } from '../src/config.js';
import { McpClient, unwrapExecuteResult } from '../src/mcp.js';

loadDotEnv();
const config = loadConfig();
const mcp = new McpClient(config.mcpUrl, { timeoutMs: 60_000 });
await mcp.open();

const res = await mcp.executeCode(`
  const file = penpot.currentFile;
  const page = penpot.currentPage;
  const shapes = penpotUtils.findShapes(() => true, page.root);
  return {
    file: file.name,
    pages: file.pages.map(p => p.name),
    currentPage: page.name,
    topLevelCount: page.root.children.length,
    topLevelNames: page.root.children.slice(0, 25).map(c => c.name + ':' + c.type),
    totalShapes: shapes.length,
    hasCrewBoard: Boolean(penpotUtils.findShape(s => s.name === 'Crew')),
  };
`);
console.log(JSON.stringify(unwrapExecuteResult(res.text), null, 2));