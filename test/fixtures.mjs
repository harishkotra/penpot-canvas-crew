/**
 * Shared fixtures. The spec here is the same one the mock model returns, so the
 * unit tests and the offline end-to-end run agree about what "the design" is.
 */

export const INITIAL_SPEC = {
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