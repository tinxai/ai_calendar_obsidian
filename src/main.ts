import { debounce, Notice, Platform, Plugin } from 'obsidian';
import { createApi, type GoogleCalSyncApi } from './api';
import { Auth, AuthError } from './auth';
import { Cache } from './cache';
import { CACHE_WARN_COUNT, CalendarSync, listCalendars } from './calendar';
import { modernColor } from './colors';
import { GoogleClient } from './google';
import { GCalView, VIEW_TYPE } from './pane';
import { registerPlannerBoardStyle } from './planner-board-style';
import { registerPlannerNavigation } from './planner-navigation';
import { PlannerPanel } from './planner-panel';
import { PlannerStore } from './planner-store';
import {
	DEFAULT_SETTINGS,
	errorMessage,
	type GCalSettings,
	GCalSettingTab,
	loadSettings,
} from './settings';
import { collectTaskNotes, TaskMirror, type TaskNote } from './tasks';
import { GCalBlock, parseOptions } from './view';

export interface SyncStatus {
	syncing: boolean;
	lastSyncAt: number;
	lastError: string;
}

const MIN_SYNC_GAP_MS = 30_000;
const LIST_REFRESH_MS = 3_600_000;

export default class GCalSync extends Plugin {
	settings: GCalSettings = { ...DEFAULT_SETTINGS };
	auth!: Auth;
	google!: GoogleClient;
	cache!: Cache;
	calendars!: CalendarSync;
	tasks!: TaskMirror;
	planner!: PlannerStore;
	status: SyncStatus = { syncing: false, lastSyncAt: 0, lastError: '' };
	/** Public entry points for other plugins and scripts; see api.ts. */
	readonly api: GoogleCalSyncApi = createApi(this);

	private listeners = new Set<() => void>();
	private timer = 0;
	private running: Promise<void> | null = null;
	private lastStart = 0;
	private lastListRefresh = 0;
	private noticedError = '';
	private noticedDuplicates = '';
	/**
	 * Set once the plugin is disabled or updated. A code block still on screen keeps a reference to this instance and can
	 * call sync() on focus; a second instance mirroring alongside the new one would write the task index twice.
	 */
	private unloaded = false;

	async onload(): Promise<void> {
		this.settings = loadSettings(await this.loadData());
		this.auth = new Auth(this);
		// Decrypting the stored login costs a key derivation, so it runs in the background rather than delaying startup.
		void this.auth.unlock().then(() => this.notifyChanged());
		this.google = new GoogleClient(this.auth);
		this.cache = new Cache(this.app);
		this.calendars = new CalendarSync(this.google, this.cache);
		this.tasks = new TaskMirror(this);
		this.planner = new PlannerStore(this.app);
		registerPlannerNavigation(this);
		registerPlannerBoardStyle(this);
		this.status.lastSyncAt = this.lastCachedSync();

		this.addSettingTab(new GCalSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new GCalView(leaf, this));
		this.addRibbonIcon('calendar', 'Open Google Calendar', () => void this.openView());
		this.addCommand({
			id: 'open-view',
			name: 'Open calendar view',
			callback: () => void this.openView(),
		});
		this.registerMarkdownCodeBlockProcessor('gcal', (source, el, ctx) => {
			const opts = parseOptions(source);
			if (typeof opts === 'string') {
				el.createEl('p', { cls: 'gcal-error', text: opts });
				return;
			}
			ctx.addChild(new GCalBlock(el, this, opts));
		});
		this.registerMarkdownCodeBlockProcessor('gcal-planner', (_source, el, ctx) => {
			ctx.addChild(new PlannerPanel(el, this));
		});

		this.addCommand({
			id: 'login',
			name: 'Log in to Google',
			checkCallback: (checking) => {
				if (!Platform.isDesktop || this.auth.loggedIn) return false;
				if (!checking) void this.login();
				return true;
			},
		});
		this.addCommand({
			id: 'logout',
			name: 'Log out',
			checkCallback: (checking) => {
				if (!this.auth.loggedIn) return false;
				if (!checking) void this.auth.logout();
				return true;
			},
		});
		this.addCommand({
			id: 'sync',
			name: 'Sync now',
			checkCallback: (checking) => {
				if (!this.auth.loggedIn) return false;
				if (!checking) void this.sync({ force: true, notice: true });
				return true;
			},
		});
		this.addCommand({
			id: 'clear-cache',
			name: 'Clear cache',
			callback: () => this.clearCache(),
		});

		this.app.workspace.onLayoutReady(() => {
			this.restartTimer();
			// Task notes changed (edited, renamed, deleted): redraw calendars and mirror soon after.
			// The metadata cache is already up to date when these fire, so the sync sees the new frontmatter.
			const onTaskNote = debounce(
				() => {
					this.notifyChanged();
					void this.sync({ force: true });
				},
				1500,
				true,
			);
			const inProjects = (path: string) =>
				path.startsWith(`${this.settings.projectsFolder}/`);
			this.registerEvent(
				this.app.metadataCache.on(
					'changed',
					(file, _data, cache) =>
						inProjects(file.path) && cache.frontmatter?.type === 'Task' && onTaskNote(),
				),
			);
			this.registerEvent(
				this.app.vault.on('delete', (file) => inProjects(file.path) && onTaskNote()),
			);
			this.registerEvent(
				this.app.vault.on(
					'rename',
					(file, oldPath) =>
						(inProjects(file.path) || inProjects(oldPath)) && onTaskNote(),
				),
			);
			if (this.auth.loggedIn) void this.sync();
		});
	}

