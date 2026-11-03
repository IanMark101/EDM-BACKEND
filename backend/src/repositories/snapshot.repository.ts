import { getPrisma, createDatabaseClient } from '../config/prisma';
import { delegate, normalizeRecord, type TableName } from './clinic.repository';
import { Prisma } from '../generated/prisma/client';
export const snapshotOrder: TableName[] = ['staffAccounts', 'appSettings', 'patients', 'visits', 'labReports', 'invoices', 'qualityReviews', 'sourceImports', 'warehouseFacts', 'warehouseRuns', 'activityHistory', 'visitWorkflow', 'staffNotifications', 'staffSessions'];
export type ClinicSnapshot = { format: 'care-record-postgresql-v1'; createdAt: string; tables: Record<string, any[]> };
export async function exportSnapshot(client = getPrisma()): Promise<ClinicSnapshot> {
  return client.$transaction(async tx => {
    const tables: Record<string, any[]> = {};
    for (const name of snapshotOrder) tables[name] = (await delegate(tx, name).findMany(name === 'staffAccounts' ? { orderBy: { recordOrder: 'asc' } } : {})).map(normalizeRecord);
    return { format: 'care-record-postgresql-v1', createdAt: new Date().toISOString(), tables };
  }, { isolationLevel: 'RepeatableRead', timeout: 120_000 });
}
export function validateSnapshot(snapshot: ClinicSnapshot) {
  if (snapshot?.format !== 'care-record-postgresql-v1' || !snapshot.tables || Object.keys(snapshot.tables).length !== snapshotOrder.length) throw new Error('Unsupported clinic snapshot.');
  for (const name of snapshotOrder) {
    const rows = snapshot.tables[name]; if (!Array.isArray(rows)) throw new Error('A clinic table is missing.');
    const primary = name === 'appSettings' ? 'key' : name === 'staffSessions' ? 'tokenHash' : name === 'visitWorkflow' ? 'visitId' : 'id';
    if (rows.some(row => !row || typeof row[primary] !== 'string') || new Set(rows.map(row => row[primary])).size !== rows.length) throw new Error('Invalid or duplicate record references in snapshot.');
  }
}
export async function importIntoEmptyDatabase(snapshot: ClinicSnapshot, client = getPrisma()) {
  validateSnapshot(snapshot);
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261102)`;
    for (const name of snapshotOrder) if (await delegate(tx, name).count()) throw new Error('The target clinic database is not empty. No records were overwritten.');
    const counts: Record<string, number> = {};
    for (const name of snapshotOrder) {
      const rows = snapshot.tables[name];
      for (let i = 0; i < rows.length; i += 100) await delegate(tx, name).createMany({ data: rows.slice(i, i + 100) });
      counts[name] = await delegate(tx, name).count();
      if (counts[name] !== rows.length) throw new Error('The import count did not match the source.');
    }
    return counts;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
}
export async function restoreToSeparateTarget(snapshot: ClinicSnapshot, url: string) {
  const client = createDatabaseClient(url);
  try {
    const counts = await importIntoEmptyDatabase(snapshot, client);
    const restored = await exportSnapshot(client);
    if (JSON.stringify(snapshot.tables.staffAccounts.map(row => row.id)) !== JSON.stringify(restored.tables.staffAccounts.map(row => row.id))) throw new Error('Recovered staff presentation order did not match the snapshot.');
    const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
    for (const name of snapshotOrder) {
      const field = name === 'appSettings' ? 'key' : name === 'staffSessions' ? 'tokenHash' : name === 'visitWorkflow' ? 'visitId' : 'id';
      const ordered = (rows: any[]) => [...rows].sort((a, b) => String(a[field]).localeCompare(String(b[field])));
      if (JSON.stringify(canonical(ordered(snapshot.tables[name]))) !== JSON.stringify(canonical(ordered(restored.tables[name])))) throw new Error('Recovered records did not match the encrypted snapshot.');
    }
    return counts;
  } finally { await client.$disconnect(); }
}
