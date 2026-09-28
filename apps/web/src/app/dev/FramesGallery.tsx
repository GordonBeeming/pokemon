import type { ReactElement } from 'react';
import { CardFrame } from '../cards/CardFrame';
import { RARITY_LABELS } from '@pokedex/shared';
import {
  ANY_FIXTURE,
  LIGHTNING_FIXTURE,
  FRAME_TYPE_FIXTURES,
  LONG_NAME_MISSING_ART_FIXTURE,
  RARITY_FIXTURES,
  RAW_ART_FIXTURE,
  REAL_ART_FIXTURES,
  WRONG_RATIO_FIXTURE,
} from './frame-fixtures';
import './FramesGallery.css';

function Cell({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <figure className="frames-gallery-cell">
      <div style={{ width: '9.5rem' }}>{children}</div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/**
 * No session, no API calls: every card here is CardFrame fed a static fixture, so
 * this route renders standalone for a screenshot even with the worker down. It is
 * excluded from the production bundle entirely (see router.tsx's import.meta.env.DEV
 * guard) rather than merely hidden behind auth.
 */
export function FramesGallery(): ReactElement {
  return (
    <main className="frames-gallery">
      <h1>CardFrame gallery</h1>

      <section>
        <h2>Every frame type, owned vs. unowned</h2>
        <div className="frames-gallery-grid">
          {FRAME_TYPE_FIXTURES.map(({ frameType, card }) => (
            <div key={frameType} className="frames-gallery-pair">
              <Cell label={`${frameType} · owned`}>
                <CardFrame card={card} state="owned" />
              </Cell>
              <Cell label={`${frameType} · unowned`}>
                <CardFrame card={card} state="unowned" />
              </Cell>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Real art (never crop, never squish)</h2>
        <div className="frames-gallery-grid">
          {REAL_ART_FIXTURES.map(({ label, card }) => (
            <Cell key={card.id} label={label}>
              <CardFrame card={card} state="owned" />
            </Cell>
          ))}
          <Cell label="wrong-ratio source (framed) — letterboxed, not cropped">
            <CardFrame card={WRONG_RATIO_FIXTURE} state="owned" />
          </Cell>
          <Cell label="wrong-ratio source, frame=false — letterboxed, not stretched">
            <CardFrame card={WRONG_RATIO_FIXTURE} state="owned" frame={false} />
          </Cell>
        </div>
      </section>

      <section>
        <h2>Every rarity symbol</h2>
        <div className="frames-gallery-grid">
          {RARITY_FIXTURES.map(({ rarityKey, card }) => (
            <Cell key={rarityKey} label={`${rarityKey} · ${RARITY_LABELS[rarityKey]}`}>
              <CardFrame card={card} state="owned" />
            </Cell>
          ))}
        </div>
      </section>

      <section>
        <h2>Variants</h2>
        <div className="frames-gallery-grid">
          <Cell label="ANY printing">
            <CardFrame card={ANY_FIXTURE} state="placed" variant="any" />
          </Cell>
          <Cell label="frame=false (raw art)">
            <CardFrame card={RAW_ART_FIXTURE} state="owned" frame={false} />
          </Cell>
          <Cell label="frame=false, missing art (neutral, not type-tinted)">
            <CardFrame card={{ ...RAW_ART_FIXTURE, imageUrl: null }} state="owned" frame={false} />
          </Cell>
          <Cell label="owned (no copy count; the inspector shows it)">
            <CardFrame card={LIGHTNING_FIXTURE} state="owned" />
          </Cell>
          <Cell label="unowned, forceSolid (inspector)">
            <CardFrame card={LIGHTNING_FIXTURE} state="unowned" forceSolid />
          </Cell>
          <Cell label="selected">
            <CardFrame card={LIGHTNING_FIXTURE} state="owned" selected onView={() => undefined} />
          </Cell>
          <Cell label="long name, missing art">
            <CardFrame card={LONG_NAME_MISSING_ART_FIXTURE} state="owned" />
          </Cell>
        </div>
      </section>
    </main>
  );
}
