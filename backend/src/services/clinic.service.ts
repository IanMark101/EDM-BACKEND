import { repository, match, allOf, oneOf, type ClinicRepository } from '../repositories/clinic.repository';
import { AppError, assertRole, cleanText, dateOnly, validatePatient, moneyCents, identityKey, labProblems, ROLES, publicStaff, csvCell, type Staff } from '../../../shared/domain';
import { authenticate, audit, auditRow, now, newId, visibleData, permittedPatient, loadAll, updateWithHistory, refreshWarehouse } from './server';
import { ensureSeed } from '../repositories/seed';
import { hashPassword, randomToken, constantEqual, digest, SESSION_MS, sessionCookie, cookieToken, requireSameOrigin } from './security';
import { notificationRows, notificationInsert } from './notifications';
import { cleanClinical, cleanMeasurements, LAB_LAYOUTS } from '../../../shared/clinical';
import { managedInvoicesService, pricedImportItems } from './billing.service';
import { result } from '../http/result';
import type { ServiceContext } from '../http/context';
function requiredRow<T>(row: T | undefined): T { if (!row)
    throw new AppError('This record could not be found.', 404); return row; }
function evidence(value: unknown) { const reason = cleanText(value, 'Reason or evidence', 1000); if (reason.length < 12)
    throw new AppError('Explain the reason or evidence in at least 12 characters.', 422); return reason; }
