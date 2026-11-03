const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), n => n.toString(16).padStart(2, '0')).join('');
export function randomToken(bytes = 32) { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }
export async function digest(value: string) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
export async function hashPassword(password: string, salt: string) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100_000, hash: 'SHA-256' }, key, 256)); }
export function constantEqual(a: string, b: string) { let different = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) different |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return different === 0; }
