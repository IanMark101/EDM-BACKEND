import { environment } from '../backend/src/config/environment';
import { getPrisma, disconnectDatabase } from '../backend/src/config/prisma';
try {
  const app = new URL(environment.databaseUrl); const direct = new URL(environment.directUrl);
  const valid = app.hostname.endsWith('.neon.tech') && direct.hostname.endsWith('.neon.tech') && app.hostname.replace('-pooler', '') === direct.hostname && app.pathname === direct.pathname;
  if (!valid) throw new Error('The pooled and direct URLs must select the same Neon database.');
  await getPrisma().$queryRaw`SELECT 1`;
  console.log(JSON.stringify({ connected: true, provider: 'Neon PostgreSQL', pooledApplicationConnection: app.hostname.includes('-pooler'), directMigrationConnection: !direct.hostname.includes('-pooler') }));
} catch { console.error('Neon connection validation failed. Check backend/.env and network access. Connection values were not logged.'); process.exitCode = 1; }
finally { await disconnectDatabase(); }
