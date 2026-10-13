/**
 * The ScreenSpec: the artifact the crew argues about.
 *
 * This is the core design decision of the project. The agents do NOT iterate
 * on generated JavaScript. They iterate on a structured spec, and the canvas
 * is a projection of that spec. Three reasons:
 *
 *  1. A spec is diffable. You can see exactly what the critic changed.
 *  2. A mid-tier model can revise JSON far more reliably than it can patch
 *     imperative canvas code, which is where "the agent broke the file"
 *     stories come from.
 *  3. The spec is where the accessibility maths lives, so the gate has
 *     something deterministic to check.
 */

import { parseHex } from './a11y.js';

export const SPEC_VERSION = 1;

/** Coerce anything to an uppercase #RRGGBB, or return the fallback. */
export function toHex(value, fallback = '#000000') {
  const rgb = parseHex(typeof value === 'string' ? value : '');
  if (!rgb) return parseHex(fallback) ? fallback.toUpperCase() : '#000000';
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

const slug = (s, fallback) =>
  String(s ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || fallback;

/**
 * Normalise a raw model-produced spec into something the rest of the system
 * can trust. Never throws on shape problems: repairs what it can, so a
 * slightly sloppy planner response does not kill a run.
 */
export function normalizeSpec(raw, { boardName = 'Crew' } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const board = src.board ?? {};

  const spec = {
    version: SPEC_VERSION,
    title: String(src.title ?? boardName).slice(0, 80),
    board: {
      width: clamp(Number(board.width) || 1440, 320, 3840),
      height: clamp(Number(board.height) || 900, 320, 3840),
      background: toHex(board.background ?? src.background ?? '#0B0B0F'),
    },
    palette: [],
    type_scale: [],
    sections: [],
    notes: String(src.notes ?? '').slice(0, 600),
  };

  // Palette: dedupe by name, always uppercase hex, always keep the board bg.
  // Two passes: a name that is already a canonical token wins over a sloppier
  // variant that merely slugifies to the same thing. A planner that emits both
  // "Bg!" and "bg" must not lose the exact "bg".
  const seen = new Set();
  const rawPalette = Array.isArray(src.palette) ? src.palette : [];
  const isCanonical = (n) => typeof n === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n);
  const orderedPalette = [
    ...rawPalette.filter((c) => isCanonical(c?.name)),
    ...rawPalette.filter((c) => !isCanonical(c?.name)),
  ];
  for (const c of orderedPalette) {
    const name = slug(c?.name, `color-${seen.size + 1}`);
    if (seen.has(name)) continue;
    seen.add(name);
    spec.palette.push({ name, hex: toHex(c?.hex ?? c?.value ?? c?.color) });
  }
  if (!seen.has('bg')) {
    spec.palette.unshift({ name: 'bg', hex: spec.board.background });
    seen.add('bg');
  }

  // Type scale: sorted, sane sizes, named.
  for (const t of Array.isArray(src.type_scale) ? src.type_scale : []) {
    const size = clamp(Number(t?.size) || 16, 10, 200);
    spec.type_scale.push({
      name: slug(t?.name, `step-${spec.type_scale.length + 1}`),
      size,
      weight: clamp(Number(t?.weight) || 400, 100, 900),
    });
  }
  if (!spec.type_scale.length) {
    spec.type_scale = [
      { name: 'display', size: 64, weight: 700 },
      { name: 'heading', size: 28, weight: 600 },
      { name: 'body', size: 18, weight: 400 },
      { name: 'caption', size: 14, weight: 400 },
    ];
  }

  // Sections: id, height, background token, text blocks with resolved colours.
  const paletteNames = new Set(spec.palette.map((c) => c.name));
  const textColorFallback =
    spec.palette.find((c) => c.name === 'text')?.name ?? spec.palette[1]?.name ?? 'bg';

  for (const s of Array.isArray(src.sections) ? src.sections : []) {
    const id = slug(s?.id ?? s?.name, `section-${spec.sections.length + 1}`);
    let background = slug(s?.background, 'bg');
    if (!paletteNames.has(background)) background = 'bg';

    const text = [];
    for (const t of Array.isArray(s?.text) ? s.text : []) {
      let color = slug(t?.color, textColorFallback);
      if (!paletteNames.has(color)) color = textColorFallback;
      text.push({
        role: slug(t?.role ?? t?.name, 'text'),
        copy: String(t?.copy ?? t?.text ?? '').slice(0, 400),
        size: clamp(Number(t?.size) || 18, 8, 200),
        weight: clamp(Number(t?.weight) || 400, 100, 900),
        color,
        background,
      });
    }

    spec.sections.push({
      id,
      role: String(s?.role ?? 'content').slice(0, 40),
      height: clamp(Number(s?.height) || 120, 24, 2000),
      description: String(s?.description ?? '').slice(0, 400),
      background,
      text,
    });
  }

  if (!spec.sections.length) {
    spec.sections.push({
      id: 'body',
      role: 'content',
      height: 400,
      description: 'Empty screen. The planner produced no sections.',
      background: 'bg',
      text: [],
    });
  }

  // Total height must fit the board; grow the board rather than clip content.
  const stacked = spec.sections.reduce((n, s) => n + s.height, 0);
  if (stacked > spec.board.height) spec.board.height = Math.min(3840, stacked);

  // Single source of truth for the page background. If the palette declares a
  // 'bg' token the board must use it, otherwise the board and the sections
  // disagree about what "background" means and a gap shows the wrong colour.
  const bgToken = spec.palette.find((c) => c.name === 'bg');
  if (bgToken) spec.board.background = bgToken.hex;

  return spec;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** A compact, model-readable view of a spec, for revision prompts. */
export function summarizeSpec(spec) {
  const palette = spec.palette.map((c) => `${c.name}=${c.hex}`).join(', ');
  const scale = spec.type_scale.map((t) => `${t.name}=${t.size}px/${t.weight}`).join(', ');
  const sections = spec.sections
    .map((s) => {
      const texts = s.text.map((t) => `"${t.copy}" ${t.size}px ${t.color}`).join(' | ') || '(no text)';
      return `  - ${s.id} [${s.role}] h=${s.height} bg=${s.background}: ${texts}`;
    })
    .join('\n');
  return [
    `title: ${spec.title}`,
    `board: ${spec.board.width}x${spec.board.height} bg=${spec.board.background}`,
    `palette: ${palette}`,
    `type_scale: ${scale}`,
    `sections:\n${sections}`,
  ].join('\n');
}

/** Structural diff between two specs, for the report and the transcript. */
export function diffSpecs(a, b) {
  const changes = [];
  if (!a) return [{ field: 'spec', from: null, to: 'created' }];
  if (a.title !== b.title) changes.push({ field: 'title', from: a.title, to: b.title });
  if (a.board.height !== b.board.height)
    changes.push({ field: 'board.height', from: a.board.height, to: b.board.height });
  if (a.board.background !== b.board.background)
    changes.push({ field: 'board.background', from: a.board.background, to: b.board.background });

  const aPal = new Map(a.palette.map((c) => [c.name, c.hex]));
  const bPal = new Map(b.palette.map((c) => [c.name, c.hex]));
  for (const [name, hex] of bPal) {
    if (!aPal.has(name)) changes.push({ field: `palette.${name}`, from: null, to: hex });
    else if (aPal.get(name) !== hex)
      changes.push({ field: `palette.${name}`, from: aPal.get(name), to: hex });
  }
  for (const name of aPal.keys()) {
    if (!bPal.has(name)) changes.push({ field: `palette.${name}`, from: aPal.get(name), to: null });
  }

  const aSec = new Map(a.sections.map((s) => [s.id, s]));
  const bSec = new Map(b.sections.map((s) => [s.id, s]));
  for (const [id, s] of bSec) {
    if (!aSec.has(id)) changes.push({ field: `section.${id}`, from: null, to: `${s.role} h=${s.height}` });
    else if (aSec.get(id).height !== s.height)
      changes.push({ field: `section.${id}.height`, from: aSec.get(id).height, to: s.height });
  }
  for (const id of aSec.keys()) {
    if (!bSec.has(id)) changes.push({ field: `section.${id}`, from: 'present', to: null });
  }
  return changes;
}