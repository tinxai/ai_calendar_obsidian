import { Notice } from 'obsidian';
import { addDays, fmtDate, fmtLocal, fmtTime, parseDate, parseLocal } from './dates';
import type GCalSync from './main';
import { EventModal, type EventModalParams } from './modal';
import type { GCalSettings } from './settings';
import { blockedMessage } from './view';

export interface CreateEventInit {
	/** YYYY-MM-DD. Without `start` the event is all-day. */
	date: string;
	/** HH:mm, local time. */
	start?: string;
	/** HH:mm on the same date; an hour after `start` when omitted. */
	end?: string;
	/** Defaults to the calendar an empty-slot click uses. */
	calendarId?: string;
}

/**
 * Reachable as `app.plugins.plugins['google-cal-sync'].api`, for dataviewjs blocks and other plugins.
 * Both calls open the modal the calendar opens and resolve once it closes. A device that cannot show
 * the calendar (no client, not logged in, locked) shows why in a notice and opens nothing.
 */
export interface GoogleCalSyncApi {
	/** The edit modal for an event in this device's cache. Rejects when the cache has no such event. */
	openEvent(calendarId: string, eventId: string): Promise<void>;
	/** The new-event modal, prefilled. Rejects on a malformed date or time, or an unknown calendar. */
	createEvent(init: CreateEventInit): Promise<void>;
}

export function createApi(plugin: GCalSync): GoogleCalSyncApi {
	const show = (params: () => EventModalParams): Promise<void> => {
		const blocked = blockedMessage(plugin);
		if (blocked) {
			new Notice(blocked);
			return Promise.resolve();
		}
		const modal = new EventModal(plugin, params());
		modal.open();
		return modal.closed;
	};
	return {
		openEvent: async (calendarId, eventId) =>
			show(() => {
				const event = plugin.cache.calendar(calendarId)?.events[eventId];
				if (!event) throw new Error(`No cached event ${eventId} in calendar ${calendarId}`);
				return { event };
			}),
		createEvent: async (init) => show(() => createParams(init, plugin.settings.calendars)),
	};
}

/** Checks an outside caller's input and turns it into the modal's prefill, the way an empty-slot click would. */
export function createParams(
	init: CreateEventInit,
	calendars: GCalSettings['calendars'],
): EventModalParams {
	const { date, start, end, calendarId } = init ?? {};
	if (typeof date !== 'string' || fmtDate(parseDate(date)) !== date)
		throw new Error(`date must be YYYY-MM-DD, got ${String(date)}`);
	if (calendarId !== undefined && !calendars[calendarId])
		throw new Error(`Unknown calendar ${calendarId}`);
	const time = (name: string, value: string) => {
		const d = parseLocal(date, value);
		if (Number.isNaN(d.getTime()) || fmtTime(d) !== value)
			throw new Error(`${name} must be HH:mm, got ${value}`);
		return d;
	};
	if (start === undefined) {
		if (end !== undefined) throw new Error('end needs a start');
		return { calendarId, allDay: true, start: date, end: addDays(date, 1) };
	}
	const s = time('start', start);
	if (end === undefined) return { calendarId, allDay: false, start: fmtLocal(s) };
	const e = time('end', end);
	if (e < s) throw new Error(`end ${end} is before start ${start}`);
	return { calendarId, allDay: false, start: fmtLocal(s), end: fmtLocal(e) };
}
