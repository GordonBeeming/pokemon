# Design

<!-- impeccable:design-schema 1 -->

## Direction

Pokédex is a Personal/Xylem operate-mode collector's cabinet. The metaphor is behavioural rather than
skeuomorphic: physical card proportions, visible pocket gaps, shelf continuity, and specimen-like
labels make the collection feel tangible without fake wood, leather, glare, or ornamental depth. One
card frame, tinted by type, carries identity, location, and ownership information, so nothing about a
card needs a caption underneath it. Pokémon card artwork provides the colour; the chrome stays calm
enough for long catalogue sessions.

## Composition

The dashboard is a visual shelf and a set of useful continuation points. Desktop layouts use a dark
cabinet-like navigation rail and a broad light work surface. Catalogue browsing is gallery-first;
opening a card raises a modal inspector over the gallery rather than replacing it. National Pokédex
tiles lead with one large physical card preview per species. Binder pages preserve the 0.72 card
ratio, make empty pockets obvious, and peek a configurable number of columns of the neighbouring page
at each edge. Narrow surfaces collapse to a single column, and a single summary pill stands in for
search and filter controls until it's tapped open.

## Type and colour

Use a legible system sans for interface text and a monospace face only for identifiers, quantities,
and measurements. Personal/Xylem tokens define the app chrome. The card frame's own palette is
separate: one shipped colour per TCG type plus a neutral for special energy, editable per person in
Settings, with a warning when a chosen colour's contrast against white falls below 4.5:1. Accent
colour marks selection and primary actions. Neutral layers separate navigation, content, and panels.
Every state has a text or icon cue as well as colour.

## Card frame

One frame renders a card everywhere it appears: catalogue, National Pokédex, binder pockets, pickers,
and the large preview. The top row shows the Pokédex number and first-found region; the bottom row
shows the set code, collector number, and rarity symbol, with a copies-owned chip. The frame is
tinted by the card's own type. A card with zero owned copies keeps a pale, dashed version of the same
frame rather than a generic empty state.

Fading is the only other ownership signal, and it applies in exactly two places: catalogue and
National Pokédex lists dim art for zero owned copies, and binder pockets dim art for a target with no
copy assigned. An unfilled "any printing" target shows its number, name, and an explicit "Any" pill,
never a blank pocket. Card pickers and the large preview never fade; the large preview states
ownership in words. Art is never cropped or squished: the art box keeps the source image's own
proportions, and pocket size follows the art rather than the other way round. Per binder, the frame
can be switched off to show raw card art instead.

## Interaction

Controls have visible keyboard focus and complete default, hover, active, disabled, loading, and
error states. Every catalogue and binder filter, search term, page, and context lives in the URL, so
reloading, sharing a link, or pressing Back always reproduces exactly what was on screen. Collection
filters use app-native segmented controls and an accessible region listbox rather than platform
dropdowns on primary desktop paths. On phone, a single summary pill stands in for the whole filter
set until tapped open, and context banners collapse to one line. The region picker shows counts after
the query and ownership filters, before its own selection. A filled check mark means owned, an
outlined gap mark means missing, and quantities above one appear beside the mark; accessible labels
always carry the full state, including on dimmed art. Species galleries navigate immediately, index
printings in place, and preserve Pokédex query, region, scroll, and focus on return. Contextual
catalogue views retain an explicit "Show full catalogue" escape.

Quantity changes are explicit: adding a first copy is its own action, and removing a copy always asks
whether it comes from a specific binder pocket, a loose copy, or a correction. Notes autosave, with
announced saving, saved, and error states plus a retry action. A failed save keeps the current card
open and blocks leaving until the draft saves, so edits are never silently discarded. From any
surface that shows a card tap action, "View card" opens the same large preview without navigating
away.

Binder planning is pocket-first: selecting a pocket opens a floating action bar with an icon and a
label for every available action, the same bar on desktop and on phone, reachable by keyboard and by
touch. Keep infrequent page actions in a dismissible ordinary popover rather than a persistent
toolbar. Drag and drop in binder planning always has a keyboard equivalent, and dragging a card
toward a peeked page edge turns the page. Motion is short and communicates state; it does not delay
loading the task.

## Binder planning

Binder planning remains pocket-first. Empty sleeves offer target and reservation actions, while
target sleeves show the intended card separately from a placed owned copy. Capacity changes are
deliberate: overflow opens the resize control without changing the binder, then retries the action
that needed the room once the resize is confirmed. Header counts identify their scope, generated
padding is not presented as a persisted reservation, and archived versions are read-only. A binder
can be cloned into a draft, edited independently of its active version, and either promoted to active
or discarded.

## Vocabulary

Use "physical printings indexed" for catalogue coverage, "card preview" for an automatic image before
printings are loaded, "chosen representative" for the owner's explicit National Pokédex image, and
"art unavailable" when the source has no image. "Owned" describes collection state only; it never
implies that the currently pictured printing is owned when another printing supplies species
coverage. In binder plans, "target" is the intended sleeve content, "placed" means a specific owned
copy has been assigned to it, and "any printing" is a Pokémon-kind target that any compatible owned
copy can fill. Outside binders, an owned copy is either placed (assigned to a binder pocket) or loose
(assigned to none).

## Accessibility

Target WCAG AA contrast for normal text, keep labels and instructions close to their controls, use
semantic headings and landmarks, and announce asynchronous save or error results. Every screen, not
only sign-in and invites, works at 390x844 without horizontal scrolling, with controls collapsed
behind a summary pill so cards lead. Desktop catalogue and binder views are allowed to remain dense
at wide widths.
