import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backupDirectory, backupPostgres, verifyPostgresBackup } from '../backend/src/services/backup.service';
import { disconnectDatabase } from '../backend/src/config/prisma';
import { keyFor, secureDirectory } from './backup-crypto.mjs';
const [command = 'backup', ...args] = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
try {
  if (command === 'backup') { const result = await backupPostgres(); console.log(JSON.stringify({ ok: true, backup: path.basename(result.file), counts: result.counts })); }
  else if (command === 'verify' || command === 'restore') {
    const file = option('--file'); if (!file) throw new Error('Select an encrypted backup with --file.');
    if (command === 'restore' && !process.env.CLINIC_RECOVERY_DATABASE_URL) throw new Error('Set CLINIC_RECOVERY_DATABASE_URL to a separate empty PostgreSQL target.');
    console.log(JSON.stringify(await verifyPostgresBackup(file, process.env.CLINIC_RECOVERY_DATABASE_URL)));
  } else if (command === 'export-recovery-key') {
    await secureDirectory(backupDirectory); await writeFile(path.join(backupDirectory, 'offline-recovery-key.txt'), (await keyFor(backupDirectory)).toString('base64'), { flag: 'wx', mode: 0o600 });
    console.log('Recovery key exported inside the protected backup folder. Store it separately with restricted access.');
  } else throw new Error('Use backup, verify, restore or export-recovery-key.');
} catch { console.error('The PostgreSQL backup operation failed. Check the backup, private target configuration, permissions and key access.'); process.exitCode = 1; }
finally { await disconnectDatabase(); }
