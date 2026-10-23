import {
	type App,
	Notice,
	Platform,
	PluginSettingTab,
	type Setting,
	type SettingDefinitionItem,
} from 'obsidian';
import { fmtDateTime } from './dates';
import type GCalSync from './main';

export interface CalendarInfo {
	name: string;
	color: string;
	enabled: boolean;
}

export const WEEKDAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface GCalSettings {
	clientId: string;
	clientSecret: string;
	/** `enc1.…` (see crypto.ts) since 1.2.0; plain text from earlier versions until a passphrase is set. */
	refreshToken: string;
	account: string;
	calendars: Record<string, CalendarInfo>;
	mirror: boolean;
	projectsFolder: string;
	taskLists: Record<string, string>;
	showCompletedTasks: boolean;
	hideMidnightTime: boolean;
	syncIntervalMinutes: number;
	weekStart: Weekday;
}

export const DEFAULT_SETTINGS: GCalSettings = {
	clientId: '',
	clientSecret: '',
	refreshToken: '',
	account: '',
	calendars: {},
	mirror: true,
	projectsFolder: '10-projects',
	taskLists: {},
	showCompletedTasks: false,
	hideMidnightTime: true,
	syncIntervalMinutes: 5,
	weekStart: 'monday',
};

export function loadSettings(saved: unknown): GCalSettings {
	const s: GCalSettings = {
		...DEFAULT_SETTINGS,
		calendars: {},
		taskLists: {},
	};
	if (!saved || typeof saved !== 'object') return s;
	const o = saved as Record<string, unknown>;
	for (const k of [
		'clientId',
		'clientSecret',
		'refreshToken',
		'account',
		'projectsFolder',
	] as const) {
		if (typeof o[k] === 'string') s[k] = o[k];
	}
	for (const k of ['mirror', 'showCompletedTasks', 'hideMidnightTime'] as const) {
		if (typeof o[k] === 'boolean') s[k] = o[k];
	}
	if (typeof o.syncIntervalMinutes === 'number' && o.syncIntervalMinutes >= 1)
		s.syncIntervalMinutes = o.syncIntervalMinutes;
	if (typeof o.weekStart === 'string' && (WEEKDAYS as readonly string[]).includes(o.weekStart))
		s.weekStart = o.weekStart as Weekday;
	if (o.calendars && typeof o.calendars === 'object') {
		for (const [id, v] of Object.entries(
			o.calendars as Record<string, Partial<CalendarInfo>>,
		)) {
			if (v && typeof v.name === 'string') {
				s.calendars[id] = {
					name: v.name,
					color: typeof v.color === 'string' ? v.color : '',
					enabled: v.enabled !== false,
				};
			}
		}
	}
	if (o.taskLists && typeof o.taskLists === 'object') {
		for (const [k, v] of Object.entries(o.taskLists as Record<string, unknown>)) {
			if (typeof v === 'string') s.taskLists[k] = v;
		}
	}
	return s;
}

