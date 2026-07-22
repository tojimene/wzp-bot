// Conversaciones con actividad más reciente + su estado de agendado.
import pg from 'pg';
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const { rows: convs } = await client.query(
  `select id, contact_name, contact_handle, contact_external_id, provider, transport,
          stage, mode, mode_locked, ai_enabled, blocked, is_test,
          last_inbound_at, last_outbound_at, respond_after, responding_lock_at
     from conversations
    order by last_message_at desc nulls last
    limit 6`,
);

for (const c of convs) {
  console.log('\n==============================');
  console.log(`conv ${c.id}  name=${c.contact_name}  handle=${c.contact_handle}  ext=${c.contact_external_id}`);
  console.log({ provider: c.provider, transport: c.transport, stage: c.stage, mode: c.mode, mode_locked: c.mode_locked, ai_enabled: c.ai_enabled, blocked: c.blocked, is_test: c.is_test });
  console.log({ last_inbound_at: c.last_inbound_at, last_outbound_at: c.last_outbound_at, respond_after: c.respond_after, responding_lock_at: c.responding_lock_at });
  const { rows: msgs } = await client.query(
    `select role, left(content,70) content, created_at, metadata->>'imported' imported
       from messages where conversation_id=$1 order by created_at desc limit 6`, [c.id]);
  for (const m of msgs.reverse()) console.log(`   [${m.created_at.toISOString()}] ${m.role}: ${m.content} ${m.imported?'(imp)':''}`);
}
console.log('\nNOW =', new Date().toISOString());
await client.end();
