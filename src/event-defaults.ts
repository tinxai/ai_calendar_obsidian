import type { GCalSettings } from './settings';

export const NEW_EVENT_COLOR_ID = '10'; // Google Calendar green (Basil).

/** Google uses the account's real id for its primary calendar, not the literal alias "primary". */
export function newEventCalendar(settings: Pick<GCalSettings, 'calendars' | 'account'>): string {
	if (settings.account && settings.calendars[settings.account]?.enabled) return settings.account;
	if (settings.calendars.primary?.enabled) return 'primary';
	return (
		Object.entries(settings.calendars).find(
			([id, calendar]) => calendar.enabled && !id.includes('#holiday@'),
		)?.[0] ?? ''
	);
}
