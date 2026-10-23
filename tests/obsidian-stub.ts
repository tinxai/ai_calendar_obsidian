// Minimal stand-in for the `obsidian` module so pure logic can run under node:test.
export class TFile {
	path = '';
	basename = '';
	extension = 'md';
	stat = { mtime: 0, ctime: 0, size: 0 };
	parent: TFolder | null = null;
}
export class TFolder {
	path = '';
	name = '';
	children: Array<TFile | TFolder> = [];
}
export class Notice {
	constructor(public message: string) {}
}
export class Modal {}
export class Menu {
	static latest: Menu;
	items: MenuItem[] = [];
	shown = false;
	constructor(_app?: unknown) {
		Menu.latest = this;
	}
	addItem(callback: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		callback(item);
		this.items.push(item);
		return this;
	}
	showAtMouseEvent(_event: unknown): void {
		this.shown = true;
	}
}
class MenuItem {
	title: unknown;
	selected = false;
	disabled = false;
	label = false;
	callback?: () => unknown;
	setTitle(title: unknown): this {
		this.title = title;
		return this;
	}
	setChecked(value: boolean): this {
		this.selected = value;
		return this;
	}
	setDisabled(value: boolean): this {
		this.disabled = value;
		return this;
	}
	setIsLabel(value: boolean): this {
		this.label = value;
		return this;
	}
	onClick(callback: () => unknown): this {
		this.callback = callback;
		return this;
	}
}
export class MarkdownRenderChild {
	constructor(public containerEl: unknown) {}
}
export const MarkdownRenderer = {
	async render(): Promise<void> {},
};
export class PluginSettingTab {}
export class Setting {}
export const Platform = { isDesktop: true, isMobile: false, isPhone: false };
export const moment = () => ({ format: () => '' });
export function getLanguage() {
	return 'en';
}
export function normalizePath(p: string) {
	return p
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/|\/$/g, '');
}
export function debounce<T extends (...a: unknown[]) => unknown>(fn: T) {
	return fn;
}
export function parseYaml(src: string): unknown {
	const out: Record<string, unknown> = {};
	for (const line of src.split('\n')) {
		const m = line.match(/^([\w-]+):\s*(.*)$/);
		if (!m) {
			if (line.trim()) throw new Error('bad yaml');
			continue;
		}
		const k = m[1] as string;
		const v = (m[2] as string).trim();
		if (v === 'true' || v === 'false') out[k] = v === 'true';
		else if (v.startsWith('['))
			out[k] = v
				.slice(1, -1)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		else if (/^\d+$/.test(v)) out[k] = Number(v);
		else out[k] = v;
	}
	return out;
}
type Req = Record<string, unknown>;
type Res = { status: number; text: string; headers: Record<string, string> };
let requestUrlImpl: (req: Req) => Promise<Res> = () =>
	Promise.reject(new Error('requestUrl not stubbed'));
export function setRequestUrl(fn: (req: Req) => Promise<Res>) {
	requestUrlImpl = fn;
}
export function requestUrl(req: Req) {
	return requestUrlImpl(req);
}

// Rich-description rendering belongs to Obsidian; tests do not emulate its sanitizer.
export function sanitizeHTMLToDom(html: string) {
	return { textContent: html, querySelectorAll: () => [] };
}
