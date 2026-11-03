import type { Staff } from '../../../shared/domain';
export type ServiceContext = { request: Request; user: Staff; id: string; action: string; input: any; url: URL };
