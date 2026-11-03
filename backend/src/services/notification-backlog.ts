import { repository, match, allOf, oneOf } from '../repositories/clinic.repository';
import type { Staff } from '../../../shared/domain';
import { notificationInsert } from './notifications';
// When an existing installation gains notifications, remind each account once
// about actual unfinished work. Do not manufacture past actors or approval events.
export async function ensureNotificationBacklog(user: Staff, data: {
    patients: any[];
    visits: any[];
    labs: any[];
    invoices: any[];
    reviews: any[];
}) {
    const key = `notification-backlog-v1:${user.id}:${user.role}`;
    if ((await repository.find("appSettings", match("key", key))).length)
        return;
    const delivered = await repository.find("staffNotifications", allOf(match("recipientId", user.id), match("recipientRole", user.role)));
    const seen = new Set(delivered.map(n => n.entityId));
    type Reminder = {
        entityId: string;
        patientId?: string;
        subject: string;
        body: string;
        href: string;
    };
    const pending: Reminder[] = [];
    const name = (id: string) => data.patients.find(p => p.id === id)?.name || id;
    if (user.role === 'doctor')
        for (const v of data.visits.filter(v => v.doctorId === user.id && ['waiting', 'draft'].includes(v.status)))
            pending.push({ entityId: v.id, patientId: v.patientId, subject: name(v.patientId), body: 'has a consultation waiting for your attention:', href: `/clinic/visits?open=${v.id}` });
    if (user.role === 'laboratory')
        for (const l of data.labs.filter(l => l.status !== 'approved'))
            pending.push({ entityId: l.id, patientId: l.patientId, subject: name(l.patientId), body: 'has a laboratory request waiting for your attention:', href: `/clinic/laboratory?open=${l.id}` });
    if (user.role === 'billing') {
        for (const v of data.visits.filter(v => v.billingReadyAt && !data.invoices.some(b => b.visitId === v.id)))
            pending.push({ entityId: v.id, patientId: v.patientId, subject: name(v.patientId), body: 'has a visit ready for billing:', href: `/clinic/billing?visit=${v.id}` });
        for (const b of data.invoices.filter(b => b.paid < b.total))
            pending.push({ entityId: b.id, patientId: b.patientId, subject: name(b.patientId), body: 'has a bill with a remaining balance:', href: `/clinic/billing?open=${b.id}` });
    }
    if (user.role === 'registration' || user.role === 'reviewer')
        for (const r of data.reviews.filter(r => r.state === 'open'))
            pending.push({ entityId: r.id, subject: r.recordId, body: 'has a record question waiting for your attention:', href: `/clinic/review?open=${r.id}` });
    const at = new Date().toISOString();
    const rows = pending.filter(r => !seen.has(r.entityId)).map(r => ({
        id: `N-${crypto.randomUUID()}`, recipientId: user.id, recipientRole: user.role, actor: 'CareRecord',
        kind: 'due', body: r.body, subject: r.subject, patientId: r.patientId || null,
        entityId: r.entityId, href: r.href, createdAt: at, eventKey: `existing-work:${user.role}:${r.entityId}`,
    }));
    await repository.batch([
        repository.insert("appSettings", { key, value: at }, { ignore: true }),
        ...notificationInsert(rows),
    ]);
}
