import { disconnectDatabase } from '../backend/src/config/prisma';
import { initializeEmptyClinic } from '../backend/src/services/clinic-setup';
import { AppError } from '../shared/domain';
let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 10_000) throw new Error('Setup input is too large.'); }
try {
  const input = JSON.parse(raw);
  if (input.database) throw new AppError('Configure the Neon target in backend/.env instead of supplying a SQLite file.');
  await initializeEmptyClinic(input);
  console.log(JSON.stringify({ ok: true, patients: 0, staff: 1, message: 'Empty PostgreSQL clinic initialized with one individual manager.' }));
} catch (error) { console.error(error instanceof AppError ? error.message : 'Clinic initialization failed. Check the private input and confirm the PostgreSQL target is empty.'); process.exitCode = 1; }
finally { await disconnectDatabase(); }
