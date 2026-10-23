import type { App } from 'obsidian';

export interface EventGuest {
	email: string;
	displayName?: string;
	responseStatus?: string;
	optional?: boolean;
	organizer?: boolean;
	self?: boolean;
	resource?: boolean;
	comment?: string;
	additionalGuests?: number;
}

export interface CachedEvent {
	id: string;
	calendarId: string;
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	description: string;
	location: string;
	recurringEventId: string | null;
	etag: string;
	/** Google Calendar event color id; empty means the calendar default. */
	colorId: string;
	eventLabelId?: string;
	attendees?: EventGuest[];
}

export interface EventLabel {
	id: string;
	backgroundColor: string;
	name?: string;
}

export interface CalendarCache {
	syncToken: string;
	syncedAt: number;
	events: Record<string, CachedEvent>;
	/** Missing on old caches, which need a full sync to recover event colors. */
	colorVersion?: number;
	detailsVersion?: number;
	labels?: EventLabel[];
}

/** Previous sync's Google task ids → note path, used to tell "note deleted" from "never mirrored". */
export type TaskIndex = Record<string, string>;

/** The mirrored fields of one task, as a note and Google last agreed on them. */
export interface TaskFields {
	title: string;
	due: string;
	done: boolean;
}

export interface TaskState {
	/** Task id → fields both sides held after the last sync, so a change can be traced to the side that made it. */
	base: Record<string, TaskFields>;
	/** `note:<id>` or `task:<id>` → when this device first saw that side missing. */
	absent: Record<string, number>;
}

const PREFIX = 'google-cal-sync:';
const TASKS_KEY = `${PREFIX}tasks`;
const TASK_STATE_KEY = `${PREFIX}task-state`;

/** Per-device cache in Obsidian's vault-scoped localStorage. Never touches data.json. */
export class Cache {
	constructor(private app: App) {}

	calendar(calendarId: string): CalendarCache | null {
		const v = this.app.loadLocalStorage(PREFIX + calendarId) as Partial<CalendarCache> | null;
		if (!v || typeof v !== 'object' || !v.events) return null;
		return {
			colorVersion: v.colorVersion,
			detailsVersion: v.detailsVersion,
			labels: v.labels,
			syncToken: v.syncToken ?? '',
			syncedAt: v.syncedAt ?? 0,
			events: v.events,
		};
	}

	saveCalendar(calendarId: string, data: CalendarCache): void {
		this.app.saveLocalStorage(PREFIX + calendarId, data);
	}

	clearCalendar(calendarId: string): void {
		this.app.saveLocalStorage(PREFIX + calendarId, null);
	}

	taskIndex(): TaskIndex {
		const v = this.app.loadLocalStorage(TASKS_KEY) as TaskIndex | null;
		return v && typeof v === 'object' ? v : {};
	}

	saveTaskIndex(index: TaskIndex): void {
		this.app.saveLocalStorage(TASKS_KEY, index);
	}

	taskState(): TaskState {
		const v = this.app.loadLocalStorage(TASK_STATE_KEY) as Partial<TaskState> | null;
		return { base: v?.base ?? {}, absent: v?.absent ?? {} };
	}

	saveTaskState(state: TaskState): void {
		this.app.saveLocalStorage(TASK_STATE_KEY, state);
	}

	/** Drops the event caches. The task index and state are not a cache: without them a device cannot tell its own notes from new ones. */
	clearAll(calendarIds: string[]): void {
		for (const id of calendarIds) this.clearCalendar(id);
	}

	/** Forgets everything about tasks, for logging out. */
	clearTasks(): void {
		this.app.saveLocalStorage(TASKS_KEY, null);
		this.app.saveLocalStorage(TASK_STATE_KEY, null);
	}
}
