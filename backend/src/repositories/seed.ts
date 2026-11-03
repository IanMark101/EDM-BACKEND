import { environment } from '../config/environment';
import { repository, match, allOf } from './clinic.repository';
import { hashPassword, randomToken } from '../lib/crypto';

export const DEMO_PASSWORD = 'CareRecord2026!';
export const DEMO_STAFF = [
  { id: 'staff-registration', username: 'frontdesk', name: 'Rochelle Andales', role: 'registration' },
  { id: 'staff-doctor', username: 'dr.buenaflor', name: 'Dr. Ian Mark Buenaflor', role: 'doctor' },
  { id: 'staff-doctor-lim', username: 'dr.lim', name: 'Dr. Miguel Lim', role: 'doctor' },
  { id: 'staff-laboratory', username: 'laboratory', name: 'Kenji Caayohan', role: 'laboratory' },
  { id: 'staff-billing', username: 'billing', name: 'Kent Jeced Alcantara', role: 'billing' },
  { id: 'staff-reviewer', username: 'reviewer', name: 'Rafael Navarro', role: 'reviewer' },
  { id: 'staff-manager', username: 'admin', name: 'Casey Reyes', role: 'manager' },
];
const STAFF_NAMES_KEY = 'staff-names-20261031';
// Rename only the original installed profiles once. Stable staff IDs preserve
// patient assignments, approvals and existing sessions. Historical actors stay intact.
async function updateInstalledStaffNames() {
  if ((await repository.find('appSettings', match('key', STAFF_NAMES_KEY))).length) return;
  const all = await repository.find('staffAccounts');
  const previous = [
    { id: 'staff-registration', name: 'Jasmine Ramos', username: 'frontdesk' },
    { id: 'staff-doctor', name: 'Dr. Elena Santos', username: 'dr.santos' },
    { id: 'staff-laboratory', name: 'Mara Cruz', username: 'laboratory' },
    { id: 'staff-billing', name: 'Lena Garcia', username: 'billing' },
  ];
  await repository.batch([
    repository.insert('appSettings', { key: STAFF_NAMES_KEY, value: new Date().toISOString() }, { ignore: true }),
    ...previous.flatMap(old => {
      const next = DEMO_STAFF.find(staff => staff.id === old.id)!;
      if (all.some(account => account.id !== old.id && account.username === next.username)) return [];
      return [repository.update('staffAccounts', { name: next.name, username: next.username }, allOf(match('id', old.id), match('role', next.role), match('name', old.name), match('username', old.username)))];
    }),
    repository.insert('activityHistory', { id: 'AUD-STAFF-NAMES-20261031', at: new Date().toISOString(), userId: 'system', actor: 'CareRecord', role: 'system', action: 'Updated initial staff names', entityType: 'staff', entityId: STAFF_NAMES_KEY, detail: 'Applied the team’s confirmed names to the original staff profiles. The doctor sign-in is now dr.buenaflor. Existing record authors and payments retain their recorded history.' }, { ignore: true }),
  ]);
}
let seedPromise: Promise<void> | undefined;
export async function ensureSeed(request?: Request) {
  if (seedPromise) return seedPromise;
  const local = request ? ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname) : false;
  const schema = new URL(environment.databaseUrl || 'postgresql://unconfigured').searchParams.get('schema') || 'public';
  const allowTestData = local && environment.seedTestData && schema.startsWith('care_record_audit_');
  seedPromise = seed(allowTestData).catch(error => { seedPromise = undefined; throw error; });
  return seedPromise;
}
async function seed(allowTestData: boolean) {
  if ((await repository.find("appSettings", match("key", 'seed-v1'))).length) {
    await updateInstalledStaffNames();
    return;
  }
  // Deployed/fresh clinic databases require an individually provisioned manager.
  // Never install test patients or shared-password accounts on an external host.
  if (!allowTestData || (await repository.find("appSettings", match("key", 'clinic-mode')))[0]?.value === 'production') return;
  const at = '2026-10-29T01:10:00.000Z';
  const staff = await Promise.all(DEMO_STAFF.map(async user => { const salt = randomToken(16); return { ...user, salt, passwordHash: await hashPassword(DEMO_PASSWORD, salt) }; }));
  const names = ['Ana Reyes', 'Gabriel Flores', 'Isabel Mendoza', 'Marco Villanueva', 'Sofia Bautista', 'Daniel Aquino', 'Camille Torres', 'Luis Fernandez', 'Nina Castillo', 'Paolo Rivera', 'Elise Tan', 'Ramon Dizon'];
  const births = ['2002-05-15', '1989-11-07', '1995-03-22', '1978-08-14', '2000-01-09', '1986-06-30', '1992-10-18', '1970-12-02', '1998-04-11', '1983-07-25', '2004-09-03', '1965-02-16'];
  const patientRows = names.map((name, i) => ({ id: `P-${String(i + 1).padStart(4, '0')}`, name, dob: births[i], phone: '', doctorId: i % 3 === 1 ? 'staff-doctor-lim' : 'staff-doctor', updatedAt: at }));
  const visitRows = Array.from({ length: 16 }, (_, i) => {
    const p = patientRows[i % names.length]; const date = `2026-10-${String(18 + Math.floor(i * 0.65)).padStart(2, '0')}`;
    return { id: `V-${String(i + 1).padStart(4, '0')}`, patientId: p.id, doctorId: p.doctorId, date,
      reason: ['Routine follow-up', 'Annual check-up', 'Return consultation', 'Wellness consultation'][i % 4],
      notes: 'Fictional classroom consultation. Visit details reviewed with the sample patient. Follow-up recorded by the assigned doctor.',
      status: 'signed', signedAt: `${date}T03:00:00.000Z`, updatedAt: `${date}T03:00:00.000Z` };
  });
  visitRows.push({ id: 'V-0024', patientId: 'P-0001', doctorId: 'staff-doctor', date: '2026-10-29', reason: 'Follow-up consultation', notes: 'Fictional follow-up notes awaiting the assigned doctor’s review.', status: 'draft', signedAt: '', updatedAt: at });
  const tests = ['Blood glucose', 'Complete blood count', 'Urinalysis', 'Blood glucose', 'Cholesterol', 'Complete blood count'];
  const labRows = tests.map((testName, i) => ({ id: `L-${String(i + 1).padStart(4, '0')}`, patientId: visitRows[i].patientId, visitId: visitRows[i].id,
    testName, value: ['92', 'Sample report recorded', 'Sample report recorded', '88', '172', 'Sample report recorded'][i], unit: i === 0 || i === 3 || i === 4 ? 'mg/dL' : 'Not applicable',
    collectedAt: `${visitRows[i].date}T02:00:00.000Z`, status: 'approved', requestedBy: visitRows[i].doctorId,
    approvedBy: 'staff-laboratory', approvedAt: `${visitRows[i].date}T04:00:00.000Z`, sourceRef: `LAB-${String(i + 1).padStart(4, '0')}`, updatedAt: `${visitRows[i].date}T04:00:00.000Z` }));
  labRows.push({ id: 'L-0032', patientId: 'P-0001', visitId: 'V-0024', testName: 'Complete blood count', value: 'Sample report recorded', unit: 'Not applicable', collectedAt: '', status: 'draft', requestedBy: 'staff-doctor', approvedBy: '', approvedAt: '', sourceRef: 'LAB-0071', updatedAt: at });
  const billRows = visitRows.slice(0, 10).map((visit, i) => {
    const items = [{ description: 'Consultation', amount: 50000 }, ...(i < 6 ? [{ description: 'Laboratory service', amount: 25000 }] : [])];
    const total = items.reduce((sum, item) => sum + item.amount, 0); const paid = i % 3 === 0 ? 0 : i % 3 === 1 ? total : 25000;
    return { id: `B-${String(i + 1).padStart(4, '0')}`, patientId: visit.patientId, visitId: visit.id, date: visit.date, items, total, paid,
      payments: paid ? [{ id: `PAY-SEED-${i}`, amount: paid, method: 'Cash', at: `${visit.date}T05:00:00.000Z`, by: 'Kent Jeced Alcantara', reference: 'Sample payment' }] : [], sourceRef: `BILL-${i + 1}`, updatedAt: at };
  });
  const held = { externalId: 'LAB-0089', patientId: 'P-0001', patientName: 'Ana R. Reyes', patientDob: '', visitId: 'V-0024', testName: 'Urinalysis', value: 'Sample report recorded', unit: 'Not applicable', collectedAt: '2026-10-29T01:00:00.000Z' };
  const facts = [
    ...visitRows.filter(v => v.status === 'signed').map(v => ({ id: `visit:${v.id}`, source: 'Clinic', sourceId: v.id, kind: 'visit', patientKey: v.patientId, visitId: v.id, date: v.date, service: 'Consultation', total: 0, paid: 0, refreshedAt: at })),
    ...labRows.filter(l => l.status === 'approved').map(l => ({ id: `lab:${l.id}`, source: 'Laboratory', sourceId: l.id, kind: 'lab', patientKey: l.patientId, visitId: l.visitId, date: l.collectedAt.slice(0, 10), service: l.testName, total: 0, paid: 0, refreshedAt: at })),
    ...billRows.map(b => ({ id: `invoice:${b.id}`, source: 'Billing', sourceId: b.id, kind: 'invoice', patientKey: b.patientId, visitId: b.visitId, date: b.date, service: 'Clinic services', total: b.total, paid: b.paid, refreshedAt: at })),
  ];
  // Keep fixture creation in bounded batches.
  const chunks = <T,>(rows: T[]) => Array.from({ length: Math.ceil(rows.length / 3) }, (_, i) => rows.slice(i * 3, i * 3 + 3));
  await repository.batch([
    ...chunks(staff).map(rows => repository.insert("staffAccounts", rows, { ignore: true })),
    ...chunks(patientRows).map(rows => repository.insert("patients", rows, { ignore: true })),
    ...chunks(visitRows).map(rows => repository.insert("visits", rows, { ignore: true })),
    ...chunks(labRows).map(rows => repository.insert("labReports", rows, { ignore: true })),
    ...chunks(billRows).map(rows => repository.insert("invoices", rows, { ignore: true })),
    repository.insert("sourceImports", { id: 'import-lab-0089', source: 'laboratory', externalId: 'LAB-0089', payload: held, state: 'held', receivedAt: at }, { ignore: true }),
    repository.insert("qualityReviews", [
      { id: 'Q-L0032', kind: 'lab', patientId: 'P-0001', recordId: 'L-0032', title: 'Collection time missing', detail: 'Laboratory report L-0032 needs a sample collection date and time before approval.', ownerRole: 'laboratory', createdAt: at },
      { id: 'Q-IMPORT0089', kind: 'identity', patientId: 'P-0001', recordId: 'import-lab-0089', title: 'Confirm the patient identity', detail: 'Incoming LAB-0089 has an abbreviated name and no birth date. It has been kept separate.', ownerRole: 'registration', createdAt: at },
    ], { ignore: true }),
    ...chunks(facts).map(rows => repository.insert("warehouseFacts", rows, { ignore: true })),
    repository.insert("warehouseRuns", { id: 'RUN-SEED', at, userId: 'staff-reviewer', count: facts.length, summary: { Clinic: 16, Laboratory: 6, Billing: 10 } }, { ignore: true }),
    repository.insert("activityHistory", [
      { id: 'AUD-SEED-1', at: '2026-10-29T00:55:00.000Z', userId: 'staff-registration', actor: 'Rochelle Andales', role: 'registration', action: 'Checked patient details', entityType: 'patient', entityId: 'P-0001', patientId: 'P-0001', detail: 'Registration details checked for the fictional patient.' },
      { id: 'AUD-SEED-2', at: '2026-10-29T01:05:00.000Z', userId: 'staff-laboratory', actor: 'Kenji Caayohan', role: 'laboratory', action: 'Saved laboratory draft', entityType: 'lab', entityId: 'L-0032', patientId: 'P-0001', detail: 'Collection time is incomplete. The report remains unapproved.' },
      { id: 'AUD-SEED-3', at, userId: 'staff-reviewer', actor: 'Rafael Navarro', role: 'reviewer', action: 'Refreshed reporting copies', entityType: 'warehouse', entityId: 'RUN-SEED', detail: `${facts.length} selected facts copied from clinic, laboratory and billing records.` },
    ], { ignore: true }),
    repository.insert("appSettings", { key: 'seed-v1', value: at }, { ignore: true }),
    repository.insert("appSettings", { key: STAFF_NAMES_KEY, value: new Date().toISOString() }, { ignore: true }),
  ] as any);
}