	onunload(): void {
		this.unloaded = true;
		this.listeners.clear();
	}

	/** data.json changed on disk (vault sync brought a login or settings from another device). */
	async onExternalSettingsChange(): Promise<void> {
		this.settings = loadSettings(await this.loadData());
		await this.auth.unlock();
		this.restartTimer();
		this.notifyChanged();
		void this.sync();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	addListener(fn: () => void): void {
		this.listeners.add(fn);
	}

	removeListener(fn: () => void): void {
		this.listeners.delete(fn);
	}

	notifyChanged(): void {
		for (const fn of this.listeners) fn();
	}

	restartTimer(): void {
		if (this.timer) window.clearInterval(this.timer);
		this.timer = this.registerInterval(
			window.setInterval(() => {
				if (!document.hidden) void this.sync();
			}, this.settings.syncIntervalMinutes * 60_000),
		);
	}

	/** Reveals the calendar pane, opening it in the right sidebar the first time. */
	async openView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	taskNotes(): TaskNote[] {
		return collectTaskNotes(this.app, this.settings.projectsFolder);
	}

	private lastCachedSync(): number {
		let max = 0;
		for (const id of Object.keys(this.settings.calendars))
			max = Math.max(max, this.cache.calendar(id)?.syncedAt ?? 0);
		return max;
	}

	private async login(): Promise<void> {
		try {
			await this.auth.login();
			new Notice(`Connected to Google: ${this.settings.account}`);
		} catch (e) {
			new Notice(`Login failed: ${errorMessage(e)}`);
		}
	}

	/** Loads calendarList into settings (keeping toggles, mapping colours to Google's modern palette); saves only on change. */
	async refreshCalendarList(): Promise<void> {
		const list = await listCalendars(this.google);
		const next: GCalSettings['calendars'] = {};
		for (const c of list) {
			next[c.id] = {
				name: c.name,
				color: modernColor(c.color),
				enabled: this.settings.calendars[c.id]?.enabled ?? true,
			};
			if (c.primary) this.settings.account = c.id;
		}
		this.lastListRefresh = Date.now();
		if (JSON.stringify(next) === JSON.stringify(this.settings.calendars)) return;
		this.settings.calendars = next;
		await this.saveSettings();
		this.notifyChanged();
	}

	clearCache(): void {
		this.cache.clearAll(Object.keys(this.settings.calendars));
		this.status.lastSyncAt = 0;
		this.status.lastError = '';
		this.notifyChanged();
		new Notice('Cache cleared. The next sync is a full sync.');
	}

	/** Incremental sync of enabled calendars, then task mirroring. Deduplicated and throttled across callers. */
	sync(opts: { force?: boolean; notice?: boolean } = {}): Promise<void> {
		if (this.running) return this.running;
		if (this.unloaded || !this.auth.loggedIn || this.auth.locked) return Promise.resolve();
		if (!opts.force && Date.now() - this.lastStart < MIN_SYNC_GAP_MS) return Promise.resolve();
		this.lastStart = Date.now();
		this.running = this.runSync(opts.notice ?? false).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async runSync(notice: boolean): Promise<void> {
		this.status.syncing = true;
		this.notifyChanged();
		let events = 0;
		let tasks = 0;
		try {
			if (
				Object.keys(this.settings.calendars).length === 0 ||
				Date.now() - this.lastListRefresh > LIST_REFRESH_MS
			)
				await this.refreshCalendarList();
			for (const [id, cal] of Object.entries(this.settings.calendars)) {
				if (!cal.enabled) continue;
				const state = await this.calendars.sync(id);
				events += Object.keys(state.events).length;
			}
			if (events > CACHE_WARN_COUNT)
				new Notice(
					`${events} events are cached. Run "Clear cache" to start a fresh, smaller cache.`,
				);
			if (this.settings.mirror) {
				const r = await this.tasks.sync();
				tasks = r.total;
				if (r.imported)
					new Notice(
						`Imported ${r.imported} task${r.imported === 1 ? '' : 's'} from Google Tasks`,
					);
				const duplicates = r.duplicates.join('\n');
				if (duplicates !== this.noticedDuplicates) {
					this.noticedDuplicates = duplicates;
					if (duplicates)
						new Notice(
							`These task notes share a Google task with another note, so they are not mirrored. Delete the copy, or clear its google_task_id to make it a task of its own:\n${duplicates}`,
							0,
						);
				}
			}
			this.status.lastSyncAt = Date.now();
			this.status.lastError = '';
			this.noticedError = '';
			if (notice) new Notice(`Synced: ${events} events, ${tasks} tasks`);
		} catch (e) {
			this.status.lastError = errorMessage(e);
			if (notice || (e instanceof AuthError && this.noticedError !== this.status.lastError))
				new Notice(this.status.lastError);
			this.noticedError = this.status.lastError;
		} finally {
			this.status.syncing = false;
			this.notifyChanged();
		}
	}
}
