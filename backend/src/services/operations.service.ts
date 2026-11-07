import { repository, match, allOf, oneOf } from '../repositories/clinic.repository';
import { AppError, assertRole, cleanText, labProblems, type Staff } from '../../../shared/domain';
import { hashPassword, constantEqual, randomToken, sessionCookie } from './security';
import { audit, auditRow, loadAll, now, permittedPatient, updateWithHistory } from './server';
import { needsDoctorReview } from '../../../shared/clinical';
import { renderDocument } from './print-document';
import { result } from '../http/result';
import type { ServiceContext } from '../http/context';
function newPassword(value: unknown) {
    const text = cleanText(value, 'New password', 200);
    if (text.length < 12)
        throw new AppError('Use a password with at least 12 characters.', 422);
    if (text === 'CareRecord2026!')
        throw new AppError('Choose an individual password instead of the shared setup password.', 422);
    return text;
}
export async function passwordService(context: ServiceContext) {
    const { request, user, id, action, input } = context;
    
    const password = newPassword(input.password);
    const old = (await repository.find("staffAccounts", match("id", user.id)))[0];
    const current = cleanText(input.currentPassword, 'Current password', 200);
    if (!constantEqual(await hashPassword(current, old.salt), old.passwordHash))
        throw new AppError('The current password was not accepted.', 422);
    if (current === password)
        throw new AppError('Choose a different password.', 422);
    const salt = randomToken(16);
    await repository.batch([repository.update("staffAccounts", { salt, passwordHash: await hashPassword(password, salt), mustChangePassword: false, failedAttempts: 0, lockedUntil: null }, match("id", user.id)), repository.remove("staffSessions", match("userId", user.id)), repository.insert("activityHistory", auditRow(user, 'Changed own password', 'staff', user.id, 'Password replaced. Existing sessions ended. No password stored in history.'))]);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie('', request, true) } });
}
export async function resetPasswordService(context: ServiceContext) {
    const { request, user, id, action, input } = context;
    assertRole(user, ['manager']);
    
    if (id === user.id)
        throw new AppError('Use Account & password to change your own password.', 422);
    const target = (await repository.find("staffAccounts", match("id", id)))[0];
    if (!target)
        throw new AppError('This staff account is unavailable.', 404);
    const reason = cleanText(input.reason, 'Identity verification and reset reason', 1000);
    if (reason.length < 12)
        throw new AppError('Describe the identity verification and reset reason in at least 12 characters.', 422);
    const password = newPassword(input.password);
    const salt = randomToken(16);
    await repository.batch([repository.update("staffAccounts", { salt, passwordHash: await hashPassword(password, salt), mustChangePassword: true, failedAttempts: 0, lockedUntil: null }, match("id", id)), repository.remove("staffSessions", match("userId", id)), repository.insert("activityHistory", auditRow(user, 'Reset staff password', 'staff', id, `Identity verified and temporary password issued for ${target.name}. Staff must replace it before continuing. Reason: ${reason}`))]);
    return result({ ok: true });
}
export async function clinicSettingsService(context: ServiceContext) {
    const { request, user, id, action, input } = context;
    assertRole(user, ['manager']);
    if (request.method === 'GET') {
        const setting = (await repository.find("appSettings", match("key", 'clinic-profile')))[0];
        const backup = (await repository.find("appSettings", match("key", 'backup-status')))[0];
        return result({ profile: setting ? JSON.parse(setting.value) : { name: '', address: '', contact: '' }, backup: backup ? JSON.parse(backup.value) : null });
    }
    if (request.method === 'POST') {
        
        const profile = { name: cleanText(input.name, 'Clinic name', 120), address: cleanText(input.address, 'Clinic address', 300, false), contact: cleanText(input.contact, 'Clinic contact', 120, false) };
        await repository.batch([repository.insert("appSettings", { key: 'clinic-profile', value: JSON.stringify(profile) }, { conflict: "key", set: { value: JSON.stringify(profile) } }), repository.insert("activityHistory", auditRow(user, 'Updated clinic document details', 'staff', 'clinic-profile', 'Clinic name, address and contact details updated for printed documents.'))]);
        return result({ ok: true });
    }
}
export async function doctorReviewService(context: ServiceContext) {
    const { request, user, id, action, input } = context;
    assertRole(user, ['doctor']);
    
    const old = (await repository.find("labReports", match("id", id)))[0];
    if (!old || old.status !== 'approved')
        throw new AppError('Only an approved report can be reviewed.', 422);
    const { patient, data } = await permittedPatient(user, old.patientId);
    if (patient.doctorId !== user.id)
        throw new AppError('This report is outside your patient assignment.', 403);
    if (!needsDoctorReview(old))
        throw new AppError('This approved report version already has a doctor review.', 409);
    if (input.confirmed !== true)
        throw new AppError('Confirm that you reviewed the approved report.', 422);
    const plan = cleanText(input.plan, 'Follow-up decision and plan', 3000);
    const followUpDate = cleanText(input.followUpDate, 'Follow-up date', 10, false);
    if (followUpDate && (!/^\d{4}-\d{2}-\d{2}$/.test(followUpDate) || !Number.isFinite(Date.parse(followUpDate)) || new Date(followUpDate).toISOString().slice(0, 10) !== followUpDate))
        throw new AppError('Enter a valid follow-up date.', 422);
    const doctorReview = { reportApprovedAt: old.approvedAt, reviewedAt: now(), reviewedBy: user.name, reviewedById: user.id, plan, followUpDate };
    await updateWithHistory("labReports", old, input.version, { doctorReview }, auditRow(user, 'Reviewed approved laboratory report', 'lab', id, 'Doctor review and follow-up decision recorded for this approved version.', old.patientId));
    return result({ ok: true });
}

