# Repository Asset Licensing

Unless a path is listed below or carries its own notice, repository source code and documentation source are licensed under [Apache License 2.0](./LICENSE).

## StudioJin brand assets — not Apache-2.0

The following paths contain the official SyncWatcher application icon, branded packaging artwork, marketing artwork, or product screenshots and demos:

- `src-tauri/icons/**`
- `src-tauri/resources/dmg/install-guide.png`
- `src-tauri/resources/dmg/install-guide@2x.png`
- `src-tauri/resources/dmg/install-guide.svg`
- `public/favicon.png`
- `manual/**`
- `docs/app-store-screenshots/**`

Copyright © 2026 StudioJin. All rights reserved.

These files may appear in the official SyncWatcher application and project documentation. They are not licensed under Apache-2.0 and may not be used to make a modified or redistributed build appear to be an official StudioJin release. Forks and derivative projects must provide their own name and application icon. See [TRADEMARKS.md](./TRADEMARKS.md).

Keeping these files in their existing locations avoids changing Tauri and Mac App Store packaging paths. Their location does not change their licensing status.

## Third-party and generic assets

- Tabler icons are supplied by `@tabler/icons-react` 3.46.0 under the MIT license. Source: <https://github.com/tabler/tabler-icons>.
- Generic UI styles, components, and source-authored interface assets not listed above are part of the Apache-2.0 Work.

Unused Gemini-generated images and unused Tauri, Vite, and React template logos were removed from the repository during the Apache-2.0 transition so that an unused asset does not create an unnecessary provenance or trademark burden.

No bundled font files are currently tracked in this repository.

Korean translation: [BRAND_ASSETS.ko.md](./BRAND_ASSETS.ko.md).
