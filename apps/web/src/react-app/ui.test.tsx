import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { BinderView } from './binder-view';
import { CatalogueView } from './catalogue-view';
import { DevicesView, Login, Shell, userMessage } from './ui';

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
      <CatalogueView initialParams={new URLSearchParams()} onNotice={() => undefined} />,
    );
    const binder = renderToStaticMarkup(<BinderView onNotice={() => undefined} />);
    expect(catalogue).toContain('Previous 50');
    expect(catalogue).toContain('Next 50');
    expect(binder).toContain('Create your first binder');
    expect(binder).toContain('<form');
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
