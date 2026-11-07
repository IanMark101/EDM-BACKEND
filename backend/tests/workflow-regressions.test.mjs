import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Bundle real services/repositories while replacing only the database, environment
// and startup seeding. Tests cannot connect to or seed an installed clinic.
const bundle = await build({
  stdin: { contents: `
    export { importsService, reviewsService, invoicesService } from './backend/src/services/clinic.service.ts';
    export { refreshWarehouse, visibleData } from './backend/src/services/server.ts';
    export { servicePricesService } from './backend/src/services/pricing.service.ts';
    export { historyService } from './backend/src/services/history.service.ts';
    export { chargeOffers } from './shared/billing.ts';
    export { renderDocument } from './backend/src/services/print-document.ts';
    export { repository } from './backend/src/repositories/clinic.repository.ts';
    export { onNotificationChanges } from './backend/src/lib/notification-events.ts';
    export { routeRequest } from './backend/src/routes/clinic.routes.ts';
  `, resolveDir: root },
  write: false, bundle: true, platform: 'node', format: 'esm', tsconfigRaw: {},
  plugins: [{ name: 'isolated-database', setup(build) {
    build.onResolve({ filter: /config\/prisma$/ }, () => ({ path: 'prisma', namespace: 'fixture' }));
    build.onResolve({ filter: /config\/environment$/ }, () => ({ path: 'environment', namespace: 'fixture' }));
    build.onResolve({ filter: /repositories\/seed$/ }, () => ({ path: 'seed', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
      args.path === 'prisma' ? 'export const getPrisma=()=>globalThis.__workflowDatabase.client;' :
      args.path === 'environment' ? 'export const environment={origins:[],databaseUrl:"",seedTestData:false};' :
      'export const ensureSeed=async()=>{};' }));
    build.onResolve({ filter: /^\./ }, args => {
      const base = resolve(args.namespace === 'source' ? dirname(args.importer) : root, args.path);
      const path = [base, `${base}.ts`, `${base}.mjs`].find(path => existsSync(path));
      if (!path) throw new Error(`Missing source: ${base}`);
      return { path, namespace: 'source' };
    });
    build.onLoad({ filter: /.*/, namespace: 'source' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: extname(args.path) === '.ts' ? 'ts' : 'js' }));
  } }],
});
const { importsService, reviewsService, invoicesService, servicePricesService, historyService, chargeOffers, visibleData, renderDocument, refreshWarehouse, repository, onNotificationChanges, routeRequest } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const modelNames = ['staffAccount', 'staffSession', 'patient', 'visit', 'labReport', 'invoice', 'qualityReview', 'sourceImport', 'warehouseFact', 'warehouseRun', 'activityHistory', 'appSetting', 'visitWorkflow', 'staffNotification', 'patientPortalAccount', 'patientPortalSession'];
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every(filter => matches(row, filter));
    if (key === 'OR') return value.some(filter => matches(row, filter));
    if (value && typeof value === 'object') return Object.entries(value).every(([op, expected]) => op === 'in' ? expected.includes(row[key]) : op === 'notIn' ? !expected.includes(row[key]) : op === 'gte' ? row[key] >= expected : op === 'lt' ? row[key] < expected : op === 'contains' ? String(row[key] ?? '').toLowerCase().includes(String(expected).toLowerCase()) : op === 'mode');
    return row[key] === value;
  });
}
function memoryDatabase() {
  const db = { tables: Object.fromEntries(modelNames.map(name => [name, []])), options: [], locks: [], active: false, failure: null, serializationFailures: 0 };
  function clientFor(tables, transactional = false) {
    const client = { async $executeRaw(strings, ...values) { assert.equal(transactional, true); db.locks.push(values[0]); return 1; } };
    function before(name, action) {
      assert.ok(!db.active || transactional, `Database access escaped the transaction: ${name}.${action}`);
      if (db.failure?.(name, action)) throw new Error(`Injected ${name}.${action} failure`);
    }
    for (const name of modelNames) {
      const list = () => transactional ? tables[name] : db.tables[name];
      function insert(data, skipDuplicates) {
        let count = 0; const rows = [];
        for (const item of Array.isArray(data) ? data : [data]) {
          const duplicate = list().some(row => item.id !== undefined && row.id === item.id || name === 'appSetting' && row.key === item.key || name === 'sourceImport' && row.source === item.source && row.externalId === item.externalId || name === 'invoice' && row.visitId === item.visitId || name === 'staffNotification' && row.recipientId === item.recipientId && row.eventKey === item.eventKey);
          if (duplicate) { if (skipDuplicates) continue; throw Object.assign(new Error('Unique constraint'), { code: 'P2002' }); }
          const defaults = name === 'invoice' ? { total: 0, paid: 0, payments: [], version: 1 } : name === 'qualityReview' ? { state: 'open' } : name === 'labReport' ? { layout: 'general', measurements: [], history: [], doctorReview: {}, version: 1 } : {};
          const row = structuredClone({ ...defaults, ...item }); list().push(row); rows.push(row); count++;
        }
        return { count, rows };
      }
      client[name] = {
        async upsert({ where, create, update }) {
          before(name, 'upsert');
          const existing = list().find(row => matches(row, where));
          if (existing) return Object.assign(existing, structuredClone(update));
          return insert(create, false).rows[0];
        },
        async count({ where } = {}) { before(name, 'count'); return list().filter(row => matches(row, where)).length; },
        async findMany({ where, orderBy, take, skip = 0, distinct } = {}) {
          before(name, 'findMany'); let rows = list().filter(row => matches(row, where));
          if (orderBy) { const orders = Array.isArray(orderBy) ? orderBy : [orderBy]; rows.sort((a, b) => { for (const order of orders) { const [key, direction] = Object.entries(order)[0]; const value = String(a[key]).localeCompare(String(b[key])) * (direction === 'asc' ? 1 : -1); if (value) return value; } return 0; }); }
          if (distinct) { const seen = new Set(); rows = rows.filter(row => { const key = JSON.stringify(distinct.map(field => row[field])); if (seen.has(key)) return false; seen.add(key); return true; }); }
          return structuredClone(rows.slice(skip, take === undefined ? undefined : skip + take));
        },
        async create({ data }) { before(name, 'create'); return insert(data, false).rows[0]; },
        async createMany({ data, skipDuplicates }) { before(name, 'createMany'); return { count: insert(data, skipDuplicates).count }; },
        async createManyAndReturn({ data, skipDuplicates }) { before(name, 'createMany'); return insert(data, skipDuplicates).rows; },
        async updateMany({ where, data }) { before(name, 'updateMany'); const rows = list().filter(row => matches(row, where)); rows.forEach(row => Object.assign(row, structuredClone(data))); return { count: rows.length }; },
        async updateManyAndReturn({ where, data }) { before(name, 'updateMany'); const rows = list().filter(row => matches(row, where)); rows.forEach(row => Object.assign(row, structuredClone(data))); return structuredClone(rows); },
        async deleteMany({ where }) { before(name, 'deleteMany'); const rows = list(); const keep = rows.filter(row => !matches(row, where)); if (transactional) tables[name] = keep; else db.tables[name] = keep; return { count: rows.length - keep.length }; },
      };
    }
    return client;
  }
  let queue = Promise.resolve();
  db.client = clientFor(db.tables);
  db.client.$transaction = (work, options) => {
    assert.equal(db.active, false, 'Nested transaction escaped the scoped repository');
    const execute = async () => {
      db.active = true; db.options.push(options); const draft = structuredClone(db.tables);
      try {
        const result = await work(clientFor(draft, true));
        if (db.serializationFailures > 0) { db.serializationFailures--; throw Object.assign(new Error('Serialization conflict'), { code: 'P2034' }); }
        db.tables = draft; return result;
      } finally { db.active = false; }
    };
    const operation = queue.then(execute); queue = operation.catch(() => {}); return operation;
  };
  return db;
}

