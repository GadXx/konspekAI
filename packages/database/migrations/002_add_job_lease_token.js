export async function up(database) {
  await database.schema
    .alterTable('jobs')
    .addColumn('lease_token', 'text')
    .execute();
}

export async function down(database) {
  await database.schema.alterTable('jobs').dropColumn('lease_token').execute();
}
