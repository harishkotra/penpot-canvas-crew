/**
 * A mock inference server.
 *
 * Implements POST /chat/completions well enough to drive every role, and
 * deliberately produces a real trajectory: round 1 is bad (and fails the
 * computed contrast gate), round 2 improves, round 3 passes. That way the
 * offline test exercises the whole argument, including the deterministic gate
 * and the arbiter's rules, rather than a single happy path.
 */

import { createServer } from 'node:http';

const INITIAL_SPEC = {
  title: 'Local-first design agent landing page',
  board: { width: 1440, height: 900, background: '#0B0B0F' },
  palette: [
    { name: 'bg', hex: '#0B0B0F' },
    { name: 'text', hex: '#FAFAFA' },
    { name: 'muted', hex: '#4B5563' },
    { name: 'accent', hex: '#6366F1' },
  ],
  type_scale: [
    { name: 'display', size: 64, weight: 700 },
    { name: 'heading', size: 28, weight: 600 },
    { name: 'body', size: 18, weight: 400 },
    { name: 'caption', size: 14, weight: 400 },
  ],
  sections: [
    {
      id: 'nav',
      role: 'navigation',
      height: 72,
      description: 'logo left, links centre, CTA right',
      background: 'bg',
      text: [{ role: 'wordmark', copy: 'Canvas Crew', size: 18, weight: 600, color: 'text' }],
    },
    {
      id: 'hero',
      role: 'hero',
      height: 520,
      description: 'headline, subhead, one CTA',
      background: 'bg',
      text: [
        { role: 'headline', copy: 'Designs that argue themselves into shape', size: 64, weight: 700, color: 'text' },
        // Deliberately low contrast: this is what the gate must catch.
        { role: 'subhead', copy: 'Four agents, one canvas, no frontier model.', size: 18, weight: 400, color: 'muted' },
      ],
    },
    {
      id: 'proof',
      role: 'content',
      height: 260,
      description: 'three short proof points',
      background: 'bg',
      text: [{ role: 'point', copy: 'Every round is on disk.', size: 16, weight: 400, color: 'muted' }],
    },
  ],
  notes: 'Keep it dark and quiet.',
};

const FIXED_SPEC = JSON.parse(JSON.stringify(INITIAL_SPEC));
FIXED_SPEC.palette = FIXED_SPEC.palette.map((c) => (c.name === 'muted' ? { ...c, hex: '#D1D5DB' } : c));
FIXED_SPEC.sections[1].height = 420;
FIXED_SPEC.sections.push({
  id: 'cta',
  role: 'cta',
  height: 148,
  description: 'closing call to action',
  background: 'bg',
  text: [{ role: 'button', copy: 'Run the crew', size: 18, weight: 600, color: 'text' }],
});

const BUILDER_CODE = `const old = penpotUtils.findShape(s => s.name === 'Crew');
if (old) old.remove();
const board = penpot.createBoard();
board.name = 'Crew';
board.resize(1440, 900);
board.x = 0;
board.y = 0;
board.fills = [{ fillColor: '#0B0B0F', fillOpacity: 1 }];
penpot.currentPage.root.appendChild(board);
const stack = board.addFlexLayout();
stack.dir = 'column';
stack.alignItems = 'stretch';
stack.rowGap = 0;
const hero = penpot.createBoard();
hero.name = 'hero';
hero.resize(1440, 520);
hero.fills = [{ fillColor: '#0B0B0F', fillOpacity: 1 }];
board.appendChild(hero);
const headline = penpot.createText('Designs that argue themselves into shape');
headline.name = 'Headline';
headline.resize(1200, 20);
headline.growType = 'auto-height';
headline.align = 'center';
headline.fontSize = 64;
headline.fills = [{ fillColor: '#FAFAFA', fillOpacity: 1 }];
hero.appendChild(headline);
return { board: board.name, boardId: board.id, sections: 3, children: board.children.map(c => c.name) };`;