let db;
beforeEach(() => {
  db = memoryDatabase(); globalThis.__workflowDatabase = db;
  db.tables.appSetting.push({ key: 'service-prices-v1', value: JSON.stringify({ version: 1, entries: [{ id: 'PRICE-CONSULT', kind: 'consultation', name: 'Consultation', amount: 1001, active: true, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'Manager', updatedById: 'U-MANAGER' }] }) });
  db.tables.patient.push({ id: 'P-1', name: 'Audit Patient', dob: '2000-01-01', doctorId: 'D-1' });
  db.tables.visit.push({ id: 'V-1', patientId: 'P-1', doctorId: 'D-1', date: '2026-01-02', status: 'signed', signedAt: '2026-01-02T02:00:00Z', updatedAt: '2026-01-02T02:00:00Z' });
  db.tables.staffAccount.push({ id: 'U-REVIEW', name: 'Reviewer', role: 'reviewer', active: true }, { id: 'U-LAB', name: 'Laboratory', role: 'laboratory', active: true });
});
const sourceRow = (externalId, extra = {}) => ({ externalId, patientId: 'P-1', patientName: 'Audit Patient', patientDob: '2000-01-01', visitId: 'V-1', ...extra });
const bill = (externalId, extra = {}) => sourceRow(externalId, { date: '2026-01-02', items: [{ description: 'Consultation', amount: '10.01' }], ...extra });
const lab = (externalId, extra = {}) => sourceRow(externalId, { testName: 'Glucose', value: '92', unit: 'mg/dL', collectedAt: '2026-01-02T09:00:00+08:00', ...extra });
const receive = (source, records) => importsService({ user: { id: 'U-STAFF', name: 'Staff', role: source }, input: { source, records } });
const decide = (id, decision = 'link') => reviewsService({ id, user: { id: 'U-REVIEW', name: 'Reviewer', role: 'reviewer' }, input: { decision, patientId: 'P-1', visitId: 'V-1', confirmedDob: '2000-01-01', evidence: 'Verified original identity documents.' } });

