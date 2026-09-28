import { useRouter } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { OverlayCloseButton } from '../ui/overlay';
import { CardInspector } from './card/CardInspector';
import './card/card-page.css';

/**
 * The standalone full-page card view: a direct link, or "View card" from a surface
 * with no catalogue result-set context (a binder pocket, a picker) — see
 * CardInspector.tsx for why prev/next chrome lives with Catalogue's own overlay
 * instead of here. Closing returns to wherever the visitor came from, matching
 * FEATURES.md's "closing it returns to exactly where you were".
 */
export function Card({ cardId }: { cardId: string }): ReactElement {
  const router = useRouter();
  return (
    <div className="card-page">
      <div className="card-page-header">
        <OverlayCloseButton onPress={() => router.history.back()} />
      </div>
      <CardInspector cardId={cardId} onClose={() => router.history.back()} />
    </div>
  );
}
