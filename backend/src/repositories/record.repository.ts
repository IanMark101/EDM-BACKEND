import { AppError } from '../../../shared/domain';
import { allOf, match, repository, type ClinicRepository } from './clinic.repository';
import type { StaffNotification } from './notification.repository';
// The version claim, record, audit, notifications and handoff commit together.
export async function updateWithHistory(name: 'patients' | 'visits' | 'labReports' | 'invoices', old: any, version: unknown, patch: any, entry: any, notifications: StaffNotification[] = [], store?: ClinicRepository): Promise<void> {
  if (!store) return repository.transaction(tx => updateWithHistory(name, old, version, patch, entry, notifications, tx));
  if (version !== old.version) throw new AppError('This record changed while you were editing. Refresh it before saving.', 409);
  const at = new Date().toISOString();
  const updated = await store.update(name, { ...patch, version: old.version + 1, updatedAt: at }, allOf(match('id', old.id), match('version', old.version)));
  if (!updated.meta.changes) throw new AppError('Another staff member updated this record. Refresh before saving.', 409);
  const writes = [store.insert('activityHistory', entry)];
  if (notifications.length) writes.push(store.insert('staffNotifications', notifications, { ignore: true }));
  if (name === 'visits' && ['signed', 'cancelled'].includes(patch.status)) {
    writes.push(store.update('visitWorkflow', { queueKey: null, ...(patch.status === 'signed' ? { billingReadyAt: at } : {}) }, match('visitId', old.id)));
  }
  await store.batch(writes);
}
