import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { OwnershipMark } from './ownership-mark';

export function CardTile({
  art,
  title,
  subtitle,
  quantity,
  showOwnership = true,
  className = '',
  ...button
}: {
  art: ReactNode;
  title: string;
  subtitle: string;
  quantity: number;
  showOwnership?: boolean;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'>): ReactElement {
  return (
    <button {...button} className={`card-tile ${className}`.trim()} type="button">
      {art}
      <span className="card-tile-title">
        <strong title={title}>{title}</strong>
        <small>{subtitle}</small>
      </span>
      {showOwnership ? <OwnershipMark quantity={quantity} /> : null}
    </button>
  );
}
