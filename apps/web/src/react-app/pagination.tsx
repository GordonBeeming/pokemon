import { useEffect, useState, type ReactElement } from 'react';

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
  const [input, setInput] = useState(String(page + 1));
  useEffect(() => setInput(String(page + 1)), [page]);
  if (totalPages <= 1) return null;
  const numberedPages = Array.from(
    new Set([0, totalPages - 1, page - 2, page - 1, page, page + 1, page + 2]),
  )
    .filter((value) => value >= 0 && value < totalPages)
    .sort((left, right) => left - right);
  return (
    <nav className="pagination-actions" aria-label={label}>
      <button
        className="quiet-button"
        type="button"
        disabled={page === 0 || pending}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </button>
      <div className="pagination-pages">
        {numberedPages.map((pageNumber, index) => {
          const previous = numberedPages[index - 1];
          return (
            <span key={pageNumber}>
              {previous !== undefined && pageNumber - previous > 1 ? (
                <span aria-hidden="true">…</span>
              ) : null}
              <button
                className="quiet-button"
                type="button"
                aria-current={pageNumber === page ? 'page' : undefined}
                disabled={pending}
                onClick={() => onPage(pageNumber)}
              >
                {pageNumber + 1}
              </button>
            </span>
          );
        })}
      </div>
      <button
        className="quiet-button"
        type="button"
        disabled={page + 1 >= totalPages || pending}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
      <form
        className="page-jump"
        onSubmit={(event) => {
          event.preventDefault();
          const requested = Number.parseInt(input, 10);
          if (Number.isInteger(requested) && requested >= 1 && requested <= totalPages)
            onPage(requested - 1);
        }}
      >
        <label>
          Page
          <input
            type="number"
            min="1"
            max={totalPages}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <span>of {totalPages}</span>
        <button className="quiet-button" type="submit" disabled={pending}>
          Go
        </button>
      </form>
    </nav>
  );
}
