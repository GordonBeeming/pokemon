// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardFrame, formatFramePrice, type CardFrameCard } from './CardFrame';
import { PriceVisibilityContextForTests } from './PriceVisibility';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
});

const pikachu: CardFrameCard = {
  id: 'card-1',
  name: 'Pikachu',
  frameType: 'lightning',
  setCode: 'MEW',
  number: '025',
  rarityKey: 'C',
  pokedexNumber: 25,
  imageUrl: 'https://example.test/pikachu.png',
};

function frameEl(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.card-frame');
}

describe('CardFrame', () => {
  it('shows the market estimate bottom right, and nothing without one', async () => {
    await step(() =>
      root.render(<CardFrame card={{ ...pikachu, priceAud: 12.4 }} state="owned" />),
    );
    expect(container.querySelector('.card-frame-price')?.textContent).toBe('~A$12');
    await step(() =>
      root.render(<CardFrame card={{ ...pikachu, priceAud: null }} state="owned" />),
    );
    expect(container.querySelector('.card-frame-price')).toBeNull();
    await step(() =>
      root.render(<CardFrame card={{ ...pikachu, priceAud: 3 }} state="owned" variant="any" />),
    );
    expect(container.querySelector('.card-frame-price')).toBeNull();
  });

  it('shows no price when prices are hidden for this person', async () => {
    await step(() =>
      root.render(
        <PriceVisibilityContextForTests value={false}>
          <CardFrame card={{ ...pikachu, priceAud: 12.4 }} state="owned" />
        </PriceVisibilityContextForTests>,
      ),
    );
    expect(container.querySelector('.card-frame-price')).toBeNull();
  });

  it('rounds to dollars, keeping cents under a dollar', () => {
    expect(formatFramePrice(0.4)).toBe('~A$0.40');
    expect(formatFramePrice(12.5)).toBe('~A$13');
    expect(formatFramePrice(1234.2)).toBe('~A$1,234');
  });

  it('renders a solid frame for owned and placed, dashed for unowned', async () => {
    await step(() => root.render(<CardFrame card={pikachu} state="owned" onView={vi.fn()} />));
    expect(frameEl()?.style.borderStyle).toBe('solid');

    await step(() => root.render(<CardFrame card={pikachu} state="placed" onView={vi.fn()} />));
    expect(frameEl()?.style.borderStyle).toBe('solid');

    await step(() => root.render(<CardFrame card={pikachu} state="unowned" onView={vi.fn()} />));
    expect(frameEl()?.style.borderStyle).toBe('dashed');
  });

  it('forces the solid style for an unowned card when forceSolid is set', async () => {
    await step(() =>
      root.render(<CardFrame card={pikachu} state="unowned" forceSolid onView={vi.fn()} />),
    );
    expect(frameEl()?.style.borderStyle).toBe('solid');
  });

  it('renders ANY instead of the set code and number for the any-printing variant', async () => {
    await step(() => root.render(<CardFrame card={pikachu} state="owned" variant="any" />));
    expect(container.textContent).toContain('ANY');
    expect(container.textContent).not.toContain('MEW');
    expect(container.querySelector('.card-frame-rarity')).toBeNull();
  });

  it('renders only the raw art with no frame chrome when frame is false', async () => {
    await step(() => root.render(<CardFrame card={pikachu} state="owned" frame={false} />));
    expect(container.querySelector('.card-frame-row')).toBeNull();
    expect(container.querySelector('img.card-frame-art')).not.toBeNull();
  });

  it('shows no copy count, only owned or not owned in its accessible name', async () => {
    await step(() => root.render(<CardFrame card={pikachu} state="owned" onView={() => {}} />));
    expect(container.textContent).not.toMatch(/×\d/u);
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toMatch(
      /, owned$/u,
    );

    await step(() => root.render(<CardFrame card={pikachu} state="unowned" onView={() => {}} />));
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toMatch(
      /, not owned$/u,
    );
  });

  it('picks dark text for a pale frame colour and white text for a dark one', async () => {
    const paleCard: CardFrameCard = { ...pikachu, frameType: 'special-energy' };
    await step(() => root.render(<CardFrame card={paleCard} state="owned" />));
    expect(frameEl()?.style.color).toBe('#0f172a');

    await step(() => root.render(<CardFrame card={pikachu} state="owned" />));
    expect(frameEl()?.style.color).toBe('#ffffff');
  });

  it('shows a type-tinted placeholder with the card name when art is missing', async () => {
    const noArt: CardFrameCard = { ...pikachu, imageUrl: null };
    await step(() => root.render(<CardFrame card={noArt} state="owned" />));
    expect(container.querySelector('img')).toBeNull();
    const placeholder = container.querySelector<HTMLElement>('.card-frame-art-placeholder');
    expect(placeholder?.textContent).toBe('Pikachu');
    // The placeholder's text colour is chosen against its own (pale) background,
    // not borrowed from the frame's white-on-solid text colour.
    expect(placeholder?.style.color).toBe('#0f172a');
  });

  it('uses the neutral placeholder, not a type tint, for missing art with frame=false', async () => {
    const noArt: CardFrameCard = { ...pikachu, imageUrl: null };
    await step(() => root.render(<CardFrame card={noArt} state="owned" frame={false} />));
    const placeholder = container.querySelector<HTMLElement>('.card-frame-art-placeholder');
    expect(placeholder?.style.background).toBe('#e2e8f0');
    expect(placeholder?.style.color).toBe('#0f172a');
  });

  it('is a button when onView is given and a non-interactive element otherwise', async () => {
    await step(() => root.render(<CardFrame card={pikachu} state="owned" onView={vi.fn()} />));
    expect(container.querySelector('button.card-frame')).not.toBeNull();

    await step(() => root.render(<CardFrame card={pikachu} state="owned" />));
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('div.card-frame')).not.toBeNull();
  });

  it('calls onView when clicked', async () => {
    const onView = vi.fn();
    await step(() => root.render(<CardFrame card={pikachu} state="owned" onView={onView} />));
    await step(() => container.querySelector('button')?.click());
    expect(onView).toHaveBeenCalledTimes(1);
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
