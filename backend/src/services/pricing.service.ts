import { AppError, assertRole, cleanText, moneyCents } from '../../../shared/domain';
import { labTestCatalog, labTestKey, serviceNameKey, type ServicePrice, type ServicePriceList } from '../../../shared/billing';
import { repository, match } from '../repositories/clinic.repository';
import { PRICE_LIST_KEY, readPriceList } from '../repositories/pricing.repository';
import { auditRow, newId, now } from './server';
import { result } from '../http/result';
import type { ServiceContext } from '../http/context';

export async function servicePricesService({ request, user, input }: ServiceContext) {
  assertRole(user, request.method === 'GET' ? ['manager', 'billing'] : ['manager']);
  if (request.method === 'GET') return result(await readPriceList());
  return repository.transaction(async store => {
    const previous = await readPriceList(store);
    if (input.version !== previous.version) throw new AppError('Service settings changed. Reload the list before saving.', 409);
    async function save(next: ServicePriceList, action: string, id: string, detail: string) {
      const value = JSON.stringify(next);
      const change = previous.version ? store.update('appSettings', { value }, match('key', PRICE_LIST_KEY)) : store.insert('appSettings', { key: PRICE_LIST_KEY, value });
      await store.batch([change, store.insert('activityHistory', auditRow(user, action, 'staff', id, detail))]);
      return result(next);
    }
    if (input.action === 'lab-availability') {
      const key = labTestKey(cleanText(input.name, 'Test name', 120));
      const test = labTestCatalog(previous).find(test => labTestKey(test.name) === key);
      if (!test) throw new AppError('Choose a test from the clinic list.', 422);
      if (typeof input.available !== 'boolean') throw new AppError('Choose whether doctors can request this test.', 422);
      if (test.available === input.available) return result(previous);
      return save({
        ...previous, version: previous.version + 1,
        labTestAvailability: { ...previous.labTestAvailability, [key]: input.available },
      }, input.available ? 'Enabled laboratory test ordering' : 'Disabled laboratory test ordering', test.name,
      `${test.name}: ${input.available ? 'available for new requests' : 'hidden from new requests'}. Existing requests and prices were kept.`);
    }
    if (!['consultation', 'laboratory'].includes(input.kind)) throw new AppError('Choose consultation or laboratory.', 422);
    const kind = input.kind as ServicePrice['kind'];
    const name = kind === 'consultation' ? 'Consultation' : cleanText(input.name, 'Service name', 120);
    const amount = moneyCents(input.amount, 'Service price');
    if (typeof input.active !== 'boolean') throw new AppError('Choose whether the price is available to billing.', 422);
    const old = input.id ? previous.entries.find(entry => entry.id === input.id) : undefined;
    if (input.id && !old) throw new AppError('This service price no longer exists. Reload the list.', 404);
    if (old && old.kind !== kind) throw new AppError('Service type cannot be changed on an existing price entry.', 422);
    if (previous.entries.some(entry => entry.id !== old?.id && entry.kind === kind && serviceNameKey(entry.name) === serviceNameKey(name))) throw new AppError('This service already has a price. Edit its existing entry.', 409);
    if (!old && previous.entries.length >= 200) throw new AppError('The price list has reached its service limit.', 422);
    const reason = old ? cleanText(input.reason, 'Reason for changing the price', 1000) : '';
    if (old && reason.length < 12) throw new AppError('Explain the price change in at least 12 characters.', 422);
    const entry: ServicePrice = { id: old?.id || newId('PRICE'), kind, name, amount, active: input.active, updatedAt: now(), updatedBy: user.name, updatedById: user.id };
    const next: ServicePriceList = { ...previous, version: previous.version + 1, entries: old ? previous.entries.map(item => item.id === old.id ? entry : item) : [...previous.entries, entry] };
    if (kind === 'laboratory') {
      const key = labTestKey(name);
      const test = labTestCatalog(previous).find(test => labTestKey(test.name) === key);
      // Preserve existing ordering decisions when the manager edits a fee.
      if (test) next.labTestAvailability = { ...previous.labTestAvailability, [key]: test.available };
    }
    return save(next, old ? 'Changed service price' : 'Set service price', entry.id,
      `${name}: PHP ${(amount / 100).toFixed(2)}; ${entry.active ? 'available' : 'disabled'}. ${old ? `Previous: ${old.name}, PHP ${(old.amount / 100).toFixed(2)}, ${old.active ? 'available' : 'disabled'}. Reason: ${reason}` : 'Clinic-approved service price entered by the account manager.'}`);
  }, { lock: 20261105 });
}
