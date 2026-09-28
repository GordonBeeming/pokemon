# Product

<!-- impeccable:product-schema 1 -->

## Platform

Pokédex is a multi-user web app. Several people share one physical card catalogue while each keeps
their own collection, binders, and settings. There is no desktop companion: finding or adding a card,
confirming a match, and placing it in a binder all happen in the browser, on desktop or phone.

## Stack

The pnpm workspace uses Turborepo, React 19, Vite, a Hono Cloudflare Worker, D1, private R2 storage,
SQLite Durable Objects, and Workflows. A scoped bearer-token API, the same one the retired desktop
scanner used, stays in place for scripts and a future AI skill. Nothing server-side depends on the
scanner itself.

## Users

Each person signs in with their own named passkey. An admin invites someone with a single-use link
that expires in 7 days; accepting it registers the invitee's own passkey under their own new user.
Roles are admin and member, and an admin can promote or demote another user. An admin can also
disable a user without deleting their data: sign-in is blocked and existing sessions are revoked
immediately, and re-enabling restores access with everything intact. The last remaining admin can't
be demoted or disabled.

## Purpose

Pokédex records what each person owns, keeps the card catalogue searchable, and compares binder
plans with the physical collection. A useful session starts with finding or adding a card, confirms
the match, updates the collection once, and shows any remaining binder shortage.

## Catalogue and pricing

TCGdex supplies physical card metadata and source art. Pokédex excludes TCG Pocket cards and keeps
stable internal card IDs when source data changes. Every set carries a short code (TCGdex's official
abbreviation where one exists, an owner-edited code otherwise) and a release date, both shown on the
Sets screen and on every card's frame. Prices retain source currency, source time, and FX date. The
displayed A$ estimate uses the lowest current positive market value available for a card.

## Collection and inventory

Quantity and notes are the collection record for a card. At zero copies there is no counter to edit,
only an "Add first copy" action. Lowering a quantity always asks where the copy comes from: a
specific binder pocket, which unassigns it; a loose copy, unavailable once every copy is placed; or a
correction ("I miscounted"), which also frees a pocket if nothing loose remains. A card's own count
reads as the number placed in binders plus the number loose.

## Binders

Binder plans are fixed-capacity digital copies of physical layouts. A creator chooses the page face
and enters the physical binder's exact pocket capacity, then deliberately grows or safely shrinks the
plan when needed. Full pages use the selected rows and columns; only the final page may be partial.
Each sleeve is empty, reserved, an exact-card target, or a National Pokédex target. Targets and
owned-card placement are separate, so a target is not presented as physically filled until a
compatible copy is assigned; placing a matching copy fills an open target rather than replacing it.
Editable binder versions support page starts, signed-offset moves, closing gaps, anchored
reservations, several arrangement orders (Pokédex number, set number, release date, language), and a
full 1,025-entry National Pokédex insert, with an option to start a new page per region, without
catalogue synchronisation. A binder can be cloned into an editable draft, refined independently of
the active version, then made active or discarded. Active versions report shortages, while archived
versions remain readable but cannot change.

Each binder carries its own settings: the card frame can be switched off to show raw card art in its
pockets, and a page-peek setting shows a chosen number of columns of the neighbouring page at each
edge, sliding on a page turn and flipping to that page when a dragged card reaches the peeked edge.

Reserved binder pages allow manual card and placeholder placement in individual pockets. Their labels
and contents are preserved by automatic layout operations. Explicit inserts, gap-closing, and
offset shifts on a reserved page stay within that page and reject overflow; moving to another page
uses the pocket move action.

## Card presentation

Every card shows the same frame wherever it appears: the Pokédex number and first-found region on
top, the set code, collector number, and a printed-style rarity symbol on the bottom, and a chip for
the number of copies owned. The frame is tinted by the card's own type, or a neutral tone for special
energy; an owner can adjust each type's colour in Settings, with a warning if the contrast against
white falls below 4.5:1. A card with zero owned copies keeps a pale, dashed version of its frame
instead of a generic missing-card look.

Art fades in exactly two places: a catalogue or National Pokédex list dims art for a card or species
with zero owned copies, and a binder pocket dims art for a target with no copy assigned. Card art is
never cropped or squished. The art box always keeps the source image's own proportions, and the frame
or pocket sizes itself around the art, never the other way round. Card pickers and the large "View
card" preview, reachable from any surface that shows a card tap action, never fade; the large preview
states ownership in words instead.

## Boundaries

Condition, finish, acquisition history, grading, finish detection, multi-card recognition, cloud
inference, Workers AI, and Vectorize are outside the current product. Backups run on an
infrastructure schedule; there is no user-facing backup or restore screen. Card art, credentials, and
collection data belong to the person who owns them. An admin can see who exists and manage roles, but
not another person's collection contents.

## Visual direction

Use the Personal/Xylem visual language. The interface is a calm working catalogue rather than a
public marketplace. Pokémon artwork supplies most of the colour; navigation and data surfaces stay
restrained and readable.

## Accessibility

Web workflows must be keyboard usable, show visible focus, meet WCAG AA contrast for normal text,
label controls, and announce loading and error states without relying on colour alone. Every screen
works at 390 by 844 pixels with no horizontal scrolling; on a phone, controls collapse behind a
single summary control and cards lead the layout. Catalogue and binder screens keep their denser
desktop layout at wider sizes.
