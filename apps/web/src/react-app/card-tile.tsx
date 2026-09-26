import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { OwnershipMark } from './ownership-mark';

export function CardTile({
  art,
  title,
  subtitle,
  quantity,
  className = '',
  ...button
}: {
  art: ReactNode;
  title: string;
  subtitle: string;
  quantity: number;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'>): ReactElement {
  return (
    <button {...button} className={`card-tile ${className}`.trim()} type="button">
      {art}
      <span className="card-tile-title">
        <strong title={title}>{title}</strong>
        <small>{subtitle}</small>
      </span>
      <OwnershipMark quantity={quantity} />
    </button>
  );
}
