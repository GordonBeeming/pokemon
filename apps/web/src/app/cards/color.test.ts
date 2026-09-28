import { describe, expect, it } from 'vitest';
import {
  bestTextColor,
  contrastWithDark,
  contrastWithWhite,
  isLowContrast,
  mix,
  prefersDarkText,
} from './color';

describe('mix', () => {
  it('returns the first colour at amount 0 and the second at amount 1', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('blends proportionally', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe('contrast', () => {
  it('gives a white background near-zero contrast against white text', () => {
    expect(contrastWithWhite('#ffffff')).toBeCloseTo(1, 1);
  });

  it('gives a white background strong contrast against dark text', () => {
    expect(contrastWithDark('#ffffff')).toBeGreaterThan(15);
  });

  it('gives white text the best contrast against black', () => {
    expect(contrastWithWhite('#000000')).toBeGreaterThan(20);
  });
});

describe('isLowContrast', () => {
  it('is false for a colour dark enough for white text', () => {
    expect(isLowContrast('#0f172a')).toBe(false);
  });

  it('is false for a colour pale enough for dark text', () => {
    expect(isLowContrast('#f8fafc')).toBe(false);
  });

  it('is true for a mid-tone colour that reads poorly either way', () => {
    expect(isLowContrast('#7c7c7c')).toBe(true);
  });
});

describe('prefersDarkText', () => {
  it('prefers dark text on the special-energy neutral', () => {
    expect(prefersDarkText('#cbd5e1')).toBe(true);
  });

  it('prefers white text on a saturated dark frame colour', () => {
    expect(prefersDarkText('#3f6212')).toBe(false);
  });
});

describe('bestTextColor', () => {
  it('picks dark text on a pale tint', () => {
    // The ~88%-toward-white mix CardFrame uses for its missing-art placeholder.
    expect(bestTextColor(mix('#3f6212', '#ffffff', 0.88))).toBe('#0f172a');
  });

  it('picks white text on a saturated dark frame colour', () => {
    expect(bestTextColor('#3f6212')).toBe('#ffffff');
  });

  it('picks dark text on the neutral placeholder background', () => {
    expect(bestTextColor('#e2e8f0')).toBe('#0f172a');
  });
});
