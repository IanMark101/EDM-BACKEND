import { AppError, assertRole, cleanText, dateOnly, moneyCents, validatePayment, type Staff } from '../../../shared/domain';
import { chargeOffers, serviceNameKey, type ChargeOffer, type LinkedCharge, type ServicePriceList } from '../../../shared/billing';
import { repository, match, allOf, type ClinicRepository } from '../repositories/clinic.repository';
import { readPriceList } from '../repositories/pricing.repository';
import { updateWithHistory, auditRow, newId, now } from './server';
import { notificationRows, notificationInsert } from './notifications';
import { result } from '../http/result';
import type { ServiceContext } from '../http/context';

function linkedCharge(offer: ChargeOffer, prices: ServicePriceList, user: Staff): LinkedCharge {
  if (offer.alreadyBilled) throw new AppError(`This visit already includes the charge for ${offer.source.name}.`, 409);
  const price = offer.price;
  if (!price) throw new AppError(`The account manager must set an active price for "${offer.source.name}" before billing.`, 422);
  return { description: offer.source.name, amount: price.amount, source: offer.source,
    price: { id: price.id, version: prices.version, name: price.name, amount: price.amount, setAt: price.updatedAt, setBy: price.updatedBy }, addedAt: now(), addedBy: user.name };
}
async function offersFor(visit: any, store: ClinicRepository, invoice?: any) {
  const [prices, labs, staff] = await Promise.all([readPriceList(store), store.find('labReports', match('visitId', visit.id)), store.find('staffAccounts')]);
  return { prices, offers: chargeOffers(visit, labs, staff, prices, invoice) };
}

// Department files retain their existing format. Their descriptions and amounts
// must agree with completed services and manager-approved prices, preventing an
// import or a held-identity decision from bypassing billing's price controls.
export async function pricedImportItems(visit: any, supplied: any[], user: Staff, store: ClinicRepository): Promise<LinkedCharge[]> {
  const { prices, offers } = await offersFor(visit, store);
  const used = new Set<string>();
  return supplied.map(item => {
    const offer = offers.find(offer => !used.has(offer.source.key) && serviceNameKey(offer.source.name) === serviceNameKey(item.description));
    if (!offer) throw new AppError(`"${item.description}" does not match an unbilled completed service on this visit.`, 422);
    const charge = linkedCharge(offer, prices, user);
    if (moneyCents(item.amount, 'Imported service price') !== charge.amount) throw new AppError(`The imported price for "${item.description}" does not match the account manager's approved price.`, 422);
    used.add(offer.source.key); return charge;
  });
}

