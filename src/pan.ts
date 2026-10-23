import type { Component } from 'obsidian';

/** Pan without taking over event dragging or the calendar's normal range selection. */
export function registerCalendarPan(owner: Component, root: HTMLElement): void {
	let drag: { x: number; y: number; scrollers: HTMLElement[] } | null = null;
	const stop = () => {
		drag = null;
		root.removeClass('is-panning');
	};
	owner.register(stop);
	owner.registerDomEvent(
		root,
		'mousedown',
		(event: MouseEvent) => {
			if (event.button !== 1 && !(event.button === 0 && event.shiftKey)) return;
			const target = event.target as HTMLElement;
			if (target.closest('button, input, select, textarea, a, .fc-event')) return;
			const scrollers: HTMLElement[] = [];
			for (let el: HTMLElement | null = target; el; el = el.parentElement) {
				if (
					(el === root || el.classList.contains('fc-scroller')) &&
					(el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
				)
					scrollers.push(el);
				if (el === root) break;
			}
			if (!scrollers.length) return;
			event.preventDefault();
			event.stopPropagation();
			drag = { x: event.clientX, y: event.clientY, scrollers };
			root.addClass('is-panning');
		},
		{ capture: true },
	);
	owner.registerDomEvent(
		root.ownerDocument,
		'mousemove',
		(event: MouseEvent) => {
			if (!drag) return;
			event.preventDefault();
			event.stopPropagation();
			for (const el of drag.scrollers) {
				el.scrollLeft += drag.x - event.clientX;
				el.scrollTop += drag.y - event.clientY;
			}
			drag.x = event.clientX;
			drag.y = event.clientY;
		},
		{ capture: true },
	);
	owner.registerDomEvent(root.ownerDocument, 'mouseup', stop);
	const view = root.ownerDocument.defaultView;
	if (view) owner.registerDomEvent(view, 'blur', stop);
}
