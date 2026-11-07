import { repository, match, type ClinicRepository } from './clinic.repository';
import type { ServicePriceList } from '../../../shared/billing';

export const PRICE_LIST_KEY = 'service-prices-v1';
// Existing installations start with no assumed fees. Saved invoices retain their
// existing amounts; only future charges need a manager-approved active price.
export async function readPriceList(store: ClinicRepository = repository): Promise<ServicePriceList> {
  const setting = (await store.find('appSettings', match('key', PRICE_LIST_KEY)))[0];
  return setting ? JSON.parse(setting.value) : { version: 0, entries: [] };
}
