import {
  AppError, assertRole, cleanClinicPhone, cleanText, clinicDay,
  identityKey, labProblems, nameTokenKey, type Staff,
} from '../../../shared/domain';
import { cleanClinical, cleanLabUnit, labResultError, type Measurement } from '../../../shared/clinical';
import { serviceNameKey } from '../../../shared/billing';
import { oneOf, repository, type ClinicRepository } from '../repositories/clinic.repository';
import { readPriceList } from '../repositories/pricing.repository';
import type { ServiceContext } from '../http/context';
import { result } from '../http/result';
import { auditRow, now, refreshWarehouse } from './server';

export const DEMO_PATIENT_IDS = Array.from({ length: 35 }, (_, i) => `P-DEMO-${String(i + 1).padStart(2, '0')}`);
const DEMO_VISIT_IDS = Array.from({ length: 35 }, (_, i) => `V-DEMO-${String(i + 1).padStart(2, '0')}`);
const DEMO_LAB_IDS = [
  ...Array.from({ length: 23 }, (_, i) => `L-DEMO-${String(i + 1).padStart(2, '0')}`),
  'L-DEMO-DQ-01',
];
const DEMO_INVOICE_IDS = Array.from({ length: 22 }, (_, i) => `B-DEMO-${String(i + 1).padStart(2, '0')}`);
const DEMO_IMPORT_IDS = ['IMP-DEMO-01', 'IMP-DEMO-02', 'IMP-DEMO-03'];
const DEMO_REVIEW_IDS = ['Q-DEMO-01', 'Q-DEMO-02', 'Q-DEMO-03'];
const DEMO_AUDIT_IDS = Array.from({ length: 12 }, (_, i) => `AUD-DEMO-${String(i + 1).padStart(2, '0')}`);

type PatientSeedSpec = {
  name: string;
  dob: string;
  phone: string;
  reason: string;
  allergies: { status: 'none' | 'recorded'; details: string };
  history: string;
  findings: string;
  assessment: string;
  plan: string;
  vitals: {
    systolic: string; diastolic: string; pulse: string; temperature: string;
    respiratoryRate: string; oxygen: string; weight: string; height: string;
  };
};

