import { AppError, assertRole, cleanText, moneyCents } from '../../../shared/domain';
import { serviceNameKey, type ServicePrice } from '../../../shared/billing';
import { repository, match } from '../repositories/clinic.repository';
import { PRICE_LIST_KEY, readPriceList } from '../repositories/pricing.repository';
import { auditRow, newId, now } from './server';
import { result } from '../http/result';
import type { ServiceContext } from '../http/context';

export async function servicePricesService({ request, user, input }: ServiceContext) {
  assertRole(user, request.method === 'GET' ? ['manager', 'billing'] : ['manager']);
  if (request.method === 'GET') return result(await readPriceList());
  if (!['consultation', 'laboratory'].includes(input.kind)) throw new AppError('Choose consultation or laboratory.', 422);
  const kind = input.kind as ServicePrice['kind'];
  const name = kind === 'consultation' ? 'Consultation' : cleanText(input.name, 'Service name', 120);
  const amount = moneyCents(input.amount, 'Service price');
  if (typeof input.active !== 'boolean') throw new AppError('Choose whether the price is available to billing.', 422);
  return repository.transaction(async store => {
    const previous = await readPriceList(store);
    if (input.version !== previous.version) throw new AppError('The price list changed. Reload it before saving.', 409);
    const old = input.id ? previous.entries.find(entry => entry.id === input.id) : undefined;
    if (input.id && !old) throw new AppError('This service price no longer exists. Reload the list.', 404);
    if (previous.entries.some(entry => entry.id !== old?.id && entry.kind === kind && serviceNameKey(entry.name) === serviceNameKey(name))) throw new AppError('This service already has a price. Edit its existing entry.', 409);
    if (!old && previous.entries.length >= 200) throw new AppError('The price list has reached its service limit.', 422);
    const reason = old ? cleanText(input.reason, 'Reason for changing the price', 1000) : '';
    if (old && reason.length < 12) throw new AppError('Explain the price change in at least 12 characters.', 422);
    const entry: ServicePrice = { id: old?.id || newId('PRICE'), kind, name, amount, active: input.active, updatedAt: now(), updatedBy: user.name, updatedById: user.id };
    const next = { version: previous.version + 1, entries: old ? previous.entries.map(item => item.id === old.id ? entry : item) : [...previous.entries, entry] };
    const value = JSON.stringify(next);
    const change = previous.version ? store.update('appSettings', { value }, match('key', PRICE_LIST_KEY)) : store.insert('appSettings', { key: PRICE_LIST_KEY, value });
    await store.batch([change, store.insert('activityHistory', auditRow(user, old ? 'Changed service price' : 'Set service price', 'staff', entry.id,
      `${name}: PHP ${(amount / 100).toFixed(2)}; ${entry.active ? 'available' : 'disabled'}. ${old ? `Previous: ${old.name}, PHP ${(old.amount / 100).toFixed(2)}, ${old.active ? 'available' : 'disabled'}. Reason: ${reason}` : 'Clinic-approved service price entered by the account manager.'}`))]);
    return result(next);
  }, { lock: 20261105 });
}