test('unsigned bill leaves no staged row and succeeds after signing', async () => {
  db.tables.visit[0].status = 'draft';
  await assert.rejects(receive('billing', [bill('B-1')]), /No records from this file were saved.*B-1.*completed/);
  assert.equal(db.tables.sourceImport.length, 0); assert.equal(db.tables.invoice.length, 0);
  db.tables.visit[0].status = 'signed';
  assert.deepEqual((await receive('billing', [bill('B-1')])).body, { imported: 1, held: 0, skipped: 0 });
  assert.equal(db.tables.invoice[0].total, 1001);
});
test('second-row failure rolls back the first bill, audit and source rows', async () => {
  db.tables.visit.push({ ...db.tables.visit[0], id: 'V-2', status: 'draft' });
  await assert.rejects(receive('billing', [bill('B-1'), bill('B-2', { visitId: 'V-2' })]), /No records.*B-2/);
  for (const name of ['invoice', 'sourceImport', 'activityHistory', 'staffNotification']) assert.equal(db.tables[name].length, 0, name);
});
test('duplicate bills for one visit reject the entire file', async () => {
  await assert.rejects(receive('billing', [bill('B-1'), bill('B-2')]), /already has a bill/);
  assert.equal(db.tables.invoice.length, 0); assert.equal(db.tables.sourceImport.length, 0);
});
test('already imported references and repeats within a file are skipped', async () => {
  const result = await receive('laboratory', [lab('L-1'), lab('L-1')]);
  assert.deepEqual(result.body, { imported: 1, held: 0, skipped: 1 });
  assert.equal((await receive('laboratory', [lab('L-1')])).body.skipped, 1);
  assert.equal(db.tables.labReport.length, 1);
});
test('legacy held staging row retries its stored payload, preserving original source data', async () => {
  db.tables.sourceImport.push({ id: 'IMP-OLD', source: 'billing', externalId: 'B-1', payload: bill('B-1'), state: 'held', receivedAt: '2026-01-02T00:00:00Z' });
  assert.equal((await receive('billing', [bill('B-1', { items: [{ description: 'Changed', amount: '99' }] })])).body.imported, 1);
  assert.equal(db.tables.sourceImport.length, 1); assert.equal(db.tables.sourceImport[0].state, 'imported'); assert.equal(db.tables.invoice[0].total, 1001);
});
test('identity hold creates review and repeated files cannot bypass it', async () => {
  assert.equal((await receive('laboratory', [lab('L-1', { patientName: 'Uncertain Name' })])).body.held, 1);
  assert.equal(db.tables.qualityReview[0].kind, 'identity');
  assert.equal((await receive('laboratory', [lab('L-1')])).body.skipped, 1); assert.equal(db.tables.labReport.length, 0);
});
test('identity linking and quality-review resolution commit together', async () => {
  await receive('laboratory', [lab('L-1', { patientName: 'Uncertain Name' })]);
  await decide(db.tables.qualityReview[0].id);
  assert.equal(db.tables.labReport.length, 1); assert.equal(db.tables.sourceImport[0].state, 'imported'); assert.equal(db.tables.qualityReview[0].state, 'resolved');
});
test('a keep-separate identity decision cannot be reversed by resubmitting a file', async () => {
  await receive('laboratory', [lab('L-1', { patientName: 'Uncertain Name' })]);
  await decide(db.tables.qualityReview[0].id, 'keep-separate');
  assert.equal((await receive('laboratory', [lab('L-1')])).body.skipped, 1);
  assert.equal(db.tables.sourceImport[0].state, 'kept-separate'); assert.equal(db.tables.labReport.length, 0);
});
test('simultaneous submissions of the same source are serialized and repeat-safe', async () => {
  const results = await Promise.all([receive('laboratory', [lab('L-1')]), receive('laboratory', [lab('L-1')])]);
  assert.equal(results.reduce((sum, result) => sum + result.body.imported, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.body.skipped, 0), 1);
  assert.equal(db.tables.labReport.length, 1); assert.ok(db.locks.every(lock => lock === 20261105));
});
test('malformed charge rows are validation errors without writes', async () => {
  await assert.rejects(receive('billing', [bill('B-1', { items: [null] })]), error => error.status === 422);
  assert.equal(db.tables.sourceImport.length, 0);
});
test('failed review resolution rolls back materialized report and notifications', async () => {
  await receive('laboratory', [lab('L-1', { patientName: 'Uncertain Name' })]);
  const before = structuredClone(db.tables);
  db.failure = (name, action) => name === 'qualityReview' && action === 'updateMany';
  await assert.rejects(decide(db.tables.qualityReview[0].id), /Injected/);
  assert.deepEqual(db.tables, before);
});
test('lab quality-task failure rolls back the source and draft report', async () => {
  db.failure = (name, action) => name === 'qualityReview' && action === 'createMany';
  await assert.rejects(receive('laboratory', [lab('L-1', { unit: '' })]), /Injected/);
  assert.equal(db.tables.labReport.length, 0); assert.equal(db.tables.sourceImport.length, 0);
});
test('normalizes identity whitespace and collection offsets before persisting', async () => {
  await receive('laboratory', [lab('L-1', { patientId: ' P-1 ', patientName: ' Audit Patient ', visitId: ' V-1 ' })]);
  assert.equal(db.tables.labReport[0].collectedAt, '2026-01-02T01:00:00.000Z'); assert.equal(db.tables.sourceImport[0].payload.patientId, 'P-1');
});
test('rejects offset-free and impossible timestamps without writes, allowing year boundaries', async () => {
  for (const collectedAt of ['2026-01-02T09:00:00', '2026-02-30T09:00:00Z']) {
    await assert.rejects(receive('laboratory', [lab('L-BAD', { collectedAt })]), /No records/); assert.equal(db.tables.sourceImport.length, 0);
  }
  await receive('laboratory', [lab('L-1', { collectedAt: '2026-01-01T01:00:00+08:00' })]);
  assert.equal(db.tables.labReport[0].collectedAt, '2025-12-31T17:00:00.000Z');
});
test('notifications publish only after the enclosing transaction commits', async () => {
  const observed = []; const stop = onNotificationChanges(() => observed.push({ active: db.active, reports: db.tables.labReport.length }));
  try {
    await receive('laboratory', [lab('L-1', { unit: '' })]);
    assert.deepEqual(observed, [{ active: false, reports: 1 }]);
    db.failure = (name, action) => name === 'qualityReview' && action === 'createMany';
    await assert.rejects(receive('laboratory', [lab('L-2', { unit: '' })])); assert.equal(observed.length, 1);
  } finally { stop(); }
});
test('import role checks happen before opening a transaction', async () => {
  await assert.rejects(importsService({ user: { role: 'doctor' }, input: { source: 'billing', records: [bill('B-1')] } }), /permission/);
  assert.equal(db.options.length, 0);
});
test('reporting reads and replacement use one serializable transaction, retrying a conflict', async () => {
  db.tables.visit.push({ ...db.tables.visit[0], id: 'V-DRAFT', status: 'draft' });
  db.tables.labReport.push({ ...lab('L-1'), id: 'L-1', patientId: 'P-1', visitId: 'V-1', status: 'approved', approvedAt: '2026-01-02T03:00:00Z', sourceRef: 'L-EXT' });
  db.tables.invoice.push({ id: 'B-1', patientId: 'P-1', visitId: 'V-1', date: '2026-01-02', total: 1001, paid: 400, sourceRef: 'B-EXT', payments: [{ id: 'PAY-1', amount: 400, at: '2026-01-03T01:00:00Z' }] });
  db.tables.warehouseFact.push({ id: 'OLD' }); db.serializationFailures = 1;
  const result = await refreshWarehouse({ id: 'U-REVIEW', name: 'Reviewer', role: 'reviewer' });
  assert.equal(result.count, 4); assert.equal(db.tables.warehouseRun.length, 1);
  assert.equal(db.tables.warehouseFact.some(row => row.id === 'OLD' || row.id === 'visit:V-DRAFT'), false);
  assert.equal(db.tables.warehouseFact.find(row => row.kind === 'payment').date, '2026-01-03');
  assert.equal(db.options.length, 2); assert.ok(db.options.every(option => option.isolationLevel === 'Serializable')); assert.ok(db.locks.every(lock => lock === 20261103));
});
test('exhausted reporting conflicts leave existing figures and return a retryable error', async () => {
  db.tables.warehouseFact.push({ id: 'OLD' }); db.serializationFailures = 3;
  await assert.rejects(refreshWarehouse({ id: 'U-REVIEW', name: 'Reviewer', role: 'reviewer' }), error => error.status === 409);
  assert.deepEqual(db.tables.warehouseFact, [{ id: 'OLD' }]); assert.equal(db.tables.warehouseRun.length, 0);
});
test('standalone repository writes and batches retain their existing behavior', async () => {
  await repository.insert('activityHistory', { id: 'AUD-1' });
  await repository.batch([repository.insert('activityHistory', { id: 'AUD-2' })]);
  assert.deepEqual(db.tables.activityHistory.map(row => row.id), ['AUD-1', 'AUD-2']);
});

