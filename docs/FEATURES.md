# Feature parity checklist

This is the checklist that proves the frontend rewrite lost nothing the owner relies on. Every line
names a capability, tags its status against the old React SPA, and states a "done when" check a
tester can verify by using the running app — not by reading code.

Status tags:

- `keep` — same behaviour as the old SPA.
- `changed` — same purpose, different behaviour; the line says how.
- `new` — did not exist before.
- `dropped` — existed before and is intentionally not carried over; the line says why.

Source material: `inventory-core.md`, `inventory-binders.md`, `backend-review.md`, and `research.md`
in the run folder, plus the canvas board (`Home`, `Pokedex`, `Sets`, `CardDetail`, `Phone`, `Binder`,
`CardFrames`, `Settings`, `Main`).

---

## Shell & navigation

- [ ] dropped · The desktop scanner (macOS Tauri app) · dropped because the collection workflow
      moves fully to the web app plus a future AI/MCP skill built on the existing bearer-token API;
      nothing server-side depended on it, so nothing needs to replace it in-app.
- [ ] keep · Sidebar brand link to Home and six nav items with an active-route indicator · done
      when: clicking "Pokédex" from any screen returns to Home, and the current nav item shows an
      active state.
- [ ] keep · A global notice region announces success and error text for screen readers and sighted
      users alike · done when: an action like revoking a token shows visible confirmation text and a
      screen reader announces it.
- [ ] changed · The URL is the source of truth for every screen's state — search, filters, ownership,
      page, species/set context · done when: searching "Pikachu" with Missing selected, reloading the
      page, or pasting the URL into a new tab shows the same results every time.
- [ ] changed · Navigating to a section opens that section's own start, never a stale in-memory
      snapshot left over from a previous visit · done when: leaving Catalogue mid-search and clicking
      Catalogue again from the nav shows a fresh catalogue, not the old search silently reapplied.
- [ ] changed · One shared loading and error treatment covers every route, including Catalogue and
      Binders · done when: a slow network shows the same loading indicator style on Home, Catalogue,
      and Binders, and a failed load shows an error tied to the route actually open.
- [ ] keep · Every in-app link is modifier-click safe · done when: ctrl-clicking (or cmd-clicking) a
      nav link opens a new tab instead of navigating in place.
- [ ] changed · One navigation mechanism is used everywhere, not a mix of app-routed links and plain
      anchors · done when: clicking a link inside the active-shortages table behaves identically to
      clicking a sidebar link — same loading state, same URL update.
- [ ] keep · The app shell works offline via a service worker that caches only the shell, never API
      responses, and is purged automatically the moment a session is invalidated · done when: going
      offline after first load still shows the app shell instead of a browser error page, and signing
      out clears any cached private data.

## Sign-in & people

- [ ] keep · "Continue with passkey" signs in via WebAuthn · done when: signing in with a registered
      passkey lands on Home with no password prompt.
- [ ] keep · "Enrol another device" takes an enrolment secret and a device name, with required-field
      validation · done when: leaving the device name blank on submit shows a validation state
      instead of firing a network call.
- [ ] keep · "Use local development login" appears only on localhost/127.0.0.1 · done when: this
      button is absent when the app is opened at the production domain.
- [ ] keep · Login and enrolment share one error message area · done when: a failed passkey attempt
      and a failed enrolment attempt both show their error in the same place, announced as an alert.
- [ ] keep · Distinct app-level auth states — checking, signed out, fatal error with reload, signed in
      · done when: a fatal session-check failure shows a reload card, never a blank or endlessly
      spinning screen.
- [ ] keep · A 401 response purges private caches and forces sign-out automatically, with no user
      action required · done when: a session revoked server-side (for example by a restore) bounces
      the open tab back to sign-in on its next action.
- [ ] new · Invite someone: a single-use link that expires in 7 days · done when: using an invite link
      a second time after it has been redeemed is rejected.
- [ ] new · Accepting an invite registers the invitee's own passkey under their own new user, separate
      from the person who invited them · done when: two people who each accepted their own invite can
      sign in independently and each sees only their own data.
- [ ] new · Roles: admin and member, with promote/demote available to admins only · done when: a
      member's account has no visible control to change anyone's role.
- [ ] new · The last remaining admin can't be demoted or disabled · done when: attempting to disable
      the sole admin account is blocked with a clear reason.
- [ ] new · An admin can disable a user without deleting their data — sign-in is blocked and existing
      sessions are revoked immediately; re-enabling restores access · done when: disabling a
      signed-in member ends their session immediately, and re-enabling lets them sign back in with
      their collection unchanged.
- [ ] keep · "Your sign-in" lists every registered passkey by device label, with "Add a passkey for
      another device" · done when: adding a passkey from a second browser shows a new labelled entry
      in this list.

## Home

- [ ] keep · Header shortcuts "Browse cards" and "Plan the Pokédex" · done when: clicking each opens
      Catalogue and National Pokédex respectively.
- [ ] keep · Metric grid: owned unique cards, total quantity, and a collection A$ estimate · done
      when: adding a copy of a card increases the unique and total counters and the A$ estimate the
      next time Home loads.
- [ ] keep · "Active shortages" toggles the shortage report open and closed in place, returning
      keyboard focus to the toggle on close · done when: opening the panel, then closing it, leaves
      focus on the toggle button.
- [ ] keep · "Recently added cards" shelf lists up to 50 owned cards; clicking one opens Catalogue
      filtered to it; art is never dimmed here since every shelf card is owned; an empty shelf shows
      "Your shelf is ready." · done when: adding a new card shows it in the shelf, and clicking its
      tile opens Catalogue searched to that name.
- [ ] keep · Active shortages panel loads on open, paginates with "Load more", de-dupes entries, and
      silently reloads from page one if the underlying counts change mid-page · done when: loading
      more than one page of shortages never shows a duplicate row.
- [ ] keep · Shortage table columns (Target, Kind, Unfilled targets, Owned, Placed,
      Assigned/Available, Missing) each carry a deep link back into Catalogue · done when: clicking a
      shortage row's link opens Catalogue pre-filtered to that exact card or species.
- [ ] keep · Row-level retry on a load failure, "Open binder plans" and "Close" panel actions, and an
      empty state "No active shortages" · done when: with every target filled, opening the panel
      shows "No active shortages" instead of an empty table.
- [ ] changed · The shortage report respects the multi-user permission model · done when: a member's
      Home shortages panel only shows shortages for binders they can see.

## Catalogue

- [ ] keep · Search bar: free-text search (200-character max), an All/Missing/Owned segmented
      control, and a Search submit that reads "Searching…" while it runs · done when: typing a name
      and pressing Search filters the gallery.
- [ ] changed · Every filter — query, ownership, species, set, language, page — is written to the URL
      as it changes, not only on first load · done when: changing the ownership filter updates the
      address bar immediately, and Back returns to the previous filter state.
