// Diagnóstico rápido de una conversación: estado de agendado + últimos mensajes.
// Uso: node --env-file=../../.env scripts/diag-conv.mjs [handle]
import pg from 'pg';

const handle = process.argv[2] ?? '8686';
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const { rows: convs } = await client.query(
  `select id, organization_id, contact_name, contact_handle, provider, transport,
          stage, mode, mode_locked, ai_enabled, blocked, is_test,
          last_inbound_at, last_outbound_at, last_message_at,
          respond_after, responding_lock_at, tagged_at
     from conversations
    where contact_handle ilike '%'||$1||'%' or contact_external_id ilike '%'||$1||'%'
    order by last_message_at desc nulls last
    limit 5`,
  [handle],
);

for (const c of convs) {
  console.log('\n==============================');
  console.log(`conv ${c.id}  ${c.contact_name}  ${c.contact_handle}`);
  console.log({
    provider: c.provider, transport: c.transport, stage: c.stage,
    mode: c.mode, mode_locked: c.mode_locked, ai_enabled: c.ai_enabled,
    blocked: c.blocked, is_test: c.is_test,
  });
  console.log({
    last_inbound_at: c.last_inbound_at, last_outbound_at: c.last_outbound_at,
    last_message_at: c.last_message_at, respond_after: c.respond_after,
    responding_lock_at: c.responding_lock_at, tagged_at: c.tagged_at,
  });
  const { rows: msgs } = await client.query(
    `select role, left(content, 80) as content, created_at, metadata->>'message_id' as mid,
            metadata->>'imported' as imported
       from messages where conversation_id=$1 order by created_at desc limit 8`,
    [c.id],
  );
  console.log('  últimos mensajes (recientes primero):');
  for (const m of msgs.reverse()) {
    console.log(`   [${m.created_at.toISOString?.() ?? m.created_at}] ${m.role}: ${m.content}  ${m.imported ? '(imported)' : ''}`);
  }
}

await client.end();