const manager = { id: 'U-MANAGER', name: 'Manager', role: 'manager', active: true };
const cashier = { id: 'U-BILLING', name: 'Cashier', role: 'billing', active: true };
const pricesNow = () => JSON.parse(db.tables.appSetting.find(setting => setting.key === 'service-prices-v1')?.value || '{"version":0,"entries":[]}');
const savePrice = (input = {}, user = manager) => servicePricesService({ request: new Request('http://localhost/api/service-prices', { method: 'POST' }), user,
  input: { version: pricesNow().version, kind: 'laboratory', name: 'Glucose', amount: '250', active: true, ...input } });
const changeConsultationPrice = (amount, extra = {}) => savePrice({ id: 'PRICE-CONSULT', kind: 'consultation', amount, reason: 'Clinic approved the revised service fee.', ...extra });
const prepareBill = (input = {}, user = cashier) => invoicesService({ user, id: '', action: '', input: { patientId: 'P-1', visitId: 'V-1', date: '2026-01-02', priceListVersion: pricesNow().version, items: [{ sourceKey: 'visit:V-1' }], ...input } });
const addServices = (input = {}) => {
  const bill = db.tables.invoice[0];
  return invoicesService({ user: cashier, id: bill.id, action: 'add-charges', input: { version: bill.version, priceListVersion: pricesNow().version, reason: 'Laboratory service completed after the first bill.', items: [{ sourceKey: 'lab:L-APPROVED' }], ...input } });
};
function approvedLab() {
  db.tables.labReport.push({ id: 'L-APPROVED', patientId: 'P-1', visitId: 'V-1', testName: 'Glucose', value: 'PRIVATE LAB VALUE', unit: 'mg/dL', collectedAt: '2026-01-02T02:00:00Z', approvedAt: '2026-01-02T03:00:00Z', approvedBy: 'U-LAB', status: 'approved', sourceRef: 'LAB-ORIGINAL', doctorReview: {}, history: [] });
}

test('only managers set prices, while billing can read them', async () => {
  for (const role of ['billing', 'doctor', 'laboratory', 'registration', 'reviewer']) await assert.rejects(savePrice({}, { ...cashier, role }), error => error.status === 403);
  const read = user => servicePricesService({ request: new Request('http://localhost/api/service-prices'), user });
  assert.equal((await read(cashier)).body.entries[0].amount, 1001);
  await assert.rejects(read({ role: 'doctor' }), error => error.status === 403);
  assert.equal(db.options.length, 0);
});

test('a fresh clinic has no assumed prices and the manager can set its first one', async () => {
  db.tables.appSetting = [];
  assert.equal(pricesNow().entries.length, 0);
  const result = await savePrice({ kind: 'consultation', amount: '500' });
  assert.equal(result.body.version, 1); assert.equal(result.body.entries[0].amount, 50000);
  assert.equal(result.body.entries[0].updatedById, manager.id);
  assert.equal(db.tables.activityHistory[0].action, 'Set service price');
});

test('prices require positive exact amounts, valid kinds, availability and unique service names', async () => {
  for (const amount of ['0', '-1', '1.234', 'abc', '1000000.01']) await assert.rejects(savePrice({ amount }), error => error.status === 422);
  await assert.rejects(savePrice({ kind: 'other' }), error => error.status === 422);
  await assert.rejects(savePrice({ active: 'true' }), error => error.status === 422);
  await assert.rejects(savePrice({ kind: 'consultation' }), error => error.status === 409);
  await savePrice({ name: '  Glucose  ' });
  await assert.rejects(savePrice({ name: 'glucose' }), error => error.status === 409);
});

