import { getPrisma } from '../config/prisma';
import { publishNotificationChanges } from '../lib/notification-events';
import type * as Models from '../generated/prisma/models';
import type { Prisma } from '../generated/prisma/client';
export const modelNames = {
  staffAccounts: 'staffAccount', staffSessions: 'staffSession', patients: 'patient', visits: 'visit', labReports: 'labReport',
  invoices: 'invoice', qualityReviews: 'qualityReview', sourceImports: 'sourceImport', warehouseFacts: 'warehouseFact',
  warehouseRuns: 'warehouseRun', activityHistory: 'activityHistory', appSettings: 'appSetting', visitWorkflow: 'visitWorkflow', staffNotifications: 'staffNotification',
} as const;
export type TableName = keyof typeof modelNames;
type NumericMoney<T> = { [K in keyof T as K extends 'recordOrder' ? never : K]: T[K] extends bigint ? number : T[K] };
type Rows = { staffAccounts: NumericMoney<Models.StaffAccountModel>; staffSessions: Models.StaffSessionModel; patients: Models.PatientModel;
  visits: Models.VisitModel; labReports: Models.LabReportModel; invoices: NumericMoney<Models.InvoiceModel>;
  qualityReviews: Models.QualityReviewModel; sourceImports: Models.SourceImportModel; warehouseFacts: NumericMoney<Models.WarehouseFactModel>;
  warehouseRuns: Models.WarehouseRunModel; activityHistory: Models.ActivityHistoryModel; appSettings: Models.AppSettingModel;
  visitWorkflow: Models.VisitWorkflowModel; staffNotifications: Models.StaffNotificationModel };
export type Transaction = Prisma.TransactionClient;
type Filter = { field: string; value: unknown; kind: 'equals' | 'in' } | { kind: 'all'; filters: Filter[] };
export const match = (field: string, value: unknown): Filter => ({ kind: 'equals', field, value });
export const oneOf = (field: string, value: unknown[]): Filter => ({ kind: 'in', field, value });
export const allOf = (...filters: Filter[]): Filter => ({ kind: 'all', filters });
function where(filter?: Filter): any {
  if (!filter) return {};
  return filter.kind === 'all' ? { AND: filter.filters.map(where) } : { [filter.field]: filter.kind === 'in' ? { in: filter.value } : filter.value };
}
export function normalizeRecord<T>(value: T): NumericMoney<T> {
  return Object.fromEntries(Object.entries(value as object).filter(([key]) => key !== 'recordOrder').map(([key, v]) => {
    if (typeof v !== 'bigint') return [key, v];
    const number = Number(v); if (!Number.isSafeInteger(number)) throw new Error('Stored money exceeds the supported exact integer range.');
    return [key, number];
  })) as NumericMoney<T>;
}
export function delegate(client: any, name: TableName): any { return client[modelNames[name]]; }
export type WriteResult = { meta: { changes: number }; recipients?: string[]; sessionsRemoved?: boolean };
export function publishCommittedWrites(writes: WriteResult[]) {
  publishNotificationChanges({
    recipients: new Set(writes.flatMap(write => write.recipients ?? [])),
    sessionsRemoved: writes.some(write => write.sessionsRemoved),
  });
}
type Operation = (tx: Transaction) => Promise<WriteResult>;
// Lazy commands retain the workflow services' atomic transaction boundaries.
class WriteCommand implements PromiseLike<WriteResult> {
  constructor(readonly table: TableName, readonly execute: Operation) {}
  then<TResult1 = WriteResult, TResult2 = never>(fulfilled?: ((value: WriteResult) => TResult1 | PromiseLike<TResult1>) | null, rejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return this.execute(getPrisma()).then(result => {
      publishCommittedWrites([result]);
      return result;
    }).then(fulfilled, rejected);
  }
}
export const repository = {
  async find<N extends TableName>(name: N, filter?: Filter, options: { orderBy?: string; limit?: number; ascending?: boolean } = {}): Promise<Rows[N][]> {
    const rows = await delegate(getPrisma(), name).findMany({ where: where(filter),
      ...(options.orderBy ? { orderBy: { [options.orderBy]: options.ascending ? 'asc' : 'desc' } } : name === 'staffAccounts' ? { orderBy: { recordOrder: 'asc' } } : {}),
      ...(options.limit !== undefined ? { take: options.limit } : {}) });
    return rows.map(normalizeRecord);
  },
  insert(name: TableName, values: any, options: { ignore?: boolean; conflict?: string; set?: any } = {}) {
    return new WriteCommand(name, async tx => {
      const table = delegate(tx, name);
      if (options.conflict) { await table.upsert({ where: { [options.conflict]: values[options.conflict] }, create: values, update: options.set }); return { meta: { changes: 1 } }; }
      if (name === 'staffNotifications') {
        const inserted = await tx.staffNotification.createManyAndReturn({
          data: values, skipDuplicates: !!options.ignore, select: { recipientId: true },
        });
        return { meta: { changes: inserted.length }, recipients: inserted.map(row => row.recipientId) };
      }
      const result = await table.createMany({ data: Array.isArray(values) ? values : [values], skipDuplicates: !!options.ignore });
      return { meta: { changes: result.count } };
    });
  },
  update(name: TableName, values: any, filter: Filter) {
    return new WriteCommand(name, async tx => {
      if (name === 'staffNotifications') {
        const updated = await tx.staffNotification.updateManyAndReturn({
          data: values, where: where(filter), select: { recipientId: true },
        });
        return { meta: { changes: updated.length }, recipients: updated.map(row => row.recipientId) };
      }
      const result = await delegate(tx, name).updateMany({ data: values, where: where(filter) });
      return { meta: { changes: result.count } };
    });
  },
  remove(name: TableName, filter?: Filter) {
    return new WriteCommand(name, async tx => {
      const result = await delegate(tx, name).deleteMany({ where: where(filter) });
      return { meta: { changes: result.count }, sessionsRemoved: name === 'staffSessions' && result.count > 0 };
    });
  },
  async batch(statements: WriteCommand[]): Promise<WriteResult[]> {
    const writes = await getPrisma().$transaction(async tx => {
      // SQLite previously serialized reporting replacements. Keep simultaneous
      // refreshes repeat-safe now that PostgreSQL permits concurrent writers.
      if (statements.some(statement => statement.table === 'warehouseFacts')) await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261103)`;
      const results = []; for (const statement of statements) results.push(await statement.execute(tx)); return results;
    }, { timeout: 60_000 });
    publishCommittedWrites(writes);
    return writes;
  },
};
