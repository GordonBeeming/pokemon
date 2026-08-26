# Design

<!-- impeccable:design-schema 1 -->

## Direction

Pokédex is a Personal/Xylem operate-mode collector's cabinet. The metaphor is behavioural rather than skeuomorphic: physical card proportions, visible pocket gaps, shelf continuity, and specimen-like labels make the collection feel tangible without fake wood, leather, glare, or ornamental depth. Pokémon card artwork provides the colour; the chrome stays calm enough for long catalogue sessions.

## Composition

The dashboard is a visual shelf and a set of useful continuation points. Desktop layouts use a dark cabinet-like navigation rail, a broad light work surface, gallery-first card browsing, and a selected-card inspector that remains visible beside the catalogue. National Pokédex tiles lead with one large physical card preview per species. Binder pages preserve the 0.72 card ratio and make empty pockets obvious. Narrow surfaces collapse to a single column; selected detail becomes a closeable drawer rather than falling below dozens of cards.

## Type and colour

Use a legible system sans for interface text and a monospace face only for identifiers, quantities, and measurements. Personal/Xylem tokens define the palette. Accent colour marks selection, primary actions, and collection state. Neutral layers separate navigation, content, and panels. Every state has a text or icon cue as well as colour.

## Interaction

Controls have visible keyboard focus and complete default, hover, active, disabled, loading, and error states. Collection filters use app-native segmented controls rather than platform dropdowns on primary desktop paths. A filled check mark means owned, an outlined gap mark means missing, and quantities above one appear beside the mark; accessible labels always carry the full state. Species galleries navigate immediately, index printings in place, and preserve Pokédex query, scroll, and focus on return. Contextual catalogue views retain an explicit “Show full catalogue” escape. Quantity and notes changes are explicit and idempotent, then autosave with announced saving, saved, and error states plus a retry action. A failed save keeps the current card detail open and blocks leaving until the draft saves, so edits are never silently discarded. Binder planning is pocket-first: activating an exact pocket establishes placement context and opens metadata search; choosing a card fills that pocket. Keep infrequent page actions in a dismissible ordinary popover rather than a persistent toolbar. Drag and drop in binder planning always has a keyboard placement equivalent. Motion is short and communicates state; it does not delay loading the task.

## Vocabulary

Use “physical printings indexed” for catalogue coverage, “card preview” for an automatic image before printings are loaded, “chosen representative” for the owner's explicit National Pokédex image, and “art unavailable” when the source has no image. “Owned” describes collection state only; it never implies that the currently pictured printing is owned when another printing supplies species coverage.

## Accessibility

Target WCAG AA contrast for normal text, keep labels and instructions close to their controls, use semantic headings and landmarks, and announce asynchronous save or error results. The login and pairing paths must work at 390x844 without horizontal scrolling. Desktop catalogue and binder views are allowed to remain dense at wide widths.
