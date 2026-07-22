import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const tables = ['workflows','workflow_runs','tag_definitions','conversation_tags','conversation_tag_removals'];
for (const t of tables) {
  const { rows } = await c.query(`select to_regclass('public.'||$1) as reg`, [t]);
  console.log(`${rows[0].reg ? '✅' : '❌'} ${t}`);
}
const { rows: col } = await c.query(`select column_name from information_schema.columns where table_name='conversations' and column_name='tagged_at'`);
console.log(`${col.length ? '✅' : '❌'} conversations.tagged_at`);
await c.end();
