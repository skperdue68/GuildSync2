# ESO account rename implementation plan

**Goal:** Preserve one member across ESO account-name changes.
**Architecture:** Stable identities and unique aliases, canonical operational keys, immutable original-name fields and rename audit. Serialized transactional rename with conflict checks; canonicalized imports and alias-aware search.
**Spec:** ../specs/2026-11-15-eso-account-renames-design.md

- [x] Identity service: startup schema/backfill; strict name validation; preview counts/conflicts and signed actor/session-bound confirmation; atomic reference updates and immutable audit; rollback on failures. Test with real SQLite execution adapter plus lock simulation.
- [x] Ingestion and retrieval: canonicalize roster snapshots/events, banking, applications and link writes under same reentrant lock; aliases resolve old searches; retain original event names; rank restoration and note access use canonical account. Test old snapshots, replay idempotence, applications/banking and collision cases.
- [x] Socket: independently authorize effective approved Admin/User, deny Viewer and bot, bind actor/session from authentication, refresh affected data without automatic linking/promotion. Test permissions and forged/expired confirmations.
- [x] Both clients: member history rename form, preview/confirm/cancel, show conflicts, reset stale requests, rename history row and original-name display. Test parity, viewer restriction and stale callbacks; build both.
- [x] Review complete diff, run relevant tests and broader checks, document migration and rollout, commit feature branch and create production PR. Original GuildSync and VSCode checkout stay unchanged. Target repository is skperdue68/GuildSync2, on its Wails 3 implementation.

Review focus: pre-existing target records/aliases, concurrent rename/import, repeated or expired confirmation, old-name replay after restart, effective viewer/impersonation permissions and secret-free audit.

Verification: 559/559 GuildSync2 backend tests pass, including old-name ingestion, rollback, aliases across startup, expired/stale confirmations, Viewer denial, restricted-note count privacy, deferred onboarding and slow Sheets exports. The 18 Wails frontend/event/hotkey/version tests pass. Both the web production build and full Windows `wails3 build` pass; `go test ./...` and the Windows manifest test pass. SQL execution tests use a SQLite compatibility adapter; no production MariaDB/Discord/Google Sheets calls were made.

## GuildSync2 integration

Target GuildSync2 master 2.0.3, preserving Wails 3 services/bindings/runtime and profile controls. Validate with its pinned Node 24 dependencies, Go 1.26+, and Wails CLI/runtime v3.1.0. No Wails 2 generated bindings, version bump, deployment, or workflow-permission changes are part of this feature. The original GuildSync repository is outside the implementation scope.
