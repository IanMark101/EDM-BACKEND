import { disconnectDatabase } from '../backend/src/config/prisma';
import { repository } from '../backend/src/repositories/clinic.repository';
import { clearPresentationData, seedPresentationData } from '../backend/src/services/presentation-seed.service';
import type { Staff } from '../shared/domain';

async function main() {
  const clear = process.argv.includes('--clear');
  const staff = await repository.find('staffAccounts');
  const manager = (staff as Staff[]).find(account => account.active && account.role === 'manager');
  if (!manager) {
    console.error('No active manager account found in database.');
    process.exitCode = 1;
    return;
  }
  const summary = clear ? await clearPresentationData(manager) : await seedPresentationData(manager);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
