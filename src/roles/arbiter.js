/**
 * The Arbiter.
 *
 * Decides whether the argument continues. The important design choice: the
 * decision is made by deterministic rules in code, and the model is only
 * consulted for the reason and the focus list.
 *
 * Why: an LLM arbiter that "decides when it is good enough" is exactly how you
 * get a loop that either never stops or declares victory on a broken design.
 * Rules are auditable and testable; a model's opinion is neither.
 */

import { ARBITER_SYSTEM, arbiterUser } from '../prompts.js';
import { extractJson } from '../models.js';
import { formatFindings } from '../a11y.js';

export const DECISIONS = { ACCEPT: 'accept', REVISE: 'revise', HALT: 'halt' };

/**
 * Pure function, no model. Returns a decision or null when the rules are
 * genuinely undecided (in which case the caller may consult the model).
 *
 * @param {{history: Array, round: number, maxRounds: number, passScore: number}} input
 * @returns {{decision: string, rule: string, reason: string} | null}
 */
export function applyRules({ history, round, maxRounds, passScore }) {
  const latest = history[history.length - 1];
  if (!latest) return { decision: DECISIONS.REVISE, rule: 'no-history', reason: 'No rounds have run yet.' };

  // 1. Budget. Always respected, whatever the score says.
  if (round >= maxRounds) {
    return {
      decision: DECISIONS.HALT,
      rule: 'budget',
      reason: `Round budget of ${maxRounds} reached. Stopping with score ${latest.score}/10.`,
    };
  }

  // 2. Computed blockers must be fixed before anything is accepted.
  if (latest.blockers > 0) {
    return {
      decision: DECISIONS.REVISE,
      rule: 'blockers',
      reason: `${latest.blockers} blocker(s) outstanding, including computed accessibility failures.`,
    };
  }

  // 3. Good enough and clean.
  if (latest.score >= passScore) {
    return {
      decision: DECISIONS.ACCEPT,
      rule: 'pass-score',
      reason: `Score ${latest.score}/10 meets the ${passScore}/10 bar with no blockers.`,
    };
  }

  // 4. Oscillation guard: two rounds without improvement means another round is
  //    spending tokens to go in circles.
  if (history.length >= 3) {
    const [a, b, c] = history.slice(-3).map((h) => h.score);
    if (c <= b && b <= a) {
      return {
        decision: DECISIONS.HALT,
        rule: 'no-improvement',
        reason: `Scores ${a} -> ${b} -> ${c} show no improvement across three rounds.`,
      };
    }
  }
  if (history.length >= 2) {
    const prev = history[history.length - 2].score;
    if (latest.score < prev - 2) {
      return {
        decision: DECISIONS.HALT,
        rule: 'regression',
        reason: `Score fell from ${prev} to ${latest.score}. The last revision made it worse; stopping rather than compounding it.`,
      };
    }
  }

  return null; // undecided: worth another round, let the model set the focus
}

export function createArbiter({ client, model, capabilities = {}, passScore = 8, maxRounds = 4, maxTokens = 1200 }) {
  const supportsJsonMode = capabilities.json !== false;

  return {
    name: 'arbiter',
    model,

    /**
     * @param {{history: Array, round: number, audit: object}} input
     * @returns {Promise<{decision: string, rule: string, reason: string, focus: string[]}>}
     */
    async decide({ history, round, audit }) {
      const ruled = applyRules({ history, round, maxRounds, passScore });
      if (ruled && ruled.decision !== DECISIONS.REVISE) {
        return { ...ruled, focus: [] };
      }

      // Either undecided, or revise-by-rule. Ask the model only for focus.
      let reason = ruled?.reason ?? 'Another round is worth spending.';
      let focus = [];
      try {
        const { value } = await client.json({
          model,
          system: ARBITER_SYSTEM,
          user: arbiterUser({
            history,
            passScore,
            round,
            maxRounds,
            auditSummary: formatFindings(audit),
          }),
          maxTokens,
          temperature: 0.2,
          supportsJsonMode,
        });
        if (value && typeof value === 'object') {
          if (value.reason) reason = String(value.reason).slice(0, 300);
          focus = (Array.isArray(value.focus) ? value.focus : []).slice(0, 3).map((f) => String(f).slice(0, 200));
        }
      } catch {
        // The model is advisory here. A failure must not stop the loop.
      }

      return { decision: ruled?.decision ?? DECISIONS.REVISE, rule: ruled?.rule ?? 'model', reason, focus };
    },
  };
}

/** Re-exported for tests. */
export const _internal = { extractJson };