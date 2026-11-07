import { randomBytes } from 'node:crypto';
import { AppError } from '../../../shared/domain';
import { hashPassword } from '../lib/crypto';
import { match, repository } from '../repositories/clinic.repository';
import { importIntoEmptyDatabase, snapshotOrder, type ClinicSnapshot } from '../repositories/snapshot.repository';

export async function initializeEmptyClinic(input: { name: string; username: string; clinicName: string; password: string; address?: string; contact?: string }) {
  const { username, password } = input;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const clinicName = typeof input.clinicName === 'string' ? input.clinicName.trim() : '';
  if (typeof username !== 'string' || !/^[a-z0-9._-]{3,40}$/.test(username) || !name || !clinicName) throw new AppError('Supply the individual manager name, username and clinic name.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 200 || password !== password.trim() || password === 'CareRecord2026!') {
    throw new AppError('Choose an individual password of 12–200 characters without leading or trailing spaces.');
  }

  const salt = randomBytes(16).toString('hex');
  const snapshot: ClinicSnapshot = {
    format: 'care-record-postgresql-v1',
    createdAt: new Date().toISOString(),
    tables: Object.fromEntries(snapshotOrder.map(name => [name, []])),
  };
  snapshot.tables.staffAccounts = [{
    id: 'STAFF-' + randomBytes(8).toString('hex').toUpperCase(),
    name, username, salt, passwordHash: await hashPassword(password, salt), role: 'manager', active: true,
  }];
  snapshot.tables.appSettings = [
    { key: 'seed-v1', value: 'individual-clinic-setup' },
    { key: 'clinic-mode', value: 'production' },
    { key: 'staff-names-20261031', value: 'individual-clinic-setup' },
    { key: 'clinic-profile', value: JSON.stringify({ name: clinicName, address: String(input.address || '').trim(), contact: String(input.contact || '').trim() }) },
  ];
  await importIntoEmptyDatabase(snapshot);
}

async function clinicMode() {
  const [mode] = await repository.find('appSettings', match('key', 'clinic-mode'));
  return mode?.value;
}

export async function prepareHostedClinic({ seedTestData, managerPassword }: { seedTestData: boolean; managerPassword?: string }) {
  if (seedTestData) throw new AppError('Turn off CLINIC_SEED_TEST_DATA before exposing the clinic API.');
  if (await clinicMode() === 'production') return false;

  const [seed] = await repository.find('appSettings', match('key', 'seed-v1'));
  if (seed) {
    // A concurrent startup may have finished between the settings reads.
    if (await clinicMode() === 'production') return false;
    throw new AppError('This database contains practice data. Set Railway to use a separate empty database.');
  }
  if (!managerPassword) throw new AppError('Set CLINIC_MANAGER_PASSWORD in Railway Variables to create the first manager.');

  try {
    await initializeEmptyClinic({ name: 'Clinic Manager', username: 'clinic-manager', clinicName: 'CareRecord Clinic', password: managerPassword });
    return true;
  } catch (error) {
    // The empty-database transaction protects existing records and serializes setup.
    if (await clinicMode() === 'production') return false;
    throw error;
  }
}
