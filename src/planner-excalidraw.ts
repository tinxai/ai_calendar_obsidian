import type { App, TFile } from 'obsidian';
import type { CanvasNode, PlannerCanvas } from './planner-canvas';
import { ensureCanvasPeriods, mergeCanvasText } from './planner-canvas';
import type { PlanPeriod } from './planner-model';

type Element = Record<string, unknown> & {
	id: string;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	text?: string;
	originalText?: string;
	rawText?: string;
	isDeleted?: boolean;
};
export interface DrawingScene extends Record<string, unknown> {
	type: string;
	elements: Element[];
	appState?: Record<string, unknown>;
	files?: Record<string, unknown>;
}
interface DrawingView {
	containerEl?: HTMLElement;
	file?: { path: string };
	excalidrawAPI?: { getSceneElements: () => Element[] };
	updateScene?: (data: unknown) => void;
	forceSave?: (silent: boolean, wait?: boolean) => Promise<void>;
}

export function parsePlannerDrawing(raw: string): DrawingScene {
	const matches = [
		...raw.matchAll(/(?:^|\n)##? Drawing\s*\n```(json|compressed-json)\s*\n([\s\S]*?)\n```/g),
	];
	const match = matches[matches.length - 1];
	if (!match) throw new Error('The Excalidraw planner has no drawing data.');
	let json = match[2] ?? '';
	if (match[1] === 'compressed-json') {
		const ea =
			typeof window === 'undefined'
				? undefined
				: (
						window as unknown as {
							ExcalidrawAutomate?: {
								decompressFromBase64: (value: string) => string;
							};
						}
					).ExcalidrawAutomate;
		if (!ea) throw new Error('Enable the Excalidraw plugin to read this planner.');
		json = ea.decompressFromBase64(json.replace(/\s/g, ''));
	}
	const data: unknown = JSON.parse(json);
	if (!data || typeof data !== 'object' || !('elements' in data) || !Array.isArray(data.elements))
		throw new Error('The Excalidraw planner is invalid.');
	const scene = data as DrawingScene;
	const ids = new Set<string>();
	for (const element of scene.elements) {
		if (
			!element ||
			typeof element.id !== 'string' ||
			ids.has(element.id) ||
			typeof element.type !== 'string' ||
			![element.x, element.y, element.width, element.height].every(Number.isFinite)
		)
			throw new Error('The drawing contains an invalid element.');
		ids.add(element.id);
	}
	return scene;
}

export function drawingPlan(scene: DrawingScene): PlannerCanvas {
	const nodes: CanvasNode[] = scene.elements
		.filter((element) => !element.isDeleted && element.type !== 'arrow')
		.map((element) => ({
			id: element.id,
			type: element.type === 'text' ? 'text' : 'group',
			x: element.x,
			y: element.y,
			width: Math.max(element.width, 1),
			height: Math.max(element.height, 1),
			...(element.type === 'text'
				? { text: element.rawText ?? element.originalText ?? element.text ?? '' }
				: {}),
			containerId: element.containerId ?? null,
			link: element.link ?? null,
		}));
	const ids = new Set(nodes.map((node) => node.id));
	const edges = scene.elements
		.filter((element) => !element.isDeleted && element.type === 'arrow')
		.flatMap((element) => {
			const from = element.startBinding as { elementId?: string } | undefined;
			const to = element.endBinding as { elementId?: string } | undefined;
			if (
				!from?.elementId ||
				!to?.elementId ||
				!ids.has(from.elementId) ||
				!ids.has(to.elementId)
			)
				return [];
			const label = scene.elements.find(
				(text) =>
					!text.isDeleted && text.type === 'text' && text.containerId === element.id,
			);
			return [
				{
					id: element.id,
					fromNode: from.elementId,
					toNode: to.elementId,
					label: label?.originalText ?? label?.text ?? '',
				},
			];
		});
	return { nodes, edges };
}

export function serializePlannerDrawing(raw: string, scene: DrawingScene): string {
	const header =
		raw.match(/^---\n[\s\S]*?\n---\n/)?.[0] ??
		'---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n';
	const dataStart = raw.indexOf('# Excalidraw Data');
	const preamble = dataStart >= 0 ? `${raw.slice(0, dataStart).trimEnd()}\n\n` : `${header}\n`;
	const text = scene.elements
		.filter((element) => !element.isDeleted && element.type === 'text')
		.map(
			(element) =>
				`${element.rawText ?? element.originalText ?? element.text ?? ''} ^${element.id}\n`,
		)
		.join('\n');
	// Retain native embedded-file metadata and links when rewriting closed drawings.
	const extra =
		raw.match(/\n## (?:Element Links|Embedded Files)\n[\s\S]*?(?=\n%%\s*\n##? Drawing)/)?.[0] ??
		'';
	return `${preamble}# Excalidraw Data\n\n## Text Elements\n${text}\n${extra}\n%%\n## Drawing\n\`\`\`json\n${JSON.stringify(scene, null, 2)}\n\`\`\`\n%%\n`;
}

export async function readPlannerDrawing(
	app: App,
	file: TFile,
): Promise<{ raw: string; scene: DrawingScene; view: DrawingView | null }> {
	const raw = await app.vault.read(file);
	const scene = parsePlannerDrawing(raw);
	let view: DrawingView | null = null;
	app.workspace?.iterateAllLeaves((leaf) => {
		const candidate = leaf.view as unknown as DrawingView;
		if (candidate.file?.path === file.path && candidate.excalidrawAPI) view = candidate;
	});
	if (view)
		scene.elements =
			(view as DrawingView).excalidrawAPI
				?.getSceneElements()
				.map((element) => ({ ...element })) ?? scene.elements;
	return { raw, scene, view };
}

export function wrapDrawingText(text: string, width: number, size: number): string {
	const columns = Math.max(8, Math.floor(width / (size * 0.6)));
	return text
		.split('\n')
		.flatMap((line) => {
			if (line.length <= columns) return [line];
			const lines: string[] = [];
			let current = '';
			for (const word of line.split(' ')) {
				if (current && current.length + word.length + 1 > columns) {
					lines.push(current);
					current = word;
				} else current += (current ? ' ' : '') + word;
			}
			lines.push(current);
			return lines;
		})
		.join('\n');
}

export function ensureDrawingPeriods(scene: DrawingScene, period: PlanPeriod): boolean {
	const before = drawingPlan(scene),
		ids = new Set(before.nodes.map((node) => node.id));
	if (!ensureCanvasPeriods(before, period)) return false;
	for (const node of before.nodes.filter((item) => !ids.has(item.id))) {
		scene.elements.push({
			id: node.id,
			type: 'text',
			x: node.x,
			y: node.y,
			width: node.width,
			height: 60,
			angle: 0,
			strokeColor: '#1e293b',
			backgroundColor: 'transparent',
			fillStyle: 'solid',
			strokeWidth: 1,
			strokeStyle: 'solid',
			roughness: 1,
			opacity: 100,
			groupIds: [],
			frameId: null,
			roundness: null,
			seed: Date.now() % 1000000,
			version: 1,
			versionNonce: 1,
			isDeleted: false,
			boundElements: null,
			updated: Date.now(),
			link: null,
			locked: false,
			fontSize: 48,
			fontFamily: 2,
			textAlign: 'left',
			verticalAlign: 'top',
			lineHeight: 1.25,
			containerId: null,
			text: (node.text ?? '').replace(/^## /, ''),
			originalText: (node.text ?? '').replace(/^## /, ''),
			autoResize: true,
		});
	}
	return true;
}

function setText(scene: DrawingScene, id: string, text: string): void {
	const element = scene.elements.find((item) => item.id === id && item.type === 'text');
	if (!element) return;
	element.text = wrapDrawingText(text, element.width, Number(element.fontSize ?? 48));
	element.originalText = text;
	if ('rawText' in element) element.rawText = text;
	element.version = Number(element.version ?? 1) + 1;
	element.versionNonce = Math.floor(Math.random() * 1000000000);
	element.updated = Date.now();
	const size = Number(element.fontSize ?? 48),
		lineHeight = Number(element.lineHeight ?? 1.25);
	// Excalidraw keeps the user's font and position; grow the containing box when added text requires it.
	const lines = element.text.split('\n').length;
	element.height = Math.max(size * lineHeight, lines * size * lineHeight);
	const container = scene.elements.find(
		(item) => item.id === element.containerId && item.type === 'rectangle',
	);
	if (container && element.height + 40 > container.height) {
		container.height = element.height + 40;
		container.version = Number(container.version ?? 1) + 1;
	}
}

/** Native drawing geometry, bindings, fonts, and other elements remain under the user's control. */
export async function updatePlannerDrawing(
	app: App,
	file: TFile,
	original: PlannerCanvas,
	proposed: PlannerCanvas,
): Promise<boolean> {
	const current = await readPlannerDrawing(app, file);
	const before = drawingPlan(current.scene);
	const merged = mergeCanvasText(original, proposed, drawingPlan(current.scene));
	if (!merged.changed) return false;
	const apply = (scene: DrawingScene) => {
		const checked = mergeCanvasText(original, proposed, drawingPlan(scene));
		for (const node of checked.board.nodes)
			if (
				node.type === 'text' &&
				node.text !== before.nodes.find((old) => old.id === node.id)?.text
			)
				setText(scene, node.id, node.text ?? '');
	};
	if (current.view?.updateScene && current.view.forceSave) {
		apply(current.scene);
		current.view.updateScene({
			elements: current.scene.elements,
			captureUpdate: 'IMMEDIATELY',
		});
		const viewWindow = current.view.containerEl?.ownerDocument.defaultView ?? window;
		await new Promise<void>((resolve) => viewWindow.requestAnimationFrame(() => resolve()));
		await current.view.forceSave(true, true);
		const persisted = drawingPlan(parsePlannerDrawing(await app.vault.read(file)));
		for (const node of merged.board.nodes)
			if (
				node.type === 'text' &&
				node.text !== before.nodes.find((old) => old.id === node.id)?.text &&
				persisted.nodes.find((item) => item.id === node.id)?.text !== node.text
			)
				throw new Error(
					'Excalidraw has not finished saving. Your changes remain in the open drawing; save it before asking again.',
				);
	} else {
		await app.vault.process(file, (raw) => {
			const scene = parsePlannerDrawing(raw);
			apply(scene);
			return serializePlannerDrawing(raw, scene);
		});
	}
	return true;
}
