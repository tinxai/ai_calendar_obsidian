// WebCrypto helpers: PKCE values for the login and the passphrase encryption of the stored refresh token.
// Runs unchanged on desktop and mobile; nothing here touches Node or Electron.

export function base64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

const PREFIX = 'enc1.';
/** OWASP's recommended work factor for PBKDF2-HMAC-SHA256. Paid once per app start per device. */
const ITERATIONS = 600_000;

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const raw = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passphrase),
		'PBKDF2',
		false,
		['deriveKey'],
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
		raw,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

/** `enc1.<salt>.<iv>.<ciphertext>` (base64url). PBKDF2-SHA256 → AES-256-GCM, fresh salt and IV every time. */
export async function encrypt(plain: string, passphrase: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveKey(passphrase, salt);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)),
	);
	return `${PREFIX}${base64url(salt)}.${base64url(iv)}.${base64url(ct)}`;
}

export function isEncrypted(value: string): boolean {
	return value.startsWith(PREFIX);
}

/** Rejects on a wrong passphrase or a damaged value (GCM authenticates the ciphertext). */
export async function decrypt(value: string, passphrase: string): Promise<string> {
	const [salt, iv, ct] = value.slice(PREFIX.length).split('.').map(fromBase64url);
	if (!salt || !iv || !ct) throw new Error('Malformed encrypted value.');
	const key = await deriveKey(passphrase, salt);
	return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}
