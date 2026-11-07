import { controllers } from '../controllers/clinic.controller';
type Route = { method: string; area: string; id?: string; action?: string; handler: (request: Request) => Promise<Response> };
// Specific routes precede area routes, retaining the existing API contract.
export const routes: Route[] = [
  { method: 'GET', area: 'session', handler: controllers.session },
  { method: 'GET', area: 'health', handler: controllers.health },
  { method: 'POST', area: 'account', id: 'password', handler: controllers.password },
  { method: 'POST', area: 'staff', action: 'reset-password', handler: controllers.resetPassword },
  { method: 'GET', area: 'clinic-settings', handler: controllers.clinicSettings },
  { method: 'POST', area: 'clinic-settings', handler: controllers.clinicSettings },
  { method: 'GET', area: 'service-prices', handler: controllers.servicePrices },
  { method: 'POST', area: 'service-prices', handler: controllers.servicePrices },
  { method: 'POST', area: 'labs', action: 'doctor-review', handler: controllers.doctorReview },
  { method: 'POST', area: 'labs', action: 'patient-release', handler: controllers.patientResultRelease },
  { method: 'GET', area: 'documents', handler: controllers.document },
  { method: 'POST', area: 'login', handler: controllers.login },
  { method: 'POST', area: 'logout', handler: controllers.logout },
  { method: 'POST', area: 'heartbeat', handler: controllers.heartbeat },
  { method: 'GET', area: 'data', handler: controllers.data },
  { method: 'GET', area: 'history', handler: controllers.history },
  { method: 'GET', area: 'patient-access', handler: controllers.patientAccess },
  { method: 'POST', area: 'patient-access', handler: controllers.patientAccess },
  { method: 'GET', area: 'patient-portal', handler: controllers.patientPortal },
  { method: 'POST', area: 'patient-portal', id: 'activate', handler: controllers.patientActivate },
  { method: 'POST', area: 'patient-portal', id: 'login', handler: controllers.patientLogin },
  { method: 'POST', area: 'patient-portal', id: 'logout', handler: controllers.patientLogout },
  { method: 'GET', area: 'reports.csv', handler: controllers.reportExport },
  { method: 'POST', area: 'views', handler: controllers.recordView },
  { method: 'POST', area: 'notifications', handler: controllers.notifications },
  { method: 'POST', area: 'check-ins', handler: controllers.checkIns },
  { method: 'POST', area: 'patients', handler: controllers.patients },
  { method: 'POST', area: 'visits', handler: controllers.visits },
  { method: 'POST', area: 'labs', handler: controllers.labs },
  { method: 'POST', area: 'invoices', handler: controllers.invoices },
  { method: 'POST', area: 'reviews', handler: controllers.reviews },
  { method: 'POST', area: 'imports', handler: controllers.imports },
  { method: 'POST', area: 'warehouse', id: 'refresh', handler: controllers.warehouse },
  { method: 'POST', area: 'staff', handler: controllers.staff },
];
export function resolveRoute(method: string, path: string[]) {
  return routes.find(r => r.method === method && r.area === path[0] && (!r.id || r.id === path[1]) && (!r.action || r.action === path[2]));
}

export function routeRequest(request: Request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return controllers.notFound(request);
  const path = url.pathname.slice(5).split('/').filter(Boolean);
  return (resolveRoute(request.method, path)?.handler || controllers.notFound)(request);
}
