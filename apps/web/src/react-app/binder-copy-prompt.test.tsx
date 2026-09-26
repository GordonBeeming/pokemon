// @vitest-environment happy-dom
import { act } from 'react';
import { cardIdSchema } from '@pokedex/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BinderCopyPrompt } from './binder-copy-prompt';
import { api, type CatalogueCardView } from './api';
vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>();
  return { ...actual, api: { ...actual.api, card: vi.fn() } };
});
const card: CatalogueCardView = {
  id: cardIdSchema.parse('card-1'),
  name: 'Bulbasaur',
  language: 'en',
  category: 'pokemon',
  setId: 'base',
  setName: 'Base',
  number: '44',
  imageLowUrl: null,
  imageHighUrl: null,
  collection: null,
  price: {
    amountAud: null,
    nativeAmount: null,
    nativeCurrency: null,
    source: null,
    sourceCapturedAt: null,
    fxDate: null,
  },
};
let container: HTMLDivElement;
let root: Root;
const choose = vi.fn();
const cancel = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
async function interact(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
afterEach(async () => {
  await interact(() => root.unmount());
  container.remove();
});
async function render(quantity: number): Promise<void> {
  vi.mocked(api.card).mockResolvedValue({
    ...card,
    collection: {
      cardId: cardIdSchema.parse('card-1'),
      quantity,
      revision: 7,
      notes: null,
      updatedAt: '2026-09-26T00:00:00Z',
    },
    supertype: null,
    subtype: null,
    species: null,
    rarity: null,
    artist: null,
    notes: null,
    source: { provider: 'manual', sourceId: 'card-1', updatedAt: '2026-09-26T00:00:00Z' },
  });
  await interact(() =>
    root.render(
      <BinderCopyPrompt card={card} pending={false} onChoose={choose} onCancel={cancel} />,
    ),
  );
}
function button(text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(text),
  );
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
describe('binder copy prompt', () => {
  it('shows the refreshed count and explicitly adds exactly one more copy', async () => {
    await render(1);
    expect(container.textContent).toContain('You own 1 copy');
    expect(button('Add a new copy').textContent).toContain('1 → 2');
    expect(choose).not.toHaveBeenCalled();
    await interact(() => button('Add a new copy').click());
    expect(choose).toHaveBeenCalledWith({ action: 'add', expectedCollectionRevision: 7 });
  });
  it('offers existing copies without incrementing and permits target-only placement', async () => {
    await render(2);
    await interact(() => button('Use an existing copy').click());
    expect(choose).toHaveBeenLastCalledWith({ action: 'existing' });
    await interact(() => button('Don’t add a copy').click());
    expect(choose).toHaveBeenLastCalledWith({ action: 'none' });
  });
  it('disables existing-copy placement at zero and lets the user cancel without mutation', async () => {
    await render(0);
    expect(button('Use an existing copy').disabled).toBe(true);
    await interact(() => button('Back to cards').click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(choose).not.toHaveBeenCalled();
  });
  it('keeps choices unavailable when loading the owned count fails, then allows retry', async () => {
    vi.mocked(api.card).mockRejectedValueOnce(new Error('offline'));
    await render(1);
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    expect(container.textContent).not.toContain('Add a new copy');
    button('Refresh owned count').focus();
    await interact(() => button('Refresh owned count').click());
    expect(document.activeElement).toBe(button('Refresh owned count'));
    expect(container.textContent).toContain('You own 1 copy');
  });
});
