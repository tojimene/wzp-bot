import pg from 'pg';
const id = process.argv[2];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(
  `select contact_name, contact_handle, ai_enabled, blocked, respond_after, responding_lock_at, last_inbound_at, last_outbound_at, stage, tagged_at
     from conversations where id=$1`, [id]);
console.log(rows[0]);
const { rows: msgs } = await client.query(
  `select role, left(content,80) content, created_at, metadata->>'imported' imp from messages where conversation_id=$1 order by created_at desc limit 6`, [id]);
console.log('mensajes (recientes primero):');
for (const m of msgs) console.log(`  [${m.created_at.toISOString()}] ${m.role}: ${m.content} ${m.imp?'(imp)':''}`);
console.log('NOW', new Date().toISOString());
await client.end();
