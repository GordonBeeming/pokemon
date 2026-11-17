import { useEffect, useState, type ReactElement } from 'react';
import {
  POKEMON_DISCOVERY_CATEGORIES,
  type BinderActivityResult,
  type PokemonDiscoveryCategory,
} from '@pokedex/shared';
import { api } from '../../api/queries/binder-activity';
import { Panel } from './panels/Panel';
import { CardFrame } from '../../cards/CardFrame';
import { binderErrorMessage as userMessage } from './model';

export function activityTime(seconds: number): string {
  return `${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(seconds * 1000))} AEST`;
}

export function BinderActivity({
  binderId,
  revision,
  onClose,
}: {
  binderId: string;
  revision: number;
  onClose: () => void;
}): ReactElement {
  const [batch, setBatch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState('newest');
  const [regions, setRegions] = useState<PokemonDiscoveryCategory[]>([]);
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
      const params = new URLSearchParams({ q: query, kind, sort, regions: regions.join(',') });
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
  }, [binderId, revision, batch, query, kind, sort, regions, refresh]);
  async function checkpoint() {
    if (saving) return;
    setSaving(true);
    setCheckpointError('');
    try {
      await api.createBinderCheckpoint(binderId);
      setBatch('');
      setRefresh((value) => value + 1);
      setStatus('Checkpoint created. New placements will collect in a fresh batch.');
    } catch (cause) {
      setCheckpointError(userMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  const selectedIndex = data?.batches.findIndex((b) => b.id === data.selectedBatch) ?? -1;
  const earlier = data?.batches[selectedIndex + 1];
  const later = selectedIndex > 0 ? data?.batches[selectedIndex - 1] : undefined;
  return (
    <Panel title="Binder activity" onClose={onClose} wide>
      <div className="binder-activity">
        <div className="binder-activity-heading">
          <div>
            <p>
              Review copies added and removed. Use a checkpoint after putting your physical cards
              away.
            </p>
          </div>
          <button
            type="button"
            className="quiet-button tone-accent"
            disabled={saving || loading}
            onClick={() => void checkpoint()}
          >
            {saving ? 'Creating…' : 'Create checkpoint'}
          </button>
        </div>
        <p className="form-help">Pocket locations reflect where each change happened.</p>
        {status ? <p role="status">{status}</p> : null}
        {checkpointError ? <p role="alert">{checkpointError}</p> : null}
        <div className="binder-activity-filters">
          <label>
            Checkpoint batch
            <select
              value={data?.selectedBatch ?? ''}
              disabled={loading || !data}
              onChange={(e) => setBatch(e.target.value)}
            >
              {data?.batches.map((b, i) => (
                <option key={b.id} value={b.id}>
                  {b.createdAt === null
                    ? 'Before first checkpoint'
                    : `Since ${activityTime(b.createdAt)}`}
                  {i === 0 ? ' · current' : ''} · {b.count} changes
                </option>
              ))}
            </select>
          </label>
          <label>
            Search cards
            <input
              type="search"
              maxLength={200}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, set or card number"
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
        <fieldset className="binder-activity-regions">
          <legend>Regions · select any combination</legend>
          {POKEMON_DISCOVERY_CATEGORIES.map((region) => (
            <label key={region}>
              <input
                type="checkbox"
                checked={regions.includes(region)}
                onChange={(e) =>
                  setRegions((current) =>
                    e.target.checked ? [...current, region] : current.filter((r) => r !== region),
                  )
                }
              />
              {region}
            </label>
          ))}
          {regions.length ? (
            <button type="button" className="text-button" onClick={() => setRegions([])}>
              All regions
            </button>
          ) : null}
        </fieldset>
        {data ? (
          <nav className="binder-activity-nav" aria-label="Checkpoint batches">
            <button
              type="button"
              className="quiet-button"
              disabled={!earlier || loading}
              onClick={() => earlier && setBatch(earlier.id)}
            >
              Older batch
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={!later || loading}
              onClick={() => later && setBatch(later.id)}
            >
              Newer batch
            </button>
            <button
              type="button"
              className="text-button"
              disabled={loading}
              onClick={() => {
                setBatch('');
                setRefresh((value) => value + 1);
              }}
            >
              Latest non-empty batch
            </button>
          </nav>
        ) : null}
        {loading ? (
          <p role="status">Loading activity…</p>
        ) : error ? (
          <p role="alert">
            {error}{' '}
            <button type="button" onClick={() => setRefresh((value) => value + 1)}>
              Try again
            </button>
          </p>
        ) : data ? (
          <>
            <p role="status">
              Showing {data.events.length} of {data.total} matching changes.
              {data.total > 500
                ? ' Narrow the filters to see more; each view shows up to 500 changes.'
                : ''}
            </p>
            {data.events.length === 0 ? (
              <p>No matching placements or removals in this batch.</p>
            ) : (
              <ol className="binder-activity-grid">
                {data.events.map((event) => (
                  <li key={event.id}>
                    <CardFrame
                      card={{
                        id: event.cardId,
                        name: event.name,
                        imageUrl: event.imageLowUrl,
                        number: event.number,
                        setCode: null,
                        rarityKey: null,
                        pokedexNumber: event.pokedexNumber,
                        frameType: null,
                      }}
                      frame={false}
                      state="placed"
                      forceSolid
                    />
                    <span className={`activity-kind activity-kind-${event.kind}`}>
                      {event.kind === 'added' ? 'Added' : 'Removed'}
                    </span>
                    <strong>{event.name}</strong>
                    <span>
                      {event.setName} · {event.number} · {event.language.toUpperCase()}
                    </span>
                    <span>
                      {event.region
                        ? `${event.region} · #${event.pokedexNumber}`
                        : 'No Pokémon region'}
                    </span>
                    <span>
                      Page {event.page + 1} · row {event.row + 1} · pocket {event.column + 1}
                    </span>
                    <small>
                      Version {event.versionNumber} · {activityTime(event.createdAt)}
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : null}
      </div>
    </Panel>
  );
}
