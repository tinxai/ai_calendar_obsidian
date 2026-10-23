import type { CachedEvent, EventGuest } from './cache';
import type { EventInput } from './calendar';
import { addDays, fmtDate, fmtLocal, fmtTime, parseDate, parseLocal } from './dates';
import { NEW_EVENT_COLOR_ID } from './event-defaults';

export interface EventDraft {
	title: string;
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	allDay: boolean;
	location: string;
	notes: string;
	links: string;
	participants: string;
}
export function splitEventDescription(description: string): { notes: string; links: string } {
	const match = /\n\nLinks:\n((?:https?:\/\/\S+[\t ]*\n?)+)$/.exec(description);
	return match
		? { notes: description.slice(0, match.index), links: match[1]?.trim() ?? '' }
		: { notes: description, links: '' };
}
export function eventDraft(event: CachedEvent): EventDraft {
	const start = parseDate(event.start),
		end = parseDate(event.end || event.start);
	const description = splitEventDescription(event.description);
	return {
		title: event.title,
		allDay: event.allDay,
		startDate: fmtDate(start),
		startTime: event.allDay ? '09:00' : fmtTime(start),
		endDate: event.allDay ? addDays(event.end || addDays(event.start, 1), -1) : fmtDate(end),
		endTime: event.allDay ? '10:00' : fmtTime(end),
		location: event.location,
		notes: description.notes,
		links: description.links,
		participants: (event.attendees ?? []).map((guest) => guest.email).join('\n'),
	};
}
function guests(value: string, original: EventGuest[]): EventGuest[] {
	const emails = [
		...new Set(
			value
				.split(/[\s,;]+/)
				.map((email) => email.trim().toLowerCase())
				.filter(Boolean),
		),
	];
	if (emails.some((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))
		throw new Error('Enter a valid email address for each participant.');
	return emails.map(
		(email) => original.find((guest) => guest.email.toLowerCase() === email) ?? { email },
	);
}
/** Only changed fields are sent; edits from another device are never silently replaced. */
export function eventDraftPatch(
	base: CachedEvent,
	draft: EventDraft,
	latest: CachedEvent,
): Partial<EventInput> {
	const original = eventDraft(base),
		patch: Partial<EventInput> = {};
	const check = (key: keyof EventInput) => {
		if (
			JSON.stringify(base[key as keyof CachedEvent]) !==
			JSON.stringify(latest[key as keyof CachedEvent])
		)
			throw new Error(
				'This field changed elsewhere. Your draft is kept; reload the event to use the latest version.',
			);
	};
	if (draft.title !== original.title) {
		if (!draft.title.trim()) throw new Error('Enter an event title.');
		check('title');
		patch.title = draft.title.trim();
	}
	if (draft.location !== original.location) {
		check('location');
		patch.location = draft.location;
	}
	if (draft.notes !== original.notes || draft.links !== original.links) {
		check('description');
		const links = draft.links
			.split('\n')
			.map((value) => value.trim())
			.filter(Boolean);
		for (const link of links) {
			const url = new URL(link);
			if (!['https:', 'http:'].includes(url.protocol))
				throw new Error('Links must start with https:// or http://.');
		}
		patch.description = draft.notes + (links.length ? `\n\nLinks:\n${links.join('\n')}` : '');
	}
	if (draft.participants !== original.participants) {
		check('attendees');
		patch.attendees = guests(draft.participants, latest.attendees ?? []);
	}
	if (
		['startDate', 'startTime', 'endDate', 'endTime', 'allDay'].some(
			(key) => draft[key as keyof EventDraft] !== original[key as keyof EventDraft],
		)
	) {
		check('start');
		check('end');
		check('allDay');
		const start = parseLocal(draft.startDate, draft.allDay ? '00:00' : draft.startTime);
		const end = parseLocal(draft.endDate, draft.allDay ? '00:00' : draft.endTime);
		if (
			Number.isNaN(start.getTime()) ||
			Number.isNaN(end.getTime()) ||
			(draft.allDay ? end < start : end <= start)
		)
			throw new Error('The end must be after the start.');
		patch.allDay = draft.allDay;
		patch.start = draft.allDay ? draft.startDate : fmtLocal(start);
		patch.end = draft.allDay ? addDays(draft.endDate, 1) : fmtLocal(end);
	}
	return patch;
}

function draftDaySpan(draft: EventDraft): number {
	const start = parseDate(draft.startDate),
		end = parseDate(draft.endDate);
	return Math.max(
		0,
		Math.round(
			(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) -
				Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
				86400000,
		),
	);
}

/** A single date field moves the whole event, retaining an existing multi-day span. */
export function moveDraftDate(draft: EventDraft, date: string): boolean {
	const parsed = parseLocal(date, '00:00');
	if (Number.isNaN(parsed.getTime()) || fmtDate(parsed) !== date) return false;
	const span = draftDaySpan(draft);
	draft.startDate = date;
	draft.endDate = addDays(date, span);
	return true;
}

/** Earlier end times mean the following day; existing longer events retain their day span. */
export function setDraftTime(
	draft: EventDraft,
	field: 'startTime' | 'endTime',
	value: string,
): void {
	const span = draftDaySpan(draft);
	const longerThanDay = span > 1 || (span === 1 && draft.endTime > draft.startTime);
	draft[field] = value;
	if (!draft.allDay && !longerThanDay)
		draft.endDate = addDays(draft.startDate, draft.endTime <= draft.startTime ? 1 : 0);
}

/** A new event must contain every required field, rather than an edit-only patch. */
export function newEventDraftInput(base: CachedEvent, draft: EventDraft): EventInput {
	if (!draft.title.trim()) throw new Error('Add a title to create the event.');
	return {
		title: draft.title.trim(),
		start: base.start,
		end: base.end,
		allDay: base.allDay,
		description: base.description,
		location: base.location,
		colorId: base.colorId || NEW_EVENT_COLOR_ID,
		attendees: base.attendees ?? [],
		...eventDraftPatch(base, draft, base),
	};
}
