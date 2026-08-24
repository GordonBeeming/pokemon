# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: pnpm workspace with Turborepo, a Hono Cloudflare Worker, a React 19 and Vite SPA, D1, KV, R2, and a later Tauri companion.

## Users

One private owner uses the catalogue at a desk to understand a physical Pokémon card collection, check sets and the National Pokédex, and plan binders. A named passkey identifies each of the owner's trusted devices. A later home-scanning companion handles one locally captured card at a time.

## Product Purpose

Pokédex records card ownership as quantities and notes, keeps catalogue data searchable, and turns binder layouts into plans that can be compared with the physical collection. Success means the owner can find a card, update its quantity, and see what a binder plan still needs without maintaining a second spreadsheet.

## Positioning

Binder plans are digital twins of physical layouts. Draft plans may reuse a card target, while active plans report shortages without refusing an incomplete layout. TCGdex supplies source data, but the app keeps stable internal records and supports manual cards and overrides.

## Operating Context

The main web product is a desktop-first data workbench. Card art is private R2 content in high and low WebP forms. The Tauri companion later synchronises that art to a configurable local library and exposes a loopback Codex bridge for a one-card-at-a-time confirmation workflow.

## Capabilities and Constraints

The product covers physical Pokémon card types and physical languages available from TCGdex, excluding TCG Pocket. Ownership is quantity plus notes. Finish, condition, acquisition history, grading, finish detection, multi-card recognition, cloud inference, Workers AI, Vectorize, and queue-backed jobs are out of scope for v1. Binder layouts include 2x2, 3x3, 4x3, top-loader, and custom rows and columns. Prices are conservative A$ estimates based on positive ordinary market data, retaining source currency, source timestamp, and FX date.

## Brand Commitments

Use Personal/Xylem brand tokens. The interface is calm, precise, and built for operating a private collection rather than presenting a public marketplace. Do not invent public claims, social proof, or a second audience.

## Evidence on Hand

The source corpus is TCGdex data and private card art. The current measured art corpus is 98,803 physical-language images, approximately 7.36 GB high and 1.79 GB low. No public catalogue, testimonials, or commercial pricing promise is part of the product brief.

## Product Principles

1. Keep the owner's physical collection and the digital record in step.
2. Preserve source provenance without making the source part of the browser runtime.
3. Make incomplete binder plans useful instead of treating missing cards as an error.
4. Keep private art, credentials, and local scan captures scoped to the owner.

## Accessibility & Inclusion

All web workflows must be keyboard usable, have visible focus, preserve readable contrast, label form controls, and expose error and loading states without relying on colour alone. The narrow layout is reserved for login, pairing, and scan status; the catalogue and planner retain their desktop information density.