export class GCalSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: GCalSync,
	) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
		if (key === 'syncIntervalMinutes') this.plugin.restartTimer();
		this.plugin.notifyChanged();
		this.update();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const loggedIn = () => !!s.refreshToken;
		return [
			{
				type: 'group',
				heading: 'Account',
				items: [
					{
						name: 'Client ID',
						desc: 'Client ID of the desktop app OAuth client from Google Cloud.',
						control: { type: 'text', key: 'clientId' },
					},
					{
						name: 'Client secret',
						desc: "Stored in this plugin's data.json so that your other devices (including mobile) can reuse it. Google does not treat the secret of a desktop app as confidential.",
						render: (setting) => {
							setting.addText((t) => {
								t.inputEl.type = 'password';
								t.setValue(s.clientSecret).onChange(async (v) => {
									s.clientSecret = v.trim();
									await this.plugin.saveSettings();
									this.update();
								});
							});
						},
					},
					{
						name: 'Sync passphrase',
						render: (setting) => this.renderPassphrase(setting),
					},
					{
						name: 'Connection',
						render: (setting) => this.renderConnect(setting),
					},
				],
			},
			{
				type: 'group',
				heading: 'Calendars',
				items: [
					...Object.entries(s.calendars).map(([id, cal]) => ({
						name: cal.name,
						visible: loggedIn,
						render: (setting: Setting) => {
							setting.nameEl.prepend(createSpan({ cls: 'gcal-dot' }));
							(setting.nameEl.firstElementChild as HTMLElement).setCssProps({
								'--gcal-color': cal.color,
							});
							setting.addToggle((t) =>
								t.setValue(cal.enabled).onChange(async (v) => {
									const target = s.calendars[id];
									if (target) target.enabled = v;
									await this.plugin.saveSettings();
									this.plugin.notifyChanged();
								}),
							);
						},
					})),
					{
						name: 'Calendar list',
						desc: 'Reload the list of calendars from Google.',
						visible: loggedIn,
						render: (setting) => {
							setting.addButton((b) =>
								b.setButtonText('Refresh').onClick(async () => {
									b.setDisabled(true);
									try {
										await this.plugin.refreshCalendarList();
									} catch (e) {
										new Notice(`Could not load calendars: ${errorMessage(e)}`);
									}
									this.update();
								}),
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Tasks',
				items: [
					{
						name: 'Mirror task notes to Google Tasks',
						desc: 'When off, the Google Tasks API is never called.',
						control: { type: 'toggle', key: 'mirror' },
					},
					{
						name: 'Projects folder',
						desc: 'Each subfolder is a project. Task notes live in <project>/tasks/ and mirror to a Google Tasks list named after the project.',
						control: { type: 'folder', key: 'projectsFolder' },
					},
					{
						name: 'Show completed tasks',
						desc: 'Also draw tasks whose status is done on the calendar.',
						control: { type: 'toggle', key: 'showCompletedTasks' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Display',
				items: [
					{
						name: 'Week starts on',
						control: {
							type: 'dropdown',
							key: 'weekStart',
							options: Object.fromEntries(
								WEEKDAYS.map((d) => [d, d.charAt(0).toUpperCase() + d.slice(1)]),
							),
						},
					},
					{
						name: 'Hide midnight start times',
						desc: 'Events that start at 00:00 are drawn without a time, the way Google Calendar shows them.',
						control: { type: 'toggle', key: 'hideMidnightTime' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Sync',
				items: [
					{
						name: 'Sync interval',
						desc: 'Minutes between background syncs.',
						control: {
							type: 'number',
							key: 'syncIntervalMinutes',
							min: 1,
							step: 1,
						},
					},
					{
						name: 'Last sync',
						render: (setting) => {
							const st = this.plugin.status;
							setting.setDesc(
								st.lastError
									? `Failed: ${st.lastError}`
									: st.lastSyncAt
										? fmtDateTime(st.lastSyncAt)
										: 'Never',
							);
						},
					},
				],
			},
		];
	}

	/**
	 * The passphrase encrypts the refresh token in data.json; each device keeps it in its own keychain. Applied with the
	 * button, not per keystroke: every application re-derives a key, and a half-typed value must never be sealed.
	 */
	private renderPassphrase(row: Setting): void {
		const { auth } = this.plugin;
		row.setDesc(
			auth.locked
				? 'The login synced to this device is encrypted. Enter the passphrase you set on desktop to unlock it here.'
				: auth.plain
					? 'Your login is stored in plain text by an earlier version. Set a passphrase to encrypt it.'
					: auth.passphrase
						? 'Set on this device. Entering a new one re-encrypts the stored login.'
						: 'Encrypts the login in data.json so that vault sync carries only ciphertext. Enter the same passphrase once on each device.',
		);
		let value = '';
		row.addText((t) => {
			t.inputEl.type = 'password';
			t.setPlaceholder(auth.passphrase && !auth.locked ? '••••••••' : 'Passphrase').onChange(
				(v) => (value = v),
			);
		});
		row.addButton((b) => {
			b.setButtonText(auth.locked ? 'Unlock' : 'Set').onClick(async () => {
				b.setDisabled(true);
				try {
					await auth.setPassphrase(value);
					new Notice(
						auth.loggedIn ? 'Login encrypted with the passphrase.' : 'Passphrase set.',
					);
				} catch (e) {
					new Notice(errorMessage(e));
				}
				this.update();
			});
		});
	}

	private renderConnect(row: Setting): void {
		const { plugin } = this;
		const s = plugin.settings;
		if (s.refreshToken) {
			row.setDesc(
				`Connected as ${s.account || 'Google account'}.${plugin.auth.locked ? ' Enter the sync passphrase above to use it on this device.' : ''}`,
			);
			row.addButton((b) =>
				b.setButtonText('Log out').onClick(async () => {
					b.setDisabled(true);
					await plugin.auth.logout();
					this.update();
				}),
			);
			return;
		}
		if (!Platform.isDesktop) {
			row.setDesc(
				'Log in on desktop. The login is carried to this device when the vault (including the plugin folder) syncs.',
			);
			return;
		}
		if (plugin.auth.pending) {
			row.setDesc(
				'Finish the login in your browser. This page updates when Google redirects back.',
			);
			return;
		}
		row.setDesc(
			'Enter the client ID, secret and a sync passphrase, then log in. A browser window opens for Google consent.',
		);
		row.addButton((b) => {
			b.setButtonText('Log in to Google')
				.setCta()
				.setDisabled(!s.clientId || !s.clientSecret || !plugin.auth.passphrase);
			b.onClick(async () => {
				try {
					// login() sets `pending` before its first await, so redraw after starting it
					// to show the "finish in your browser" notice while Google has the user.
					const done = plugin.auth.login();
					this.update();
					await done;
					new Notice(`Connected to Google: ${s.account}`);
				} catch (e) {
					new Notice(`Login failed: ${errorMessage(e)}`);
				}
				this.update();
			});
		});
	}
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
