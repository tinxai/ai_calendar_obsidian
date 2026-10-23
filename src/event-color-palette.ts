import type { EventColorChoice } from './event-colors';

export interface EventMenuAction {
	name: string;
	shortcut?: string;
	destructive?: boolean;
	run: () => void | Promise<void>;
}
export interface ColorPopover {
	close: () => void;
}
export function swatchTextColor(color: string): string {
	const match = color.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
	if (!match) return '#ffffff';
	const [r, g, b] = match.slice(1).map((part) => Number.parseInt(part, 16));
	return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0) > 155 ? '#111111' : '#ffffff';
}

/** A compact swatch grid, rather than one menu row for every color label. */
export function showEventColorPalette(
	doc: Document,
	x: number,
	y: number,
	choices: EventColorChoice[],
	select: (choice: EventColorChoice) => void | Promise<void>,
	disabled = false,
	actions: EventMenuAction[] = [],
): ColorPopover {
	const popover = doc.body.createDiv({
		cls: actions.length ? 'gcal-color-popover gcal-event-context-menu' : 'gcal-color-popover',
		attr: { role: 'dialog', 'aria-label': 'Event color' },
	});
	if (!actions.length)
		popover.createDiv({ cls: 'gcal-color-popover-title', text: 'Event color' });
	const buttons: HTMLButtonElement[] = [];
	let closed = false;
	const view = doc.defaultView ?? window;
	const close = () => {
		if (closed) return;
		closed = true;
		doc.removeEventListener('pointerdown', outside, true);
		doc.removeEventListener('keydown', keyboard, true);
		doc.removeEventListener('scroll', scrolling, true);
		view.removeEventListener('resize', close);
		popover.remove();
	};
	const choose = (choice: EventColorChoice) => {
		if (disabled) return;
		close();
		void select(choice);
	};
	const defaultChoice = choices[0];
	if (defaultChoice) {
		const button = popover.createEl('button', {
			cls: 'gcal-color-default',
			text: 'Calendar default',
			attr: { type: 'button', 'aria-pressed': String(defaultChoice.selected) },
		});
		button.disabled = disabled;
		button.onclick = () => choose(defaultChoice);
		buttons.push(button);
	}
	const grid = popover.createDiv({
		cls: 'gcal-color-swatch-grid',
		attr: { role: 'group', 'aria-label': 'Event colors' },
	});
	for (const choice of choices.slice(1)) {
		const button = grid.createEl('button', {
			cls: 'gcal-color-choice',
			text: choice.selected ? '✓' : '',
			attr: {
				type: 'button',
				title: choice.name,
				'aria-label': choice.name,
				'aria-pressed': String(choice.selected),
			},
		});
		button.setCssProps({
			'--gcal-swatch': choice.color,
			'--gcal-swatch-text': swatchTextColor(choice.color),
		});
		button.disabled = disabled;
		button.onclick = () => choose(choice);
		buttons.push(button);
	}
	if (actions.length) {
		const menu = popover.createDiv({ cls: 'gcal-event-context-actions' });
		for (const action of actions) {
			const button = menu.createEl('button', {
				cls: action.destructive ? 'is-destructive' : '',
			});
			button.createSpan({ text: action.name });
			if (action.shortcut)
				button.createSpan({ cls: 'gcal-event-shortcut', text: action.shortcut });
			button.onclick = () => {
				close();
				void action.run();
			};
			buttons.push(button);
		}
	}
	const outside = (event: Event) => {
		if (!popover.contains(event.target as Node)) close();
	};
	const scrolling = (event: Event) => {
		if (!popover.contains(event.target as Node)) close();
	};
	const keyboard = (event: KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.repeat) {
			const action = actions.find(
				(item) => item.shortcut?.slice(-1).toLowerCase() === event.key.toLowerCase(),
			);
			if (action) {
				event.preventDefault();
				event.stopPropagation();
				close();
				void action.run();
				return;
			}
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close();
			return;
		}
		const index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
		if (index < 0) return;
		const delta =
			event.key === 'ArrowRight'
				? 1
				: event.key === 'ArrowLeft'
					? -1
					: event.key === 'ArrowDown'
						? 5
						: event.key === 'ArrowUp'
							? -5
							: 0;
		if (delta) {
			event.preventDefault();
			buttons[(index + delta + buttons.length) % buttons.length]?.focus();
		}
	};
	const bounds = popover.getBoundingClientRect();
	popover.setCssProps({
		left: `${Math.max(8, Math.min(x, view.innerWidth - bounds.width - 8))}px`,
		top: `${Math.max(8, Math.min(y, view.innerHeight - bounds.height - 8))}px`,
	});
	doc.addEventListener('pointerdown', outside, true);
	doc.addEventListener('keydown', keyboard, true);
	doc.addEventListener('scroll', scrolling, true);
	view.addEventListener('resize', close);
	(buttons.find((button) => button.getAttribute('aria-pressed') === 'true') ?? buttons[0])?.focus(
		{ preventScroll: true },
	);
	return { close };
}
