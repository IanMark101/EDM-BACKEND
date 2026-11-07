import { getPrisma } from '../config/prisma';
import { retryDatabaseRead } from '../lib/database-recovery';
import type { Prisma } from '../generated/prisma/client';

export const historyRepository = {
  count: (where: Prisma.ActivityHistoryWhereInput) => retryDatabaseRead(() => getPrisma().activityHistory.count({ where })),
  page: (where: Prisma.ActivityHistoryWhereInput, skip: number, take: number) => retryDatabaseRead(() => getPrisma().activityHistory.findMany({ where, skip, take, orderBy: [{ at: 'desc' }, { id: 'desc' }] })),
  options: (where: Prisma.ActivityHistoryWhereInput) => retryDatabaseRead(() => getPrisma().activityHistory.findMany({ where, distinct: ['role', 'action'], select: { role: true, action: true } })),
};