function invoiceItems(items: any) {
    if (!Array.isArray(items) || !items.length || items.length > 12)
        throw new AppError('Add between 1 and 12 charge items.', 422);
    return items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('Each charge item must contain a service description and amount.', 422);
        return { description: cleanText(item.description, 'Service description', 160), amount: moneyCents(item.amount, 'Charge') };
    });
}
async function syncLabReview(report: any, visit: any, user: Staff, store: ClinicRepository = repository) {
    const open = await store.find("qualityReviews", allOf(match("recordId", report.id), match("state", 'open')));
    const problems = labProblems(report, visit);
    if (!problems.length) {
        if (open.length)
            await store.update("qualityReviews", { state: 'resolved', resolvedAt: now(), resolvedBy: user.name, resolution: 'Required laboratory details checked.', evidence: 'Patient, visit, result, unit and collection time were checked by laboratory staff.' }, allOf(match("recordId", report.id), match("state", 'open')));
    }
    else if (!open.length) {
        const issueId = newId('Q');
        const notices = await notificationRows(user, { key: `quality:${issueId}`, roles: ['reviewer', 'laboratory'], kind: 'due', body: 'saved a report that needs details:', subject: report.id, patientId: report.patientId, entityId: issueId, href: `/clinic/review?open=${issueId}` }, store);
        // Laboratory recipients open the report itself, rather than the reviewer's screen.
        notices.forEach(n => { if (n.recipientRole === 'laboratory')
            n.href = `/clinic/laboratory?open=${report.id}`; });
        await store.batch([store.insert("qualityReviews", { id: issueId, kind: 'lab', patientId: report.patientId, recordId: report.id, title: 'Laboratory details incomplete', detail: problems.join(' '), ownerRole: 'laboratory', createdAt: now() }), ...notificationInsert(notices)]);
    }
}
async function materializeImport(imported: any, patientId: string, visitId: string, user: Staff, store: ClinicRepository = repository) {
    const p = cleanImportPayload(imported.source, imported.payload);
    const visit = requiredRow((await store.find("visits", match("id", visitId)))[0]);
    if (visit.patientId !== patientId)
        throw new AppError('The selected visit belongs to another patient.', 422);
    const id = `${imported.source === 'laboratory' ? 'L' : 'B'}-IMP-${imported.externalId}`;
    if ('testName' in p) {
        const report = { id, patientId, visitId, testName: cleanText(p.testName, 'Test name', 120), value: cleanText(p.value, 'Result', 3000, false), unit: cleanText(p.unit, 'Unit', 80, false), collectedAt: cleanText(p.collectedAt, 'Collection time', 40, false), status: 'draft', requestedBy: visit.doctorId, sourceRef: imported.externalId, updatedAt: now() };
        await store.batch([store.insert("labReports", report), store.update("sourceImports", { state: 'imported', linkedPatientId: patientId }, match("id", imported.id)), store.insert("activityHistory", auditRow(user, 'Received laboratory record', 'import', imported.externalId, 'Source reference retained. Report saved as a draft for laboratory review.', patientId))]);
        await syncLabReview(report, visit, user, store);
    }
    else {
        if (visit.status !== 'signed')
            throw new AppError('The consultation must be completed before a bill can be received for this visit.', 422);
        if ((await store.find("invoices", match("visitId", visit.id))).length)
            throw new AppError('This visit already has a bill. Billing staff must check it and use Add a charge for a later service, rather than receive a second bill.', 409);
        const items = await pricedImportItems(visit, p.items, user, store);
        const total = items.reduce((sum: number, item: any) => sum + item.amount, 0);
        await store.batch([store.insert("invoices", { id, patientId, visitId, date: dateOnly(p.date, 'Bill date'), items, total, sourceRef: imported.externalId, updatedAt: now() }), store.update("sourceImports", { state: 'imported', linkedPatientId: patientId }, match("id", imported.id)), store.insert("activityHistory", auditRow(user, 'Received billing record', 'import', imported.externalId, 'A checked source bill was linked to the selected patient and visit.', patientId))]);
    }
}
export async function loginService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    
    const username = cleanText(input.username, 'Username', 60).toLowerCase();
    const password = cleanText(input.password, 'Password', 200);
    const account = (await repository.find("staffAccounts", match("username", username)))[0];
    const passwordHash = await hashPassword(password, account?.salt || 'unavailable-account-salt');
    if (!account || !account.active || account.lockedUntil && Date.parse(account.lockedUntil) > Date.now() || !constantEqual(passwordHash, account.passwordHash)) {
        if (account && (!account.lockedUntil || Date.parse(account.lockedUntil) <= Date.now())) {
            const attempts = account.lockedUntil ? 1 : account.failedAttempts + 1;
            await repository.update("staffAccounts", { failedAttempts: attempts, lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null }, match("id", account.id));
            await audit(publicStaff(account), 'Sign-in unsuccessful', 'session', account.id, 'Credentials were not accepted. Repeated failed attempts temporarily lock the account.');
        }
        throw new AppError('Sign-in was not successful. Check your details, or wait 15 minutes if the account is temporarily locked.', 401);
    }
    user = publicStaff(account);
    const token = randomToken();
    const at = now();
    await repository.batch([repository.update("staffAccounts", { failedAttempts: 0, lockedUntil: null }, match("id", user.id)), repository.insert("staffSessions", { tokenHash: await digest(token), userId: user.id, createdAt: at, lastSeen: at, expiresAt: new Date(Date.now() + SESSION_MS).toISOString() }), repository.insert("activityHistory", auditRow(user, 'Signed in', 'session', user.id, 'Individual staff account authenticated.'))]);
    return result({ user }, 200, { 'Set-Cookie': sessionCookie(token, request) });
}
export async function logoutService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    await repository.batch([repository.remove("staffSessions", match("tokenHash", await digest(cookieToken(request)))), repository.insert("activityHistory", auditRow(user, 'Signed out', 'session', user.id, 'Staff session ended.'))]);
    return result({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', request, true) });
}
export async function heartbeatService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    return result({ ok: true });
}
export async function dataService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    if (user.mustChangePassword)
        return result({ user, patients: [], visits: [], labs: [], invoices: [], reviews: [], imports: [], facts: [], runs: [], staff: [], history: [], notifications: [], billingServices: [], generatedAt: now() });
    if (!url.searchParams.has('refresh'))
        await audit(user, 'Opened permitted workspace', 'workspace', user.role, 'Only the fields and patients permitted for the assigned staff role were returned.');
    return result(await visibleData(user));
}
export async function reportExportService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    assertRole(user, ['reviewer']);
    const from = url.searchParams.get('from') || '1900-01-01';
    const to = url.searchParams.get('to') || '9999-12-31';
    const rows = (await repository.find("warehouseFacts", undefined)).filter(f => f.date >= from && f.date <= to);
    const csv = [['Source', 'Source record', 'Kind', 'Date', 'Service', 'Charges PHP', 'Payments received PHP', 'Current paid on bill PHP', 'Current bill balance PHP', 'Last refreshed'], ...rows.map(f => [f.source, f.sourceId, f.kind, f.date, f.service, (f.total / 100).toFixed(2), ((f.kind === 'payment' ? f.paid : 0) / 100).toFixed(2), ((f.kind === 'invoice' ? f.paid : 0) / 100).toFixed(2), ((f.kind === 'invoice' ? f.total - f.paid : 0) / 100).toFixed(2), f.refreshedAt])].map(row => row.map(csvCell).join(',')).join('\r\n');
    await audit(user, 'Exported reporting copies', 'warehouse', 'CSV', `${rows.length} selected reporting rows exported. Names, birth dates, contact details, notes and result values excluded.`);
    return new Response('\uFEFF' + csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="carerecord-report.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function recordViewService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    
    await permittedPatient(user, cleanText(input.patientId, 'Patient number', 60));
    await audit(user, 'Viewed patient record', 'patient', input.patientId, 'Opened the patient view permitted for this staff role.', input.patientId);
    return result({ ok: true });
}
export async function notificationsService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    
    const allowed = (await visibleData(user)).notifications;
    if (id === 'read-all') {
        const ids = allowed.filter(n => !n.readAt).map(n => n.id);
        if (ids.length)
            await repository.batch(Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) => repository.update("staffNotifications", { readAt: now() }, oneOf("id", ids.slice(i * 50, i * 50 + 50)))) as any);
    }
    else {
        const notification = allowed.find(n => n.id === id);
        if (!notification)
            throw new AppError('This notification is not available to your account.', 403);
        if (typeof input.unread !== 'boolean' && typeof input.archived !== 'boolean')
            throw new AppError('Choose read or archive.', 422);
        const patch: {
            readAt?: string | null;
            archivedAt?: string | null;
        } = {};
        if (typeof input.unread === 'boolean')
            patch.readAt = input.unread ? null : now();
        if (typeof input.archived === 'boolean') {
            patch.archivedAt = input.archived ? now() : null;
            if (input.archived)
                patch.readAt = now();
        }
        await repository.update("staffNotifications", patch, allOf(match("id", id), match("recipientId", user.id)));
    }
    return result({ ok: true });
}
export async function checkInsService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    assertRole(user, ['registration']);
    
    if (id) {
        const visit = requiredRow((await repository.find("visits", match("id", id)))[0]);
        if (visit.status !== 'waiting')
            throw new AppError('Only a waiting check-in can be cancelled. Contact the doctor for a consultation already in progress.', 409);
        const reason = evidence(input.reason);
        const patient = requiredRow((await repository.find("patients", match("id", visit.patientId)))[0]);
        const notices = await notificationRows(user, { key: `checkin-cancelled:${id}`, staffIds: [visit.doctorId], kind: 'edit', body: 'cancelled the waiting check-in for', subject: patient.name, patientId: patient.id, entityId: id, href: `/clinic/visits?open=${id}` });
        await updateWithHistory("visits", visit, input.version, { status: 'cancelled' }, auditRow(user, 'Cancelled check-in', 'visit', id, reason, visit.patientId), notices);
        return result({ id });
    }
    const patient = requiredRow((await repository.find("patients", match("id", input.patientId)))[0]);
    const date = dateOnly(input.date, 'Visit date');
    const doctor = (await repository.find("staffAccounts", match("id", patient.doctorId!)))[0];
    if (!doctor?.active || doctor.role !== 'doctor')
        throw new AppError('Assign an active doctor in the patient details before check-in.', 422);
    const active = (await repository.find("visits", match("patientId", patient.id))).find(v => v.status === 'waiting' || v.date === date && v.status === 'draft');
    if (active)
        return result({ id: active.id, alreadyWaiting: true });
    const visitId = newId('V');
    const at = now();
    const notices = await notificationRows(user, { key: `checkin:${visitId}`, staffIds: [doctor.id], kind: 'request', body: 'checked in', subject: patient.name, patientId: patient.id, entityId: visitId, href: `/clinic/visits?open=${visitId}` });
    await repository.batch([
        repository.insert("visits", { id: visitId, patientId: patient.id, doctorId: doctor.id, date, reason: '', clinical: { structured: true, allergyStatus: 'unknown' }, status: 'waiting', updatedAt: at }),
        repository.insert("visitWorkflow", { visitId, checkedInAt: at, queueKey: patient.id }),
        repository.insert("activityHistory", auditRow(user, 'Checked in patient', 'visit', visitId, 'Patient identity confirmed and waiting visit assigned to the responsible doctor.', patient.id)),
        ...notificationInsert(notices),
    ]);
    return result({ id: visitId }, 201);
}
export async function patientsService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    assertRole(user, id ? ['registration', 'reviewer'] : ['registration']);
    
    const fields = validatePatient(input);
    const all = await repository.find("patients", undefined);
    const possible = all.filter(p => p.id !== id && p.dob === fields.dob && identityKey(p.name) === identityKey(fields.name));
    if (possible.length && !(input.confirmDifferentPerson === true && typeof input.reason === 'string' && input.reason.trim().length >= 12))
        throw new AppError(`Possible existing patient: ${possible.map(p => `${p.name} (${p.id})`).join(', ')}. Check the record before creating another. If this is a different person, confirm that and record the evidence.`, 409);
    const doctorId = cleanText(input.doctorId, 'Assigned doctor', 80);
    const doctor = (await repository.find("staffAccounts", match("id", doctorId)))[0];
    if (!doctor?.active || doctor.role !== 'doctor')
        throw new AppError('Choose an active doctor.', 422);
    if (id) {
        const old = requiredRow(all.find(p => p.id === id));
        const reason = evidence(input.reason);
        await updateWithHistory("patients", old, input.version, { ...fields, doctorId }, auditRow(user, 'Corrected patient details', 'patient', id, JSON.stringify({ previous: { name: old.name, dob: old.dob, phone: old.phone, doctorId: old.doctorId }, corrected: { ...fields, doctorId }, reason }), id));
        return result({ id });
    }
    const patientId = newId('P');
    await repository.batch([repository.insert("patients", { id: patientId, ...fields, doctorId, updatedAt: now() }), repository.insert("activityHistory", auditRow(user, 'Registered patient', 'patient', patientId, input.reason ? `Different-person evidence: ${evidence(input.reason)}` : 'Identity fields checked and permanent patient number assigned.', patientId))]);
    return result({ id: patientId }, 201);
}
export async function visitsService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    assertRole(user, ['doctor']);
    
    if (!id) {
        const { patient } = await permittedPatient(user, cleanText(input.patientId, 'Patient number', 80));
        const visitId = newId('V');
        const row = { id: visitId, patientId: patient.id, doctorId: user.id, date: dateOnly(input.date, 'Visit date'), reason: cleanText(input.reason, 'Reason for visit', 200), notes: cleanText(input.notes, 'Consultation notes', 5000, false), clinical: cleanClinical(input.clinical || { allergyStatus: 'unknown' }), updatedAt: now() };
        const ongoing = (await repository.find("visits", match("patientId", patient.id))).find(v => v.status === 'waiting' || v.date === row.date && v.status === 'draft');
        if (ongoing)
            throw new AppError(`Visit ${ongoing.id} is already open. Continue that visit instead of creating another consultation.`, 409);
        await repository.batch([repository.insert("visits", row), repository.insert("activityHistory", auditRow(user, 'Opened consultation', 'visit', visitId, 'A separate visit number was assigned to the patient.', patient.id))]);
        return result({ id: visitId }, 201);
    }
    const old = requiredRow((await repository.find("visits", match("id", id)))[0]);
    await permittedPatient(user, old.patientId);
    if (old.doctorId !== user.id)
        throw new AppError('Only the responsible doctor can change this consultation.', 403);
    const mode = input.action || 'save';
    if (mode === 'start') {
        if (old.status === 'draft')
            return result({ id });
        if (old.status !== 'waiting')
            throw new AppError('This visit is no longer waiting. Refresh your work list.', 409);
        await updateWithHistory("visits", old, input.version, { status: 'draft' }, auditRow(user, 'Started consultation', 'visit', id, 'The responsible doctor began this consultation.', old.patientId));
        return result({ id });
    }
    if (!['save', 'sign', 'correct'].includes(mode))
        throw new AppError('Choose a valid consultation action.', 422);
    if (old.status === 'signed' && mode !== 'correct')
        throw new AppError('Use a recorded correction for signed notes.', 422);
    if (old.status === 'cancelled')
        throw new AppError('This check-in was cancelled. Open a new visit.', 422);
    const notes = cleanText(input.notes, 'Consultation notes', 5000, mode !== 'save' && input.clinical === undefined);
    const reason = mode === 'correct' ? evidence(input.reason) : '';
    const visitReason = cleanText(input.visitReason ?? old.reason, 'Reason for visit', 200, mode !== 'save');
    const clinical = input.clinical === undefined && !(old.clinical as any)?.structured ? old.clinical : cleanClinical(input.clinical ?? old.clinical, mode !== 'save');
    const history = mode === 'correct' ? [...old.history as any[], { notes: old.notes, clinical: old.clinical, visitReason: old.reason, signedAt: old.signedAt, changedAt: now(), changedBy: user.name, reason }] : old.history;
    const patient = requiredRow((await repository.find("patients", match("id", old.patientId)))[0]);
    const notices = mode === 'sign' && old.status !== 'signed' ? await notificationRows(user, { key: `visit-signed:${id}`, roles: ['billing'], kind: 'created', body: 'completed the consultation for', subject: patient.name, patientId: patient.id, entityId: id, href: `/clinic/billing?visit=${id}` }) : [];
    await updateWithHistory("visits", old, input.version, { reason: visitReason, notes, clinical, history, status: mode === 'save' ? 'draft' : 'signed', signedAt: mode === 'save' ? null : now() }, auditRow(user, mode === 'correct' ? 'Corrected signed consultation' : mode === 'sign' ? 'Signed consultation' : 'Saved consultation draft', 'visit', id, reason || 'Consultation content saved by its responsible doctor. Earlier signed content is retained when corrected.', old.patientId), notices);
    return result({ id });
}
export async function labsService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    
    if (!id) {
        assertRole(user, ['doctor']);
        const { patient } = await permittedPatient(user, cleanText(input.patientId, 'Patient number', 80));
        const visit = requiredRow((await repository.find("visits", match("id", input.visitId)))[0]);
        if (visit.patientId !== patient.id || visit.doctorId !== user.id)
            throw new AppError('Choose one of your visits for this patient.', 422);
        if (visit.status === 'waiting' || visit.status === 'cancelled')
            throw new AppError('Start the consultation before requesting a test.', 422);
        const labId = newId('L');
        const notices = await notificationRows(user, { key: `lab-request:${labId}`, roles: ['laboratory'], kind: 'request', body: 'requested a laboratory test for', subject: patient.name, patientId: patient.id, entityId: labId, href: `/clinic/laboratory?open=${labId}` });
        await repository.batch([repository.insert("labReports", { id: labId, patientId: patient.id, visitId: visit.id, testName: cleanText(input.testName, 'Test name', 120), requestedBy: user.id, sourceRef: newId('LAB'), updatedAt: now() }), repository.insert("activityHistory", auditRow(user, 'Requested laboratory test', 'lab', labId, 'Request linked to the confirmed patient and visit.', patient.id)), ...notificationInsert(notices)]);
        return result({ id: labId }, 201);
    }
    assertRole(user, ['laboratory']);
    const old = requiredRow((await repository.find("labReports", match("id", id)))[0]);
    const visit = requiredRow((await repository.find("visits", match("id", old.visitId)))[0]);
    const mode = input.action || 'save';
    if (!['save', 'approve', 'correct'].includes(mode))
        throw new AppError('Choose a valid laboratory action.', 422);
    if (old.status === 'approved' && mode !== 'correct')
        throw new AppError('Use a recorded correction for an approved report.', 422);
    if (mode === 'correct' && old.status !== 'approved')
        throw new AppError('Only approved reports use the correction process.', 422);
    const fields = { value: cleanText(input.value, 'Result', 3000, false), unit: cleanText(input.unit, 'Unit', 80, false), collectedAt: cleanText(input.collectedAt, 'Collection time', 40, false) };
    if (fields.collectedAt && !Number.isFinite(Date.parse(fields.collectedAt)))
        throw new AppError('Enter a valid collection time.', 422);
    const layout = input.layout ?? old.layout;
    if (!LAB_LAYOUTS.some(l => l.id === layout))
        throw new AppError('Choose a listed report layout.', 422);
    const measurements = input.measurements === undefined ? old.measurements : cleanMeasurements(input.measurements);
    const urgency = input.urgency ?? old.urgency;
    if (!['routine', 'urgent'].includes(urgency))
        throw new AppError('Choose routine or urgent review.', 422);
    const contact: any = input.contact === undefined ? old.contact : {
        person: cleanText(input.contact?.person, 'Staff member contacted', 120, false),
        method: cleanText(input.contact?.method, 'Contact method', 80, false),
        at: cleanText(input.contact?.at, 'Contact time', 40, false),
    };
    if (contact.at && (!Number.isFinite(Date.parse(contact.at)) || Date.parse(contact.at) > Date.now() + 60000))
        throw new AppError('Enter a valid contact time that is not in the future.', 422);
    if (mode !== 'save' && urgency === 'urgent' && (!contact.person || !contact.method || !contact.at))
        throw new AppError('For an urgent report, contact the responsible clinician and record their name, contact method and time before approval.', 422);
    const report = { ...old, ...fields, layout, measurements,
        specimen: cleanText(input.specimen ?? old.specimen, 'Sample type', 120, false),
        reportComment: cleanText(input.reportComment ?? old.reportComment, 'Report comment', 2000, false), urgency, contact };
    const problems = labProblems(report, visit);
    if (mode !== 'save' && problems.length)
        throw new AppError(problems.join(' '), 422);
    if (mode !== 'save' && input.reviewed !== true)
        throw new AppError('Confirm that you checked the patient, request and report content.', 422);
    const reason = mode === 'correct' ? evidence(input.reason) : '';
    const history = mode === 'correct' ? [...old.history as any[], { value: old.value, unit: old.unit, measurements: old.measurements, layout: old.layout, specimen: old.specimen, reportComment: old.reportComment, urgency: old.urgency, contact: old.contact, doctorReview: old.doctorReview, collectedAt: old.collectedAt, approvedAt: old.approvedAt, approvedBy: old.approvedBy, changedAt: now(), changedBy: user.name, reason }] : old.history;
    const patch = { ...fields, layout, measurements, specimen: report.specimen, reportComment: report.reportComment, urgency, contact,
        doctorReview: mode === 'save' ? old.doctorReview : {}, history, status: mode === 'save' ? 'draft' : 'approved', approvedBy: mode === 'save' ? null : user.id, approvedAt: mode === 'save' ? null : now() };
    const patient = requiredRow((await repository.find("patients", match("id", old.patientId)))[0]);
    const notices = mode === 'save' ? [] : await notificationRows(user, { key: `lab-approved:${id}:${old.version}`, staffIds: [patient.doctorId!], kind: urgency === 'urgent' ? 'due' : mode === 'correct' ? 'edit' : 'file', body: urgency === 'urgent' ? 'sent an urgent approved report for' : mode === 'correct' ? 'corrected an approved report for' : 'approved a laboratory report for', subject: patient.name, patientId: patient.id, entityId: id, href: `/clinic/laboratory?open=${id}` });
    await updateWithHistory("labReports", old, input.version, patch, auditRow(user, mode === 'correct' ? 'Approved report correction' : mode === 'approve' ? 'Approved laboratory report' : 'Saved laboratory draft', 'lab', id, reason || (problems.length ? `Required details still missing: ${problems.join(' ')}` : 'Required details checked; laboratory staff remain responsible for checking the report content.'), old.patientId), notices);
    await syncLabReview({ ...report, ...patch }, visit, user);
    return result({ id });
}
export async function invoicesService(context: ServiceContext) {
    return managedInvoicesService(context);
}
export async function reviewsService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    assertRole(user, ['reviewer', 'registration']);
    
    const reason = evidence(input.evidence);
    return repository.transaction(async store => {
        const review = requiredRow((await store.find("qualityReviews", match("id", id)))[0]);
        if (review.state !== 'open')
            throw new AppError('This review has already been resolved.', 409);
        if (review.kind !== 'identity')
            throw new AppError('Laboratory details must be corrected and checked by laboratory staff.', 403);
        const imported = requiredRow((await store.find("sourceImports", match("id", review.recordId)))[0]);
        if (input.decision === 'link') {
            const patient = requiredRow((await store.find("patients", match("id", input.patientId)))[0]);
            if (cleanText(input.confirmedDob, 'Verified birth date', 10) !== patient.dob)
                throw new AppError('The verified birth date does not match the selected patient. Keep the records separate until confirmed.', 422);
            await materializeImport(imported, patient.id, cleanText(input.visitId, 'Verified visit', 80), user, store);
        }
        else if (input.decision === 'keep-separate')
            await store.update("sourceImports", { state: 'kept-separate' }, match("id", imported.id));
        else
            throw new AppError('Choose to link the confirmed record or keep it separate.', 422);
        const notices = await notificationRows(user, { key: `identity-resolved:${id}`, roles: [imported.source as 'laboratory' | 'billing', 'reviewer'], kind: 'edit', body: 'resolved the patient match for', subject: imported.externalId, entityId: id, href: '/clinic/sources' }, store);
        await store.batch([store.update("qualityReviews", { state: 'resolved', resolution: input.decision === 'link' ? 'Identity confirmed and source record linked.' : 'Kept separate after identity review.', evidence: reason, resolvedBy: user.name, resolvedAt: now() }, match("id", id)), store.insert("activityHistory", auditRow(user, 'Resolved identity review', 'review', id, `${input.decision}: ${reason}`, review.patientId || undefined)), ...notificationInsert(notices)]);
        return result({ id });
    }, { lock: 20261105 });
}
// Keep source values canonical before matching or saving. Collection times must
// identify an instant; an offset-free source string depends on the host timezone.
function cleanImportPayload(source: string, value: any) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AppError('Each source record must be a JSON object.', 422);
    const externalId = cleanText(value.externalId, 'Source record number', 32);
    if (!/^[a-zA-Z0-9_-]+$/.test(externalId))
        throw new AppError('Source record numbers may contain only letters, digits, hyphens and underscores.', 422);
    const payload = { externalId, patientId: cleanText(value.patientId, 'Patient number', 80),
        patientName: cleanText(value.patientName, 'Patient name', 120),
        patientDob: value.patientDob ? dateOnly(value.patientDob, 'Birth date') : '',
        visitId: cleanText(value.visitId, 'Visit number', 80) };
    if (source === 'laboratory') {
        const collectedAt = cleanText(value.collectedAt, 'Collection time', 40, false);
        if (collectedAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(collectedAt) || !Number.isFinite(Date.parse(collectedAt))))
            throw new AppError(`Record ${externalId}: collection time must be valid ISO 8601 with Z or an explicit timezone offset.`, 422);
        if (collectedAt) dateOnly(collectedAt.slice(0, 10), 'Collection date', true);
        return { ...payload, testName: cleanText(value.testName, 'Test name', 120),
            value: cleanText(value.value, 'Result', 3000, false), unit: cleanText(value.unit, 'Unit', 80, false),
            collectedAt: collectedAt ? new Date(collectedAt).toISOString() : '' };
    }
    // Validate amounts here; materialization converts these decimal amounts to cents.
    const items = invoiceItems(value.items);
    return { ...payload, date: dateOnly(value.date, 'Bill date'),
        items: items.map(item => ({ description: item.description, amount: (item.amount / 100).toFixed(2) })) };
}
export async function importsService(context: ServiceContext) {
    const { user, input } = context;
    const source = input.source;
    if (!['laboratory', 'billing'].includes(source))
        throw new AppError('Choose laboratory or billing as the source.', 422);
    assertRole(user, [source]);
    if (!Array.isArray(input.records) || !input.records.length || input.records.length > 50)
        throw new AppError('Import between 1 and 50 records.', 422);
    try {
        const normalized = input.records.map((row: any) => cleanImportPayload(source, row));
        // All rows, held-review tasks, audit entries and notifications commit together.
        // The same lock covers identity decisions, so a retry cannot race a review.
        return await repository.transaction(async store => {
            const [patients, visits, imports] = await Promise.all([
                store.find('patients'), store.find('visits'), store.find('sourceImports', match('source', source)),
            ]);
            let importedCount = 0, held = 0, skipped = 0;
            const seen = new Set<string>();
            for (const supplied of normalized) {
                if (seen.has(supplied.externalId)) { skipped++; continue; }
                seen.add(supplied.externalId);
                const existing = imports.find(row => row.externalId === supplied.externalId);
                // Previously failed staging rows can be recovered by resubmitting the
                // file. Preserve their original payload and any human identity decision.
                if (existing && (existing.state !== 'held' || (await store.find('qualityReviews', allOf(match('recordId', existing.id), match('kind', 'identity')))).length)) {
                    skipped++; continue;
                }
                const payload = existing ? cleanImportPayload(source, existing.payload) : supplied;
                const patient = patients.find(row => row.id === payload.patientId);
                const visit = visits.find(row => row.id === payload.visitId);
                const matches = patient && patient.dob === payload.patientDob && identityKey(patient.name) === identityKey(payload.patientName) && visit?.patientId === patient.id;
                const row = existing || { id: newId('IMP'), source, externalId: payload.externalId, payload, state: 'held', receivedAt: now() };
                if (!existing) await store.insert('sourceImports', row);
                if (matches) {
                    try { await materializeImport({ ...row, payload }, patient.id, visit.id, user, store); }
                    catch (error) {
                        if (error instanceof AppError) throw new AppError(`Record ${payload.externalId}: ${error.message}`, error.status);
                        throw error;
                    }
                    importedCount++;
                } else {
                    const issueId = newId('Q');
                    const notices = await notificationRows(user, { key: `identity-held:${row.id}`, roles: ['registration', 'reviewer'], kind: 'due', body: 'received a record that needs an identity check:', subject: payload.externalId, entityId: issueId, href: `/clinic/review?open=${issueId}` }, store);
                    await store.batch([
                        store.insert('qualityReviews', { id: issueId, kind: 'identity', patientId: patient?.id || null, recordId: row.id, title: 'Confirm the source patient', detail: `${source === 'laboratory' ? 'Laboratory' : 'Billing'} source ${payload.externalId} could not be safely matched. Check the patient number, name, birth date and visit.`, ownerRole: 'registration', createdAt: now() }),
                        store.insert('activityHistory', auditRow(user, 'Held source record for checking', 'import', payload.externalId, 'Identity or visit details did not match. Nothing was automatically combined.')),
                        ...notificationInsert(notices),
                    ]);
                    held++;
                }
            }
            return result({ imported: importedCount, held, skipped });
        }, { lock: 20261105 });
    } catch (error) {
        if (error instanceof AppError) throw new AppError(`No records from this file were saved. ${error.message}`, error.status);
        if (['P2002', 'P2034'].includes((error as any)?.code))
            throw new AppError('No records from this file were saved. Another staff action changed the source records or bills. Refresh and retry the file.', 409);
        throw error;
    }
}
export async function warehouseService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    assertRole(user, ['reviewer']);
    return result(await refreshWarehouse(user));
}
export async function staffService(context: ServiceContext) {
    let { request, user, id, action, input, url } = context;
    assertRole(user, ['manager']);
    
    if (!id) {
        const username = cleanText(input.username, 'Username', 40).toLowerCase();
        const name = cleanText(input.name, 'Staff name', 120);
        if (!/^[a-z0-9._-]{3,40}$/.test(username))
            throw new AppError('Use 3–40 letters, digits, dots, underscores or hyphens for the username.', 422);
        if (!ROLES.includes(input.role))
            throw new AppError('Choose a listed staff role.', 422);
        const password = cleanText(input.password, 'Password', 200);
        if (password.length < 12)
            throw new AppError('Use a password with at least 12 characters.', 422);
        if (password === 'CareRecord2026!')
            throw new AppError('Use an individual temporary password instead of the shared setup password.', 422);
        if ((await repository.find("staffAccounts", match("username", username))).length)
            throw new AppError('This username is already in use.', 409);
        const staffId = newId('STAFF');
        const salt = randomToken(16);
        const notices = await notificationRows(user, { key: `staff-created:${staffId}`, roles: ['manager'], kind: 'join', body: 'created a staff account for', subject: name, entityId: staffId, href: '/clinic/staff' });
        await repository.batch([repository.insert("staffAccounts", { id: staffId, username, name, role: input.role, salt, mustChangePassword: true, passwordHash: await hashPassword(password, salt) }), repository.insert("activityHistory", auditRow(user, 'Created staff account', 'staff', staffId, `${name} (${username}) assigned to ${input.role}. Temporary password replacement required.`)), ...notificationInsert(notices)]);
        return result({ id: staffId }, 201);
    }
    if (id === user.id)
        throw new AppError('Your own role and access cannot be changed from this session.', 422);
    const old = requiredRow((await repository.find("staffAccounts", match("id", id)))[0]);
    if (!ROLES.includes(input.role) || typeof input.active !== 'boolean')
        throw new AppError('Choose a valid role and account state.', 422);
    const reason = evidence(input.reason);
    const notices = await notificationRows(user, { key: `staff-access:${id}:${crypto.randomUUID()}`, roles: ['manager'], staffIds: [id], kind: 'edit', body: 'updated staff access for', subject: old.name, entityId: id, href: '/clinic/access' });
    notices.forEach(n => { if (n.recipientId === id)
        n.recipientRole = input.role;
    else
        n.href = '/clinic/staff'; });
    await repository.batch([repository.update("staffAccounts", { role: input.role, active: input.active }, match("id", id)), repository.remove("staffSessions", match("userId", id)), repository.insert("activityHistory", auditRow(user, 'Changed staff permissions', 'staff', id, `${old.name}: ${old.role} → ${input.role}; access ${input.active ? 'enabled' : 'disabled'}. Existing sessions ended. Reason: ${reason}`)), ...notificationInsert(notices)]);
    return result({ id });
}
