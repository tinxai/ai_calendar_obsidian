# Calendar Planner for Obsidian

**Connect the work on your calendar to the goals on your planner.**

Calendar Planner combines a Google Calendar editor, one editable Excalidraw planning board, and an AI planning assistant inside Obsidian. It extends [Google Calendar Tasks Sync](https://github.com/PubCyBerry/obsidian-google-cal-sync), retaining its sync engine, MIT license, and attribution.

![Illustrated Calendar Planner overview: a seven-day calendar, compact autosaving event editor, and planning assistant below the calendar](docs/images/calendar-overview.png)

*Illustrated overview with fictional sample events. The image explains the layout and workflow; it is not a live screenshot.*

## Why use this version?

The main addition is a planning workflow: schedule your work, edit it quickly, and review how it supports your goals.

| Workflow | Google Calendar Tasks Sync | Calendar Planner |
| --- | --- | --- |
| Google Calendar and Google Tasks synchronization | Included | Retains the original sync engine |
| Moving through days | Navigate calendar periods | Continuous horizontal scrolling; seven days fit the pane |
| Event creation and editing | Event modal | Compact right-hand panel with autosave |
| Fast event actions | Calendar and modal controls | Copy/paste, cut, duplicate, Delete/Backspace, and a right-click color menu |
| Planning across time horizons | Calendar and task notes | One connected Excalidraw board for yearly, monthly, weekly, and interview plans |
| Weekly reflection | Review calendar and tasks yourself | Ask AI to compare plans with calendar completion evidence |

*Comparison refers to upstream v1.7.0, the base of this custom build. The original calendar/task synchronization remains the foundation.*

## From a yearly goal to this week's progress

![Illustrated workflow: connected yearly, monthly, weekly, and interview plans lead to an example AI weekly review supported by completed calendar events](docs/images/planning-workflow.png)

1. **Plan on one board.** Edit text, move cards, and connect related goals with arrows in Excalidraw.
2. **Schedule the work.** Select time blocks to create events; new events default to your personal calendar and green.
3. **Mark completed work.** Explicitly gray/Graphite-colored events are manual completion evidence under this planner convention.
4. **Ask for a review.** For example: “How did this week contribute to my yearly goals, and what should I prioritize next week?”

*The illustration uses fictional plans and an example AI response. Reviews use the evidence you provide; an elapsed calendar event alone is not proof that work was completed.*

## Get started

- [Build, installation, and the custom planning workflow](docs/calendar-planner.md)
- [Google Calendar and Tasks connection setup](docs/setup-guide.md)
- Calendar time range: **00:00–24:00**. Event time pickers use 15-minute AM/PM choices.
- Shortcuts: **Cmd/Ctrl+C**, **V**, **X**, **D** for copy, paste, cut, and duplicate; **Delete/Backspace** removes the selected event. Text fields retain normal editing behavior.

Your notes, planner content, calendar cache, and login credentials stay outside this source repository. The optional planning assistant uses your locally installed Codex CLI and existing login; AI requests run when you ask.

---

# Google Calendar Tasks Sync

A `gcal` code block that turns into your **Google Calendar** (all calendars, month/week/day, create/edit/drag/delete), plus **task notes mirrored to Google Tasks** so they show up as checkboxes in the Google Calendar app on your phone.

- One code block, every calendar, each in its own Google colour.
- Create, edit, move, resize and delete events. Changes go straight to Google; Google is the source of truth for events.
- Task notes (`type: Task` frontmatter) inside project folders are mirrored to a Google Tasks list per project. Title, due date and completion sync both ways; Obsidian is the source of truth for tasks.
- Also available as its own pane: the ribbon icon or the **Open calendar view** command opens it in the right sidebar, and you can drag it into a tab.
- Log in once on desktop; phones and tablets reuse that login through your vault sync. No login screen on mobile. The login travels encrypted: each device unlocks it once with a passphrase you choose.
- Offline: the last synced state is drawn from a per-device cache.

## Documentation

- [Setup guide](docs/setup-guide.md): first-time walkthrough from Google Cloud to your phone, with troubleshooting.
- [Architecture](docs/architecture.md): C4 context, containers and components, runtime flows, data, decisions.
- [Changelog](CHANGELOG.md): what changed in each release.

## Setup

You bring your own Google Cloud OAuth client, so nothing goes through a third-party server. The short version follows; the [setup guide](docs/setup-guide.md) has every click.

1. In [Google Cloud Console](https://console.cloud.google.com/) create or pick a project, then enable **Google Calendar API** and **Google Tasks API**.
2. Under **Google Auth Platform**, configure the consent screen (External), add yourself as a test user, and add the scopes `https://www.googleapis.com/auth/calendar` and `https://www.googleapis.com/auth/tasks`.
3. Create an OAuth client of type **Desktop app**. Copy its Client ID and Client secret.
4. In Obsidian → Settings → Google Calendar Tasks Sync, paste both values, set a **Sync passphrase** (it encrypts the login before it is written to disk) and click **Log in to Google**. A browser window opens; approve both permissions. The browser returns to `http://127.0.0.1:<port>` and the plugin stores the encrypted refresh token.
5. Put a code block in any note:

   ````markdown
   ```gcal
   view: month
   ```
   ````

6. Publish the consent screen (Audience → Publish app). Refresh tokens issued while the app is in *Testing* expire after 7 days. Log in once more after publishing.

### Code block options

| Option      | Values                                   | Default | Meaning                                                                 |
| ----------- | ---------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `view`      | `month`, `week`, `day`, `list`           | `month` | Initial view. Phones always open on the list                            |
| `height`    | CSS length or `auto`                     | `auto`  | Calendar height                                                         |
| `calendars` | list of calendar ids                     | `[]`    | Empty follows the toggles in settings; a list pins those calendars only |
| `tasks`     | `true`, `false`                          | `true`  | Draw task notes on their due date                                       |

### Task mirroring

Task notes live in `<projects folder>/<project>/tasks/*.md` (projects folder defaults to `10-projects`) and need this frontmatter:

```yaml
---
type: Task
title: Write the README
status: active        # backlog | active | blocked | done
due: 2026-09-15       # optional, YYYY-MM-DD
google_task_id:       # filled by the plugin
---
```

- Each project folder gets a Google Tasks list with the project's name.
- `status: done` ↔ completed. Any other status is *needs action*; completing a task on the phone sets the note to `done`, and un-completing a `done` note sets it to `backlog`.
- Title, due date and completion merge field by field: a field changed on only one side since the last sync takes that side, so completing a task on the phone while another device moves its due date keeps both changes. A field changed on both sides goes to the newer one.
- A task added in a Google app appears as a new note in that project's `tasks/` folder with `status: backlog`. Whatever you wrote in the task's notes stays there, below the link back to the note.
- Deleting a note deletes the Google task. Deleting a task in Google (instead of completing it) makes the plugin re-create it from the note. Both wait about ten minutes first, because vault sync may still be delivering a rename or a deletion from another device.
- Moving a note to another project moves the task to that project's list.
- Only `title`, `due`, `status` and `google_task_id` are ever written to a note; bodies and other properties are left alone. Google's task notes field starts with an `obsidian://` link back to the note.

Every device runs the mirror, so it is built for devices that see each other's notes a few minutes late:

- A task whose notes start with that `obsidian://` link came from a note on some device. A device that does not have the note yet waits for vault sync and never imports the task as a second note.
- When two notes claim one task (a sync conflict copy, or a note you duplicated), every device mirrors the same one, the note the task links back to. The others are listed in a notice: delete the copy, or clear its `google_task_id` to make it a task of its own.
- `Clear cache` empties the event cache only. The record of which note owns which task is kept.

Turn mirroring off in settings and the Google Tasks API is never called.

### Display

Calendar colours follow the Google Calendar apps (the API reports the classic palette; the plugin maps it to the modern one you see on the web and phone) and are refreshed once an hour. Events that start at 00:00 are drawn without a time, like Google does; turn **Hide midnight start times** off in settings to show it.

### Commands

`Log in to Google` (desktop only), `Log out`, `Sync now`, `Clear cache`, `Open calendar view`.

### API for scripts and other plugins

`app.plugins.plugins['google-cal-sync'].api` opens the calendar's own event modal from anywhere, for example a `dataviewjs` block that lists today's events. Both calls resolve when the modal closes; saving or deleting there updates Google and the cache and redraws every calendar, exactly as a click in the calendar does.

```js
const api = app.plugins.plugins['google-cal-sync'].api;
// Edit an event from this device's cache (local storage key `google-cal-sync:<calendarId>`).
await api.openEvent('primary', eventId);
// New event: all-day when `start` is left out; `end` defaults to an hour after `start`.
await api.createEvent({ date: '2026-10-15', start: '09:30', end: '10:30', calendarId: 'primary' });
```

`openEvent` rejects when the cache has no such event, and `createEvent` rejects a malformed date or time or an unknown calendar. A device that cannot show the calendar (no client, not logged in, locked) shows the same message in a notice and opens nothing. The types are in [`src/api.ts`](src/api.ts).

## Mobile

Obsidian Mobile cannot run the local login server, so log in on desktop. The encrypted refresh token is stored in this plugin's `data.json`, which your vault sync (Obsidian Sync, iCloud, Syncthing, …) carries to the other devices. On each of them, enter the same sync passphrase once in the plugin settings and press **Unlock**; from then on the plugin refreshes the access token by itself. If a device shows "Log in on desktop", its `data.json` has not arrived yet; if it shows "Enter the sync passphrase", it has arrived and is waiting for the passphrase.

## Network use and data storage (please read)

- Calendar and task synchronization talks to Google: `accounts.google.com` and `oauth2.googleapis.com` for OAuth, `www.googleapis.com/calendar/v3` for events, and `tasks.googleapis.com/tasks/v1` for tasks.
- The optional planning assistant invokes the locally installed Codex CLI only when you ask. It sends planner text/connections, current-week calendar evidence and recent chat to OpenAI using your existing local login. There are no background AI reviews and no telemetry. Login credentials are never included in this repository.
- Permissions requested from Google: `calendar` (your calendars and their events) and `tasks`. The plugin itself only lists calendars and reads and writes events and tasks; it never calls the sharing, settings or calendar-deletion endpoints.
- Your OAuth client ID and client secret are stored in plain text in `.obsidian/plugins/google-cal-sync/data.json`. Google does not treat the secret of a desktop app as confidential, and both are needed on every device to refresh the access token.
- The **refresh token is stored encrypted in the same file**, with a key derived from your sync passphrase (PBKDF2-SHA256, 600,000 iterations, AES-256-GCM). Your vault sync therefore carries only ciphertext. Each device keeps the passphrase in Obsidian's keychain (Settings → Keychain, encrypted by the operating system) and decrypts the token into memory only. A login stored by a version before 1.2.0 stays in plain text until you set a passphrase; the settings tab tells you so.
- Calendar events are cached per device in Obsidian's local storage (not in notes). `Clear cache` removes it; `Log out` revokes the token at Google and removes it too. If you suspect a copy of `data.json` leaked together with the passphrase, remove the app under [Third-party apps & services](https://myaccount.google.com/connections) in your Google account, which invalidates the token immediately.
- Requests per sync: one per enabled calendar (incremental with Google's sync tokens) and one per project task list, plus one request per change you make.

## Development

```bash
npm install
npm run dev     # watch build to main.js
npm run build   # type check + production build
npm run lint    # eslint with eslint-plugin-obsidianmd
npm test        # unit tests (node:test)
```

Symlink or copy the repository folder to `<vault>/.obsidian/plugins/google-cal-sync/`. FullCalendar (MIT) is bundled into `main.js` and loaded lazily when the first code block renders, so it does not add to app start time.

## Compatibility

| Plugin | Obsidian |
| ------ | -------- |
| 1.x    | 1.13.7+  |

## License

MIT. FullCalendar (MIT) is bundled; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
