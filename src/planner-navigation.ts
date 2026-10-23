import type { Plugin } from 'obsidian';

/** Navigate the board without taking pointer events from Kanban cards, grips or editors. */
export function registerPlannerNavigation(plugin: Plugin): void {
	const documents = new Set<Document>();
	const attach = (doc: Document) => {
		if (documents.has(doc)) return;
		documents.add(doc);
		let drag: { board: HTMLElement; x: number; y: number } | null = null;
		const stop = () => {
			drag?.board.classList.remove('planner-is-panning');
			drag = null;
		};
		plugin.register(stop);
		plugin.registerDomEvent(
			doc,
			'pointerdown',
			(event: PointerEvent) => {
				if (event.pointerType !== 'mouse' || (event.button !== 0 && event.button !== 1))
					return;
				const target = event.target as HTMLElement | null;
				if (
					!target?.closest ||
					target.closest(
						'.kanban-plugin__lane-wrapper, .kanban-plugin__item, .kanban-plugin__lane-header-wrapper, button, input, textarea, select, a, [contenteditable="true"], [data-ignore-drag]',
					)
				)
					return;
				const board = target.closest<HTMLElement>('.kanban-plugin__board');
				if (
					!board ||
					(board.scrollWidth <= board.clientWidth &&
						board.scrollHeight <= board.clientHeight)
				)
					return;
				event.preventDefault();
				event.stopPropagation();
				drag = { board, x: event.clientX, y: event.clientY };
				board.classList.add('planner-is-panning');
			},
			{ capture: true },
		);
		plugin.registerDomEvent(
			doc,
			'pointermove',
			(event: PointerEvent) => {
				if (!drag) return;
				if (!(event.buttons & 5)) {
					stop();
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				drag.board.scrollLeft += drag.x - event.clientX;
				drag.board.scrollTop += drag.y - event.clientY;
				drag.x = event.clientX;
				drag.y = event.clientY;
			},
			{ capture: true },
		);
		plugin.registerDomEvent(doc, 'pointerup', stop);
		plugin.registerDomEvent(doc, 'pointercancel', stop);
		const view = doc.defaultView;
		if (view) plugin.registerDomEvent(view, 'blur', stop);
		plugin.registerDomEvent(
			doc,
			'wheel',
			(event: WheelEvent) => {
				if (
					event.defaultPrevented ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey ||
					Math.abs(event.deltaX) >= Math.abs(event.deltaY)
				)
					return;
				const target = event.target as HTMLElement | null;
				if (
					!target?.closest ||
					target.closest('input, textarea, select, [contenteditable="true"]')
				)
					return;
				const board = target.closest<HTMLElement>(
					'.kanban-plugin__board.kanban-plugin__horizontal',
				);
				if (!board || board.scrollWidth <= board.clientWidth) return;
				// Let a tall lane consume its own vertical scrolling before moving the board sideways.
				for (
					let el: HTMLElement | null = target;
					el && el !== board;
					el = el.parentElement
				) {
					if (
						el.classList.contains('kanban-plugin__scroll-container') &&
						el.scrollHeight > el.clientHeight + 1 &&
						((event.deltaY > 0 &&
							el.scrollTop + el.clientHeight < el.scrollHeight - 1) ||
							(event.deltaY < 0 && el.scrollTop > 0))
					)
						return;
				}
				const previous = board.scrollLeft;
				const multiplier =
					event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? board.clientWidth : 1;
				board.scrollLeft += event.deltaY * multiplier;
				if (board.scrollLeft !== previous) event.preventDefault();
			},
			{ passive: false },
		);
	};
	attach(document);
	plugin.app.workspace.iterateAllLeaves((leaf) => attach(leaf.view.containerEl.ownerDocument));
	plugin.registerEvent(
		plugin.app.workspace.on('window-open', (_workspaceWindow, view) => attach(view.document)),
	);
}
