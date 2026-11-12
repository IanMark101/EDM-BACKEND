import { labTestKey } from './billing';
export type ReportFact = { id: string; kind: string; date: string; patientKey: string; sourceId: string; source: string; service: string; total: number; paid: number; refreshedAt: string };
export function reportTests(facts: ReportFact[]) {
  const groups = new Map<string, { name: string; count: number }>();
  for (const fact of facts.filter(fact => fact.kind === 'lab')) {
    const key = labTestKey(fact.service);
    const entry = groups.get(key);
    if (entry) entry.count++;
    else groups.set(key, { name: key === 'blood glucose' ? 'Blood glucose' : fact.service, count: 1 });
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
export function reportSummary(facts: ReportFact[], from: string, to: string) {
  const selected = facts.filter(f => f.date >= from && f.date <= to);
  const invoices = selected.filter(f => f.kind === 'invoice');
  return {
    selected,
    visits: selected.filter(f => f.kind === 'visit').length,
    labs: selected.filter(f => f.kind === 'lab').length,
    patients: new Set(selected.filter(f => f.kind === 'visit').map(f => f.patientKey)).size,
    charged: invoices.reduce((n, f) => n + f.total, 0),
    received: selected.filter(f => f.kind === 'payment').reduce((n, f) => n + f.paid, 0),
    due: invoices.reduce((n, f) => n + f.total - f.paid, 0),
  };
}
