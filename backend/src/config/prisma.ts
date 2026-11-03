import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { environment } from './environment';
import { AppError } from '../../../shared/domain';
let client: PrismaClient | undefined;
export function createDatabaseClient(url: string) {
  const connection = new URL(url);
  if (['require', 'prefer', 'verify-ca'].includes(connection.searchParams.get('sslmode') || '')) connection.searchParams.set('sslmode', 'verify-full');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: connection.toString(), connectionTimeoutMillis: 30_000, max: 10 }, { schema: connection.searchParams.get('schema') || 'public' }), transactionOptions: { maxWait: 30_000, timeout: 60_000 }, log: [] });
}
export function getPrisma() {
  if (!environment.databaseUrl) throw new AppError('Configure the Neon database connection in backend/.env before signing in.', 503);
  return client ||= createDatabaseClient(environment.databaseUrl);
}
export async function disconnectDatabase() { if (client) await client.$disconnect(); }
