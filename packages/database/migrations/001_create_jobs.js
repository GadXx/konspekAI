export async function up(database) {
  await database.schema
    .createTable('jobs')
    .ifNotExists()
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('input_kind', 'text', (column) => column.notNull())
    .addColumn('input_text', 'text')
    .addColumn('source_path', 'text')
    .addColumn('language', 'text', (column) => column.notNull())
    .addColumn('summary_language', 'text', (column) => column.notNull())
    .addColumn('summary_type', 'text', (column) => column.notNull())
    .addColumn('dev_mode', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('recognized_text', 'text')
    .addColumn('normalized_transcript', 'text')
    .addColumn('note_json', 'text')
    .addColumn('error_code', 'text')
    .addColumn('error_message', 'text')
    .addColumn('attempt_count', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'text', (column) => column.notNull())
    .addColumn('lease_expires_at', 'text')
    .addColumn('progress', 'text', (column) => column.notNull().defaultTo('queued'))
    .addColumn('created_at', 'text', (column) => column.notNull())
    .addColumn('updated_at', 'text', (column) => column.notNull())
    .addColumn('expires_at', 'text', (column) => column.notNull())
    .execute();
  await database.schema
    .createIndex('jobs_queue_idx')
    .ifNotExists()
    .on('jobs')
    .columns(['status', 'next_attempt_at', 'created_at'])
    .execute();
  await database.schema
    .createIndex('jobs_expiry_idx')
    .ifNotExists()
    .on('jobs')
    .column('expires_at')
    .execute();
}

export async function down(database) {
  await database.schema.dropTable('jobs').ifExists().execute();
}
