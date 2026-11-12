// End-to-end smoke test against a running server (npm start in another terminal).
// 1) triage the Busan->LA quote email, 2) approve -> PayPal sandbox invoice is created & sent,
// 3) triage the follow-up "did you receive my payment?" email -> live PayPal status lookup.
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

const t1 = await post('/api/emails/e1/analyze');
console.log(`e1 intent=${t1.analysis.intent} lane=${t1.analysis.matched_lane_id} quote=${t1.quote?.total} ${t1.quote?.currency_code}`);
console.log(`   proposal: ${t1.proposal.title}`);

const t1b = await post('/api/emails/e1/approve');
console.log(`   PayPal invoice ${t1b.invoice.number} status=${t1b.invoice.status}`);
console.log(`   payer link: ${t1b.invoice.payer_link}`);

const t4 = await post('/api/emails/e4/analyze');
console.log(`e4 intent=${t4.analysis.intent} -> ${t4.proposal.title}`);
for (const inv of t4.lookup?.invoices || []) console.log(`   ${inv.number} ${inv.status} ${inv.total} ${inv.currency_code}`);
console.log(`   reply: ${t4.reply?.subject}`);
