# Contributing

## Setup

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Build with `npm run build:release`.

## Pull Requests

- Keep changes source-first. Do not commit generated output from `out/`, `tmp/`, or release packages.
- Prefer small, reviewable pull requests.
- Update documentation when behavior or build steps change.

## Validation

- Run `npm run compile` for source changes.
- Run `npm run build:release` before packaging-related changes.
- GUI automation scripts are optional and Windows-specific.
