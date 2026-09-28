// Shared colour math for anything that needs to know whether a frame colour reads
// better with white or dark text — CardFrame, and the Settings frame-colour picker's
// "Text hard to read" warning (same threshold, so they never disagree).

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function toRgb(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function channelHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

function toHex({ r, g, b }: Rgb): string {
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
}

export function mix(hex: string, other: string, amount: number): string {
  const a = toRgb(hex);
  const b = toRgb(other);
  return toHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

function channelLuminance(value: number): number {
  const normalised = value / 255;
  return normalised <= 0.03928 ? normalised / 12.92 : Math.pow((normalised + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = toRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

const DARK_TEXT = '#0f172a';

export function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

export function contrastWithDark(hex: string): number {
  return (relativeLuminance(hex) + 0.05) / (relativeLuminance(DARK_TEXT) + 0.05);
}

/** Neither white nor dark text reads at 4.5:1 — only then is a colour a real problem. */
export function isLowContrast(hex: string): boolean {
  return contrastWithWhite(hex) < 4.5 && contrastWithDark(hex) < 4.5;
}

/** True when the colour is pale enough that dark text reads better on it than white. */
export function prefersDarkText(hex: string): boolean {
  return contrastWithWhite(hex) < 4.5 && contrastWithDark(hex) >= 4.5;
}

/**
 * Picks whichever of white or dark text contrasts better against `hex`. Used
 * anywhere text sits on a colour that isn't necessarily a frame's "owned" solid —
 * the missing-art placeholder's pale tint, for instance — so it can't just borrow
 * the frame's own text-colour choice, which was computed against a different fill.
 */
export function bestTextColor(hex: string): '#ffffff' | '#0f172a' {
  return contrastWithWhite(hex) >= contrastWithDark(hex) ? '#ffffff' : '#0f172a';
}
