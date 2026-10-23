export function timeLabel(value: string): string {
	const [hour = 0, minute = 0] = value.split(':').map(Number);
	return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Explicit labels avoid the platform's segmented numeric time editor. */
export function timeChoices(current: string): Array<{ value: string; label: string }> {
	const values = Array.from(
		{ length: 96 },
		(_, index) =>
			`${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`,
	);
	if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(current) && !values.includes(current))
		values.push(current);
	return values.sort().map((value) => ({ value, label: timeLabel(value) }));
}
