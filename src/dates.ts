// Small date helpers on the native Date API so the plugin does not depend on moment's typings.

const pad = (n: number) => String(n).padStart(2, '0');

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date as YYYY-MM-DD. */
export function fmtDate(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local wall-clock time as HH:mm. */
export function fmtTime(d: Date): string {
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** RFC 3339 with the local UTC offset, e.g. 2026-09-10T10:00:00+09:00 (what Google shows verbatim). */
export function fmtLocal(d: Date): string {
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? '+' : '-';
	const abs = Math.abs(off);
	return `${fmtDate(d)}T${fmtTime(d)}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** YYYY-MM-DD HH:mm in local time. */
export function fmtDateTime(ms: number): string {
	const d = new Date(ms);
	return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** Parses YYYY-MM-DD (as a local date) or any ISO date-time string. */
export function parseDate(s: string): Date {
	const m = DATE_ONLY.exec(s);
	if (m) {
		const [y, mo, d] = s.split('-').map(Number) as [number, number, number];
		return new Date(y, mo - 1, d);
	}
	return new Date(s);
}

/** Local date-time from date and time inputs; invalid when either part is malformed. */
export function parseLocal(date: string, time: string): Date {
	if (!DATE_ONLY.test(date) || !/^\d{2}:\d{2}$/.test(time)) return new Date(NaN);
	const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
	const [h, mi] = time.split(':').map(Number) as [number, number];
	return new Date(y, mo - 1, d, h, mi);
}

/** YYYY-MM-DD shifted by whole days, across month and year ends. */
export function addDays(date: string, days: number): string {
	const d = parseDate(date);
	d.setDate(d.getDate() + days);
	return fmtDate(d);
}

/** "3m ago", "2h ago", "5d ago". */
export function fromNow(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 90) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}
