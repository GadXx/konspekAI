import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, Migrator, PostgresDialect, SqliteDialect } from 'kysely';
import pg from 'pg';
import { config } from '../../config/src/config.js';
import * as jobsMigration from '../migrations/001_create_jobs.js';
import * as leaseTokenMigration from '../migrations/002_add_job_lease_token.js';

let database;

export function getDatabase() {
  if (database) {
    return database;
  }
  if (config.databaseDialect === 'sqlite') {
    mkdirSync(dirname(config.sqlitePath), { recursive: true });
    const sqlite = new Database(config.sqlitePath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma(`busy_timeout = ${config.databaseBusyTimeoutMs}`);
    sqlite.pragma('foreign_keys = ON');
    database = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
    return database;
  }
  database = new Kysely({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: config.databaseUrl, max: 10 }) }),
  });
  return database;
}

export async function closeDatabase() {
  if (database) {
    await database.destroy();
    database = undefined;
  }
}

export async function migrate(databaseHandle = getDatabase()) {
  const migrator = new Migrator({
    db: databaseHandle,
    provider: {
      getMigrations: async () => ({
      '001_create_jobs': { up: jobsMigration.up, down: jobsMigration.down },
      '002_add_job_lease_token': { up: leaseTokenMigration.up, down: leaseTokenMigration.down },
      }),
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    throw error;
  }
}

export async function enqueueJob(job, databaseHandle = getDatabase()) {
  await databaseHandle.insertInto('jobs').values(job).execute();
}

export async function getJob(id, databaseHandle = getDatabase()) {
  return databaseHandle.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function claimNextJob({ leaseSeconds, now = new Date().toISOString() }, databaseHandle = getDatabase()) {
  const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
  const leaseToken = randomUUID();
  return databaseHandle.transaction().execute(async (transaction) => {
    let candidateQuery = transaction
      .selectFrom('jobs')
      .selectAll()
      .where('status', '=', 'queued')
      .where('next_attempt_at', '<=', now)
      .where('expires_at', '>', now)
      .orderBy('created_at', 'asc')
      .limit(1);
    if (config.databaseDialect === 'postgres') {
      candidateQuery = candidateQuery.forUpdate().skipLocked();
    }
    const candidate = await candidateQuery.executeTakeFirst();
    if (!candidate) {
      return undefined;
    }
    return transaction
      .updateTable('jobs')
      .set({ status: 'processing', progress: 'processing', lease_expires_at: leaseExpiresAt, lease_token: leaseToken, updated_at: now, attempt_count: candidate.attempt_count + 1 })
      .where('id', '=', candidate.id)
      .where('status', '=', 'queued')
      .returningAll()
      .executeTakeFirst();
  });
}

export async function recoverExpiredLeases(now = new Date().toISOString(), databaseHandle = getDatabase()) {
  const failed = await databaseHandle
    .updateTable('jobs')
    .set({ status: 'failed', progress: 'failed', lease_expires_at: null, lease_token: null, next_attempt_at: now, updated_at: now, error_code: 'WORKER_LEASE_EXPIRED', error_message: 'The job exceeded its maximum processing attempts.' })
    .where('status', '=', 'processing')
    .where('lease_expires_at', '<=', now)
    .where('attempt_count', '>=', config.jobMaxAttempts)
    .returning('id')
    .execute();
  const recovered = await databaseHandle
    .updateTable('jobs')
    .set({ status: 'queued', progress: 'queued', lease_expires_at: null, lease_token: null, next_attempt_at: now, updated_at: now })
    .where('status', '=', 'processing')
    .where('lease_expires_at', '<=', now)
    .where('attempt_count', '<', config.jobMaxAttempts)
    .returning('id')
    .execute();
  return failed.length + recovered.length;
}

export async function updateClaimedJob(id, leaseToken, fields, databaseHandle = getDatabase()) {
  return databaseHandle
    .updateTable('jobs')
    .set({ ...fields, updated_at: new Date().toISOString() })
    .where('id', '=', id)
    .where('status', '=', 'processing')
    .where('lease_token', '=', leaseToken)
    .returningAll()
    .executeTakeFirst();
}

export async function updateJob(id, fields, databaseHandle = getDatabase()) {
  const updated = await databaseHandle
    .updateTable('jobs')
    .set({ ...fields, updated_at: new Date().toISOString() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
  return updated;
}

export async function getExpiredJobs(now = new Date().toISOString(), databaseHandle = getDatabase()) {
  return databaseHandle.selectFrom('jobs').selectAll()
    .where('expires_at', '<=', now)
    .where((expression) => expression.or([
      expression('status', '!=', 'processing'),
      expression('lease_expires_at', '<=', now),
    ]))
    .execute();
}

export async function getReferencedMediaPaths(databaseHandle = getDatabase()) {
  const rows = await databaseHandle.selectFrom('jobs').select('source_path').where('source_path', 'is not', null).execute();
  return rows.map((row) => row.source_path);
}

export async function deleteExpiredJobs(now = new Date().toISOString(), databaseHandle = getDatabase()) {
  const expired = await getExpiredJobs(now, databaseHandle);
  if (expired.length > 0) {
    await databaseHandle.deleteFrom('jobs')
      .where('expires_at', '<=', now)
      .where((expression) => expression.or([
        expression('status', '!=', 'processing'),
        expression('lease_expires_at', '<=', now),
      ]))
      .execute();
  }
  return expired;
}