- [ ] keep · Contextual headers for a species gallery, a set gallery, or the full catalogue, with a
      "Show full catalogue" escape whenever a context filter is active · done when: opening Catalogue
      from a Pokédex species shows a species-scoped header and a working "Show full catalogue" link.
- [ ] keep · A species indexing status line (checking, result, or inline retry on failure), backed by
      a time-limited re-check cache · done when: opening the same species gallery twice within a few
      hours doesn't re-trigger a fresh TCGdex lookup, but "Try again" still works after a failure.
- [ ] keep · "Add a card that is not in TCGdex…" (in the control bar's More (⋯) menu, opening a
      dialog on desktop or a sheet on phone) creates a custom card with fixed language, category,
      and set metadata · done when: submitting a custom card name adds a findable card without
      choosing a language, set, or category.
- [ ] keep · A live "Showing X to Y of Z cards." status, a card gallery grid with a clear selected
      state, and an empty state "No cards match this search." · done when: an unmatched search shows
      that empty-state text instead of an empty grid.
- [ ] keep · Pagination at 50 cards per page, using the same component as National Pokédex · done
      when: paging past 50 results loads the next page without resetting the search bar.
- [ ] changed · Catalogue results follow the one fading rule: an unowned card gets the pale, dashed
      frame with its art faded, an owned one is solid; the card inspector never fades and states
      ownership in words · done when: an unowned card in the gallery shows the pale dashed frame
      with faded art, and the same card open in the inspector shows full-opacity art.
- [ ] keep · Preloads the art of the immediate neighbours of an open card, with a bounded cache · done
      when: pressing Next in the inspector on a preloaded neighbour shows its high-res art with no
      visible load flash.
- [ ] dropped · The `/api/catalogue/facets/species` client call · dropped because it has no caller
      today — the National Pokédex screen supersedes it — and is not reintroduced.
- [ ] changed · TCG Pocket cards are excluded from search, browsing, and new catalogue imports · done
      when: searching a known TCG Pocket-only set (for example "Paldean Wonders") returns no results.
- [ ] new · Desktop search bar: a slim bar (search, ownership toggle, a "Filters" button carrying an
      active-count badge) with set/region/type/order filters in an on-demand panel and active filters
      shown as removable chips · done when: opening Filters, choosing a set and a type, shows two
      removable chips next to the search bar and the badge reads "2".
- [ ] keep · Card art is always shown; when the source genuinely has none, an explicit
      "art unavailable" state renders instead of a blank tile · done when: a card confirmed to have
      no source art shows a labelled placeholder, never a broken-image icon.
- [ ] changed · Each card or species tile carries an accessible ownership mark separate from the
      art (solid frame for owned, pale dashed frame for missing) with a full text label for screen
      readers; the copy count shows in the card inspector only, never on a tile · done when: a
      screen reader announces "owned" or "not owned" for a tile, and the number of copies appears
      only once the card is open in the inspector.
- [ ] changed · Any art dimmed for a missing or unplaced state also carries its own accessible label,
      not only the nearby badge · done when: a screen reader focused directly on dimmed art still
      announces ownership or placement state.

## Card inspector

- [ ] keep · Opening a card shows a modal inspector — high-res art, position within the current
      result set, quantity, notes, and actions — without navigating away from the search · done when:
      clicking a tile in Catalogue opens this view over the search results.
- [ ] keep · Previous/Next chevrons and ArrowLeft/ArrowRight move through the current filtered result
      set and wrap around; arrow keys are ignored while typing in a field · done when: pressing
      ArrowRight while the notes textarea is focused types normally instead of moving cards.
- [ ] keep · Escape and clicking outside both close the inspector through the same unsaved-changes
      gate · done when: editing notes then pressing Escape shows a save-in-progress state before the
      view actually closes.
- [ ] keep · Focus is trapped inside the open inspector and page scroll is locked while it's open ·
      done when: pressing Tab repeatedly from the last control cycles back to the first, and the page
      behind it doesn't scroll.
- [ ] changed · At 0 copies there is no quantity counter — the first action is "Add first copy" · done
      when: an unowned card's inspector shows "Add first copy" instead of a quantity field at 0.
- [ ] new · Lowering a card's owned quantity always asks where the copy comes from: a specific binder
      pocket (unassigns it), a loose copy (disabled once every copy is placed), or "I miscounted" ·
      done when: reducing quantity on a card with 2 placed copies and 1 loose offers all three
      sources, and choosing a placed pocket clears that pocket's assignment.
- [ ] new · A card's split shows as "N in a binder · M loose" · done when: a card with 2 placed
      copies and 1 spare shows "2 in a binder · 1 loose" in the inspector.
- [ ] keep · Notes textarea (2,000-character max) with a live character count · done when: typing
      near the limit shows "N of 2,000 characters" updating live.
- [ ] keep · Autosave: debounced after edits, immediate on blur, with a status line cycling through
      saving, saved, and error-with-retry · done when: editing notes and waiting briefly shows
      "Saved." with no save button pressed.
- [ ] keep · Switching to a different card resets the draft to that card's own saved quantity and
      notes · done when: opening card A, editing notes without saving, then jumping to card B via
      Next shows card B's own notes, not a leaked draft.
- [ ] changed · Binder placement is not a separate disclosure — each binder the owner has is a row
      with a status tag (Target waiting / In binder / Not in binder); a row expands inline to show
      the destination and one action; "New binder" is the last row · done when: opening the inspector
      for a card that's a target in one binder shows that binder's row tagged "Target waiting", and
      expanding it offers to fill that exact target.
