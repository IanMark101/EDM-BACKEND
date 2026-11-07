import { createHash } from 'node:crypto';
import { AppError, assertRole, cleanText, labProblems } from '../../../shared/domain';
import type { ServiceContext } from '../http/context';
import { result } from '../http/result';
import { allOf, match, oneOf, repository, type ClinicRepository } from '../repositories/clinic.repository';
import { constantEqual, digest, hashPassword, randomToken, sessionExpired, SESSION_MS } from './security';
import { auditRow, now } from './server';

const cookieName = 'carerecord_patient';
const codeLifetime = 24 * 60 * 60_000;
const credentialsError = 'Check your patient number and password. If needed, ask Registration for a new setup code.';
const expiredError = 'Your patient session ended. Sign in again.';
const validToken = /^[a-f0-9]{64}$/;
const patientKey = (value: unknown) => cleanText(value, 'Patient number', 80).toUpperCase();
const patientLock = (patientId: string) => -1 - (createHash('sha256').update(patientId).digest().readUInt32BE() & 0x3fffffff);
const accountFor = async (patientId: string, store: ClinicRepository = repository) => (await store.find('patientPortalAccounts', match('patientId', patientId)))[0];
const patientFor = async (patientId: string, store: ClinicRepository = repository) => (await store.find('patients', match('id', patientId)))[0];

