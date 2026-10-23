import type {
	Calendar,
	EventApi,
	EventClickArg,
	EventContentArg,
	EventDropArg,
	EventInput as FcEvent,
} from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import { getLanguage, MarkdownRenderChild, Notice, Platform, parseYaml } from 'obsidian';
import type { CachedEvent } from './cache';
import { inCalendarRange } from './calendar-range';
import { type CalendarScroller, registerCalendarScroll, scrollingRange } from './calendar-scroll';
import { addDays, fmtLocal, fromNow } from './dates';
import { CalendarEventActions } from './event-actions';
import { type ColorPopover, showEventColorPalette } from './event-color-palette';
import { type EventColorChoice, eventColor, eventColorChoices } from './event-colors';
import { EventDetailsPanel } from './event-details';
import type GCalSync from './main';
import { PlannerPanel } from './planner-panel';
import { errorMessage, WEEKDAYS } from './settings';

const VIEWS = {
	month: 'dayGridMonth',
	week: 'timeGridScroll',
	day: 'timeGridDay',
	list: 'listWeek',
} as const;

export interface BlockOptions {
	view: keyof typeof VIEWS;
	height: string;
	calendars: string[];
	tasks: boolean;
}

export function parseOptions(source: string): BlockOptions | string {
	let raw: unknown;
	try {
		raw = source.trim() ? parseYaml(source) : {};
	} catch {
		return 'gcal: options must be YAML (key: value per line)';
	}
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const opts: BlockOptions = {
		view: 'month',
		height: 'auto',
		calendars: [],
		tasks: true,
	};
	if (o.view !== undefined) {
		if (typeof o.view !== 'string' || !(o.view in VIEWS))
			return 'gcal: `view` must be one of month, week, day, list';
		opts.view = o.view as BlockOptions['view'];
	}
	if (o.height !== undefined) {
		if (typeof o.height !== 'string' && typeof o.height !== 'number')
			return 'gcal: `height` must be a CSS length or auto';
		opts.height = String(o.height);
	}
	if (o.calendars !== undefined) {
		if (!Array.isArray(o.calendars) || !o.calendars.every((c) => typeof c === 'string'))
			return 'gcal: `calendars` must be a list of calendar ids';
		opts.calendars = o.calendars;
	}
	if (o.tasks !== undefined) {
		if (typeof o.tasks !== 'boolean') return 'gcal: `tasks` must be true or false';
		opts.tasks = o.tasks;
	}
	return opts;
}

/** What this device shows instead of the calendar when it cannot draw one; empty when it can. */
export function blockedMessage(plugin: GCalSync): string {
	const s = plugin.settings;
	if (!s.clientId || !s.clientSecret)
		return 'Enter a Google client ID and secret in the plugin settings.';
	if (!s.refreshToken)
		return Platform.isDesktop
			? 'Log in to Google in the plugin settings to see your calendar here.'
			: 'Log in on desktop. The calendar appears here once the vault syncs the login to this device.';
	if (plugin.auth.locked)
		return 'Enter the sync passphrase in the plugin settings to unlock the calendar on this device.';
	return '';
}

type Kind = { kind: 'event'; ev: CachedEvent } | { kind: 'task'; path: string; status: string };

export class GCalBlock extends MarkdownRenderChild {
	private calendar: Calendar | null = null;
	private toolbar!: HTMLElement;
	private pill!: HTMLElement;
	private showTasks: boolean;
	/** The blocked message the block last drew, '' for the calendar itself; null before the first draw. */
	private lastState: string | null = null;
	/** A redraw was requested while the block had no size (hidden tab); done when it becomes visible. */
	private dirty = false;
	private resizeObserver: ResizeObserver | null = null;
	private plannerPanel: PlannerPanel | null = null;
	private detailsPanel: EventDetailsPanel | null = null;
	private scrolling: CalendarScroller | null = null;
	private dateLabel: HTMLElement | null = null;
	private colorPopover: ColorPopover | null = null;
	private pendingColors = new Set<string>();
	private eventActions: CalendarEventActions | null = null;

	constructor(
		containerEl: HTMLElement,
		private plugin: GCalSync,
		private opts: BlockOptions,
	) {
		super(containerEl);
		this.showTasks = opts.tasks;
	}

