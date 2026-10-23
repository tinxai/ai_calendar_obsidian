import { MarkdownRenderChild, sanitizeHTMLToDom } from 'obsidian';
import type { CachedEvent } from './cache';
import { addDays, parseDate } from './dates';
import { eventColor } from './event-colors';
import { NEW_EVENT_COLOR_ID, newEventCalendar } from './event-defaults';
import {
	type EventDraft,
	eventDraft,
	eventDraftPatch,
	moveDraftDate,
	newEventDraftInput,
	setDraftTime,
} from './event-editing';
import { timeChoices } from './event-times';
import type GCalSync from './main';
import { errorMessage } from './settings';

export function eventTimeSummary(event: CachedEvent): string {
	const date = (value: string) =>
		parseDate(value).toLocaleDateString(undefined, {
			weekday: 'short',
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		});
	if (event.allDay) {
		const last = event.end ? addDays(event.end, -1) : event.start;
		return `All day · ${date(event.start)}${last > event.start ? ` – ${date(last)}` : ''}`;
	}
	const time = (value: string) =>
		parseDate(value).toLocaleTimeString(undefined, {
			hour: 'numeric',
			minute: '2-digit',
		});
	const start = parseDate(event.start),
		end = parseDate(event.end);
	const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
	const duration =
		minutes > 0
			? [
					Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}h` : '',
					minutes % 60 ? `${minutes % 60}m` : '',
				]
					.filter(Boolean)
					.join(' ')
			: '';
	const endDate = end.toDateString() === start.toDateString() ? '' : `${date(event.end)} `;
	return `${date(event.start)}\n${time(event.start)}${event.end ? ` → ${endDate}${time(event.end)}` : ''}${duration ? ` · ${duration}` : ''}`;
}

interface DraftState {
	base: CachedEvent;
	draft: EventDraft;
	dirty: boolean;
}

/** Inline event editor. Drafts survive selection changes and background calendar refreshes. */
export class EventDetailsPanel extends MarkdownRenderChild {
	private selected: CachedEvent | null = null;
	private drafts = new Map<string, DraftState>();
	private newEvents = new Set<string>();
	private saving = new Set<string>();
	private status: HTMLElement | null = null;
	private timers = new Map<string, number>();
	private disposed = false;
	private summary: HTMLElement | null = null;
	private recovery: HTMLButtonElement | null = null;
	private heading: HTMLElement | null = null;

	constructor(
		container: HTMLElement,
		private plugin: GCalSync,
		private changed: (open: boolean) => void,
		private created?: (event: CachedEvent) => void,
	) {
		super(container);
	}
	private get timerWindow(): Window {
		return this.containerEl.ownerDocument.defaultView ?? window;
	}
	private key(event: CachedEvent): string {
		return `${event.calendarId}/${event.id}`;
	}

	onload(): void {
		this.containerEl.addClass('gcal-event-details');
		this.containerEl.setAttribute('role', 'region');
		this.containerEl.setAttribute('aria-label', 'Event details');
		this.containerEl.hidden = true;
		this.registerDomEvent(this.containerEl.ownerDocument, 'keydown', (event) => {
			if (
				event.key !== 'Escape' ||
				event.defaultPrevented ||
				this.containerEl.ownerDocument.querySelector('.modal-container')
			)
				return;
			if (this.selected) {
				event.preventDefault();
				this.close();
			}
		});
	}
	onunload(): void {
		this.disposed = true;
		this.selected = null;
		for (const [key, state] of this.drafts) this.flush(key, state);
	}
	create(range: { start: string; end: string; allDay: boolean }): void {
		const calendarId = newEventCalendar(this.plugin.settings);
		if (!calendarId) return;
		const event: CachedEvent = {
			id: crypto.randomUUID().replace(/-/g, ''),
			calendarId,
			title: '',
			start: range.start,
			end: range.end,
			allDay: range.allDay,
			description: '',
			location: '',
			recurringEventId: null,
			etag: '',
			colorId: NEW_EVENT_COLOR_ID,
			attendees: [],
		};
		this.newEvents.add(this.key(event));
		this.show(event);
		this.containerEl
			.querySelector<HTMLInputElement>('.gcal-event-title-input')
			?.focus({ preventScroll: true });
	}
	show(event: CachedEvent): void {
		if (this.selected && this.key(this.selected) !== this.key(event)) this.flushSelected();
		this.selected = this.plugin.cache.calendar(event.calendarId)?.events[event.id] ?? event;
		this.containerEl.hidden = false;
		this.render();
		this.changed(true);
	}
	close(): void {
		this.flushSelected();
		this.selected = null;
		this.containerEl.empty();
		this.containerEl.hidden = true;
		this.changed(false);
	}
	refresh(): void {
		if (!this.selected) return;
		const latest = this.plugin.cache.calendar(this.selected.calendarId)?.events[
			this.selected.id
		];
		if (!latest && this.newEvents.has(this.key(this.selected))) return;
		if (!latest) {
			this.close();
			return;
		}
		const previous = this.selected;
		this.selected = latest;
		if (this.drafts.get(this.key(latest))?.dirty || this.saving.has(this.key(latest))) return;
		if (this.containerEl?.contains(this.containerEl.ownerDocument.activeElement)) return;
		if (JSON.stringify(previous) !== JSON.stringify(latest)) {
			this.drafts.delete(this.key(latest));
			this.render();
		}
	}
	private render(): void {
		const event = this.selected;
		if (!event) return;
		const key = this.key(event);
		const state = this.drafts.get(key) ?? {
			base: event,
			draft: eventDraft(event),
			dirty: false,
		};
		this.drafts.set(key, state);
		const root = this.containerEl;
		root.empty();
		const header = root.createDiv({ cls: 'gcal-event-details-header' });
		this.heading = header.createSpan({ text: this.newEvents.has(key) ? 'New event' : 'Event' });
		this.status = root.createDiv({
			cls: 'gcal-event-details-muted',
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		header.createEl('button', {
			text: '×',
			attr: { 'aria-label': 'Close event details' },
		}).onclick = () => this.close();
		const changed = () => {
			this.updateSpanHint(state.draft);
			state.dirty = JSON.stringify(state.draft) !== JSON.stringify(eventDraft(state.base));
			this.status?.setText(
				this.saving.has(key) ? 'Saving…' : state.dirty ? 'Waiting to save…' : 'Saved',
			);
			if (this.recovery) this.recovery.hidden = true;
			if (state.dirty) this.schedule(key, state);
		};
		const field = (label: string, name: keyof EventDraft, type = 'text', multiline = false) => {
			const row = root.createEl('label', { cls: 'gcal-event-field' });
			row.createSpan({ text: label });
			const input = multiline ? row.createEl('textarea') : row.createEl('input', { type });
			input.value = String(state.draft[name]);

			input.oninput = () => {
				Object.assign(state.draft, { [name]: input.value });
				changed();
			};
			input.onblur = () => this.flush(key, state);
			return input;
		};
		field('Title', 'title').addClass('gcal-event-title-input');
		// Date and time controls stay compact so the notes remain near the top.
		this.summary = null;
		const dateRow = root.createDiv({ cls: 'gcal-event-date-row' });
		const date = field('Date', 'startDate', 'date');
		if (date.parentElement) dateRow.appendChild(date.parentElement);
		date.oninput = () => {
			if (moveDraftDate(state.draft, date.value)) changed();
		};
		const allDay = dateRow.createEl('label', { cls: 'gcal-event-all-day' });
		const toggle = allDay.createEl('input', { type: 'checkbox' });
		toggle.checked = state.draft.allDay;
		allDay.createSpan({ text: 'All day' });
		const timeRow = root.createDiv({ cls: 'gcal-event-time-row' });
		const startTime = this.timeField(timeRow, 'Start time', 'startTime', state, changed);
		const endTime = this.timeField(timeRow, 'End time', 'endTime', state, changed);
		this.summary = root.createDiv({ cls: 'gcal-event-details-muted gcal-event-span-hint' });
		this.updateSpanHint(state.draft);
		const times = () => {
			startTime.parentElement?.toggleClass('is-hidden', state.draft.allDay);
			endTime.parentElement?.toggleClass('is-hidden', state.draft.allDay);
		};
		times();
		toggle.onchange = () => {
			state.draft.allDay = toggle.checked;
			times();
			changed();
		};

		const row = root.createDiv({ cls: 'gcal-event-field' });
		row.createSpan({ text: 'Notes' });
		const notes = row.createDiv({
			cls: 'gcal-event-notes-editor',
			attr: {
				contenteditable: 'true',
				role: 'textbox',
				'aria-label': 'Event notes',
				'aria-multiline': 'true',
			},
		});
		notes.appendChild(sanitizeHTMLToDom(state.draft.notes));
		notes.oninput = () => {
			state.draft.notes = notes.innerHTML;
			changed();
		};
		notes.onblur = () => this.flush(key, state);
		root.createDiv({
			cls: 'gcal-event-details-muted',
			text: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
		field('Location', 'location');
		const participants = field('Participants', 'participants');
		participants.value = state.draft.participants.replace(/\n/g, ', ');
		participants.placeholder = 'Email addresses, separated by commas';
		if (!event.attendees) {
			participants.disabled = true;
			participants.placeholder = 'Syncing participants…';
		}
		const links = field('Links', 'links', 'text', true);
		links.placeholder = 'One https:// link per line';
		root.createDiv({
			cls: 'gcal-event-details-muted',
			text: 'Links are saved with the event notes.',
		});
		if (event.recurringEventId)
			root.createDiv({
				cls: 'gcal-event-details-muted',
				text: 'Repeating event · edits apply to this occurrence',
			});

		this.recovery = root.createEl('button', { text: 'Reload event' });
		this.recovery.hidden = true;
		this.recovery.onclick = () => {
			if (this.saving.has(key)) return;
			const timer = this.timers.get(key);
			if (timer !== undefined) this.timerWindow.clearTimeout(timer);
			this.timers.delete(key);
			this.drafts.delete(key);
			const latest = this.plugin.cache.calendar(event.calendarId)?.events[event.id];
			if (latest) this.show(latest);
		};
		const calendar = this.plugin.settings.calendars[event.calendarId];
		const footer = root.createDiv({
			cls: 'gcal-event-details-section gcal-event-details-calendar',
		});
		footer.createSpan({ cls: 'gcal-dot' }).setCssProps({
			'--gcal-color':
				eventColor(
					event,
					this.plugin.cache.calendar(event.calendarId)?.labels,
					calendar?.color,
				) ?? 'var(--interactive-accent)',
		});
		footer.createSpan({ text: calendar?.name ?? event.calendarId });
		this.status.setText(
			this.saving.has(key)
				? 'Saving…'
				: state.dirty
					? 'Not saved yet'
					: this.newEvents.has(key)
						? 'Add a title to create the event'
						: 'All changes saved',
		);
	}
	private updateSpanHint(draft: EventDraft): void {
		this.summary?.setText(draft.endDate !== draft.startDate ? `Ends ${draft.endDate}` : '');
	}
	private timeField(
		root: HTMLElement,
		label: string,
		name: 'startTime' | 'endTime',
		state: DraftState,
		changed: () => void,
	): HTMLSelectElement {
		const row = root.createEl('label', { cls: 'gcal-event-field' });
		row.createSpan({ text: label });
		const select = row.createEl('select', {
			cls: 'gcal-event-time-picker',
			attr: { 'aria-label': label },
		});
		for (const choice of timeChoices(state.draft[name]))
			select.createEl('option', { value: choice.value, text: choice.label });
		select.value = state.draft[name];
		select.onchange = () => {
			setDraftTime(state.draft, name, select.value);
			changed();
			this.flush(this.key(state.base), state);
		};
		return select;
	}
	private schedule(key: string, state: DraftState): void {
		const timer = this.timers.get(key);
		if (timer !== undefined) this.timerWindow.clearTimeout(timer);
		if (this.disposed) return;
		this.timers.set(
			key,
			this.timerWindow.setTimeout(() => {
				this.timers.delete(key);
				void this.save(state.base, state);
			}, 700),
		);
	}
	private flush(key: string, state: DraftState): void {
		const timer = this.timers.get(key);
		if (timer !== undefined) this.timerWindow.clearTimeout(timer);
		this.timers.delete(key);
		if (state.dirty) void this.save(state.base, state);
	}
	private flushSelected(): void {
		if (!this.selected) return;
		const key = this.key(this.selected),
			state = this.drafts.get(key);
		if (state) this.flush(key, state);
	}
	private async save(event: CachedEvent, state: DraftState): Promise<void> {
		const key = this.key(event);
		if (this.saving.has(key) || !state.dirty) return;
		const submitted = { ...state.draft };
		let succeeded = false;
		const visible = () => !this.disposed && this.selected && this.key(this.selected) === key;
		try {
			const creating = this.newEvents?.has(key) ?? false;
			const latest = this.plugin.cache.calendar(event.calendarId)?.events[event.id];
			if (!latest && !creating) throw new Error('The event is no longer available.');
			this.saving.add(key);
			if (visible()) {
				this.status?.setText(creating ? 'Creating…' : 'Saving…');
				if (this.recovery) this.recovery.hidden = true;
			}
			let updated: CachedEvent;
			if (creating)
				updated = await this.plugin.calendars.insert(
					event.calendarId,
					newEventDraftInput(state.base, submitted),
					event.id,
				);
			else {
				if (!latest) throw new Error('The event is no longer available.');
				const patch = eventDraftPatch(state.base, submitted, latest);
				updated = Object.keys(patch).length
					? await this.plugin.calendars.patch(
							event.calendarId,
							event.id,
							latest.etag,
							patch,
						)
					: latest;
			}
			this.newEvents?.delete(key);
			const saved = eventDraft(updated);
			// Edits typed while the request was in flight remain in the draft for the next save.
			for (const field of Object.keys(saved) as (keyof EventDraft)[]) {
				if (state.draft[field] === submitted[field])
					Object.assign(state.draft, { [field]: saved[field] });
			}
			state.base = updated;
			state.dirty = JSON.stringify(state.draft) !== JSON.stringify(saved);

			if (creating && visible()) this.created?.(updated);
			if (visible()) {
				this.selected = updated;
				this.heading?.setText('Event');
				this.updateSpanHint(state.draft);
				this.status?.setText(state.dirty ? 'Saving…' : 'Saved');
			}
			succeeded = true;
			this.plugin.notifyChanged();
		} catch (error) {
			if (visible()) {
				this.status?.setText(`Not saved: ${errorMessage(error)}`);
				if (this.recovery) this.recovery.hidden = false;
			}
			// Keep the draft on validation, conflict or network errors; retry after the next edit or blur.
		} finally {
			this.saving.delete(key);
			if (succeeded && state.dirty) {
				if (this.disposed) void this.save(state.base, state);
				else this.schedule(key, state);
			}
		}
	}
}
