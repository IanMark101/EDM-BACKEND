import { AppError, type Staff } from '../../../shared/domain';
import { authenticate, audit } from '../services/server';
import { ensureSeed } from '../repositories/seed';
import { requireSameOrigin } from '../services/security';
import * as clinic from '../services/clinic.service';
import * as operations from '../services/operations.service';
import { servicePricesService } from '../services/pricing.service';
import { historyService } from '../services/history.service';
import * as portal from '../services/patient-portal.service';
import { isTemporaryDatabaseError } from '../lib/database-recovery';
import type { ServiceContext } from '../http/context';
import type { ServiceResult } from '../http/result';
type Endpoint = { auth?: boolean; limit?: number; service: (context: ServiceContext) => Promise<ServiceResult | Response | null | undefined> };
import { responseOf, result } from '../http/result';

async function bodyOf(request: Request, limit = 100_000) {
  const text = await request.text();
  if (text.length > limit) throw new AppError(limit === 20_000 ? 'This submission is too large.' : 'This file is too large. Import at most 50 records at a time.', 413);
  try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new AppError('The request must contain a valid JSON object.', 400); }
}
async function finishUnusedBody(request: Request) {
  if (request.bodyUsed || !request.body) return;
  const reader = request.body.getReader(); let bytes = 0;
  try { while (bytes <= 100_000) { const chunk = await reader.read(); if (chunk.done) return; bytes += chunk.value.byteLength; } await reader.cancel(); }
  catch { /* Disconnected caller. */ } finally { reader.releaseLock(); }
}
async function clinicController(request: Request, route?: Endpoint): Promise<Response> {
  let user: Staff | undefined; const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean); const [area, id = '', action = ''] = path;
  try {
    if (request.method === 'GET' && area === 'health') return responseOf(result({ ok: true, service: 'care-record-backend' }));
    await ensureSeed(request);
    if (request.method !== 'GET') requireSameOrigin(request);
    if (request.method === 'GET' && area === 'session') {
      try { return responseOf(result({ user: await authenticate(request, false) })); }
      catch (error) { if (error instanceof AppError && error.status === 401) return responseOf(result({ user: null })); throw error; }
    }
    if (route?.auth !== false) {
      user = await authenticate(request, area !== 'data');
      if (user.mustChangePassword && !['account', 'logout', 'heartbeat', 'data'].includes(area)) throw new AppError('Replace your temporary password in Account & password before continuing.', 403);
    }
    if (!route) throw new AppError('This action could not be found.', 404);
    const input = request.method === 'GET' ? undefined : await bodyOf(request, route.limit);
    return responseOf(await route.service({ request, user: user!, id, action, input, url }));
  } catch (error) {
    const failure = error instanceof Error ? `${error.message} ${(error.cause as Error | undefined)?.message || ''}` : '';
    if ((error as any)?.code === 'P2002' && /queue|one_active_checkin/.test(JSON.stringify((error as any).meta || {}) + failure)) return responseOf(result({ error: 'This patient was just checked in by another staff member. Refresh the waiting list.' }, 409));
    if (error instanceof AppError) {
      if (user && error.status === 403) await audit(user, 'Access refused', 'permission', url.pathname.slice(0, 160), 'Server refused an action outside the staff account permissions.').catch(() => {});
      return responseOf(result({ error: error.message, fields: error.fields }, error.status));
    }
    if (isTemporaryDatabaseError(error)) {
      console.warn('Clinic database connection is temporarily unavailable. No write was automatically replayed.');
      return responseOf(result({
        code: 'DATABASE_UNAVAILABLE',
        error: request.method === 'GET'
          ? 'The database connection was interrupted. Try refreshing the records again.'
          : 'The database connection was interrupted. Refresh the records to check whether your change was saved before trying again.',
      }, 503, { 'Retry-After': '1' }));
    }
    console.error('Clinic request failed:', error instanceof Error ? error.message : 'Unknown error');
    return responseOf(result({ error: 'The request could not be completed. Refresh the page and try again.' }, 500));
  } finally { await finishUnusedBody(request); }
}

const controller = (endpoint?: Endpoint) => (request: Request) => clinicController(request, endpoint);
export const controllers = {
  session: controller(), health: controller(), notFound: controller(),
  login: controller({ service: clinic.loginService, auth: false }),
  logout: controller({ service: clinic.logoutService }),
  heartbeat: controller({ service: clinic.heartbeatService }),
  data: controller({ service: clinic.dataService }),
  history: controller({ service: historyService }),
  patientAccess: controller({ service: portal.patientAccessService, limit: 20_000 }),
  patientPortal: controller({ service: portal.patientPortalRecords, auth: false }),
  patientActivate: controller({ service: portal.activatePatientPortal, auth: false, limit: 20_000 }),
  patientLogin: controller({ service: portal.loginPatientPortal, auth: false, limit: 20_000 }),
  patientLogout: controller({ service: portal.logoutPatientPortal, auth: false, limit: 20_000 }),
  reportExport: controller({ service: clinic.reportExportService }),
  recordView: controller({ service: clinic.recordViewService }),
  notifications: controller({ service: clinic.notificationsService }),
  checkIns: controller({ service: clinic.checkInsService }),
  patients: controller({ service: clinic.patientsService }),
  visits: controller({ service: clinic.visitsService }),
  labs: controller({ service: clinic.labsService }),
  invoices: controller({ service: clinic.invoicesService }),
  reviews: controller({ service: clinic.reviewsService }),
  imports: controller({ service: clinic.importsService }),
  warehouse: controller({ service: clinic.warehouseService }),
  staff: controller({ service: clinic.staffService }),
  password: controller({ service: operations.passwordService, limit: 20_000 }),
  resetPassword: controller({ service: operations.resetPasswordService, limit: 20_000 }),
  clinicSettings: controller({ service: operations.clinicSettingsService, limit: 20_000 }),
  servicePrices: controller({ service: servicePricesService, limit: 20_000 }),
  doctorReview: controller({ service: operations.doctorReviewService, limit: 20_000 }),
  patientResultRelease: controller({ service: operations.patientResultReleaseService, limit: 20_000 }),
  document: controller({ service: operations.documentService, limit: 20_000 }),
};
