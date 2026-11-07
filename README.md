# EDM-BACKEND

The Node.js and Express API for CareRecord, with Prisma and Neon PostgreSQL.

## Local setup

Use Node.js 22.13 or newer.

Copy `backend/.env.example` to `backend/.env` and set your pooled Neon connection as `DATABASE_URL` and direct connection as `DIRECT_URL`. Then run:

```sh
npm ci
npm run db:migrate
npm run dev
```

For a new empty clinic database, run `npm run clinic:initialize` to create its first account manager. Existing clinic databases already have their own staff accounts.

The API listens on port 3001. Start [EDM-FRONTEND](https://github.com/IanMark101/EDM-FRONTEND) on port 3000 to open the staff workspace. Use `npm run build` to compile the API or `npm run db:check` to verify the database connection.

The `shared/` folder contains the types and rules used by both applications. Keep it synchronized with the other CareRecord repository when updating it.

## Railway deployment

1. Import `EDM-BACKEND` from GitHub into Railway with the repository root `/`. Use the default Dockerfile start command.
2. Add the variables below and deploy. The container applies database migrations at startup and creates `clinic-manager` on the first start with an empty database. Keep the local shared-password practice database separate from the public app.
3. Generate the service's public domain. Set that HTTPS origin as `CLINIC_API_ORIGIN` in Vercel. Check `/api/health` on Railway, then sign in on Vercel with the hosted manager account.

| Railway variable | Value |
| --- | --- |
| `DATABASE_URL` | Pooled Neon URL for the hosted database. |
| `DIRECT_URL` | Direct Neon URL for the same database. |
| `CLINIC_MANAGER_PASSWORD` | A new password of at least 12 characters. Required for the first startup with an empty database. You can remove it after the account is created. |
| `CLINIC_FRONTEND_ORIGINS` | Exact HTTPS origin of the Vercel frontend, without a trailing slash. |

On later starts the backend uses the existing manager account. The container uses Neon for persistent storage. Configure backups in Neon or use a separate durable backup setup.

## Import behavior and checks

Department JSON imports commit the whole file together, including held identity reviews, audit entries and notifications. If a row fails, no changes from that file are saved; correct the cause and resubmit. A previously stranded held source row without an identity-review decision is retried using its stored payload. Imported or reviewed source references remain protected from replacement by a later file.

Laboratory collection timestamps must use ISO 8601 with `Z` or an explicit offset, such as `2026-01-02T09:00:00+08:00`. They are normalized to UTC. Reporting refreshes read and replace their figures in one serializable transaction, with bounded retries for concurrent changes.

Run `npm test` for workflow regression tests and `npm run typecheck` for TypeScript checks. Tests use actual services and repositories with an isolated in-memory database substitute; they do not connect to the configured clinic database.

## Service prices and billing

The account manager sets the clinic-approved prices in **Service prices** (`/clinic/prices`). Existing installations start with an empty price list; enter the actual consultation fee and laboratory test fees before preparing new charges. Test names match the doctor's requested service name, ignoring letter case and repeated spaces.

Only managers can change prices through `/api/service-prices`. Billing selects a completed consultation or valid approved laboratory report, and the backend derives the charge from the active approved price. Each new invoice line retains its service record, responsible staff member and saved price source. Outdated price quotes and repeated linked services are rejected. Additional services go on the visit's existing bill with a reason.

This uses the existing settings and invoice-item storage and requires no schema migration. Earlier invoice amounts, payments, receipts and reports retain their values; missing historical links are labeled rather than invented. Price changes affect future charges only. Older lines with matching service descriptions are recognized when avoiding repeat charges; staff must check earlier generic charges that have no specific service link.

Billing import files retain their format, but new imported charges must match completed services and the manager's approved prices. A price mismatch rejects the file without saving part of it. Identity review cannot override that price check. Existing imported bills are not rewritten.

Deploy the updated backend and frontend together. No example prices are installed automatically.

## Temporary database interruptions

Standalone reads retry once after a recognized connection failure, allowing the pool to acquire a fresh connection. Reads inside a transaction and write operations are not automatically replayed by this recovery path. Persistent connection failures return HTTP 503 with a message asking staff to refresh; after an interrupted save, staff should check the saved records before submitting again.

The connection pool uses bounded connection setup, idle and connection lifetime limits. Workflow regression tests cover read recovery, persistent outages, transaction boundaries and preventing automatic payment replay. Database credentials and validation failures are not treated as temporary outages.