test('price edits require a reason and reject outdated versions without overwriting a newer fee', async () => {
  await assert.rejects(changeConsultationPrice('15', { reason: 'short' }), error => error.status === 422);
  await changeConsultationPrice('15');
  await assert.rejects(changeConsultationPrice('20', { version: 1 }), error => error.status === 409);
  assert.equal(pricesNow().entries[0].amount, 1500); assert.equal(db.tables.activityHistory.length, 1);
});

test('price and its activity record commit together', async () => {
  const before = structuredClone(db.tables);
  db.failure = (name, action) => name === 'activityHistory' && action === 'createMany';
  await assert.rejects(changeConsultationPrice('15'), /Injected/);
  assert.deepEqual(db.tables, before);
});

test('billing calculates prices on the server and saves the service and price sources', async () => {
  await prepareBill({ items: [{ sourceKey: 'visit:V-1', amount: '0.01', description: 'Forged price' }] });
  const saved = db.tables.invoice[0];
  assert.equal(saved.total, 1001); assert.equal(saved.items[0].description, 'Consultation');
  assert.equal(saved.items[0].source.recordId, 'V-1'); assert.equal(saved.items[0].price.amount, 1001);
  assert.equal(saved.items[0].price.setBy, 'Manager'); assert.equal(saved.items[0].addedBy, 'Cashier');
  await assert.rejects(prepareBill(), error => error.status === 409);
  assert.equal(db.tables.invoice.length, 1);
});

test('billing rejects unauthorized accounts, uncompleted visits and unrelated service records', async () => {
  await assert.rejects(prepareBill({}, { role: 'doctor' }), error => error.status === 403);
  await assert.rejects(prepareBill({ patientId: 'P-OTHER' }), error => error.status === 422);
  await assert.rejects(prepareBill({ items: [{ sourceKey: 'visit:V-OTHER' }] }), error => error.status === 422);
  await assert.rejects(prepareBill({ items: [{ description: 'Made-up charge', amount: '999' }] }), error => error.status === 422);
  db.tables.visit[0].status = 'draft';
  await assert.rejects(prepareBill(), /complete the consultation/); assert.equal(db.tables.invoice.length, 0);
});

test('laboratory charges require an approved complete report from the same patient and visit', async () => {
  await savePrice(); approvedLab();
  const items = [{ sourceKey: 'visit:V-1' }, { sourceKey: 'lab:L-APPROVED' }];
  for (const patch of [{ status: 'draft' }, { collectedAt: '' }, { patientId: 'P-OTHER' }, { visitId: 'V-OTHER' }]) {
    const original = structuredClone(db.tables.labReport[0]); Object.assign(db.tables.labReport[0], patch);
    await assert.rejects(prepareBill({ items }), error => error.status === 422); db.tables.labReport[0] = original;
  }
  await prepareBill({ items });
  assert.equal(db.tables.invoice[0].total, 26001); assert.equal(db.tables.invoice[0].items[1].source.originalRef, 'LAB-ORIGINAL');
});

test('missing or disabled prices and outdated quotes block new charges', async () => {
  await changeConsultationPrice('15', { active: false });
  await assert.rejects(prepareBill({ priceListVersion: 1 }), error => error.status === 409);
  await assert.rejects(prepareBill(), /active price/);
  db.tables.appSetting = [];
  await assert.rejects(prepareBill(), /active price/); assert.equal(db.tables.invoice.length, 0);
});

test('one service cannot be selected twice and new bills include the consultation', async () => {
  await assert.rejects(prepareBill({ items: [{ sourceKey: 'visit:V-1' }, { sourceKey: 'visit:V-1' }] }), /charged twice/);
  await savePrice(); approvedLab();
  await assert.rejects(prepareBill({ items: [{ sourceKey: 'lab:L-APPROVED' }] }), /Include the completed consultation/);
  assert.equal(db.tables.invoice.length, 0);
});

test('later approved services use current prices while earlier charges keep their saved prices', async () => {
  await prepareBill(); const firstCharge = structuredClone(db.tables.invoice[0].items[0]);
  await changeConsultationPrice('500'); await savePrice(); approvedLab();
  await addServices();
  assert.equal(db.tables.invoice[0].total, 26001); assert.deepEqual(db.tables.invoice[0].items[0], firstCharge);
  assert.equal(db.tables.invoice[0].items[1].price.version, 3);
  await assert.rejects(addServices(), /already includes/);
  assert.equal(db.tables.invoice[0].items.length, 2);
});

test('outdated invoice edits and short additional-service reasons do not change a bill', async () => {
  await prepareBill(); await savePrice(); approvedLab(); const original = structuredClone(db.tables.invoice[0]);
  await assert.rejects(addServices({ version: 0 }), error => error.status === 409);
  await assert.rejects(addServices({ reason: 'short' }), error => error.status === 422);
  assert.deepEqual(db.tables.invoice[0], original);
});

