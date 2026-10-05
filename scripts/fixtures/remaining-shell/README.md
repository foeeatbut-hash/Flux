# Fixtures for the remaining shell and Play component check

`play-components.html` renders the repository's `LibraryTab`, `PrepareTab`,
`InvitePicker`, and `PartyBar` components. The fixture supplies synthetic users,
presence, lobby state, and callback handlers. The Playwright script presses the
real component buttons and checks callback calls, visible pending/error states,
and horizontal bounds at several viewport sizes and themes.

`start-menu.html` renders the repository's `StartMenu` with in-memory Zustand
stores and a test router. The script checks search, route navigation, pinning,
theme change, Escape, and the Home window action.

These fixtures do not mount `PlayScreen` or `App`, authenticate against an API,
or persist changes. They prove component behavior with supplied props and local
stores. Live Play pages, network recovery between two windows, Windows native
shell behavior, and the full application visual matrix need separate evidence.