	onload(): void {
		this.containerEl.addClass('gcal');
		this.eventActions = new CalendarEventActions(this.plugin, this, this.containerEl, (event) =>
			this.detailsPanel?.show(event),
		);
		// Expand within this note's pane, rather than overflowing into adjacent panes.
		let note = this.containerEl.closest('.markdown-preview-view, .markdown-source-view');
		note?.addClass('gcal-wide-note');
		this.register(() => {
			this.containerEl.removeClass('gcal');
			if (!note?.querySelector('.gcal')) note?.removeClass('gcal-wide-note');
		});
		this.scrolling = registerCalendarScroll(
			this,
			this.containerEl,
			() => this.calendar,
			(text) => this.dateLabel?.setText(text),
		);
		this.plugin.addListener(this.refresh);
		this.registerDomEvent(window, 'focus', () => void this.plugin.sync());
		// FullCalendar measures column widths when it draws. Drawn in a hidden tab (width 0), multi-day bars
		// collapse to one cell, so redraw or re-measure whenever the block gains or changes size.
		this.resizeObserver = new ResizeObserver(() => {
			// Code blocks can load before their rendered wrapper is attached to the note.
			note ??= this.containerEl.closest('.markdown-preview-view, .markdown-source-view');
			note?.addClass('gcal-wide-note');
			this.onResize();
		});
		this.resizeObserver.observe(this.containerEl);
		void this.render();
	}

	onunload(): void {
		this.colorPopover?.close();
		this.plugin.removeListener(this.refresh);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.calendar?.destroy();
		this.calendar = null;
	}

	private get hidden(): boolean {
		return this.containerEl.offsetWidth === 0;
	}

	private onResize(): void {
		this.scrolling?.resize();
		if (!this.calendar || this.hidden) return;
		if (this.dirty) {
			this.dirty = false;
			this.calendar.refetchEvents();
		} else {
			this.calendar.updateSize();
		}
	}

	private refresh = (): void => {
		if (blockedMessage(this.plugin) !== this.lastState) {
			void this.render();
			return;
		}
		this.renderToolbar();
		this.detailsPanel?.refresh();
		this.calendar?.setOption('firstDay', WEEKDAYS.indexOf(this.plugin.settings.weekStart));
		if (this.hidden) {
			this.dirty = true;
			return;
		}
		this.calendar?.refetchEvents();
	};

