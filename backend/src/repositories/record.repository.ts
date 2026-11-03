import { getPrisma } from '../config/prisma';
import { AppError } from '../../../shared/domain';
import { delegate, publishCommittedWrites, repository } from './clinic.repository';
import type { StaffNotification } from './notification.repository';
// The version claim, record, audit, notifications and handoff commit together.
export async function updateWithHistory(name: 'patients' | 'visits' | 'labReports' | 'invoices', old: any, version: unknown, patch: any, entry: any, notifications: StaffNotification[] = []) {
  if (version !== old.version) throw new AppError('This record changed while you were editing. Refresh it before saving.', 409);
  const noticeWrite = await getPrisma().$transaction(async tx => {
    const updated = await delegate(tx, name).updateMany({ where: { id: old.id, version: old.version }, data: { ...patch, version: old.version + 1, updatedAt: new Date().toISOString() } });
    if (!updated.count) throw new AppError('Another staff member updated this record. Refresh before saving.', 409);
    await tx.activityHistory.create({ data: entry });
    const notices = notifications.length
      ? await repository.insert('staffNotifications', notifications, { ignore: true }).execute(tx)
      : null;
    if (name === 'visits' && ['signed', 'cancelled'].includes(patch.status)) await tx.visitWorkflow.updateMany({ where: { visitId: old.id }, data: { queueKey: null, ...(patch.status === 'signed' ? { billingReadyAt: new Date().toISOString() } : {}) } });
    return notices;
  }, { timeout: 30_000 });
  if (noticeWrite) publishCommittedWrites([noticeWrite]);
}
