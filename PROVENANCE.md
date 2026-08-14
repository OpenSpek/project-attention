# Provenance and dependencies

Project Attention is original plugin code copyright Luke Westlake and developed in the OpenSpek project context with AI assistance.

## Included code and assets

- No third-party source code is copied into this repository.
- No third-party images, fonts, icons, binaries, or generated dependency bundles are included.
- The screenshot and preview are generated from Project Attention's own contained review harness.
- The plugin imports only public modules supplied by Hermes Desktop: `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`.
- The Python backend uses only Python's standard library plus FastAPI supplied by the Hermes plugin runtime.

## Runtime authority

Hermes Agent and Hermes Desktop are separate upstream projects and are not redistributed here. Project Attention uses their documented plugin and gateway APIs. Users must install Hermes separately under Hermes's own license and terms.

## Privacy and data handling

Project Attention has no telemetry and makes no third-party network requests. It reads local native Project metadata, stored-session mappings, workspace bindings, and bound Kanban state. Its SQLite access opens data in read-only URI mode and enables `PRAGMA query_only=ON`. It does not create, edit, move, assign, complete, block, or delete cards, Projects, sessions, or files.
