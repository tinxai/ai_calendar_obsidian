# Architecture

A [C4](https://c4model.com/) description of Google Calendar Tasks Sync: context, containers, components, the two runtime flows that matter, the data it owns, and the decisions behind the shape. Diagrams are Mermaid and render on GitHub and in Obsidian.

## Level 1: System context

Google Calendar Tasks Sync is a plugin inside Obsidian. It talks to Google on the user's behalf with an OAuth client the user created, and it relies on whatever already synchronises the vault to carry one file between devices.

```mermaid
C4Context
    title Google Calendar Tasks Sync in context
    Person(user, "Vault owner", "Edits events and task notes on desktop and phone")
    System(plugin, "Google Calendar Tasks Sync", "Obsidian plugin: calendar code block and task mirroring")
    System_Ext(gauth, "Google OAuth 2.0", "accounts.google.com, oauth2.googleapis.com")
    System_Ext(gcal, "Google Calendar API v3", "Source of truth for events")
    System_Ext(gtasks, "Google Tasks API v1", "Mirror of task notes")
    System_Ext(sync, "Vault sync", "Obsidian Sync, iCloud, Syncthing, ... copies .obsidian/plugins/google-cal-sync/data.json")
    System_Ext(gapps, "Google Calendar / Tasks apps", "Where the phone shows mirrored tasks")

    Rel(user, plugin, "Reads the calendar, creates and drags events, ticks tasks")
    Rel(plugin, gauth, "Loopback login with PKCE (desktop); refresh token → access token (all devices)", "HTTPS")
    Rel(plugin, gcal, "calendarList, events.list with syncToken, insert/patch/delete", "HTTPS")
    Rel(plugin, gtasks, "tasklists, tasks list/insert/patch/delete/move", "HTTPS")
    Rel(plugin, sync, "data.json written only on login, logout, settings, toggles")
    Rel(user, gapps, "Completes or adds tasks on the phone")
    Rel(gapps, gtasks, "")
```

Trust boundary: everything the plugin stores stays on the user's devices and in the user's own Google account. There is no server operated by the plugin author.

## Level 2: Containers

The same `main.js` runs in two hosts. The only host-specific piece is the loopback HTTP server, which exists solely during a desktop login.

```mermaid
C4Container
    title Containers on one device
    Person(user, "Vault owner")
    System_Boundary(obsidian, "Obsidian (Electron on desktop, Capacitor on mobile)") {
        Container(main, "main.js", "TypeScript bundled by esbuild", "Plugin code plus FullCalendar v6, loaded lazily on first code block")
        Container(loopback, "Loopback server", "Node http, desktop only", "Receives Google's redirect on http://127.0.0.1:<port> for one login")
        ContainerDb(datajson, "data.json", "JSON in the plugin folder", "Client id/secret, refresh token encrypted with the sync passphrase, calendar toggles, project→list map, settings")
        ContainerDb(keychain, "Obsidian keychain", "app.secretStorage, per vault, per device, OS-encrypted", "Sync passphrase")
        ContainerDb(local, "localStorage", "Per vault, per device", "Event cache and syncToken per calendar; previous task id→path map")
        ContainerDb(notes, "Task notes", "Markdown with frontmatter", "type: Task under <projects>/<project>/tasks/")
    }
    System_Ext(google, "Google APIs")
    System_Ext(browser, "System browser", "Google consent page")

    Rel(user, main, "gcal code block, settings tab, commands")
    Rel(main, loopback, "starts, waits for ?code&state, stops", "desktop only")
    Rel(browser, loopback, "redirect after consent", "HTTP 127.0.0.1")
    Rel(main, google, "requestUrl", "HTTPS")
    Rel(main, datajson, "loadData / saveData")
    Rel(main, keychain, "getSecret / setSecret")
    Rel(main, local, "app.loadLocalStorage / saveLocalStorage")
    Rel(main, notes, "metadataCache read, processFrontMatter write, create, rename")
```

Why three stores: `data.json` is copied between devices by vault sync, so it holds what every device needs (the login) and is written as rarely as possible to avoid conflict copies. The refresh token inside it is ciphertext; the passphrase that unlocks it never travels and sits in each device's keychain, which Obsidian encrypts with the operating system (Electron `safeStorage` on desktop, the iOS/Android secure store on mobile). The event cache changes on every sync and is device-local, so it lives in localStorage and never travels.

## Level 3: Components

One file per responsibility inside `src/`. Arrows are compile-time dependencies.

```mermaid
C4Component
    title Components inside main.js
    Container_Boundary(main, "main.js") {
        Component(plugin, "main.ts · GCalSync", "Plugin", "Loads settings, registers block/commands/settings tab, owns the sync loop, throttles and deduplicates syncs, publishes change notifications")
        Component(settings, "settings.ts", "PluginSettingTab (declarative)", "Settings schema, defaults, tolerant loader, settings UI")
        Component(auth, "auth.ts · Auth", "OAuth", "PKCE, state, loopback server (desktop), token exchange, refresh with single-flight, logout with revoke; seals and unlocks the stored refresh token with the passphrase")
        Component(cryptomod, "crypto.ts", "WebCrypto", "base64url, random tokens, SHA-256 for PKCE; PBKDF2-SHA256 → AES-256-GCM for the stored refresh token")
        Component(google, "google.ts · GoogleClient", "HTTP", "requestUrl wrapper: bearer token, one retry after 401, errors as GoogleError(status)")
        Component(calendar, "calendar.ts · CalendarSync", "Domain", "calendarList; events.list full or incremental; 410 → full; insert/patch(If-Match)/delete; keeps the cache current")
        Component(tasks, "tasks.ts · TaskMirror", "Domain", "Collects task notes, pairs them with Google tasks by id, applies field-owner rules, imports, deletes, moves")
        Component(cache, "cache.ts · Cache", "Storage", "Typed access to localStorage entries")
        Component(view, "view.ts · GCalBlock", "MarkdownRenderChild", "Parses block options, renders toolbar and FullCalendar, maps cache+notes to events, handles select/click/drag, redraws when the block becomes visible")
        Component(pane, "pane.ts · GCalView", "ItemView", "The same block inside a workspace leaf (sidebar or tab)")
        Component(colors, "colors.ts", "Table", "Classic → modern Google calendar palette")
        Component(fc, "fc.ts", "Lazy module", "Re-exports FullCalendar core, dayGrid, timeGrid, interaction, locales")
        Component(modal, "modal.ts · EventModal", "Modal", "Create/edit/delete one event; validates title and range")
        Component(api, "api.ts · plugin.api", "Public API", "openEvent / createEvent for scripts and other plugins: checks input, opens EventModal, resolves on close")
    }
    Rel(plugin, settings, "")
    Rel(plugin, auth, "")
    Rel(plugin, google, "")
    Rel(plugin, calendar, "sync per calendar")
    Rel(plugin, tasks, "sync")
    Rel(plugin, cache, "")
    Rel(plugin, view, "registers block")
    Rel(plugin, pane, "registers view")
    Rel(pane, view, "embeds")
    Rel(plugin, colors, "on calendarList refresh")
    Rel(view, fc, "await import()")
    Rel(view, modal, "opens")
    Rel(plugin, api, "exposes")
    Rel(api, modal, "opens")
    Rel(api, view, "blockedMessage")
    Rel(view, calendar, "patch on drag/resize")
    Rel(modal, calendar, "insert / patch / remove")
    Rel(calendar, google, "")
    Rel(calendar, cache, "")
    Rel(tasks, google, "")
    Rel(tasks, cache, "task index")
    Rel(google, auth, "token(force?)")
    Rel(auth, cryptomod, "")
```

| Component | Depends on Obsidian for | Depends on Node for |
| --- | --- | --- |
| `auth.ts` | `requestUrl`, `Platform`, `App.secretStorage` | `http` (only inside `Platform.isDesktop`) |
| `crypto.ts` | nothing (`crypto.subtle`, `btoa`/`atob`) | nothing |
| `google.ts` | `requestUrl` | nothing |
| `calendar.ts`, `cache.ts` | `App.loadLocalStorage/saveLocalStorage` | nothing |
| `tasks.ts` | `Vault`, `MetadataCache`, `FileManager.processFrontMatter/renameFile` | nothing |
| `view.ts`, `modal.ts`, `pane.ts`, `api.ts` | `MarkdownRenderChild`, `ItemView`, `Modal`, `Setting`, `Notice`, `getLanguage`, `parseYaml` | nothing |

Everything except the loopback server therefore runs unchanged on mobile, which is what lets `isDesktopOnly` be `false`.

## Runtime views

### Login (desktop, once)

```mermaid
sequenceDiagram
    actor U as User
    participant S as Settings tab
    participant A as Auth
    participant L as Loopback :port
    participant B as Browser
    participant G as Google OAuth
    participant K as Keychain
    participant D as data.json

    U->>S: Sync passphrase → Set
    S->>K: setSecret(passphrase)
    U->>S: Log in to Google
    S->>A: login()
    A->>K: getSecret(passphrase), refuse without one
    A->>A: verifier, S256 challenge, state
    A->>L: listen 127.0.0.1:0
    A->>B: window.open(auth URL with challenge, state, access_type=offline, prompt=consent)
    B->>G: consent
    G-->>B: 302 http://127.0.0.1:port/?code&state
    B->>L: GET /?code&state
    L->>L: state matches? else reject
    L-->>B: "Connected, close this window"
    L-->>A: code
    A->>G: POST /token (code, verifier, client id+secret, redirect_uri)
    G-->>A: access_token, refresh_token
    A->>A: encrypt(refresh_token, passphrase)
    A->>D: refreshToken (enc1.…), calendars (via calendarList), account
    A-->>S: connected
```

The access token lives in memory and is refreshed 60 s before expiry or after a 401, on every platform, using only `requestUrl`. Concurrent callers share one refresh (single-flight).

### Unlock (every device, at start)

`data.json` arrives on another device through vault sync with the token as ciphertext. At load the plugin reads the passphrase from that device's keychain and decrypts the token into memory; the key derivation runs in the background so `onload` stays cheap. Without a passphrase, or with a wrong one, the plugin is *locked*: the block and pane show *Enter the sync passphrase in the plugin settings*, the settings tab offers an **Unlock** button, and no sync runs. Entering the passphrase there decrypts the token and stores the passphrase in the keychain, after which the device behaves like the desktop. A login written by a version before 1.2.0 is plain text; it keeps working and is encrypted the moment a passphrase is set.

### Sync (every device)

```mermaid
sequenceDiagram
    participant T as Trigger
    participant P as GCalSync.sync()
    participant C as CalendarSync
    participant M as TaskMirror
    participant G as Google
    participant LS as localStorage
    participant V as Task notes

    T->>P: block render / window focus / interval / task note changed / Sync now
    P->>P: already running? reuse. <30 s ago and not forced? skip
    loop each enabled calendar
        P->>C: sync(calendarId)
        C->>LS: read syncToken
        alt no token
            C->>G: events.list timeMin/timeMax singleEvents
        else token
            C->>G: events.list syncToken
            G-->>C: 410 → clear cache, full list
        end
        C->>LS: upsert / drop cancelled, save nextSyncToken
    end
    opt mirroring on
        P->>M: sync()
        M->>G: tasks.list per project list (create list if missing)
        M->>V: collect type: Task notes
        M->>M: pair by google_task_id (fallback: previous index by path)
        M->>G: insert / patch / move / delete
        M->>V: processFrontMatter, rename, create
        M->>LS: save id→path index
    end
    P-->>T: status {lastSyncAt | lastError}; listeners redraw
```

Triggers include metadata changes of task notes (debounced 1.5 s, forced) so that ticking a checkbox reaches Google immediately, and so the sync runs after the metadata cache has re-parsed the note the plugin itself just wrote.

### Task field ownership

Events are never merged: the last write to Google wins, protected by `If-Match` so a stale client gets a 412 and refreshes. Tasks have two writers, so the mirrored fields merge field by field against the values both sides held after the last sync (the *base*, kept per device): a field changed on one side only takes that side; a field changed on both sides goes to the side with the later timestamp (Google `updated` against the file's mtime); a pair without a base yet falls back to that timestamp for every field.

| Field | Push to Google | Pull to note |
| --- | --- | --- |
| `title` | `title` | `title`; the file is renamed too |
| `due` | `due` | `due`, or removed when Google cleared it |
| completion | `done` ↔ `completed`, anything else ↔ `needsAction` | `completed` → `done`; `needsAction` → `backlog` only if the note was `done` |
| `backlog` / `active` / `blocked`, body, other properties | never sent | never touched |
| `notes` (Google) | starts with the `obsidian://` back-link; text written on a phone stays below it | ignored |

Existence rules:

- A note without an id gets a task, unless a task already links back to the note's path: another device made it and the id has not reached this note yet, so the two are paired instead.
- A task without a note is imported as a note only if it has no back-link, that is, it was typed into a Google app. A task with a back-link came from a note on some device; if this device does not have that note, vault sync has not delivered it yet, and the task is left alone.
- A task whose note this device paired last time and which is now gone is deleted, after the note has stayed gone for ten minutes (a rename or move still in transit looks like a deletion for a moment).
- A note whose task Google no longer has gets a new task, after the same ten minutes (the note may be a deletion from another device that has not arrived).
- When several notes claim one task, the note the task links back to is mirrored (else the first path); the others are skipped and listed in a notice.
- A task whose note moved to another project is moved with `tasks.move?destinationTasklist`.

These rules are why mirroring can run on every device at once. Vault sync delivers notes minutes late, and each device decides from its own copy, so a rule may never act on something merely being absent from this device. Google, which every device sees at the same moment, carries the evidence instead: the back-link. Issue #10 was the case this broke before: a device that had not yet received another device's notes imported their tasks as new notes, and each copy then got a task of its own.

## Data

`data.json` (synced between devices, written only on login, logout, settings and toggles):

```json
{
  "clientId": "…apps.googleusercontent.com",
  "clientSecret": "…",
  "refreshToken": "enc1.<salt>.<iv>.<ciphertext>",
  "account": "user@gmail.com",
  "calendars": { "<calendarId>": { "name": "Work", "color": "#D85B8B", "enabled": true } },
  "mirror": true,
  "projectsFolder": "10-projects",
  "taskLists": { "<project folder name>": "<Google list id>" },
  "showCompletedTasks": false,
  "hideMidnightTime": true,
  "syncIntervalMinutes": 5,
  "weekStart": "monday"
}
```

`refreshToken` is the refresh token encrypted with AES-256-GCM under a key derived from the sync passphrase by PBKDF2-HMAC-SHA256 (600,000 iterations, 16-byte salt, 12-byte IV, all base64url). A fresh salt and IV are used every time it is written. Google treats the client secret of a desktop app as public, so `clientId` and `clientSecret` stay plain.

Obsidian keychain (per vault, per device, via `app.secretStorage`):

| Id | Value |
| --- | --- |
| `google-cal-sync-passphrase` | The sync passphrase. Written when the user sets or unlocks it; never written to the vault |

localStorage (per device):

| Key | Value |
| --- | --- |
| `google-cal-sync:<calendarId>` | `{ syncToken, syncedAt, events: { [id]: { id, calendarId, title, start, end, allDay, description, location, recurringEventId, etag } } }` |
| `google-cal-sync:tasks` | `{ [googleTaskId]: notePath }` from the previous mirror run. Kept by `Clear cache`, dropped on logout |
| `google-cal-sync:task-state` | `{ base: { [googleTaskId]: { title, due, done } }, absent: { ["note:" \| "task:" + id]: firstMissingAt } }` |

Task note frontmatter the plugin reads and writes: `type`, `title`, `status`, `due`, `google_task_id`. Nothing else in the note is touched.

## Decisions

| Decision | Alternatives considered | Why this one |
| --- | --- | --- |
| Google is the source of truth for events; no local queue or merge | Notes per event; offline queue | Two sources of truth need conflict code larger than the feature. Offline users still see the cache; writes simply fail with a notice |
| Notes are the source of truth for tasks; Google is a mirror | Google Tasks as master | Tasks API has two states and no custom fields; the note's `status` column and body cannot live there |
| Login on desktop only; phones reuse the refresh token through vault sync | Relay server; static HTTPS bridge page with `obsidian://` handoff | No infrastructure to run, no public redirect URI to register, nothing to keep alive. A refresh token does not expire from age alone |
| `data.json` for the login, localStorage for the cache | Everything in `data.json`; SecretStorage | Vault sync must carry the token; it must not carry a file that changes every five minutes. SecretStorage is per device and would strand phones |
| The refresh token in `data.json` is encrypted with a user passphrase; the passphrase lives in each device's keychain | Plain text (1.0 and 1.1); SecretStorage only; a static HTTPS bridge page so that every device logs in for itself | Plain text left the token in every sync copy and backup. SecretStorage alone never syncs. A bridge needs a public redirect URI and a Web client. A passphrase-derived key gives end-to-end encryption between the user's own devices with no infrastructure, and the keychain makes it a one-time entry per device |
| Scopes `calendar` + `tasks` | The narrower `calendar.calendarlist.readonly` + `calendar.events` pair, which 1.2.0 shipped | One scope covers every calendar endpoint the plugin may need, and the owner chose it over the narrower pair in 1.6.0. The plugin still calls only `calendarList.list` and `events.*` |
| The loopback server ignores requests without this login's `state` | Reject the login on the first mismatch | A stray or hostile local request must not be able to cancel a login; the real redirect or the timeout ends it |
| FullCalendar 6, bundled, imported on first block | Hand-drawn grid; FullCalendar 7 | Month/week/day, drag, resize and touch for free under MIT. v7 needs `temporal-polyfill`, separate CSS and renamed variables; v6 injects its CSS and its `--fc-*` variables map cleanly to Obsidian's |
| Conflict tie-break by file mtime, not frontmatter `modified` | Date-only comparison | A note created today and ticked on the phone today would otherwise be reverted by the note |
| Field-by-field merge against a per-device base; the timestamp only breaks ties | Whole-record last writer wins | Completing on the phone while another device edits the due date lost one of the two changes |
| Every device mirrors; Google's back-link decides whether a task is new | A synced task index; one mirroring device; a lease on Google | A synced index arrives as late as the notes. One device stops mirroring whenever it is off, and there is often no device that is always on. A lease needs a visible list or another OAuth scope |
| `If-Match` on every patch | Blind patch | A 412 costs one extra GET and avoids overwriting an edit made in Google Calendar between syncs |
| One `select` handler for click and drag-select | `dateClick` + `select` | With `selectable`, a single click fires both; two modals opened |
| Incremental sync with `syncToken`, first sync bounded to −3/+6 months | Time-window every time | One request per calendar per sync regardless of size; Google's own delta protocol handles deletions |
| Declarative settings tab (`getSettingDefinitions`) | Imperative `display()` | Settings become searchable in Obsidian 1.13 and the lint recommends it |
| Map calendar colours from the classic to the modern palette; refresh the list hourly | Use `backgroundColor` as returned | The API still reports the 2011 palette (`#9fe1e7`) while every Google app shows the modern one (`#039be5`); users expect the block to match their apps |
| Day cells overflow visible; redraw on becoming visible | Trust FullCalendar's defaults | Obsidian's reading view clips `td`, and FullCalendar measures columns when it draws, so multi-day bars otherwise collapse to one cell |

## Quality attributes and how they are met

| Attribute | Target | Mechanism | Evidence |
| --- | --- | --- | --- |
| Start-up cost | ≤ 50 ms added | `onload` only registers; FullCalendar and locales load on the first `gcal` block | Enable time measured at ~4 ms |
| Mobile compatibility | Same bundle on iOS/Android | No Node/Electron outside the `Platform.isDesktop` guard; `requestUrl` everywhere; no regex look-behind | `eslint-plugin-obsidianmd` recommended passes with 0 warnings; mobile emulation checked |
| API budget | ≤ 1 list call per calendar and per task list per sync | syncToken; tasks.list per project; writes only on change; 30 s throttle; single in-flight sync | e2e "request budget" step |
| Data safety | Never delete what the user did not delete | Deletions only from explicit UI actions or a note that existed in the previous index and is gone; cache untouched on failed requests | e2e steps for 412, 410, deletions |
| Theme fit | No literal colours | `--fc-*` mapped to Obsidian CSS variables; only Google's calendar colours are inline | `styles.css` |
| Secrets at rest | No plain-text refresh token in any synced file | AES-256-GCM under a PBKDF2 key from the sync passphrase; passphrase in the OS-encrypted keychain; decrypted token only in memory | Unit tests: round trip, wrong passphrase, two-device unlock; e2e: login refuses to start without a passphrase |

## Testing

- `npm test`: node:test over the pure logic (settings loader, block options, event mapping, `GoogleClient` retry and errors, `CalendarSync` full/incremental/410/pagination, 412 handling) with an `obsidian` stub.
- `tests/e2e/`: scripts run inside a development vault against a fake Google transport swapped in at the `GoogleClient.send` level, so `GoogleError` handling is the real code. They cover the whole task ruleset, the calendar write paths, the UI wiring and the public API's modals; `login-test.js` drives the loopback server with a fake browser up to the real token endpoint.
- GitHub Actions runs build, lint and unit tests on Node 20, 22 and 24; release-please keeps a release pull request open on `master`, and merging it tags the commit, publishes the GitHub release and attaches the attested build assets.
