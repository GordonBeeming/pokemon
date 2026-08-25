# Pokédex Scanner

The desktop companion supports macOS 13 and later on Apple silicon and Intel. Its Tauri bundle targets are `app` and `dmg`; Linux and Windows artifacts are not supported.

Run the RustSec check through the target-aware package script:

```sh
pnpm audit:macos
```

The script compares the advisory report with Cargo's dependency trees for both supported macOS architectures. It excludes only packages absent from both trees, fails on applicable vulnerabilities and unsound warnings, and prints applicable unmaintained warnings. Run an unfiltered audit separately when evaluating a future platform expansion, and resolve its target-specific findings before adding that platform to the supported targets.
