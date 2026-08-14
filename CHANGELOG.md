# Changelog

All notable changes to Project Attention are documented here.

## 0.2.1 — 2026-08-14

Initial public-release candidate.

- Adds one quiet Project-scoped status indicator for blocked/review attention.
- Keeps the indicator hidden when no current or background Project needs attention.
- Shows current-Project details first and background Project attention in a compact footer.
- Reveals the exact matched workspace folder through the supported Hermes Desktop API.
- Opens a background Project session only when one authoritative stored-session mapping exists.
- Uses read-only, fail-closed Project, session, folder, and Kanban matching.
