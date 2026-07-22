import pg from 'pg';
const id = process.argv[2];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const now = new Date().toISOString();
const { rowCount } = await client.query(
  `update conversations
      set respond_after = $2, last_inbound_at = $2, responding_lock_at = null, updated_at = $2
    where id = $1`, [id, now]);
console.log(`Actualizadas ${rowCount} filas. respond_after=${now}`);
await client.end();
