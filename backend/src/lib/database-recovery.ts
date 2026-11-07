import { setTimeout as pause } from 'node:timers/promises';

const connectionCodes = new Set([
  'P1001', 'P1002', 'P1017', 'P2024',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  '08000', '08001', '08003', '08004', '08006', '08007', '57P01', '57P02', '57P03',
]);
const connectionKinds = new Set(['ConnectionClosed', 'DatabaseNotReachable', 'SocketTimeout', 'ConnectionTimeout', 'PoolTimeout']);

// Prisma can wrap a pg/socket error under its driver-adapter metadata. Inspect
// those known wrappers without treating validation/authentication errors as outages.
export function isTemporaryDatabaseError(error: unknown): boolean {
  const pending: unknown[] = [error]; const visited = new Set<unknown>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const item = value as Record<string, any>;
    if (typeof item.status === 'number' && item.status >= 400 && item.status < 500) continue;
    if (connectionCodes.has(item.code) || connectionCodes.has(item.originalCode) || connectionKinds.has(item.kind)) return true;
    // pg-pool throws plain Errors without a code when waiting for a connection.
    // These must recover just like socket timeouts, including through Prisma.
    if ((!item.code || item.code === 'N/A') && typeof item.message === 'string' && /^(timeout exceeded when trying to connect|connection terminated due to connection timeout)$/i.test(item.message.trim())) return true;
    if ((!item.code || item.code === 'N/A') && typeof item.message === 'string' && /server has closed the connection|connection terminated unexpectedly|connection ended unexpectedly|connection terminated$|client has encountered a connection error and is not queryable/i.test(item.message)) return true;
    pending.push(item.cause, item.meta, item.driverAdapterError, item.originalError);
  }
  return false;
}

// pg removes failed connections from its pool. Retry one standalone read so it
// can acquire a fresh connection. Never disconnect the shared pool underneath
// concurrent work, replay a write, or retry a statement in an aborted transaction.
export async function retryDatabaseRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (!isTemporaryDatabaseError(error)) throw error;
    await pause(200);
    return read();
  }
}
