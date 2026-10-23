import type { CachedEvent, EventLabel } from './cache';

/** Google Calendar's modern standard per-event color palette (legacy colorId 1–11). */
export const EVENT_COLORS: Record<string, string> = {
	'1': '#7986cb', // Lavender
	'2': '#33b679', // Sage
	'3': '#8e24aa', // Grape
	'4': '#e67c73', // Flamingo
	'5': '#f6bf26', // Banana
	'6': '#f4511e', // Tangerine
	'7': '#039be5', // Peacock
	'8': '#616161', // Graphite
	'9': '#3f51b5', // Blueberry
	'10': '#0b8043', // Basil
	'11': '#d50000', // Tomato
};

export const EVENT_COLOR_NAMES: Record<string, string> = {
	'1': 'Lavender blue',
	'2': 'Sage',
	'3': 'Grape',
	'4': 'Flamingo',
	'5': 'Banana',
	'6': 'Tangerine',
	'7': 'Peacock',
	'8': 'Graphite',
	'9': 'Blueberry',
	'10': 'Basil',
	'11': 'Tomato',
};

export function eventColor(
	event: Pick<CachedEvent, 'colorId' | 'eventLabelId'>,
	labels: EventLabel[] | undefined,
	calendarColor?: string,
): string | undefined {
	return (
		labels?.find((label) => label.id === event.eventLabelId)?.backgroundColor ||
		EVENT_COLORS[event.colorId] ||
		calendarColor
	);
}

export interface EventColorChoice {
	name: string;
	color: string;
	selected: boolean;
	changes: { colorId: string } | { eventLabelId: string };
}

/** Include modern custom labels plus standard colors missing from the label palette. */
export function eventColorChoices(
	event: Pick<CachedEvent, 'colorId' | 'eventLabelId'>,
	labels: EventLabel[] = [],
	calendarColor = 'var(--interactive-accent)',
): EventColorChoice[] {
	const choices: EventColorChoice[] = [
		{
			name: 'Calendar default',
			color: calendarColor,
			selected: !event.colorId && !event.eventLabelId,
			changes: labels.length || event.eventLabelId ? { eventLabelId: '' } : { colorId: '' },
		},
	];
	for (const label of labels)
		choices.push({
			name: label.name || label.backgroundColor,
			color: label.backgroundColor,
			selected: event.eventLabelId === label.id,
			changes: { eventLabelId: label.id },
		});
	for (const [id, name] of Object.entries(EVENT_COLOR_NAMES)) {
		if (
			labels.some(
				(label) => label.backgroundColor.toLowerCase() === EVENT_COLORS[id]?.toLowerCase(),
			)
		)
			continue;
		choices.push({
			name: id === '8' ? 'Graphite · completed' : name,
			color: EVENT_COLORS[id] ?? calendarColor,
			selected: !event.eventLabelId && event.colorId === id,
			changes: { colorId: id },
		});
	}
	return choices;
}
