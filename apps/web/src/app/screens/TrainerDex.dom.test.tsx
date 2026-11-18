// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TrainerDexSearch } from '../routes/trainer-dex';
import { TrainerDex } from './TrainerDex';
const trainers = [
  {
    key: 'brock',
    name: 'Brock',
    regions: ['Kanto'],
    cardCount: 2,
    ownedCount: 1,
    representative: null,
  },
  {
    key: 'misty',
    name: 'Misty',
    regions: ['Kanto'],
    cardCount: 1,
    ownedCount: 0,
    representative: null,
  },
  {
    key: 'cynthia',
    name: 'Cynthia',
    regions: ['Sinnoh'],
    cardCount: 3,
    ownedCount: 0,
    representative: null,
  },
  {
    key: 'rei',
    name: 'Rei',
    regions: ['Hisui'],
    cardCount: 0,
    ownedCount: 0,
    representative: null,
  },
];
vi.mock('../api/queries/trainer-dex', () => ({
  useTrainerDex: () => ({ data: trainers, isPending: false, isError: false }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
    'aria-label'?: string;
    className?: string;
  }) => (
    <a
      href={`${to}?${new URLSearchParams(Object.entries(search ?? {}).map(([key, value]) => [key, String(value)]))}`}
      {...props}
    >
      {children}
    </a>
  ),
}));
vi.mock('../ui/SelectField', () => ({
  SelectField: ({
    label,
    value,
    options,
    onChange,
  }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
function Page() {
  const [search, setSearch] = useState<TrainerDexSearch>({
    q: '',
    region: 'all',
    available: true,
    page: 1,
  });
  return <TrainerDex search={search} onSearch={setSearch} />;
}
for (const [device, width, height] of [
  ['phone portrait', 390, 844],
  ['phone landscape', 844, 390],
  ['tablet portrait', 768, 1024],
  ['tablet landscape', 1024, 768],
  ['desktop', 1440, 1000],
] as const) {
  it(`filters trainers and opens their English card variants on ${device}`, () => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Page />
        </QueryClientProvider>,
      ),
    );
    expect(container.querySelectorAll('.trainer-dex-grid li')).toHaveLength(3);
    const region = container.querySelector('select');
    if (!region) throw new Error('Missing region filter');
    act(() => {
      region.value = 'Kanto';
      region.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelectorAll('.trainer-dex-grid li')).toHaveLength(2);
    const brock = container.querySelector<HTMLAnchorElement>('[aria-label^="Brock,"]');
    expect(brock?.href).toContain('character=brock');
    expect(brock?.href).toContain('language=en');
    act(() => {
      region.value = 'Hisui';
      region.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('No matching trainers');
    const available = container.querySelector<HTMLInputElement>('input[type=checkbox]');
    act(() => available?.click());
    expect(container.textContent).toContain('Rei');
    expect(container.textContent).toContain('No English printings in the catalogue');
  });
}
