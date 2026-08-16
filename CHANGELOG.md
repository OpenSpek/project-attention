# Changelog

All notable changes to Project Attention are documented here.

## 0.2.3 — 2026-08-16

- Shows every Project with blocked/review attention and omits Projects with zero attention.
- Removes the unsupported current/background distinction because Hermes Desktop v0.20.1 does not expose focused-session identity through the public plugin SDK.
- Keeps the supported calm amber status dot, aggregate actionable count, exact folder reveal, and fail-closed exact-session navigation.
- Replaces the stale active-Project regression with all-Project attention and no-current-claim coverage.

## 0.2.2 — 2026-08-15

- Uses Hermes's native active-Project identity before workspace fallback, preventing stale multi-tab workspace state from mislabeling the current Project.
- Uses the supported Hermes warning status-dot component so the calm amber dot renders reliably beside the actionable count.
- Adds regressions for stale workspace/session context and the packaged status-dot contract.

## 0.2.1 — 2026-08-14

Initial public-release candidate.

- Adds one quiet Project-scoped status indicator for blocked/review attention.
- Keeps the indicator hidden when no current or background Project needs attention.
- Shows current-Project details first and background Project attention in a compact footer.
- Reveals the exact matched workspace folder through the supported Hermes Desktop API.
- Opens a background Project session only when one authoritative stored-session mapping exists.
- Uses read-only, fail-closed Project, session, folder, and Kanban matching.
