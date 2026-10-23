import type { CachedEvent, CalendarCache, EventLabel } from './cache';
import { EVENT_COLORS } from './event-colors';
import type { PlanPeriod } from './planner-model';

type Completion = 'completed' | 'not_marked_complete' | 'unknown_color';

/** The user's convention applies to explicitly selected event colors, never a day's gray shading. */
export function calendarCompletion(
	event: CachedEvent,
	labels: EventLabel[] = [],
): {
	completion: Completion;
	color: string | null;
	evidence: string;
} {
	let color: string | undefined;
	if (event.eventLabelId) {
		color = labels.find((label) => label.id === event.eventLabelId)?.backgroundColor;
		if (!color)
			return {
				completion: 'unknown_color',
				color: null,
				evidence:
					'Event label is missing from the synced palette; completion cannot be determined.',
			};
	} else if (event.colorId) {
		color = EVENT_COLORS[event.colorId];
		if (!color)
			return {
				completion: 'unknown_color',
				color: null,
				evidence:
					'Event color is not in the synced palette; completion cannot be determined.',
			};
	}
	// Includes Graphite in modern/classic palettes and neutral custom gray labels.
	const channels = color
		?.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
		?.slice(1)
		.map((part) => Number.parseInt(part, 16));
	const gray =
		channels &&
		Math.max(...channels) - Math.min(...channels) <= 12 &&
		Math.min(...channels) >= 40 &&
		Math.max(...channels) <= 235;
	return {
		completion: gray ? 'completed' : 'not_marked_complete',
		color: color ?? null,
		evidence: gray
			? 'User explicitly colors completed events gray.'
			: 'This event has not been explicitly colored gray; completion is not recorded.',
	};
}

export interface PlanningCalendar {
	id: string;
	name: string;
	enabled: boolean;
	cache: CalendarCache | null;
}

/** Snapshot preserves stable event identity and individual recurring occurrences for evidence. */
export function planningCalendarSnapshot(
	calendars: PlanningCalendar[],
	period: PlanPeriod,
	lastSyncedAt: number,
	syncError = '',
) {
	const start = new Date(`${period.start}T00:00:00`).getTime();
	const nextDay = new Date(`${period.end}T00:00:00`);
	nextDay.setDate(nextDay.getDate() + 1);
	const end = nextDay.getTime();
	const slots = calendars
		.filter((calendar) => calendar.enabled)
		.flatMap((calendar) =>
			Object.values(calendar.cache?.events ?? {}).flatMap((event) => {
				const begins = new Date(
					event.allDay ? `${event.start}T00:00:00` : event.start,
				).getTime();
				const ends = event.end
					? new Date(event.allDay ? `${event.end}T00:00:00` : event.end).getTime()
					: begins;
				if (
					!Number.isFinite(begins) ||
					!Number.isFinite(ends) ||
					begins >= end ||
					(ends > begins ? ends <= start : begins < start)
				)
					return [];
				return [
					{
						id: event.id,
						calendarId: calendar.id,
						title: event.title,
						calendar: calendar.name,
						start: event.start,
						end: event.end,
						allDay: event.allDay,
						...calendarCompletion(event, calendar.cache?.labels),
					},
				];
			}),
		)
		.sort(
			(a, b) =>
				a.start.localeCompare(b.start) ||
				a.calendarId.localeCompare(b.calendarId) ||
				a.id.localeCompare(b.id),
		);
	return {
		period: period.week,
		lastSyncedAt: lastSyncedAt || null,
		syncError: syncError || null,
		completionRule:
			'Explicit gray event color means completed work. Other events are not marked complete. Calendar defaults and day shading do not indicate completion.',
		total: slots.length,
		completed: slots.filter((slot) => slot.completion === 'completed').length,
		notMarkedComplete: slots.filter((slot) => slot.completion === 'not_marked_complete').length,
		unknownColor: slots.filter((slot) => slot.completion === 'unknown_color').length,
		slots: slots.slice(0, 300),
		omitted: Math.max(0, slots.length - 300),
	};
}
