export async function up(database) {
  await database.schema
    .createTable('library_folders')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('created_at', 'text', (column) => column.notNull())
    .addColumn('updated_at', 'text', (column) => column.notNull())
    .execute();

  await database.schema
    .createTable('library_notes')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('source_job_id', 'text', (column) => column.notNull().unique())
    .addColumn('folder_id', 'text', (column) => column.references('library_folders.id').onDelete('cascade'))
    .addColumn('title', 'text', (column) => column.notNull())
    .addColumn('summary', 'text', (column) => column.notNull())
    .addColumn('sections_json', 'text', (column) => column.notNull())
    .addColumn('key_points_json', 'text', (column) => column.notNull())
    .addColumn('markdown', 'text', (column) => column.notNull())
    .addColumn('summary_type', 'text', (column) => column.notNull())
    .addColumn('language', 'text', (column) => column.notNull())
    .addColumn('summary_language', 'text', (column) => column.notNull())
    .addColumn('created_at', 'text', (column) => column.notNull())
    .addColumn('updated_at', 'text', (column) => column.notNull())
    .execute();

  await database.schema.createIndex('library_notes_folder_idx').on('library_notes').column('folder_id').execute();
  await database.schema.createIndex('library_notes_updated_idx').on('library_notes').column('updated_at').execute();
}

export async function down(database) {
  await database.schema.dropTable('library_notes').ifExists().execute();
  await database.schema.dropTable('library_folders').ifExists().execute();
}
