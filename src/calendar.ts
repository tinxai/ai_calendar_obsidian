import type { Cache, CachedEvent, CalendarCache, EventGuest, EventLabel } from './cache';
import { type GoogleClient, GoogleError } from './google';

const API = 'https://www.googleapis.com/calendar/v3';
const PAST_MONTHS = 3;
const FUTURE_MONTHS = 6;
export const CACHE_WARN_COUNT = 5000;

interface GoogleTime {
	date?: string | null;
	dateTime?: string | null;
	timeZone?: string;
}

export interface GoogleEvent {
	id: string;
	etag?: string;
	status?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: GoogleTime;
	end?: GoogleTime;
	recurringEventId?: string;
	colorId?: string;
	eventLabelId?: string;
	attendees?: EventGuest[];
}

interface EventList {
	items?: GoogleEvent[];
	nextPageToken?: string;
	nextSyncToken?: string;
}

export interface CalendarListEntry {
	id: string;
	name: string;
	color: string;
	primary: boolean;
}

/** Fields the UI can write. `start`/`end` are ISO date-times, or YYYY-MM-DD when allDay (end exclusive). */
export interface EventInput {
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	description: string;
	location: string;
	colorId?: string;
	eventLabelId?: string;
	attendees?: EventGuest[];
}

export async function listCalendars(g: GoogleClient): Promise<CalendarListEntry[]> {
	const out: CalendarListEntry[] = [];
	let pageToken: string | undefined;
	do {
		const page = await g.call<{
			items?: Array<{
				id: string;
				summary?: string;
				summaryOverride?: string;
				backgroundColor?: string;
				primary?: boolean;
			}>;
			nextPageToken?: string;
		}>('GET', `${API}/users/me/calendarList`, {
			query: { pageToken, minAccessRole: 'reader' },
		});
		for (const c of page.items ?? []) {
			out.push({
				id: c.id,
				name: c.summaryOverride || c.summary || c.id,
				color: c.backgroundColor ?? '',
				primary: !!c.primary,
			});
		}
		pageToken = page.nextPageToken;
	} while (pageToken);
	return out;
}

export function fromGoogle(calendarId: string, e: GoogleEvent): CachedEvent {
	const allDay = !!e.start?.date;
	return {
		id: e.id,
		calendarId,
		title: e.summary?.trim() || '(No title)',
		start: (allDay ? e.start?.date : e.start?.dateTime) ?? '',
		end: (allDay ? e.end?.date : e.end?.dateTime) ?? '',
		allDay,
		description: e.description ?? '',
		location: e.location ?? '',
		recurringEventId: e.recurringEventId ?? null,
		etag: e.etag ?? '',
		colorId: e.colorId ?? '',
		eventLabelId: e.eventLabelId ?? '',
		attendees: e.attendees ?? [],
	};
}

/** Builds a Google event body from the changed fields. `nullOthers` clears the unused date/dateTime on patch. */
export function toGoogle(input: Partial<EventInput>, nullOthers: boolean): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (input.title !== undefined) body.summary = input.title;
	if (input.description !== undefined) body.description = input.description;
	if (input.attendees !== undefined) body.attendees = input.attendees;
	if (input.location !== undefined) body.location = input.location;
	if (input.colorId !== undefined) body.colorId = input.colorId || null;
	if (input.eventLabelId !== undefined) body.eventLabelId = input.eventLabelId;
	const time = (v: string, allDay: boolean): GoogleTime =>
		allDay
			? nullOthers
				? { date: v, dateTime: null }
				: { date: v }
			: nullOthers
				? { dateTime: v, date: null }
				: { dateTime: v };
	if (input.start !== undefined && input.allDay !== undefined)
		body.start = time(input.start, input.allDay);
	if (input.end !== undefined && input.allDay !== undefined)
		body.end = time(input.end, input.allDay);
	return body;
}

function isoDate(d: Date): string {
	return d.toISOString();
}

export class CalendarSync {
	constructor(
		private g: GoogleClient,
		private cache: Cache,
	) {}

	/** Incremental sync with syncToken; full sync over a bounded window when there is none or Google answers 410. */
	async sync(calendarId: string): Promise<CalendarCache> {
		let state = this.cache.calendar(calendarId) ?? {
			syncToken: '',
			syncedAt: 0,
			events: {},
		};
		// Old sync tokens would return only changed events, leaving historical colors missing forever.
		if (state.colorVersion !== 1 || state.detailsVersion !== 1)
			state = { syncToken: '', syncedAt: 0, events: {} };
		// Labels can change color without the events themselves being modified.
		const metadata = await this.g.call<{ labelProperties?: { eventLabels?: EventLabel[] } }>(
			'GET',
			`${API}/calendars/${encodeURIComponent(calendarId)}`,
		);
		const labels = metadata.labelProperties?.eventLabels ?? [];
		try {
			state = await this.fetch(calendarId, state);
		} catch (e) {
			if (!(e instanceof GoogleError) || e.status !== 410) throw e;
			this.cache.clearCalendar(calendarId);
			state = await this.fetch(calendarId, {
				syncToken: '',
				syncedAt: 0,
				events: {},
			});
		}
		state.colorVersion = 1;
		state.detailsVersion = 1;
		state.labels = labels;
		this.cache.saveCalendar(calendarId, state);
		return state;
	}

