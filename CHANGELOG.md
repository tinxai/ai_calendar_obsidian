# Changelog

All notable changes to this plugin are recorded here. Entries below 1.3.0 were written by hand; from 1.3.0 on, [release-please](https://github.com/googleapis/release-please) generates them from [Conventional Commits](https://www.conventionalcommits.org/). Versions follow [Semantic Versioning](https://semver.org/), and each one has a matching GitHub release tag that Obsidian installs from.

## [1.7.0](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.6.1...1.7.0) (2026-10-09)


### Features

* expose an API to open the event modal from outside the calendar ([#14](https://github.com/PubCyBerry/obsidian-google-cal-sync/issues/14)) ([dc7b097](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/dc7b0970fe8fa5f2242320044143272f26d87bd6)), closes [#13](https://github.com/PubCyBerry/obsidian-google-cal-sync/issues/13)

## [1.6.1](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.6.0...1.6.1) (2026-10-09)


### Bug Fixes

* keep task mirroring from multiplying notes across devices ([#11](https://github.com/PubCyBerry/obsidian-google-cal-sync/issues/11)) ([6ad89f2](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/6ad89f2f46bc0b34f6f9bde325a143669507ddfc))

## [1.6.0](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.5.0...1.6.0) (2026-09-21)


### Features

* request the full calendar scope again, and drop the :has selector ([#7](https://github.com/PubCyBerry/obsidian-google-cal-sync/issues/7)) ([0b15480](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/0b15480e7ecfec5473d07a9617d39e17995d3ce2))

## [1.5.0](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.4.2...1.5.0) (2026-09-21)


### Features

* let the event modal edit the location ([#5](https://github.com/PubCyBerry/obsidian-google-cal-sync/issues/5)) ([ad1ed44](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/ad1ed444f275c13d5c112f78f2cf3d19c6563065))

## [1.4.2](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.4.1...1.4.2) (2026-09-20)


### Bug Fixes

* make the list view day headings readable ([3936eaa](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/3936eaacb4a6828b10dbeb6a3f87663e761e67a3))

## [1.4.1](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.4.0...1.4.1) (2026-09-20)


### Bug Fixes

* keep the phone list from scrolling sideways ([1407b1b](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/1407b1bab097962af50d165c30790a449377def2))

## [1.4.0](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.3.0...1.4.0) (2026-09-20)


### Features

* add a list view for phones ([7c2efd3](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/7c2efd3d5f2412e4d2374127a88cbdf7c28ee200))

## [1.3.0](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.2.0...1.3.0) (2026-09-18)


### Features

* keep the event location from Google ([0d21df9](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/0d21df983e4a88191ce730a80e97059eb02fc9ae))


### Bug Fixes

* keep the status pill from reflowing the toolbar ([caf333e](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/caf333e957fa67dd65121c44412ffe6ec658a849))
* redraw the settings tab while the browser login is pending ([e411a52](https://github.com/PubCyBerry/obsidian-google-cal-sync/commit/e411a5215c971bb30d36ececd99eda5a681eaef9))

## [1.2.0](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.1.0...1.2.0) (2026-09-11)

### Features

* **Sync passphrase** setting. The refresh token is now written to `data.json` encrypted with a key derived from the passphrase (PBKDF2-SHA256, AES-256-GCM), so vault sync carries only ciphertext. Each device keeps the passphrase in Obsidian's keychain and unlocks the login once; a device without it shows *Enter the sync passphrase* instead of the calendar and syncs nothing.
* The login is required to have a passphrase before it starts. A login stored by an earlier version keeps working in plain text and is encrypted as soon as a passphrase is set.
* Narrower Google permissions: `calendar.calendarlist.readonly` and `calendar.events` instead of the full `calendar` scope. A leaked token can no longer share, delete or reconfigure calendars. Existing users log in once more so the stored token carries the new scopes.

### Bug Fixes

* The loopback login page ignores requests that do not carry this login's `state` (answered 404) instead of cancelling the login, and Google's error code is sanitised before it is shown.

## [1.1.0](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.0.4...1.1.0) (2026-09-11)

### Features

* The calendar as its own pane: the ribbon calendar icon or the **Open calendar view** command opens it in the right sidebar, and its tab can be dragged into the main area.
* Setting **Hide midnight start times** (on by default). Events that start at 00:00 are drawn without a time, the way Google Calendar shows them.
* The calendar list (names, colours, new calendars) is refreshed once an hour during sync and saved only when something changed.
* Events have rounded corners. Multi-day bars stay square on the side where they continue into the previous or next week.

### Bug Fixes

* Calendar colours now match the Google Calendar apps. The API reports the classic palette (for example `#9fe1e7`); the plugin maps it to the modern one (`#039be5`). Custom colours pass through unchanged.
* Day numbers no longer wrap in narrow panes.

## [1.0.4](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.0.3...1.0.4) (2026-09-11)

### Bug Fixes

* Multi-day events were cut at the edge of their first day in reading view. Obsidian clips table cells; the stylesheet now lets the calendar's day cells overflow so the bars span their days.

## [1.0.3](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.0.2...1.0.3) (2026-09-11)

### Bug Fixes

* Multi-day events collapsed to a single cell when the block was drawn or refreshed in a hidden tab. FullCalendar measures column widths when it draws; the block now redraws or re-measures when it becomes visible.

## [1.0.2](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.0.1...1.0.2) (2026-09-11)

### Bug Fixes

* The desktop-only loopback server is typed locally so the community directory's lint sees no `any`. No behaviour change.

## [1.0.1](https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.0.0...1.0.1) (2026-09-11)

### Bug Fixes

* `LICENSE` is plain MIT again so it is recognised; the bundled FullCalendar notice moved to `THIRD_PARTY_NOTICES.md`.
* Date handling uses native helpers (`src/dates.ts`, with unit tests) instead of `moment`, removing the typing warnings raised by the directory's automated review.

## 1.0.0 (2026-09-11)

First release, published under the id `google-cal-sync` after the earlier ids `gcal-sync` and `gcal-block` turned out to be taken or were superseded.

### Features

* `gcal` code block with FullCalendar month, week and day views, every calendar in its Google colour, calendar and task toggles, a status pill, and an offline cache.
* Create, edit, move, resize and delete events. Writes go straight to Google; `If-Match` guards against overwriting a change made elsewhere (412 refreshes the event).
* Incremental sync with Google's sync tokens, a bounded first sync (three months back, six ahead) and automatic full resync on 410.
* Task notes (`type: Task`) in project folders mirrored to a Google Tasks list per project: title, due date and completion in both directions, imports from the Google Tasks app, moves between projects, deletions, and an `obsidian://` back-link in the task notes.
* Desktop loopback OAuth with PKCE and state check; token refresh on every platform; logout with revocation. Mobile reuses the desktop login through vault sync.
* Declarative settings tab, commands (`Log in to Google`, `Log out`, `Sync now`, `Clear cache`), unit tests, and in-app end-to-end scripts against a fake Google backend.
