// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CardArt, isCardArtDimmed } from './card-art';

describe('CardArt', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.replaceChildren(container);
    root = createRoot(container);
  });

  afterEach(() => act(() => root.unmount()));

  it('replaces the previous image with a loader until the new source is ready', () => {
    act(() =>
      root.render(
        <CardArt src="/first.webp" alt="First card art" display={{ context: 'preview' }} />,
      ),
    );
    const first = container.querySelector('img');
    expect(container.querySelector('[data-image-state="loading"]')).not.toBeNull();
    expect(first?.classList).toContain('awaiting-image');

    act(() => {
      first?.dispatchEvent(new Event('load'));
    });
    expect(container.querySelector('[data-image-state="loaded"]')).not.toBeNull();
    expect(container.querySelector('.card-art-loading')).toBeNull();

    act(() =>
      root.render(
        <CardArt src="/second.webp" alt="Second card art" display={{ context: 'preview' }} />,
      ),
    );
    const second = container.querySelector('img');
    expect(second?.getAttribute('src')).toBe('/second.webp');
    expect(second?.classList).toContain('awaiting-image');
    expect(container.querySelector('[data-image-state="loading"]')).not.toBeNull();
    expect(container.querySelector('img[src="/first.webp"]')).toBeNull();

    act(() => {
      second?.dispatchEvent(new Event('load'));
    });
    expect(container.querySelector('[data-image-state="loaded"]')).not.toBeNull();
    expect(second?.classList).not.toContain('awaiting-image');
  });

  it('falls back only after the requested source fails', () => {
    act(() =>
      root.render(
        <CardArt src="/missing.webp" alt="Missing card art" display={{ context: 'preview' }} />,
      ),
    );
    const image = container.querySelector('img');
    act(() => {
      image?.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('[data-image-state="failed"]')).not.toBeNull();
    expect(container.querySelector('.card-art-loading')).toBeNull();
    expect(container.textContent).toContain('Art unavailable');
  });

  it('offers a Retina source and dims unowned art', () => {
    act(() =>
      root.render(
        <CardArt
          src="/card/low.webp"
          highSrc="/card/high.webp"
          alt="Squirtle card art"
          display={{ context: 'collection', owned: false }}
        />,
      ),
    );

    expect(container.querySelector('.card-art-unowned')).not.toBeNull();
    expect(container.querySelector('img')?.getAttribute('srcset')).toBe(
      '/card/low.webp 245w, /card/high.webp 600w',
    );
    expect(container.querySelector('img')?.getAttribute('sizes')).toBe('240px');
  });
  it('requires binder placement for full brightness and keeps neutral previews visible', () => {
    expect(isCardArtDimmed({ context: 'binder', placed: false })).toBe(true);
    expect(isCardArtDimmed({ context: 'binder', placed: true })).toBe(false);
    expect(isCardArtDimmed({ context: 'collection', owned: false })).toBe(true);
    expect(isCardArtDimmed({ context: 'collection', owned: true })).toBe(false);
    expect(isCardArtDimmed({ context: 'preview' })).toBe(false);
    act(() =>
      root.render(
        <CardArt src="/card.webp" alt="Target" display={{ context: 'binder', placed: false }} />,
      ),
    );
    expect(
      container.querySelector('[data-art-context="binder"][data-art-dimmed="true"]'),
    ).not.toBeNull();
    act(() =>
      root.render(
        <CardArt
          src="/card.webp"
          alt="Placed copy"
          display={{ context: 'binder', placed: true }}
        />,
      ),
    );
    expect(container.querySelector('.card-art-unowned')).toBeNull();
  });
});