test('simultaneous bill creation produces one bill and one committed activity entry', async () => {
  const results = await Promise.allSettled([prepareBill(), prepareBill()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(db.tables.invoice.length, 1); assert.equal(db.tables.activityHistory.length, 1);
});

test('invoice and price provenance roll back when recording activity fails', async () => {
  db.failure = (name, action) => name === 'activityHistory' && action === 'createMany';
  await assert.rejects(prepareBill(), /Injected/);
  assert.equal(db.tables.invoice.length, 0); assert.equal(db.tables.staffNotification.length, 0);
});

test('old bills keep their amounts and matching earlier descriptions are not offered twice', async () => {
  db.tables.invoice.push({ id: 'B-OLD', patientId: 'P-1', visitId: 'V-1', items: [{ description: 'Consultation', amount: 1234 }], total: 1234, paid: 400, payments: [], version: 1 });
  await savePrice(); approvedLab();
  const offers = chargeOffers(db.tables.visit[0], db.tables.labReport, [], pricesNow(), db.tables.invoice[0]);
  assert.equal(offers[0].alreadyBilled, true);
  await addServices();
  assert.equal(db.tables.invoice[0].total, 26234); assert.equal(db.tables.invoice[0].items[0].amount, 1234); assert.equal(db.tables.invoice[0].paid, 400);
});

test('existing payments work without a price list and still reject excess payments', async () => {
  db.tables.invoice.push({ id: 'B-OLD', patientId: 'P-1', visitId: 'V-1', items: [{ description: 'Original', amount: 1001 }], total: 1001, paid: 0, payments: [], version: 1 });
  db.tables.appSetting = [];
  const pay = input => invoicesService({ id: 'B-OLD', action: 'payment', user: cashier, input: { version: 1, method: 'Cash', reference: '', ...input } });
  await assert.rejects(pay({ amount: '10.02' }), /greater than/);
  await pay({ amount: '4.00' });
  assert.equal(db.tables.invoice[0].paid, 400); assert.equal(db.tables.invoice[0].total, 1001); assert.equal(db.tables.invoice[0].payments[0].by, 'Cashier');
});

test('billing imports must use approved prices and retain their original record reference', async () => {
  await assert.rejects(receive('billing', [bill('B-WRONG', { items: [{ description: 'Consultation', amount: '999' }] })]), /approved price/);
  assert.equal(db.tables.sourceImport.length, 0); assert.equal(db.tables.invoice.length, 0);
  await receive('billing', [bill('B-CORRECT')]);
  assert.equal(db.tables.invoice[0].sourceRef, 'B-CORRECT'); assert.equal(db.tables.invoice[0].items[0].price.setBy, 'Manager'); assert.equal(db.tables.invoice[0].items[0].source.recordId, 'V-1');
});

test('identity linking cannot bypass an imported bill price mismatch', async () => {
  await receive('billing', [bill('B-HELD', { patientName: 'Uncertain Name', items: [{ description: 'Consultation', amount: '999' }] })]);
  await assert.rejects(decide(db.tables.qualityReview[0].id), /approved price/);
  assert.equal(db.tables.qualityReview[0].state, 'open'); assert.equal(db.tables.sourceImport[0].state, 'held'); assert.equal(db.tables.invoice.length, 0);
});

test('billing source details exclude clinical content and manager prices do not grant patient access', async () => {
  await savePrice(); approvedLab(); db.tables.visit[0].notes = 'PRIVATE CONSULTATION';
  const billing = await visibleData(cashier);
  assert.equal(billing.billingServices[0].charges.length, 2); assert.equal(billing.labs.length, 0);
  assert.ok(!JSON.stringify(billing).includes('PRIVATE LAB VALUE')); assert.ok(!JSON.stringify(billing).includes('PRIVATE CONSULTATION'));
  const administration = await visibleData(manager);
  assert.equal(administration.priceList.entries.length, 2); assert.equal(administration.patients.length, 0); assert.equal(administration.invoices.length, 0); assert.equal(administration.labs.length, 0);
});

test('printed saved bills and payment receipts use historical amounts after a price edit', async () => {
  await prepareBill(); await changeConsultationPrice('500');
  const record = db.tables.invoice[0];
  const html = renderDocument('bill', record, db.tables.patient[0], [], { name: 'Clinic' });
  assert.ok(html.includes('10.01')); assert.ok(!html.includes('500.00'));
  const receipt = renderDocument('receipt', record, db.tables.patient[0], [], { name: 'Clinic' }, { id: 'PAY-1', amount: 400, at: '2026-01-02T04:00:00Z', by: 'Cashier', method: 'Cash' });
  assert.ok(receipt.includes('4.00')); assert.ok(receipt.includes('PAY-1'));
});

test('repository standalone reads recover from a single connection drop', async () => {
  let attempts = 0;
  db.failure = (name, action) => { if (name === 'appSetting' && action === 'findMany' && ++attempts === 1) throw Object.assign(new Error('Closed connection'), { code: 'P1017' }); return false; };
  const rows = await repository.find('appSettings');
  assert.equal(attempts, 2); assert.equal(JSON.parse(rows[0].value).entries[0].amount, 1001);
});

test('transaction reads and writes are never replayed after a connection drop', async () => {
  let attempts = 0;
  db.failure = (name, action) => { if (name === 'appSetting' && action === 'findMany') { attempts++; throw { code: 'P1017' }; } return false; };
  await assert.rejects(repository.transaction(store => store.find('appSettings'), { lock: 20261105 }), error => error.code === 'P1017');
  assert.equal(attempts, 1);
  attempts = 0;
  db.failure = (name, action) => { if (name === 'activityHistory' && action === 'createMany') { attempts++; throw { code: 'P1017' }; } return false; };
  await assert.rejects(async () => { await repository.insert('activityHistory', { id: 'AUD-UNCONFIRMED' }); }, error => error.code === 'P1017');
  assert.equal(attempts, 1); assert.equal(db.tables.activityHistory.length, 0);
});

async function managerRequest(method) {
  const token = 'a'.repeat(64);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
  db.tables.staffAccount.push(manager);
  db.tables.staffSession.push({ tokenHash: hash, userId: manager.id, expiresAt: new Date(Date.now() + 600000).toISOString(), lastSeen: new Date().toISOString() });
  return new Request('http://localhost/api/service-prices', { method, headers: { cookie: `carerecord_session=${token}`, origin: 'http://localhost', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ version: 1, kind: 'laboratory', name: 'Glucose', amount: '250', active: true }) } : {}) });
}
test('persistent read outages return a safe retryable response instead of generic 500', async () => {
  db.failure = (name, action) => { if (name === 'appSetting' && action === 'findMany') throw { code: 'P1017' }; return false; };
  const response = await routeRequest(await managerRequest('GET'));
  assert.equal(response.status, 503); assert.equal(response.headers.get('Retry-After'), '1');
  const payload = await response.json(); assert.equal(payload.code, 'DATABASE_UNAVAILABLE'); assert.match(payload.error, /refreshing the records/);
});

