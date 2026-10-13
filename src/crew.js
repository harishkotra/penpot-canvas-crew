/**
 * The crew loop.
 *
 * plan -> build -> export -> audit -> critique -> arbitrate -> (revise | stop)
 *
 * The canvas is a projection of the spec, and the exported PNG is the oracle.
 * Every round is written to disk, so a run is reproducible, inspectable and
 * shareable, and so a failure shows exactly which step broke.
 *
 * Artifacts are written from a `finally` block. An unexpected error must still
 * leave a diagnosable run on disk rather than a lost one.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { ChatClient } from './models.js';
import { McpClient, imageDataUrl, unwrapExecuteResult } from './mcp.js';
import { auditSpec } from './a11y.js';
import { diffSpecs, summarizeSpec } from './spec.js';
import { createPlanner } from './roles/planner.js';
import { createBuilder, checkCodeSafety } from './roles/builder.js';
import { createCritic } from './roles/critic.js';
import { createArbiter, DECISIONS } from './roles/arbiter.js';
import { buildReport } from './report.js';

export function slugify(text, max = 40) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max) || 'run'
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The Penpot plugin connection flaps. Observed on a real setup: a call succeeds,
 * then the next one fails with "No Penpot instance connected for user token"
 * while the browser throttles the tab, then it recovers. Those two failures are
 * transient often enough to be worth retrying before giving up on a round.
 */
