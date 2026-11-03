export const ROLES = ['registration', 'doctor', 'laboratory', 'billing', 'reviewer', 'manager'] as const;
export type Role = typeof ROLES[number];
export type Staff = { id: string; username: string; name: string; role: Role; active: boolean; mustChangePassword?: boolean };
export const ROLE_NAMES: Record<Role, string> = { registration: 'Registration', doctor: 'Doctor', laboratory: 'Laboratory', billing: 'Billing', reviewer: 'Records reviewer', manager: 'Account manager' };
export const ROLE_DETAILS: Record<Role, string> = {
  registration: 'Register patients and maintain identity and contact details.', doctor: 'Document assigned patient visits and request laboratory tests.',
  laboratory: 'Complete, review, approve and correct laboratory reports.', billing: 'Prepare itemized bills and record payments.',
  reviewer: 'Resolve identity questions, review history and prepare checked reports.', manager: 'Create staff accounts and assign responsibilities.',
};
export class AppError extends Error {
  status: number; fields?: Record<string, string>;
  constructor(message: string, status = 400, fields?: Record<string, string>) { super(message); this.status = status; this.fields = fields; }
}
export function assertRole(user: Staff, roles: Role[]) { if (!roles.includes(user.role)) throw new AppError('Your account does not have permission for this action.', 403); }
export function cleanText(value: unknown, label: string, max = 200, required = true): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new AppError(`${label} is required.`, 422);
  if (text.length > max) throw new AppError(`${label} must be ${max} characters or fewer.`, 422);
  return text;
}
// The clinic uses a fixed UTC+8 day. Keep this independent of the
// host's locale database so browser, Node and Worker runtimes agree.
export function clinicDay(value: Date = new Date()): string { return new Date(value.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10); }
export function dateOnly(value: unknown, label = 'Date', allowFuture = false): string {
  const s = cleanText(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new AppError(`Enter a valid ${label.toLowerCase()}.`, 422);
  const today = clinicDay();
  if (!allowFuture && s > today) throw new AppError(`${label} cannot be in the future.`, 422);
  return s;
}
export function validatePatient(input: any) {
  const name = cleanText(input.name, 'Patient name', 120); const dob = dateOnly(input.dob, 'Birth date');
  if (dob < '1900-01-01') throw new AppError('Check the birth year before saving.', 422);
  const phone = cleanText(input.phone, 'Contact number', 30, false);
  if (phone && !/^[+\d ()-]{5,30}$/.test(phone)) throw new AppError('Use digits, spaces, +, parentheses or hyphens for the contact number.', 422);
  return { name, dob, phone };
}
export function labProblems(report: any, visit: any): string[] {
  const problems: string[] = [];
  const rows = Array.isArray(report.measurements) ? report.measurements : [];
  if (rows.length) {
    rows.forEach((row: any, index: number) => {
      if (!row.name?.trim()) problems.push(`Measurement ${index + 1}: add its name.`);
      if (!row.result?.trim()) problems.push(`Measurement ${index + 1}: enter the result.`);
      if (!row.unit?.trim()) problems.push(`Measurement ${index + 1}: enter a unit or choose No unit.`);
    });
  } else {
    if (report.layout && report.layout !== 'general') problems.push('Add the measurements included in this report.');
    if (!report.value?.trim()) problems.push('Enter the result.');
    if (!report.unit?.trim()) problems.push('Enter a unit, or “Not applicable” for a result without units.');
  }
  if (!report.collectedAt) problems.push('Add the sample collection date and time.');
  else { const t = Date.parse(report.collectedAt); if (!Number.isFinite(t)) problems.push('Enter a valid collection date and time.');
    else { if (t > Date.now() + 60_000) problems.push('Collection time cannot be in the future.');
      const clinicDate = clinicDay(new Date(t));
      if (visit?.date && clinicDate < visit.date) problems.push('Collection date is earlier than this visit. Check the dates.'); } }
  if (!visit || visit.patientId !== report.patientId) problems.push('The patient and visit must match.');
  return problems;
}
export function moneyCents(value: unknown, label = 'Amount'): number {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new AppError(`${label} must be a positive amount with at most two decimal places.`, 422);
  const [whole, fraction = ''] = s.split('.'); const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100_000_000) throw new AppError(`${label} is outside the permitted range.`, 422);
  return cents;
}
export function validatePayment(value: unknown, total: number, paid: number): number { const amount = moneyCents(value, 'Payment'); if (amount > total - paid) throw new AppError('Payment is greater than the amount still due.', 422); return amount; }
export function identityKey(name: string) { return name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
export function csvCell(value: unknown): string { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; }
export function publicStaff(row: any): Staff { return { id: row.id, username: row.username, name: row.name, role: row.role, active: !!row.active, mustChangePassword: !!row.mustChangePassword }; }
export function summarizeFacts(facts: any[]) {
  const visitFacts = facts.filter(f => f.kind === 'visit'); const labs = facts.filter(f => f.kind === 'lab'); const bills = facts.filter(f => f.kind === 'invoice');
  return { visits: visitFacts.length, laboratoryReports: labs.length, invoices: bills.length, patients: new Set(facts.map(f => f.patientKey)).size,
    charged: bills.reduce((sum, f) => sum + f.total, 0), paid: bills.reduce((sum, f) => sum + f.paid, 0), due: bills.reduce((sum, f) => sum + f.total - f.paid, 0) };
}
