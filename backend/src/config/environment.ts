import { config } from 'dotenv';
import path from 'node:path';
import { readFileSync } from 'node:fs';
function projectRoot() {
  let current = path.resolve(process.env.CARE_RECORD_ROOT || process.cwd());
  for (;;) {
    try { if (JSON.parse(readFileSync(path.join(current, 'package.json'), 'utf8')).name === 'care-record') return current; } catch {}
    const parent = path.dirname(current); if (parent === current) throw new Error('Start the service from the CareRecord project.'); current = parent;
  }
}
export const root = projectRoot();
config({ path: path.join(root, 'backend/.env'), quiet: true });
export const environment = {
  port: Number(process.env.PORT || 3001),
  databaseUrl: process.env.DATABASE_URL || '',
  directUrl: process.env.DIRECT_URL || '',
  origins: (process.env.CLINIC_FRONTEND_ORIGINS || process.env.FRONTEND_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s => s.trim()).filter(Boolean),
  seedTestData: process.env.CLINIC_SEED_TEST_DATA === '1',
};
