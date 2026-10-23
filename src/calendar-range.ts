/** Filter before handing events to FullCalendar, avoiding reparsing the entire multi-month cache per swipe. */
export function inCalendarRange(
	start: string,
	end: string,
	allDay: boolean,
	from?: Date,
	to?: Date,
): boolean {
	if (!from || !to) return true;
	const begins = Date.parse(
		allDay && /^\d{4}-\d{2}-\d{2}$/.test(start) ? `${start}T00:00:00` : start,
	);
	const finishes = end
		? Date.parse(allDay && /^\d{4}-\d{2}-\d{2}$/.test(end) ? `${end}T00:00:00` : end)
		: begins;
	return (
		Number.isFinite(begins) &&
		begins < to.getTime() &&
		(finishes > begins ? finishes > from.getTime() : begins >= from.getTime())
	);
}
