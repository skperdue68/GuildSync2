# Match strength and sticky suggested-match search

Base: master after PR #119. Separate fix branch and ready PR; no production deployment.

- Reproduced the Suggested Matches heading sliding behind the sticky summary in a local browser. Wrap heading and search as one sticky unit, offset by the summary's measured height plus spacing; observe wrapping/resize changes and disconnect observers on rerender.
- Reuse the backend's 82% candidate threshold for presentation. Reserve fuzzy labels for 82â€“99%, exact for 100%, and show lower scores as low-similarity manual alternatives. Keep all accounts searchable/selectable without changing backend matching policy.
- Test boundaries, weak-name labels, grouping/search and sticky offset lifecycle before implementation; verify real scrolling at short desktop, normal desktop, tablet and phone sizes. Run frontend/backend tests, Go tests and Wails 3/web production builds; independent review before push.


Validation: 774 backend tests, 72 frontend tests, Go tests, Wails 3.1.0 desktop build and web build passed. Local Edge checks reproduced the original heading overlap and keyboard-selection overlap before fixes; corrected heading/search visibility and keyboard row bounds pass at 1811×600, 1811×694, 1024×768 and 390×844. Independent review found no remaining actionable issues. Keyboard scroll padding uses measured heights of both sticky sections and updates on resize/wrapping.
