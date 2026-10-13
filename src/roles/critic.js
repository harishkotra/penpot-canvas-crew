/**
 * The Critic.
 *
 * The only role that needs vision: it is shown the exported PNG of the canvas
 * and judges the pixels, not the intent. Deterministic accessibility findings
 * are injected as facts it is required to carry through.
 *
 * Two hard-won rules live here:
 *
 *  1. The system prompt MUST be sent on the vision path too. Without an output
 *     contract a vision model answers in prose, the JSON parse fails, and the
 *     critique is unusable. This actually happened on a real run.
 *  2. A critique that cannot be parsed must NEVER be given a default score. An
 *     invented 5/10 is worse than no score: the loop then optimises against a
 *     number nobody produced. Unparsed critiques are marked and the crew stops.
 *
 * If no image is available (a vision model was not configured, or the export
 * failed) the critic degrades to a spec-only review and says so, rather than
 * pretending it looked at the design.
 */

import { CRITIC_SYSTEM, criticUser } from '../prompts.js';
import { formatFindings } from '../a11y.js';
import { extractJson } from '../models.js';
import { summarizeSpec } from '../spec.js';

const VALID_SEVERITIES = new Set(['blocker', 'major', 'minor']);

const STRICT_RETRY = `Your previous reply was not a JSON object, so it could not be used.
Reply again with ONLY the JSON object described above. No markdown, no headings,
no commentary. Begin with { and end with }.`;

/**
 * Normalise a critic response into something the rest of the loop can trust.
 *
 * @param {object|undefined} raw the parsed response, or undefined when the
 *   response could not be parsed as JSON at all
 * @param {{audit: object, visual: boolean}} ctx
 */
export function normalizeCritique(raw, { audit, visual }) {
  const parsed = raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw);
  const src = parsed ? raw : {};

  // No parsed response means no score. Never substitute a default.
  const score = parsed ? clamp(Number(src.score), 1, 10, null) : null;

  const findings = [];
  for (const f of Array.isArray(src.findings) ? src.findings : []) {
    const severity = VALID_SEVERITIES.has(String(f?.severity).toLowerCase())
      ? String(f.severity).toLowerCase()
      : 'minor';
    findings.push({
      severity,
      area: String(f?.area ?? 'general').slice(0, 80),
      issue: String(f?.issue ?? '').slice(0, 400),
      fix: String(f?.fix ?? '').slice(0, 400),
    });
  }

  // Computed accessibility failures are facts. Force them into the findings and
  // never let them be downgraded to minor.
  for (const f of audit?.findings ?? []) {
    const already = findings.some((x) => x.area === f.area && x.issue.slice(0, 40) === f.issue.slice(0, 40));
    if (already) continue;
    findings.push({
      severity: f.severity === 'blocker' ? 'blocker' : 'major',
      area: f.area,
      issue: f.issue,
      fix: f.fix,
    });
  }

  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  const majors = findings.filter((f) => f.severity === 'major').length;

  // A design with computed blockers cannot be accepted, whatever the model said.
  let verdict = String(src.verdict ?? '').toLowerCase() === 'accept' ? 'accept' : 'revise';
  if (blockers > 0) verdict = 'revise';

  return {
    parsed,
    score,
    verdict,
    visual: Boolean(visual),
    summary: String(src.summary ?? '').slice(0, 600),
    strengths: (Array.isArray(src.strengths) ? src.strengths : []).map((s) => String(s).slice(0, 200)),
    findings,
    blockers,
    majors,
    auditPassed: Boolean(audit?.passed),
  };
}

export function createCritic({ client, model, capabilities = {}, maxTokens = 4000 }) {
  const canSee = capabilities.vision !== false;

  return {
    name: 'critic',
    model,
    canSee,

    /**
     * @param {{brief: string, spec: object, audit: object, round: number,
     *          maxRounds: number, imageUrl?: string}} input
     */
    async critique({ brief, spec, audit, round, maxRounds, imageUrl }) {
      const prompt = criticUser({
        brief,
        specSummary: summarizeSpec(spec),
        audit: formatFindings(audit),
        round,
        maxRounds,
      });

      const useVision = Boolean(imageUrl) && canSee;

      /** One attempt. `strict` appends a re-ask when the first reply was prose. */
      const attempt = async (strict) => {
        const user = strict ? `${prompt}\n\n${STRICT_RETRY}` : prompt;
        if (useVision) {
          // The system prompt is essential here: it carries the JSON contract.
          const res = await client.vision({
            model,
            system: CRITIC_SYSTEM,
            prompt: user,
            imageUrl,
            maxTokens,
            temperature: 0.2,
          });
          return { text: res.text, usage: res.usage, visual: true };
        }
        const text = await client.text({
          model,
          system: CRITIC_SYSTEM,
          user:
            `${user}\n\nNOTE: no rendered image is available, so you cannot judge the pixels. ` +
            'Start your "summary" with "Spec-only review (no image)." and only raise findings you ' +
            'can justify from the specification itself.',
          maxTokens,
          temperature: 0.2,
        });
        return { text, usage: undefined, visual: false };
      };

      let result = await attempt(false);
      let parsed = extractJson(result.text);

      if (parsed === undefined) {
        // One re-ask with the contract restated, then give up honestly.
        const retry = await attempt(true);
        const retryParsed = extractJson(retry.text);
        result = retry;
        parsed = retryParsed;
      }

      const critique = normalizeCritique(parsed, { audit, visual: result.visual });
      return { ...critique, raw: result.text, usage: result.usage };
    },
  };
}

function clamp(n, lo, hi, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}