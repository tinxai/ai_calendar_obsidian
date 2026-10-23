import { Platform, requestUrl } from 'obsidian';
import { base64url, decrypt, encrypt, isEncrypted, randomToken, sha256 } from './crypto';
import type GCalSync from './main';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
// Full calendar and tasks access, as before 1.2.0. 1.2.0 had narrowed this to the calendar list
// and events; the owner asked for the wider scope back in 1.6.0.
const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks';
const LOGIN_TIMEOUT_MS = 120_000;
/** Id of the sync passphrase in this device's Obsidian keychain (Settings → Keychain). Never leaves the device. */
const PASSPHRASE_ID = 'google-cal-sync-passphrase';

export class AuthError extends Error {}

/** The slice of Node's http module the loopback login uses, typed here so no Node typings are needed. */
interface LoopbackResponse {
	writeHead(status: number, headers?: Record<string, string>): LoopbackResponse;
	end(body?: string): void;
}
interface LoopbackServer {
	listen(port: number, host: string, cb: () => void): void;
	address(): { port: number } | string | null;
	close(): void;
	closeAllConnections(): void;
	once(event: 'error', cb: (e: Error) => void): void;
}
interface HttpModule {
	createServer(handler: (req: { url?: string }, res: LoopbackResponse) => void): LoopbackServer;
}

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string;
	error?: string;
	error_description?: string;
}

/**
 * The refresh token is stored in data.json encrypted with a passphrase (`enc1.…`, see crypto.ts), so vault sync carries
 * only ciphertext. Each device keeps the passphrase in its own Obsidian keychain and decrypts the token into memory.
 */
export class Auth {
	pending = false;
	private accessToken = '';
	private expiresAt = 0;
	private refreshing: Promise<string> | null = null;
	/** Decrypted refresh token, memory only. Empty while locked or logged out. */
	private refreshToken = '';
	/** The unlock started at load; `locked` is meaningful once it has settled. */
	private unlocking: Promise<boolean> | null = null;
	private settled = false;

	constructor(private plugin: GCalSync) {}

	/** A login is stored in data.json, encrypted or (from versions before 1.2.0) in plain text. */
	get loggedIn(): boolean {
		return !!this.plugin.settings.refreshToken;
	}

	/** The stored login is encrypted and this device could not decrypt it: the passphrase is missing or wrong. */
	get locked(): boolean {
		return this.loggedIn && this.settled && !this.refreshToken;
	}

	/** The stored login is still the plain-text form; setting a passphrase encrypts it. */
	get plain(): boolean {
		return this.loggedIn && !isEncrypted(this.plugin.settings.refreshToken);
	}

	get passphrase(): string {
		return this.plugin.app.secretStorage.getSecret(PASSPHRASE_ID) ?? '';
	}

	/** Derives the memory token from data.json and this device's passphrase. Resolves false when that leaves it locked. */
	unlock(passphrase = this.passphrase): Promise<boolean> {
		this.settled = false;
		this.unlocking = (async () => {
			const stored = this.plugin.settings.refreshToken;
			this.refreshToken = '';
			try {
				if (!stored) return false;
				if (!isEncrypted(stored)) {
					this.refreshToken = stored;
					return true;
				}
				if (!passphrase) return false;
				this.refreshToken = await decrypt(stored, passphrase);
				return true;
			} catch {
				return false;
			} finally {
				this.settled = true;
			}
		})();
		return this.unlocking;
	}

	/** Encrypts the memory token with the passphrase into data.json and keeps the passphrase in this device's keychain. */
	private async seal(passphrase: string): Promise<void> {
		this.plugin.settings.refreshToken = await encrypt(this.refreshToken, passphrase);
		this.plugin.app.secretStorage.setSecret(PASSPHRASE_ID, passphrase);
		await this.plugin.saveSettings();
	}

	/**
	 * The settings field. Not logged in: remembered for the login. Logged in and unlocked (or plain): re-encrypts the
	 * stored login with it. Locked: tries to unlock with it and throws when it is wrong. An empty value does nothing.
	 */
	async setPassphrase(value: string): Promise<void> {
		const v = value.trim();
		if (!v) return;
		await this.unlocking;
		if (this.refreshToken) await this.seal(v);
		else if (this.loggedIn) {
			if (!(await this.unlock(v))) throw new AuthError('Wrong sync passphrase.');
			this.plugin.app.secretStorage.setSecret(PASSPHRASE_ID, v);
		} else this.plugin.app.secretStorage.setSecret(PASSPHRASE_ID, v);
		this.plugin.notifyChanged();
	}