const PATIENT_SPECS: PatientSeedSpec[] = [
  {
    name: 'Lorenzo Villanueva Santos', dob: '1964-03-14', phone: '0917 412 8801',
    reason: 'Follow-up for hypertension and elevated fasting glucose',
    allergies: { status: 'recorded', details: 'Sulfa drugs — mild skin rash' },
    history: 'Diagnosed with primary hypertension 5 years ago. Compliant with maintenance medication.',
    findings: 'Alert, cooperative. Regular cardiac rate and rhythm; lungs clear on auscultation.',
    assessment: 'Controlled essential hypertension; screen for impaired fasting glucose.',
    plan: 'Continue losartan 50mg OD; request Fasting Blood Glucose and monitor home BP daily.',
    vitals: { systolic: '132', diastolic: '84', pulse: '76', temperature: '36.6', respiratoryRate: '18', oxygen: '98', weight: '72.5', height: '168' },
  },
  {
    name: 'Patricia Mendoza Reyes', dob: '1978-11-22', phone: '0918 523 4402',
    reason: 'Annual executive wellness evaluation and fatigue',
    allergies: { status: 'none', details: '' },
    history: 'Reports mild afternoon fatigue over the past three weeks. No fever or weight loss.',
    findings: 'Slightly pale palpebral conjunctiva; otherwise unremarkable cardiopulmonary exam.',
    assessment: 'Mild fatigue, rule out iron-deficiency anemia.',
    plan: 'Order Complete blood count and counsel on iron-rich dietary intake.',
    vitals: { systolic: '112', diastolic: '74', pulse: '82', temperature: '36.7', respiratoryRate: '18', oxygen: '99', weight: '56.0', height: '158' },
  },
  {
    name: 'Camille Bautista Torres', dob: '1994-08-19', phone: '0919 634 1103',
    reason: 'Dysuria and increased urinary frequency for 2 days',
    allergies: { status: 'none', details: '' },
    history: 'Acute onset urinary frequency and mild suprapubic discomfort without flank pain or fever.',
    findings: 'Mild suprapubic tenderness on deep palpation; no costovertebral angle tenderness.',
    assessment: 'Uncomplicated lower urinary tract infection.',
    plan: 'Request Urinalysis, increase oral fluid intake, and follow up with laboratory results.',
    vitals: { systolic: '110', diastolic: '70', pulse: '80', temperature: '37.1', respiratoryRate: '18', oxygen: '99', weight: '54.2', height: '160' },
  },
  {
    name: 'Miguel Angelo Cruz', dob: '1985-01-30', phone: '0920 745 2204',
    reason: 'Cardiovascular risk screening and dyslipidemia review',
    allergies: { status: 'none', details: '' },
    history: 'Family history of premature coronary artery disease. Sedentary office occupation.',
    findings: 'No xanthomas or peripheral edema; heart sounds distinct without murmurs.',
    assessment: 'Cardiometabolic risk screening.',
    plan: 'Order fasting Lipid panel and recommend 150 minutes/week of moderate aerobic exercise.',
    vitals: { systolic: '126', diastolic: '82', pulse: '74', temperature: '36.5', respiratoryRate: '17', oxygen: '98', weight: '79.0', height: '172' },
  },
  {
    name: 'Sophia Mae Navarro', dob: '1999-07-04', phone: '0921 856 3305',
    reason: 'Polyuria and family history of type 2 diabetes',
    allergies: { status: 'recorded', details: 'Seafood — hives' },
    history: 'Increased thirst and mild post-prandial lethargy for 1 month.',
    findings: 'Good skin turgor, no acanthosis nigricans, normal neurological exam.',
    assessment: 'Evaluate glycemic control over the last 3 months.',
    plan: 'Request Hemoglobin A1c test and advise balanced carbohydrate portions.',
    vitals: { systolic: '116', diastolic: '76', pulse: '78', temperature: '36.6', respiratoryRate: '18', oxygen: '99', weight: '61.5', height: '162' },
  },
  {
    name: 'Daniel Joseph Aquino', dob: '1972-09-12', phone: '0922 967 5506',
    reason: 'Renal function check before NSAID adjustment',
    allergies: { status: 'none', details: '' },
    history: 'Occasional knee osteoarthritis pain managed intermittently with topical and oral analgesics.',
    findings: 'No bilateral pedal edema; blood pressure stable.',
    assessment: 'Baseline renal function screening prior to analgesic adjustment.',
    plan: 'Check serum Creatinine and prefer non-nephrotoxic joint management.',
    vitals: { systolic: '128', diastolic: '80', pulse: '72', temperature: '36.4', respiratoryRate: '16', oxygen: '98', weight: '74.0', height: '170' },
  },
  {
    name: 'Beatriz Mercado Lim', dob: '1988-05-28', phone: '0923 118 6607',
    reason: 'Routine metabolic follow-up',
    allergies: { status: 'none', details: '' },
    history: 'Asymptomatic, coming in for scheduled kidney hydration and metabolic baseline.',
    findings: 'Hydrated mucous membranes; normal abdominal exam.',
    assessment: 'Routine preventive metabolic assessment.',
    plan: 'Order Blood urea nitrogen and encourage adequate daily water intake.',
    vitals: { systolic: '114', diastolic: '72', pulse: '70', temperature: '36.5', respiratoryRate: '16', oxygen: '99', weight: '58.0', height: '159' },
  },
  {
    name: 'Gabriel Antonio Flores', dob: '1991-12-03', phone: '0926 229 7708',
    reason: 'Pre-employment medical screening and blood sugar check',
    allergies: { status: 'none', details: '' },
    history: 'No chronic illness; fasting since 10 PM yesterday.',
    findings: 'Well-nourished, alert, normal physical examination.',
    assessment: 'General medical fitness screening.',
    plan: 'Request Blood glucose and issue medical clearance after review.',
    vitals: { systolic: '118', diastolic: '76', pulse: '72', temperature: '36.6', respiratoryRate: '17', oxygen: '99', weight: '68.0', height: '171' },
  },
  {
    name: 'Isabela Soriano Ramos', dob: '1969-04-17', phone: '0927 331 8809',
    reason: 'Recurring mild dizziness and hematology follow-up',
    allergies: { status: 'recorded', details: 'Penicillin — bronchospasm in childhood' },
    history: 'Experienced two brief episodes of orthostatic lightheadedness this week.',
    findings: 'No orthostatic hypotension; cardiac rhythm regular.',
    assessment: 'Dizziness, rule out anemia or thrombocytopenia.',
    plan: 'Order Complete blood count and instruct slow positional changes.',
    vitals: { systolic: '122', diastolic: '78', pulse: '79', temperature: '36.7', respiratoryRate: '18', oxygen: '98', weight: '60.4', height: '156' },
  },
  {
    name: 'Marco Paulo Castillo', dob: '1983-06-25', phone: '0928 442 9910',
    reason: 'Low-back discomfort and routine urine screen',
    allergies: { status: 'none', details: '' },
    history: 'Mild right lumbar ache after lifting boxes; no gross hematuria.',
    findings: 'Mild paraspinal muscle tenderness; CVA tenderness negative.',
    assessment: 'Lumbar muscular strain, rule out urinary calculi/infection.',
    plan: 'Order Urinalysis, ergonomic rest, and warm compress.',
    vitals: { systolic: '124', diastolic: '80', pulse: '75', temperature: '36.8', respiratoryRate: '18', oxygen: '99', weight: '76.2', height: '173' },
  },
  {
    name: 'Clarisse Pascual Ocampo', dob: '1996-10-08', phone: '0929 553 1211',
    reason: 'Preventive cholesterol screening',
    allergies: { status: 'none', details: '' },
    history: 'High dietary saturated fat intake; seeks baseline lipid assessment.',
    findings: 'Normal BMI, clear lungs, normal heart sounds.',
    assessment: 'Routine lipid screening.',
    plan: 'Request Lipid panel and review high-fiber meal planning.',
    vitals: { systolic: '108', diastolic: '70', pulse: '74', temperature: '36.5', respiratoryRate: '16', oxygen: '99', weight: '52.8', height: '157' },
  },
  {
    name: 'Rafael Domingo Tan', dob: '1961-02-19', phone: '0930 664 2312',
    reason: 'Quarterly diabetes control follow-up',
    allergies: { status: 'none', details: '' },
    history: 'Type 2 diabetes on metformin 500mg BID. Reports good medication adherence.',
    findings: 'Pedal pulses palpable bilaterally; monofilament foot sensation intact.',
    assessment: 'Type 2 diabetes mellitus, evaluate 3-month glycemic average.',
    plan: 'Request Hemoglobin A1c and continue current oral hypoglycemic therapy.',
    vitals: { systolic: '134', diastolic: '84', pulse: '73', temperature: '36.6', respiratoryRate: '18', oxygen: '98', weight: '70.0', height: '166' },
  },
  {
    name: 'Hannah Grace Garcia', dob: '2001-03-27', phone: '0935 775 3413',
    reason: 'Annual athletic clearance and kidney function panel',
    allergies: { status: 'none', details: '' },
    history: 'Collegiate swimmer taking creatine-free hydration supplements.',
    findings: 'Resting bradycardia consistent with athletic conditioning; clear lungs.',
    assessment: 'Routine sports clearance.',
    plan: 'Order Creatinine test and certify clearance upon laboratory review.',
    vitals: { systolic: '106', diastolic: '68', pulse: '62', temperature: '36.5', respiratoryRate: '16', oxygen: '99', weight: '55.5', height: '164' },
  },
  {
    name: 'Victorino Morales Pineda', dob: '1959-08-11', phone: '0936 886 4514',
    reason: 'Hypertension medication renewal and renal check',
    allergies: { status: 'recorded', details: 'Aspirin — gastric irritation' },
    history: 'On amlodipine 5mg OD. No chest pain or dyspnea on exertion.',
    findings: 'Minimal ankle trace, clear lung bases, regular heart rate.',
    assessment: 'Stable hypertension; monitor serum urea nitrogen.',
    plan: 'Request Blood urea nitrogen and renew 30-day antihypertensive prescription.',
    vitals: { systolic: '136', diastolic: '86', pulse: '71', temperature: '36.5', respiratoryRate: '18', oxygen: '97', weight: '69.0', height: '165' },
  },
  {
    name: 'Teresita Alvarez Pangilinan', dob: '1967-07-15', phone: '0939 997 5615',
    reason: 'Elevated home glucometer readings and blurred vision',
    allergies: { status: 'none', details: '' },
    history: 'Reports blurred vision and dry mouth after skipping maintenance diabetes tablets for 1 week.',
    findings: 'Mildly dry oral mucosa; alert and coherent, no Kussmaul breathing.',
    assessment: 'Hyperglycemia secondary to medication interruption.',
    plan: 'Urgent Blood glucose test; resume antidiabetic therapy and hydrate immediately.',
    vitals: { systolic: '138', diastolic: '86', pulse: '88', temperature: '36.8', respiratoryRate: '20', oxygen: '98', weight: '64.0', height: '155' },
  },
  {
    name: 'Enrique De la Rosa Gomez', dob: '1975-11-05', phone: '0945 108 6716',
    reason: 'Persistent bruising after minor trauma',
    allergies: { status: 'none', details: '' },
    history: 'Noticed two small ecchymoses on forearms over the past week.',
    findings: 'Two 2cm fading ecchymoses on right forearm; no hepatosplenomegaly.',
    assessment: 'Easy bruising; evaluate platelet count and hemoglobin.',
    plan: 'Request Complete blood count and avoid aspirin-containing products.',
    vitals: { systolic: '120', diastolic: '78', pulse: '76', temperature: '36.6', respiratoryRate: '18', oxygen: '99', weight: '75.0', height: '170' },
  },
  {
    name: 'Margarita San Jose Tolentino', dob: '1981-04-23', phone: '0947 219 7817',
    reason: 'Weight management and lipid profile evaluation',
    allergies: { status: 'none', details: '' },
    history: 'Started low-sodium nutrition program 2 months ago; requests repeat lipid check.',
    findings: 'Normal vital signs, abdomen soft and nontender.',
    assessment: 'Follow-up dyslipidemia management.',
    plan: 'Order Lipid panel and reinforce lifestyle modifications.',
    vitals: { systolic: '118', diastolic: '76', pulse: '74', temperature: '36.5', respiratoryRate: '17', oxygen: '99', weight: '63.0', height: '160' },
  },
  {
    name: 'Carlo Magno Evangelista', dob: '1990-09-14', phone: '0949 321 8918',
    reason: 'Follow-up for borderline fasting sugar',
    allergies: { status: 'none', details: '' },
    history: 'Previous fasting glucose was 104 mg/dL; completed 8-week diet intervention.',
    findings: 'Alert, weight down by 2 kg since prior visit.',
    assessment: 'Prediabetes follow-up.',
    plan: 'Check Hemoglobin A1c to confirm glycemic trend.',
    vitals: { systolic: '116', diastolic: '74', pulse: '72', temperature: '36.6', respiratoryRate: '16', oxygen: '99', weight: '71.0', height: '169' },
  },
  {
    name: 'Katrina Mae Rosales', dob: '1997-01-19', phone: '0955 432 9019',
    reason: 'Mild dehydration recovery and follow-up check',
    allergies: { status: 'none', details: '' },
    history: 'Recovering from acute gastroenteritis 4 days ago; oral intake now normal.',
    findings: 'Normal skin turgor, active bowel sounds, no abdominal tenderness.',
    assessment: 'Resolved acute gastroenteritis; confirm renal recovery.',
    plan: 'Order Creatinine test to confirm baseline hydration status.',
    vitals: { systolic: '108', diastolic: '70', pulse: '76', temperature: '36.5', respiratoryRate: '17', oxygen: '99', weight: '51.5', height: '156' },
  },
  {
    name: 'Eduardo Santiago Roxas', dob: '1963-12-09', phone: '0956 543 1120',
    reason: 'Annual senior wellness check and blood sugar check',
    allergies: { status: 'none', details: '' },
    history: 'Well-controlled blood pressure on diet alone; requests routine screening.',
    findings: 'Clear breath sounds, regular rhythm, no peripheral edema.',
    assessment: 'Senior preventive health review.',
    plan: 'Request Blood glucose screening and advise annual wellness follow-up.',
    vitals: { systolic: '124', diastolic: '78', pulse: '70', temperature: '36.4', respiratoryRate: '17', oxygen: '98', weight: '66.0', height: '164' },
  },
  {
    name: 'Angelica Valdez Herrera', dob: '1986-02-28', phone: '0961 654 2221',
    reason: 'Tension headaches during workweek',
    allergies: { status: 'none', details: '' },
    history: 'Bilateral band-like frontal headaches in late afternoon associated with prolonged screen time.',
    findings: 'Normal cranial nerve II-XII exam, no papilledema, mild trapezius tightness.',
    assessment: 'Tension-type headache.',
    plan: 'Prescribe short-term paracetamol PRN, ergonomic breaks, and hydration.',
    vitals: { systolic: '116', diastolic: '74', pulse: '75', temperature: '36.6', respiratoryRate: '17', oxygen: '99', weight: '57.0', height: '159' },
  },
  {
    name: 'Dominic Soriano Velasco', dob: '1979-06-16', phone: '0965 765 3322',
    reason: 'Mild seasonal allergic rhinitis',
    allergies: { status: 'recorded', details: 'Dust mites — sneezing and rhinorrhea' },
    history: 'Clear watery rhinorrhea and morning sneezing without fever.',
    findings: 'Pale boggy nasal turbinates; clear tympanic membranes and oropharynx.',
    assessment: 'Intermittent allergic rhinitis.',
    plan: 'Prescribe second-generation oral antihistamine and nasal saline rinse.',
    vitals: { systolic: '120', diastolic: '78', pulse: '73', temperature: '36.5', respiratoryRate: '17', oxygen: '99', weight: '72.0', height: '171' },
  },
  {
    name: 'Gianna Kristine Ferrer', dob: '2003-05-02', phone: '0966 876 4423',
    reason: 'University physical fitness certificate',
    allergies: { status: 'none', details: '' },
    history: 'No active complaints; requires medical certificate for university internship.',
    findings: 'Normal systemic examination, clear chest and normal heart tones.',
    assessment: 'Clinically fit for university training.',
    plan: 'Issued signed consultation clearance and advised routine annual check-up.',
    vitals: { systolic: '104', diastolic: '66', pulse: '70', temperature: '36.5', respiratoryRate: '16', oxygen: '99', weight: '50.0', height: '157' },
  },
  {
    name: 'Arturo Bonifacio Magbanua', dob: '1966-10-21', phone: '0967 987 5524',
    reason: 'Mild acid reflux after dinner',
    allergies: { status: 'none', details: '' },
    history: 'Epigastric burning sensation after spicy meals; no melena or dysphagia.',
    findings: 'Mild epigastric tenderness without rebound or guarding.',
    assessment: 'Uncomplicated gastroesophageal reflux disease.',
    plan: 'Start omeprazole 20mg pre-breakfast for 14 days and elevate head of bed.',
    vitals: { systolic: '126', diastolic: '80', pulse: '74', temperature: '36.6', respiratoryRate: '18', oxygen: '98', weight: '73.5', height: '167' },
  },
  {
    name: 'Rochelle Anne Corpuz', dob: '1993-03-11', phone: '0975 198 6625',
    reason: 'Dry cough recovery check-up',
    allergies: { status: 'none', details: '' },
    history: 'Post-viral dry cough resolving after 10 days; afebrile throughout.',
    findings: 'Bilateral breath sounds clear without wheezes or crackles.',
    assessment: 'Post-infectious airway hypersensitivity, resolving.',
    plan: 'Continue warm fluids and throat lozenges; return if fever develops.',
    vitals: { systolic: '112', diastolic: '72', pulse: '76', temperature: '36.6', respiratoryRate: '18', oxygen: '99', weight: '55.0', height: '158' },
  },
  {
    name: 'Nathaniel David Macaraeg', dob: '1984-07-29', phone: '0977 209 7726',
    reason: 'Right ankle mild sprain follow-up',
    allergies: { status: 'none', details: '' },
    history: 'Twisted right ankle jogging 5 days ago; swelling significantly reduced.',
    findings: 'Minimal lateral malleolar tenderness; able to bear full weight.',
    assessment: 'Resolving Grade I lateral ankle sprain.',
    plan: 'Continue elastic ankle support during walking and gradual range-of-motion stretches.',
    vitals: { systolic: '122', diastolic: '76', pulse: '68', temperature: '36.5', respiratoryRate: '16', oxygen: '99', weight: '74.8', height: '174' },
  },
  {
    name: 'Valerie Jean Caballes', dob: '1995-11-17', phone: '0981 312 8827',
    reason: 'Scheduled check-in for persistent sore throat',
    allergies: { status: 'none', details: '' },
    history: 'Sore throat for 3 days with mild swallowing discomfort.',
    findings: 'Awaiting physician evaluation.',
    assessment: 'Pending doctor consultation.',
    plan: 'Pending doctor consultation.',
    vitals: { systolic: '112', diastolic: '72', pulse: '78', temperature: '37.2', respiratoryRate: '18', oxygen: '99', weight: '54.0', height: '159' },
  },
  {
    name: 'Jericho Miguel Manalo', dob: '1987-08-06', phone: '0985 423 9928',
    reason: 'Blood pressure monitoring visit',
    allergies: { status: 'none', details: '' },
    history: 'Requested routine BP recheck after starting low-salt diet.',
    findings: 'Awaiting physician evaluation.',
    assessment: 'Pending doctor consultation.',
    plan: 'Pending doctor consultation.',
    vitals: { systolic: '128', diastolic: '82', pulse: '74', temperature: '36.6', respiratoryRate: '18', oxygen: '98', weight: '77.0', height: '172' },
  },
  {
    name: 'Samantha Nicole Alonzo', dob: '2000-12-24', phone: '0989 534 1029',
    reason: 'Intermittent migraine evaluation',
    allergies: { status: 'none', details: '' },
    history: 'Throbbing unilateral headache triggered by sleep deprivation.',
    findings: 'Awaiting physician evaluation.',
    assessment: 'Pending doctor consultation.',
    plan: 'Pending doctor consultation.',
    vitals: { systolic: '108', diastolic: '68', pulse: '76', temperature: '36.5', respiratoryRate: '17', oxygen: '99', weight: '52.0', height: '160' },
  },
  {
    name: 'Rodolfo Lazaro Bernardo', dob: '1968-01-13', phone: '0991 645 2130',
    reason: 'Medication refill and annual check-up',
    allergies: { status: 'recorded', details: 'Iodine contrast — mild nausea' },
    history: 'Routine maintenance refill check.',
    findings: 'Awaiting physician evaluation.',
    assessment: 'Pending doctor consultation.',
    plan: 'Pending doctor consultation.',
    vitals: { systolic: '130', diastolic: '82', pulse: '72', temperature: '36.5', respiratoryRate: '17', oxygen: '98', weight: '71.0', height: '166' },
  },
  {
    name: 'Marisol Guinto Pangilinan', dob: '1974-05-07', phone: '0992 756 3231',
    reason: 'Mild knee stiffness and laboratory consultation',
    allergies: { status: 'none', details: '' },
    history: 'Morning stiffness in left knee lasting less than 15 minutes.',
    findings: 'Awaiting physician evaluation.',
    assessment: 'Pending doctor consultation.',
    plan: 'Pending doctor consultation.',
    vitals: { systolic: '122', diastolic: '78', pulse: '75', temperature: '36.6', respiratoryRate: '18', oxygen: '99', weight: '62.5', height: '158' },
  },
  {
    name: 'Christian Jade Morales', dob: '1992-02-14', phone: '0993 867 4332',
    reason: 'Fatigue and fasting glucose consultation',
    allergies: { status: 'none', details: '' },
    history: 'Reports sluggishness mid-morning; ordered fasting blood glucose.',
    findings: 'Normal resting pulse, alert and oriented.',
    assessment: 'Evaluate blood sugar levels.',
    plan: 'Pending Blood glucose laboratory report.',
    vitals: { systolic: '118', diastolic: '76', pulse: '74', temperature: '36.6', respiratoryRate: '17', oxygen: '99', weight: '70.0', height: '170' },
  },
  {
    name: 'Arlene Joy Sarmiento', dob: '1982-09-30', phone: '0994 978 5433',
    reason: 'Suspected anemia workup',
    allergies: { status: 'none', details: '' },
    history: 'Complains of mild exertional dyspnea and dizziness when standing.',
    findings: 'Conjunctiva mildly pale; regular cardiac sounds.',
    assessment: 'Rule out anemia.',
    plan: 'Pending Complete blood count results.',
    vitals: { systolic: '110', diastolic: '70', pulse: '84', temperature: '36.7', respiratoryRate: '18', oxygen: '98', weight: '56.5', height: '158' },
  },
  {
    name: 'Leonardo Del Rosario Cruz', dob: '1962-06-03', phone: '0995 189 6534',
    reason: 'Routine cholesterol and vascular check',
    allergies: { status: 'none', details: '' },
    history: 'High dietary cholesterol risk; undergoing lipid profile.',
    findings: 'Regular rhythm, no carotid bruit.',
    assessment: 'Dyslipidemia screening.',
    plan: 'Pending Lipid panel results.',
    vitals: { systolic: '132', diastolic: '84', pulse: '71', temperature: '36.5', respiratoryRate: '17', oxygen: '98', weight: '72.0', height: '167' },
  },
  {
    name: 'Bianca Denise Alcaraz', dob: '1998-04-20', phone: '0995 628 4135',
    reason: 'Mild urinary discomfort',
    allergies: { status: 'none', details: '' },
    history: 'Increased urinary frequency since yesterday.',
    findings: 'Mild lower abdominal sensitivity.',
    assessment: 'Rule out urinary tract infection.',
    plan: 'Pending Urinalysis completion in Laboratory.',
    vitals: { systolic: '110', diastolic: '72', pulse: '79', temperature: '37.0', respiratoryRate: '18', oxygen: '99', weight: '53.0', height: '159' },
  },
];

