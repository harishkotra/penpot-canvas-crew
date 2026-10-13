/**
 * The Planner.
 *
 * Turns a brief into a ScreenSpec, and later revises that spec in response to
 * critic findings. Needs JSON mode. Never touches the canvas.
 */

import { PLANNER_SYSTEM, PLANNER_REVISE_SYSTEM, plannerUser, plannerReviseUser } from '../prompts.js';
import { normalizeSpec, summarizeSpec } from '../spec.js';
import { formatFindings } from '../a11y.js';

export function createPlanner({ client, model, capabilities = {}, boardName = 'Crew', maxTokens = 8000 }) {
  const supportsJsonMode = capabilities.json !== false;

  return {
    name: 'planner',
    model,

    /** @returns {Promise<{spec: object, raw: string, usage?: unknown}>} */
    async plan(brief) {
      const { value, raw, usage } = await client.json({
        model,
        system: PLANNER_SYSTEM,
        user: plannerUser(brief),
        maxTokens,
        temperature: 0.35,
        supportsJsonMode,
      });
      return { spec: normalizeSpec(value, { boardName }), raw, usage };
    },

    /** @returns {Promise<{spec: object, raw: string, usage?: unknown}>} */
    async revise({ spec, critique, audit, history }) {
      const { value, raw, usage } = await client.json({
        model,
        system: PLANNER_REVISE_SYSTEM,
        user: plannerReviseUser({ spec, critique, audit: formatFindings(audit), history }),
        maxTokens,
        temperature: 0.25,
        supportsJsonMode,
      });
      // A revision that comes back unusable must not destroy a working spec.
      const revised = normalizeSpec(value, { boardName });
      if (!revised.sections?.length) {
        return { spec, raw, usage, rejected: true };
      }
      return { spec: revised, raw, usage };
    },
  };
}

export { summarizeSpec };