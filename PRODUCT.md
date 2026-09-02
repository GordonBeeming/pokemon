# Product

<!-- impeccable:product-schema 1 -->

## Platform

Pokédex has a desktop-first web app and a macOS Tauri companion.

## Stack

The pnpm workspace uses Turborepo, React 19, Vite, a Hono Cloudflare Worker, D1, private R2 storage, SQLite Durable Objects, and Workflows. The desktop app uses Rust, Tauri, Keychain, and a loopback MCP server.

## Users

One private owner uses Pokédex to understand a physical Pokémon card collection, check set and National Pokédex coverage, plan binders, and process local scans. Named passkeys identify trusted browser devices. Scoped desktop tokens connect the scanner without exposing the browser session.

## Purpose

Pokédex records quantities and notes, keeps the card catalogue searchable, and compares binder plans with the physical collection. A useful workflow starts with finding or scanning a card, confirms the match, updates the collection once, and shows any remaining binder shortage.

## Catalogue and pricing

TCGdex supplies physical card metadata and source art. Pokédex excludes TCG Pocket and keeps stable internal card IDs when source data changes. Prices retain source currency, source time, and FX date. The displayed A$ estimate uses the lowest current positive market value available for a card.

## Binders

Binder plans are fixed-capacity digital copies of physical layouts. A creator chooses the page face and enters the physical binder's exact pocket capacity, then deliberately grows or safely shrinks the plan when needed. Full pages use the selected rows and columns; only the final page may be partial. Each sleeve is empty, reserved, an exact-card target, or a National Pokédex target. Targets and owned-card placement are separate, so a target is not presented as physically filled until a compatible copy is assigned. Editable binder versions support page starts, signed-offset moves, closing gaps, anchored reservations, and a full 1,025-entry National Pokédex insert without catalogue synchronisation. Active versions report shortages, while archived versions remain readable but cannot change.

## Desktop companion

The Tauri app captures or imports one card image at a time, stores pending scans locally, synchronises high- and low-resolution WebP art, and keeps its cloud token in Keychain. Its authenticated MCP tools can inspect pending scans, search the catalogue, confirm a match, update collection notes and quantities, and work with binder drafts.

## Boundaries

Condition, finish, acquisition history, grading, finish detection, multi-card recognition, cloud inference, Workers AI, and Vectorize are outside the current product. Card art, credentials, collection data, and local scans remain private to the owner.

## Visual direction

Use the Personal/Xylem visual language. The interface is a calm working catalogue rather than a public marketplace. Pokémon artwork supplies most of the colour; navigation and data surfaces stay restrained and readable.

## Accessibility

Web workflows must be keyboard usable, show visible focus, meet WCAG AA contrast for normal text, label controls, and announce loading and error states without relying on colour alone. Login and pairing work at 390 by 844 pixels. Catalogue and binder screens keep their denser desktop layout at wider sizes.