	private async render(): Promise<void> {
		const blocked = (this.lastState = blockedMessage(this.plugin));
		this.colorPopover?.close();
		if (this.plannerPanel) this.removeChild(this.plannerPanel);
		if (this.detailsPanel) this.removeChild(this.detailsPanel);
		this.detailsPanel = null;
		this.calendar?.destroy();
		this.calendar = null;
		this.containerEl.empty();
		const layout = this.containerEl.createDiv({ cls: 'gcal-layout' });
		const schedule = layout.createDiv({ cls: 'gcal-schedule' });
		this.plannerPanel = new PlannerPanel(layout.createDiv(), this.plugin);
		this.addChild(this.plannerPanel);
		if (blocked) {
			schedule.createEl('p', { cls: 'gcal-empty', text: blocked });
			return;
		}
		this.toolbar = schedule.createDiv({ cls: 'gcal-toolbar' });
		const navigation = schedule.createDiv({ cls: 'gcal-date-navigation' });
		const previous = navigation.createEl('button', { text: 'Previous week' });
		const today = navigation.createEl('button', { text: 'Today' });
		const next = navigation.createEl('button', { text: 'Next week' });
		const hint = navigation.createSpan({
			cls: 'gcal-swipe-hint',
			text: 'Scroll left/right across days',
		});
		previous.onclick = () => {
			if (!this.scrolling?.step(-7)) this.calendar?.prev();
		};
		today.onclick = () => {
			if (!this.scrolling?.today()) this.calendar?.today();
		};
		next.onclick = () => {
			if (!this.scrolling?.step(7)) this.calendar?.next();
		};
		this.dateLabel = navigation.createSpan({ cls: 'gcal-date-label' });
		const viewPicker = navigation.createEl('select', {
			attr: { 'aria-label': 'Calendar view' },
		});
		for (const [name, id] of Object.entries(VIEWS)) {
			viewPicker.createEl('option', {
				text: name.charAt(0).toUpperCase() + name.slice(1),
				value: id,
			});
		}
		viewPicker.onchange = () => this.calendar?.changeView(viewPicker.value);
		const workspace = schedule.createDiv({ cls: 'gcal-event-workspace' });
		const viewport = workspace.createDiv({ cls: 'gcal-calendar-viewport' });
		const calendarHeight =
			this.opts.height === 'auto'
				? 'min(75vh, 900px)'
				: /^\d+$/.test(this.opts.height)
					? `${this.opts.height}px`
					: this.opts.height;
		workspace.setCssProps({ '--gcal-event-height': calendarHeight });
		const details = workspace.createDiv();
		this.detailsPanel = new EventDetailsPanel(
			details,
			this.plugin,
			(open) => {
				workspace.toggleClass('has-event-details', open);
				if (!open) this.calendar?.unselect();
				this.onResize();
			},
			(event) => {
				this.calendar?.unselect();
				this.eventActions?.select(event, false);
			},
		);
		this.addChild(this.detailsPanel);
		const calEl = viewport.createDiv({ cls: 'gcal-calendar' });
		this.scrolling?.prepare(viewport, calEl, !Platform.isPhone && this.opts.view === 'week');
		calEl.title =
			'Scroll left/right continuously across days. Drag empty space to pan; drag events to reschedule.';
		this.renderToolbar();
		const fc = await import('./fc');
		if (!this.containerEl.isConnected && !this.containerEl.parentElement) return;
		const s = this.plugin.settings;
		this.calendar = new fc.Calendar(calEl, {
			plugins: [fc.dayGridPlugin, fc.timeGridPlugin, fc.listPlugin, fc.interactionPlugin],
			locales: fc.allLocales,
			locale: getLanguage(),
			// A phone is too narrow for the month and week grids, which need about 700px to stay readable.
			// Start on the list there whatever the block asks for; the toolbar still switches to any view.
			initialView: Platform.isPhone ? VIEWS.list : VIEWS[this.opts.view],
			headerToolbar: false,
			views: {
				timeGridScroll: {
					type: 'timeGrid',
					visibleRange: scrollingRange,
					dateAlignment: 'day',
					dateIncrement: { days: 7 },
					buttonText: 'Week',
				},
				// The list puts the time in its own column, and a locale that spells out AM/PM makes that
				// column wide enough to squeeze the title out on a phone. 24-hour time keeps it narrow.
				listWeek: {
					eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
					// The year is the same on every heading of a week, so it only crowds the date.
					listDaySideFormat: { month: 'long', day: 'numeric' },
				},
			},
			firstDay: WEEKDAYS.indexOf(s.weekStart),
			height: 'auto',
			slotMinTime: '00:00:00',
			slotMaxTime: '24:00:00',
			scrollTimeReset: false,
			nowIndicator: true,
			dayMaxEvents: true,
			editable: true,
			selectable: true,
			unselectCancel: '.gcal-event-details',
			longPressDelay: 500,
			eventLongPressDelay: 500,
			selectLongPressDelay: 500,
			events: (info, success) => success(this.events(info.start, info.end)),
			// A plain click selects one day (or one slot), so `select` covers both click and drag-to-select.
			select: (info) => {
				if (this.scrolling?.suppressSelection()) {
					this.calendar?.unselect();
					return;
				}
				if (
					this.eventActions?.place(
						{ start: info.startStr, allDay: info.allDay },
						info.end.getTime() - info.start.getTime() >
							(info.allDay ? 86400000 : 1800000),
					)
				)
					return;
				this.eventActions?.clearSelection();
				this.detailsPanel?.create({
					start: info.startStr,
					end: info.endStr,
					allDay: info.allDay,
				});
			},
			// The stylesheet needs to know when the list is showing. A `:has()` selector would do it,
			// but the community review flags that rule for broad style invalidation, so mark the root here.
			datesSet: (info) => {
				viewPicker.value = info.view.type;
				this.containerEl.toggleClass('is-list', info.view.type === VIEWS.list);
				this.scrolling?.dates(
					info.view.type === VIEWS.week,
					info.start,
					info.end,
					info.view.calendar.getDate(),
				);
				const period =
					info.view.type === VIEWS.month
						? 'month'
						: info.view.type === VIEWS.day
							? 'day'
							: 'week';
				previous.setText(`Previous ${period}`);
				next.setText(`Next ${period}`);
				previous.setAttribute('aria-label', `Previous ${period}`);
				next.setAttribute('aria-label', `Next ${period}`);
				hint.setText(
					info.view.type === VIEWS.week
						? 'Scroll left/right across days'
						: 'Use the arrows to change dates',
				);
				if (info.view.type !== VIEWS.week) this.dateLabel?.setText(info.view.title);
			},
			eventClick: (info) => this.onEventClick(info),
			eventDrop: (info) => void this.onMove(info),
			eventResize: (info) => void this.onMove(info),
			eventContent: (arg) => this.taskContent(arg),
			eventWillUnmount: (arg) => {
				arg.el.oncontextmenu = null;
			},
			eventDidMount: (arg) => {
				if (arg.event.extendedProps.kind === 'event')
					arg.el.oncontextmenu = (event) => this.onEventContextMenu(arg.event, event);
				const start = arg.event.start;
				if (
					this.plugin.settings.hideMidnightTime &&
					!arg.event.allDay &&
					start &&
					start.getHours() === 0 &&
					start.getMinutes() === 0
				) {
					arg.el.querySelector('.fc-event-time')?.remove();
				}
			},
		});
		this.calendar.render();
		if (this.hidden) this.dirty = true;
		void this.plugin.sync();
	}

