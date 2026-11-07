import { AppError, assertRole, cleanText, dateOnly, ROLES } from '../../../shared/domain';
import type { Prisma } from '../generated/prisma/client';
import { historyRepository } from '../repositories/history.repository';
import type { ServiceContext } from '../http/context';
import { result } from '../http/result';

export async function historyService({ user, url }: ServiceContext) {
  assertRole(user, ['reviewer', 'manager']);
  const params = url.searchParams;
  function integer(key: string, fallback: number, allowed?: number[]) {
    const raw = params.get(key); const value = raw === null ? fallback : Number(raw);
    if (raw !== null && !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000 || allowed && !allowed.includes(value)) throw new AppError(`Choose a valid ${key === 'pageSize' ? 'page size' : 'page'}.`, 422);
    return value;
  }
  const requestedPage = integer('page', 1); const pageSize = integer('pageSize', 20, [10, 20, 50]);
  const query = cleanText(params.get('q') || '', 'Search', 120, false);
  const role = cleanText(params.get('role') || '', 'Role', 40, false);
  const action = cleanText(params.get('action') || '', 'Action', 120, false);
  if (role && ![...ROLES, 'system', 'patient'].some(value => value === role)) throw new AppError('Choose a valid role.', 422);
  const from = params.get('from') ? dateOnly(params.get('from'), 'From date', true) : '';
  const to = params.get('to') ? dateOnly(params.get('to'), 'To date', true) : '';
  if (from && to && from > to) throw new AppError('The from date must be on or before the to date.', 422);
  const scope: Prisma.ActivityHistoryWhereInput = user.role === 'manager' ? { entityType: { in: ['staff', 'session'] } } : {};
  const filters: Prisma.ActivityHistoryWhereInput[] = [scope];
  if (role) filters.push({ role });
  if (action) filters.push({ action });
  // Audit timestamps are UTC; date controls refer to the clinic's UTC+8 day.
  if (from || to) filters.push({ at: {
    ...(from ? { gte: new Date(`${from}T00:00:00+08:00`).toISOString() } : {}),
    ...(to ? { lt: new Date(Date.parse(`${to}T00:00:00+08:00`) + 86_400_000).toISOString() } : {}),
  } });
  if (query) {
    const contains = { contains: query, mode: 'insensitive' as const };
    filters.push({ OR: [{ actor: contains }, { action: contains }, { entityId: contains }, { patientId: contains },
      // Hidden clinical details must not be discoverable through search counts.
      { AND: [{ entityType: { notIn: ['visit', 'lab'] } }, { detail: contains }] },
    ] });
  }
  const where = { AND: filters };
  const [total, available] = await Promise.all([historyRepository.count(where), historyRepository.options(scope)]);
  const pages = Math.max(1, Math.ceil(total / pageSize)); const page = Math.min(requestedPage, pages);
  const records = await historyRepository.page(where, (page - 1) * pageSize, pageSize);
  const entries = records.map(row => ['visit', 'lab'].includes(row.entityType) ? { ...row, detail: 'Action recorded by the responsible department. Clinical content and correction details remain in the authorized clinical record.' } : row);
  return result({ entries, total, page, pages, pageSize,
    roles: [...new Set(available.map(row => row.role))].sort(),
    actions: [...new Set(available.map(row => row.action))].sort(),
  });
}
