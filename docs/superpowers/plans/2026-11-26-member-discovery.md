# Member names and history navigation

Implement on a separate branch stacked on PR #118; preserve desktop/web parity and Wails 3 builds.

1. Add a small mirrored member-discovery module with Discord display-name fallback, safe three-name markup with exact/fuzzy match emphasis, and a debounced history fallback controller. Test fallback precedence, HTML escaping, blank names, stale requests, current visible matches, no historical matches, and tab/session cancellation before implementation.
2. Use the name renderer for current link cards and Discord candidates, including the source Discord member when the candidate target is ESO. Add Display Name as the first sortable Discord table column; retain username/global/nickname columns and adjust empty-row span and responsive labels.
3. Connect roster/Discord search input to delayed historical lookup only while the current visible result list is empty and authenticated. Populate the existing history modal with the search and returned matches. Ignore late results after query, tab, session or modal changes.
4. Let the four main tabs dismiss Discord, roster and banking history modals, cancel their pending requests/timers, and navigate. Preserve blocking behavior for confirmation, editing and other dialogs. Keep tabs physically clickable above the history backdrop, including mobile.
5. Run meaningful behavior tests, browser checks for names/layout and tab click interception, frontend/backend suites, Go tests and Wails 3/web builds. Obtain independent review and publish a ready PR. No deployment or live messages.


## Implementation notes

- Completed name labels/highlights, first-column display name, history fallback and navigable history modals in both clients.
- Ruling: wait 700 ms after typing, verify the current visible list is empty, and reuse the authenticated existing history search APIs; populate their existing match lists without automatically choosing among ambiguous identities.
- Review finding resolved: retain lookup intent while member data loads, recheck after loading, and cancel on navigation/query/session/modal changes.
- Browser finding resolved: use content-sized suggestion grid rows; keep mobile history content scrollable above the bottom navigation.

- Final validation: 772 backend tests, 64 frontend tests, Go tests, Wails 3.1.0 desktop production build and web production build passed. Local browser checks at 1811×900, 1024×768 and 390×844 verified three names fit, matching nickname highlighted, visible history content and click-through main-tab navigation. Independent review finding resolved; no remaining actionable findings.
