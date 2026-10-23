import { debounce, MarkdownRenderChild, MarkdownRenderer, Notice } from 'obsidian';
import type GCalSync from './main';
import { askPlanningCodex, type PlanningRequest } from './planner-ai';
import { planningCalendarSnapshot } from './planner-calendar';
import { canvasProgress, parsePlannerCanvas } from './planner-canvas';
import { type PlanPeriod, plannerPrompt, plannerSections, planPeriod } from './planner-model';
import { errorMessage } from './settings';

interface ChatLine {
	role: 'user' | 'assistant';
	text: string;
}
const CHAT_KEY = 'google-cal-sync:planning-chat';

export class PlannerPanel extends MarkdownRenderChild {
	private stats!: HTMLElement;
	private calendarSummary!: HTMLElement;
	private messages!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private send!: HTMLButtonElement;
	private cancelButton!: HTMLButtonElement;
	private status!: HTMLElement;
	private period!: PlanPeriod;
	private pending: PlanningRequest | null = null;
	private busy = false;
	private closed = false;
	private cancelled = false;
	private history: ChatLine[] = [];
	private statsVersion = 0;

	constructor(
		containerEl: HTMLElement,
		private plugin: GCalSync,
	) {
		super(containerEl);
	}

	onload(): void {
		this.period = planPeriod();
		const root = this.containerEl;
		root.addClass('gcal-planner');
		if (!root.closest('.gcal')) {
			root.addClass('gcal-planner-standalone');
			let note = root.closest('.markdown-preview-view, .markdown-source-view');
			const expand = () => {
				note ??= root.closest('.markdown-preview-view, .markdown-source-view');
				note?.addClass('gcal-wide-note');
			};
			expand();
			const observer = new ResizeObserver(expand);
			observer.observe(root);
			this.register(() => {
				observer.disconnect();
				root.removeClass('gcal-planner-standalone');
				if (!note?.querySelector('.gcal, .gcal-planner-standalone'))
					note?.removeClass('gcal-wide-note');
			});
		}

		root.createEl('h3', { text: 'Planning assistant' });
		root.createEl('p', {
			cls: 'gcal-planner-description',
			text: 'Yearly · monthly · weekly · interviews — all in Planner',
		});
		const visual = root.createEl('button', { text: 'Open visual planner' });
		visual.onclick = () =>
			void this.plugin.app.workspace.openLinkText(this.plugin.planner.path, '', false);
		this.stats = root.createDiv({ cls: 'gcal-planner-stats' });
		this.calendarSummary = root.createEl('p', { cls: 'gcal-planner-description' });
		this.messages = root.createDiv({
			cls: 'gcal-planner-messages',
			attr: { role: 'log', 'aria-label': 'Planning conversation' },
		});
		const saved: unknown = this.plugin.app.loadLocalStorage(CHAT_KEY);
		if (Array.isArray(saved))
			this.history = saved
				.filter(
					(line: unknown): line is ChatLine =>
						!!line &&
						typeof line === 'object' &&
						'role' in line &&
						(line.role === 'user' || line.role === 'assistant') &&
						'text' in line &&
						typeof line.text === 'string',
				)
				.slice(-20);
		for (const line of this.history) void this.drawMessage(line);
		if (!this.history.length)
			this.messages.createEl('p', {
				cls: 'gcal-planner-welcome',
				text: 'Tell me your goals, ask for a weekly review, or report what you finished. Edit plan cards directly in Planner Board, or ask here to update them.',
			});
		const examples = root.createDiv({ cls: 'gcal-planner-examples' });
		for (const [label, question] of [
			['Review this week', 'Review this week’s progress toward my monthly and yearly goals.'],
			[
				'Plan next week',
				'Help me choose three deliverables for next week, based on my yearly goals.',
			],
			[
				'Set yearly goals',
				'Help me define my yearly goals. Ask me what outcomes I want before adding commitments.',
			],
		]) {
			const button = examples.createEl('button', { text: label });
			button.onclick = () => {
				this.input.value = question ?? '';
				this.input.focus();
			};
		}
		this.input = root.createEl('textarea', {
			cls: 'gcal-planner-input',
			attr: {
				placeholder: 'Ask about your plans or progress…',
				'aria-label': 'Ask the planning assistant',
				rows: '3',
				maxlength: '12000',
			},
		});
		this.registerDomEvent(this.input, 'keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				void this.submit();
			}
		});
		const actions = root.createDiv({ cls: 'gcal-planner-actions' });
		this.send = actions.createEl('button', { text: 'Ask', cls: 'mod-cta' });
		this.send.onclick = () => void this.submit();
		this.cancelButton = actions.createEl('button', { text: 'Cancel' });
		this.cancelButton.hidden = true;
		this.cancelButton.onclick = () => {
			this.cancelled = true;
			this.pending?.cancel();
		};
		const clear = actions.createEl('button', { text: 'Clear chat' });
		clear.onclick = () => {
			if (this.busy) return;
			this.history = [];
			this.plugin.app.saveLocalStorage(CHAT_KEY, []);
			this.messages.empty();
		};
		this.status = root.createEl('p', { cls: 'gcal-planner-status', attr: { role: 'status' } });
		root.createEl('p', {
			cls: 'gcal-planner-footnote',
			text: 'Gray event color = completed work. Other events are not marked complete. Uses your local Codex login; on Ask, sends the planner, its visual connections, this week’s calendar slots and colors, and recent chat to OpenAI. Explicit plan changes save automatically with backups.',
		});
		this.register(() => {
			this.closed = true;
			this.pending?.cancel();
		});
		const refresh = debounce(() => void this.refreshStats(), 250, true);
		this.plugin.addListener(refresh);
		this.register(() => this.plugin.removeListener(refresh));
		const onPlanChange = (file: { path: string }) => {
			if (file.path.startsWith('Plans/')) refresh();
		};
		this.registerEvent(this.plugin.app.vault.on('create', onPlanChange));
		this.registerEvent(this.plugin.app.vault.on('modify', onPlanChange));
		this.registerEvent(this.plugin.app.vault.on('delete', onPlanChange));
		this.registerEvent(
			this.plugin.app.vault.on('rename', (file, oldPath) => {
				if (file.path.startsWith('Plans/') || oldPath.startsWith('Plans/')) refresh();
			}),
		);
		this.registerDomEvent(root.ownerDocument.defaultView ?? window, 'focus', refresh);
		void this.refreshStats();
	}

	private async refreshStats(): Promise<void> {
		const version = ++this.statsVersion;
		try {
			this.period = planPeriod();
			await this.plugin.planner.ensure(this.period);
			if (this.closed || version !== this.statsVersion) return;
			const calendar = this.calendarContext();
			this.calendarSummary.setText(
				`Calendar this week: ${calendar.completed} completed (gray) · ${calendar.notMarkedComplete} not marked complete${calendar.unknownColor ? ` · ${calendar.unknownColor} unknown color` : ''}. Plan counters above reflect saved checkboxes.`,
			);
			this.stats.empty();
			const path = this.plugin.planner.path;
			const file = this.plugin.app.vault.getFileByPath(path);
			const context = file ? await this.plugin.planner.context(this.period) : [];
			const text = context[0]?.content ?? '{"nodes":[],"edges":[]}';
			if (this.closed || version !== this.statsVersion) return;
			for (const { heading, label } of plannerSections(this.period)) {
				const progress = canvasProgress(parsePlannerCanvas(text), heading);
				const row = this.stats.createDiv({ cls: 'gcal-planner-stat' });
				const link = row.createEl('a', {
					cls: 'gcal-planner-link',
					text: label,
					attr: { href: '#', title: path },
				});
				link.onclick = (event) => {
					event.preventDefault();
					void this.plugin.app.workspace.openLinkText(path, '', false);
				};
				row.createSpan({
					text: progress.total
						? `${progress.done}/${progress.total} · ${Math.round((100 * progress.done) / progress.total)}%`
						: 'Not set yet',
				});
				const meter = row.createEl('progress', {
					attr: {
						max: String(progress.total || 1),
						value: String(progress.done),
						'aria-label': label,
					},
				});
				meter.addClass('gcal-planner-progress');
			}
		} catch (error) {
			if (!this.closed) this.status.setText(errorMessage(error));
		}
	}

	private async drawMessage(line: ChatLine): Promise<void> {
		const message = this.messages.createDiv({ cls: `gcal-planner-message is-${line.role}` });
		message.createEl('strong', { text: line.role === 'user' ? 'You' : 'Assistant' });
		const content = message.createDiv();
		await MarkdownRenderer.render(
			this.plugin.app,
			line.text,
			content,
			this.plugin.planner.path,
			this,
		);
		if (!this.closed) this.messages.scrollTop = this.messages.scrollHeight;
	}

	private async submit(): Promise<void> {
		const question = this.input.value.trim();
		if (this.busy || !question) return;
		this.busy = true;
		this.cancelled = false;
		this.send.disabled = true;
		this.cancelButton.hidden = false;
		this.input.value = '';
		this.status.setText('Reading your plans…');
		const user: ChatLine = { role: 'user', text: question };
		const previous = [...this.history];
		this.history.push(user);
		try {
			await this.drawMessage(user);
			this.period = planPeriod();
			if (this.plugin.auth.loggedIn && !this.plugin.auth.locked) {
				this.status.setText('Syncing calendar colors…');
				await this.plugin.sync({ force: true });
			}
			const notes = await this.plugin.planner.context(this.period);
			if (this.closed) return;
			if (this.cancelled) throw new Error('Request cancelled.');
			this.status.setText('Reviewing with Codex…');
			this.pending = askPlanningCodex(
				plannerPrompt(question, notes, previous, this.period, this.calendarContext()),
			);
			const reply = await this.pending.result;
			if (this.closed) return;
			if (this.cancelled) throw new Error('Request cancelled.');
			this.cancelButton.hidden = true;
			this.status.setText('Saving plan changes…');
			const saved = await this.plugin.planner.apply(reply.edits, notes);
			const line: ChatLine = {
				role: 'assistant',
				text:
					reply.message +
					(saved.length
						? `\n\nSaved: ${saved.map((path) => `[[${path}]]`).join(', ')}`
						: ''),
			};
			this.history.push(line);
			await this.drawMessage(line);
			this.status.setText(
				saved.length
					? 'Plan updated. Previous versions are in Plans/History.'
					: 'Review complete.',
			);
			await this.refreshStats();
		} catch (error) {
			if (!this.closed) {
				this.status.setText(errorMessage(error));
				this.input.value = question;
				new Notice(errorMessage(error));
			}
		} finally {
			this.pending = null;
			this.busy = false;
			this.history = this.history.slice(-20);
			this.plugin.app.saveLocalStorage(CHAT_KEY, this.history);
			if (!this.closed) {
				this.send.disabled = false;
				this.cancelButton.hidden = true;
				this.input.focus();
			}
		}
	}

	private calendarContext() {
		return planningCalendarSnapshot(
			Object.entries(this.plugin.settings.calendars).map(([id, calendar]) => ({
				id,
				...calendar,
				cache: this.plugin.cache.calendar(id),
			})),
			this.period,
			this.plugin.status.lastSyncAt,
			this.plugin.status.lastError,
		);
	}
}