	private renderToolbar(): void {
		if (!this.toolbar) return;
		const s = this.plugin.settings;
		this.toolbar.empty();
		const toggles = this.toolbar.createDiv({ cls: 'gcal-toggles' });
		if (this.opts.calendars.length === 0) {
			for (const cal of Object.values(s.calendars)) {
				const b = toggles.createEl('button', {
					cls: ['gcal-toggle', cal.enabled ? 'is-on' : ''],
					text: cal.name,
				});
				b.createSpan({ cls: 'gcal-dot' }).setCssProps({
					'--gcal-color': cal.color,
				});
				b.prepend(b.lastChild as Node);
				b.onclick = async () => {
					cal.enabled = !cal.enabled;
					await this.plugin.saveSettings();
					this.plugin.notifyChanged();
				};
			}
		}
		if (this.opts.tasks) {
			const b = toggles.createEl('button', {
				cls: ['gcal-toggle', 'gcal-toggle-tasks', this.showTasks ? 'is-on' : ''],
				text: 'Tasks',
			});
			b.onclick = () => {
				this.showTasks = !this.showTasks;
				this.renderToolbar();
				this.calendar?.refetchEvents();
			};
		}
		// Inside the toggle wrap flow rather than beside it: as its own flex item the pill shrinks the
		// toggle row and pushes a button onto a new line whenever the status text appears.
		this.pill = toggles.createSpan({ cls: 'gcal-pill' });
		this.renderPill();
	}

	private renderPill(): void {
		const st = this.plugin.status;
		this.pill.className = 'gcal-pill';
		this.pill.onclick = null;
		if (st.syncing) {
			this.pill.setText('Syncing…');
		} else if (st.lastError) {
			this.pill.addClass('is-error');
			this.pill.setText('Error');
			this.pill.onclick = () => new Notice(st.lastError);
		} else if (st.lastSyncAt && Date.now() - st.lastSyncAt > 3_600_000) {
			this.pill.addClass('is-stale');
			this.pill.setText(`Synced ${fromNow(st.lastSyncAt)}`);
		} else {
			this.pill.setText('');
		}
	}

	private visibleCalendars(): string[] {
		const s = this.plugin.settings;
		if (this.opts.calendars.length) return this.opts.calendars;
		return Object.keys(s.calendars).filter((id) => s.calendars[id]?.enabled);
	}

	private events(from?: Date, to?: Date): FcEvent[] {
		const s = this.plugin.settings;
		const out: FcEvent[] = [];
		for (const calId of this.visibleCalendars()) {
			const calendarColor = s.calendars[calId]?.color || undefined;
			const cache = this.plugin.cache.calendar(calId);
			if (!cache) continue;
			for (const ev of Object.values(cache.events)) {
				if (!inCalendarRange(ev.start, ev.end, ev.allDay, from, to)) continue;
				const kind: Kind = { kind: 'event', ev };
				const color = eventColor(ev, cache.labels, calendarColor);
				out.push({
					id: `${calId}::${ev.id}`,
					title: ev.title,
					start: ev.start,
					end: ev.end || undefined,
					allDay: ev.allDay,
					backgroundColor: color,
					borderColor: color,
					extendedProps: kind,
				});
			}
		}
		if (this.showTasks) {
			for (const t of this.plugin.taskNotes()) {
				if (
					!t.due ||
					(t.status === 'done' && !s.showCompletedTasks) ||
					!inCalendarRange(t.due, '', true, from, to)
				)
					continue;
				const kind: Kind = {
					kind: 'task',
					path: t.file.path,
					status: t.status,
				};
				out.push({
					id: `task::${t.file.path}`,
					title: t.title,
					start: t.due,
					allDay: true,
					editable: false,
					classNames: [
						'gcal-task',
						t.status === 'done' ? 'is-done' : '',
						t.status === 'blocked' ? 'is-blocked' : '',
					].filter(Boolean),
					extendedProps: kind,
				});
			}
		}
		return out;
	}