test('a persistent uncoded connection-pool timeout returns 503 instead of 500', async () => {
  let attempts = 0;
  db.failure = (name, action) => { if (name === 'appSetting' && action === 'findMany') { attempts++; throw new Error('timeout exceeded when trying to connect'); } return false; };
  const response = await routeRequest(await managerRequest('GET'));
  assert.equal(response.status, 503); assert.equal(attempts, 2);
  assert.equal((await response.json()).code, 'DATABASE_UNAVAILABLE');
});
test('an interrupted save tells staff to verify records and does not repeat the transaction', async () => {
  let attempts = 0; const original = structuredClone(db.tables.appSetting);
  db.failure = (name, action) => { if (name === 'appSetting' && action === 'findMany') { attempts++; throw { code: 'P1017' }; } return false; };
  const response = await routeRequest(await managerRequest('POST'));
  assert.equal(response.status, 503); assert.match((await response.json()).error, /check whether your change was saved/);
  assert.equal(attempts, 1); assert.deepEqual(db.tables.appSetting, original);
});

const reviewer = { id: 'U-REVIEW', name: 'Reviewer', role: 'reviewer', active: true };
const historyContext = (params = '', user = reviewer) => ({ user, url: new URL(`http://localhost/api/history?${params}`) });
function historyEntry(id, extra = {}) { return { id, at: '2026-11-07T02:00:00.000Z', userId: 'U-REVIEW', actor: 'Reviewer', role: 'reviewer', action: 'Viewed patient record', entityType: 'patient', entityId: id, patientId: 'P-1', detail: 'Checked record', ...extra }; }

test('history pagination reaches entries beyond the previous 250-row cap and clamps pages', async () => {
  db.tables.activityHistory = Array.from({ length: 275 }, (_, i) => historyEntry(`AUD-${String(i).padStart(4, '0')}`));
  const first = (await historyService(historyContext('pageSize=50'))).body;
  const last = (await historyService(historyContext('pageSize=50&page=999'))).body;
  assert.equal(first.total, 275); assert.equal(first.entries.length, 50); assert.equal(first.entries[0].id, 'AUD-0274');
  assert.equal(last.page, 6); assert.equal(last.entries.length, 25); assert.equal(last.entries.at(-1).id, 'AUD-0000');
});

test('history manager scope is applied before filtering, options and pagination', async () => {
  db.tables.activityHistory = [historyEntry('PATIENT'), historyEntry('PRICE', { entityType: 'staff', role: 'manager', actor: 'Casey', action: 'Set service price' }), historyEntry('LOGIN', { entityType: 'session', role: 'doctor', action: 'Signed in' })];
  const page = (await historyService(historyContext('', manager))).body;
  assert.equal(page.total, 2); assert.ok(!JSON.stringify(page).includes('PATIENT')); assert.ok(!page.actions.includes('Viewed patient record'));
  const filtered = (await historyService(historyContext('role=manager&action=Set+service+price&q=casey', manager))).body;
  assert.equal(filtered.total, 1); assert.equal(filtered.entries[0].id, 'PRICE');
});

test('reviewer history hides clinical details from entries and search results', async () => {
  db.tables.activityHistory = [historyEntry('LAB', { entityType: 'lab', detail: 'CONFIDENTIAL_RESULT_73' })];
  const page = (await historyService(historyContext())).body;
  assert.equal(page.total, 1); assert.ok(!JSON.stringify(page).includes('CONFIDENTIAL_RESULT_73'));
  assert.equal((await historyService(historyContext('q=CONFIDENTIAL_RESULT_73'))).body.total, 0);
});

test('history dates use inclusive clinic days and combine with role and action filters', async () => {
  db.tables.activityHistory = ['2026-11-06T15:59:59.000Z', '2026-11-06T16:00:00.000Z', '2026-11-07T15:59:59.999Z', '2026-11-07T16:00:00.000Z'].map((at, i) => historyEntry(`AUD-${i}`, { at }));
  assert.equal((await historyService(historyContext('from=2026-11-07&to=2026-11-07&role=reviewer&action=Viewed+patient+record'))).body.total, 2);
});

test('history rejects other roles and invalid filters without changing records', async () => {
  await assert.rejects(historyService(historyContext('', { ...reviewer, role: 'doctor' })), error => error.status === 403);
  for (const params of ['page=0', 'pageSize=999', 'page=1.5', 'role=owner', 'from=2026-02-30', 'from=2026-11-08&to=2026-11-07']) await assert.rejects(historyService(historyContext(params)), error => error.status === 422);
  assert.equal(db.tables.activityHistory.length, 0);
});

