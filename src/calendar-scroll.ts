import type { Calendar } from '@fullcalendar/core';
import type { Component } from 'obsidian';

export const SCROLL_DAYS = 49;
export const SCROLL_BUFFER = 21;
export function addCalendarDays(date: Date, days: number): Date {
	const value = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	value.setDate(value.getDate() + days);
	return value;
}
export function scrollingRange(date: Date): { start: Date; end: Date } {
	return {
		start: addCalendarDays(date, -SCROLL_BUFFER),
		end: addCalendarDays(date, SCROLL_DAYS - SCROLL_BUFFER),
	};
}
export function dayDifference(from: Date, to: Date): number {
	return Math.round(
		(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) -
			Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) /
			86400000,
	);
}
export interface CalendarScroller {
	prepare: (viewport: HTMLElement, content: HTMLElement, continuous: boolean) => void;
	dates: (continuous: boolean, start: Date, end: Date, anchor: Date) => void;
	resize: () => void;
	step: (days: number) => boolean;
	today: () => boolean;
	suppressSelection: () => boolean;
}

/** Wheel and touch use the browser's overflow scrolling. No gesture thresholds or week-page lock. */
export function registerCalendarScroll(
	owner: Component,
	root: HTMLElement,
	calendar: () => Calendar | null,
	label: (value: string) => void,
): CalendarScroller {
	let viewport: HTMLElement | null = null,
		content: HTMLElement | null = null;
	let continuous = false,
		rangeStart: Date | null = null,
		pendingDate: Date | null = null,
		pendingFraction = 0;
	let dayWidth = 180,
		suppressUntil = 0,
		frame = 0,
		edgeTimer = 0;
	let drag: {
		x: number;
		y: number;
		left: number;
		top: number;
		panning: boolean;
		force: boolean;
	} | null = null;
	const view = root.ownerDocument.defaultView ?? window;
	const clear = () => {
		drag = null;
		root.classList.remove('gcal-is-scrolling');
	};
	const stopTimers = () => {
		if (frame) view.cancelAnimationFrame(frame);
		if (edgeTimer) view.clearTimeout(edgeTimer);
		frame = 0;
		edgeTimer = 0;
	};
	const updateLabel = () => {
		if (!continuous || !viewport || !rangeStart) return;
		const first = addCalendarDays(rangeStart, Math.floor(viewport.scrollLeft / dayWidth));
		const last = addCalendarDays(
			first,
			Math.max(1, Math.ceil((viewport.clientWidth - 52) / dayWidth)) - 1,
		);
		const format: Intl.DateTimeFormatOptions = {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
		};
		label(
			`${first.toLocaleDateString(undefined, format)} – ${last.toLocaleDateString(undefined, format)}`,
		);
	};
	const width = () => {
		if (!viewport || !content) return;
		const position = viewport.scrollLeft / dayWidth;
		// Reserve the time axis and fit seven columns, including in narrow split panes.
		// Keep the previous width while the note is hidden and cannot be measured.
		if (viewport.clientWidth > 52) dayWidth = (viewport.clientWidth - 52) / 7;
		content.setCssProps({ width: continuous ? `${52 + SCROLL_DAYS * dayWidth}px` : '100%' });
		viewport.scrollLeft = continuous ? position * dayWidth : 0;
	};
	const scrollToDate = (date: Date, fraction = 0, smooth = false) => {
		if (!continuous || !viewport || !rangeStart) return false;
		const day = dayDifference(rangeStart, date) + fraction;
		if (day < 0 || day > SCROLL_DAYS - viewport.clientWidth / dayWidth) {
			pendingDate = date;
			pendingFraction = fraction;
			calendar()?.gotoDate(date);
			return true;
		}
		const left = day * dayWidth;
		if (smooth && viewport.scrollTo)
			viewport.scrollTo({
				left,
				behavior: view.matchMedia?.('(prefers-reduced-motion: reduce)').matches
					? 'auto'
					: 'smooth',
			});
		else viewport.scrollLeft = left;
		updateLabel();
		return true;
	};
	const rebase = () => {
		edgeTimer = 0;
		if (!continuous || !viewport || !rangeStart || drag) return;
		const day = viewport.scrollLeft / dayWidth,
			count = viewport.clientWidth / dayWidth;
		if (day >= 7 && day + count <= SCROLL_DAYS - 7) return;
		pendingDate = addCalendarDays(rangeStart, Math.floor(day));
		pendingFraction = day - Math.floor(day);
		calendar()?.gotoDate(pendingDate);
	};
	owner.register(() => {
		clear();
		stopTimers();
	});
	owner.registerDomEvent(
		root,
		'scroll',
		(event) => {
			if (event.target !== viewport || !continuous) return;
			if (!frame)
				frame = view.requestAnimationFrame(() => {
					frame = 0;
					updateLabel();
				});
			if (edgeTimer) view.clearTimeout(edgeTimer);
			edgeTimer = view.setTimeout(rebase, 160);
		},
		{ capture: true, passive: true },
	);
	owner.registerDomEvent(
		root,
		'mousedown',
		(event: MouseEvent) => {
			if (!viewport || (event.button !== 0 && event.button !== 1)) return;
			const target = event.target as HTMLElement | null;
			if (
				!target?.closest?.('.gcal-calendar-viewport') ||
				target.closest(
					'.fc-event, button, input, textarea, select, [contenteditable="true"], .gcal-color-popover',
				)
			)
				return;
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			const force = event.button === 1 || event.shiftKey;
			if (!continuous && !force) return;
			drag = {
				x: event.clientX,
				y: event.clientY,
				left: viewport.scrollLeft,
				top: viewport.scrollTop,
				panning: false,
				force,
			};
			if (force) event.preventDefault();
		},
		{ capture: true },
	);
	owner.registerDomEvent(
		root.ownerDocument,
		'mousemove',
		(event: MouseEvent) => {
			if (!drag || !viewport) return;
			if (!(event.buttons & 5)) {
				clear();
				return;
			}
			const dx = event.clientX - drag.x,
				dy = event.clientY - drag.y;
			if (!drag.force && !drag.panning && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) {
				clear();
				return;
			}
			if (
				drag.force ||
				drag.panning ||
				(Math.abs(dx) > 3 && Math.abs(dx) > Math.abs(dy) * 1.2)
			) {
				drag.panning = true;
				suppressUntil = Date.now() + 180;
				root.classList.add('gcal-is-scrolling');
				viewport.scrollLeft = drag.left - dx;
				if (drag.force) viewport.scrollTop = drag.top - dy;
				event.preventDefault();
			}
		},
		{ capture: true },
	);
	owner.registerDomEvent(root.ownerDocument, 'mouseup', () => {
		if (drag?.panning) suppressUntil = Date.now() + 180;
		clear();
	});
	owner.registerDomEvent(view, 'blur', clear);
	return {
		prepare: (outer, inner, active) => {
			stopTimers();
			viewport = outer;
			content = inner;
			continuous = active;
			rangeStart = null;
			pendingDate = null;
			viewport.classList.toggle('is-continuous', active);
			width();
		},
		dates: (active, start, _end, anchor) => {
			const entering = !continuous || !rangeStart;
			const first =
				pendingDate ??
				(entering
					? anchor
					: rangeStart && viewport
						? addCalendarDays(rangeStart, Math.floor(viewport.scrollLeft / dayWidth))
						: anchor);
			const fraction = pendingDate
				? pendingFraction
				: entering
					? 0
					: viewport
						? (viewport.scrollLeft / dayWidth) % 1
						: 0;
			continuous = active;
			rangeStart = start;
			viewport?.classList.toggle('is-continuous', active);
			width();
			pendingDate = null;
			pendingFraction = 0;
			if (active) scrollToDate(first, fraction);
			else viewport && (viewport.scrollLeft = 0);
		},
		resize: () => {
			width();
			updateLabel();
		},
		step: (days) => {
			if (!continuous || !rangeStart || !viewport) return false;
			const index = viewport.scrollLeft / dayWidth;
			return scrollToDate(
				addCalendarDays(rangeStart, Math.floor(index) + days),
				index % 1,
				true,
			);
		},
		today: () => scrollToDate(new Date(), 0, true),
		suppressSelection: () => !!drag?.panning || Date.now() < suppressUntil,
	};
}
