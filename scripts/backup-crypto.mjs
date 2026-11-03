import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const magic = Buffer.from('CRBK1');
export async function secureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = [process.env.USERDOMAIN, process.env.USERNAME].join(String.fromCharCode(92));
    const r = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('Could not restrict the backup directory to this Windows account.');
  }
}
export async function keyFor(directory) {
  if (process.env.CLINIC_BACKUP_KEY) {
    const key = Buffer.from(process.env.CLINIC_BACKUP_KEY, 'base64');
    if (key.length !== 32) throw new Error('CLINIC_BACKUP_KEY must contain a base64-encoded 32-byte key.');
    return key;
  }
  if (process.platform !== 'win32') throw new Error('Supply CLINIC_BACKUP_KEY through the installation secret store.');
  const keyPath = path.join(directory, 'recovery-key.dpapi');
  let protectedKey;
  try { protectedKey = await readFile(keyPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const action = protectedKey ? 'Unprotect' : 'Protect';
  const raw = protectedKey || randomBytes(32);
  const command = `Add-Type -AssemblyName System.Security; $data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $result = [Security.Cryptography.ProtectedData]::${action}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: raw.toString('base64'), encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('Windows could not unlock the backup key for this account. Use the saved recovery key.');
  const result = Buffer.from(r.stdout.trim(), 'base64');
  if (!protectedKey) { await writeFile(keyPath, result, { flag: 'wx', mode: 0o600 }); return raw; }
  if (result.length !== 32) throw new Error('The recovery key is invalid.');
  return result;
}
export function encryptSnapshot(data, key) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(magic);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]);
}
export function decryptSnapshot(data, key) {
  if (data.length < 34 || !data.subarray(0,5).equals(magic)) throw new Error('This is not a supported encrypted clinic backup.');
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(5,17)); cipher.setAAD(magic); cipher.setAuthTag(data.subarray(17,33));
  try { return Buffer.concat([cipher.update(data.subarray(33)), cipher.final()]); }
  catch { throw new Error('The backup key is incorrect or the backup has been changed.'); }
}
