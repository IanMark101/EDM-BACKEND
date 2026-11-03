import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { AppError, type Staff } from '../../../shared/domain';
import { environment } from '../config/environment';
import { onNotificationChanges } from '../lib/notification-events';
import { authenticate } from '../services/server';

const PATH = '/api/notifications/live';
const UPDATE = JSON.stringify({ type: 'notifications:changed' });

type Connection = {
  socket: WebSocket;
  request: Request;
  staff: Staff;
  alive: boolean;
  checking: boolean;
  recheck: boolean;
  pendingUpdate: boolean;
};

export function attachNotificationSockets(server: Server) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const connections = new Set<Connection>();
  let stopped = false;

  async function checkSession(connection: Connection) {
    if (connection.checking || connection.socket.readyState !== WebSocket.OPEN) return;
    connection.checking = true;
    try {
      do {
        connection.recheck = false;
        const staff = await authenticate(connection.request, false);
        if (staff.id !== connection.staff.id || staff.role !== connection.staff.role || staff.mustChangePassword) {
          connection.socket.close(1008, 'Staff session is no longer active');
          return;
        }
        if (connection.socket.readyState !== WebSocket.OPEN) return;
      } while (connection.recheck);

      if (connection.pendingUpdate) {
        connection.pendingUpdate = false;
        connection.socket.send(UPDATE, error => {
          if (error) connection.socket.terminate();
        });
      }
    } catch (error) {
      const unauthorized = error instanceof AppError && (error.status === 401 || error.status === 403);
      connection.socket.close(unauthorized ? 1008 : 1011, unauthorized ? 'Staff session is no longer active' : 'Try reconnecting');
    } finally {
      connection.checking = false;
    }
  }

  const unsubscribe = onNotificationChanges(({ recipients, sessionsRemoved }) => {
    for (const connection of connections) {
      const changed = recipients.has(connection.staff.id);
      if (!changed && !sessionsRemoved) continue;
      if (changed) connection.pendingUpdate = true;
      if (sessionsRemoved) connection.recheck = true;
      void checkSession(connection);
    }
  });

  function onUpgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const onError = () => socket.destroy();
    socket.on('error', onError);

    if (incoming.url !== PATH) return reject('404 Not Found');
    const origin = incoming.headers.origin;
    if (!origin || !environment.origins.includes(origin)) return reject('403 Forbidden');

    const request = new Request(`http://127.0.0.1${PATH}`, {
      headers: { cookie: incoming.headers.cookie || '' },
    });
    const timeout = setTimeout(() => socket.destroy(), 10_000);
    void authenticate(request, false).then(staff => {
      if (stopped || socket.destroyed || socket.writableEnded) return;
      if (staff.mustChangePassword) return reject('403 Forbidden');
      sockets.handleUpgrade(incoming, socket, head, client => {
        const connection: Connection = {
          socket: client, request, staff, alive: true, checking: false, recheck: false, pendingUpdate: false,
        };
        connections.add(connection);
        client.on('pong', () => { connection.alive = true; });
        client.on('error', () => client.terminate());
        client.on('close', () => connections.delete(connection));
        socket.off('error', onError);
        // Check again after subscribing in case a session was revoked during the handshake.
        void checkSession(connection);
      });
    }).catch(error => {
      if (socket.destroyed || socket.writableEnded) return;
      reject(error instanceof AppError && error.status === 401 ? '401 Unauthorized' : '503 Service Unavailable');
    }).finally(() => clearTimeout(timeout));
  }

  server.on('upgrade', onUpgrade);
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      connection.alive = false;
      connection.socket.ping();
      void checkSession(connection);
    }
  }, 30_000);
  heartbeat.unref();

  return () => {
    stopped = true;
    unsubscribe();
    clearInterval(heartbeat);
    server.off('upgrade', onUpgrade);
    for (const connection of connections) connection.socket.terminate();
    sockets.close();
  };
}