function cookie(request: Request, token: string) {
  return `${cookieName}=${token}; Path=/api/patient-portal; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_MS / 1000 : 0}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

function tokenFrom(request: Request) {
  return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
}

function accountStatus(account: Awaited<ReturnType<typeof accountFor>> | undefined) {
  if (account?.passwordHash) return 'active';
  if (account?.activationHash && account.activationExpiresAt) return Date.parse(account.activationExpiresAt) > Date.now() ? 'pending' : 'expired';
  return 'off';
}

export async function patientAccessService({ user, id, request, input }: ServiceContext) {
  assertRole(user, ['registration']);
  const patientId = patientKey(id);
  if (!await patientFor(patientId)) throw new AppError('This patient record was not found.', 404);
  if (request.method === 'GET') {
    const account = await accountFor(patientId);
    return result({ status: accountStatus(account), expiresAt: account?.activationExpiresAt });
  }
  if (input.verified !== true) throw new AppError('Confirm that you checked the patient’s identity.', 422);
  if (!['issue', 'disable'].includes(input.action)) throw new AppError('Choose a patient access action.', 422);
  const reason = cleanText(input.reason || '', 'Reason', 500, false);
  const data = await repository.transaction(async store => {
    const account = await accountFor(patientId, store);
    if (input.action === 'disable') {
      if (!account) return { status: 'off' };
      if (reason.length < 12) throw new AppError('Enter a reason of at least 12 characters.', 422);
      await store.batch([
        store.remove('patientPortalSessions', match('patientId', patientId)),
        store.remove('patientPortalAccounts', match('patientId', patientId)),
        store.insert('activityHistory', auditRow(user, 'Disabled patient portal access', 'patient', patientId, reason, patientId)),
      ]);
      return { status: 'off' };
    }
    if (account && reason.length < 12) throw new AppError('Enter a reason of at least 12 characters for replacing access.', 422);
    const code = randomToken(16);
    const expiresAt = new Date(Date.now() + codeLifetime).toISOString();
    const credentials = { activationHash: await digest(code), activationExpiresAt: expiresAt, passwordHash: null, salt: null, failedAttempts: 0, lockedUntil: null };
    await store.batch([
      store.insert('patientPortalAccounts', { patientId, ...credentials }, { conflict: 'patientId', set: credentials }),
      store.remove('patientPortalSessions', match('patientId', patientId)),
      store.insert('activityHistory', auditRow(user, account ? 'Reissued patient setup code' : 'Issued patient setup code', 'patient', patientId, reason || 'Registration confirmed the patient’s identity in person.', patientId)),
    ]);
    return { status: 'pending', expiresAt, code };
  }, { lock: patientLock(patientId) });
  return result(data);
}

function patientActor(patient: { id: string; name: string }) {
  return { id: patient.id, name: patient.name, role: 'patient' as const };
}

async function startSession(store: ClinicRepository, patientId: string) {
  const token = randomToken();
  await store.batch([
    store.remove('patientPortalSessions', match('patientId', patientId)),
    store.insert('patientPortalSessions', { tokenHash: await digest(token), patientId, lastSeen: now(), expiresAt: new Date(Date.now() + SESSION_MS).toISOString() }),
  ]);
  return token;
}

export async function activatePatientPortal({ request, input }: ServiceContext) {
  const patientId = patientKey(input.patientId);
  const code = cleanText(input.code, 'Setup code', 64).toLowerCase();
  const password = cleanText(input.password, 'Password', 200);
  if (password.length < 12 || password === 'CareRecord2026!') throw new AppError('Choose your own password with at least 12 characters.', 422);
  if (!/^[a-f0-9]{32}$/.test(code)) throw new AppError('Check the setup code or ask Registration for a new one.', 422);
  const token = await repository.transaction(async store => {
    const account = await accountFor(patientId, store);
    if (!account?.activationHash || !account.activationExpiresAt || Date.parse(account.activationExpiresAt) <= Date.now() || !constantEqual(await digest(code), account.activationHash)) throw new AppError('Check the setup code or ask Registration for a new one.', 422);
    const patient = await patientFor(patientId, store);
    const salt = randomToken(16);
    await store.batch([
      store.update('patientPortalAccounts', { salt, passwordHash: await hashPassword(password, salt), activationHash: null, activationExpiresAt: null, failedAttempts: 0, lockedUntil: null }, match('patientId', patientId)),
      store.insert('activityHistory', auditRow(patientActor(patient), 'Activated patient account', 'patient', patientId, 'Patient completed one-time account setup.', patientId)),
    ]);
    return startSession(store, patientId);
  }, { lock: patientLock(patientId) });
  return result({ ok: true }, 200, { 'Set-Cookie': cookie(request, token) });
}

export async function loginPatientPortal({ request, input }: ServiceContext) {
  const patientId = patientKey(input.patientId);
  const password = cleanText(input.password, 'Password', 200);
  const token = await repository.transaction(async store => {
    const account = await accountFor(patientId, store);
    const passwordHash = await hashPassword(password, account?.salt || 'unavailable-patient-account');
    if (!account?.passwordHash || account.lockedUntil && Date.parse(account.lockedUntil) > Date.now()) return null;
    if (!constantEqual(passwordHash, account.passwordHash)) {
      const failedAttempts = account.lockedUntil ? 1 : account.failedAttempts + 1;
      await store.update('patientPortalAccounts', { failedAttempts, lockedUntil: failedAttempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null }, match('patientId', patientId));
      return null;
    }
    const patient = await patientFor(patientId, store);
    await store.batch([
      store.update('patientPortalAccounts', { failedAttempts: 0, lockedUntil: null }, match('patientId', patientId)),
      store.insert('activityHistory', auditRow(patientActor(patient), 'Patient signed in', 'patient-session', patientId, 'Patient signed in to their portal.', patientId)),
    ]);
    return startSession(store, patientId);
  }, { lock: patientLock(patientId) });
  if (!token) throw new AppError(credentialsError, 401);
  return result({ ok: true }, 200, { 'Set-Cookie': cookie(request, token) });
}

export async function logoutPatientPortal({ request }: ServiceContext) {
  const token = tokenFrom(request);
  if (validToken.test(token)) await repository.remove('patientPortalSessions', match('tokenHash', await digest(token)));
  return result({ ok: true }, 200, { 'Set-Cookie': cookie(request, '') });
}

export async function patientPortalRecords({ request }: ServiceContext) {
  const token = tokenFrom(request);
  if (!validToken.test(token)) throw new AppError(expiredError, 401);
  const tokenHash = await digest(token);
  const [session] = await repository.find('patientPortalSessions', match('tokenHash', tokenHash));
  if (!session || sessionExpired(session)) throw new AppError(expiredError, 401);
  const { patientId } = session;
  const [patient, visits, reports, bills] = await Promise.all([
    patientFor(patientId), repository.find('visits', match('patientId', patientId)),
    repository.find('labReports', allOf(match('patientId', patientId), match('status', 'approved'))),
    repository.find('invoices', match('patientId', patientId)),
  ]);
  if (!patient) throw new AppError(expiredError, 401);
  const visitsById = new Map(visits.map(visit => [visit.id, visit]));
  const completed = visits.filter(visit => visit.status === 'signed');
  const doctors = completed.length ? await repository.find('staffAccounts', oneOf('id', [...new Set(completed.map(visit => visit.doctorId))])) : [];
  const names = new Map(doctors.map(doctor => [doctor.id, doctor.name]));
  const labs = reports.flatMap(report => {
    const review = report.doctorReview as { reviewedAt?: string; reportApprovedAt?: string; releasedAt?: string; plan?: string; followUpDate?: string } | null;
    const visit = visitsById.get(report.visitId);
    if (!review?.releasedAt || !review.reviewedAt || review.reportApprovedAt !== report.approvedAt || !visit || visit.status === 'cancelled' || labProblems(report, visit).length) return [];
    const measurements = (report.measurements as { name: string; result: string; unit: string; reference?: string; flag?: string }[]).map(({ name, result, unit, reference, flag }) => ({ name, result, unit, reference, flag }));
    return [{ id: report.id, visitId: report.visitId, testName: report.testName, releasedAt: review.releasedAt, collectedAt: report.collectedAt,
      measurements: measurements.length ? measurements : [{ name: report.testName, result: report.value, unit: report.unit }], followUpDate: review.followUpDate }];
  });
  if (Date.parse(session.lastSeen) < Date.now() - 30_000) await repository.update('patientPortalSessions', { lastSeen: now() }, match('tokenHash', tokenHash));
  return result({ patient: { id: patient.id, name: patient.name },
    visits: completed.map(visit => ({ id: visit.id, date: visit.date, doctor: names.get(visit.doctorId) || 'Clinic doctor' })).sort((a, b) => b.date.localeCompare(a.date)),
    labs: labs.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt)),
    bills: bills.filter(bill => visitsById.has(bill.visitId)).map(bill => ({ id: bill.id, visitId: bill.visitId, date: bill.date, total: bill.total, paid: bill.paid,
      items: (bill.items as { description: string; amount: number }[]).map(({ description, amount }) => ({ description, amount })),
      payments: (bill.payments as { amount: number; method: string; at: string }[]).map(({ amount, method, at }) => ({ amount, method, at })),
    })).sort((a, b) => b.date.localeCompare(a.date)),
  });
}
