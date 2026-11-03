export type ReportFact = { id: string; kind: string; date: string; patientKey: string; sourceId: string; source: string; service: string; total: number; paid: number; refreshedAt: string };
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