	/** Returns a valid access token, refreshing it with the stored refresh token when needed. Works on mobile. */
	async token(force = false): Promise<string> {
		if (!force && this.accessToken && Date.now() < this.expiresAt - 60_000)
			return this.accessToken;
		if (!this.refreshing) {
			this.refreshing = this.refresh().finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	private async refresh(): Promise<string> {
		const { clientId, clientSecret } = this.plugin.settings;
		if (!clientId || !clientSecret) throw new AuthError('Client ID and secret are missing.');
		if (!this.loggedIn) throw new AuthError('Not logged in on this device.');
		await this.unlocking;
		if (!this.refreshToken)
			throw new AuthError(
				'Enter the sync passphrase in the plugin settings to unlock the login on this device.',
			);
		await this.tokenRequest({
			grant_type: 'refresh_token',
			refresh_token: this.refreshToken,
		});
		return this.accessToken;
	}

	private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
		const { clientId, clientSecret } = this.plugin.settings;
		const body = new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			...params,
		}).toString();
		const res = await requestUrl({
			url: TOKEN_URL,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body,
			throw: false,
		});
		const data = (res.text ? JSON.parse(res.text) : {}) as TokenResponse;
		if (res.status >= 400 || !data.access_token) {
			this.accessToken = '';
			if (data.error === 'invalid_grant' && params.grant_type === 'refresh_token')
				throw new AuthError('Google connection lost. Log in again on desktop.');
			throw new AuthError(
				data.error_description || data.error || `Token request failed (${res.status})`,
			);
		}
		this.accessToken = data.access_token;
		this.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
		return data;
	}

	/** Desktop only: loopback OAuth with PKCE. Resolves after the encrypted refresh token is stored. */
	async login(): Promise<void> {
		if (!Platform.isDesktop) throw new AuthError('Login is only available on desktop.');
		if (this.pending) throw new AuthError('A login is already in progress.');
		const { clientId, clientSecret } = this.plugin.settings;
		if (!clientId || !clientSecret)
			throw new AuthError('Enter the client ID and secret first.');
		const passphrase = this.passphrase;
		if (!passphrase) throw new AuthError('Set a sync passphrase first.');
		this.pending = true;
		try {
			const verifier = randomToken(48);
			const state = randomToken(16);
			const challenge = base64url(await sha256(verifier));
			const { code, redirectUri } = await this.waitForCode(clientId, challenge, state);
			const data = await this.tokenRequest({
				grant_type: 'authorization_code',
				code,
				code_verifier: verifier,
				redirect_uri: redirectUri,
			});
			if (!data.refresh_token)
				throw new AuthError(
					'Google did not return a refresh token. Remove the app from your Google account permissions and log in again.',
				);
			this.refreshToken = data.refresh_token;
			this.settled = true;
			await this.seal(passphrase);
			await this.plugin.refreshCalendarList();
			await this.plugin.saveSettings();
			this.plugin.notifyChanged();
		} finally {
			this.pending = false;
		}
	}

	private waitForCode(
		clientId: string,
		challenge: string,
		state: string,
	): Promise<{ code: string; redirectUri: string }> {
		// Node's http exists only on desktop, where Electron exposes require on window. Never referenced on mobile.
		const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
		if (Platform.isDesktop && nodeRequire) {
			const http = nodeRequire('http') as HttpModule;
			return new Promise((resolve, reject) => {
				let done = false;
				const finish = (err: Error | null, code?: string, redirectUri?: string) => {
					if (done) return;
					done = true;
					window.clearTimeout(timer);
					server.close();
					server.closeAllConnections();
					if (err || !code || !redirectUri)
						reject(err ?? new AuthError('Login was cancelled.'));
					else resolve({ code, redirectUri });
				};
				const server = http.createServer((req, res) => {
					const url = new URL(req.url ?? '/', 'http://127.0.0.1');
					// Only Google's redirect for this login (root path, our state) counts. Anything else is answered and
					// ignored so that a stray request cannot cancel the login; the timeout still closes the server.
					if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
						res.writeHead(404).end();
						return;
					}
					const code = url.searchParams.get('code') ?? '';
					// Google's error codes are ASCII words; nothing else is echoed into the page.
					const error = (url.searchParams.get('error') ?? '').replace(/[^\w.-]/g, '');
					res.writeHead(200, {
						'Content-Type': 'text/html; charset=utf-8',
					});
					res.end(
						`<!doctype html><title>Google Calendar Tasks Sync</title><body style="font-family:sans-serif;padding:2em"><h2>${code ? 'Connected. You can close this window and return to Obsidian.' : 'Login failed.'}</h2>${error ? `<p>${error}</p>` : ''}</body>`,
					);
					if (code) finish(null, code, `http://127.0.0.1:${port}`);
					else finish(new AuthError(error || 'Google did not send a code.'));
				});
				let port = 0;
				const timer = window.setTimeout(
					() => finish(new AuthError('Timed out waiting for the browser.')),
					LOGIN_TIMEOUT_MS,
				);
				server.once('error', (e) => finish(e));
				server.listen(0, '127.0.0.1', () => {
					const addr = server.address();
					port = addr && typeof addr === 'object' ? addr.port : 0;
					const params = new URLSearchParams({
						client_id: clientId,
						redirect_uri: `http://127.0.0.1:${port}`,
						response_type: 'code',
						scope: SCOPES,
						code_challenge: challenge,
						code_challenge_method: 'S256',
						state,
						access_type: 'offline',
						prompt: 'consent',
					});
					window.open(`${AUTH_URL}?${params.toString()}`);
				});
			});
		}
		return Promise.reject(new AuthError('Login is only available on desktop.'));
	}

	/** Revokes the refresh token at Google (when this device can read it) and forgets it locally, along with cached data. */
	async logout(): Promise<void> {
		const s = this.plugin.settings;
		await this.unlocking;
		if (this.refreshToken) {
			try {
				await requestUrl({
					url: `${REVOKE_URL}?token=${encodeURIComponent(this.refreshToken)}`,
					method: 'POST',
					throw: false,
				});
			} catch {
				// Offline: the token is dropped locally anyway.
			}
		}
		this.accessToken = '';
		this.expiresAt = 0;
		this.refreshToken = '';
		this.plugin.cache.clearAll(Object.keys(s.calendars));
		this.plugin.cache.clearTasks();
		s.refreshToken = '';
		s.account = '';
		s.calendars = {};
		s.taskLists = {};
		await this.plugin.saveSettings();
		this.plugin.notifyChanged();
	}
}
