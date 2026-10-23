import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type GCalSync from './main';
import { GCalBlock } from './view';

export const VIEW_TYPE = 'google-cal-sync-calendar';

/** The calendar as its own pane (sidebar or tab), reusing the code block renderer. */
export class GCalView extends ItemView {
	navigation = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: GCalSync,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Google Calendar';
	}

	getIcon(): string {
		return 'calendar';
	}

	onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('gcal-view');
		this.addChild(
			new GCalBlock(this.contentEl.createDiv(), this.plugin, {
				view: 'month',
				height: 'auto',
				calendars: [],
				tasks: true,
			}),
		);
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}
}
