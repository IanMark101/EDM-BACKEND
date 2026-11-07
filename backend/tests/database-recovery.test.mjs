import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/database-recovery.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { isTemporaryDatabaseError, retryDatabaseRead } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('recognizes Prisma, adapter and socket disconnections through known wrappers', () => {
  for (const error of [{ code: 'P1017' }, { code: 'ECONNRESET' }, { cause: { code: '57P01' } }, { meta: { driverAdapterError: { cause: { kind: 'ConnectionClosed' } } } }, new Error('Connection terminated unexpectedly')]) assert.equal(isTemporaryDatabaseError(error), true);
});
test('validation, credentials and unknown errors are not disguised as outages', () => {
  for (const error of [{ code: 'P2002' }, { code: 'P1000' }, { code: 'P2028' }, { code: 'P2002', message: 'Duplicate value: Server has closed the connection.' }, { status: 422, message: 'Set a price for Server has closed the connection.' }, new Error('Invalid service price'), null]) assert.equal(isTemporaryDatabaseError(error), false);
  const cyclic = { code: 'P2002' }; cyclic.cause = cyclic;
  assert.equal(isTemporaryDatabaseError(cyclic), false);
});

test('recognizes uncoded pg-pool timeouts and PostgreSQL adapter codes', () => {
  for (const error of [new Error('timeout exceeded when trying to connect'), new Error('Connection terminated due to connection timeout'), { cause: new Error('timeout exceeded when trying to connect') }, { meta: { driverAdapterError: { cause: { originalCode: '57P03', kind: 'postgres' } } } }]) assert.equal(isTemporaryDatabaseError(error), true);
  assert.equal(isTemporaryDatabaseError({ status: 422, message: 'timeout exceeded when trying to connect' }), false);
  assert.equal(isTemporaryDatabaseError({ code: 'P2002', message: 'timeout exceeded when trying to connect' }), false);
});

test('a connection-pool wait timeout retries a read once', async () => {
  let attempts = 0;
  const rows = await retryDatabaseRead(async () => { if (++attempts === 1) throw new Error('timeout exceeded when trying to connect'); return ['ready']; });
  assert.equal(attempts, 2); assert.deepEqual(rows, ['ready']);
});
test('a dropped standalone read recovers once with a fresh pool acquisition', async () => {
  let attempts = 0;
  const result = await retryDatabaseRead(async () => { if (++attempts === 1) throw { code: 'P1017' }; return [{ name: 'Consultation', amount: 50000 }]; });
  assert.equal(attempts, 2); assert.equal(result[0].amount, 50000);
});
test('an ongoing outage has a bounded retry and preserves the final error', async () => {
  let attempts = 0; const failure = Object.assign(new Error('Server has closed the connection.'), { code: 'P1017' });
  await assert.rejects(retryDatabaseRead(async () => { attempts++; throw failure; }), error => error === failure);
  assert.equal(attempts, 2);
});
test('a permanent failure is returned immediately without retry', async () => {
  let attempts = 0;
  await assert.rejects(retryDatabaseRead(async () => { attempts++; throw { code: 'P2002' }; }), error => error.code === 'P2002');
  assert.equal(attempts, 1);
});
