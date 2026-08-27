---
name: create-release
description: Create a signed Pokédex Scanner release and verify its GitHub, Homebrew, and installed-app consumer paths. Use when the user says "create a release", "new release", "cut a release", "ship it", or asks to publish the scanner.
---

# Create Release

Publish Pokédex Scanner through `.github/workflows/release.yml`. The workflow owns
the build, Developer ID signing, Apple notarization, DMG upload, quarantined-app
validation, and Homebrew cask update. Do not replace it with a manual release.

## Preconditions

Confirm before creating anything:

- The release targets a clean, current `main`.
- The intended commit and release tag are signed and verifiable.
- No release or tag already uses the proposed version.
- GitHub's `prod` environment contains:
  - `APPLE_ID`
  - `APPLE_TEAM_ID`
  - `APPLE_APP_PASSWORD`
  - `DEVELOPER_ID_CERTIFICATE`
  - `DEVELOPER_ID_PASSWORD`
  - `HOMEBREW_TAP_DEPLOY_KEY`
- The Homebrew deploy key is the dedicated Pokédex key; never substitute another
  app's key.

Publishing a release starts an outward-facing workflow. Get explicit release
authorization before creating the tag or GitHub release.

## Versioning

- Stable tag: `v{major}.{minor}`, for example `v0.2`.
- Beta tag: `v{major}.{minor}-beta.{n}`, for example `v0.2-beta.1`.
- The workflow stamps `{major}.{minor}.{github_run_number}` into the packaged app
  and preserves the beta suffix when present.
- The DMG is `pokedex-scanner-{tag without v}-aarch64.dmg`.
- For an ordinary feature release, increment the minor version.
- Never move, recreate, delete, or overwrite an existing release tag.

## Release flow

1. Confirm plain-Git state without modifying it:

   ```sh
   git branch --show-current
   git status --short
   ```

   Stop on a dirty tree or a branch other than `main`.

2. Bring `main` forward without rewriting it, then verify the resulting `HEAD`:

   ```sh
   git pull --ff-only
   git log -1 --show-signature --format=fuller
   ```

   Stop if the post-pull commit signature is not verifiable.

3. Inspect existing releases and changes:

   ```sh
   gh release list --repo GordonBeeming/pokemon --limit 10
   LAST_TAG=$(gh release list --repo GordonBeeming/pokemon --limit 1 --json tagName --jq '.[0].tagName')
   git log "${LAST_TAG}..HEAD" --oneline
   ```

   With no prior release, inspect `git log --oneline` instead.

4. Run the complete repository gate:

   ```sh
   pnpm check
   actionlint .github/workflows/release.yml
   ```

5. Create and verify a signed annotated tag, then push it:

   ```sh
   git tag -s v{version} -m "Pokédex Scanner v{version}"
   git tag -v v{version}
   git push origin v{version}
   ```

   A signing failure is a blocker. Never replace the signed tag with a lightweight
   or unsigned tag.

6. Publish the GitHub release using the existing tag. For a stable release:

   ```sh
   gh release create v{version} \
     --repo GordonBeeming/pokemon \
     --verify-tag \
     --title "Pokédex Scanner v{version}" \
     --notes-file /path/to/release-notes.md
   ```

   Add `--prerelease` for beta tags. Release notes must include:

   ```sh
   brew install --cask gordonbeeming/tap/pokedex-scanner
   ```

   Do not upload a locally built DMG. Publishing the release triggers the workflow.

7. Locate and watch the release run:

   ```sh
   gh run list --repo GordonBeeming/pokemon --workflow release.yml --limit 5
   gh run watch {run-id} --repo GordonBeeming/pokemon --exit-status
   ```

8. Require every release step to pass, especially:

   - Sign and verify app
   - Notarize and staple app
   - Create, sign, notarize, and validate DMG
   - Validate quarantined consumer installation
   - Upload release DMG
   - Update Homebrew cask

## Failed-run recovery

Fix workflow code through a normal signed PR with green CI. Do not move the
existing tag. After the fix reaches `main`, rebuild the immutable release source
through the workflow's manual dispatch:

```sh
gh workflow run release.yml \
  --repo GordonBeeming/pokemon \
  --ref main \
  -f tag=v{existing-version}
```

The dispatch definition comes from `main`, while checkout is forced to
`refs/tags/{existing-version}`. Never weaken that qualification to a bare ref.

## Consumer verification

After the workflow succeeds:

1. Confirm the release asset digest and remote cask SHA match.
2. Download the DMG back from GitHub and verify:
   - SHA-256
   - `codesign --verify --strict`
   - `xcrun stapler validate`
   - `hdiutil verify`
   - `spctl --assess --type open --context context:primary-signature`
3. Update Homebrew and install or upgrade:

   ```sh
   brew update
   brew install --cask gordonbeeming/tap/pokedex-scanner
   # Existing installation:
   brew upgrade --cask gordonbeeming/tap/pokedex-scanner
   ```

4. Verify `/Applications/Pokédex Scanner.app` with `codesign`, `stapler`,
   `gktool`, `spctl`, and `syspolicy_check distribution`.
5. Confirm the cask's `postflight` ran `gktool scan` so first launch does not show
   the generic internet-download approval prompt.

Do not launch the native app or capture keyboard/mouse focus without Gordon's
explicit GUI-automation opt-in.

## Report

Return the release URL, workflow URL, tag and merge signature status, asset
digest, Homebrew cask commit, installed app version, and consumer-validation
results. Do not call the release complete while the workflow, tap, or installed
app remains unverified.