type LabTemplateSpec = {
  testName: string;
  layout: string;
  specimen: string;
  value: string;
  unit: string;
  measurements: Measurement[];
  comment: string;
  doctorPlan: string;
};

const LAB_TEMPLATE_ROTATION: LabTemplateSpec[] = [
  {
    testName: 'Blood glucose', layout: 'glucose', specimen: 'Serum', value: '94', unit: 'mg/dL',
    measurements: [{ name: 'Blood glucose', result: '94', unit: 'mg/dL', reference: '70-99', flag: '' }],
    comment: 'Fasting specimen verified; sample non-hemolyzed.',
    doctorPlan: 'Fasting glucose is within normal reference limits. Maintain balanced diet and routine follow-up.',
  },
  {
    testName: 'Complete blood count', layout: 'cbc', specimen: 'Whole blood', value: '', unit: '',
    measurements: [
      { name: 'Hemoglobin', result: '13.4', unit: 'g/dL', reference: '12.0-16.0', flag: '' },
      { name: 'Hematocrit', result: '40.2', unit: '%', reference: '36.0-48.0', flag: '' },
      { name: 'Red blood cells', result: '4.6', unit: '10^12/L', reference: '4.1-5.4', flag: '' },
      { name: 'White blood cells', result: '7.1', unit: '10^9/L', reference: '4.0-11.0', flag: '' },
      { name: 'Platelets', result: '245', unit: '10^9/L', reference: '150-450', flag: '' },
    ],
    comment: 'Automated hematology analyzer verified with manual differential review.',
    doctorPlan: 'All hematology indices are normal. Reassured patient and advised adequate hydration.',
  },
  {
    testName: 'Urinalysis', layout: 'urinalysis', specimen: 'Urine', value: '', unit: '',
    measurements: [
      { name: 'Color', result: 'Yellow', unit: 'Not applicable', reference: 'Straw to yellow', flag: '' },
      { name: 'Appearance', result: 'Slightly cloudy', unit: 'Not applicable', reference: 'Clear', flag: 'abnormal' },
      { name: 'Specific gravity', result: '1.018', unit: 'Not applicable', reference: '1.005-1.030', flag: '' },
      { name: 'pH', result: '6.0', unit: 'Not applicable', reference: '4.5-8.0', flag: '' },
      { name: 'Protein', result: 'Negative', unit: 'Not applicable', reference: 'Negative', flag: '' },
      { name: 'Glucose', result: 'Negative', unit: 'Not applicable', reference: 'Negative', flag: '' },
      { name: 'White blood cells', result: '12', unit: '/hpf', reference: '0-5', flag: 'high' },
      { name: 'Red blood cells', result: '1', unit: '/hpf', reference: '0-3', flag: '' },
    ],
    comment: 'Microscopic sediment evaluated at 40x objective.',
    doctorPlan: 'Elevated urinary leukocytes consistent with mild UTI. Advised full hydration and follow-up if persistent.',
  },
  {
    testName: 'Lipid panel', layout: 'lipid', specimen: 'Serum', value: '', unit: '',
    measurements: [
      { name: 'Total cholesterol', result: '214', unit: 'mg/dL', reference: '<200', flag: 'high' },
      { name: 'Triglycerides', result: '142', unit: 'mg/dL', reference: '<150', flag: '' },
      { name: 'HDL cholesterol', result: '46', unit: 'mg/dL', reference: '>40', flag: '' },
      { name: 'LDL cholesterol', result: '139', unit: 'mg/dL', reference: '<100', flag: 'high' },
    ],
    comment: '10-hour fasting sample confirmed with patient.',
    doctorPlan: 'Mildly elevated LDL and total cholesterol. Initiated heart-healthy dietary plan and 3-month repeat check.',
  },
  {
    testName: 'Hemoglobin A1c', layout: 'hba1c', specimen: 'Whole blood', value: '6.1', unit: '%',
    measurements: [{ name: 'Hemoglobin A1c', result: '6.1', unit: '%', reference: '<5.7', flag: 'high' }],
    comment: 'NGSP-certified HPLC assay.',
    doctorPlan: 'HbA1c in prediabetes/controlled range. Reinforced daily walking and reduced refined sugar intake.',
  },
  {
    testName: 'Creatinine', layout: 'creatinine', specimen: 'Serum', value: '0.9', unit: 'mg/dL',
    measurements: [{ name: 'Creatinine', result: '0.9', unit: 'mg/dL', reference: '0.6-1.3', flag: '' }],
    comment: 'Enzymatic kinetic method calibrated.',
    doctorPlan: 'Normal serum creatinine and preserved renal clearance. Safe to proceed with current care plan.',
  },
  {
    testName: 'Blood urea nitrogen', layout: 'bun', specimen: 'Serum', value: '14', unit: 'mg/dL',
    measurements: [{ name: 'Blood urea nitrogen', result: '14', unit: 'mg/dL', reference: '7-20', flag: '' }],
    comment: 'Clean serum sample processed without hemolysis.',
    doctorPlan: 'BUN is well within normal range; hydration and renal function remain stable.',
  },
];