export async function managedInvoicesService({ user, id, action, input }: ServiceContext) {
  assertRole(user, ['billing']);
  if (!id || action === 'add-charges') {
    return repository.transaction(async store => {
      const old = id ? (await store.find('invoices', match('id', id)))[0] : undefined;
      if (id && !old) throw new AppError('This bill could not be found.', 404);
      if (old && input.version !== old.version) throw new AppError('This bill changed while you were editing. Refresh before saving.', 409);
      const patientId = old?.patientId || cleanText(input.patientId, 'Patient number', 80);
      const visitId = old?.visitId || cleanText(input.visitId, 'Visit number', 80);
      const patient = (await store.find('patients', match('id', patientId)))[0];
      const visit = (await store.find('visits', match('id', visitId)))[0];
      if (!patient || !visit || visit.patientId !== patient.id) throw new AppError('Choose the correct patient and visit for this bill.', 422);
      if (visit.status !== 'signed') throw new AppError('The doctor must complete the consultation before a bill is prepared.', 422);
      if (!old && (await store.find('invoices', match('visitId', visit.id))).length) throw new AppError('This visit already has a bill. Open it to add services or receive payment.', 409);
      const { prices, offers } = await offersFor(visit, store, old);
      if (input.priceListVersion !== prices.version) throw new AppError('Service prices changed. Close this window, refresh the work list and review the prices before saving.', 409);
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 12) throw new AppError('Choose between 1 and 12 completed services.', 422);
      const used = new Set<string>();
      const added = input.items.map((item: any) => {
        const offer = offers.find(offer => offer.source.key === item?.sourceKey);
        if (!offer) throw new AppError('Choose a completed consultation or approved laboratory service from this visit.', 422);
        if (used.has(offer.source.key)) throw new AppError('The same service cannot be charged twice.', 422);
        used.add(offer.source.key); return linkedCharge(offer, prices, user);
      });
      if (!old && !used.has(`visit:${visit.id}`)) throw new AppError('Include the completed consultation when creating this visit’s bill.', 422);
      const items = [...(old?.items as any[] || []), ...added];
      if (items.length > 24) throw new AppError('This bill has reached its service limit. Contact the records reviewer.', 422);
      const total = items.reduce((sum, item) => sum + item.amount, 0);
      const invoiceId = old?.id || newId('B');
      if (old) {
        const reason = cleanText(input.reason, 'Reason for adding services', 1000);
        if (reason.length < 12) throw new AppError('Explain the additional services in at least 12 characters.', 422);
        const saved = await store.update('invoices', { items, total, version: old.version + 1, updatedAt: now() }, allOf(match('id', old.id), match('version', old.version)));
        if (!saved.meta.changes) throw new AppError('Another staff member updated this bill. Refresh before saving.', 409);
        await store.insert('activityHistory', auditRow(user, 'Added bill charges', 'invoice', old.id, `Manager-priced completed services added. Reason: ${reason}`, patient.id));
      } else {
        const notices = await notificationRows(user, { key: `bill:${invoiceId}`, roles: ['billing'], kind: 'created', body: 'prepared a bill for', subject: patient.name, patientId: patient.id, entityId: invoiceId, href: `/clinic/billing?open=${invoiceId}` }, store);
        await store.batch([
          store.insert('invoices', { id: invoiceId, patientId: patient.id, visitId: visit.id, date: dateOnly(input.date, 'Bill date'), items, total, paid: 0, payments: [], sourceRef: newId('BILL'), version: 1, updatedAt: now() }),
          store.insert('activityHistory', auditRow(user, 'Created bill', 'invoice', invoiceId, 'Completed services priced from the account manager’s approved list. Service and price references retained on each charge.', patient.id)), ...notificationInsert(notices),
        ]);
      }
      return result({ id: invoiceId }, old ? 200 : 201);
    }, { lock: 20261105 });
  }
  // Payments keep the existing amounts, receipt history and optimistic version
  // check. A price-list change never recalculates a bill already saved.
  if (action !== 'payment') throw new AppError('Choose a payment action.', 404);
  const old = (await repository.find('invoices', match('id', id)))[0];
  if (!old) throw new AppError('This bill could not be found.', 404);
  const amount = validatePayment(input.amount, old.total, old.paid);
  const method = cleanText(input.method, 'Payment method', 40);
  if (!['Cash', 'Card', 'Bank transfer'].includes(method)) throw new AppError('Choose a listed payment method.', 422);
  const reference = cleanText(input.reference, 'Payment reference', 120, method !== 'Cash');
  const payments = [...old.payments as any[], { id: newId('PAY'), amount, method, reference, by: user.name, at: now() }];
  const patient = (await repository.find('patients', match('id', old.patientId)))[0];
  if (!patient) throw new AppError('This patient could not be found.', 404);
  const notices = await notificationRows(user, { key: `payment:${payments[payments.length - 1].id}`, roles: ['billing'], kind: 'created', body: 'recorded a payment for', subject: patient.name, patientId: patient.id, entityId: id, href: `/clinic/billing?open=${id}` });
  await updateWithHistory('invoices', old, input.version, { paid: old.paid + amount, payments }, auditRow(user, 'Recorded payment', 'invoice', id, `${(amount / 100).toFixed(2)} PHP received by ${method}.`, old.patientId), notices);
  return result({ id });
}
