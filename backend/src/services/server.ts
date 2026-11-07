import { repository, match, allOf, oneOf } from '../repositories/clinic.repository';
import { updateWithHistory } from '../repositories/record.repository';
export { updateWithHistory } from '../repositories/record.repository';
import { AppError, type Staff, publicStaff, labProblems, summarizeFacts, clinicDay } from '../../../shared/domain';
import { cookieToken, digest, sessionExpired, roleCanReadPatient } from './security';
import { ensureSeed } from '../repositories/seed';
import type { StaffNotification } from './notifications';
import { ensureNotificationBacklog } from './notification-backlog';
import { readPriceList } from '../repositories/pricing.repository';
import { chargeOffers } from '../../../shared/billing';
export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
export function auditRow(user: { id: string; name: string; role: Staff['role'] | 'patient' }, action: string, entityType: string, entityId: string, detail: string, patientId?: string) {
    return { id: newId('AUD'), at: now(), userId: user.id, actor: user.name, role: user.role, action, entityType, entityId, patientId: patientId || null, detail };
}
export async function audit(user: Staff, action: string, entityType: string, entityId: string, detail: string, patientId?: string) {
    await repository.insert("activityHistory", auditRow(user, action, entityType, entityId, detail, patientId));
}
export async function authenticate(request: Request, touch = true): Promise<Staff> {
    await ensureSeed(request);
    const token = cookieToken(request);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
        throw new AppError('Please sign in to continue.', 401);
    const hash = await digest(token);
    const session = (await repository.find("staffSessions", match("tokenHash", hash)))[0];
    if (!session || sessionExpired(session)) {
        if (session)
            await repository.remove("staffSessions", match("tokenHash", hash));
        throw new AppError('Your session ended. Please sign in again.', 401);
    }
    const row = (await repository.find("staffAccounts", match("id", session.userId)))[0];
    if (!row?.active)
        throw new AppError('This staff account is unavailable. Contact the account manager.', 401);
    if (touch && Date.parse(session.lastSeen) < Date.now() - 30000)
        await repository.update("staffSessions", { lastSeen: now() }, match("tokenHash", hash));
    return publicStaff(row);
}
export async function loadAll() {
    const [patients, visitRows, labs, invoices, reviews, imports, facts, runs, staff, workflows] = await Promise.all([
        repository.find("patients", undefined),
        repository.find("visits", undefined),
        repository.find("labReports", undefined),
        repository.find("invoices", undefined),
        repository.find("qualityReviews", undefined, { orderBy: "createdAt" }),
        repository.find("sourceImports", undefined),
        repository.find("warehouseFacts", undefined),
        repository.find("warehouseRuns", undefined, { orderBy: "at", limit: 10 }),
        repository.find("staffAccounts", undefined),
        repository.find("visitWorkflow", undefined),
    ]);
    const visits = visitRows.map(v => {
        const workflow = workflows.find(w => w.visitId === v.id);
        return { ...v, checkedInAt: workflow?.checkedInAt || null,
            billingReadyAt: workflow?.billingReadyAt || (v.status === 'signed' ? v.signedAt || v.updatedAt : null) };
    });
    return { patients, visits, labs, invoices, reviews, imports, facts, runs, staff: staff.map(publicStaff) };
}
export async function visibleData(user: Staff) {
    const data = await loadAll();
    const priceList = ['manager', 'billing'].includes(user.role) ? await readPriceList() : undefined;
    const patients = data.patients.filter(p => roleCanReadPatient(user, p, data.labs, data.invoices));
    const ids = new Set(patients.map(p => p.id));
    const labVisitIds = new Set(data.labs.map(l => l.visitId));
    const billedVisitIds = new Set(data.invoices.map(b => b.visitId));
    const visits = data.visits.filter(v => ids.has(v.patientId)
        && (user.role !== 'laboratory' || labVisitIds.has(v.id))
        && (user.role !== 'billing' || v.billingReadyAt || billedVisitIds.has(v.id)))
        .map(v => user.role === 'doctor' ? v : ({ id: v.id, patientId: v.patientId, doctorId: v.doctorId,
        date: v.date, status: v.status, checkedInAt: v.checkedInAt, billingReadyAt: v.billingReadyAt }));
    const reviewSummary = (review: any) => review?.reviewedAt ? { reportApprovedAt: review.reportApprovedAt, reviewedAt: review.reviewedAt, reviewedBy: review.reviewedBy } : {};
    const labs = user.role === 'laboratory' ? data.labs.map(l => ({ ...l, doctorReview: reviewSummary(l.doctorReview), history: (l.history as any[]).map(h => ({ ...h, doctorReview: reviewSummary(h.doctorReview) })) })) : user.role === 'doctor' ? data.labs.filter(l => ids.has(l.patientId)).map(l => l.status === 'approved' ? l : ({ id: l.id, patientId: l.patientId, visitId: l.visitId, testName: l.testName, status: l.status, sourceRef: l.sourceRef, updatedAt: l.updatedAt })) : [];
    const invoices = user.role === 'billing' ? data.invoices : [];
    const reviews = data.reviews.filter(r => user.role === 'reviewer' || user.role === r.ownerRole || (user.role === 'laboratory' && r.ownerRole === 'laboratory'));
    const imports = ['laboratory', 'billing', 'reviewer', 'registration'].includes(user.role) ? data.imports.filter(i => user.role !== 'laboratory' && user.role !== 'billing' || i.source === user.role).map(i => {
        const p = i.payload as any;
        return { ...i, payload: user.role === 'laboratory' && i.source === 'laboratory' || user.role === 'billing' && i.source === 'billing' ? p : { patientId: p.patientId, patientName: p.patientName, patientDob: p.patientDob, visitId: p.visitId } };
    }) : [];
    const facts = user.role === 'reviewer' ? data.facts : [];
    await ensureNotificationBacklog(user, { patients, visits, labs, invoices, reviews });
    const notificationList = await repository.find("staffNotifications", allOf(match("recipientId", user.id), match("recipientRole", user.role)), { orderBy: "createdAt", limit: 250 });
    const notifications = notificationList.filter(n => !n.patientId || ids.has(n.patientId))
        .map(({ recipientId, recipientRole, eventKey, ...n }) => n);
    const billingServices = user.role === 'billing' ? data.visits.filter(v => v.status === 'signed' && (v.billingReadyAt || data.invoices.some(invoice => invoice.visitId === v.id))).map(v => ({
        visitId: v.id, patientId: v.patientId, consultation: v.status === 'signed',
        tests: data.labs.filter(l => l.visitId === v.id && l.status === 'approved').map(l => ({ id: l.id, name: l.testName })),
        charges: chargeOffers(v, data.labs, data.staff, priceList!, data.invoices.find(invoice => invoice.visitId === v.id)),
    })) : [];
    const incompleteReports = data.labs.filter(l => l.status !== 'requested' && l.status !== 'approved' && labProblems(l, data.visits.find(v => v.id === l.visitId)).length);
    const quality = user.role === 'reviewer' ? {
        identityQuestions: data.reviews.filter(r => r.state === 'open' && r.kind === 'identity').length,
        incompleteReports: incompleteReports.length,
        heldImports: data.imports.filter(i => i.state === 'held').length,
        invalidApproved: data.labs.filter(l => l.status === 'approved' && labProblems(l, data.visits.find(v => v.id === l.visitId)).length).length,
        checkedAt: now(),
    } : undefined;
    return {
        user, patients: patients.map(p => ['laboratory', 'billing'].includes(user.role) ? { id: p.id, name: p.name, dob: p.dob, version: p.version, doctorId: p.doctorId, updatedAt: p.updatedAt, source: p.source } : p),
        visits, labs, invoices, reviews, imports, facts, runs: user.role === 'reviewer' ? data.runs : [],
        notifications, billingServices, quality, priceList,
        staff: user.role === 'manager' ? data.staff : data.staff.filter(u => u.role === 'doctor' && u.active).map(u => ({ id: u.id, name: u.name, role: u.role })),
        // History is fetched separately with permission-scoped pagination.
        history: [],
        generatedAt: now(),
    };
}
export async function permittedPatient(user: Staff, id: string) {
    const data = await loadAll();
    const patient = data.patients.find(p => p.id === id);
    if (!patient || !roleCanReadPatient(user, patient, data.labs, data.invoices))
        throw new AppError('This patient is not available to your account.', 403);
    return { patient, data };
}
export async function refreshWarehouse(user: Staff) {
    try {
        return await repository.transaction(async store => {
            const [patients, visits, labs, invoices] = await Promise.all([
                store.find('patients'), store.find('visits'), store.find('labReports'), store.find('invoices'),
            ]);
            const data = { patients, visits, labs, invoices };
            const at = now();
            const runId = newId('RUN');
            const validPatients = new Set(data.patients.map(p => p.id));
            const validVisits = new Map(data.visits.map(v => [v.id, v]));
            const facts = [
                ...data.visits.filter(v => v.status === 'signed' && validPatients.has(v.patientId)).map(v => ({ id: `visit:${v.id}`, source: 'Clinic', sourceId: v.id, kind: 'visit', patientKey: v.patientId, visitId: v.id, date: v.date, service: 'Consultation', total: 0, paid: 0, refreshedAt: at })),
                ...data.labs.filter(l => l.status === 'approved' && !labProblems(l, validVisits.get(l.visitId)).length && validPatients.has(l.patientId)).map(l => ({ id: `lab:${l.id}`, source: 'Laboratory', sourceId: l.sourceRef, kind: 'lab', patientKey: l.patientId, visitId: l.visitId, date: clinicDay(new Date(l.approvedAt || l.collectedAt)), service: l.testName, total: 0, paid: 0, refreshedAt: at })),
                ...data.invoices.filter(b => validPatients.has(b.patientId) && validVisits.get(b.visitId)?.patientId === b.patientId).map(b => ({ id: `invoice:${b.id}`, source: 'Billing', sourceId: b.sourceRef, kind: 'invoice', patientKey: b.patientId, visitId: b.visitId, date: b.date, service: 'Clinic services', total: b.total, paid: b.paid, refreshedAt: at })),
                ...data.invoices.filter(b => validPatients.has(b.patientId) && validVisits.get(b.visitId)?.patientId === b.patientId)
                    .flatMap(b => (b.payments as any[]).filter(p => p.id && Number.isInteger(p.amount) && p.amount > 0 && Number.isFinite(Date.parse(p.at)))
                    .map(p => ({ id: `payment:${b.id}:${p.id}`, source: 'Billing', sourceId: p.id, kind: 'payment', patientKey: b.patientId,
                    visitId: b.visitId, date: clinicDay(new Date(p.at)), service: 'Payment received', total: 0, paid: p.amount, refreshedAt: at }))),
            ];
            const statements: any[] = [store.remove("warehouseFacts")];
            for (let i = 0; i < facts.length; i += 5)
                statements.push(store.insert("warehouseFacts", facts.slice(i, i + 5)));
            statements.push(store.insert("warehouseRuns", { id: runId, at, userId: user.id, count: facts.length, summary: { ...summarizeFacts(facts), formatVersion: 2 } }), store.insert("activityHistory", auditRow(user, 'Refreshed reporting copies', 'warehouse', runId, `${facts.length} checked facts copied. Draft results and held imports excluded.`)));
            await store.batch(statements as any);
            return { count: facts.length, refreshedAt: at };
        }, { lock: 20261103, isolationLevel: 'Serializable' });
    } catch (error) {
        if (['P2034', '40001'].includes((error as any)?.code))
            throw new AppError('Records changed during the reporting update. Please update the figures again.', 409);
        throw error;
    }
}
