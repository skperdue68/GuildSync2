# Discord Membership DMs Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline.

**Goal:** Officer-controlled, slowly paced Discord DMs with persistent responses and optional automatic ESO linking.

**Architecture:** Backend transactions persist campaign state, recipient history, preferences and a forwarding outbox. A bot worker claims one eligible delivery at a time, sends persistent buttons/modal forms, and forwards replies. Existing administration settings configure templates, destination, role and cooldown.

**Tech Stack:** Existing Node, MariaDB, Socket.IO and discord.js.

**Spec:** `outputs/Discord-membership-DM-design.md` in the task workspace, approved by user; amended to retain confirmed send dates and skip recent recipients without delaying the next eligible recipient.

## Constraints and review focus

- Persist alphabetic campaign order, last attempted and last successful recipient, and next scheduled attempt.
- Random delay 600–900 seconds between actual attempts; never introduce a delay for eligibility skips.
- Default repeat interval 30 days, configurable 1–365 days; recheck immediately before sending.
- Automatic linking requires an active unlinked roster match, preserves explicit link blocks and rejects conflicts. The result is a self-reported identity.
- Persist community preferences, safely forward replies, and keep buttons valid after restart.
- No real DMs, role changes, command deployment or production deployment during tests.

## Tasks

1. Add failing tests for the pure campaign engine, then implement alphabetical selection, cooldown, pacing, pause/resume and uncertain delivery handling in `membership-dms.js`. Persist JSON state atomically under the existing ESO identity lock.
2. Test and implement backend bot-only socket operations, officer command authorization, candidate selection, account-link checks and durable reply/forwarding events. Integrate state with existing onboarding to suppress competing reminders.
3. Test and implement `membership-dms.js` in the bot: persistent interaction routing, four buttons, modal text forms, typed DM handling, paced worker, configurable forwarding destination and optional community role.
4. Register `/discord-reminders` start/pause/resume/restart/status commands in source, add settings to the existing admin catalog, and document configuration and restart semantics.
5. Run affected suites, production builds and a fresh branch review. Present both ESO export and bot command locations and outstanding live smoke tests.

## Ledger

- User approved implementing the DM design, automatic active/unlinked roster matching and per-user repeat suppression. Default community behavior stores a preference; an optional configured role adds a label without removing access.
- Implemented the engine, transactional database persistence, authenticated bot RPC, six slash-command controls, four persistent buttons, modal and typed reply intake, durable forwarding/role retries, administrator settings and isolated test sends.
- Independent review fixes: pace from confirmed completion; persist inbound replies through backend outages; supersede stale role actions. Integration tests verify recipient authorization, ownership conflicts, automatic linking, cooldowns, restart persistence and test isolation. The existing onboarding reminder is suppressed for managed campaign recipients while promotions remain enabled.
- Validation before updating the branch base: complete backend suite 662/662, complete bot suite 226/226, plus the new competing-onboarding regression passed. Web production build passed. Final suites will be rerun against the merged ESO feature. No live DMs, role changes, slash-command deployment or production deployment were performed.
- Final validation after rebasing onto merged ESO PR #85 (`922d064`): backend 672/672, bot 226/226, Wails 3 version checks 3/3 and production web build passed. Both backend reminder initializers and socket registrations are retained. Added a dedicated Node 24 CI workflow for backend and bot regression suites.
