import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { environment, root } from '../config/environment';
import { exportSnapshot, validateSnapshot, restoreToSeparateTarget } from '../repositories/snapshot.repository';
import { repository, match } from '../repositories/clinic.repository';
import { encryptSnapshot, decryptSnapshot, keyFor, secureDirectory } from '../../../scripts/backup-crypto.mjs';
export const backupDirectory = path.join(root, '.wrangler/protected-backups');
export function databaseFingerprint(value: string) {
  const url = new URL(value);
  return createHash('sha256').update([url.hostname.replace('-pooler', ''), url.port || '5432', url.pathname, url.searchParams.get('schema') || 'public'].join('|')).digest('hex');
}
async function recordStatus(patch: any) {
  const row = (await repository.find('appSettings', match('key', 'backup-status')))[0];
  const old = row ? JSON.parse(row.value) : {};
  const value = JSON.stringify({ ...(old.format === 'postgresql-v1' ? old : {}), format: 'postgresql-v1', ...patch });
  await repository.insert('appSettings', { key: 'backup-status', value }, { conflict: 'key', set: { value } });
}
export async function backupPostgres() {
  await secureDirectory(backupDirectory); const key = await keyFor(backupDirectory);
  const snapshot = { ...await exportSnapshot(), origin: databaseFingerprint(environment.databaseUrl) };
  const file = path.join(backupDirectory, 'postgresql-' + new Date().toISOString().replace(/[:.]/g, '-') + '.crbackup');
  await writeFile(file, encryptSnapshot(Buffer.from(JSON.stringify(snapshot)), key), { flag: 'wx', mode: 0o600 });
  await recordStatus({ createdAt: new Date().toISOString() });
  return { file, counts: Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, rows.length])) };
}
export async function verifyPostgresBackup(file: string, target?: string) {
  const resolved = path.resolve(file); const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Choose an encrypted backup inside this installation.');
  const key = await keyFor(backupDirectory);
  let snapshot: any;
  try { snapshot = JSON.parse(decryptSnapshot(await readFile(resolved), key).toString()); } catch { throw new Error('The backup could not be authenticated or is not a PostgreSQL snapshot.'); }
  validateSnapshot(snapshot);
  if (!target) return { authenticated: true, restored: false };
  if (!snapshot.origin || databaseFingerprint(target) === snapshot.origin) throw new Error('Recovery requires a separate empty PostgreSQL database or schema. The working clinic cannot be overwritten.');
  const counts = await restoreToSeparateTarget(snapshot, target);
  if (snapshot.origin === databaseFingerprint(environment.databaseUrl)) await recordStatus({ verifiedAt: new Date().toISOString() });
  return { authenticated: true, restored: true, allFieldsVerified: true, counts };
}
export function startAutomaticBackups() {
  if (!environment.databaseUrl || process.env.CLINIC_TEST_MODE === '1' || process.env.CLINIC_AUTOBACKUP === '0') return () => {};
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await backupPostgres(); } catch { console.error('Automatic encrypted backup failed. Check database, storage and key access.'); } finally { busy = false; } };
  void run(); const timer = setInterval(() => void run(), 15 * 60_000); timer.unref();
  return () => clearInterval(timer);
}