export function startMockLlm({
  trajectory = [5, 7, 9],
  failPlanner = false,
  criticProse = false,
  builderEmpty = false,
  reviseNoChange = false,
} = {}) {
  const calls = [];
  let critiqueCount = 0;
  let reviseCount = 0;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* ignore */
      }
      const messages = body.messages ?? [];
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      const hasImage = JSON.stringify(messages).includes('image_url');
      calls.push({ model: body.model, hasImage, sys: String(sys).slice(0, 40) });

      const send = (message, opts = {}) =>
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            choices: [{ message, ...(opts.choice ?? {}) }],
            usage: opts.usage ?? { total_tokens: 42 },
          }),
        );

      // --- capability probes -------------------------------------------------
      if (/Make the header shape pure white/.test(user)) {
        send({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'set_fill', arguments: '{"shape":"header","hex":"#FFFFFF"}' },
            },
          ],
        });
        return;
      }
      if (/what are the two colours/.test(user)) {
        send({ role: 'assistant', content: 'Red, blue' });
        return;
      }
      if (/exactly this JSON/.test(user)) {
        send({ role: 'assistant', content: '{"ok": true}' });
        return;
      }

      // --- planner ----------------------------------------------------------
      if (/Return the complete revised specification JSON/.test(user)) {
        reviseCount++;
        if (reviseNoChange) {
          // Reproduces a planner that returns the spec untouched, which would
          // re-render an identical canvas.
          send({ role: 'assistant', content: JSON.stringify(INITIAL_SPEC) });
          return;
        }
        // A realistic planner keeps changing things. Returning a byte-identical
        // spec every time would (correctly) trip the no-spec-change rule.
        const revised = JSON.parse(JSON.stringify(FIXED_SPEC));
        if (reviseCount > 1) revised.sections[1].height += 10 * (reviseCount - 1);
        send({ role: 'assistant', content: JSON.stringify(revised) });
        return;
      }
      if (/Produce the specification JSON/.test(user)) {
        if (failPlanner) {
          // A hard 4xx: the crew must not retry it, and must still write artifacts.
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ error: { message: 'simulated planner failure' } }),
          );
          return;
        }
        send({ role: 'assistant', content: '```json\n' + JSON.stringify(INITIAL_SPEC) + '\n```' });
        return;
      }

      // --- builder ----------------------------------------------------------
      if (/Build this screen on the Penpot canvas/.test(user)) {
        if (builderEmpty) {
          // Reproduces the real failure: a reasoning model spends the entire
          // budget thinking and returns zero characters of code.
          send(
            { role: 'assistant', content: '', reasoning_content: 'thinking...' },
            {
              choice: { finish_reason: 'length' },
              usage: {
                completion_tokens: 16000,
                reasoning_tokens: 16000,
                completion_tokens_details: { reasoning_tokens: 16000 },
              },
            },
          );
          return;
        }
        // Wrap in a fence on purpose: the extractor must cope with it.
        send({ role: 'assistant', content: '```javascript\n' + BUILDER_CODE + '\n```' });
        return;
      }

      // --- critic -----------------------------------------------------------
      if (/Look at the attached PNG export/.test(user)) {
        critiqueCount++;
        if (criticProse) {
          // Reproduces the real failure: a vision model with no output contract
          // answers in markdown, so the JSON parse fails.
          send({
            role: 'assistant',
            content:
              '# Critique: Inkwell Pricing (Round 1)\n\n## Verdict\nThe export is severely broken, this is not a polish pass.\n\n## What works\n- The palette is coherent.\n',
          });
          return;
        }
        const score = trajectory[Math.min(critiqueCount - 1, trajectory.length - 1)];
        const early = score < 8;
        send({
          role: 'assistant',
          content: JSON.stringify({
            score,
            verdict: early ? 'revise' : 'accept',
            summary: early
              ? 'The structure is right but the subhead is unreadable against the background.'
              : 'A finished screen with a clear hierarchy and a readable palette.',
            strengths: early ? ['Clear single-column reading order'] : ['Clear hierarchy', 'Consistent spacing'],
            findings: early
              ? [
                  {
                    severity: 'blocker',
                    area: 'hero/subhead',
                    issue: 'Subhead is nearly invisible against the dark background.',
                    fix: 'Lighten the muted colour until contrast reaches 4.5:1.',
                  },
                ]
              : [],
          }),
        });
        return;
      }

      // --- arbiter ----------------------------------------------------------
      if (/# Score trajectory/.test(user)) {
        send({
          role: 'assistant',
          content: JSON.stringify({
            reason: 'Contrast improved and the layout tightened; one more pass is worth it.',
            focus: ['Tighten hero spacing', 'Check caption legibility'],
          }),
        });
        return;
      }

      send({ role: 'assistant', content: '{}' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        calls,
        get critiqueCount() {
          return critiqueCount;
        },
        get reviseCount() {
          return reviseCount;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}