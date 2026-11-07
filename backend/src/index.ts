import express from 'express';
import { Readable } from 'node:stream';
import { routeRequest } from './routes/clinic.routes';
import { environment } from './config/environment';
import { disconnectDatabase } from './config/prisma';
import { startAutomaticBackups } from './services/backup.service';
import { attachNotificationSockets } from './realtime/notifications';
const app = express();
app.disable('x-powered-by');
app.use('/api', async (req, res) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers };
    if (!['GET', 'HEAD'].includes(req.method)) { init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>; init.duplex = 'half'; }
    const request = new Request(req.protocol + '://' + req.get('host') + req.originalUrl, init);
    const response = await routeRequest(request);
    res.status(response.status);
    response.headers.forEach((value, name) => { if (name !== 'set-cookie') res.setHeader(name, value); });
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('set-cookie', cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Clinic HTTP response failed:', { method: req.method, area: req.path.split('/')[1] || 'unknown', error: error instanceof Error ? error.name : 'Unknown error', code: (error as { code?: string })?.code });
    if (!res.headersSent) res.status(500).json({ error: 'The request could not be completed. Refresh the page and try again.' });
    else res.end();
  }
});
app.use((_req, res) => res.status(404).json({ error: 'This action could not be found.' }));
const server = app.listen(environment.port, '127.0.0.1', () => console.log('Express API ready at http://localhost:' + environment.port));
const stopNotifications = attachNotificationSockets(server);
const stopBackups = startAutomaticBackups();
let stopping = false;
async function stop() { if (stopping) return; stopping = true; stopNotifications(); stopBackups(); server.close(); await disconnectDatabase(); process.exit(0); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
