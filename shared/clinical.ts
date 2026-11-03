import { AppError, cleanText } from './domain.ts';

export type Measurement = { name: string; result: string; unit: string; reference: string; flag: string };
export const LAB_LAYOUTS = [
  { id: 'general', name: 'Flexible report' }, { id: 'glucose', name: 'Blood glucose' },
  { id: 'cbc', name: 'Complete blood count (CBC)' }, { id: 'urinalysis', name: 'Urinalysis' },
] as const;
// These are field arrangements, not test orders, reference intervals or clinical rules.
export function templateRows(layout: string): Measurement[] {
  const labels: Record<string, string[]> = {
    glucose: ['Blood glucose'],
    cbc: ['Hemoglobin', 'Hematocrit', 'Red blood cells', 'White blood cells', 'Platelets'],
    urinalysis: ['Color', 'Appearance', 'Specific gravity', 'pH', 'Protein', 'Glucose', 'White blood cells', 'Red blood cells'],
  };
  return (labels[layout] || ['Result']).map(name => ({ name, result: '', unit: '', reference: '', flag: '' }));
}
export function suggestedLayout(name: string) {
  if (/complete blood count|\bcbc\b/i.test(name)) return 'cbc';
  if (/urinalysis/i.test(name)) return 'urinalysis';
  if (/glucose|blood sugar/i.test(name)) return 'glucose';
  return 'general';
}
export const VITAL_FIELDS = [
  ['systolic', 'Blood pressure: upper number', 'mmHg'], ['diastolic', 'Blood pressure: lower number', 'mmHg'],
  ['pulse', 'Pulse', 'beats/min'], ['temperature', 'Temperature', '°C'], ['respiratoryRate', 'Breathing rate', 'breaths/min'],
  ['oxygen', 'Oxygen saturation', '%'], ['weight', 'Weight', 'kg'], ['height', 'Height', 'cm'],
] as const;
export function cleanClinical(value: any, complete = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Enter valid consultation sections.', 422);
  const clinical: any = { structured: true };
  for (const [key, label] of [['history', 'Relevant patient history'], ['allergies', 'Allergy details'], ['medicines', 'Current medicines'],
    ['findings', 'Examination findings'], ['assessment', 'Assessment'], ['plan', 'Care plan']] as const) {
    clinical[key] = cleanText(value[key], label, 5000, complete && ['assessment', 'plan'].includes(key));
  }
  if (!['unknown', 'none', 'recorded'].includes(value.allergyStatus)) throw new AppError('Choose an allergy review status.', 422);
  clinical.allergyStatus = value.allergyStatus;
  if (value.allergyStatus === 'recorded' && !clinical.allergies) throw new AppError('Enter the reported allergy and reaction details.', 422);
  clinical.vitals = {};
  for (const [key, label] of VITAL_FIELDS) {
    const text = String(value.vitals?.[key] ?? '').trim();
    // Validate notation only, never silently discard or label clinical measurements as normal.
    if (text && (!/^\d+(\.\d{1,2})?$/.test(text) || text.length > 10)) throw new AppError(`Enter ${label.toLowerCase()} as a number, or leave it blank.`, 422);
    clinical.vitals[key] = text;
  }
  return clinical;
}
export function cleanMeasurements(value: unknown): Measurement[] {
  if (!Array.isArray(value) || value.length > 30) throw new AppError('Use at most 30 measurements per report.', 422);
  return value.map((row: any) => {
    if (!row || typeof row !== 'object') throw new AppError('Enter a valid measurement row.', 422);
    const flag = cleanText(row.flag, 'Laboratory flag', 30, false);
    if (!['', 'high', 'low', 'abnormal'].includes(flag)) throw new AppError('Choose a listed laboratory flag.', 422);
    return { name: cleanText(row.name, 'Measurement name', 120, false), result: cleanText(row.result, 'Measurement result', 500, false),
      unit: cleanText(row.unit, 'Measurement unit', 80, false), reference: cleanText(row.reference, 'Laboratory reference', 200, false), flag };
  });
}
export function measurementProblems(rows: any[]): string[] {
  return rows.flatMap((row, index) => {
    const prefix = `Measurement ${index + 1}`;
    return [!row.name?.trim() ? `${prefix}: add its name.` : '', !row.result?.trim() ? `${prefix}: enter the result.` : '',
      !row.unit?.trim() ? `${prefix}: enter a unit or choose No unit.` : ''].filter(Boolean);
  });
}
export function needsDoctorReview(report: any) {
  return report.status === 'approved' && report.doctorReview?.reportApprovedAt !== report.approvedAt;
}
