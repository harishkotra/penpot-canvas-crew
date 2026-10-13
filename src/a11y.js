/**
 * Deterministic accessibility gate.
 *
 * This is the part of the crew that is not a language model, on purpose.
 * Contrast is arithmetic: WCAG 2.2 relative luminance and contrast ratio.
 * A model can be argued with, a ratio cannot. The critic receives these
 * findings as facts it has to address, and the arbiter will not accept a
 * design that fails the gate.
 *
 * References: WCAG 2.2 SC 1.4.3 (contrast minimum, 4.5:1 / 3:1 large text)
 * and SC 1.4.11 (non-text contrast, 3:1).
 */

/** Parse #RGB or #RRGGBB into [r, g, b] 0-255. Returns null when invalid. */
export function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(h)) return null;
  if (h.length === 3) {
    return h.split('').map((c) => parseInt(c + c, 16));
  }
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance, WCAG 2.x definition. */
export function relativeLuminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two hex colours. Returns null when either is invalid. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG "large text": >=24px, or >=18.66px when bold (>=700). */
export function isLargeText(fontSizePx, fontWeight = 400) {
  const size = Number(fontSizePx) || 0;
  const weight = Number(fontWeight) || 400;
  return size >= 24 || (size >= 18.66 && weight >= 700);
}

/** The threshold that applies to a given piece of text. */
export function requiredContrast(fontSizePx, fontWeight = 400) {
  return isLargeText(fontSizePx, fontWeight) ? 3.0 : 4.5;
}

/**
 * Audit a ScreenSpec. Returns { findings, checked, failures, passed }.
 * Each finding is { severity, area, issue, fix, ratio, required }.
 */
export function auditSpec(spec) {
  const findings = [];
  let checked = 0;
  let failures = 0;

  const paletteMap = new Map((spec.palette ?? []).map((c) => [c.name, c.hex]));
  const boardBg = spec.board?.background ?? '#FFFFFF';

  // 1. Board background must itself be a real colour.
  if (!parseHex(boardBg)) {
    findings.push({
      severity: 'blocker',
      area: 'board',
      issue: `Board background "${boardBg}" is not a valid hex colour.`,
      fix: 'Use an uppercase 6-digit hex such as #0B0B0F.',
    });
    failures++;
  }

  // 2. Palette sanity.
  if ((spec.palette ?? []).length < 3) {
    findings.push({
      severity: 'major',
      area: 'palette',
      issue: `Palette has ${(spec.palette ?? []).length} colour(s). A screen needs a background, a body colour and an accent at minimum.`,
      fix: 'Add the missing colours to the palette and reference them by name.',
    });
    failures++;
  }

  // 3. Real contrast maths on every declared text block.
  for (const section of spec.sections ?? []) {
    const sectionBg = paletteMap.get(section.background) ?? boardBg;
    for (const t of section.text ?? []) {
      const fg = paletteMap.get(t.color) ?? t.color;
      const bg = t.background ? paletteMap.get(t.background) ?? t.background : sectionBg;
      const ratio = contrastRatio(fg, bg);
      const required = requiredContrast(t.size, t.weight);
      checked++;
      if (ratio === null) {
        findings.push({
          severity: 'major',
          area: `section:${section.id}/text:${t.role}`,
          issue: `Cannot compute contrast: foreground "${fg}" or background "${bg}" is not a valid hex colour.`,
          fix: 'Resolve both colours to uppercase 6-digit hex.',
        });
        failures++;
        continue;
      }
      if (ratio < required) {
        findings.push({
          severity: 'blocker',
          area: `section:${section.id}/text:${t.role}`,
          issue: `Contrast ${ratio.toFixed(2)}:1 is below the ${required}:1 required for ${isLargeText(t.size, t.weight) ? 'large' : 'body'} text ("${t.copy ?? t.role}" at ${t.size}px/${t.weight}).`,
          fix: `Darken or lighten the text colour, or change the surface behind it, until the ratio reaches ${required}:1.`,
          ratio: Number(ratio.toFixed(2)),
          required,
        });
        failures++;
      }
    }
  }

  // 4. Body copy size floor (a legibility rule, not a WCAG failure).
  for (const section of spec.sections ?? []) {
    for (const t of section.text ?? []) {
      if (Number(t.size) > 0 && Number(t.size) < 12) {
        findings.push({
          severity: 'minor',
          area: `section:${section.id}/text:${t.role}`,
          issue: `Font size ${t.size}px is below the 12px legibility floor.`,
          fix: 'Raise it to at least 12px, ideally 16px for body copy.',
        });
        failures++;
      }
    }
  }

  return {
    findings,
    checked,
    failures,
    passed: failures === 0,
    worst: findings.reduce((acc, f) => (f.severity === 'blocker' ? acc + 1 : acc), 0),
  };
}

/**
 * Render findings as a compact text block for a model prompt.
 * Deterministic findings go in as facts, clearly separated from the model's
 * own visual judgement, so it cannot quietly ignore them.
 */
export function formatFindings(audit) {
  if (!audit.findings.length) {
    return `Deterministic checks: all ${audit.checked} text/background pairs pass their WCAG threshold.`;
  }
  const lines = audit.findings.map(
    (f) => `- [${f.severity.toUpperCase()}] ${f.area}: ${f.issue} FIX: ${f.fix}`,
  );
  return `Deterministic checks: ${audit.failures} failure(s) across ${audit.checked} checked pair(s). These are computed, not opinions, and must be addressed.\n${lines.join('\n')}`;
}