- [ ] keep · Choosing a destination for an exact-card target opens the copy-choice prompt (use an
      existing copy / add a new copy / don't add a copy) before committing · done when: placing a
      card you don't yet own into a binder pocket offers "Add a new copy" and picking it increments
      the owned count.
- [ ] new · "Put in a binder" fills a matching open target (for example, an "any Pikachu" Pokémon
      target) by assigning a copy, rather than rewriting the target into an exact-card target · done
      when: putting a specific Pikachu print into a binder with an unfilled "any Pikachu" target
      assigns the copy there and the pocket still reads "Any" afterward.
- [ ] keep · "Use as Pokédex image" sets the owner's chosen National Pokédex representative, shown
      only when a Pokédex number is resolvable · done when: choosing this action from a species
      gallery updates that species' tile everywhere in the National Pokédex.
- [ ] new · "View card" opens the same large preview — name, set, number, region, ownership state —
      from any surface that shows a card tap action: binder pockets, pickers, search results · done
      when: choosing "View card" from a binder pocket's tools shows the large preview over the
      binder, and closing it returns to exactly where you were.
- [ ] changed · The large preview never fades the art regardless of ownership; ownership is stated in
      words ("Owned" / "Not owned") · done when: viewing an unowned card through "View card" shows
      full-opacity art with the word "Not owned" next to it.
- [ ] keep · A failed autosave keeps the inspector open and blocks leaving until the draft saves or
      the user retries · done when: forcing a save failure and trying to close the inspector shows a
      retry prompt instead of silently discarding the edit.
- [ ] keep · A card with no available market price shows an explicit "No price yet" state instead of
      $0.00 or a blank value · done when: a custom or unpriced card's inspector shows
      "Market estimate: No price yet."

## Clipboard & bulk actions

- [ ] keep · The control bar's one "Copy" button opens a small menu; its "Displayed order" copies up
      to 2,000 matching cards in the currently displayed filter and sort order to a shared clipboard
      · done when: copying a 274-card search then opening a binder shows "274 card(s) copied."
- [ ] keep · The Copy menu's "Release-date order" copies the same result set sorted oldest-first,
      independent of the on-screen sort · done when: copying release-date order for a set copies its
      earliest print first regardless of the visible sort.
- [ ] keep · The Copy menu's "This page" copies only the 50 loaded cards, and is shown only when
      there are more than 50 total results · done when: a 40-result search's Copy menu doesn't show
      "This page", but a 120-result search's does.
- [ ] keep · Copy menu items are disabled while busy, while copying, at 0 results, above 2,000
      results, or before the first search resolves; each disabled item says why, and the cap message
      appears inside the menu only when it applies · done when: a 3,000-result search's Copy menu
      shows the whole-result items disabled under the same cap wording bulk-add uses.
- [ ] keep · The clipboard is shared with the binder's "Paste cards here" tool, persists in local
      storage, and stays in sync across open tabs · done when: copying cards in one tab immediately
      shows the copied count in a binder open in a second tab.
- [ ] changed · A successful copy closes the menu and shows a toast "N cards copied." with an "Open
      binders" action, instead of a permanent line in the layout · done when: copying cards shows
      that toast and its "Open binders" action opens the binder library.
- [ ] keep · Bulk "Add these results to a binder…" (in the More (⋯) menu, opening a dialog on
      desktop or a sheet on phone) adds every matching result in catalogue order to a chosen binder,
      capped at 2,000 with a consistent explanatory cap message · done when: adding a 2,500-result
      search to a binder is blocked with the same cap wording the copy tools use.
- [ ] changed · Catalogue's binder picker and the open binder's own binder list share one cache · done
      when: creating a binder from the catalogue's "Add to binder" picker makes it appear in the
      binder library without a manual refresh.
- [ ] keep · The clipboard is not auto-cleared after a paste; the same clipboard can be pasted into
      multiple pockets or binders · done when: pasting a clipboard into one binder, then opening a
      second binder, still offers "Paste cards here" with the same cards.
- [ ] keep · "Clear copied cards" removes the clipboard entirely · done when: clearing it makes
      "Paste cards here" disappear from every pocket's tools until something is copied again.

## National Pokédex

- [ ] keep · Query, ownership, page, region, scroll position, and focused tile all survive leaving
      and returning to the screen · done when: filtering to "Missing", scrolling down, opening a
      species, then pressing Back restores the same filter, scroll position, and focused tile.
- [ ] keep · "Find a Pokémon" matches name, region, zero-padded number (with or without a leading #),
      or type, and resets to page 1 on every keystroke · done when: typing "025" finds Pikachu and
      typing "fire" filters to Fire-type species.
- [ ] keep · The region picker is a full keyboard-accessible listbox showing live counts under the
      current query and ownership filters · done when: filtering to "Missing" first, then opening the
      region picker, shows counts that reflect only missing species per region.
- [ ] keep · An All/Missing/Owned segmented control resets to page 1 on change · done when: switching
      to "Owned" while on page 3 returns to page 1 of owned-only results.
- [ ] changed · Species tiles show a real printing's art (faded if the species is unowned) with no
      repeated caption labels — just name and "#number · region" · done when: an unowned species
      tile shows dimmed real card art with its name and number, not a placeholder graphic or a
      "Not owned" caption line.
- [ ] keep · A live "Showing X of Y matching species." status and a header "N of 1,025 species owned"
      progress line · done when: the header count updates immediately after adding the first copy of
      a previously-unowned species.
- [ ] keep · Rows are disabled while that species' printing discovery is in flight, preventing a
      second concurrent discovery · done when: clicking a not-yet-indexed species disables it until
      indexing finishes.
- [ ] keep · Opening a species navigates straight into its catalogue gallery and triggers indexing in
      place · done when: clicking a species tile opens its gallery immediately, with an indexing
      status line rather than a separate loading screen.
- [ ] keep · Empty state "No Pokémon match these filters." · done when: an impossible filter
      combination shows this text instead of a blank grid.

## Sets & codes

- [ ] keep · "Find a set" filters the set list client-side · done when: typing part of a set name
      narrows the list without a network request.
- [ ] keep · Each row shows owned/total/language with a progress bar; clicking opens Catalogue
      filtered to that set with its language preserved · done when: opening a Japanese-language set
      keeps the language filter in the resulting catalogue URL.
- [ ] changed · Every set lists its stored code, full name, and release date, so the owner can learn
      the codes the card frame shows · done when: the Sets screen shows a code (for example "MEW")
      next to every set's full name and release date.
- [ ] new · Sets without a TCGdex-supplied code (promos, specials) get an owner-editable code; two
      sets that would otherwise share a code (30th Classic Collection and 30th Celebration) are
      disambiguated · done when: editing one of the two "30C"-colliding sets to a distinct code
      updates that set's frame everywhere it appears.
- [ ] new · The same area lists every normalised rarity code with its printed-style symbol and full
      name · done when: looking up a card's rarity symbol here matches the symbol on that card's
      frame.
- [ ] keep · Empty state "Nothing to show yet." · done when: an empty or failed set list shows this
      text instead of a blank page.

## Binders library

- [ ] keep · "New binder" toggles the create form in place · done when: clicking it shows the create
      form without navigating away from the library.
- [ ] keep · Create form: name (required, ≤120 characters), page face (2×2, 3×3, 4×3, Top-loader, or
      Custom with 1–20 rows/columns), pocket capacity with live help text, and a "Create binder"
      submit disabled while invalid · done when: choosing Custom with 5 rows and 4 columns and a
      matching capacity creates a binder with that exact page shape.
- [ ] keep · A binder library grid where each tile opens that binder · done when: clicking any binder
      tile opens straight into its current page.
- [ ] keep · "Back to all binders" returns to the library from any open binder · done when: it works
      from any open binder page.

## Binder page

- [ ] keep · Page stepper: First/Previous/"Page n of total" jump with Go/Next/Last, all disabled
      while pending or out of range · done when: typing an out-of-range page number and pressing Go
      is rejected rather than jumping past the last page.
- [ ] keep · "Manage page" popover: reserve/edit label, move earlier/later, arrange targets, remove
      this page (disabled if not removable or the only page) · done when: opening this popover on a
      binder's only page shows "Remove this page" disabled.
- [ ] keep · A bookmark jump dropdown lists every saved bookmark, including auto-generated ones for
      reserved pages · done when: reserving a page adds it to the bookmark dropdown without manually
      bookmarking anything.
- [ ] keep · Binder space search: a debounced text search across every page, results show
      label/page/row·column/placed state, paginated 50 at a time, and clicking a result jumps to and
      focuses that pocket · done when: searching a reservation label jumps straight to its page with
      that pocket focused.
- [ ] keep · An unsubmitted "go to page" value is discarded when switching to a different binder via
      a direct link · done when: typing "45" in the page-jump field without pressing Go, then opening
      a different binder by URL, shows an empty jump field, not the leftover "45".
- [ ] keep · Selecting a pocket opens pocket tools whose available actions depend on its state
      (target / reserved sleeve / empty / archived read-only) · done when: selecting an empty pocket
      offers "Insert targets here" and "Reserve sleeve", while a filled target pocket instead offers
      move/replace/remove/placement tools.
- [ ] new · The pocket-tools surface is a floating action bar under the binder on both desktop and
      phone, showing a thumbnail, "#number name", page/row/pocket, and placed status, with every
      action shown as an icon plus a label from one shared icon set · done when: selecting any pocket
      shows the action bar with a legible icon-and-label pair for each action, using the same icon
      for "Move" everywhere it appears.
- [ ] keep · Clicking outside a selected pocket, its tools, or an open dialog deselects it · done
      when: clicking empty space outside the binder grid closes the action bar and clears selection.
- [ ] keep · Pocket selection is reflected in the URL and does not survive plain page navigation, but
      does survive a mutation, a bookmark jump, or a space-search jump · done when: pressing Next
      resets the selection, but saving a move keeps the moved pocket selected afterward.
- [ ] keep · "Move to another pocket" arms a cancelable move; clicking, dragging, or pressing `m` on
      a focused pocket all trigger the same move, and Escape cancels an armed move · done when:
      pressing `m` on a focused target pocket, then clicking a destination, moves it exactly as
      dragging it there would.
- [ ] new · The move shortcut is discoverable — the "Move" action's visible label or tooltip states
      the `m` key, not only an aria-label · done when: hovering or focusing "Move" shows the `m`
      shortcut in visible text.
- [ ] keep · "Replace with same type" pre-fills a search by the target's own species or category;
      "Replace with any card" is a free search; both share the Insert dialog's result grid and
      pagination · done when: replacing a Pikachu target with "same type" starts the search already
      filtered to Pikachu.
- [ ] keep · "Insert a gap or shift sleeves" moves later targets forward or closes a gap by a signed
      integer · done when: entering -1 removes one empty sleeve and shifts everything after it back
      by one.
- [ ] changed · "Remove" wording adapts to what's being removed — a reserved sleeve gets "Unreserve"
      language instead of "Remove card" · done when: opening the remove tool on a reserved sleeve
      shows "Unreserve this sleeve", not "Remove card and leave gap".
- [ ] keep · "Owned copies and page break" lists compatible unassigned owned copies to assign, offers
      "Remove physical placement", and a "Start this target on a new page" checkbox (hidden on
      reserved pages) · done when: assigning one of two available compatible copies reduces the
      remaining-copies count shown for other targets needing that same card by one.
- [ ] keep · "Reserve sleeve" on an empty pocket takes an optional label · done when: reserving an
      empty pocket with a label shows that label in the pocket and in the bookmark list.
- [ ] keep · "Insert targets here" opens the Insert dialog anchored at the selected pocket · done
      when: choosing this from a pocket shows "Insert at page P, pocket R:C, shifting later targets"
      as the destination.
- [ ] keep · "Paste cards here" opens the Paste dialog anchored at the selected pocket, offered only
      when a clipboard exists · done when: with an empty clipboard, no pocket offers "Paste cards
      here."
- [ ] keep · "Bookmark pocket" defaults its name to the Pokémon name, card name, reservation label, or
      "Empty", and can save or remove a bookmark for that pocket · done when: bookmarking an empty
      pocket without typing a name saves it labelled "Empty."
- [ ] keep · Delete/Backspace on a focused pocket with an assigned copy removes only the physical
      placement, keeping the target · done when: pressing Delete on a filled target pocket clears its
      assignment but the target's identity ("Any" or exact card) stays.
- [ ] keep · The copy-choice prompt shows the card, owned quantity, and "Use an existing copy" /
      "Add a new copy (N→N+1)" / "Don't add a copy", plus "Refresh owned count" and "Back to cards" ·
      done when: choosing "Add a new copy" on a 0-quantity card increments the owned count and fills
      the pocket in one step.
- [ ] keep · The Insert dialog offers Pokémon-targets and exact-cards tabs, a destination line
      reflecting the anchor pocket or an end-of-binder append point, "Select all N matches", "Clear
      selection", a toggleable result grid capped at 1,025 selections, and a live
      "N targets selected." status · done when: selecting all matching Pokémon species for a
      filtered region and inserting them places exactly that many new targets.
- [ ] changed · The 1,025 selection cap on exact-card search results is explained the same way the
      copy-tools cap is · done when: exceeding the cap on an exact-card search names the limit in the
      same style the catalogue's copy tools use.
- [ ] keep · The Paste dialog offers "Use existing pockets without shifting" vs "Insert and shift
      later targets", a live server-calculated preview per mode, a required confirmation checkbox
      when a replace would release existing assignments, a list of the first 8 copied cards with a
      "+N more" count, and a "Refresh preview" retry on error · done when: switching to replace mode
      on a clipboard that would displace 3 targets shows a required confirmation checkbox naming
      those targets before "Paste" can be pressed.
- [ ] keep · Closing the Paste dialog is blocked while a paste is actually saving · done when:
      clicking outside the dialog mid-save does not close it until the save finishes.
- [ ] keep · Binder pocket art shows the assigned copy's art if placed, otherwise the exact-card
      target's own art dimmed; an unfilled Pokémon-kind target shows no art image at all · done when:
      an unfilled exact-card target shows dimmed real art, while an unfilled Pokémon-kind target
      shows none.
- [ ] changed · An unfilled Pokémon-kind ("any printing") target shows its number and name plus an
      explicit "Any" pill, instead of rendering no image at all · done when: an unfilled "any
      Pikachu" pocket shows "#0025 Pikachu" with a visible "Any" pill rather than a blank pocket.
- [ ] keep · All three card-picker surfaces inside binder tools (copy prompt, insert dialog, replace
      search) show art at full opacity, never dimmed · done when: browsing results inside "Replace
      with any card" shows every result at full opacity regardless of ownership.
- [ ] keep · A slow create/delete/mutation that finishes after the user has navigated elsewhere shows
      its own success or error toast but never rewrites the URL out from under the current screen ·
      done when: starting a delete, immediately switching to a different binder, then letting the
      delete resolve leaves the second binder's URL untouched.
- [ ] keep · A card picked up (armed for move) in one binder is never still armed after switching to
      a different binder · done when: pressing `m` on a pocket in binder A, then opening binder B via
      a direct link, shows no "Moving the card…" banner in binder B.
- [ ] keep · Direct links and back/forward navigation restore scroll position and focus to the linked
      pocket, or the first pocket on that page; ordinary in-app page navigation does not perform this
      restoration · done when: opening a bookmarked pocket link in a fresh tab scrolls to and focuses
      that exact pocket.
- [ ] keep · Internal app-driven URL updates never re-trigger a duplicate page load, and every
      in-flight page/candidate/search request is aborted on navigation · done when: repeatedly
      selecting different pockets causes no repeated network requests beyond what each selection's
      own tools need.
- [ ] keep · Deleting the binder currently open redirects to the library only if it's still the one
      open — a different binder opened while the delete was in flight is left alone · done when:
      deleting binder A, then quickly opening binder B before the delete finishes, stays on binder B
      once the delete completes.
- [ ] changed · Binder links are real paths, `/binders/<id>?page=&v=&sel=<pageId>:<row>:<col>`,
      instead of the old `#binders?…` hash; `/binders` alone opens the library; an invalid pocket
      reference is dropped silently while the page itself still opens ·
      done when: visiting a binder link with a nonsense row/column still opens the correct page with
      no pocket selected, instead of an error.
- [ ] keep · Any open pocket dialog or panel traps Tab focus within it and returns focus to whatever
      opened it when closed · done when: tabbing through the Insert dialog cycles within it, and
      closing it returns keyboard focus to the "Insert targets here" control that opened it.
- [ ] keep · Selecting a pocket updates the URL without adding a browser-history entry, while normal
      page navigation does add one · done when: selecting five different pockets in a row, then
      pressing Back once, returns to the page before the binder was opened.
- [ ] keep · Binder space search results and query are dropped when switching to a different binder ·
      done when: searching a term in binder A, then opening binder B, shows an empty search box with
      no leftover results from A.

## Binder management

- [ ] keep · "Delete binder" requires typing the exact binder name to confirm; deleting the currently
      open binder redirects to the library · done when: typing a mismatched name keeps "Permanently
      delete binder" disabled, and the exact name enables it.
- [ ] keep · "Print" renders a print-friendly layout via the browser's print dialog · done when:
      opening print preview hides the toolbar and tools chrome and shows only the binder pages.
- [ ] keep · Archived binders are read-only: only "Bookmark pocket" remains available, every other
      pocket tool and keyboard shortcut is inert, with a visible read-only banner · done when:
      opening an archived binder and pressing the `m` move shortcut on a pocket does nothing, while
      bookmarking still works.
- [ ] keep · "Manage binder" offers a capacity input with live help text and a "Grow binder" or
      "Safely shrink binder" submit depending on direction · done when: entering a capacity below the
      current value changes the submit label to "Safely shrink binder."
- [ ] new · Arrangement supports multiple sort keys — Pokédex number, set number, release date,
      language — chosen by whoever is arranging, not hard-coded · done when: choosing "release date"
      for "Arrange targets" reorders the binder's targets oldest-first.
- [ ] keep · If a mutation needs more capacity than is available, the capacity field auto-fills with
      the required amount and a message points to "Manage binder" · done when: an insert needing 3
      more pockets than available shows the resize field pre-filled with the new total.
- [ ] new · After growing capacity from that auto-fill, the original action that triggered it is
      retried automatically rather than requiring it to be redone from scratch · done when:
      confirming the suggested capacity grow completes the insert that originally failed, without
      reopening the insert dialog.
- [ ] new · Binder drafts: clone the active version into an editable draft, edit it independently,
      then either make it active or discard it · done when: cloning a binder into a draft, moving
      several targets in the draft, then discarding it leaves the original active version unchanged.
- [ ] new · A full 1,025-entry National Pokédex insert is available from the UI, with an option to
      start a new page per region · done when: running the full insert with region page breaks
      enabled on an empty binder creates a page break at each region's first entry.
- [ ] new · Per-binder setting: "Card frame" on/off — off shows raw card art in pockets with no frame
      chrome · done when: turning the frame off in one binder's settings shows plain card art in
      every pocket of that binder, with the frame still shown in every other binder.
- [ ] new · Per-binder setting: page peek — shows N columns of the previous/next page at the edges,
      slides when a page turns, and dragging a card to a peeked edge flips to that page · done when:
      setting peek to 2 columns shows two columns of the next page at the right edge, and dragging a
      card there for a moment turns the page.
- [ ] keep · A clipboard banner in the open binder reads "N card(s) copied…" with "Clear copied
      cards" · done when: copying cards in Catalogue then opening any binder shows this banner until
      cleared.
- [ ] keep · "Reserve this page" / "Edit page label" offers an optional label, and "Unreserve this
      page" once reserved · done when: reserving a page with a label shows that label in the bookmark
      jump list.
- [ ] keep · "Move page earlier" / "Move page later" reorders pages, and the page stepper reflects
      the new order immediately · done when: moving the second page earlier swaps its position with
      the first page.
- [ ] changed · Binder targets pointing at now-hidden TCG Pocket cards are surfaced for the owner to
      retarget, rather than left silently broken · done when: opening a binder with a target pointing
      at a hidden Pocket card shows that pocket flagged as needing attention, with a path to pick a
      replacement.
- [ ] new · Manage binder has an "Add a page at the end" control alongside capacity growth · done
      when: Add a page at the end adds one empty page after the last page and nothing else moves.
- [ ] dropped · Exposing bulk slot-assignment directly in the UI · dropped because the insert and
      per-pocket assignment flows already cover every bulk scenario the research surfaced; the
      endpoint stays available server-side for scripts.
- [ ] new · Manage binder shows this binder's shortage count, next to the dashboard's cross-binder
      Active shortages report · done when: a binder with unfilled targets shows its own count in
      Manage binder.

## Settings

- [ ] changed · "API tokens" (renamed from Devices): create a pairing code with a visible expiry,
      copy it, list issued tokens with last-used time, and revoke any of them · done when: revoking a
      token removes it from the list and any future use of it is rejected.
- [ ] dropped · The Devices screen as a distinct nav destination · dropped because its pairing and
      device-list capability continues under Settings → API tokens, reframed for scripts and future
      AI skills rather than just one scanner.
- [ ] new · Card frame colours: per-type presets, a custom colour picker, "Reset to defaults", and a
      contrast warning below 4.5:1 against white · done when: choosing a poor-contrast custom colour
      shows the warning, and "Reset to defaults" restores every type's shipped colour.
- [ ] new · "Sync now" triggers a catalogue sync from TCGdex, with the last-synced date shown · done
      when: pressing it starts a sync and the "Last synced" date updates once it completes.
- [ ] new · A scheduled, infrastructure-level backup runs automatically with no user-facing control ·
      done when: a new backup run exists roughly every 36 hours with no one having opened a backup
      screen — because there isn't one.

## Phone

- [ ] new · Controls are collapsed by default on narrow screens; cards lead the layout · done when:
      at a 390px-wide viewport, Catalogue opens straight to the result grid with search and filter
      controls collapsed behind a summary control.
- [ ] new · A single summary pill ("query · filter · count", for example "Pikachu · Missing · 12")
      expands into the full search and filter controls on tap · done when: tapping the summary pill
      on phone reveals the search field and filters, and applying a search collapses it back to an
      updated summary.
- [ ] new · Contextual banners (species/set/full-catalogue context) collapse to a single line on
      phone · done when: opening a species gallery on a phone-width screen shows one line of context
      text, not a multi-line header block.
- [ ] keep · Login and pairing/invite screens work at 390×844 with no horizontal scroll · done when:
      the sign-in screen at that exact viewport size shows no horizontal scrollbar and every control
      is reachable without zooming.
- [ ] new · Binder page peek, pocket selection, and the floating action bar work with touch: tapping
      a pocket selects it, dragging toward a peeked page edge flips the page · done when: on a
      touch-emulated viewport, tapping a pocket shows the action bar, and dragging a card toward the
      visible edge of the next page turns to it.
- [ ] new · Every binder and catalogue action available on desktop (View card, Find cards, Move,
      Change target, Insert/shift, Paste here, Bookmark, Remove) is reachable on phone through the
      same floating action bar, sized for touch · done when: at a phone-width viewport, selecting a
      filled pocket shows the same set of actions as desktop, laid out for touch.

---

## Inventory → checklist mapping

Every numbered or bulleted item in `inventory-core.md` §2–§4 and `inventory-binders.md` §2–§5 is
listed below against the FEATURES.md line(s) it maps to, grouped by the checklist line for
readability. Citations use each inventory document's own section/subsection headings.

### `inventory-core.md` §2 — Per-screen capabilities

| Inventory item                                                             | FEATURES.md line                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Shell: brand link + 6 nav items, `aria-current`                            | Shell & navigation: sidebar nav                       |
| Shell: global `notice` region (sr-only live + visible alert)               | Shell & navigation: global notice region              |
| Shell: `notice` cleared on every `navigate()`                              | Shell & navigation: global notice region              |
| Login: "Continue with passkey" WebAuthn login                              | Sign-in & people: passkey login                       |
| Login: "Enrol another device" form + validation                            | Sign-in & people: enrol another device                |
| Login: "Use local development login" (host-gated)                          | Sign-in & people: local dev login                     |
| Login: single shared error paragraph                                       | Sign-in & people: shared error area                   |
| Login: app-level auth states (checking/anonymous/error/authenticated)      | Sign-in & people: auth states                         |
| Login: session-loss via `AUTH_LOST_EVENT` forces sign-out                  | Sign-in & people: 401 forces sign-out                 |
| Dashboard: "Browse cards" / "Plan the Pokédex" header links                | Home: header shortcuts                                |
| Dashboard: metric grid (owned unique / total qty / A$ estimate)            | Home: metric grid                                     |
| Dashboard: Active shortages toggle, expand/collapse, focus mgmt            | Home: active shortages toggle                         |
| Dashboard: `activeShortageCount()` server-field-or-fallback                | Home: active shortages toggle                         |
| Dashboard: Recently added shelf (≤50), click → catalogue search            | Home: recently added shelf                            |
| Dashboard: empty state "Your shelf is ready."                              | Home: recently added shelf                            |
| Active shortages: load on mount/identity change, abort in-flight           | Home: active shortages panel load/paginate            |
| Active shortages: "Load more", de-dupe by kind+id                          | Home: active shortages panel load/paginate            |
| Active shortages: snapshot-consistency guard                               | Home: active shortages panel load/paginate            |
| Active shortages: row-level "Try again"/"Retry", `role="alert"`            | Home: retry/open binder plans/close/empty state       |
| Active shortages: table columns + catalogue deep link                      | Home: shortages table columns                         |
| Active shortages: `catalogueHrefForEntry()` deep link building             | Home: shortages table columns                         |
| Active shortages: "Open binder plans" + "Close"                            | Home: retry/open binder plans/close/empty state       |
| Active shortages: empty state "No active shortages"                        | Home: retry/open binder plans/close/empty state       |
| Catalogue: search bar (text/segmented/submit)                              | Catalogue: search bar                                 |
| Catalogue: filters not written to address bar (bug)                        | Catalogue: URL reflects every filter (fixed)          |
| Catalogue: ownership/query resync from `initialParams` prop change         | Catalogue: URL reflects every filter                  |
| Catalogue: contextual headers + "Show full catalogue"                      | Catalogue: contextual headers                         |
| Catalogue: species indexing status line + 6h cache + retry                 | Catalogue: species indexing status line               |
| Catalogue: "Copy displayed order"                                          | Clipboard & bulk actions: copy displayed order        |
| Catalogue: "Copy release-date order"                                       | Clipboard & bulk actions: copy release-date order     |
| Catalogue: "Copy this page" (>50 results only)                             | Clipboard & bulk actions: copy this page              |
| Catalogue: copy tools disabled conditions                                  | Clipboard & bulk actions: copy disabled conditions    |
| Catalogue: clipboard shared/localStorage/cross-tab                         | Clipboard & bulk actions: shared clipboard, cross-tab |
| Catalogue: post-copy confirmation + "Open binders"                         | Clipboard & bulk actions: post-copy confirmation      |
| Catalogue: "Add a card that is not in TCGdex"                              | Catalogue: add custom card                            |
| Catalogue: "Add these results to a binder" bulk disclosure                 | Clipboard & bulk actions: bulk add to binder          |
| Catalogue: live "Showing X to Y of Z" status, gallery, empty state         | Catalogue: live status + gallery + empty state        |
| Catalogue: pagination (50/page)                                            | Catalogue: pagination 50/page                         |
| Catalogue: detail lightbox (position of total, high-res art)               | Card inspector: modal detail view                     |
| Catalogue: Prev/Next chevrons + arrow-key shortcuts, wraparound            | Card inspector: prev/next + arrow keys                |
| Catalogue: Escape closes through save gate                                 | Card inspector: escape/outside-click                  |
| Catalogue: Tab focus trap                                                  | Card inspector: focus trap + scroll lock              |
| Catalogue: body scroll lock                                                | Card inspector: focus trap + scroll lock              |
| Catalogue: quantity input (0–9999) + notes (≤2000, live count)             | Card inspector: notes 2000 char + live count          |
| Catalogue: autosave (650ms debounce + blur + status cycle)                 | Card inspector: autosave cycle                        |
| Catalogue: leaving-while-dirty guard                                       | Card inspector: failed autosave blocks leaving        |
| Catalogue: switching card resets draft                                     | Card inspector: draft resets per card                 |
| Catalogue: "Add one copy" button                                           | Card inspector: no 0 counter, "Add first copy"        |
| Catalogue: "Use as Pokédex image"                                          | Card inspector: use as Pokédex image                  |
| Catalogue: "Add to binder" section (choice/replace/add-at-end/conflict)    | Card inspector: binder rows as control                |
| Catalogue: image preloading of neighbours, bounded cache                   | Catalogue: neighbour image preloading                 |
| Set checklists: "Find a set" client filter                                 | Sets & codes: find a set filter                       |
| Set checklists: live "Showing all N matching sets."                        | Sets & codes: find a set filter                       |
| Set checklists: row (owned/total/language + bar), click preserves language | Sets & codes: row shows owned/total/language          |
| Set checklists: empty state "Nothing to show yet."                         | Sets & codes: empty state                             |
| National Pokédex: state lifted to App, survives nav away/back              | National Pokédex: state survives leave/return         |
| National Pokédex: "Find a Pokémon" search, resets page 0                   | National Pokédex: search matches name/region/number   |
| National Pokédex: RegionPicker combobox, live counts                       | National Pokédex: region picker with live counts      |
| National Pokédex: SegmentedControl, resets page 0                          | National Pokédex: ownership segmented control         |
| National Pokédex: live status + 50/page grid + representative/preview art  | National Pokédex: live status + header progress       |
| National Pokédex: row click → openSpecies, stash focus/scroll              | National Pokédex: open species → gallery              |
| National Pokédex: rows disabled during discovery                           | National Pokédex: rows disabled during discovery      |
| National Pokédex: on-mount scroll/focus restoration                        | National Pokédex: state survives leave/return         |
| National Pokédex: pagination, empty state, header progress                 | National Pokédex: empty state / header progress       |
| Devices: "Create pairing code" button                                      | Settings: API tokens                                  |
| Devices: pairing-code output panel + "Copy code"                           | Settings: API tokens                                  |
| Devices: paired-device list + "Revoke"                                     | Settings: API tokens                                  |
| Devices: empty state "No scanner is paired."                               | Settings: Devices screen dropped                      |

### `inventory-core.md` §3 — Auth flows and settings/admin surfaces

| Inventory item                                                | FEATURES.md line                                |
| ------------------------------------------------------------- | ----------------------------------------------- |
| Passkey login and enrolment (dup of §2)                       | Sign-in & people: passkey login / enrol device  |
| Local dev login shortcut (dup of §2)                          | Sign-in & people: local dev login               |
| Session check on load (`api.me()`)                            | Sign-in & people: auth states                   |
| Session loss / private cache purge (dup of §2)                | Sign-in & people: 401 forces sign-out           |
| Desktop pairing / device management (dup of §2)               | Settings: API tokens; Settings: Devices dropped |
| Service worker: shell caching, offline fallback, purge on 401 | Shell & navigation: offline shell               |
| Backups/sync-workflow triggers not present in the React app   | Settings: sync now; Settings: scheduled backup  |

### `inventory-core.md` §4 — Card art / ownership display rules

| Inventory item                                                          | FEATURES.md line                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `CardArtDisplay` discriminated union (binder/collection/preview)        | Catalogue: one fading rule (unowned faded, inspector never fades) |
| `isCardArtDimmed()` rule                                                | Catalogue: one fading rule (unowned faded, inspector never fades) |
| Call site: catalogue gallery/lightbox → `preview`, never dimmed         | Catalogue: one fading rule (unowned faded, inspector never fades) |
| Call site: National Pokédex tile → `collection`                         | National Pokédex: real printing art, no repeated captions         |
| Call site: dashboard shelf → `collection`                               | Home: recently added shelf                                        |
| Call site: binder pocket → `binder`                                     | Binder page: pocket art rules                                     |
| Call site: binder slot-picker / insert dialog / copy-prompt → `preview` | Binder page: all three pickers full opacity                       |
| Inconsistency: opacity vs. badge, dimming carries no ARIA label         | Catalogue: accessible ownership mark; dimmed art carries a label  |

### `inventory-binders.md` §2 — Every user capability

| Inventory item                                                    | FEATURES.md line                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| "New binder" toggle button                                        | Binders library: new binder toggle                                  |
| Create form (name/page-face/capacity/help/submit)                 | Binders library: create form                                        |
| Binder library grid → open binder                                 | Binders library: library grid                                       |
| "Back to all binders" link                                        | Binders library: back to all binders                                |
| "Print" header button + `@media print`                            | Binder management: print                                            |
| "Delete binder" confirm flow + redirect                           | Binder management: delete binder                                    |
| Archived binders: read-only banner, inert controls, bookmark-only | Binder management: archived read-only                               |
| Page stepper (First/Previous/jump+Go/Next/Last)                   | Binder page: page stepper                                           |
| "Manage page" popover (reserve/label/move/arrange/remove)         | Binder page: manage page popover                                    |
| Bookmark jump dropdown                                            | Binder page: bookmark jump dropdown                                 |
| Binder space search (debounced, paginated, jump+focus)            | Binder page: space search                                           |
| "Go to page" draft reset via remount on binder switch             | Binder page: page-jump draft resets                                 |
| Click pocket selects; floating pocket tools rail, state-dependent | Binder page: pocket selection → state-dependent tools               |
| Click outside deselects                                           | Binder page: click outside deselects                                |
| Selection in URL, doesn't survive plain navigation                | Binder page: selection in URL                                       |
| "Move to another pocket" banner + Cancel move                     | Binder page: move (click/drag/keyboard)                             |
| `m` key pick-up shortcut (no on-screen hint)                      | Binder page: move (click/drag/keyboard); move shortcut discoverable |
| Drag-and-drop move                                                | Binder page: move (click/drag/keyboard)                             |
| Escape cancels armed move                                         | Binder page: move (click/drag/keyboard)                             |
| "Replace with same type" / "Replace with any card"                | Binder page: replace same-type/any-card search                      |
| "Insert a gap or shift sleeves" (signed offset)                   | Binder page: insert gap/shift sleeves                               |
| "Remove card": leave gap vs close gap                             | Binder page: remove wording adapts to reserved sleeve               |
| "Owned copies and page break" panel                               | Binder page: owned copies + page break                              |
| "Reserve sleeve" (empty pocket)                                   | Binder page: reserve sleeve                                         |
| "Insert targets here"                                             | Binder page: insert targets here anchored                           |
| "Paste cards here"                                                | Binder page: paste cards here anchored                              |
| "Bookmark pocket" (BookmarkEditor)                                | Binder page: bookmark pocket editor                                 |
| Delete/Backspace removes physical placement only                  | Binder page: delete/backspace removes placement only                |
| `BinderCopyPrompt` (existing/new/none, refresh, back)             | Binder page: copy-choice prompt                                     |
| Insert dialog: tabs, destination line                             | Binder page: insert dialog                                          |
| Insert dialog: search field per tab                               | Binder page: insert dialog                                          |
| Insert dialog: "Select all N matches"                             | Binder page: insert dialog; 1,025 cap message consistent            |
| Insert dialog: "Clear selection"                                  | Binder page: insert dialog                                          |
| Insert dialog: result grid, 1,025 cap                             | Binder page: insert dialog; 1,025 cap message consistent            |
| Insert dialog: Prev/Next results paging                           | Binder page: insert dialog                                          |
| Insert dialog: footer status + submit                             | Binder page: insert dialog                                          |
| Paste dialog: anchored trigger                                    | Binder page: paste dialog                                           |
| Paste dialog: mode radio (replace vs insert)                      | Binder page: paste dialog                                           |
| Paste dialog: live preview + messaging + confirm checkbox         | Binder page: paste dialog                                           |
| Paste dialog: "Refresh preview" retry                             | Binder page: paste dialog                                           |
| Paste dialog: first-8 list + "And N more"                         | Binder page: paste dialog                                           |
| Paste dialog: footer submit + disabled conditions                 | Binder page: paste dialog                                           |
| Paste dialog: close blocked while saving                          | Binder page: paste dialog close blocked while saving                |
| "Manage binder" toggle → capacity panel                           | Binder management: manage binder capacity control                   |
| Binder capacity: grow/shrink submit                               | Binder management: manage binder capacity control                   |
| "Arrange targets" (hard-coded pokedex-number)                     | Binder management: multiple arrangement sort keys                   |
| `binder_capacity_exceeded` auto-fill + message                    | Binder page/management: capacity-exceeded auto-fill + retry         |
| "Reserve this page"/"Edit page label"/"Unreserve"                 | Binder management: reserve/edit page label                          |
| "Move page earlier"/"Move page later"                             | Binder management: move page earlier/later                          |
| Clipboard: localStorage, zod, 2000 cap, 1.5MB cap, cross-tab      | Clipboard & bulk actions: shared clipboard, cross-tab               |
| Clipboard: populated by catalogue copy actions                    | Clipboard & bulk actions: copy displayed/release-date/this page     |
| Clipboard: binder header banner + "Clear copied cards"            | Binder management: clipboard banner + clear                         |
| Clipboard: not auto-cleared after paste                           | Clipboard & bulk actions: clipboard persists across pastes          |
| `insertFullPokedex`/`previewFullPokedex` (no UI)                  | Binder management: full 1,025 insert with region page breaks        |
| Catalogue "Add to binder" (dup)                                   | Card inspector: binder rows as control                              |
| Catalogue bulk "Add these results to a binder" (dup)              | Clipboard & bulk actions: bulk add to binder                        |
| Two independent binder-list caches                                | Clipboard & bulk actions: unified binder-list cache                 |
| Dashboard "Active shortages" (cross-binder, dup)                  | Home: shortages table columns / retry-open-close                    |
| Keyboard: `m` pick-up                                             | Binder page: move (click/drag/keyboard)                             |
| Keyboard: Delete/Backspace removes placement                      | Binder page: delete/backspace removes placement only                |
| Keyboard: Escape cancels armed move                               | Binder page: move (click/drag/keyboard)                             |
| Keyboard: Escape closes open panel/dialog, focus returns          | Binder page: dialogs/panels trap focus                              |
| Keyboard: Tab/Shift+Tab focus trap in modal panel                 | Binder page: dialogs/panels trap focus                              |
| Keyboard: Escape on "Manage page" popover                         | Binder page: manage page popover                                    |
| URL format `#binders?version=&page=&row=&column=`                 | Binder page: binder links are real paths (changed)                  |
| `#binders` alone shows library                                    | Binder page: URL hash format                                        |
| Parsing validation, invalid pocket dropped silently               | Binder page: URL hash format                                        |
| `pushState` vs `replaceState` distinction                         | Binder page: pocket selection uses replaceState                     |

### `inventory-binders.md` §3 — Card art opacity rules

| Inventory item                                                  | FEATURES.md line                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `isCardArtDimmed()` (binder/collection/preview), dup of core §4 | Binder page: pocket art rules                                         |
| Binder grid: assigned-copy art, else target's own art dimmed    | Binder page: pocket art rules                                         |
| Unfilled Pokémon-kind target renders no image at all            | Binder page: pocket art rules; unfilled "any printing" shows Any pill |
| All three binder pickers use `preview`, never dimmed            | Binder page: all three pickers full opacity                           |

### `inventory-binders.md` §4 — Navigation / state-determinism issues

| Inventory item                                                            | FEATURES.md line                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Epoch-guarded mutations (slow create/delete doesn't rewrite URL)          | Binder page: slow mutation never rewrites URL                       |
| Per-binder state reset conditional (picked-up card doesn't carry over)    | Binder page: picked-up card doesn't carry to another binder         |
| `BinderPageToolbar` remount via key (page-jump reset)                     | Binder page: page-jump draft resets                                 |
| `BinderSpaceSearch` remount via key (search reset)                        | Binder page: space search resets on binder switch                   |
| Three `AbortController`s aborted on load/select/unmount                   | Binder page: internal URL updates never re-trigger a duplicate load |
| Selection does not survive plain navigation (only mutation/jump keeps it) | Binder page: selection in URL                                       |
| Deep-link vs library-list scroll/focus behaviour differs                  | Binder page: deep links restore scroll/focus                        |
| Hash echo suppression (`lastHash.current`)                                | Binder page: internal URL updates never re-trigger a duplicate load |
| Deleted-binder redirect race (re-parses current hash)                     | Binder page: delete-redirect race guarded                           |

### `inventory-binders.md` §5 — API endpoints used by the binder UI

| Inventory item                                                        | FEATURES.md line                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Version lifecycle (clone → draft → activate), no UI today             | Binder management: binder drafts clone/edit/activate/discard         |
| National Pokédex full insert with `regionPageBreaks`, no UI today     | Binder management: full 1,025 insert with region page breaks         |
| Explicit "add a page" (`addBinderPage`), no UI today                  | Binder management: an explicit "add a page" control (dropped)        |
| Bulk slot assignment (`setBinderSlots`), no UI today                  | Binder management: exposing bulk slot-assignment in the UI (dropped) |
| Per-binder shortages endpoint, no UI today                            | Binder management: a per-binder shortages screen (dropped)           |
| Arrangement modes `set-number`/`release-date`/`language`, no UI today | Binder management: multiple arrangement sort keys                    |

---

## Coverage note

`inventory-core.md` §5 (navigation/determinism problems), §6 (API endpoint table), and §7 (other UX
rough edges), and `inventory-binders.md` §6 (UX rough edges), are not required by the mapping table
above, but every concrete behaviour worth preserving or fixing from those sections was folded into a
checklist line above rather than dropped silently — for example the two-nav-mechanism split (Shell &
navigation), the four pagination idioms and duplicated response envelope (owned by the backend
workstream, not this checklist), the borrowed 1,025 cap message, the reserved-sleeve "remove" wording,
and the hand-rolled panel-positioning math (consolidated into the shared floating action bar).