export async function patientResultReleaseService({ user, id, input }: ServiceContext) {
    assertRole(user, ['doctor']);
    const report = (await repository.find('labReports', match('id', id)))[0];
    if (!report) throw new AppError('This report was not found.', 404);
    const { patient, data } = await permittedPatient(user, report.patientId);
    if (patient.doctorId !== user.id) throw new AppError('This report is outside your patient assignment.', 403);
    const review = report.doctorReview as { reviewedAt?: string; reportApprovedAt?: string; releasedAt?: string } | null;
    const visit = data.visits.find(row => row.id === report.visitId && row.patientId === patient.id);
    if (report.status !== 'approved' || !review?.reviewedAt || review.reportApprovedAt !== report.approvedAt || !visit || visit.status === 'cancelled' || labProblems(report, visit).length) throw new AppError('Complete the review of the current approved result before releasing it.', 422);
    if (review.releasedAt) return result({ ok: true });
    if (input.confirmed !== true) throw new AppError('Confirm release to the patient portal.', 422);
    await updateWithHistory('labReports', report, input.version, { doctorReview: { ...review, releasedAt: now() } }, auditRow(user, 'Released laboratory report to patient', 'lab', id, 'Assigned doctor released the reviewed report to the patient portal.', patient.id));
    return result({ ok: true });
}
export async function documentService(context: ServiceContext) {
    const { request, user, id, action, input } = context;
    const kind = id;
    const recordId = action;
    const data = await loadAll();
    let record: any;
    if (kind === 'visit') {
        assertRole(user, ['doctor']);
        record = data.visits.find(v => v.id === recordId);
        if (!record || record.status !== 'signed')
            throw new AppError('Print a completed consultation from its saved record.', 422);
    }
    else if (kind === 'lab') {
        assertRole(user, ['doctor', 'laboratory']);
        record = data.labs.find(l => l.id === recordId);
        if (!record || record.status !== 'approved')
            throw new AppError('Only approved laboratory reports can be printed.', 422);
    }
    else if (kind === 'bill' || kind === 'receipt') {
        assertRole(user, ['billing']);
        record = data.invoices.find(b => b.id === recordId);
    }
    else
        throw new AppError('This document type is unavailable.', 404);
    if (!record)
        throw new AppError('This document is unavailable.', 404);
    const { patient } = await permittedPatient(user, record.patientId);
    const setting = (await repository.find("appSettings", match("key", 'clinic-profile')))[0];
    const profile = setting ? JSON.parse(setting.value) : { name: 'Clinic', address: '', contact: '' };
    const paymentId = new URL(request.url).searchParams.get('payment');
    const payment = kind === 'receipt' ? (record.payments as any[]).find(p => p.id === paymentId) : undefined;
    if (kind === 'receipt' && !payment)
        throw new AppError('Choose a payment recorded on this bill.', 404);
    const html = renderDocument(kind, record, patient, data.staff, profile, payment);
    await audit(user, 'Opened printable document', kind === 'visit' ? 'visit' : kind === 'lab' ? 'lab' : 'invoice', record.id, `Saved ${kind} document opened for printing.`, patient.id);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } });
}
