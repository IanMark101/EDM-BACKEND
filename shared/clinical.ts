import { AppError, cleanText } from './domain.ts';

export type Measurement = { name: string; result: string; unit: string; reference: string; flag: string };
export const LAB_LAYOUTS = [
  { id: 'general', name: 'Flexible report' }, { id: 'glucose', name: 'Blood glucose' },
  { id: 'cbc', name: 'Complete blood count (CBC)' }, { id: 'urinalysis', name: 'Urinalysis' },
  { id: 'lipid', name: 'Lipid panel' }, { id: 'hba1c', name: 'Hemoglobin A1c' },
  { id: 'creatinine', name: 'Creatinine' }, { id: 'bun', name: 'Blood urea nitrogen' },
] as const;
export const URGENT_CONTACT_METHODS = ['Phone', 'In person', 'Clinic messaging'] as const;
export const SPECIMEN_OPTIONS = ['Blood', 'Urine', 'Serum', 'Plasma', 'Whole blood', 'Stool', 'Swab', 'Sputum'] as const;
export const STANDARD_LAB_UNITS = [
  'mg/dL', 'mmol/L', 'g/dL', 'g/L', '%', '10^9/L', '10^12/L',
  '/uL', '/hpf', '/lpf', 'U/L', 'mEq/L', 'mIU/L',
  'ng/mL', 'pg/mL', 'IU/mL', 'mm/hr', 'mL/min/1.73m²',
  'seconds', 'INR', 'Not applicable',
] as const;
export const QUANTITATIVE_LAB_UNITS = STANDARD_LAB_UNITS.filter(u => u !== 'Not applicable');
const UNIT_LOOKUP = new Map<string, string>([
  ...STANDARD_LAB_UNITS.map(u => [u.toLocaleLowerCase(), u] as const),
  ['ml/min/1.73m2', 'mL/min/1.73m²'],
]);
export function cleanLabUnit(value: unknown, required = false): string {
  const raw = cleanText(value, 'Unit', 80, required);
  if (!raw) return '';
  const key = raw.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').toLocaleLowerCase();
  const matched = UNIT_LOOKUP.get(key);
  if (matched) return matched;
  throw new AppError('Choose a standard laboratory unit (e.g. mg/dL, mmol/L, g/dL, %, 10^9/L, /hpf, or Not applicable).', 422);
}
export function labResultError(result: unknown, unit: unknown): string {
  const text = typeof result === 'string' ? result.trim() : '';
  const unitText = typeof unit === 'string' ? unit.trim() : '';
  if (!text || !unitText || unitText === 'Not applicable') return '';
  if (!/^(?:[<>]=?\s*)?\d+(?:\.\d{1,3})?(?:\s*-\s*\d+(?:\.\d{1,3})?)?$/.test(text)) {
    return 'Enter a numeric result (e.g. 92, 5.6, <5, or 2-4) without repeating the unit.';
  }
  return '';
}
// These are field arrangements, not test orders, reference intervals or clinical rules.
export function templateRows(layout: string): Measurement[] {
  const labels: Record<string, [string, string][]> = {
    glucose: [['Blood glucose', 'mg/dL']],
    cbc: [['Hemoglobin', 'g/dL'], ['Hematocrit', '%'], ['Red blood cells', '10^12/L'], ['White blood cells', '10^9/L'], ['Platelets', '10^9/L']],
    urinalysis: [['Color', 'Not applicable'], ['Appearance', 'Not applicable'], ['Specific gravity', 'Not applicable'], ['pH', 'Not applicable'], ['Protein', 'Not applicable'], ['Glucose', 'Not applicable'], ['White blood cells', '/hpf'], ['Red blood cells', '/hpf']],
    lipid: [['Total cholesterol', 'mg/dL'], ['Triglycerides', 'mg/dL'], ['HDL cholesterol', 'mg/dL'], ['LDL cholesterol', 'mg/dL']],
    hba1c: [['Hemoglobin A1c', '%']],
    creatinine: [['Creatinine', 'mg/dL']],
    bun: [['Blood urea nitrogen', 'mg/dL']],
  };
  return (labels[layout] || [['Result', '']]).map(([name, unit]) => ({ name, result: '', unit, reference: '', flag: '' }));
}
export function suggestedLayout(name: string) {
  if (/complete blood count|\bcbc\b/i.test(name)) return 'cbc';
  if (/urinalysis/i.test(name)) return 'urinalysis';
  if (/glucose|blood sugar/i.test(name)) return 'glucose';
  if (/lipid/i.test(name)) return 'lipid';
  if (/a1c|hba1c/i.test(name)) return 'hba1c';
  if (/creatinine/i.test(name)) return 'creatinine';
  if (/urea nitrogen|\bbun\b/i.test(name)) return 'bun';
  return 'general';
}
export const VITAL_FIELDS = [
  ['systolic', 'Blood pressure: upper number', 'mmHg'], ['diastolic', 'Blood pressure: lower number', 'mmHg'],
  ['pulse', 'Pulse', 'beats/min'], ['temperature', 'Temperature', '°C'], ['respiratoryRate', 'Breathing rate', 'breaths/min'],
  ['oxygen', 'Oxygen saturation', '%'], ['weight', 'Weight', 'kg'], ['height', 'Height', 'cm'],
] as const;
export const VITAL_BOUNDS: Record<typeof VITAL_FIELDS[number][0], [number, number]> = {
  systolic: [40, 300], diastolic: [20, 200], pulse: [20, 300], temperature: [25, 45],
  respiratoryRate: [4, 100], oxygen: [30, 100], weight: [0.5, 500], height: [20, 280],
};
export function vitalErrors(vitals: Record<string, unknown> | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!vitals || typeof vitals !== 'object') return errors;
  for (const [key, label, unit] of VITAL_FIELDS) {
    const text = String(vitals[key] ?? '').trim();
    if (!text) continue;
    if (!/^\d+(\.\d{1,2})?$/.test(text) || text.length > 10) {
      errors[key] = `Enter ${label.toLowerCase()} as a number.`;
      continue;
    }
    const numeric = Number(text);
    const [min, max] = VITAL_BOUNDS[key];
    if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
      errors[key] = `Must be between ${min} and ${max} ${unit}.`;
    }
  }
  const sys = String(vitals.systolic ?? '').trim();
  const dia = String(vitals.diastolic ?? '').trim();
  if (!errors.systolic && !errors.diastolic && sys && dia && Number(sys) <= Number(dia)) {
    errors.systolic = 'Upper BP must be greater than lower BP.';
  }
  return errors;
}
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
  for (const [key, label, unit] of VITAL_FIELDS) {
    const text = String(value.vitals?.[key] ?? '').trim();
    // Validate notation and physical plausibility only, never silently discard or label clinical measurements as normal.
    if (text && (!/^\d+(\.\d{1,2})?$/.test(text) || text.length > 10)) throw new AppError(`Enter ${label.toLowerCase()} as a number, or leave it blank.`, 422);
    if (text) {
      const numeric = Number(text);
      const [min, max] = VITAL_BOUNDS[key];
      if (!Number.isFinite(numeric) || numeric < min || numeric > max)
        throw new AppError(`${label} must be between ${min} and ${max} ${unit}. Check for a typing error.`, 422);
    }
    clinical.vitals[key] = text;
  }
  if (clinical.vitals.systolic && clinical.vitals.diastolic && Number(clinical.vitals.systolic) <= Number(clinical.vitals.diastolic))
    throw new AppError('Blood pressure upper number must be greater than the lower number.', 422);
  return clinical;
}
export function cleanMeasurements(value: unknown): Measurement[] {
  if (!Array.isArray(value) || value.length > 30) throw new AppError('Use at most 30 measurements per report.', 422);
  return value.map((row: any) => {
    if (!row || typeof row !== 'object') throw new AppError('Enter a valid measurement row.', 422);
    const flag = cleanText(row.flag, 'Laboratory flag', 30, false);
    if (!['', 'high', 'low', 'abnormal'].includes(flag)) throw new AppError('Choose a listed laboratory flag.', 422);
    const name = cleanText(row.name, 'Measurement name', 120, false);
    if (name && !/\p{L}/u.test(name)) throw new AppError('Enter a valid measurement name containing letters.', 422);
    const unit = cleanLabUnit(row.unit, false);
    const result = cleanText(row.result, 'Measurement result', 500, false);
    const resultErr = labResultError(result, unit);
    if (resultErr) throw new AppError(resultErr, 422);
    return { name, result, unit, reference: cleanText(row.reference, 'Laboratory reference', 200, false), flag };
  });
}
export function measurementProblems(rows: any[]): string[] {
  return rows.flatMap((row, index) => {
    const prefix = `Measurement ${index + 1}`;
    let unitProblem = '';
    if (!row.unit?.trim()) unitProblem = `${prefix}: enter a unit or choose No unit.`;
    else {
      try { cleanLabUnit(row.unit, false); }
      catch { unitProblem = `${prefix}: choose a standard laboratory unit.`; }
    }
    const resultErr = row.result?.trim() ? labResultError(row.result, row.unit) : '';
    return [
      !row.name?.trim() ? `${prefix}: add its name.` : !/\p{L}/u.test(row.name) ? `${prefix}: enter a valid measurement name containing letters.` : '',
      !row.result?.trim() ? `${prefix}: enter the result.` : resultErr ? `${prefix}: ${resultErr}` : '',
      unitProblem,
    ].filter(Boolean);
  });
}
export function needsDoctorReview(report: any) {
  return report.status === 'approved' && report.doctorReview?.reportApprovedAt !== report.approvedAt;
}