function api(path, body, cookie) {
  const headers = { origin: 'http://localhost', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  return routeRequest(new Request(`http://localhost/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
async function staffCookie(user) {
  db.tables.staffAccount.push(user);
  const token = crypto.randomUUID().replaceAll('-', '').repeat(2);
  const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
  db.tables.staffSession.push({ tokenHash, userId: user.id, lastSeen: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() });
  return `carerecord_session=${token}`;
}

test('portal activation is single use and staff can replace access without exposing credentials', async () => {
  const staff = await staffCookie({ id: 'U-FRONT', name: 'Front desk', role: 'registration', active: true });
  assert.equal((await api('patient-access/P-1', { action: 'issue' }, staff)).status, 422);
  const issued = await api('patient-access/P-1', { action: 'issue', verified: true }, staff);
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  assert.match(code, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(db.tables).includes(code));
  const status = await (await api('patient-access/P-1', undefined, staff)).json();
  assert.equal(status.status, 'pending'); assert.equal(status.code, undefined);
  const credentials = { patientId: 'P-1', password: 'FictionalPass123!', code };
  const activated = await api('patient-portal/activate', credentials);
  assert.equal(activated.status, 200);
  const cookie = activated.headers.getSetCookie()[0];
  assert.match(cookie, /carerecord_patient=[a-f0-9]{64}; Path=\/api\/patient-portal; HttpOnly; SameSite=Strict/);
  const token = cookie.split(';')[0];
  assert.equal((await api('patient-portal/activate', credentials)).status, 422);
  assert.equal((await api('patient-portal', undefined, token)).status, 200);
  assert.equal((await api('data?refresh=1', undefined, token)).status, 401);
  assert.equal((await api('patient-portal', undefined, staff)).status, 401);
  const replaced = await api('patient-access/P-1', { action: 'issue', verified: true, reason: 'Verified password reset in person.' }, staff);
  assert.equal(replaced.status, 200);
  assert.equal((await api('patient-portal', undefined, token)).status, 401);
  assert.equal((await api('patient-portal/login', credentials)).status, 401);
  assert.equal((await api('patient-access/P-1', undefined, await staffCookie(manager))).status, 403);
});

test('portal shows only the session patient and current released result, even with another patient requested', async () => {
  const frontdesk = await staffCookie({ id: 'U-FRONT', name: 'Front desk', role: 'registration', active: true });
  const doctor = await staffCookie({ id: 'D-1', name: 'Assigned doctor', role: 'doctor', active: true });
  const otherDoctor = await staffCookie({ id: 'D-2', name: 'Other doctor', role: 'doctor', active: true });
  const approvedAt = '2026-01-02T03:00:00.000Z';
  db.tables.patient.push({ id: 'P-OTHER', name: 'OTHER_PRIVATE_PATIENT', dob: '2000-01-01', doctorId: 'D-2' });
  db.tables.visit[0].notes = 'PRIVATE_CLINIC_NOTES';
  db.tables.visit.push({ ...db.tables.visit[0], id: 'V-OTHER', patientId: 'P-OTHER', doctorId: 'D-2' });
  db.tables.labReport.push({ id: 'L-1', patientId: 'P-1', visitId: 'V-1', version: 1, status: 'approved', approvedAt, collectedAt: '2026-01-02T02:00:00.000Z', testName: 'Blood glucose', value: '92', unit: 'mg/dL', measurements: [], history: [], doctorReview: {} });
  db.tables.invoice.push({ id: 'B-1', patientId: 'P-1', visitId: 'V-1', date: '2026-01-02', total: 75000, paid: 50000, items: [{ description: 'Consultation', amount: 50000, addedBy: 'PRIVATE_INTERNAL_FIELD' }], payments: [{ amount: 50000, method: 'Cash', at: approvedAt, reference: 'PRIVATE_RECEIPT_REF' }] });
  db.tables.invoice.push({ ...db.tables.invoice[0], id: 'B-OTHER', patientId: 'P-OTHER', visitId: 'V-OTHER' });
  const { code } = await (await api('patient-access/P-1', { action: 'issue', verified: true }, frontdesk)).json();
  const activated = await api('patient-portal/activate', { patientId: 'P-1', code, password: 'FictionalPass123!' });
  const cookie = activated.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await api('labs/L-1/patient-release', { confirmed: true, version: 1 }, doctor)).status, 422);
  assert.equal((await api('labs/L-1/doctor-review', { confirmed: true, version: 1, plan: 'PRIVATE_FOLLOWUP' }, doctor)).status, 200);
  assert.equal((await api('labs/L-1/patient-release', { confirmed: true, version: 2 }, otherDoctor)).status, 403);
  assert.equal((await (await api('patient-portal', undefined, cookie)).json()).labs.length, 0);
  assert.equal((await api('labs/L-1/patient-release', { confirmed: true, version: 2 }, doctor)).status, 200);
  const data = await (await api('patient-portal?patientId=P-OTHER', undefined, cookie)).json();
  assert.equal(data.patient.id, 'P-1'); assert.deepEqual(data.visits.map(row => row.id), ['V-1']);
  assert.equal(data.labs[0].measurements[0].result, '92'); assert.equal(data.bills[0].paid, 50000);
  assert.ok(!/PRIVATE_|P-OTHER|B-OTHER/.test(JSON.stringify(data)));
  db.tables.labReport[0].approvedAt = '2026-01-02T04:00:00.000Z';
  assert.equal((await (await api('patient-portal', undefined, cookie)).json()).labs.length, 0);
  assert.equal((await api('patient-portal/logout', {}, cookie)).status, 200);
  assert.equal((await api('patient-portal', undefined, cookie)).status, 401);
});
