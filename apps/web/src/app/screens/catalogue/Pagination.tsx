import type { ReactElement } from 'react';
import { Icon } from '../../ui/icons';

/** Shared by Catalogue and National Pokédex — both paginate 50 items per page
 * (FEATURES.md: "using the same component as National Pokédex"). */
export function Pagination({
  page,
  totalPages,
  pending,
  label,
  onPage,
}: {
  page: number;
  totalPages: number;
  pending: boolean;
  label: string;
  onPage: (page: number) => void;
}): ReactElement | null {
  if (totalPages <= 1) return null;
  const numbered = [...new Set([1, totalPages, page - 1, page, page + 1])]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((left, right) => left - right);

  return (
    <nav className="pagination" aria-label={label}>
      <button type="button" disabled={page <= 1 || pending} onClick={() => onPage(page - 1)}>
        <Icon name="chevron-left" /> Previous
      </button>
      <div className="pagination-pages">
        {numbered.map((value, index) => {
          const previous = numbered[index - 1];
          return (
            <span key={value}>
              {previous !== undefined && value - previous > 1 ? (
                <span aria-hidden="true">…</span>
              ) : null}
              <button
                type="button"
                aria-current={value === page ? 'page' : undefined}
                disabled={pending}
                onClick={() => onPage(value)}
              >
                {value}
              </button>
            </span>
          );
        })}
      </div>
      <button
        type="button"
        disabled={page >= totalPages || pending}
        onClick={() => onPage(page + 1)}
      >
        Next <Icon name="chevron-right" />
      </button>
    </nav>
  );
}
