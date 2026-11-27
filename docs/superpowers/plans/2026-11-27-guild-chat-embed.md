# Guild Chat embedded tab

User approved explicit `?embedded=1`, five-tab placement, compact embedded website, external-link destination without the parameter, and implementation after receiving reusable prompts. Work on codex/guild-chat-embedded-tab from master 98fef91.

1. Website: add a small head-loaded embedded-layout script. Only exact embedded=1 enables a root class. Move the existing Follow Newest and Refresh nodes into an initially hidden actions slot after Clear; leave standalone DOM/layout and app behavior untouched. Scope all compact/full-height styles to embedded mode. Tests cover opt-in, standalone no-op, node identity and deferred DOM readiness.
2. Clients: add a mirrored small Guild Chat panel module with fixed embed and external URLs, accessible iframe, desktop Wails 3 browser button, web safe new-tab anchor. Insert Guild Chat after roster, add chat icon, and update both navigation grids to five columns. Keep bank attention logic unchanged.
3. Preserve a mounted chat iframe during routine tab layout updates while still rendering application overlays in a separate host. Switching away destroys the frame normally. Ensure correct mobile viewport sizing. Tests cover external-link routing/failure, panel rendering, fifth-tab placement, and DOM preservation with overlays.
4. Browser QA: locally serve the actual archive with mocked API/socket data; verify standalone unchanged, embedded header absent, toolbar order/spacing, table fills frame, follow/refresh/search/date/permalink behavior and iframe persistence. Test desktop/tablet/phone layouts, external links and navigation. Run backend/bot/frontend suites, Go tests and Wails 3/web builds. Obtain independent review, push branch and ready PR; do not deploy or merge.

Ruling: use a tab-contained iframe panel rather than a blocking global dialog, matching the approved mockup and keeping navigation available. Use existing chat nodes instead of duplicated controls so handlers, follow preferences and live behavior remain shared.


## Completed implementation and validation

- Explicit embed mode hides branding/Live and moves original Follow/Refresh nodes after Clear. Standalone geometry matches the pre-change baseline; no changes to chat app logic or server API.
- Added Guild Chat third tab, compact blue external action, full-height iframe, accessible full tab labels and shorter mobile labels. External URLs omit embedded=1. Routine app renders preserve iframe DOM identity, filters and scroll while updating application overlays. Initial/restored views receive the same sizing setup.
- Kept the web client's uncapped coarse-pointer mobile policy; desktop retains its existing breakpoint policy. Phone and wide touch layouts keep archive content above app status and navigation.
- Validation: 786 backend tests, 84 frontend tests, 198 bot tests, Go tests, Wails 3.1.0 desktop build and web production build passed. Browser checks used mocked chat data only: standalone/embedded controls and filtering, identical standalone geometry, toolbar order, five tabs, iframe identity preservation, overlays and navigation at desktop/tablet/phone sizes; wide-touch 1280×900 also passed. No live messages, deployment or merge.
- Independent read-only review found no actionable issues. Native desktop compiled successfully; the iframe flows were exercised in a local Edge browser rather than an authenticated running native application.
