import type { Plugin } from 'obsidian';

/** Scale this planner's text only; other canvases and the rest of Obsidian keep their font size. */
export function registerPlannerBoardStyle(plugin: Plugin): void {
	const marked = new Set<HTMLElement>();
	const refresh = () => {
		plugin.app.workspace.iterateAllLeaves((leaf) => {
			const element = leaf.view.containerEl;
			const path = leaf.view.getState().file;
			const active =
				leaf.view.getViewType() === 'canvas' &&
				(path === 'Plans/Planner Board.canvas' || path === 'Planner Board.canvas');
			element.classList.toggle('planner-board-large-text', active);
			if (active) {
				const view = element.ownerDocument.defaultView;
				const size =
					view
						?.getComputedStyle(element.ownerDocument.body)
						.getPropertyValue('--font-text-size')
						.trim() || '16px';
				element.style.setProperty('--planner-base-font-size', size);
				marked.add(element);
			} else if (marked.delete(element))
				element.style.removeProperty('--planner-base-font-size');
		});
	};
	plugin.registerEvent(plugin.app.workspace.on('layout-change', refresh));
	plugin.registerEvent(plugin.app.workspace.on('file-open', refresh));
	plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', refresh));
	plugin.app.workspace.onLayoutReady(refresh);
	plugin.register(() => {
		for (const element of marked) {
			element.classList.remove('planner-board-large-text');
			element.style.removeProperty('--planner-base-font-size');
		}
	});
}
