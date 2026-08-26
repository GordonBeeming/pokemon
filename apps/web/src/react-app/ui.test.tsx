import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { BinderView, containsCardSequence } from './binder-view';
import { CatalogueView } from './catalogue-view';
import { DevicesView, FacetsView, Login, Shell, userMessage } from './ui';

beforeEach(() => {
  vi.stubGlobal('location', { hostname: 'localhost' });
});

describe('accessible frontend structure', () => {
  it('renders enrolment as a labelled form with a persistent alert region', () => {
    const html = renderToStaticMarkup(<Login onAuthenticated={() => undefined} />);
    expect(html).toContain('<form');
    expect(html).toContain('aria-labelledby="enrol-heading"');
    expect(html).toContain('id="login-error"');
    expect(html).toContain('role="alert"');
  });

  it('marks the active route and keeps status regions mounted', () => {
    const html = renderToStaticMarkup(
      <Shell route="catalogue" navigate={() => undefined} notice={null}>
        <h1>Catalogue</h1>
      </Shell>,
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-live="assertive"');
  });

  it('gives repeated device actions a unique accessible name', () => {
    const html = renderToStaticMarkup(
      <DevicesView
        tokens={[
          { id: 'one', label: 'Scanner one' },
          { id: 'two', label: 'Scanner two' },
        ]}
        pairCode={null}
        pending={false}
        pair={() => undefined}
        revoke={() => undefined}
        copied={() => undefined}
        copyFailed={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Revoke Scanner one"');
    expect(html).toContain('aria-label="Revoke Scanner two"');
  });

  it('renders catalogue paging and a searchable binder creator without API data', () => {
    const catalogue = renderToStaticMarkup(
      <CatalogueView
        initialParams={new URLSearchParams()}
        refreshKey={0}
        indexing={false}
        indexingError={null}
        indexingResult={null}
        retryIndexing={() => undefined}
        onBackToNational={() => undefined}
        onBackToSets={() => undefined}
        onNotice={() => undefined}
      />,
    );
    const binder = renderToStaticMarkup(<BinderView onNotice={() => undefined} />);
    expect(catalogue).not.toContain('Previous 50');
    expect(catalogue).not.toContain('Next 50');
    expect(binder).toContain('Your binders');
    expect(binder).toContain('Create your first binder');
    expect(binder).toContain('<form');
  });

  it('shows an indexing overlay instead of a false empty result', () => {
    const html = renderToStaticMarkup(
      <CatalogueView
        initialParams={new URLSearchParams({ species: 'Metapod', pokedexNumber: '11' })}
        refreshKey={0}
        indexing
        indexingError={null}
        indexingResult={null}
        retryIndexing={() => undefined}
        onBackToNational={() => undefined}
        onBackToSets={() => undefined}
        onNotice={() => undefined}
      />,
    );

    expect(html).toContain('Finding every Metapod printing');
    expect(html).not.toContain('No cards match this search');
  });

  it('keeps set context and recovery navigation visible in a filtered catalogue', () => {
    const html = renderToStaticMarkup(
      <CatalogueView
        initialParams={new URLSearchParams({ setId: 'sv03.5', setName: '151' })}
        refreshKey={0}
        indexing={false}
        indexingError={null}
        indexingResult={null}
        retryIndexing={() => undefined}
        onBackToNational={() => undefined}
        onBackToSets={() => undefined}
        onNotice={() => undefined}
      />,
    );
    expect(html).toContain('Back to Set checklists');
    expect(html).toContain('151 card gallery');
    expect(html).toContain('Browsing 151 (sv03.5)');
    expect(html).not.toContain('pagination-actions');
  });

  it('renders every set without progressive loading instructions', () => {
    const html = renderToStaticMarkup(
      <FacetsView
        title="Set checklists"
        items={Array.from({ length: 30 }, (_value, index) => ({
          id: `set-${index}`,
          label: `Set ${index + 1}`,
          detail: '0 of 10 owned · en',
        }))}
        onChoose={() => undefined}
      />,
    );
    expect(html).toContain('Showing all 30 matching sets.');
    expect(html).toContain('Set 30');
    expect(html).not.toContain('Show 24 more');
    expect(html).not.toContain('Browse cards');
  });
});

describe('binder planning helpers', () => {
  it('finds an existing ordered card sequence without matching gaps or partial runs', () => {
    const slots = ['lead', 'card-1', 'card-2', 'card-3', null, 'tail'];
    expect(containsCardSequence(slots, ['card-1', 'card-2', 'card-3'])).toBe(true);
    expect(containsCardSequence(slots, ['card-1', 'card-3'])).toBe(false);
    expect(containsCardSequence(slots, [])).toBe(false);
  });
});

describe('user-facing errors', () => {
  it('turns API codes into recovery copy and keeps a request reference', () => {
    expect(
      userMessage(new ApiError('binder_revision_conflict', 'code', 409, 'request-1', null)),
    ).toBe(
      'This binder changed elsewhere. The latest page has been reloaded. Reference request-1.',
    );
    expect(userMessage(new ApiError('rate_limited', 'code', 429, null, 20))).toBe(
      'Too many attempts were made. Wait a moment, then try again. Try again in 20 seconds.',
    );
  });
});
