/**
 * The Builder.
 *
 * Turns a ScreenSpec into Penpot Plugin API JavaScript and runs it against the
 * live canvas. Needs tool-calling strength (it writes imperative canvas code).
 *
 * This is the only role that mutates the user's design file, so it also carries
 * a best-effort static guard: the crew refuses code that would damage anything
 * beyond its own board.
 */

import { builderSystem, builderUser } from '../prompts.js';
import { unwrapExecuteResult } from '../mcp.js';

/** Strip markdown fences and leading prose so we get runnable JS. */
export function extractCode(raw) {
  let text = String(raw ?? '').trim();
  const fenced = text.match(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const firstStatement = text.search(/^(const|let|var|if|for|return|await|penpot|penpotUtils|\/\/|\/\*)/m);
  if (firstStatement > 0) text = text.slice(firstStatement).trim();
  return text;
}

/**
 * Catastrophic-pattern guard. Not a sandbox: a sandbox is not possible when the
 * code runs in the user's own plugin context. This catches the ways an LLM
 * wipes a file, which is the failure that actually hurts.
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkCodeSafety(code, boardName) {
  const problems = [];
  const src = String(code ?? '');

  if (!src.trim()) problems.push('Generated code is empty.');

  const patterns = [
    [/penpot\.currentPage\.root\.remove\s*\(/i, 'removes the page root, which would delete the entire page'],
    [/currentFile\.pages[\s\S]{0,120}?\.remove\s*\(/i, 'removes whole pages from the file'],
    [/penpot\.closePlugin/i, 'closes the plugin, killing the MCP session'],
    [/localStorage\.clear|indexedDB\.deleteDatabase/i, 'clears browser storage'],
  ];
  for (const [re, why] of patterns) {
    if (re.test(src)) problems.push(`Code ${why}.`);
  }

  if (!src.includes(boardName)) {
    problems.push(
      `Code never mentions the board name "${boardName}", so it would build on the wrong shape or nothing at all.`,
    );
  }

  return { ok: problems.length === 0, problems };
}

export function createBuilder({ client, model, mcp, boardName = 'Crew', capabilities = {}, maxTokens = 16000 }) {
  return {
    name: 'builder',
    model,

    /** Ask the model for canvas code. `feedback` is appended on a retry. */
    async writeCode(spec, feedback) {
      const user = feedback ? `${builderUser(spec)}\n\n# Correction required\n${feedback}` : builderUser(spec);
      // This budget is large on purpose. On endpoints that serve reasoning
      // models, reasoning tokens are drawn from the SAME budget as the answer,
      // and a real 7-section spec made the builder spend 16000 tokens thinking
      // and return zero characters of code. 4000 was not enough for either.
      const { text, usage } = await client.textWithUsage({
        model,
        system: builderSystem(boardName),
        user,
        maxTokens,
        temperature: 0.2,
      });
      const code = extractCode(text);
      return { code, raw: text, usage };
    },

    /**
     * Write and run. Returns { code, exec, boardId }.
     * Throws on unsafe code or a canvas failure, with the code attached so the
     * run artifacts show exactly what was attempted.
     */
    async render(spec) {
      const { code, raw } = await this.writeCode(spec);
      const safety = checkCodeSafety(code, boardName);
      if (!safety.ok) {
        const err = new Error(`Builder produced unsafe or unusable code:\n  - ${safety.problems.join('\n  - ')}`);
        err.code = code;
        err.raw = raw;
        err.unsafe = true;
        throw err;
      }

      const result = await mcp.executeCode(code);
      const unwrapped = unwrapExecuteResult(result.text);
      const boardId =
        (unwrapped && typeof unwrapped === 'object' && (unwrapped.boardId ?? unwrapped.id)) || undefined;

      return { code, raw, exec: { text: result.text, value: unwrapped }, boardId };
    },
  };
}