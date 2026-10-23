# Calendar Planner: setup and development

This project extends the MIT-licensed Google Calendar Tasks Sync plugin. The installation id remains `google-cal-sync` so existing calendar connections, settings and note code blocks keep working. The repository name does not change that id.

## Build and validate

Use Node.js 20 or later and npm.

```sh
npm ci
npm run build
npm test
npm run lint
```

Install `main.js`, `manifest.json` and `styles.css` from the project root into `<vault>/.obsidian/plugins/google-cal-sync/`, then reload Obsidian. Keep the installed plugin's existing `data.json` when updating. `main.js` is generated and intentionally excluded from Git.

The inherited GitHub Actions workflow runs build, lint and tests on pushes and pull requests.

## Calendar

Follow the [Google setup guide](setup-guide.md) for your own OAuth client and Google login. A note containing this block opens the calendar:

````markdown
```gcal
view: week
height: auto
```
````

Scroll through days continuously; seven columns fit the calendar pane. All hours from 00:00 to midnight are available. Select empty time blocks to create an event in the right panel. Entering a title starts autosave. Existing events open the same compact editor. A status near the heading reports waiting, saving, saved or an error.

Click an event and use Cmd/Ctrl+C then V to copy it. Cut uses X, Duplicate uses D, and Delete/Backspace deletes the selected event. Input fields retain normal text editing. Right-click for event colors and actions. New events use your primary personal calendar and green; copies retain their source color.

## Planning

Install and enable the Obsidian Excalidraw plugin for the editable planner drawing. Plans live in `Plans/Planner Board.excalidraw.md`; the assistant and chat log use that same drawing. Keep yearly, monthly, weekly, interview and other plans together. Native text is editable, boxes can be moved, and arrows connect related plans.

The assistant uses the installed Codex CLI and its existing local login. On an explicit request, it sends the planner text, connections, the current week's calendar evidence and recent chat to the model. It does not run AI reviews in the background. Explicit gray/Graphite event colors mean completed work under this planner convention; other events are unconfirmed. Plan edits preserve drawing geometry and make vault-local backups.

The user's planner content, chat history, calendar cache, OAuth settings and login credentials are not part of this repository. Connect Google and sign in locally on each new installation.

## Git

The source is backed up in the private repository [tinxai/ai_calendar_obsidian](https://github.com/tinxai/ai_calendar_obsidian). The local development checkout keeps the original upstream history on `source-history`; `main` follows the GitHub repository. Upstream attribution and the MIT license remain in the published source.

To make a fresh checkout:

```sh
git clone https://github.com/tinxai/ai_calendar_obsidian.git
cd ai_calendar_obsidian
npm ci
```

After editing and running the checks, commit the changed source files and push to `main`. Do not copy the whole installed plugin directory into Git: it contains device settings and private backups. Rebuild from this source checkout and copy only the three installation artifacts into the vault plugin folder.
