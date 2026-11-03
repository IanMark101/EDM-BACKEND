import { getPrisma } from '../config/prisma';
import { AppError } from '../../../shared/domain';
import type { StaffNotification } from './notification.repository';
import { publishCommittedWrites, repository } from './clinic.repository';
export async function createBillOnce(values: any, invoiceId: string, visitId: string, event: any, notices: StaffNotification[]) {
  try {
    const noticeWrite = await getPrisma().$transaction(async tx => {
      await tx.invoice.create({ data: { ...values, items: typeof values.items === 'string' ? JSON.parse(values.items) : values.items, payments: typeof values.payments === 'string' ? JSON.parse(values.payments) : values.payments } });
      await tx.activityHistory.create({ data: event });
      return notices.length
        ? repository.insert('staffNotifications', notices, { ignore: true }).execute(tx)
        : null;
    }, { timeout: 30_000 });
    if (noticeWrite) publishCommittedWrites([noticeWrite]);
  } catch (error) {
    if ((error as any).code === 'P2002') throw new AppError('Another staff member already prepared a bill for this visit. Refresh and open the existing bill.', 409);
    throw error;
  }
}
