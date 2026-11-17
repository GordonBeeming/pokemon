# Repository workflow

Work directly in this repository's main checkout on `main`. This is an explicit
exception to the global `gb/...` branch and sprig worktree rules. Apply feature
work, fixes, tests, and documentation changes here without creating or switching
branches or worktrees.

After each completed batch of work, run the relevant checks and obtain an
independent review, then create a signed commit on `main`, push it, and deploy
the web app with any required database migrations. Verify the live deployment
before reporting the batch complete. This is standing authorization for those
steps in this repository; deliver completed work to the live app rather than
leaving it only in the local checkout.

Keep unrelated local changes intact and out of the batch's commit. The remaining
global rules, including secret handling and commit signing, still apply.

## Responsive usability checks

Every UI test plan and acceptance check must cover phone, tablet, and desktop.
For each batch affecting the UI or user flows, verify representative phone and
tablet sizes in both portrait and landscape, alongside desktop. Exercise the
affected tasks, including navigation, forms, dialogs, scrolling, and touch-sized
controls; check for clipping, unwanted horizontal overflow, and unreachable
actions. Automated UI tests must run the affected tasks at phone and tablet sizes
in portrait and landscape, as well as desktop, and assert that content fits and
actions remain reachable. Capture before-and-after screenshots at the affected
sizes, and fix usability failures on every supported layout before committing
and deploying.
