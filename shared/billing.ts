import { labProblems } from './domain';

export type ServiceKind = 'consultation' | 'laboratory';
export type ServicePrice = {
  id: string; kind: ServiceKind; name: string; amount: number; active: boolean;
  updatedAt: string; updatedBy: string; updatedById: string;
};
export type ServicePriceList = { version: number; entries: ServicePrice[]; labTestAvailability?: Record<string, boolean> };
export type ChargeSource = {
  key: string; kind: ServiceKind; recordId: string; originalRef: string;
  name: string; completedAt: string; completedBy: string;
};
export type ChargeOffer = { source: ChargeSource; price: ServicePrice | null; alreadyBilled: boolean };
export type LinkedCharge = {
  description: string; amount: number; source: ChargeSource;
  price: { id: string; version: number; name: string; amount: number; setAt: string; setBy: string };
  addedAt: string; addedBy: string;
};
export const serviceNameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

const starterLabTests = [
  'Blood glucose', 'Blood urea nitrogen', 'Complete blood count', 'Creatinine',
  'Hemoglobin A1c', 'Lipid panel', 'Urinalysis',
];
const glucoseAliases = ['blood glucose', 'blood glucose test'];

export function labTestKey(name: string) {
  const key = serviceNameKey(name);
  return glucoseAliases.includes(key) ? glucoseAliases[0] : key;
}

export function labTestCatalog(prices: ServicePriceList) {
  const tests = new Map(starterLabTests.map(name => [labTestKey(name), { name, price: null as ServicePrice | null }]));
  for (const price of prices.entries) {
    if (price.kind !== 'laboratory') continue;
    const key = labTestKey(price.name);
    const current = tests.get(key);
    if (!current?.price || serviceNameKey(price.name) === key) tests.set(key, { name: price.name, price });
  }
  return Array.from(tests, ([key, test]) => ({
    ...test,
    available: (Object.hasOwn(prices.labTestAvailability ?? {}, key) ? prices.labTestAvailability![key] : undefined)
      ?? test.price?.active ?? true,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function priceForService(source: ChargeSource, prices: ServicePriceList) {
  const name = serviceNameKey(source.name);
  const entries = prices.entries.filter(price => price.kind === source.kind);
  const exact = entries.find(price => serviceNameKey(price.name) === name);
  if (exact) return exact.active ? exact : null;

  // Older lab requests used both spellings. Keep explicit price entries authoritative.
  if (source.kind !== 'laboratory') return null;
  if (!glucoseAliases.includes(name)) return null;
  const alternate = glucoseAliases.find(alias => alias !== name);
  return entries.find(price => price.active && serviceNameKey(price.name) === alternate) || null;
}

// Only service identity and completion details cross into billing, never result
// values, consultation notes, or a doctor's follow-up decision.
export function chargeOffers(visit: any, labs: any[], staff: any[], prices: ServicePriceList, invoice?: any): ChargeOffer[] {
  if (visit.status !== 'signed') return [];
  const staffName = (id: string) => staff.find(person => person.id === id)?.name || 'Responsible staff';
  const sources: ChargeSource[] = [{
    key: `visit:${visit.id}`, kind: 'consultation', recordId: visit.id, originalRef: visit.id,
    name: 'Consultation', completedAt: visit.signedAt || '', completedBy: staffName(visit.doctorId),
  }, ...labs.filter(report => report.visitId === visit.id && report.patientId === visit.patientId && report.status === 'approved' && !labProblems(report, visit).length).map(report => ({
    key: `lab:${report.id}`, kind: 'laboratory' as const, recordId: report.id, originalRef: report.sourceRef || report.id,
    name: report.testName, completedAt: report.approvedAt || '', completedBy: staffName(report.approvedBy),
  }))];
  const items: any[] = Array.isArray(invoice?.items) ? invoice.items : [];
  const billed = new Set<string>(items.flatMap(item => item.source?.key ? [item.source.key] : []));
  // Older bills have no source IDs. Recognize an exact service description once
  // without claiming that it is a historically verified link.
  for (const item of items.filter(item => !item.source?.key)) {
    const source = sources.find(source => !billed.has(source.key) && serviceNameKey(source.name) === serviceNameKey(item.description || ''));
    if (source) billed.add(source.key);
  }
  return sources.map(source => ({
    source, alreadyBilled: billed.has(source.key),
    price: priceForService(source, prices),
  }));
}
