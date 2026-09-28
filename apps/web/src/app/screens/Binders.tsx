import type { BinderLayout } from '@pokedex/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { queryKeys } from '../api/keys';
import { binderApi, useBinders, useBinderSummaries } from '../api/queries/binders';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/icons';
import { useRouteAnnounce, useToast } from '../ui/Toast';
import {
  BINDER_NAME_MAX,
  binderErrorMessage,
  capacityDescription,
  layoutFor,
  PAGE_FACES,
} from './binders/model';
import './binders/binders.css';

export function CreateBinderForm({
  pending,
  error,
  onCreate,
  onCancel,
}: {
  pending: boolean;
  error: string | null;
  onCreate: (name: string, layout: BinderLayout, capacity: number) => void;
  onCancel: () => void;
}): ReactElement {
  const id = useId();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BinderLayout['kind']>('3x3');
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const [capacity, setCapacity] = useState(9);
  const layout = layoutFor(kind, rows, columns);
  const face = layout.rows * layout.columns;
  const validShape =
    kind !== 'custom' ||
    (Number.isInteger(rows) &&
      rows >= 1 &&
      rows <= 20 &&
      Number.isInteger(columns) &&
      columns >= 1 &&
      columns <= 20);
  const validCapacity = Number.isInteger(capacity) && capacity >= 1;
  const valid = name.trim().length > 0 && validShape && validCapacity;

  return (
    <form
      className="create-binder"
      aria-labelledby={`${id}-heading`}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !pending) onCreate(name.trim(), layout, capacity);
      }}
    >
      <h2 id={`${id}-heading`}>New binder</h2>
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      <label className="panel-field">
        <span>Name</span>
        <input
          value={name}
          maxLength={BINDER_NAME_MAX}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <fieldset className="page-face-picker">
        <legend>Page face</legend>
        <div>
          {PAGE_FACES.map((item) => (
            <button
              key={item.kind}
              type="button"
              aria-pressed={kind === item.kind}
              onClick={() => {
                setKind(item.kind);
                if (item.kind !== 'custom') setCapacity(item.rows * item.columns);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </fieldset>
      {kind === 'custom' ? (
        <div className="panel-inline">
          <label>
            <span>Rows</span>
            <input
              type="number"
              min="1"
              max="20"
              value={rows}
              aria-invalid={!validShape}
              onChange={(event) => setRows(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Columns</span>
            <input
              type="number"
              min="1"
              max="20"
              value={columns}
              aria-invalid={!validShape}
              onChange={(event) => setColumns(Number(event.target.value))}
            />
          </label>
        </div>
      ) : null}
      <label className="panel-field">
        <span>Binder capacity (pockets)</span>
        <input
          type="number"
          min="1"
          step="1"
          value={capacity}
          aria-invalid={!validCapacity}
          aria-describedby={`${id}-capacity`}
          onChange={(event) => setCapacity(Number(event.target.value))}
        />
      </label>
      <p id={`${id}-capacity`} className="panel-help" aria-live="polite">
        {capacityDescription(capacity, face)} Each full page is {layout.rows} × {layout.columns}.
      </p>
      <div className="panel-actions">
        <button type="button" className="button-text" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className="button-primary" disabled={!valid || pending}>
          {pending ? 'Creating…' : 'Create binder'}
        </button>
      </div>
    </form>
  );
}

export function Binders({
  onOpenBinder,
}: {
  onOpenBinder: (binderId: string) => void;
}): ReactElement {
  const binders = useBinders();
  const queryClient = useQueryClient();
  const toast = useToast();
  const announce = useRouteAnnounce();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const list = binders.data ?? [];
  const versionIds = list.flatMap((binder) => {
    const versionId = binder.activeVersionId ?? binder.latestVersionId;
    return versionId ? [versionId] : [];
  });
  const summaries = useBinderSummaries(versionIds);
  const summaryByVersion = new Map(
    versionIds.flatMap((versionId, index) => {
      const data = summaries[index]?.data;
      return data ? [[versionId, data] as const] : [];
    }),
  );

  async function create(name: string, layout: BinderLayout, capacity: number): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await binderApi.create(name, layout, capacity);
      await queryClient.invalidateQueries({ queryKey: queryKeys.binders.list() });
      toast('success', `${name} was created.`);
      // A create that finishes after Gordon has moved on only toasts; it never pulls
      // him back to a screen he left.
      if (!mounted.current) return;
      setCreating(false);
      announce(`${name} was created.`);
      onOpenBinder(result.version.binderId);
    } catch (cause) {
      const message = binderErrorMessage(cause);
      if (mounted.current) setError(message);
      else toast('error', message);
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section className="binders-library" aria-labelledby="binders-heading">
      <header className="binders-library-header">
        <h1 id="binders-heading">Binders</h1>
        <button
          type="button"
          className="button-primary"
          aria-expanded={creating}
          onClick={() => {
            setCreating((value) => !value);
            setError(null);
          }}
        >
          <Icon name="plus" />
          New binder
        </button>
      </header>
      {creating ? (
        <CreateBinderForm
          pending={pending}
          error={error}
          onCreate={(name, layout, capacity) => void create(name, layout, capacity)}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {binders.isLoading ? (
        <p role="status">Loading binders…</p>
      ) : binders.isError ? (
        <div>
          <p role="alert" className="panel-error">
            {binderErrorMessage(binders.error)}
          </p>
          <button type="button" onClick={() => void binders.refetch()}>
            Try again
          </button>
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon="binder"
          title="No binders yet"
          description="Create a binder to plan where every card goes."
          action={creating ? undefined : { label: 'New binder', onSelect: () => setCreating(true) }}
        />
      ) : (
        <ul className="binder-tiles">
          {list.map((binder) => {
            const versionId = binder.activeVersionId ?? binder.latestVersionId;
            const summary = versionId ? summaryByVersion.get(versionId) : undefined;
            const draft =
              binder.latestVersionId !== null && binder.latestVersionId !== binder.activeVersionId;
            const fill =
              summary && summary.targets > 0
                ? Math.round((summary.placed / summary.targets) * 100)
                : 0;
            return (
              <li key={binder.id}>
                <button
                  type="button"
                  className="binder-tile"
                  onClick={() => onOpenBinder(binder.id)}
                >
                  <span className="binder-tile-name">
                    <Icon name="binder" />
                    {binder.name}
                  </span>
                  {summary ? (
                    <>
                      <span className="binder-tile-meta">
                        {summary.capacity.toLocaleString('en-AU')} pockets ·{' '}
                        {Math.ceil(summary.capacity / summary.pageSize).toLocaleString('en-AU')}{' '}
                        pages
                      </span>
                      <span className="binder-tile-meta">
                        {summary.placed.toLocaleString('en-AU')} of{' '}
                        {summary.targets.toLocaleString('en-AU')} targets placed
                      </span>
                      <span
                        className="binder-tile-bar"
                        role="img"
                        aria-label={`${fill}% of targets placed`}
                      >
                        <span style={{ width: `${fill}%` }} />
                      </span>
                    </>
                  ) : (
                    <span className="binder-tile-meta">Loading…</span>
                  )}
                  {draft ? <span className="binder-tile-badge">Draft in progress</span> : null}
                  {!binder.activeVersionId ? (
                    <span className="binder-tile-badge">Archived · read-only</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
