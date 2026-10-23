import type { Component } from 'obsidian';
import { Notice } from 'obsidian';
import type { CachedEvent } from './cache';
import type { EventInput } from './calendar';
import { addDays, fmtDate, fmtLocal, fmtTime, parseDate, parseLocal } from './dates';
import type GCalSync from './main';
import { errorMessage } from './settings';

export interface PasteTarget {
	start: string;
	allDay: boolean;
}
let clipboard: { event: CachedEvent; cut: boolean } | null = null;

/** Preserve duration and event type when placing a copy on a new calendar slot. */
export function pastedEventInput(event: CachedEvent, target: PasteTarget | null): EventInput {
	const input: EventInput = {
		title: event.title,
		start: event.start,
		end: event.end,
		allDay: event.allDay,
		description: event.description,
		location: event.location,
		...(event.eventLabelId ? { eventLabelId: event.eventLabelId } : { colorId: event.colorId }),
		...(event.attendees
			? {
					attendees: event.attendees.map((guest) => ({
						email: guest.email,
						optional: guest.optional,
					})),
				}
			: {}),
	};
	if (!target) return input;
	const date = fmtDate(parseDate(target.start));
	if (event.allDay) {
		const from = parseDate(event.start),
			to = parseDate(event.end || addDays(event.start, 1));
		const days = Math.max(
			1,
			Math.round(
				(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) -
					Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) /
					86400000,
			),
		);
		input.start = date;
		input.end = addDays(date, days);
	} else {
		const start = target.allDay
			? parseLocal(date, fmtTime(parseDate(event.start)))
			: parseDate(target.start);
		const duration =
			Math.max(0, parseDate(event.end).getTime() - parseDate(event.start).getTime()) ||
			3600000;
		input.start = fmtLocal(start);
		input.end = fmtLocal(new Date(start.getTime() + duration));
	}
	return input;
}

