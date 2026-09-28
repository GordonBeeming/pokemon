// @vitest-environment happy-dom
import { act, useState, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinderSearch } from '../../routes/search-params';
import { BinderDetail } from '../BinderDetail';
import { FakeServer, flush, makeBinder, renderWithProviders, waitFor } from './test-harness';

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root | undefined;
let server: FakeServer;
let switchBinder: (binderId: string) => void = () => undefined;
let initialSearch: BinderSearch = { page: 1, q: '' };
let currentSearch: BinderSearch = initialSearch;

function Screen(): ReactElement {
  const [binderId, setBinderId] = useState('binder_a');
  const [search, setSearch] = useState<BinderSearch>(initialSearch);
  currentSearch = search;
  switchBinder = (next) => {
    // Opening another binder by URL: new id, and that URL's own (empty) search.
    setBinderId(next);
    setSearch({ page: 1, q: '' });
  };
  return (
    <BinderDetail
      binderId={binderId}
      search={search}
      onSearch={(next) => setSearch(next)}
      onOpenLibrary={() => undefined}
      onFindCards={() => undefined}
    />
  );
}

function pocket(at: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`[data-pocket="${at}"]`);
  if (!element) throw new Error(`pocket ${at} is not rendered`);
  return element;
}

async function key(target: Element, name: string): Promise<void> {
  await step(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  });
}

async function focusedKey(name: string): Promise<void> {
  const target = document.activeElement ?? document.body;
  await key(target, name);
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await step(() => {
    // React tracks the value through the prototype setter, so go through it.
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount(): Promise<void> {
  const rendered = await renderWithProviders(container, () => <Screen />);
  root = rendered.root;
  await waitFor(() => container.querySelector('[data-pocket="0:0:0"]') !== null);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  initialSearch = { page: 1, q: '' };
  server = new FakeServer([makeBinder('binder_a', 'Alpha'), makeBinder('binder_b', 'Beta')]);
  server.install();
});

afterEach(async () => {
  await step(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

describe('BinderView move mode', () => {
  it('picks up with m, chooses with arrows, drops with Enter using the seen revision', async () => {
    await mount();
    const source = pocket('0:0:0');
    source.focus();
    await key(source, 'm');
    expect(container.textContent).toContain('Moving #0001 Bulbasaur');

    for (const step of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight'])
      await focusedKey(step);
    expect(pocket('0:2:2').className).toContain('pocket-move-cursor');
    await focusedKey('Enter');
    await waitFor(() => server.count('POST', '/swap') === 1);

    const swap = server.requests.find((request) => request.path.endsWith('/swap'));
    expect(swap?.body).toEqual({
      source: { page: 0, row: 0, column: 0 },
      target: { page: 0, row: 2, column: 2 },
      expectedRevision: 3,
    });
    await waitFor(() => !container.textContent?.includes('Moving #0001'));
  });

  it('Escape cancels an armed move without writing anything', async () => {
    await mount();
    const source = pocket('0:0:1');
    source.focus();
    await key(source, 'm');
    expect(container.textContent).toContain('Moving #0002 Ivysaur');
    await focusedKey('Escape');
    expect(container.textContent).not.toContain('Moving #0002');
    expect(server.count('POST', '/swap')).toBe(0);
  });
});

describe('BinderView revision conflicts', () => {
  it('shows what changed on a 409 and only retries when asked', async () => {
    server.overrides.push((request) =>
      request.path.endsWith('/swap')
        ? { status: 409, body: { ok: false, error: 'binder_revision_conflict', requestId: 'r1' } }
        : undefined,
    );
    await mount();
    const source = pocket('0:0:0');
    source.focus();
    await key(source, 'm');
    for (const step of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight'])
      await focusedKey(step);
    await focusedKey('Enter');

    await waitFor(() => container.textContent?.includes('changed elsewhere') === true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Nothing of yours was saved',
    );
    expect(server.count('POST', '/swap')).toBe(1);
    // The page was reloaded to show the latest state...
    expect(
      server.requests.filter((request) => request.path.includes('?page=0')).length,
    ).toBeGreaterThan(1);

    // ...and nothing retries on its own.
    await flush(20);
    expect(server.count('POST', '/swap')).toBe(1);

    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Try again on the latest',
    );
    if (!retry) throw new Error('retry button missing');
    await step(() => retry.click());
    await waitFor(() => server.count('POST', '/swap') === 2);
  });
});

describe('BinderView state that belongs to one binder', () => {
  it('never carries a picked-up card into a different binder', async () => {
    await mount();
    const source = pocket('0:0:0');
    source.focus();
    await key(source, 'm');
    expect(container.textContent).toContain('Moving #0001 Bulbasaur');

    await step(() => switchBinder('binder_b'));
    await waitFor(() => container.querySelector('h1')?.textContent === 'Beta');
    await flush();
    expect(container.textContent).not.toContain('Moving');
    expect(container.querySelector('.pocket-move-source')).toBeNull();
  });

  it('drops an unsubmitted page-jump value when another binder opens', async () => {
    await mount();
    const jump = container.querySelector<HTMLInputElement>('input[aria-label="Go to page"]');
    if (!jump) throw new Error('page jump input missing');
    await setInput(jump, '45');
    expect(jump.value).toBe('45');

    await step(() => switchBinder('binder_b'));
    await waitFor(() => container.querySelector('h1')?.textContent === 'Beta');
    const fresh = container.querySelector<HTMLInputElement>('input[aria-label="Go to page"]');
    expect(fresh?.value).toBe('');
  });
});

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button "${label}" is not rendered`);
  return found;
}

describe('BinderView drafts', () => {
  async function openDraft(): Promise<void> {
    const alpha = server.binders[0];
    if (!alpha) throw new Error('fixture missing');
    alpha.draft = { versionId: 'binder_a_v2', revision: 5 };
    initialSearch = { page: 1, q: '', v: 'binder_a_v2' };
    await mount();
    await waitFor(() => container.textContent?.includes('You’re editing a draft') === true);
    await step(() => button('Manage binder').click());
    await step(() => button('Discard draft').click());
  }

  it('discards a draft only after confirming, with the revision it last saw, then shows the active binder', async () => {
    await openDraft();
    expect(server.count('DELETE', '/binder_a_v2')).toBe(0);
    await step(() => button('Discard draft').click());
    await waitFor(() => server.count('DELETE', '/binder_a_v2') === 1);

    const request = server.requests.find((item) => item.method === 'DELETE');
    expect(request?.path).toBe('/api/binders/versions/binder_a_v2');
    expect(request?.body).toEqual({ expectedRevision: 5 });
    await waitFor(() => currentSearch.v === undefined);
    await waitFor(() => !container.textContent?.includes('You’re editing a draft'));
    expect(document.body.textContent).toContain('Draft discarded. The active binder is unchanged.');
  });

  it('explains a refusal and keeps the draft open', async () => {
    server.overrides.push((request) =>
      request.method === 'DELETE'
        ? { status: 409, body: { ok: false, error: 'binder_revision_conflict', requestId: 'r' } }
        : undefined,
    );
    await openDraft();
    await step(() => button('Discard draft').click());
    await waitFor(() => document.body.textContent?.includes('changed elsewhere') === true);
    expect(currentSearch.v).toBe('binder_a_v2');
    expect(server.count('DELETE', '/binder_a_v2')).toBe(1);
  });
});
