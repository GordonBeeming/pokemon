import { useEffect, useState, type ReactElement } from 'react';
import type { BinderActivityResult } from '@pokedex/shared';
import { api } from '../../api/queries/binder-activity';
import { CardFrame } from '../../cards/CardFrame';
import { Icon } from '../../ui/icons';
import { binderErrorMessage as userMessage, frameCardFrom } from './model';

export function activityTime(seconds: number): string {
  return `${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(seconds * 1000))} AEST`;
}

function batchTime(seconds: number): string {
  return `${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(seconds * 1000))} AEST`;
}

export function BinderActivity({
  binderId,
  revision,
  onOpenCard,
}: {
  binderId: string;
  revision: number;
  onOpenCard?: (cardId: string) => void;
}): ReactElement {
  const [batch, setBatch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState('newest');
  const [sections, setSections] = useState<string[]>([]);
  const [data, setData] = useState<BinderActivityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [checkpointError, setCheckpointError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        q: query,
        kind,
        sort,
        sections: JSON.stringify(sections),
      });
      if (batch) params.set('batch', batch);
      void api
        .binderActivity(binderId, params, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setData(result);
            setLoading(false);
          }
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setError(userMessage(cause));
            setLoading(false);
          }
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [binderId, revision, batch, query, kind, sort, sections, refresh]);
  async function checkpoint() {
    if (saving || loading || !data?.pendingChanges) return;
    setSaving(true);
    setCheckpointError('');
    try {
      const result = await api.createBinderCheckpoint(binderId);
      setBatch('');
      setRefresh((n) => n + 1);
      setStatus(
        result.created
          ? 'Checkpoint created. New changes will start a fresh batch.'
          : 'No new changes to checkpoint.',
      );
    } catch (cause) {
      setCheckpointError(userMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  const selectedIndex = data?.batches.findIndex((b) => b.id === data.selectedBatch) ?? -1;
  const selected = data?.batches[selectedIndex];
  const older = data?.batches[selectedIndex + 1];
  const newer = selectedIndex > 0 ? data?.batches[selectedIndex - 1] : undefined;
  const filtered = Boolean(query || kind !== 'all' || sections.length);
  const available = data?.sections ?? [];
  const hasBookmarks = available.some((section) => section.id.startsWith('bookmark:'));
  const choices = [
    ...(hasBookmarks ? available : []),
    ...sections
      .filter((id) => !available.some((section) => section.id === id) || !hasBookmarks)
      .map((id) => ({
        id,
        name: id === 'unbookmarked' ? 'Unbookmarked' : id.replace(/^bookmark:/, ''),
      })),
  ];
  return (
    <div className="binder-activity">
      <div className="activity-summary">
        <div>
          <strong>
            {data
              ? data.pendingChanges
                ? `${data.pendingChanges} new ${data.pendingChanges === 1 ? 'change' : 'changes'}`
                : 'No new changes'
              : 'Checking for new changes…'}
          </strong>
          <span>Since your last checkpoint</span>
        </div>
        <button
          type="button"
          className="button-primary"
          disabled={saving || loading || !data?.pendingChanges}
          onClick={() => void checkpoint()}
          title={
            data?.pendingChanges
              ? 'Start a fresh batch after putting your cards away'
              : 'A checkpoint needs at least one new placement or removal'
          }
        >
          {saving ? 'Creating…' : 'Create checkpoint'}
        </button>
      </div>
      {status ? (
        <p className="activity-feedback" role="status">
          {status}
        </p>
      ) : null}
      {checkpointError ? (
        <p className="activity-feedback" role="alert">
          {checkpointError}
        </p>
      ) : null}
      <div className="activity-batch-bar">
        <label>
          Batch
          <select
            value={data?.selectedBatch ?? ''}
            disabled={loading || !data}
            onChange={(e) => setBatch(e.target.value)}
          >
            {data?.batches.map((b, i) => (
              <option key={b.id} value={b.id}>
                {i === 0
                  ? 'Current batch'
                  : b.createdAt === null
                    ? 'First batch'
                    : batchTime(b.createdAt)}{' '}
                · {b.count} {b.count === 1 ? 'change' : 'changes'}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Checkpoint batches">
          <button
            type="button"
            aria-label="Older batch"
            title="Older batch"
            disabled={!older || loading}
            onClick={() => older && setBatch(older.id)}
          >
            <Icon name="chevron-left" />
          </button>
          <button
            type="button"
            aria-label="Newer batch"
            title="Newer batch"
            disabled={!newer || loading}
            onClick={() => newer && setBatch(newer.id)}
          >
            <Icon name="chevron-right" />
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setBatch('');
              setRefresh((n) => n + 1);
            }}
          >
            Latest changes
          </button>
        </nav>
      </div>
      {selected?.createdAt ? (
        <p className="activity-batch-date">From {activityTime(selected.createdAt)}</p>
      ) : null}
      <div className="activity-filter-bar">
        <label>
          Search cards
          <input
            type="search"
            maxLength={200}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Card name, set or number"
          />
        </label>
        <label>
          Changes
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">Added and removed</option>
            <option value="added">Added only</option>
            <option value="removed">Removed only</option>
          </select>
        </label>
        <label>
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="binder">Binder order</option>
            <option value="pokedex">Pokédex number</option>
          </select>
        </label>
      </div>
      <section className="activity-sections" aria-labelledby="activity-sections-heading">
        <div className="activity-sections-heading">
          <h2 id="activity-sections-heading">Binder sections</h2>
          {sections.length ? (
            <button type="button" className="button-text" onClick={() => setSections([])}>
              All sections
            </button>
          ) : null}
        </div>
        {choices.length ? (
          <fieldset>
            <legend className="sr-only">Filter by binder bookmarks</legend>
            {choices.map((section) => (
              <label
                key={section.id}
                className={
                  sections.includes(section.id) ? 'activity-section selected' : 'activity-section'
                }
              >
                <input
                  type="checkbox"
                  checked={sections.includes(section.id)}
                  onChange={(e) =>
                    setSections((current) =>
                      e.target.checked
                        ? [...current, section.id]
                        : current.filter((name) => name !== section.id),
                    )
                  }
                />
                {section.name}
              </label>
            ))}
          </fieldset>
        ) : (
          <p>Bookmark a page or pocket in this binder to filter by its sections.</p>
        )}
      </section>
      {loading ? (
        <p role="status">Loading activity…</p>
      ) : error ? (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRefresh((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : data ? (
        <>
          <div className="activity-results-heading">
            <h2>
              {data.total} {data.total === 1 ? 'change' : 'changes'}
            </h2>
            {filtered ? (
              <button
                type="button"
                className="button-text"
                onClick={() => {
                  setQuery('');
                  setKind('all');
                  setSections([]);
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
          {data.total > 500 ? (
            <p className="activity-batch-date">
              Showing {data.events.length} of {data.total}. Narrow the filters to see more.
            </p>
          ) : null}
          {data.events.length === 0 ? (
            <div className="activity-empty">
              <strong>{filtered ? 'No matching changes' : 'No changes in this batch'}</strong>
              <p>
                {filtered
                  ? 'Try another batch or clear the filters.'
                  : 'Your next placement or removal will appear here.'}
              </p>
            </div>
          ) : (
            <ol className="binder-activity-grid">
              {data.events.map((event) => (
                <li key={event.id}>
                  <CardFrame
                    card={
                      event.card
                        ? frameCardFrom(event.card)
                        : {
                            id: event.cardId,
                            name: event.name,
                            imageUrl: event.imageLowUrl,
                            number: event.number,
                            setCode: null,
                            rarityKey: null,
                            pokedexNumber: event.pokedexNumber,
                            frameType: null,
                          }
                    }
                    state={(event.card?.collection?.quantity ?? 0) > 0 ? 'owned' : 'unowned'}
                    onView={event.card && onOpenCard ? () => onOpenCard(event.cardId) : undefined}
                  />
                  <div className="activity-card-heading">
                    <span className={`activity-kind activity-kind-${event.kind}`}>
                      {event.kind === 'added' ? 'Added' : 'Removed'}
                    </span>
                  </div>
                  <strong>{event.name}</strong>
                  {event.sectionName ? (
                    <span className="activity-card-section">{event.sectionName}</span>
                  ) : null}
                  <span>
                    Page {event.page + 1} · row {event.row + 1} · pocket {event.column + 1}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </div>
  );
}
