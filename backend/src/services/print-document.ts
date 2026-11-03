import { VITAL_FIELDS } from '../../../shared/clinical.ts';

const h = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (cents: number) => `PHP ${(cents / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const time = (value: string) => value ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(new Date(value)) + ' UTC+8' : 'Not recorded';
const section = (label: string, text: unknown) => `<section><h2>${h(label)}</h2><p class="pre">${h(text || 'Not recorded')}</p></section>`;
const table = (heads: string[], rows: unknown[][]) => `<table><thead><tr>${heads.map(v => `<th>${h(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(v => `<td>${h(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
export function renderDocument(kind: string, record: any, patient: any, staff: any[], clinic: any, payment?: any) {
  const title = ({ visit: 'Consultation summary', lab: 'Laboratory report', bill: 'Bill summary', receipt: 'Payment receipt' } as any)[kind];
  const person = (id: string) => staff.find(s => s.id === id)?.name || id || 'Not recorded';
  let body = '';
  if (kind === 'visit') {
    const c = record.clinical || {};
    body = `<p>Visit date: ${h(record.date)}<br>Responsible doctor: ${h(person(record.doctorId))}<br>Completed: ${h(time(record.signedAt))}</p>` +
      section('Reason for visit', record.reason) + section('Consultation notes', record.notes) +
      (c.structured ? section('Relevant history', c.history) + section('Allergy review', c.allergyStatus === 'none' ? 'No known allergies reported' : c.allergyStatus === 'recorded' ? c.allergies : 'Not yet confirmed') +
        section('Current medicines', c.medicines) + table(['Measurement', 'Recorded value'], VITAL_FIELDS.filter(([key]) => c.vitals?.[key]).map(([key, label, unit]) => [label, `${c.vitals[key]} ${unit}`])) +
        section('Examination findings', c.findings) + section('Assessment', c.assessment) + section('Care plan', c.plan) : '');
  } else if (kind === 'lab') {
    body = `<p>Test: ${h(record.testName)}<br>Sample: ${h(record.specimen || 'Not recorded')}<br>Collected: ${h(time(record.collectedAt))}<br>Approved by: ${h(person(record.approvedBy))}<br>Approved: ${h(time(record.approvedAt))}</p>` +
      (record.urgency === 'urgent' ? section('Urgent clinician review', `Contacted ${record.contact?.person || 'responsible clinician'} by ${record.contact?.method || 'recorded contact'} at ${time(record.contact?.at)}.`) : '') +
      (record.measurements?.length ? table(['Measurement', 'Result', 'Unit', 'Laboratory reference', 'Lab flag'], record.measurements.map((r: any) => [r.name, r.result, r.unit, r.reference || 'Not supplied', r.flag || ''])) : table(['Result', 'Unit'], [[record.value, record.unit]])) +
      (record.reportComment ? section('Laboratory comment', record.reportComment) : '') + `<p>Source reference: ${h(record.sourceRef)}</p>`;
  } else if (kind === 'bill') {
    body = `<p>Bill date: ${h(record.date)}</p>` + table(['Service', 'Charge'], record.items.map((r: any) => [r.description, money(r.amount)])) +
      table(['Summary', 'Amount'], [['Total charges', money(record.total)], ['Payments received', money(record.paid)], ['Remaining balance', money(record.total - record.paid)]]);
  } else {
    body = table(['Payment detail', 'Recorded value'], [['Payment reference', payment.id], ['Received', time(payment.at)], ['Amount received', money(payment.amount)], ['Method', payment.method], ['Transaction reference', payment.reference || 'Not supplied'], ['Recorded by', payment.by]]) +
      `<p>This receipt records this individual payment against bill ${h(record.id)}.</p>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} ${h(record.id)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f5f2;color:#17231b;font:15px/1.6 Arial,sans-serif}main{max-width:850px;margin:24px auto;background:white;padding:44px}header{border-bottom:2px solid #2c3b31;padding-bottom:18px}h1{font-size:26px;margin:0 0 10px}h2{font-size:16px;margin:20px 0 6px}p{margin:8px 0}.clinic{font-size:19px;font-weight:bold}.meta{color:#4b5850;font-size:13px}.identity{margin:24px 0;padding:14px 0;border-block:1px solid #ddd}.pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;margin:20px 0;table-layout:fixed}td,th{padding:9px 8px;text-align:left;border-bottom:1px solid #ddd;overflow-wrap:anywhere;vertical-align:top}th{font-size:13px}section{break-inside:avoid}footer{margin-top:28px;border-top:1px solid #ddd;padding-top:12px;font-size:12px;color:#555}.print-running{display:none}.print-tools{max-width:850px;margin:18px auto;display:flex;justify-content:space-between;align-items:center;padding:0 12px;gap:12px}.print-tools button{background:#2c3b31;color:#fff;border:0;border-radius:6px;padding:12px 20px;cursor:pointer;font:inherit}@media(max-width:600px){main{margin:0;padding:24px 18px}.print-tools{font-size:13px}td,th{padding:8px 4px;font-size:12px}}@media print{.print-running{display:block;position:fixed;top:-11mm;left:0;right:0;font-size:10px;color:#555;border-bottom:1px solid #ddd}@page{size:A4;margin:16mm}body{background:white}main{padding:0;margin:0;max-width:none}.print-tools{display:none}table{break-inside:auto}tr{break-inside:avoid}thead{display:table-header-group}h2{break-after:avoid}}</style></head><body><div class="print-running">${h(patient.name)} · Patient ${h(patient.id)} · ${h(title)} ${h(record.id)}</div><div class="print-tools"><span>Saved document · Print or save as PDF</span><button onclick="window.print()">Print document</button></div><main><header><div class="clinic">${h(clinic.name)}</div>${clinic.address ? `<p>${h(clinic.address)}</p>` : ''}${clinic.contact ? `<p>${h(clinic.contact)}</p>` : ''}</header><h1>${h(title)}</h1><p class="meta">Record ${h(record.id)} · Version ${h(record.version)} · Visit ${h(record.visitId || record.id)}</p><div class="identity"><strong>${h(patient.name)}</strong><br>Patient ${h(patient.id)} · Birth date ${h(patient.dob)}</div>${body}<footer>Prepared from the saved record on ${h(time(new Date().toISOString()))}. Earlier signed/approved versions remain in the permitted record history.</footer></main></body></html>`;
}
