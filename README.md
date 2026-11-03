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
