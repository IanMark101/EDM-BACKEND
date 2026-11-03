import type { Prisma } from '../generated/prisma/client';
import { repository } from './clinic.repository';
export type StaffNotification = Prisma.StaffNotificationCreateManyInput;
export function notificationInsert(rows: StaffNotification[]) {
  return rows.length ? [repository.insert('staffNotifications', rows, { ignore: true })] : [];
}
