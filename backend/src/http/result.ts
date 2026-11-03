export type ServiceResult = { body: unknown; status: number; headers: Record<string, string> };
export const result = (body: unknown, status = 200, headers: Record<string, string> = {}): ServiceResult => ({ body, status, headers });
export function responseOf(value: ServiceResult | Response | null | undefined): Response {
  if (value instanceof Response) return value;
  if (!value) return Response.json({ error: 'This action could not be found.' }, { status: 404 });
  return Response.json(value.body, { status: value.status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...value.headers } });
}
