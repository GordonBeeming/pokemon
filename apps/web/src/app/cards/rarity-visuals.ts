import type { RarityKey } from '@pokedex/shared';

export type RarityTone = 'ink' | 'silver' | 'gold';

// The printed symbol and metal tone per rarity, from the CardFrames canvas board.
// RARITY_LABELS (packages/shared) already carries the accessible name; this is purely
// the visual layer CardFrame draws on top of it.
export const RARITY_VISUALS: Record<RarityKey, { icon: string; tone: RarityTone }> = {
  C: { icon: '●', tone: 'ink' },
  U: { icon: '◆', tone: 'ink' },
  R: { icon: '★', tone: 'ink' },
  HV: { icon: '★', tone: 'ink' },
  RR: { icon: '★★', tone: 'ink' },
  UR: { icon: '★★', tone: 'silver' },
  IR: { icon: '★', tone: 'gold' },
  SIR: { icon: '★★', tone: 'gold' },
  HR: { icon: '★★★', tone: 'gold' },
  SR: { icon: '✦', tone: 'gold' },
  S: { icon: '✧', tone: 'gold' },
  ACE: { icon: '◈', tone: 'gold' },
  PR: { icon: '✪', tone: 'ink' },
};

/** The metal colours a rarity symbol is drawn in: bright on a solid (owned) frame,
 * deeper on a pale one. Anything else showing a symbol (the Sets legend) uses the
 * same values so a symbol never looks different off the card. */
export const RARITY_TONE_COLOURS: Record<
  Exclude<RarityTone, 'ink'>,
  { onSolid: string; onLight: string }
> = {
  gold: { onSolid: '#fcd34d', onLight: '#a16207' },
  silver: { onSolid: '#e2e8f0', onLight: '#64748b' },
};

/** The colour to draw `tone` in; `ink` is whatever text colour the surface uses. */
export function rarityToneColour(tone: RarityTone, solid: boolean, ink: string): string {
  if (tone === 'ink') return ink;
  const colours = RARITY_TONE_COLOURS[tone];
  return solid ? colours.onSolid : colours.onLight;
}