export async function retryCanvas(fn, { attempts = 6, delayMs = 5000, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = err?.frozen || err?.missing;
      if (!transient || i === attempts - 1) throw err;
      onRetry?.(err, i + 1);
      await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

export function makeRunDir(runsDir, brief, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = resolve(runsDir, `${stamp}-${slugify(brief)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the board id by name, for when the builder did not return one. */
export async function resolveBoardId(mcp, boardName) {
  const res = await mcp.executeCode(
    `const s = penpotUtils.findShape(x => x.name === ${JSON.stringify(boardName)});
     return s ? { boardId: s.id } : null;`,
  );
  const value = unwrapExecuteResult(res.text);
  return value && typeof value === 'object' ? value.boardId : undefined;
}

/**
 * Run the crew.
 *
 * @param {{config: object, brief: string, log?: (s: string) => void,
 *          client?: object, mcp?: object, now?: Date}} input
 */
export async function runCrew({ config, brief, log = () => {}, client, mcp, now = new Date() }) {
  const chat =
    client ?? new ChatClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
  const canvas = mcp ?? new McpClient(config.mcpUrl, { timeoutMs: config.timeoutMs });
  // Connection-retry policy. The Penpot plugin drops whenever its tab loses
  // focus, which is exactly what happens when you run this from a terminal on
  // the same machine. So the retry has to be patient enough for a human to
  // click back into the browser: six attempts over about 75 seconds.
  const retry = config.retry ?? { attempts: 6, delayMs: 5000 };
  const tokens = config.maxTokens ?? { planner: 8000, builder: 16000, critic: 4000, arbiter: 1200 };
  const pluginHint = (e, n) =>
    say(
      `  canvas not reachable (retry ${n}): ${String(e.message).split('\n')[0]} ` +
        '- click into the Penpot tab to wake the plugin.',
    );

  const runDir = makeRunDir(config.runsDir, brief, now);
  const reportPath = join(runDir, 'report.html');
  writeFileSync(join(runDir, 'brief.txt'), brief);

  const transcript = [];
  const say = (line) => {
    transcript.push(line);
    log(line);
  };

  const rounds = [];
  const history = [];
  let spec = null;
  let specVersion = 0;
  let verdict = {
    decision: DECISIONS.HALT,
    rule: 'not-run',
    reason: 'The loop never ran.',
    focus: [],
  };

  /**
   * Write the run artifacts. Ordered cheapest-first so that if the report
   * generation itself fails, the raw evidence is already on disk.
   */
  const finalise = () => {
    try {
      writeFileSync(join(runDir, 'transcript.md'), transcript.join('\n'));
      writeFileSync(join(runDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
      writeFileSync(join(runDir, 'history.json'), JSON.stringify(history, null, 2));
      writeFileSync(
        reportPath,
        buildReport({ brief, config, rounds, history, verdict, transcript: transcript.join('\n') }),
      );
    } catch (err) {
      say(`!! Could not write every artifact: ${String(err?.message ?? err)}`);
      try {
        writeFileSync(join(runDir, 'transcript.md'), transcript.join('\n'));
      } catch {
        /* nothing further we can do */
      }
    }
  };

  say('# Canvas Crew run');
  say('');
  say(`Brief: ${brief}`);
  say(`Board: ${config.boardName}`);
  say(`Rounds: up to ${config.maxRounds}, pass score ${config.passScore}/10`);
  say(
    `Crew: planner=${config.models.planner}, builder=${config.models.builder}, ` +
      `critic=${config.models.critic}, arbiter=${config.models.arbiter}`,
  );
  say('');

  try {
    if (!mcp) {
      const info = await canvas.open();
      say(`MCP connected: ${info.serverInfo?.name ?? 'unknown'} ${info.serverInfo?.version ?? ''}`);
      const tools = await canvas.listTools();
      say(`MCP tools: ${tools.map((t) => t.name).join(', ')}`);
    }

    // Precondition: the plugin must actually be attached. `high_level_overview`
    // answers without one, so prove it with a file-touching call before
    // spending a single model call on a run that cannot draw.
    try {
      await retryCanvas(() => canvas.executeCode('return { ok: true, file: penpot.currentFile.name };'), {
        ...retry,
        onRetry: pluginHint,
      });
      say('Plugin responsive.');
      say('');
    } catch (err) {
      const e = new Error(
        'The Penpot plugin is not reachable, so the crew cannot draw anything.\n' +
          `Cause: ${String(err.message).split('\n')[0]}\n` +
          'Fix: click into the Penpot tab to wake it, and in Chrome add your Penpot site under\n' +
          '  Settings -> Performance -> "Always keep these sites active".',
      );
      e.precondition = true;
      throw e;
    }

    const planner = createPlanner({
      client: chat,
      model: config.models.planner,
      boardName: config.boardName,
      maxTokens: tokens.planner,
    });
    const builder = createBuilder({
      client: chat,
      model: config.models.builder,
      mcp: canvas,
      boardName: config.boardName,
      maxTokens: tokens.builder,
    });
    const critic = createCritic({ client: chat, model: config.models.critic, maxTokens: tokens.critic });
    const arbiter = createArbiter({
      client: chat,
      model: config.models.arbiter,
      passScore: config.passScore,
      maxRounds: config.maxRounds,
      maxTokens: tokens.arbiter,
    });

    // --- Round 0: plan -----------------------------------------------------
    say('## Planning');
    const planned = await planner.plan(brief);
    spec = planned.spec;
    specVersion = 1;
    writeFileSync(join(runDir, 'spec.v1.json'), JSON.stringify(spec, null, 2));
    say(`Planner produced ${spec.sections.length} section(s), ${spec.palette.length} colours.`);
    say('');
    say('```');
    say(summarizeSpec(spec));
    say('```');
    say('');

    for (let round = 1; round <= config.maxRounds; round++) {
      const roundDir = join(runDir, `round-${round}`);
      mkdirSync(roundDir, { recursive: true });
      say(`## Round ${round}`);

      // --- Build -----------------------------------------------------------
      let rendered;
      let buildError;
      let lastRaw = '';
      let lastUsage;
      for (let attempt = 1; attempt <= 2 && !rendered; attempt++) {
        try {
          const feedback =
            attempt === 1
              ? undefined
              : `Your previous attempt was rejected by a static safety check:\n${buildError?.message ?? ''}\n` +
                `Fix it and return the full code again. It must delete only the board named "${config.boardName}" and return { boardId }.`;
          const code = attempt === 1 ? await builder.writeCode(spec) : await builder.writeCode(spec, feedback);
          lastRaw = code.raw ?? '';
          lastUsage = code.usage;
          // Re-run the guard on the retry too.
          const safety = checkCodeSafety(code.code, config.boardName);
          if (!safety.ok) {
            throw Object.assign(new Error(safety.problems.join('; ')), {
              code: code.code,
              raw: code.raw,
              usage: code.usage,
              unsafe: true,
            });
          }
          const exec = await retryCanvas(() => canvas.executeCode(code.code), {
            ...retry,
            onRetry: pluginHint,
          });
          const value = unwrapExecuteResult(exec.text);
          rendered = {
            code: code.code,
            value,
            boardId: value && typeof value === 'object' ? value.boardId ?? value.id : undefined,
          };
        } catch (err) {
          buildError = err;
          // A connection failure has already been retried; do not burn another
          // model call on it.
          if (err.frozen || err.missing) break;
        }
      }

      if (!rendered) {
        // Diagnosability: the raw reply and the token accounting both go to
        // disk. Without them an empty response is indistinguishable from a
        // parsing bug, which cost a full debugging round the first time.
        const usage = buildError?.usage ?? lastUsage;
        const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
        const completion = usage?.completion_tokens;

        let message = String(buildError?.message ?? buildError).split('\n')[0];
        if (!String(buildError?.code ?? '').trim() && reasoning) {
          message =
            `The builder returned no code. It spent ${reasoning} reasoning tokens and hit the ` +
            `${completion ?? 'token'} token ceiling before writing any code. Raise CREW_BUILDER_MAX_TOKENS, ` +
            'or route the builder to a non-reasoning model.';
        }

        writeFileSync(join(roundDir, 'code.js'), buildError?.code ?? '// no code produced\n');
        writeFileSync(join(roundDir, 'builder-raw.txt'), String(buildError?.raw ?? lastRaw ?? ''));
        writeFileSync(
          join(roundDir, 'build-error.json'),
          JSON.stringify({ message: String(buildError?.message ?? buildError), usage: usage ?? null }, null, 2),
        );
        say(`Build failed: ${message}`);
        verdict = {
          decision: DECISIONS.HALT,
          rule: 'build-failure',
          reason: `Could not render round ${round}: ${message}`,
          focus: [],
        };
        break;
      }

      writeFileSync(join(roundDir, 'code.js'), rendered.code);
      say(`Builder wrote ${rendered.code.split('\n').length} lines, executed cleanly.`);

      // --- Export the pixels ----------------------------------------------
      let imageUrl;
      let exportError;
      try {
        let boardId = rendered.boardId;
        if (!boardId) boardId = await retryCanvas(() => resolveBoardId(canvas, config.boardName), retry);
        const exported = await retryCanvas(() => canvas.exportShape(boardId ?? 'page', 'png'), {
          ...retry,
          onRetry: pluginHint,
        });

        if (exported.image?.data) {
          const buf = Buffer.from(exported.image.data, 'base64');
          writeFileSync(join(roundDir, 'board.png'), buf);
          imageUrl = imageDataUrl(exported);
          say(`Exported board.png (${buf.length} bytes).`);
        } else {
          // Never fail silently here: without the PNG the critic cannot see the
          // design, and the report must say so rather than looking fine.
          exportError = `export_shape returned no image block. Raw: ${JSON.stringify(exported.raw).slice(0, 300)}`;
          say('Export failed: export_shape returned no image. The critic will review the spec only.');
        }
      } catch (err) {
        exportError = String(err.message ?? err);
        say(`Export failed: ${exportError.split('\n')[0]}`);
      }

      // --- Deterministic audit ---------------------------------------------
      const audit = auditSpec(spec);
      writeFileSync(join(roundDir, 'audit.json'), JSON.stringify(audit, null, 2));
      say(
        `Computed accessibility: ${audit.checked} pair(s) checked, ${audit.failures} failure(s), ` +
          `${audit.worst} blocker(s).`,
      );

      // --- Critique ---------------------------------------------------------
      const critique = await critic.critique({
        brief,
        spec,
        audit,
        round,
        maxRounds: config.maxRounds,
        imageUrl,
      });
      writeFileSync(join(roundDir, 'critique.json'), JSON.stringify(critique, null, 2));
      if (critique.parsed) {
        say(
          `Critic scored ${critique.score}/10 (${critique.visual ? 'looked at the render' : 'SPEC ONLY, no image'}): ` +
            `${String(critique.summary ?? '').split('.')[0] || '(no summary)'}.`,
        );
      } else {
        say(
          `Critic reply was NOT parseable JSON (${critique.visual ? 'vision path' : 'spec-only path'}). ` +
            'The raw reply is saved in critique.json.',
        );
      }
      for (const f of critique.findings.slice(0, 6)) {
        say(`  - [${f.severity}] ${f.area}: ${f.issue}`);
      }

      history.push({
        round,
        score: critique.score,
        parsed: critique.parsed,
        blockers: critique.blockers,
        majors: critique.majors,
        verdict: critique.verdict,
      });

      // --- Arbitrate --------------------------------------------------------
      if (!critique.parsed) {
        // Never arbitrate on a score that does not exist. Substituting a
        // default here would make the crew optimise against a number nobody
        // produced, which is worse than stopping.
        verdict = {
          decision: DECISIONS.HALT,
          rule: 'critique-unparsed',
          reason:
            `Round ${round}: the critic replied with prose instead of JSON, so there is no score to ` +
            `judge against. The render and the raw reply are saved in round-${round}/.`,
          focus: [],
        };
        say(`Arbiter: HALT (rule: critique-unparsed) - ${verdict.reason}`);
      } else {
        verdict = await arbiter.decide({ history, round, audit });
        say(`Arbiter: ${verdict.decision.toUpperCase()} (rule: ${verdict.rule}) - ${verdict.reason}`);
        if (verdict.focus?.length) {
          for (const f of verdict.focus) say(`  focus: ${f}`);
        }
      }
      say('');

      // Persist the decision for this round so `report` can be regenerated
      // faithfully from disk without guessing.
      writeFileSync(join(roundDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
      // Only written when the export actually failed, so an empty file is never
      // mistaken for a recorded failure.
      if (exportError) writeFileSync(join(roundDir, 'export-error.txt'), String(exportError));

      rounds.push({
        round,
        roundDir,
        codeLines: rendered.code.split('\n').length,
        execValue: rendered.value,
        imageUrl: exportedUrlForReport(round, imageUrl),
        exportError,
        audit,
        critique,
        verdict,
        spec,
      });

      if (verdict.decision === DECISIONS.ACCEPT || verdict.decision === DECISIONS.HALT) break;

      // --- Revise the spec for the next round -------------------------------
      const revised = await planner.revise({ spec, critique, audit, history });
      if (revised.rejected) {
        say('Planner revision came back unusable; keeping the previous spec.');
      } else {
        const changes = diffSpecs(spec, revised.spec);
        specVersion++;
        writeFileSync(join(runDir, `spec.v${specVersion}.json`), JSON.stringify(revised.spec, null, 2));
        writeFileSync(join(roundDir, 'spec-diff.json'), JSON.stringify(changes, null, 2));
        say(`Planner revised the spec (v${specVersion}): ${changes.length} change(s).`);
        for (const c of changes.slice(0, 8)) {
          say(`  - ${c.field}: ${c.from === null ? '(new)' : c.from} -> ${c.to === null ? '(removed)' : c.to}`);
        }
        say('');

        if (changes.length === 0) {
          // Re-rendering an identical spec produces an identical canvas and an
          // identical critique. Stopping here is honest and saves a whole round.
          verdict = {
            decision: DECISIONS.HALT,
            rule: 'no-spec-change',
            reason:
              `The planner returned an identical spec after round ${round}, so another render would ` +
              'produce the same result. Either the findings need a change the spec cannot express ' +
              '(text frame widths, gradients, effects), or the planner did not act on them. ' +
              `The outstanding findings are in round-${round}/critique.json.`,
            focus: [],
          };
          say(`Arbiter: HALT (rule: no-spec-change) - ${verdict.reason}`);
          break;
        }

        spec = revised.spec;
      }
    }
  } catch (err) {
    const message = String(err?.message ?? err);
    say('');
    if (err?.precondition) {
      say(`STOPPED before planning: ${message.split('\n')[0]}`);
      say(message);
      verdict = {
        decision: DECISIONS.HALT,
        rule: 'plugin-unavailable',
        // Keep the cause in the reason, so the verdict alone is diagnosable.
        reason: message.split('\n').slice(0, 2).join(' '),
        focus: [],
      };
    } else {
      say(`!! The run stopped on an unexpected error: ${message}`);
      say('Everything completed before this point is still on disk.');
      verdict = {
        decision: DECISIONS.HALT,
        rule: 'unexpected-error',
        reason: message.split('\n')[0],
        focus: [],
      };
    }
  } finally {
    finalise();
  }

  return { runDir, reportPath, verdict, history, rounds, spec, transcript: transcript.join('\n') };
}

/** Report images are referenced relative to the run directory. */
function exportedUrlForReport(round, imageUrl) {
  return imageUrl ? `round-${round}/board.png` : undefined;
}