	private async fetch(calendarId: string, state: CalendarCache): Promise<CalendarCache> {
		const events = { ...state.events };
		const full = !state.syncToken;
		const now = new Date();
		const timeMin = new Date(now.getFullYear(), now.getMonth() - PAST_MONTHS, 1);
		const timeMax = new Date(now.getFullYear(), now.getMonth() + FUTURE_MONTHS + 1, 1);
		let pageToken: string | undefined;
		let syncToken = state.syncToken;
		do {
			const page = await this.g.call<EventList>(
				'GET',
				`${API}/calendars/${encodeURIComponent(calendarId)}/events`,
				{
					query: {
						eventLabelVersion: 1,
						singleEvents: true,
						showDeleted: true,
						maxResults: 2500,
						pageToken,
						syncToken: full ? undefined : state.syncToken,
						timeMin: full ? isoDate(timeMin) : undefined,
						timeMax: full ? isoDate(timeMax) : undefined,
					},
				},
			);
			for (const item of page.items ?? []) {
				if (item.status === 'cancelled') delete events[item.id];
				else events[item.id] = fromGoogle(calendarId, item);
			}
			pageToken = page.nextPageToken;
			if (page.nextSyncToken) syncToken = page.nextSyncToken;
		} while (pageToken);
		return { ...state, syncToken, syncedAt: Date.now(), events };
	}

	async insert(calendarId: string, input: EventInput, id?: string): Promise<CachedEvent> {
		const created = await this.g.call<GoogleEvent>(
			'POST',
			`${API}/calendars/${encodeURIComponent(calendarId)}/events`,
			{
				body: { ...toGoogle(input, false), ...(id ? { id } : {}) },
				query: {
					eventLabelVersion: input.eventLabelId !== undefined ? 1 : undefined,
					sendUpdates: input.attendees !== undefined ? 'none' : undefined,
				},
			},
		);
		return this.upsert(calendarId, created);
	}

	/** Patches only the given fields. Sends If-Match so a change made elsewhere is not overwritten (412). */
	async patch(
		calendarId: string,
		id: string,
		etag: string,
		changes: Partial<EventInput>,
	): Promise<CachedEvent> {
		const url = `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`;
		const cached = this.cache.calendar(calendarId)?.events[id];
		// A time/title edit must preserve the label, including when dragging an event.
		if (
			changes.colorId === undefined &&
			changes.eventLabelId === undefined &&
			cached?.eventLabelId
		)
			changes = { ...changes, eventLabelId: cached.eventLabelId };
		try {
			const updated = await this.g.call<GoogleEvent>('PATCH', url, {
				body: toGoogle(changes, true),
				headers: etag ? { 'If-Match': etag } : {},
				query: {
					eventLabelVersion: changes.eventLabelId !== undefined ? 1 : undefined,
					sendUpdates: changes.attendees !== undefined ? 'none' : undefined,
				},
			});
			return this.upsert(calendarId, updated);
		} catch (e) {
			if (e instanceof GoogleError && e.status === 412) {
				const fresh = await this.g.call<GoogleEvent>('GET', url, {
					query: { eventLabelVersion: 1 },
				});
				this.upsert(calendarId, fresh);
				throw new GoogleError(
					412,
					'This event was changed elsewhere. The calendar has been refreshed; try again.',
				);
			}
			throw e;
		}
	}

	async remove(calendarId: string, id: string): Promise<void> {
		try {
			await this.g.call(
				'DELETE',
				`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
			);
		} catch (e) {
			if (!(e instanceof GoogleError) || (e.status !== 404 && e.status !== 410)) throw e;
		}
		const state = this.cache.calendar(calendarId);
		if (state && state.events[id]) {
			delete state.events[id];
			this.cache.saveCalendar(calendarId, state);
		}
	}

	private upsert(calendarId: string, e: GoogleEvent): CachedEvent {
		const ev = fromGoogle(calendarId, e);
		const state = this.cache.calendar(calendarId) ?? {
			syncToken: '',
			syncedAt: 0,
			events: {},
		};
		if (e.status === 'cancelled') delete state.events[ev.id];
		else state.events[ev.id] = ev;
		this.cache.saveCalendar(calendarId, state);
		return ev;
	}
}
