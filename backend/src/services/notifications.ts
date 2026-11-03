import { repository, match, allOf, oneOf } from '../repositories/clinic.repository';
import type { Role, Staff } from '../../../shared/domain';
import type { StaffNotification } from '../repositories/notification.repository';
export type { StaffNotification } from '../repositories/notification.repository';
export { notificationInsert } from '../repositories/notification.repository';
type Event = {
    key: string;
    roles?: Role[];
    staffIds?: string[];
    body: string;
    subject: string;
    kind: 'request' | 'file' | 'edit' | 'created' | 'due' | 'join';
    patientId?: string;
    entityId: string;
    href: string;
};
// Event text deliberately excludes notes, result values, contact details and money references.
export async function notificationRows(actor: Staff, event: Event): Promise<StaffNotification[]> {
    const staff = await repository.find("staffAccounts", match("active", true));
    return staff.filter(person => event.staffIds?.includes(person.id) || event.roles?.includes(person.role as Role))
        .map(person => ({
        id: `N-${crypto.randomUUID()}`, recipientId: person.id, recipientRole: person.role,
        actor: actor.name, kind: event.kind, body: event.body, subject: event.subject,
        patientId: event.patientId || null, entityId: event.entityId, href: event.href,
        createdAt: new Date().toISOString(), eventKey: event.key,
    }));
}
