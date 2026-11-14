# Adding unofficial fan-art cards

Create these through the authenticated custom-card API. They start private to the signed-in account; follow [Make the cards global](#make-the-cards-global) when they should be available to every account. Catalogue syncs leave custom cards alone.

The unofficial marking is stored in the card name, set ID, set name, and rarity. There is no separate fan-art flag or badge. Keep the words `Unofficial fan art` in the name so the distinction survives card pickers, search, and detail views.

## Prepare the card and images

1. Compare the physical card's artwork, name, collector number, and printed credit with the source image. Confirm that it is unofficial before labelling it. A matching name alone is insufficient.
2. Search the catalogue for the species and collector number, including existing custom cards. Reuse a matching entry rather than creating a duplicate: `POST /api/catalogue/custom` generates a new ID every time.
3. Find an image of the exact design, or ask for a separate photograph. Record the listing and image URLs. Do not regenerate the artwork or substitute an official printing. If cropping or another substitute is needed, agree that with Gordon first.
4. Prepare high- and low-resolution WebP files. The upload endpoint requires complete WebP files, at most 15 MiB each. These commands preserve the source photograph, with a smaller copy for the gallery:

```sh
cwebp -quiet -q 90 /absolute/source.jpg -o /absolute/card-high.webp
cwebp -quiet -q 85 -resize 300 0 /absolute/source.jpg -o /absolute/card-low.webp
```

Catalogue creation does not add an owned copy. Only update quantities or binder assignments when requested.

## Connect with Browser's CLI

This uses the [Browser application](https://github.com/bradystroud/browser), whose CLI controls its own agent pages. It is separate from Chrome, Computer Use, and the Codex Browser plugin.

```sh
browser --help
browser page help
browser page list --json
browser page open https://pokedex.gordonbeeming.com \
  --profile Personal --headless --wait-idle --timeout 20000 --json
```

Use the returned page ID in subsequent commands; the examples below use `p4`. Agent pages share the chosen profile's sign-in. If authentication is needed, use `browser page show p4` and let Gordon complete the passkey flow. A normal Browser tab in the same profile can also establish the session.

Troubleshooting from this run:

- A dangling `/opt/homebrew/bin/browser` link pointed into a missing app. `brew reinstall --cask bradystroud/tap/browser` restored Browser 0.1.3 and the CLI.
- `browser --help` initially hung before reaching application code. A process sample showed `_dyld_start`; `syspolicyd` reported `Prompt shown ... waiting for response`. Gordon approved the normal first-launch Open prompt. Help then completed in 0.04 seconds. Do not strip quarantine or disable Gatekeeper to work around this.
- If the CLI reports no running instance, launch Browser. `open -gj /Applications/Browser.app` starts it in the background.
- If `page list` reports that agent control is off, ask Gordon to enable **Settings > Privacy > Agents**. The CLI cannot enable that setting.
- Native Computer Use and its Chrome connection were unavailable in this session. Browser's CLI worked independently.

Follow the current session's GUI permission rules before opening or controlling visible windows. The headless agent pages used here did not take keyboard or mouse focus.

## Create labelled catalogue entries

Execute API calls inside the signed-in page with `browser page eval`. This uses the existing session without exporting its cookies. Check both the HTTP status and the JSON `ok` field after every request.

Search first:

```sh
browser page eval p4 'return await (await fetch("/api/catalogue/search?q=" + encodeURIComponent("Unofficial fan art") + "&limit=100")).json();' --json
```

Create one card with `POST /api/catalogue/custom`, `content-type: application/json`, and a body such as:

```json
{
  "name": "Mimikyu ex (Unofficial fan art)",
  "language": "en",
  "category": "pokemon",
  "setId": "unofficial-fan-art-055",
  "setName": "Unofficial fan art (055-card series)",
  "number": "052/055",
  "numberSort": 52,
  "supertype": "Pokémon",
  "subtype": "Basic",
  "species": "Mimikyu",
  "rarity": "SAR (unofficial)",
  "artist": "WCS TYDS"
}
```

Use a distinct set ID for a different unofficial series. `055-card series` describes the printed denominator; it is not a verified official set title. `WCS TYDS` transcribes the printed credit and does not verify the artist's identity. Leave unknown metadata unset rather than guessing it.

Save each returned `id` before uploading. If a request times out, search again before retrying creation. The current `createCustomCard` implementation accepts `pokedexNumber` through its request schema but does not persist it; do not claim that these entries have a National Pokédex number mapping.

## Authorise artwork uploads

The browser session can create custom cards, but artwork uploads require an uploader credential. Get any approval required by the active tool policy before creating one. In this run Gordon approved a temporary credential with exactly `art:read` and `art:write`.

Keep the pair code, bearer token, and upload tickets in page memory. Never print them, put them in shell arguments, save them in the repo, or include them in a report. When an existing secret must be retrieved, use the 1Password skill and its `op whoami` check.

Inside the signed-in page:

1. `POST /api/desktop/pair` with `{"scopes":["art:read","art:write"]}`. Retain the returned `code` privately.
2. `POST /api/desktop/pair/redeem` with that code and a descriptive `label`, such as `Temporary fan-art upload`. Retain the returned `token` privately.
3. Compute the token's SHA-256 hex digest with `crypto.subtle.digest`. This is the credential ID used by the revocation endpoint. Keep it available for cleanup even if an upload fails.

Use a `try/finally` around the upload work so cleanup also runs on failure. A redeemed uploader credential has a normal 90-day maximum lifetime; calling it temporary does not shorten that lifetime. Revocation is required.

## Upload and verify both image sizes

For each card and each variant (`high`, then `low`):

1. Load the WebP bytes into page memory and compute their SHA-256 hex digest.
2. Request a ticket with `POST /api/desktop/art/upload-tokens`, bearer authentication, and this body:

   ```json
   {
     "cardId": "<returned custom card ID>",
     "variant": "high",
     "sha256": "<SHA-256 of the complete WebP file>",
     "maxBytes": 530820,
     "onlyIfMissing": true
   }
   ```

   Replace `maxBytes` with the actual file size. Keep `onlyIfMissing: true` so reruns do not replace existing art.

3. `PUT` the raw WebP bytes to the returned `uploadPath`, with `content-type: image/webp` and `authorization: Bearer <ticket token>`. The ticket token is different from the uploader credential.
4. Read `/api/art/<cardId>/<variant>` using the signed-in session. Hash the returned bytes and compare them with the local file's hash. A successful upload response alone is insufficient.

Browser's file chooser command failed in this run with `The click opened no file chooser`, even when targeting a file input. The working transfer used a local Python process to read each file, base64-encode it, and send chunks through the CLI. This avoids operating-system argument size limits:

```python
import base64
import json
import pathlib
import subprocess

def evaluate(page_id, code):
    result = subprocess.run(
        ["browser", "page", "eval", page_id, code, "--json"],
        capture_output=True, text=True, timeout=40, check=True,
    )
    response = json.loads(result.stdout)
    if not response.get("ok"):
        raise RuntimeError("Browser evaluation failed")
    return response.get("value")

page_id = "p4"
payload = base64.b64encode(pathlib.Path("/absolute/card-high.webp").read_bytes()).decode()
evaluate(page_id, 'globalThis.__fanArtBytes = ""; return {ok:true};')
for offset in range(0, len(payload), 48000):
    chunk = json.dumps(payload[offset:offset + 48000])
    evaluate(page_id, 'globalThis.__fanArtBytes += ' + chunk + '; return {ok:true};')
```

Then decode in the page with `Uint8Array.from(atob(globalThis.__fanArtBytes), c => c.charCodeAt(0))` and perform the ticket, PUT, and read-back steps above. Clear the base64 string after decoding. The chunks contain image bytes only; the uploader credential stays in page memory. Do not reload or navigate that page while it holds the credential.

## Revoke access and check the app

1. `DELETE /api/desktop/tokens/<credential SHA-256 hex digest>` using the signed-in browser session. Verify HTTP success and `ok: true`.
2. Try an upload-ticket request using the revoked credential. It must return HTTP 401 with `desktop_token_invalid`.
3. Remove the credential, pair code, ticket tokens, and image buffers from page memory. Close or reload the page only after revocation has succeeded. If cleanup fails, retain the credential ID and revoke the matching entry through Settings before reporting completion.
4. Search the catalogue again. Confirm the expected count, collector numbers, full unofficial names, set labels, `manual` source, and both artwork URLs through `GET /api/catalogue/<id>`.
5. Open each card's detail view. Check that its artwork loads and its unofficial label is visible. Capture before/after screenshots and report them. Record any failures separately from completed uploads.

The gallery shows the custom set code (`UNOFFICIAL-FAN-ART-055`) beneath the artwork. Full names and the readable set name appear in card details. These labels are data, not an image watermark.

## Make the cards global

Custom-card creation has no sharing option. The catalogue, artwork, collection, and binder readers already treat `catalogue_cards.owner_id = NULL` as shared, so a global printing keeps the same card ID and artwork. Quantities, notes, and binder placements remain scoped to each account.

Use [global-fan-art.sql](../apps/web/repairs/global-fan-art.sql) for the two cards recorded below. It matches their exact IDs, names, set, language, and collector numbers, requires both artwork sizes, adds an active `fan-art` source using the high-resolution artwork checksum, and clears their catalogue owner. It leaves `is_custom = 1` so catalogue sync cannot retire them. A rerun leaves already-published rows unchanged.

Deploy the backup restore guard in `apps/web/src/worker/lib/backup.ts` before applying the SQL to a shared environment. Without it, restoring a user backup can claim an ownerless custom card and make it private again. The guard preserves cards with an existing active `fan-art` source, including when the backup was taken before publication. Restoring a card absent from the target database still creates a private custom card; a backup restore cannot publish a new global printing.

Apply changes in this order:

1. **Dev:** run the repair and backup tests against isolated local databases:

   ```sh
   pnpm --dir apps/web test src/worker/lib/global-fan-art.test.ts src/worker/lib/backup-restore.test.ts
   ```

   Check that a second account can search, resolve, and read the two cards' artwork manifests; its quantities and notes are independent; other private cards stay hidden; and restore keeps the published cards shared.

2. **UAT:** if a UAT deployment exists, deploy the restore guard there first. Gordon runs the SQL in that environment's database console and checks the results before production. The repository currently configures local development and one production D1 binding; it has no UAT binding. Do not treat production as UAT.

3. **Production:** after the code has passed review and been deployed, Gordon runs `apps/web/repairs/global-fan-art.sql` in **Cloudflare dashboard > Workers & Pages > D1 > pokedex > Console**. This database is SQLite/D1, so SSMS does not connect to it. Follow the shared-environment SQL rule: provide the committed file for Gordon to execute; do not run remote SQL from a local runner without an explicit override of that rule.

The SQL's final query should return exactly two rows with `owner_id = NULL`, `is_custom = 1`, `provider = fan-art`, and the existing high- and low-resolution art checksums. Refresh the catalogue under a second account and search `Unofficial fan art`. Open both detail views and check the artwork and labels. Only then report that global publication is complete.

For future additions, prepare a separate reviewed SQL file matching the new cards' returned IDs and verified metadata. Create the active `fan-art` source before clearing ownership. Do not bulk-publish by species, an ID prefix, or the unofficial set name alone. Global publication exposes the printing's name, metadata, and artwork to every signed-in account.

## Cards added on 14 November 2026

Both cards were added to the production catalogue under the signed-in account. Their owned quantities and binder assignments were left unchanged. The global-promotion SQL is prepared separately; its presence in the repo does not mean it has been applied.

| Card                                 | Number  | Catalogue ID                                  |
| ------------------------------------ | ------- | --------------------------------------------- |
| Mimikyu ex (Unofficial fan art)      | 052/055 | `custom_4c705272-b14d-4dfc-adf9-9cfbb8e76f91` |
| Snorlax (Batman, Unofficial fan art) | 027/055 | `custom_f9c57bdb-852c-4cab-9e55-73c79901d4ae` |

Sources used:

- Mimikyu: [listing](https://www.ebay.com/itm/800842612466), [source image](https://i.ebayimg.com/images/g/uLkAAeSw9tNq4Ab6/s-l1600.jpg).
- Snorlax: [listing](https://www.ebay.com/itm/158213778531), [source image](https://i.ebayimg.com/images/g/FDcAAeSw7zhqiP0n/s-l1600.png).

These are listing photographs of the matching cards, including their backgrounds and foil reflections. No artwork was generated or taken from an official printing.

All four uploaded WebP files passed SHA-256 read-back checks. The temporary uploader credential was revoked, and a subsequent request with it returned `desktop_token_invalid`.
