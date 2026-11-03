import { environment } from '../config/environment';
import { AppError, type Staff } from '../../../shared/domain';
export const SESSION_COOKIE = 'carerecord_session'; export const IDLE_MS = 20 * 60_000; export const SESSION_MS = 8 * 60 * 60_000;
export { randomToken, digest, hashPassword, constantEqual } from '../lib/crypto';
export function cookieToken(request: Request) { return request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) || ''; }
export function sessionCookie(token: string, request: Request, clear = false) { return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_MS / 1000}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
export function requireSameOrigin(request: Request) { const origin = request.headers.get('origin'); const allowed = environment.origins; if (!origin || (origin !== new URL(request.url).origin && !allowed.includes(origin))) throw new AppError('This request did not come from the clinic application.', 403); if (!request.headers.get('content-type')?.includes('application/json')) throw new AppError('Send this request as JSON.', 415); }
export function sessionExpired(session: { expiresAt: string; lastSeen: string }, now = Date.now()) { return Date.parse(session.expiresAt) <= now || Date.parse(session.lastSeen) + IDLE_MS <= now; }
export function roleCanReadPatient(user: Staff, patient: any, labs: any[], bills: any[]) { if (user.role === 'manager') return false; if (user.role === 'doctor') return patient.doctorId === user.id; if (user.role === 'laboratory') return labs.some(l => l.patientId === patient.id); return true; }