const DEFAULT_SERVICE_PRICES_CENTS: Record<string, number> = {
  'consultation': 50000,
  'blood glucose': 18000,
  'complete blood count': 32000,
  'urinalysis': 15000,
  'lipid panel': 65000,
  'hemoglobin a1c': 55000,
  'creatinine': 22000,
  'blood urea nitrogen': 22000,
};

function dayOffset(daysAgo: number): string {
  const today = clinicDay();
  const base = new Date(`${today}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - daysAgo);
  return base.toISOString().slice(0, 10);
}

function isoOnDay(dateStr: string, hourTaipei: number, minute: number): string {
  const hh = String(hourTaipei).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const target = Date.parse(`${dateStr}T${hh}:${mm}:00+08:00`);
  const safeCeiling = Date.now() - 5 * 60_000;
  return new Date(Math.min(target, safeCeiling)).toISOString();
}

function pickActor(staff: Staff[], role: Staff['role'], fallback: Staff): Staff {
  return staff.find(account => account.active && account.role === role) || fallback;
}

function buildDataset(user: Staff, staff: Staff[], prices: Awaited<ReturnType<typeof readPriceList>>) {
  const doctors = staff.filter(account => account.active && account.role === 'doctor');
  if (!doctors.length) {
    throw new AppError('Add at least one active doctor account before loading presentation sample data.', 422);
  }
  const regStaff = pickActor(staff, 'registration', user);
  const labStaff = pickActor(staff, 'laboratory', user);
  const billingStaff = pickActor(staff, 'billing', user);
  const reviewerStaff = pickActor(staff, 'reviewer', user);
  const today = dayOffset(0);
  const priceCreatedAt = isoOnDay(dayOffset(25), 9, 0);

  const patients = PATIENT_SPECS.map((spec, index) => {
    const id = DEMO_PATIENT_IDS[index];
    const doctor = index % 3 === 1 && doctors.length > 1 ? doctors[1] : doctors[0];
    // Spread updatedAt cleanly across recent days; validate through domain sanitizers.
    const dob = spec.dob;
    const phone = spec.phone.replace(/[ -]/g, '');
    cleanClinicPhone(spec.phone);
    identityKey(spec.name);
    nameTokenKey(spec.name);
    return {
      id,
      name: spec.name,
      dob,
      phone,
      doctorId: doctor.id,
      source: 'Presentation sample',
      version: 1,
      updatedAt: index < 26 ? isoOnDay(dayOffset(21 - Math.floor((index * 20) / 25)), 16, 0) : isoOnDay(today, 8, 30),
    };
  });

  const visits: any[] = [];
  const visitWorkflow: any[] = [];
  PATIENT_SPECS.forEach((spec, index) => {
    const visitId = DEMO_VISIT_IDS[index];
    const patient = patients[index];
    if (index < 26) {
      const daysAgo = Math.max(1, 20 - Math.floor((index * 19) / 25));
      const date = dayOffset(daysAgo);
      const checkedInAt = isoOnDay(date, 9, 10);
      const signedAt = isoOnDay(date, 15, 20);
      const clinical = cleanClinical({
        allergyStatus: spec.allergies.status,
        allergies: spec.allergies.details,
        history: spec.history,
        medicines: 'No acute contraindications reported.',
        findings: spec.findings,
        assessment: spec.assessment,
        plan: spec.plan,
        vitals: spec.vitals,
      }, true);
      visits.push({
        id: visitId,
        patientId: patient.id,
        doctorId: patient.doctorId,
        date,
        reason: spec.reason,
        notes: `${spec.assessment} ${spec.plan}`,
        clinical,
        status: 'signed',
        signedAt,
        history: [],
        version: 1,
        updatedAt: signedAt,
      });
      visitWorkflow.push({ visitId, checkedInAt, billingReadyAt: signedAt, queueKey: null });
    } else if (index < 31) {
      const waitingOffset = index - 26;
      const checkedInAt = new Date(Date.now() - (45 - waitingOffset * 5) * 60_000).toISOString();
      visits.push({
        id: visitId,
        patientId: patient.id,
        doctorId: patient.doctorId,
        date: today,
        reason: spec.reason,
        notes: '',
        clinical: { structured: true, allergyStatus: 'unknown' },
        status: 'waiting',
        signedAt: null,
        history: [],
        version: 1,
        updatedAt: checkedInAt,
      });
      visitWorkflow.push({ visitId, checkedInAt, billingReadyAt: null, queueKey: patient.id });
    } else {
      const isYesterday = index === 34;
      const date = isYesterday ? dayOffset(1) : today;
      const checkedInAt = isYesterday
        ? isoOnDay(date, 9, 0)
        : new Date(Date.now() - (25 - (index - 31) * 4) * 60_000).toISOString();
      const clinical = cleanClinical({
        allergyStatus: spec.allergies.status,
        allergies: spec.allergies.details,
        history: spec.history,
        medicines: '',
        findings: spec.findings,
        assessment: '',
        plan: '',
        vitals: spec.vitals,
      }, false);
      visits.push({
        id: visitId,
        patientId: patient.id,
        doctorId: patient.doctorId,
        date,
        reason: spec.reason,
        notes: '',
        clinical,
        status: 'draft',
        signedAt: null,
        history: [],
        version: 1,
        updatedAt: checkedInAt,
      });
      visitWorkflow.push({ visitId, checkedInAt, billingReadyAt: null, queueKey: patient.id });
    }
  });

  const labReports: any[] = [];
  // L-DEMO-01 .. L-DEMO-14: Approved, doctor-reviewed, and released to patient portal.
  for (let i = 0; i < 14; i++) {
    const visit = visits[i];
    const doctor = doctors.find(d => d.id === visit.doctorId) || doctors[0];
    const tpl = LAB_TEMPLATE_ROTATION[i % LAB_TEMPLATE_ROTATION.length];
    const collectedAt = isoOnDay(visit.date, 10, 15);
    const approvedAt = isoOnDay(visit.date, 11, 45);
    const reviewedAt = isoOnDay(visit.date, 13, 30);
    const releasedAt = isoOnDay(visit.date, 14, 0);
    const followUpDate = i % 2 === 0 ? dayOffset(-14) : '';
    const followUpTime = i % 2 === 0 ? '09:30' : '';
    const report = {
      id: DEMO_LAB_IDS[i],
      patientId: visit.patientId,
      visitId: visit.id,
      testName: tpl.testName,
      value: tpl.value,
      unit: tpl.unit ? cleanLabUnit(tpl.unit) : '',
      collectedAt,
      status: 'approved',
      requestedBy: visit.doctorId,
      approvedBy: labStaff.id,
      approvedAt,
      history: [],
      sourceRef: `LAB-DEMO-${String(i + 1).padStart(2, '0')}`,
      version: 1,
      updatedAt: releasedAt,
      layout: tpl.layout,
      measurements: tpl.measurements.map(m => ({ ...m })),
      specimen: tpl.specimen,
      reportComment: tpl.comment,
      urgency: 'routine',
      contact: {},
      doctorReview: {
        reportApprovedAt: approvedAt,
        reviewedAt,
        reviewedBy: doctor.name,
        reviewedById: doctor.id,
        plan: tpl.doctorPlan,
        followUpDate,
        followUpTime,
        releasedAt,
        releasedBy: doctor.name,
      },
    };
    if (labProblems(report, visit).length) {
      throw new AppError(`Invalid seeded lab fixture ${report.id}`, 500);
    }
    labReports.push(report);
  }

  // L-DEMO-15 .. L-DEMO-18: Approved and awaiting doctor review (L-DEMO-15 urgent).
  const reviewQueueTemplates = [
    {
      idx: 14, testName: 'Blood glucose', layout: 'glucose', specimen: 'Serum', value: '248', unit: 'mg/dL',
      measurements: [{ name: 'Blood glucose', result: '248', unit: 'mg/dL', reference: '70-99', flag: 'high' }],
      comment: 'Critical hyperglycemia confirmed on repeat analyzer run.', urgency: 'urgent',
    },
    {
      idx: 15, testName: 'Complete blood count', layout: 'cbc', specimen: 'Whole blood', value: '', unit: '',
      measurements: [
        { name: 'Hemoglobin', result: '12.6', unit: 'g/dL', reference: '12.0-16.0', flag: '' },
        { name: 'Hematocrit', result: '38.0', unit: '%', reference: '36.0-48.0', flag: '' },
        { name: 'Red blood cells', result: '4.4', unit: '10^12/L', reference: '4.1-5.4', flag: '' },
        { name: 'White blood cells', result: '6.8', unit: '10^9/L', reference: '4.0-11.0', flag: '' },
        { name: 'Platelets', result: '142', unit: '10^9/L', reference: '150-450', flag: 'low' },
      ],
      comment: 'Mild thrombocytopenia without platelet clumping on smear.', urgency: 'routine',
    },
    {
      idx: 16, testName: 'Lipid panel', layout: 'lipid', specimen: 'Serum', value: '', unit: '',
      measurements: [
        { name: 'Total cholesterol', result: '198', unit: 'mg/dL', reference: '<200', flag: '' },
        { name: 'Triglycerides', result: '128', unit: 'mg/dL', reference: '<150', flag: '' },
        { name: 'HDL cholesterol', result: '52', unit: 'mg/dL', reference: '>40', flag: '' },
        { name: 'LDL cholesterol', result: '120', unit: 'mg/dL', reference: '<100', flag: 'high' },
      ],
      comment: 'Lipid profile improved from prior baseline.', urgency: 'routine',
    },
    {
      idx: 17, testName: 'Hemoglobin A1c', layout: 'hba1c', specimen: 'Whole blood', value: '5.8', unit: '%',
      measurements: [{ name: 'Hemoglobin A1c', result: '5.8', unit: '%', reference: '<5.7', flag: 'high' }],
      comment: 'Borderline prediabetic range; compare with fasting glucose.', urgency: 'routine',
    },
  ];
  for (const item of reviewQueueTemplates) {
    const visit = visits[item.idx];
    const doctor = doctors.find(d => d.id === visit.doctorId) || doctors[0];
    const collectedAt = isoOnDay(visit.date, 10, 0);
    const contactAt = isoOnDay(visit.date, 11, 20);
    const approvedAt = isoOnDay(visit.date, 11, 30);
    const report = {
      id: DEMO_LAB_IDS[item.idx],
      patientId: visit.patientId,
      visitId: visit.id,
      testName: item.testName,
      value: item.value,
      unit: item.unit,
      collectedAt,
      status: 'approved',
      requestedBy: visit.doctorId,
      approvedBy: labStaff.id,
      approvedAt,
      history: [],
      sourceRef: `LAB-DEMO-${String(item.idx + 1).padStart(2, '0')}`,
      version: 1,
      updatedAt: approvedAt,
      layout: item.layout,
      measurements: item.measurements,
      specimen: item.specimen,
      reportComment: item.comment,
      urgency: item.urgency,
      contact: item.urgency === 'urgent' ? { person: doctor.name, method: 'Phone', at: contactAt } : {},
      doctorReview: {},
    };
    if (labProblems(report, visit).length) {
      throw new AppError(`Invalid seeded review-queue lab fixture ${report.id}`, 500);
    }
    labReports.push(report);
  }

  // L-DEMO-19 .. L-DEMO-21: Requested tests waiting for Laboratory.
  const requestedSpecs = [
    { id: 'L-DEMO-19', visitIdx: 31, testName: 'Blood glucose', layout: 'glucose' },
    { id: 'L-DEMO-20', visitIdx: 32, testName: 'Complete blood count', layout: 'cbc' },
    { id: 'L-DEMO-21', visitIdx: 33, testName: 'Lipid panel', layout: 'lipid' },
  ];
  for (let i = 0; i < requestedSpecs.length; i++) {
    const spec = requestedSpecs[i];
    const visit = visits[spec.visitIdx];
    labReports.push({
      id: spec.id,
      patientId: visit.patientId,
      visitId: visit.id,
      testName: spec.testName,
      value: '',
      unit: '',
      collectedAt: '',
      status: 'requested',
      requestedBy: visit.doctorId,
      approvedBy: null,
      approvedAt: null,
      history: [],
      sourceRef: `LAB-DEMO-${String(19 + i).padStart(2, '0')}`,
      version: 1,
      updatedAt: visit.updatedAt,
      layout: spec.layout,
      measurements: [],
      specimen: '',
      reportComment: '',
      urgency: 'routine',
      contact: {},
      doctorReview: {},
    });
  }

  // L-DEMO-22 .. L-DEMO-23: Laboratory drafts in progress.
  const draftVisit35 = visits[34];
  labReports.push({
    id: 'L-DEMO-22',
    patientId: draftVisit35.patientId,
    visitId: draftVisit35.id,
    testName: 'Urinalysis',
    value: '',
    unit: '',
    collectedAt: isoOnDay(draftVisit35.date, 9, 30),
    status: 'draft',
    requestedBy: draftVisit35.doctorId,
    approvedBy: null,
    approvedAt: null,
    history: [],
    sourceRef: 'LAB-DEMO-22',
    version: 1,
    updatedAt: isoOnDay(draftVisit35.date, 10, 0),
    layout: 'urinalysis',
    measurements: [
      { name: 'Color', result: 'Yellow', unit: 'Not applicable', reference: 'Straw to yellow', flag: '' },
      { name: 'Appearance', result: 'Slightly cloudy', unit: 'Not applicable', reference: 'Clear', flag: 'abnormal' },
    ],
    specimen: 'Urine',
    reportComment: 'Microscopic examination pending.',
    urgency: 'routine',
    contact: {},
    doctorReview: {},
  });

  const draftVisit19 = visits[18];
  labReports.push({
    id: 'L-DEMO-23',
    patientId: draftVisit19.patientId,
    visitId: draftVisit19.id,
    testName: 'Creatinine',
    value: '0.88',
    unit: 'mg/dL',
    collectedAt: '',
    status: 'draft',
    requestedBy: draftVisit19.doctorId,
    approvedBy: null,
    approvedAt: null,
    history: [],
    sourceRef: 'LAB-DEMO-23',
    version: 1,
    updatedAt: isoOnDay(draftVisit19.date, 11, 15),
    layout: 'creatinine',
    measurements: [{ name: 'Creatinine', result: '0.88', unit: 'mg/dL', reference: '0.6-1.3', flag: '' }],
    specimen: 'Serum',
    reportComment: 'Awaiting collection timestamp verification.',
    urgency: 'routine',
    contact: {},
    doctorReview: {},
  });

  // L-DEMO-DQ-01: Approved report missing collection time -> populates Reviewer "Approved reports needing a check: 1".
  const dqVisit = visits[19];
  labReports.push({
    id: 'L-DEMO-DQ-01',
    patientId: dqVisit.patientId,
    visitId: dqVisit.id,
    testName: 'Blood glucose',
    value: '108',
    unit: 'mg/dL',
    collectedAt: '',
    status: 'approved',
    requestedBy: dqVisit.doctorId,
    approvedBy: labStaff.id,
    approvedAt: isoOnDay(dqVisit.date, 11, 0),
    history: [],
    sourceRef: 'LAB-DEMO-DQ-01',
    version: 1,
    updatedAt: isoOnDay(dqVisit.date, 11, 0),
    layout: 'glucose',
    measurements: [{ name: 'Blood glucose', result: '108', unit: 'mg/dL', reference: '70-99', flag: 'high' }],
    specimen: 'Serum',
    reportComment: 'Collection timestamp omitted on bench log; held for laboratory check.',
    urgency: 'routine',
    contact: {},
    doctorReview: {},
  });

  // Ensure every quantitative measurement passes labResultError before saving.
  for (const r of labReports) {
    if (Array.isArray(r.measurements)) {
      for (const m of r.measurements as Measurement[]) {
        if (m.result && m.unit && labResultError(m.result, m.unit)) {
          throw new AppError(`Invalid seeded measurement in ${r.id}`, 500);
        }
      }
    }
  }

  // Invoices B-DEMO-01 .. B-DEMO-22 (leaving V-DEMO-23..26 ready under "To bill").
  const resolvePrice = (kind: 'consultation' | 'laboratory', name: string) => {
    const key = serviceNameKey(name);
    const matched = prices.entries.find(entry => entry.active && entry.kind === kind && serviceNameKey(entry.name) === key);
    if (matched) {
      return {
        id: matched.id,
        version: prices.version,
        name: matched.name,
        amount: matched.amount,
        setAt: matched.updatedAt,
        setBy: matched.updatedBy,
      };
    }
    return {
      id: `PRICE-DEMO-${key.replace(/[^a-z0-9]+/g, '-').toUpperCase()}`,
      version: prices.version || 1,
      name,
      amount: DEFAULT_SERVICE_PRICES_CENTS[key] || 25000,
      setAt: priceCreatedAt,
      setBy: user.name,
    };
  };

  const invoices: any[] = [];
  for (let i = 0; i < 22; i++) {
    const visit = visits[i];
    const doctor = doctors.find(d => d.id === visit.doctorId) || doctors[0];
    const billAt = isoOnDay(visit.date, 15, 40);
    const consultPrice = resolvePrice('consultation', 'Consultation');
    const items: any[] = [{
      description: 'Consultation',
      amount: consultPrice.amount,
      source: {
        key: `visit:${visit.id}`,
        kind: 'consultation',
        recordId: visit.id,
        originalRef: visit.id,
        name: 'Consultation',
        completedAt: visit.signedAt,
        completedBy: doctor.name,
      },
      price: consultPrice,
      addedAt: billAt,
      addedBy: billingStaff.name,
    }];

    const visitApprovedLabs = labReports.filter(report =>
      report.visitId === visit.id
      && report.status === 'approved'
      && !labProblems(report, visit).length,
    );
    for (const report of visitApprovedLabs) {
      const labPrice = resolvePrice('laboratory', report.testName);
      items.push({
        description: report.testName,
        amount: labPrice.amount,
        source: {
          key: `lab:${report.id}`,
          kind: 'laboratory',
          recordId: report.id,
          originalRef: report.sourceRef,
          name: report.testName,
          completedAt: report.approvedAt,
          completedBy: labStaff.name,
        },
        price: labPrice,
        addedAt: billAt,
        addedBy: billingStaff.name,
      });
    }

    const total = items.reduce((sum, item) => sum + item.amount, 0);
    let paid = 0;
    const payments: any[] = [];
    if (i < 14) {
      paid = total;
      const methods = ['Cash', 'Card', 'Bank transfer'] as const;
      const method = methods[i % methods.length];
      payments.push({
        id: `PAY-DEMO-${String(i + 1).padStart(2, '0')}`,
        amount: total,
        method,
        reference: method === 'Cash' ? 'OR-2026-' + String(1001 + i) : method === 'Card' ? `CARD-2026-${101 + i}` : `BPI-2026-${201 + i}`,
        by: billingStaff.name,
        at: isoOnDay(visit.date, 16, 5),
      });
    } else if (i < 18) {
      paid = Math.min(30000, Math.max(10000, total - 10000));
      payments.push({
        id: `PAY-DEMO-${String(i + 1).padStart(2, '0')}`,
        amount: paid,
        method: 'Cash',
        reference: 'PARTIAL-OR-' + String(1101 + i),
        by: billingStaff.name,
        at: isoOnDay(visit.date, 16, 15),
      });
    }

    invoices.push({
      id: DEMO_INVOICE_IDS[i],
      patientId: visit.patientId,
      visitId: visit.id,
      date: visit.date,
      items,
      total,
      paid,
      payments,
      sourceRef: `BILL-DEMO-${String(i + 1).padStart(2, '0')}`,
      version: 1,
      updatedAt: payments.length ? payments[0].at : billAt,
    });
  }

  // Held/resolved external imports & QualityReview items so Reviewer sees live exceptions.
  const camilleVisit = visits[2];
  const sourceImports = [
    {
      id: DEMO_IMPORT_IDS[0],
      source: 'laboratory',
      externalId: 'EXT-LAB-2041',
      payload: {
        externalId: 'EXT-LAB-2041',
        patientId: 'P-DEMO-03',
        patientName: 'Camille Torres',
        patientDob: '1994-08-18',
        visitId: 'V-DEMO-03',
        testName: 'Blood glucose',
        value: '112',
        unit: 'mg/dL',
        collectedAt: isoOnDay(camilleVisit.date, 9, 45),
      },
      state: 'held',
      linkedPatientId: null,
      receivedAt: isoOnDay(camilleVisit.date, 12, 0),
    },
    {
      id: DEMO_IMPORT_IDS[1],
      source: 'laboratory',
      externalId: 'EXT-LAB-2042',
      payload: {
        externalId: 'EXT-LAB-2042',
        patientId: 'P-EXT-9921',
        patientName: 'Rafael Aquino',
        patientDob: '1985-03-11',
        visitId: 'V-EXT-9921',
        testName: 'Creatinine',
        value: '1.1',
        unit: 'mg/dL',
        collectedAt: isoOnDay(dayOffset(2), 10, 30),
      },
      state: 'held',
      linkedPatientId: null,
      receivedAt: isoOnDay(dayOffset(2), 13, 0),
    },
    {
      id: DEMO_IMPORT_IDS[2],
      source: 'laboratory',
      externalId: 'EXT-LAB-2039',
      payload: {
        externalId: 'EXT-LAB-2039',
        patientId: 'P-EXT-8810',
        patientName: 'Lourdes Mendoza',
        patientDob: '1977-04-02',
        visitId: 'V-EXT-8810',
        testName: 'Urinalysis',
        value: 'Negative',
        unit: 'Not applicable',
        collectedAt: isoOnDay(dayOffset(5), 11, 0),
      },
      state: 'kept-separate',
      linkedPatientId: null,
      receivedAt: isoOnDay(dayOffset(5), 12, 10),
    },
  ];

  const qualityReviews = [
    {
      id: DEMO_REVIEW_IDS[0],
      kind: 'identity',
      patientId: 'P-DEMO-03',
      recordId: DEMO_IMPORT_IDS[0],
      title: 'Confirm the source patient',
      detail: 'Laboratory source EXT-LAB-2041 could not be safely matched. Check the patient number, name, birth date and visit.',
      ownerRole: 'registration',
      state: 'open',
      resolution: null,
      evidence: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: isoOnDay(camilleVisit.date, 12, 0),
    },
    {
      id: DEMO_REVIEW_IDS[1],
      kind: 'identity',
      patientId: null,
      recordId: DEMO_IMPORT_IDS[1],
      title: 'Confirm the source patient',
      detail: 'Laboratory source EXT-LAB-2042 could not be safely matched. Check the patient number, name, birth date and visit.',
      ownerRole: 'registration',
      state: 'open',
      resolution: null,
      evidence: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: isoOnDay(dayOffset(2), 13, 0),
    },
    {
      id: DEMO_REVIEW_IDS[2],
      kind: 'identity',
      patientId: null,
      recordId: DEMO_IMPORT_IDS[2],
      title: 'Confirm the source patient',
      detail: 'Laboratory source EXT-LAB-2039 could not be safely matched. Check the patient number, name, birth date and visit.',
      ownerRole: 'registration',
      state: 'resolved',
      resolution: 'Kept separate after identity review.',
      evidence: 'Confirmed with front desk that the external file birth date belonged to another clinic branch patient.',
      resolvedBy: reviewerStaff.name,
      resolvedAt: isoOnDay(dayOffset(4), 10, 0),
      createdAt: isoOnDay(dayOffset(5), 12, 10),
    },
  ];

  const primaryDoctor = doctors[0];
  const activityHistory = [
    { id: DEMO_AUDIT_IDS[0], at: isoOnDay(dayOffset(20), 8, 50), userId: regStaff.id, actor: regStaff.name, role: regStaff.role, action: 'Registered patient', entityType: 'patient', entityId: 'P-DEMO-01', patientId: 'P-DEMO-01', detail: 'Identity fields checked and permanent patient number assigned.' },
    { id: DEMO_AUDIT_IDS[1], at: isoOnDay(dayOffset(20), 15, 20), userId: primaryDoctor.id, actor: primaryDoctor.name, role: 'doctor', action: 'Signed consultation', entityType: 'visit', entityId: 'V-DEMO-01', patientId: 'P-DEMO-01', detail: 'Consultation content saved by its responsible doctor.' },
    { id: DEMO_AUDIT_IDS[2], at: isoOnDay(dayOffset(20), 11, 45), userId: labStaff.id, actor: labStaff.name, role: labStaff.role, action: 'Approved laboratory report', entityType: 'lab', entityId: 'L-DEMO-01', patientId: 'P-DEMO-01', detail: 'Required details checked; laboratory report approved with standard UCUM units.' },
    { id: DEMO_AUDIT_IDS[3], at: isoOnDay(dayOffset(20), 14, 0), userId: primaryDoctor.id, actor: primaryDoctor.name, role: 'doctor', action: 'Released laboratory report to patient', entityType: 'lab', entityId: 'L-DEMO-01', patientId: 'P-DEMO-01', detail: 'Assigned doctor released the reviewed report to the patient portal.' },
    { id: DEMO_AUDIT_IDS[4], at: isoOnDay(dayOffset(20), 16, 5), userId: billingStaff.id, actor: billingStaff.name, role: billingStaff.role, action: 'Recorded payment', entityType: 'invoice', entityId: 'B-DEMO-01', patientId: 'P-DEMO-01', detail: 'Payment received against approved clinic fees.' },
    { id: DEMO_AUDIT_IDS[5], at: isoOnDay(camilleVisit.date, 12, 0), userId: labStaff.id, actor: labStaff.name, role: labStaff.role, action: 'Held source record for checking', entityType: 'import', entityId: 'EXT-LAB-2041', patientId: 'P-DEMO-03', detail: 'Identity or visit details did not match. Held in Record checks queue.' },
    { id: DEMO_AUDIT_IDS[6], at: isoOnDay(dayOffset(4), 10, 0), userId: reviewerStaff.id, actor: reviewerStaff.name, role: reviewerStaff.role, action: 'Resolved identity review', entityType: 'review', entityId: 'Q-DEMO-03', patientId: null, detail: 'keep-separate: Confirmed external branch patient identity mismatch.' },
    { id: DEMO_AUDIT_IDS[7], at: isoOnDay(dayOffset(2), 11, 0), userId: labStaff.id, actor: labStaff.name, role: labStaff.role, action: 'Approved laboratory report', entityType: 'lab', entityId: 'L-DEMO-DQ-01', patientId: 'P-DEMO-20', detail: 'Report L-DEMO-DQ-01 approved without sample collection timestamp; flagged for Record checks.' },
    { id: DEMO_AUDIT_IDS[8], at: isoOnDay(dayOffset(2), 13, 0), userId: labStaff.id, actor: labStaff.name, role: labStaff.role, action: 'Held source record for checking', entityType: 'import', entityId: 'EXT-LAB-2042', patientId: null, detail: 'Unrecognized patient number P-EXT-9921 held in Record checks.' },
    { id: DEMO_AUDIT_IDS[9], at: isoOnDay(dayOffset(6), 11, 30), userId: labStaff.id, actor: labStaff.name, role: labStaff.role, action: 'Approved laboratory report', entityType: 'lab', entityId: 'L-DEMO-15', patientId: 'P-DEMO-15', detail: 'Urgent blood glucose result (248 mg/dL) communicated by phone to attending doctor.' },
    { id: DEMO_AUDIT_IDS[10], at: isoOnDay(dayOffset(1), 9, 0), userId: regStaff.id, actor: regStaff.name, role: regStaff.role, action: 'Checked in patient', entityType: 'visit', entityId: 'V-DEMO-35', patientId: 'P-DEMO-35', detail: 'Patient checked in and assigned for urinary evaluation.' },
    { id: DEMO_AUDIT_IDS[11], at: new Date(Date.now() - 10 * 60_000).toISOString(), userId: regStaff.id, actor: regStaff.name, role: regStaff.role, action: 'Checked in patient', entityType: 'visit', entityId: 'V-DEMO-27', patientId: 'P-DEMO-27', detail: 'Today walk-in patient checked in for consultation.' },
  ];

  return { patients, visits, visitWorkflow, labReports, invoices, sourceImports, qualityReviews, activityHistory, reviewerStaff };
}

async function missingIds<T>(
  store: ClinicRepository,
  table: Parameters<ClinicRepository['find']>[0],
  field: string,
  ids: string[],
  rows: T[],
  keyOf: (row: T) => string,
): Promise<T[]> {
  if (!rows.length || !ids.length) return [];
  const existing = await store.find(table, oneOf(field, ids));
  const present = new Set(existing.map((row: any) => String(row[field])));
  return rows.filter(row => !present.has(keyOf(row)));
}

export async function seedPresentationData(user: Staff) {
  const [staff, prices] = await Promise.all([
    repository.find('staffAccounts'),
    readPriceList(),
  ]);
  const dataset = buildDataset(user, staff as Staff[], prices);

  await repository.transaction(async store => {
    const newPatients = await missingIds(store, 'patients', 'id', DEMO_PATIENT_IDS, dataset.patients, r => r.id);
    const newVisits = await missingIds(store, 'visits', 'id', DEMO_VISIT_IDS, dataset.visits, r => r.id);
    const newWorkflows = await missingIds(store, 'visitWorkflow', 'visitId', DEMO_VISIT_IDS, dataset.visitWorkflow, r => r.visitId);
    const newLabs = await missingIds(store, 'labReports', 'id', DEMO_LAB_IDS, dataset.labReports, r => r.id);
    const newInvoices = await missingIds(store, 'invoices', 'id', DEMO_INVOICE_IDS, dataset.invoices, r => r.id);
    const newImports = await missingIds(store, 'sourceImports', 'id', DEMO_IMPORT_IDS, dataset.sourceImports, r => r.id);
    const newReviews = await missingIds(store, 'qualityReviews', 'id', DEMO_REVIEW_IDS, dataset.qualityReviews, r => r.id);
    const newAudits = await missingIds(store, 'activityHistory', 'id', DEMO_AUDIT_IDS, dataset.activityHistory, r => r.id);

    const inserts: any[] = [];
    if (newPatients.length) inserts.push(store.insert('patients', newPatients, { ignore: true }));
    if (newVisits.length) inserts.push(store.insert('visits', newVisits, { ignore: true }));
    if (newWorkflows.length) inserts.push(store.insert('visitWorkflow', newWorkflows, { ignore: true }));
    if (newLabs.length) inserts.push(store.insert('labReports', newLabs, { ignore: true }));
    if (newInvoices.length) inserts.push(store.insert('invoices', newInvoices, { ignore: true }));
    if (newImports.length) inserts.push(store.insert('sourceImports', newImports, { ignore: true }));
    if (newReviews.length) inserts.push(store.insert('qualityReviews', newReviews, { ignore: true }));
    if (newAudits.length) inserts.push(store.insert('activityHistory', newAudits, { ignore: true }));
    if (newPatients.length) {
      inserts.push(store.insert('activityHistory', auditRow(
        user,
        'Loaded presentation sample data',
        'warehouse',
        'DEMO',
        `Loaded ${newPatients.length} sample patients with consultations, UCUM laboratory reports, bills, Record checks, and warehouse metrics.`,
      )));
    }
    if (inserts.length) await store.batch(inserts);
  }, { lock: 20261109 });

  const warehouse = await refreshWarehouse(dataset.reviewerStaff);
  const [patients, visits, labs, invoices, reviews] = await Promise.all([
    repository.find('patients', oneOf('id', DEMO_PATIENT_IDS)),
    repository.find('visits', oneOf('patientId', DEMO_PATIENT_IDS)),
    repository.find('labReports', oneOf('patientId', DEMO_PATIENT_IDS)),
    repository.find('invoices', oneOf('patientId', DEMO_PATIENT_IDS)),
    repository.find('qualityReviews', oneOf('id', DEMO_REVIEW_IDS)),
  ]);
  return {
    seeded: patients.length > 0,
    counts: {
      patients: patients.length,
      visits: visits.length,
      labs: labs.length,
      invoices: invoices.length,
      reviews: reviews.length,
      facts: warehouse.count,
    },
  };
}

export async function clearPresentationData(user: Staff) {
  const staff = await repository.find('staffAccounts');
  const reviewerStaff = pickActor(staff as Staff[], 'reviewer', user);

  await repository.transaction(async store => {
    const demoVisits = await store.find('visits', oneOf('patientId', DEMO_PATIENT_IDS));
    const demoVisitIds = demoVisits.map(visit => visit.id);
    const reviewEntities = [...DEMO_REVIEW_IDS, 'L-DEMO-DQ-01'];

    const deletions: any[] = [
      store.remove('staffNotifications', oneOf('patientId', DEMO_PATIENT_IDS)),
      store.remove('staffNotifications', oneOf('entityId', reviewEntities)),
      store.remove('patientPortalSessions', oneOf('patientId', DEMO_PATIENT_IDS)),
      store.remove('patientPortalAccounts', oneOf('patientId', DEMO_PATIENT_IDS)),
      store.remove('qualityReviews', oneOf('id', DEMO_REVIEW_IDS)),
      store.remove('qualityReviews', oneOf('patientId', DEMO_PATIENT_IDS)),
      store.remove('sourceImports', oneOf('id', DEMO_IMPORT_IDS)),
      store.remove('sourceImports', oneOf('linkedPatientId', DEMO_PATIENT_IDS)),
      store.remove('invoices', oneOf('patientId', DEMO_PATIENT_IDS)),
      store.remove('labReports', oneOf('patientId', DEMO_PATIENT_IDS)),
    ];
    if (demoVisitIds.length) {
      deletions.push(store.remove('visitWorkflow', oneOf('visitId', demoVisitIds)));
    }
    deletions.push(
      store.remove('visits', oneOf('patientId', DEMO_PATIENT_IDS)),
      store.remove('patients', oneOf('id', DEMO_PATIENT_IDS)),
      store.remove('activityHistory', oneOf('id', DEMO_AUDIT_IDS)),
      store.remove('activityHistory', oneOf('patientId', DEMO_PATIENT_IDS)),
      store.insert('activityHistory', auditRow(
        user,
        'Removed presentation sample data',
        'warehouse',
        'DEMO',
        'Removed presentation sample records while retaining clinic staff accounts and manually recorded patient records.',
      )),
    );
    await store.batch(deletions);
  }, { lock: 20261109 });

  await refreshWarehouse(reviewerStaff);
  return {
    seeded: false,
    counts: { patients: 0, visits: 0, labs: 0, invoices: 0, reviews: 0 },
  };
}

export async function getPresentationSeedStatus() {
  const [patients, visits, labs, invoices, reviews] = await Promise.all([
    repository.find('patients', oneOf('id', DEMO_PATIENT_IDS)),
    repository.find('visits', oneOf('patientId', DEMO_PATIENT_IDS)),
    repository.find('labReports', oneOf('patientId', DEMO_PATIENT_IDS)),
    repository.find('invoices', oneOf('patientId', DEMO_PATIENT_IDS)),
    repository.find('qualityReviews', oneOf('id', DEMO_REVIEW_IDS)),
  ]);
  return {
    seeded: patients.length > 0,
    counts: {
      patients: patients.length,
      visits: visits.length,
      labs: labs.length,
      invoices: invoices.length,
      reviews: reviews.length,
    },
  };
}

export async function presentationSeedService(context: ServiceContext) {
  const { request, user, input } = context;
  assertRole(user, ['manager']);
  if (request.method === 'GET') {
    return result(await getPresentationSeedStatus());
  }
  const action = cleanText(input.action, 'Presentation sample action', 20);
  if (!['seed', 'clear'].includes(action)) {
    throw new AppError('Choose to load or remove presentation sample data.', 422);
  }
  if (action === 'seed') {
    return result(await seedPresentationData(user));
  }
  return result(await clearPresentationData(user));
}