	private taskContent(arg: EventContentArg): { domNodes: Node[] } | true {
		const kind = arg.event.extendedProps as Kind;
		if (kind.kind !== 'task') return true;
		const frag = createFragment();
		const box = frag.createEl('input', {
			type: 'checkbox',
			cls: 'gcal-task-check',
		});
		box.checked = kind.status === 'done';
		box.onclick = (e) => {
			e.stopPropagation();
			void this.toggleTask(kind.path, box.checked);
		};
		frag.createSpan({ cls: 'gcal-task-title', text: arg.event.title });
		return { domNodes: Array.from(frag.childNodes) };
	}

	private async toggleTask(path: string, done: boolean): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(path);
		if (!file) return;
		await this.plugin.app.fileManager.processFrontMatter(
			file,
			(fm: Record<string, unknown>) => {
				fm.status = done ? 'done' : 'backlog';
			},
		);
		// The metadata 'changed' event redraws and mirrors once the cache has the new status.
	}

	private onEventContextMenu(event: EventApi, mouse: MouseEvent): void {
		const kind = event.extendedProps as Kind;
		if (kind.kind !== 'event') return;
		mouse.preventDefault();
		mouse.stopPropagation();
		const cached = this.plugin.cache.calendar(kind.ev.calendarId);
		const latest = cached?.events[kind.ev.id] ?? kind.ev;
		this.colorPopover?.close();
		this.eventActions?.select(latest);
		const doc =
			(mouse.target as HTMLElement | null)?.ownerDocument ?? this.containerEl.ownerDocument;
		this.colorPopover = showEventColorPalette(
			doc,
			mouse.clientX,
			mouse.clientY,
			eventColorChoices(
				latest,
				cached?.labels,
				this.plugin.settings.calendars[latest.calendarId]?.color,
			),
			(choice) => this.changeEventColor(event, choice),
			this.pendingColors.has(event.id),
			[
				{ name: 'Cut', shortcut: '⌘X', run: () => this.eventActions?.copy(true) },
				{ name: 'Copy', shortcut: '⌘C', run: () => this.eventActions?.copy() },
				{ name: 'Duplicate', shortcut: '⌘D', run: () => this.eventActions?.duplicate() },
				{
					name: 'Delete',
					destructive: true,
					run: async () => {
						await this.eventActions?.remove();
					},
				},
			],
		);
	}

	private async changeEventColor(event: EventApi, choice: EventColorChoice): Promise<void> {
		const kind = event.extendedProps as Kind;
		if (kind.kind !== 'event' || this.pendingColors.has(event.id)) return;
		const latest =
			this.plugin.cache.calendar(kind.ev.calendarId)?.events[kind.ev.id] ?? kind.ev;
		this.pendingColors.add(event.id);
		const original = { backgroundColor: event.backgroundColor, borderColor: event.borderColor };
		event.setProp('backgroundColor', choice.color);
		event.setProp('borderColor', choice.color);
		try {
			await this.plugin.calendars.patch(
				latest.calendarId,
				latest.id,
				latest.etag,
				choice.changes,
			);
		} catch (error) {
			event.setProp('backgroundColor', original.backgroundColor);
			event.setProp('borderColor', original.borderColor);
			new Notice(`Could not change event color: ${errorMessage(error)}`);
		} finally {
			this.pendingColors.delete(event.id);
			this.plugin.notifyChanged();
		}
	}

	private onEventClick(info: EventClickArg): void {
		const kind = info.event.extendedProps as Kind;
		if (kind.kind === 'task') {
			void this.plugin.app.workspace.openLinkText(kind.path, '', false);
			return;
		}
		info.jsEvent.preventDefault();
		this.colorPopover?.close();
		this.eventActions?.select(kind.ev);
		this.detailsPanel?.show(kind.ev);
	}

	private async onMove(info: EventDropArg | EventResizeDoneArg): Promise<void> {
		const kind = info.event.extendedProps as Kind;
		if (kind.kind !== 'event') {
			info.revert();
			return;
		}
		const ev = kind.ev;
		const allDay = info.event.allDay;
		const start = info.event.startStr;
		const end =
			info.event.endStr ||
			(allDay
				? addDays(start, 1)
				: fmtLocal(new Date((info.event.start?.getTime() ?? Date.now()) + 3_600_000)));
		try {
			await this.plugin.calendars.patch(ev.calendarId, ev.id, ev.etag, {
				start,
				end,
				allDay,
			});
			this.plugin.notifyChanged();
		} catch (e) {
			info.revert();
			new Notice(`Could not save to Google: ${errorMessage(e)}`);
			this.plugin.notifyChanged();
		}
	}
}
