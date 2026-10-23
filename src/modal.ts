import { Modal, Notice, Setting } from 'obsidian';
import type { CachedEvent, EventGuest } from './cache';
import type { EventInput } from './calendar';
import { addDays, fmtDate, fmtLocal, fmtTime, parseDate, parseLocal } from './dates';
import { type EventColorChoice, eventColorChoices } from './event-colors';
import { NEW_EVENT_COLOR_ID, newEventCalendar } from './event-defaults';
import type GCalSync from './main';
import { errorMessage } from './settings';

export interface EventModalParams {
	/** Existing event to edit; omitted when creating. */
	event?: CachedEvent;
	/** Prefill a new, independent event. Never patches or deletes the source. */
	copyFrom?: CachedEvent;
	calendarId?: string;
	start?: string;
	end?: string;
	allDay?: boolean;
}

/** Create/edit/delete one Google Calendar event. Tasks never open this; they open their note. */
export class EventModal extends Modal {
	private title = '';
	private calendarId = '';
	private allDay = false;
	private startDate = '';
	private startTime = '09:00';
	private endDate = '';
	private endTime = '10:00';
	private description = '';
	private location = '';
	private colorChanges: EventColorChoice['changes'] = { colorId: '' };
	private copyGuests?: EventGuest[];
	private deleteArmed = false;
	private busy = false;
	private settle: () => void = () => {};
	/** Settles when the modal closes, whether it saved, deleted or was cancelled. */
	readonly closed: Promise<void>;