export class CalendarEventActions {
	private selected: CachedEvent | null = null;
	private target: PasteTarget | null = null;
	private choosingTarget = false;
	private busy = false;
	private selectionVersion = 0;
	constructor(
		private plugin: GCalSync,
		owner: Component,
		private root: HTMLElement,
		private pasted?: (event: CachedEvent) => void,
	) {
		let engaged = false;
		const doc = root.ownerDocument;
		const eligible = () => {
			const active = doc.activeElement;
			if (!active || (!root.contains(active) && !(engaged && active.contains(root))))
				return false;
			const editor = active.closest(
				'input, textarea, select, [contenteditable="true"], .gcal-planner',
			);
			// Live Preview itself is contenteditable; only editors INSIDE this calendar block opt out.
			if (editor && root.contains(editor)) return false;
			const selection = doc.getSelection();
			return !(
				selection?.toString() &&
				selection.anchorNode &&
				root.contains(selection.anchorNode)
			);
		};
		owner.registerDomEvent(
			doc,
			'pointerdown',
			(event) => {
				engaged = !!event.target && root.contains(event.target as Node);
			},
			{ capture: true },
		);
		const keyboard = (event: KeyboardEvent) => {
			if (!eligible() || event.altKey || event.repeat) return;
			if (event.key === 'Escape') {
				this.choosingTarget = false;
				return;
			}
			if (
				(event.key === 'Delete' || event.key === 'Backspace') &&
				!event.metaKey &&
				!event.ctrlKey &&
				this.selected
			) {
				event.preventDefault();
				event.stopPropagation();
				void this.remove();
				return;
			}
			if ((!event.metaKey && !event.ctrlKey) || event.shiftKey) return;
			const key = event.key.toLowerCase();
			if (
				!['c', 'x', 'v', 'd'].includes(key) ||
				(key !== 'v' && !this.selected) ||
				(key === 'v' && !clipboard)
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			if (key === 'c') this.copy(false);
			if (key === 'x') this.copy(true);
			if (key === 'v') void this.paste();
			if (key === 'd') this.duplicate();
		};
		// Window capture precedes Obsidian's editor-level shortcuts in Live Preview.
		if (doc.defaultView)
			owner.registerDomEvent(doc.defaultView, 'keydown', keyboard, { capture: true });
		else owner.registerDomEvent(doc, 'keydown', keyboard, { capture: true });
		for (const type of ['copy', 'cut', 'paste'] as const) {
			owner.registerDomEvent(
				doc,
				type,
				(event) => {
					if (!eligible() || (type === 'paste' ? !clipboard : !this.selected)) return;
					event.preventDefault();
					event.stopPropagation();
					if (type === 'paste') void this.paste();
					else {
						this.copy(type === 'cut');
						event.clipboardData?.setData('text/plain', this.selected?.title ?? '');
					}
				},
				{ capture: true },
			);
		}
	}
	clearSelection(): void {
		this.selectionVersion++;
		this.selected = null;
	}

	select(event: CachedEvent, focus = true): void {
		this.selectionVersion++;
		this.selected = this.plugin.cache.calendar(event.calendarId)?.events[event.id] ?? event;
		this.target = null;
		this.root.tabIndex = -1;
		if (focus) this.root.focus({ preventScroll: true });
	}
	/** After copy/cut, an empty-slot click chooses the paste position instead of opening a new event. */
	place(target: PasteTarget, createRange = false): boolean {
		this.target = target;
		if (createRange) this.choosingTarget = false;
		if (!clipboard || !this.choosingTarget) return false;
		this.root.focus({ preventScroll: true });
		return true;
	}
	copy(cut = false, announce = true): void {
		if (!this.selected) return;
		const latest =
			this.plugin.cache.calendar(this.selected.calendarId)?.events[this.selected.id] ??
			this.selected;
		clipboard = { event: structuredClone(latest), cut };
		this.choosingTarget = true;
		this.target = null;
		this.root.focus({ preventScroll: true });
		if (announce)
			new Notice(
				cut
					? 'Event cut. Choose a time and paste to move it.'
					: 'Event copied. Paste now, or choose a time first.',
			);
	}
	duplicate(): void {
		if (!this.selected) return;
		this.copy(false, false);
		void this.paste();
	}

	async paste(): Promise<void> {
		if (!clipboard || this.busy) return;
		const copied = clipboard,
			target = this.target,
			version = this.selectionVersion;
		this.busy = true;
		try {
			const event = copied.event;
			let pasted: CachedEvent;
			if (copied.cut) {
				const latest = this.plugin.cache.calendar(event.calendarId)?.events[event.id];
				if (!latest) throw new Error('The source event is no longer available.');
				const input = pastedEventInput(latest, target);
				pasted = await this.plugin.calendars.patch(
					latest.calendarId,
					latest.id,
					latest.etag,
					{ start: input.start, end: input.end, allDay: input.allDay },
				);
				if (clipboard === copied) clipboard = null;
			} else
				pasted = await this.plugin.calendars.insert(
					event.calendarId,
					pastedEventInput(event, target),
				);
			if (version === this.selectionVersion) {
				this.selected = pasted;
				this.pasted?.(pasted);
			}
			this.choosingTarget = false;
			this.plugin.notifyChanged();
			new Notice(copied.cut ? 'Event moved' : 'Event pasted');
		} catch (error) {
			new Notice(`Could not paste event: ${errorMessage(error)}`);
		} finally {
			this.busy = false;
		}
	}
	async remove(): Promise<void> {
		if (!this.selected || this.busy) return;
		const event = this.selected;
		this.busy = true;
		try {
			await this.plugin.calendars.remove(event.calendarId, event.id);
			if (this.selected?.id === event.id && this.selected.calendarId === event.calendarId)
				this.selected = null;
			this.plugin.notifyChanged();
		} catch (error) {
			new Notice(`Could not delete event: ${errorMessage(error)}`);
		} finally {
			this.busy = false;
		}
	}
}
