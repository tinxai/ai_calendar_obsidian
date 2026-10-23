import { type App, normalizePath, TFile, TFolder } from 'obsidian';
import { ensureCanvasPeriods, mergeCanvasText, parsePlannerCanvas } from './planner-canvas';
import {
	drawingPlan,
	ensureDrawingPeriods,
	parsePlannerDrawing,
	readPlannerDrawing,
	serializePlannerDrawing,
	updatePlannerDrawing,
} from './planner-excalidraw';
import {
	type PlanEdit,
	type PlanNote,
	type PlanPeriod,
	parsePlannerReply,
	planPeriod,
} from './planner-model';

export class PlannerStore {
	private creating: Promise<void> = Promise.resolve();
	private retiredChecked = false;
	constructor(private app: App) {}

	private async folder(path: string): Promise<void> {
		const parts = normalizePath(path).split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current))
				await this.app.vault.createFolder(current);
		}
	}

	ensure(period: PlanPeriod): Promise<void> {
		const next = this.creating.then(async () => {
			await this.cleanupRetired();
			await this.createPeriod(period);
		});
		this.creating = next.catch(() => {});
		return next;
	}

	/** The old live plugin can recreate empty templates until Obsidian reloads. */
	private async cleanupRetired(): Promise<void> {
		if (this.retiredChecked) return;
		this.retiredChecked = true;
		const adapter = this.app.vault.adapter;
		if (!adapter) return;
		const manifestPath = `${this.app.vault.configDir || '.obsidian'}/plugins/google-cal-sync/planner-consolidation-cleanup.json`;
		if (!(await adapter.exists(manifestPath))) return;
		const value: unknown = JSON.parse(await adapter.read(manifestPath));
		if (
			!value ||
			typeof value !== 'object' ||
			!('entries' in value) ||
			!Array.isArray(value.entries) ||
			('complete' in value && value.complete)
		)
			return;
		for (const entry of value.entries as unknown[]) {
			if (
				!entry ||
				typeof entry !== 'object' ||
				!('path' in entry) ||
				!('content' in entry) ||
				typeof entry.path !== 'string' ||
				typeof entry.content !== 'string' ||
				!/^(?:Plans\/(?:Yearly\/\d{4}|Monthly\/\d{4}-\d{2}|Weekly\/\d{4}-W\d{2})\.md|(?:Plans\/)?Planner\.md|(?:Plans\/)?Planner Board\.canvas)$/.test(
					entry.path,
				)
			)
				continue;
			if (entry.path === this.path) continue;
			const file = this.app.vault.getAbstractFileByPath(entry.path);
			if (file instanceof TFile && (await this.app.vault.read(file)) === entry.content)
				await this.app.vault.delete(file);
		}
		for (const name of ['Yearly', 'Monthly', 'Weekly']) {
			const folder = this.app.vault.getAbstractFileByPath(`Plans/${name}`);
			if (folder instanceof TFolder && folder.children.length === 0)
				await this.app.vault.delete(folder);
		}
		// Keep the exact original contents in this manifest as a recoverable backup.
		await adapter.write(manifestPath, JSON.stringify({ ...value, complete: true }, null, 2));
	}

	get path(): string {
		for (const path of [
			'Plans/Planner Board.excalidraw.md',
			'Planner Board.excalidraw.md',
			'Plans/Planner Board.canvas',
			'Planner Board.canvas',
		]) {
			if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return path;
		}
		return 'Plans/Planner Board.excalidraw.md';
	}

	private async createPeriod(period: PlanPeriod): Promise<void> {
		const path = this.path;
		let file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			if (path.includes('/')) await this.folder(path.slice(0, path.lastIndexOf('/')));
			file = await this.app.vault.create(
				path,
				path.endsWith('.excalidraw.md')
					? serializePlannerDrawing('', {
							type: 'excalidraw',
							version: 2,
							elements: [],
							appState: { viewBackgroundColor: '#f8fafc', currentItemFontSize: 48 },
							files: {},
						})
					: '{"nodes":[],"edges":[]}',
			);
		}
		if (!(file instanceof TFile)) return;
		if (path.endsWith('.excalidraw.md')) {
			const drawing = await readPlannerDrawing(this.app, file);
			if (!ensureDrawingPeriods(drawing.scene, period)) return;
			if (drawing.view?.updateScene && drawing.view.forceSave) {
				drawing.view.updateScene({
					elements: drawing.scene.elements,
					captureUpdate: 'IMMEDIATELY',
				});
				await drawing.view.forceSave(true, true);
			} else
				await this.app.vault.process(file, (raw) => {
					const scene = parsePlannerDrawing(raw);
					return ensureDrawingPeriods(scene, period)
						? serializePlannerDrawing(raw, scene)
						: raw;
				});
			return;
		}
		const check = parsePlannerCanvas(await this.app.vault.read(file));
		if (!ensureCanvasPeriods(check, period)) return;
		await this.app.vault.process(file, (raw) => {
			const board = parsePlannerCanvas(raw);
			return ensureCanvasPeriods(board, period) ? `${JSON.stringify(board, null, 2)}\n` : raw;
		});
	}

	async context(period = planPeriod()): Promise<PlanNote[]> {
		await this.ensure(period);
		const file = this.app.vault.getAbstractFileByPath(this.path);
		if (!(file instanceof TFile)) throw new Error('The planner board could not be found.');
		const content = file.path.endsWith('.excalidraw.md')
			? JSON.stringify(drawingPlan((await readPlannerDrawing(this.app, file)).scene))
			: await this.app.vault.read(file);
		if (content.length > 60000)
			throw new Error(
				'The planner board is too large for one review. Shorten older content first.',
			);
		parsePlannerCanvas(content);
		return [{ path: file.path, content }];
	}

	async apply(edits: PlanEdit[], snapshot: PlanNote[]): Promise<string[]> {
		parsePlannerReply(JSON.stringify({ message: '', edits }));
		if (!edits.length) return [];
		const edit = edits[0];
		const original = snapshot.find((note) => note.path === edit?.path);
		if (!edit || edit.path !== this.path || !original)
			throw new Error('The assistant may update only the current planner board.');
		const file = this.app.vault.getAbstractFileByPath(edit.path);
		if (!(file instanceof TFile))
			throw new Error('The planner board was moved or deleted. Nothing was saved.');
		const oldBoard = parsePlannerCanvas(original.content);
		const proposed = parsePlannerCanvas(edit.content);
		if (file.path.endsWith('.excalidraw.md')) {
			const drawing = await readPlannerDrawing(this.app, file);
			if (!mergeCanvasText(oldBoard, proposed, drawingPlan(drawing.scene)).changed) return [];
			const backup = `Plans/History/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			await this.folder(backup);
			await this.app.vault.create(`${backup}/Planner Board.excalidraw.md`, drawing.raw);
			return (await updatePlannerDrawing(this.app, file, oldBoard, proposed))
				? [edit.path]
				: [];
		}
		const before = await this.app.vault.read(file);
		const preview = mergeCanvasText(oldBoard, proposed, parsePlannerCanvas(before));
		if (!preview.changed) return [];
		const backup = `Plans/History/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		await this.folder(backup);
		await this.app.vault.create(`${backup}/Planner Board.canvas`, before);
		await this.app.vault.process(file, (raw) => {
			const merged = mergeCanvasText(oldBoard, proposed, parsePlannerCanvas(raw));
			return merged.changed ? `${JSON.stringify(merged.board, null, 2)}\n` : raw;
		});
		return [edit.path];
	}
}
