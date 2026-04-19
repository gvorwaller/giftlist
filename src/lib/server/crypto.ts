import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard
const AUTH_TAG_LEN = 16;

function getKey(): Buffer {
	const secret = process.env.AUTH_SECRET;
	if (!secret || secret.length < 16) {
		throw new Error('AUTH_SECRET not set or too short — required for token encryption');
	}
	return createHash('sha256').update(secret).digest();
}

/**
 * Encrypts `plaintext` → base64url string of (iv | ciphertext | tag).
 * Use for short secrets (OAuth tokens, keys). Not designed for streams.
 */
export function encryptString(plaintext: string): string {
	const key = getKey();
	const iv = randomBytes(IV_LEN);
	const cipher = createCipheriv(ALGO, key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, ct, tag]).toString('base64url');
}

export function decryptString(encoded: string): string {
	const key = getKey();
	const buf = Buffer.from(encoded, 'base64url');
	if (buf.length < IV_LEN + AUTH_TAG_LEN) {
		throw new Error('encrypted payload too short');
	}
	const iv = buf.subarray(0, IV_LEN);
	const tag = buf.subarray(buf.length - AUTH_TAG_LEN);
	const ct = buf.subarray(IV_LEN, buf.length - AUTH_TAG_LEN);
	const decipher = createDecipheriv(ALGO, key, iv);
	decipher.setAuthTag(tag);
	const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
	return pt.toString('utf8');
}
