import { type PlanPeriod, plannerSections, planProgress } from './planner-model';

export interface CanvasNode extends Record<string, unknown> {
	id: string;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	text?: string;
}
export interface CanvasEdge extends Record<string, unknown> {
	id: string;
	fromNode: string;
	toNode: string;
}
export interface PlannerCanvas extends Record<string, unknown> {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

export function parsePlannerCanvas(raw: string): PlannerCanvas {
	const data: unknown = JSON.parse(raw);
	if (!data || typeof data !== 'object' || !('nodes' in data) || !Array.isArray(data.nodes))
		throw new Error('The planner board is not valid Canvas data.');
	const board = data as PlannerCanvas;
	if (board.edges === undefined) board.edges = [];
	if (!Array.isArray(board.edges)) throw new Error('The planner connections are not valid.');
	const ids = new Set<string>();
	for (const node of board.nodes) {
		if (
			!node ||
			typeof node.id !== 'string' ||
			!node.id ||
			ids.has(node.id) ||
			!['text', 'file', 'link', 'group'].includes(node.type) ||
			![node.x, node.y, node.width, node.height].every(Number.isFinite) ||
			node.width <= 0 ||
			node.height <= 0 ||
			(node.type === 'text' && typeof node.text !== 'string')
		)
			throw new Error('The planner contains an invalid card.');
		ids.add(node.id);
	}
	const edges = new Set<string>();
	for (const edge of board.edges) {
		if (
			!edge ||
			typeof edge.id !== 'string' ||
			edges.has(edge.id) ||
			!ids.has(edge.fromNode) ||
			!ids.has(edge.toNode)
		)
			throw new Error('The planner contains an invalid connection.');
		edges.add(edge.id);
	}
	return board;
}

/** Cards contain all plan text. New periods add cards, leaving the existing canvas untouched. */
export function ensureCanvasPeriods(board: PlannerCanvas, period: PlanPeriod): boolean {
	let changed = false;
	for (const { heading } of plannerSections(period)) {
		if (
			board.nodes.some(
				(node) =>
					node.type === 'text' &&
					node.text
						?.split('\n')
						.some((line) => line.replace(/^#{1,6}\s+/, '').trim() === heading),
			)
		)
			continue;
		const y = board.nodes.length
			? Math.max(...board.nodes.map((node) => node.y + node.height)) + 100
			: 0;
		let id = `plan-${heading.replace(/[^\w-]/g, '-').toLowerCase()}`;
		while (board.nodes.some((node) => node.id === id)) id += '-new';
		board.nodes.push({
			id,
			type: 'text',
			x: 0,
			y,
			width: 720,
			height: 500,
			text: `## ${heading}\n\n`,
		});
		changed = true;
	}
	return changed;
}

export function canvasProgress(
	board: PlannerCanvas,
	heading: string,
): { done: number; total: number } {
	return board.nodes
		.filter((node) => node.type === 'text')
		.reduce(
			(sum, node) => {
				const value = planProgress(node.text ?? '', heading);
				return { done: sum.done + value.done, total: sum.total + value.total };
			},
			{ done: 0, total: 0 },
		);
}

/** Apply only card text, merging safely with any manual movement or arrow edits during the AI request. */
export function mergeCanvasText(
	original: PlannerCanvas,
	proposed: PlannerCanvas,
	current: PlannerCanvas,
): { board: PlannerCanvas; changed: boolean } {
	if (
		original.nodes.length !== proposed.nodes.length ||
		proposed.nodes.some(
			(node) => !original.nodes.some((old) => old.id === node.id && old.type === node.type),
		)
	)
		throw new Error(
			'The assistant may update existing text cards only. Add or remove cards directly on the board.',
		);
	let changed = false;
	for (const old of original.nodes) {
		if (old.type !== 'text') continue;
		const next = proposed.nodes.find((node) => node.id === old.id);
		if (!next || typeof next.text !== 'string')
			throw new Error('The assistant returned an invalid text card.');
		if (next.text === old.text) continue;
		const latest = current.nodes.find((node) => node.id === old.id);
		if (latest?.type !== 'text' || latest.text !== old.text)
			throw new Error(
				'A plan card changed while the assistant was thinking. Nothing was saved; please ask again.',
			);
		latest.text = next.text;
		changed = true;
	}
	return { board: current, changed };
}
