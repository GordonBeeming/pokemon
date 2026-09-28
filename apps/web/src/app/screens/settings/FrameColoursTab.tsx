import { DEFAULT_FRAME_PALETTE, FRAME_TYPES, type FrameType } from '@pokedex/shared';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useFramePalette } from '../../api/queries/settings';
import { CardFrame, type CardFrameCard } from '../../cards/CardFrame';
import { isLowContrast } from '../../cards/color';
import { useToast } from '../../ui/Toast';

export const FRAME_TYPE_LABELS: Record<FrameType, string> = {
  grass: 'Grass',
  fire: 'Fire',
  water: 'Water',
  lightning: 'Lightning',
  psychic: 'Psychic',
  fighting: 'Fighting',
  darkness: 'Darkness',
  metal: 'Metal',
  dragon: 'Dragon',
  fairy: 'Fairy',
  colorless: 'Colorless',
  trainer: 'Trainer cards',
  energy: 'Basic energy',
  'special-energy': 'Special energy',
};

// Four presets per type, the first always the shipped default; picked on the Card
// frames board so every preset keeps readable text on the solid frame.
export const FRAME_PRESETS: Record<FrameType, readonly string[]> = {
  grass: ['#3f6212', '#166534', '#15803d', '#365314'],
  fire: ['#9a3412', '#b91c1c', '#7f1d1d', '#c2410c'],
  water: ['#1e40af', '#1d4ed8', '#0e7490', '#1e3a8a'],
  lightning: ['#a16207', '#854d0e', '#92400e', '#713f12'],
  psychic: ['#6b21a8', '#7e22ce', '#86198f', '#5b21b6'],
  fighting: ['#7c3f1d', '#78350f', '#9a3412', '#57534e'],
  darkness: ['#134e4a', '#1e293b', '#0f172a', '#115e59'],
  metal: ['#475569', '#52525b', '#374151', '#64748b'],
  dragon: ['#3730a3', '#4338ca', '#854d0e', '#1e3a8a'],
  fairy: ['#9d174d', '#be185d', '#86198f', '#831843'],
  colorless: ['#57534e', '#475569', '#334155', '#78716c'],
  trainer: ['#334155', '#1e293b', '#475569', '#0f766e'],
  energy: ['#0e7490', '#155e75', '#0369a1', '#115e59'],
  'special-energy': ['#cbd5e1', '#e2e8f0', '#94a3b8', '#475569'],
};

// A custom colour picker fires on every drag step; only the colour it settles on is
// saved, so dragging doesn't send a request per pixel.
const CUSTOM_COMMIT_DELAY_MS = 400;

function sampleCard(frameType: FrameType): CardFrameCard {
  return {
    id: `sample-${frameType}`,
    name: FRAME_TYPE_LABELS[frameType],
    frameType,
    setCode: 'MEW',
    number: '025',
    rarityKey: 'C',
    pokedexNumber: null,
    imageUrl: null,
  };
}

function FrameRow({
  frameType,
  colour,
  overridden,
  palette,
  disabled,
  onPick,
  onReset,
}: {
  frameType: FrameType;
  colour: string;
  overridden: boolean;
  palette: Record<FrameType, string>;
  disabled: boolean;
  onPick: (hex: string) => void;
  onReset: () => void;
}): ReactElement {
  const label = FRAME_TYPE_LABELS[frameType];
  const [custom, setCustom] = useState(colour);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setCustom(colour), [colour]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const shown = custom.toLowerCase();
  const lowContrast = isLowContrast(shown);
  const previewPalette = { ...palette, [frameType]: shown };

  return (
    <li className="frame-row">
      <span className="frame-row-label">{label}</span>
      <div className="frame-row-swatches" role="radiogroup" aria-label={`${label} frame colour`}>
        {FRAME_PRESETS[frameType].map((hex) => (
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={shown === hex}
            aria-label={hex}
            className="frame-swatch"
            style={{ background: hex }}
            disabled={disabled}
            onClick={() => onPick(hex)}
          />
        ))}
      </div>
      <label className="frame-row-custom">
        <span>Custom</span>
        <input
          type="color"
          value={shown}
          aria-label={`${label} custom colour`}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value.toLowerCase();
            setCustom(next);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => onPick(next), CUSTOM_COMMIT_DELAY_MS);
          }}
        />
      </label>
      <code className="frame-row-hex">{shown}</code>
      {lowContrast ? (
        <span className="frame-row-warning" role="status">
          Text hard to read
        </span>
      ) : null}
      {overridden ? (
        <button type="button" className="button-text" disabled={disabled} onClick={onReset}>
          Reset
        </button>
      ) : null}
      <span className="frame-row-preview" aria-hidden="true">
        <CardFrame
          card={sampleCard(frameType)}
          state="owned"
          palette={previewPalette}
          size="7rem"
        />
        <CardFrame
          card={sampleCard(frameType)}
          state="unowned"
          palette={previewPalette}
          size="7rem"
        />
      </span>
    </li>
  );
}

export function FrameColoursTab(): ReactElement {
  const { palette, overrides, isLoading, error, setOverride, resetOverride, resetAll } =
    useFramePalette();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  async function save(action: () => Promise<unknown>, message: string): Promise<void> {
    setSaving(true);
    try {
      await action();
      toast('success', message);
    } catch {
      toast('error', 'The frame colour could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-card" aria-labelledby="frames-heading">
      <div className="settings-card-header">
        <h2 id="frames-heading">Card frames</h2>
        <button
          type="button"
          disabled={saving || Object.keys(overrides).length === 0}
          onClick={() => void save(resetAll, 'Every frame colour is back to its default.')}
        >
          Reset to defaults
        </button>
      </div>
      <p className="settings-help">
        Colours per card type, just for you. Unowned cards use a pale tint of the same colour. A
        warning shows when neither white nor dark text is easy to read on a colour.
      </p>
      {error ? (
        <p role="alert" className="panel-error">
          Your frame colours could not be loaded. The defaults are shown.
        </p>
      ) : null}
      {isLoading ? <p role="status">Loading your frame colours…</p> : null}
      <ul className="frame-rows">
        {FRAME_TYPES.map((frameType) => (
          <FrameRow
            key={frameType}
            frameType={frameType}
            colour={palette[frameType]}
            overridden={
              overrides[frameType] !== undefined &&
              overrides[frameType] !== DEFAULT_FRAME_PALETTE[frameType]
            }
            palette={palette}
            disabled={saving}
            onPick={(hex) =>
              void save(
                () => setOverride(frameType, hex),
                `${FRAME_TYPE_LABELS[frameType]} frame colour saved.`,
              )
            }
            onReset={() =>
              void save(
                () => resetOverride(frameType),
                `${FRAME_TYPE_LABELS[frameType]} is back to its default.`,
              )
            }
          />
        ))}
      </ul>
    </section>
  );
}