	constructor(
		private plugin: GCalSync,
		private params: EventModalParams,
	) {
		super(plugin.app);
		this.closed = new Promise((resolve) => {
			this.settle = resolve;
		});
		const ev = params.event ?? params.copyFrom;
		if (params.copyFrom?.attendees)
			this.copyGuests = params.copyFrom.attendees.map((guest) => ({
				email: guest.email,
				optional: guest.optional,
			}));
		this.calendarId = ev?.calendarId ?? params.calendarId ?? newEventCalendar(plugin.settings);
		this.allDay = ev?.allDay ?? params.allDay ?? false;
		this.title = ev?.title ?? '';
		this.description = ev?.description ?? '';
		this.location = ev?.location ?? '';
		this.colorChanges = ev?.eventLabelId
			? { eventLabelId: ev.eventLabelId }
			: { colorId: ev?.colorId ?? NEW_EVENT_COLOR_ID };
		const start = ev?.start ?? params.start ?? fmtLocal(new Date());
		const end = ev?.end ?? params.end ?? '';
		this.startDate = fmtDate(parseDate(start));
		if (this.allDay) {
			this.endDate = end ? addDays(fmtDate(parseDate(end)), -1) : this.startDate;
			if (this.endDate < this.startDate) this.endDate = this.startDate;
		} else {
			const s = parseDate(start);
			const e = end ? parseDate(end) : new Date(s.getTime() + 3_600_000);
			this.startTime = fmtTime(s);
			this.endDate = fmtDate(e);
			this.endTime = fmtTime(e);
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		const ev = this.params.event;
		this.modalEl.addClass('gcal-modal');
		this.setTitle(ev ? 'Edit event' : this.params.copyFrom ? 'Duplicate event' : 'New event');
		if (this.params.copyFrom)
			contentEl.createEl('p', {
				cls: 'gcal-modal-note',
				text: 'Choose a date and time for this independent copy, then create it.',
			});
		if (ev?.recurringEventId)
			contentEl.createEl('p', {
				text: 'This is one occurrence of a repeating event. Changes apply to this occurrence only.',
				cls: 'gcal-modal-note',
			});

		new Setting(contentEl).setName('Title').addText((t) => {
			t.setValue(this.title).onChange((v) => {
				this.title = v;
				this.validate();
			});
			t.inputEl.addClass('gcal-modal-title');
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(contentEl).setName('Calendar').addDropdown((d) => {
			for (const [id, c] of Object.entries(this.plugin.settings.calendars))
				if (c.enabled || id === this.calendarId) d.addOption(id, c.name);
			d.setValue(this.calendarId).onChange((v) => {
				this.calendarId = v;
				this.colorChanges = { colorId: '' };
				paintPalette();
			});
			d.setDisabled(!!ev);
		});
		const colorSetting = new Setting(contentEl).setName('Color');
		const palette = colorSetting.controlEl.createDiv({ cls: 'gcal-color-palette' });
		const paintPalette = () => {
			const defaultColor =
				this.plugin.settings.calendars[this.calendarId]?.color ||
				'var(--interactive-accent)';
			const choices = eventColorChoices(
				{
					colorId: 'colorId' in this.colorChanges ? this.colorChanges.colorId : '',
					eventLabelId:
						'eventLabelId' in this.colorChanges ? this.colorChanges.eventLabelId : '',
				},
				this.plugin.cache.calendar(this.calendarId)?.labels,
				defaultColor,
			);
			palette.empty();
			for (const choice of choices) {
				const b = palette.createEl('button', {
					cls: ['gcal-color-swatch', choice.selected ? 'is-selected' : ''],
					attr: { type: 'button', 'aria-label': choice.name, title: choice.name },
				});
				const swatchColor = choice.color;
				b.style.setProperty('--gcal-event-color', swatchColor);
				b.style.setProperty('background-color', swatchColor);
				b.onclick = () => {
					this.colorChanges = choice.changes;
					paintPalette();
				};
			}
		};
		paintPalette();
		new Setting(contentEl).setName('All day').addToggle((t) =>
			t.setValue(this.allDay).onChange((v) => {
				this.allDay = v;
				for (const el of times) el.toggleClass('is-hidden', v);
				this.validate();
			}),
		);
		const times: HTMLElement[] = [];
		const dateRow = (
			name: string,
			date: string,
			time: string,
			set: (d: string, t: string) => void,
		) => {
			const row = new Setting(contentEl).setName(name);
			const dateEl = row.controlEl.createEl('input', {
				type: 'date',
				value: date,
			});
			const timeEl = row.controlEl.createEl('input', {
				type: 'time',
				value: time,
			});
			timeEl.toggleClass('is-hidden', this.allDay);
			times.push(timeEl);
			const update = () => {
				set(dateEl.value, timeEl.value);
				this.validate();
			};
			dateEl.addEventListener('change', update);
			timeEl.addEventListener('change', update);
		};
		dateRow('Start', this.startDate, this.startTime, (d, t) => {
			this.startDate = d;
			this.startTime = t;
		});
		dateRow('End', this.endDate, this.endTime, (d, t) => {
			this.endDate = d;
			this.endTime = t;
		});
		new Setting(contentEl).setName('Location').addText((t) =>
			t.setValue(this.location).onChange((v) => {
				this.location = v;
			}),
		);
		new Setting(contentEl).setName('Notes').addTextArea((t) =>
			t.setValue(this.description).onChange((v) => {
				this.description = v;
			}),
		);

		const buttons = new Setting(contentEl);
		buttons.addButton((b) => {
			this.saveButton = b.buttonEl;
			b.setButtonText(this.params.copyFrom ? 'Create copy' : 'Save')
				.setCta()
				.onClick(() => void this.save());
		});
		if (ev) {
			buttons.addButton((b) => {
				b.setButtonText('Delete')
					.setDestructive()
					.onClick(() => {
						if (!this.deleteArmed) {
							this.deleteArmed = true;
							b.setButtonText('Click again to delete');
							return;
						}
						void this.remove();
					});
			});
		}
		buttons.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
		this.validate();
	}

	onClose(): void {
		this.contentEl.empty();
		this.settle();
	}

	private saveButton: HTMLButtonElement | null = null;

	private colorInput(): Partial<EventInput> {
		return { ...this.colorChanges, ...(this.copyGuests ? { attendees: this.copyGuests } : {}) };
	}

	private input(): EventInput | null {
		if (!this.title.trim() || !this.calendarId || !this.startDate || !this.endDate) return null;
		if (this.allDay) {
			if (this.endDate < this.startDate) return null;
			return {
				title: this.title.trim(),
				allDay: true,
				start: this.startDate,
				end: addDays(this.endDate, 1),
				description: this.description,
				location: this.location.trim(),
				...this.colorInput(),
			};
		}
		const s = parseLocal(this.startDate, this.startTime || '00:00');
		const e = parseLocal(this.endDate, this.endTime || '00:00');
		if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return null;
		return {
			title: this.title.trim(),
			allDay: false,
			start: fmtLocal(s),
			end: fmtLocal(e),
			description: this.description,
			location: this.location.trim(),
			...this.colorInput(),
		};
	}

	private validate(): void {
		if (this.saveButton) this.saveButton.disabled = this.busy || !this.input();
	}

	private async save(): Promise<void> {
		const input = this.input();
		if (!input || this.busy) return;
		this.busy = true;
		this.validate();
		try {
			const ev = this.params.event;
			if (ev) await this.plugin.calendars.patch(ev.calendarId, ev.id, ev.etag, input);
			else await this.plugin.calendars.insert(this.calendarId, input);
			this.plugin.notifyChanged();
			this.close();
		} catch (e) {
			new Notice(`Could not save to Google: ${errorMessage(e)}`);
			this.plugin.notifyChanged();
		} finally {
			this.busy = false;
			this.validate();
		}
	}

	private async remove(): Promise<void> {
		const ev = this.params.event;
		if (!ev || this.busy) return;
		this.busy = true;
		try {
			await this.plugin.calendars.remove(ev.calendarId, ev.id);
			this.plugin.notifyChanged();
			this.close();
		} catch (e) {
			new Notice(`Could not save to Google: ${errorMessage(e)}`);
		} finally {
			this.busy = false;
		}
	}
}
