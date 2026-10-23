import type { Component } from 'obsidian';

export interface CalendarSwipe {
	suppressSelection: () => boolean;
}
type Direction = 'previous' | 'next';
interface Drag {
	x: number;
	y: number;
	started: number;
	direction: Direction | null;
	vertical: boolean;
}

/** A horizontal gesture changes the displayed period; event drags and vertical scrolling stay native. */
export function registerCalendarSwipe(
	owner: Component,
	root: HTMLElement,
	navigate: (direction: Direction) => void,
): CalendarSwipe {
	let drag: Drag | null = null;
	let suppressUntil = 0;
	let wheelSum = 0,
		wheelAt = 0,
		wheelLocked = false;
	let wheelDirection = 0,
		lastAmount = 0,
		lastNavigation = 0,
		decayed = false,
		tailMinimum = Infinity;
	let pending = 0;
	const view = root.ownerDocument.defaultView ?? window;
	const inCalendar = (target: EventTarget | null): target is HTMLElement =>
		!!(target as HTMLElement | null)?.closest?.('.gcal-calendar');
	const editable = (target: HTMLElement) =>
		!!target.closest(
			'button, input, textarea, select, [contenteditable="true"], .fc-event, .fc-popover',
		) ||
		(!!target.closest('a') && !target.closest('.fc-col-header-cell'));
	const canScroll = (target: HTMLElement, dx: number) => {
		for (let el: HTMLElement | null = target; el; el = el.parentElement) {
			if (
				(el === root || el.classList.contains('fc-scroller')) &&
				el.scrollWidth > el.clientWidth + 1 &&
				(dx > 0 ? el.scrollLeft < el.scrollWidth - el.clientWidth - 1 : el.scrollLeft > 1)
			)
				return true;
			if (el === root) break;
		}
		return false;
	};
	let frame = 0,
		offset = 0;
	let motion: Animation | null = null;
	const harness = () => root.querySelector<HTMLElement>('.fc-view-harness');
	const resetPreview = () => {
		if (frame) view.cancelAnimationFrame?.(frame);
		frame = 0;
		offset = 0;
		const element = harness();
		if (element?.style) {
			element.style.removeProperty('transform');
		}
	};
	const preview = (amount: number) => {
		motion?.cancel();
		motion = null;
		offset = Math.max(-100, Math.min(100, amount));
		const draw = () => {
			frame = 0;
			const element = harness();
			if (element?.style) {
				element.style.setProperty('transform', `translate3d(${offset}px, 0, 0)`);
			}
		};
		if (view.requestAnimationFrame) {
			if (!frame) frame = view.requestAnimationFrame(draw);
		} else draw();
	};
	const page = (direction: Direction) => {
		resetPreview();
		motion?.cancel();
		navigate(direction);
		const element = harness();
		if (element?.animate && !view.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
			motion = element.animate(
				[
					{
						transform: `translateX(${direction === 'next' ? 18 : -18}px)`,
						opacity: 0.85,
					},
					{ transform: 'translateX(0)', opacity: 1 },
				],
				{ duration: 100, easing: 'ease-out' },
			);
		}
	};
	const clear = () => {
		drag = null;
		root.classList.remove('is-week-swiping');
		resetPreview();
	};
	const begin = (x: number, y: number) => {
		drag = { x, y, started: Date.now(), direction: null, vertical: false };
	};
	const move = (x: number, y: number, touch = false) => {
		if (!drag || drag.vertical) return false;
		const dx = x - drag.x,
			dy = y - drag.y;
		if (
			!drag.direction &&
			((touch && Date.now() - drag.started > 350) ||
				(Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx) * 1.2))
		) {
			drag.vertical = true;
			return false;
		}
		if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2) preview(dx);
		if (Math.abs(dx) >= 28 && Math.abs(dx) > Math.abs(dy) * 1.3) {
			drag.direction = dx < 0 ? 'next' : 'previous';
			suppressUntil = Date.now() + 180;
			root.classList.add('is-week-swiping');
		}
		return !!drag.direction;
	};
	const finish = () => {
		const direction = drag?.direction;
		clear();
		if (!direction) return;
		suppressUntil = Date.now() + 180;
		// Let FullCalendar finish its mouse/touch selection lifecycle before replacing the view.
		if (pending) view.clearTimeout(pending);
		pending = view.setTimeout(() => {
			pending = 0;
			page(direction);
		}, 0);
	};
	owner.register(() => {
		clear();
		if (pending) view.clearTimeout(pending);
		motion?.cancel();
	});
	owner.registerDomEvent(
		root,
		'wheel',
		(event: WheelEvent) => {
			if (
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				event.defaultPrevented ||
				!inCalendar(event.target) ||
				root.querySelector('.fc-event-dragging, .fc-event-resizing')
			)
				return;
			const dx =
				event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)
					? event.deltaY
					: event.deltaX;
			if (
				!dx ||
				(!event.shiftKey && Math.abs(dx) <= Math.abs(event.deltaY) * 1.5) ||
				canScroll(event.target, dx)
			)
				return;
			event.preventDefault();
			const now = Date.now();
			const amount =
				dx * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientWidth : 1);
			const amplitude = Math.abs(amount),
				direction = Math.sign(amount);
			const fresh = now - wheelAt > 120;
			const reversed = direction !== wheelDirection && amplitude >= 6;
			const newPush =
				decayed &&
				amplitude >= Math.max(18, Math.min(lastAmount, tailMinimum) * 2.5) &&
				now - lastNavigation >= 80;
			if (fresh || reversed || newPush) {
				wheelSum = 0;
				wheelLocked = false;
				decayed = false;
				tailMinimum = Infinity;
			}
			wheelAt = now;
			if (amplitude < 12) {
				decayed = true;
				tailMinimum = Math.min(tailMinimum, amplitude);
			}
			lastAmount = amplitude;
			if (wheelLocked) return;
			if (direction !== Math.sign(wheelSum)) wheelSum = 0;
			wheelSum += amount;
			preview(-wheelSum);
			if (Math.abs(wheelSum) >= 32) {
				wheelLocked = true;
				wheelDirection = direction;
				lastNavigation = now;
				page(wheelSum > 0 ? 'next' : 'previous');
			}
		},
		{ passive: false },
	);
	owner.registerDomEvent(
		root,
		'mousedown',
		(event: MouseEvent) => {
			if (
				event.button !== 0 ||
				event.shiftKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				!inCalendar(event.target) ||
				editable(event.target)
			)
				return;
			begin(event.clientX, event.clientY);
		},
		{ capture: true },
	);
	owner.registerDomEvent(
		root.ownerDocument,
		'mousemove',
		(event: MouseEvent) => {
			if (!drag) return;
			if (!(event.buttons & 1)) {
				clear();
				return;
			}
			if (move(event.clientX, event.clientY)) event.preventDefault();
		},
		{ capture: true },
	);
	owner.registerDomEvent(root.ownerDocument, 'mouseup', finish);
	owner.registerDomEvent(
		root,
		'touchstart',
		(event: TouchEvent) => {
			const touch = event.touches[0];
			if (
				event.touches.length !== 1 ||
				!touch ||
				!inCalendar(event.target) ||
				editable(event.target)
			) {
				clear();
				return;
			}
			begin(touch.clientX, touch.clientY);
		},
		{ passive: true },
	);
	owner.registerDomEvent(
		root,
		'touchmove',
		(event: TouchEvent) => {
			const touch = event.touches[0];
			if (event.touches.length !== 1 || !touch) {
				clear();
				return;
			}
			if (
				inCalendar(event.target) &&
				canScroll(event.target, (drag?.x ?? touch.clientX) - touch.clientX)
			) {
				clear();
				return;
			}
			if (move(touch.clientX, touch.clientY, true)) {
				if (event.cancelable) event.preventDefault();
				event.stopPropagation();
			}
		},
		{ passive: false },
	);
	owner.registerDomEvent(root, 'touchend', finish);
	owner.registerDomEvent(root, 'touchcancel', clear);
	owner.registerDomEvent(view, 'blur', clear);
	return { suppressSelection: () => Date.now() < suppressUntil || !!drag?.direction };
}
