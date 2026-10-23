import { requestUrl } from 'obsidian';

export class GoogleError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export interface TokenSource {
	token(force?: boolean): Promise<string>;
}

export interface CallOptions {
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
}

/** Thin requestUrl wrapper: bearer token, one retry after 401, errors as GoogleError. */
export class GoogleClient {
	constructor(private auth: TokenSource) {}

	async call<T = unknown>(method: string, url: string, opts: CallOptions = {}): Promise<T> {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(opts.query ?? {}))
			if (v !== undefined && v !== '') q.set(k, String(v));
		const full = q.size ? `${url}?${q.toString()}` : url;
		let res = await this.send(method, full, await this.auth.token(), opts);
		if (res.status === 401)
			res = await this.send(method, full, await this.auth.token(true), opts);
		if (res.status >= 400) {
			let msg = `HTTP ${res.status}`;
			try {
				const j = JSON.parse(res.text) as {
					error?: { message?: string } | string;
				};
				msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? msg);
			} catch {
				// Non-JSON error body: keep the status text.
			}
			throw new GoogleError(res.status, msg);
		}
		return (res.text ? JSON.parse(res.text) : undefined) as T;
	}

	private send(method: string, url: string, token: string, opts: CallOptions) {
		return requestUrl({
			url,
			method,
			headers: { Authorization: `Bearer ${token}`, ...opts.headers },
			contentType: opts.body === undefined ? undefined : 'application/json',
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			throw: false,
		});
	}
}
