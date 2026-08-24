# Design

<!-- impeccable:design-schema 1 -->

## Direction

Pokédex is a restrained Personal/Xylem operate-mode workbench. Its visual language should feel like a well-kept reference desk: quiet surfaces, clear measurements, readable tables, and precise state changes. Pokémon imagery and collection data provide the colour; the chrome stays calm enough for long catalogue sessions.

## Composition

The dashboard is the first working surface. Desktop layouts use a stable navigation rail or top-level workspace navigation, a broad content region, and detail panels that can remain visible beside a catalogue. The narrow companion surfaces collapse to a single column and keep actions reachable without reproducing the desktop shell.

## Type and colour

Use a legible system sans for interface text and a monospace face only for identifiers, quantities, and measurements. Use Personal/Xylem tokens from the shared UI package once it is built. Accent colour marks selection, primary actions, and collection state. Neutral layers separate navigation, content, and panels. Every state has a text or icon cue as well as colour.

## Interaction

Controls have visible keyboard focus and complete default, hover, active, disabled, loading, and error states. Quantity changes are explicit and idempotent. Drag and drop in binder planning always has a keyboard placement equivalent. Motion is short and communicates state; it does not delay loading the task.

## Accessibility

Target WCAG AA contrast for normal text, keep labels and instructions close to their controls, use semantic headings and landmarks, and announce asynchronous save or error results. The login and pairing paths must work at 390x844 without horizontal scrolling. Desktop catalogue and binder views are allowed to remain dense at wide widths.
