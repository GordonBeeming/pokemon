export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function toneClass(tone: Tone): string {
  return `tone-${tone}`;
}

export const componentClassNames = {
  quietButton: 'quiet-button',
  stateBadge: 'state-badge',
} as const;
