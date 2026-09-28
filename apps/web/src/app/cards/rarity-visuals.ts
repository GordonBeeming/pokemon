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
