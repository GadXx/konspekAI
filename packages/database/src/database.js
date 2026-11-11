import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, Migrator, PostgresDialect, SqliteDialect } from 'kysely';
import pg from 'pg';
import { config } from '../../config/src/config.js';
import * as jobsMigration from '../migrations/001_create_jobs.js';
import * as leaseTokenMigration from '../migrations/002_add_job_lease_token.js';
import * as libraryMigration from '../migrations/003_create_library.js';

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
      '003_create_library': { up: libraryMigration.up, down: libraryMigration.down },
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

export async function completeClaimedJob({ id, leaseToken, note }, databaseHandle = getDatabase()) {
  const now = new Date().toISOString();
  return databaseHandle.transaction().execute(async (transaction) => {
    const completed = await transaction
      .updateTable('jobs')
      .set({
        status: 'completed',
        progress: 'completed',
        note_json: JSON.stringify(note),
        error_code: null,
        error_message: null,
        lease_expires_at: null,
        lease_token: null,
        updated_at: now,
      })
      .where('id', '=', id)
      .where('status', '=', 'processing')
      .where('lease_token', '=', leaseToken)
      .returningAll()
      .executeTakeFirst();

    if (!completed) {
      return undefined;
    }

    await transaction.insertInto('library_notes').values({
      id: randomUUID(),
      source_job_id: id,
      folder_id: null,
      title: note.title,
      summary: note.summary,
      sections_json: JSON.stringify(note.sections),
      key_points_json: JSON.stringify(note.key_points),
      markdown: note.markdown,
      summary_type: completed.summary_type,
      language: completed.language,
      summary_language: completed.summary_language,
      created_at: now,
      updated_at: now,
    }).execute();

    return completed;
  });
}

export async function listLibraryFolders(databaseHandle = getDatabase()) {
  const rows = await databaseHandle
    .selectFrom('library_folders')
    .leftJoin('library_notes', 'library_notes.folder_id', 'library_folders.id')
    .select([
      'library_folders.id as id',
      'library_folders.name as name',
      'library_folders.created_at as created_at',
      'library_folders.updated_at as updated_at',
      (expression) => expression.fn.count('library_notes.id').as('note_count'),
    ])
    .groupBy(['library_folders.id', 'library_folders.name', 'library_folders.created_at', 'library_folders.updated_at'])
    .orderBy('library_folders.name', 'asc')
    .execute();
  return rows.map((row) => ({ ...row, note_count: Number(row.note_count) }));
}

export async function listLibraryNotes({ folderId, query, limit = 100, offset = 0 }, databaseHandle = getDatabase()) {
  let selection = databaseHandle.selectFrom('library_notes').select([
    'id', 'folder_id', 'title', 'summary', 'summary_type', 'language', 'summary_language', 'created_at', 'updated_at',
  ]);
  if (folderId === 'unfiled') {
    selection = selection.where('folder_id', 'is', null);
  } else if (folderId) {
    selection = selection.where('folder_id', '=', folderId);
  }
  if (query) {
    const pattern = `%${query}%`;
    selection = selection.where((expression) => expression.or([
      expression('title', 'like', pattern),
      expression('summary', 'like', pattern),
    ]));
  }
  return selection.orderBy('updated_at', 'desc').limit(limit).offset(offset).execute();
}

export async function countLibraryNotes({ folderId, query } = {}, databaseHandle = getDatabase()) {
  let selection = databaseHandle.selectFrom('library_notes').select((expression) => expression.fn.countAll().as('total'));
  if (folderId === 'unfiled') {
    selection = selection.where('folder_id', 'is', null);
  } else if (folderId) {
    selection = selection.where('folder_id', '=', folderId);
  }
  if (query) {
    const pattern = `%${query}%`;
    selection = selection.where((expression) => expression.or([
      expression('title', 'like', pattern),
      expression('summary', 'like', pattern),
    ]));
  }
  const result = await selection.executeTakeFirst();
  return Number(result.total);
}

export async function getLibraryNote(id, databaseHandle = getDatabase()) {
  const note = await databaseHandle.selectFrom('library_notes').selectAll().where('id', '=', id).executeTakeFirst();
  if (!note) {
    return undefined;
  }
  return {
    ...note,
    sections: JSON.parse(note.sections_json),
    key_points: JSON.parse(note.key_points_json),
  };
}

export async function createLibraryFolder({ id, name }, databaseHandle = getDatabase()) {
  const now = new Date().toISOString();
  await databaseHandle.insertInto('library_folders').values({ id, name, created_at: now, updated_at: now }).execute();
  return { id, name, created_at: now, updated_at: now, note_count: 0 };
}

export async function renameLibraryFolder(id, name, databaseHandle = getDatabase()) {
  return databaseHandle.updateTable('library_folders').set({ name, updated_at: new Date().toISOString() })
    .where('id', '=', id).returningAll().executeTakeFirst();
}

export async function deleteLibraryFolder(id, databaseHandle = getDatabase()) {
  return databaseHandle.deleteFrom('library_folders').where('id', '=', id).executeTakeFirst();
}

export async function moveLibraryNote(id, folderId, databaseHandle = getDatabase()) {
  return databaseHandle.updateTable('library_notes').set({ folder_id: folderId, updated_at: new Date().toISOString() })
    .where('id', '=', id).returningAll().executeTakeFirst();
}

export async function deleteLibraryNote(id, databaseHandle = getDatabase()) {
  return databaseHandle.deleteFrom('library_notes').where('id', '=', id).executeTakeFirst();
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
