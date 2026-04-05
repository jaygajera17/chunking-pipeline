# Chunking Pipeline (Bootstrap)

This repository contains the first implementation bootstrap for the reliable recording pipeline in `plan.md`:

- Next.js app with a plain recording page
- OPFS-first chunk persistence
- Hono API route scaffolding for sessions/chunks/finalize/reconcile/transcriptions
- Drizzle schema and config bootstrap
- MinIO/OpenAI/Postgres env wiring

## 1) Install

```bash
npm install
```

## 2) Configure Environment

Copy `.env.example` to `.env` and fill values:

- `DATABASE_URL`
- `MINIO_*`
- `OPENAI_API_KEY`

## 3) Run Development Server

```bash
npm run dev
```

Open `http://localhost:3000`.

## 4) Database Commands

```bash
npm run db:generate
npm run db:push
npm run db:migrate
npm run db:studio
```

## 5) Quality Checks

```bash
npm run typecheck
npm run lint
```

## Bootstrap Notes

- Current API uses an in-memory bootstrap store to validate flow and endpoint contracts.
- Drizzle schema and storage clients are ready, but durable DB/MinIO writes are the next step.
- UI is intentionally minimal and function-first.
