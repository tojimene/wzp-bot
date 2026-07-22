const dsn = process.env.UNIPILE_DSN;
const apiKey = process.env.UNIPILE_API_KEY;
const res = await fetch(`https://${dsn}/api/v1/webhooks`, {
  headers: { 'X-API-KEY': apiKey, accept: 'application/json' },
});
const data = await res.json();
const list = Array.isArray(data) ? data : (data.items ?? data.data ?? []);
for (const w of list) {
  console.log(`- source=${w.source} name=${w.name} url=${w.request_url ?? w.url} id=${w.id ?? w.webhook_id}`);
}
