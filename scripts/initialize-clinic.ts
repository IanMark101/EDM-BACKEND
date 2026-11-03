import { randomBytes } from 'node:crypto';
import { hashPassword } from '../backend/src/lib/crypto';
import { importIntoEmptyDatabase, snapshotOrder, type ClinicSnapshot } from '../backend/src/repositories/snapshot.repository';
import { disconnectDatabase } from '../backend/src/config/prisma';
let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 10_000) throw new Error('Setup input is too large.'); }
let stage = 'input validation';
try {
  const input = JSON.parse(raw);
  if (input.database) throw new Error('Configure the Neon target in backend/.env instead of supplying a SQLite file.');
  if (!/^[a-z0-9._-]{3,40}$/.test(input.username || '') || !String(input.name || '').trim() || !String(input.clinicName || '').trim()) throw new Error('Supply the individual manager name, username and clinic name.');
  if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 200 || input.password === 'CareRecord2026!') throw new Error('Use an individual password of 12–200 characters.');
  const salt = randomBytes(16).toString('hex');
  stage = 'password setup';
  const snapshot: ClinicSnapshot = { format: 'care-record-postgresql-v1', createdAt: new Date().toISOString(), tables: Object.fromEntries(snapshotOrder.map(name => [name, []])) };
  snapshot.tables.staffAccounts = [{ id: 'STAFF-' + randomBytes(8).toString('hex').toUpperCase(), name: input.name.trim(), username: input.username, salt, passwordHash: await hashPassword(input.password, salt), role: 'manager', active: true }];
  snapshot.tables.appSettings = [
    { key: 'seed-v1', value: 'individual-clinic-setup' }, { key: 'clinic-mode', value: 'production' }, { key: 'staff-names-20261031', value: 'individual-clinic-setup' },
    { key: 'clinic-profile', value: JSON.stringify({ name: input.clinicName.trim(), address: String(input.address || '').trim(), contact: String(input.contact || '').trim() }) },
  ];
  stage = 'empty-database initialization';
  await importIntoEmptyDatabase(snapshot);
  console.log(JSON.stringify({ ok: true, patients: 0, staff: 1, message: 'Empty PostgreSQL clinic initialized with one individual manager.' }));
} catch (error) { console.error('Clinic initialization failed during ' + stage + ' (' + ((error as any)?.code || (error as any)?.name || 'validation') + '). Check private input and an empty PostgreSQL target.'); process.exitCode = 1; }
finally { await disconnectDatabase(); }
