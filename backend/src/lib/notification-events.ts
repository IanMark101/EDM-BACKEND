import { EventEmitter } from 'node:events';

export type NotificationChanges = {
  recipients: ReadonlySet<string>;
  sessionsRemoved: boolean;
};

const events = new EventEmitter();

export function publishNotificationChanges(changes: NotificationChanges) {
  if (changes.recipients.size || changes.sessionsRemoved) events.emit('committed', changes);
}

export function onNotificationChanges(listener: (changes: NotificationChanges) => void) {
  events.on('committed', listener);
  return () => events.off('committed', listener);
}
