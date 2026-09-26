import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { OwnershipMark } from './ownership-mark';

export function CardTile({
  art,
  title,
  subtitle,
  quantity,
  region,
  className = '',
  ...button
}: {
  art: ReactNode;
  title: string;
  subtitle: string;
  quantity: number;
  region?: string | null;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'>): ReactElement {
  return (
    <button {...button} className={`card-tile ${className}`.trim()} type="button">
      {art}
      <span className="card-tile-title">
        <strong title={title}>{title}</strong>
        <small title={subtitle}>{subtitle}</small>
        {region ? (
          <span className="card-tile-region-row">
            <span className="card-region" title={`Species first found in ${region}`}>
              <span className="sr-only">Region: </span>
              {region}
            </span>
            <OwnershipMark quantity={quantity} />
          </span>
        ) : null}
      </span>
      {!region ? <OwnershipMark quantity={quantity} /> : null}
    </button>
  );
}
