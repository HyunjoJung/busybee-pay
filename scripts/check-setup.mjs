// Verifies your .env: calls Gemini once and asks PayPal for an OAuth token (sandbox by default).
import { settings } from '../src/config.js';

let ok = true;

async function checkGemini() {
  if (!settings.gemini.apiKey) {
    console.log('✗ GEMINI_API_KEY is empty. Create a free key at https://aistudio.google.com/apikey');
    return false;
  }
  for (const model of settings.gemini.models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.gemini.apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with OK' }] }] }),
    });
    if (res.ok) {
      console.log(`✓ Gemini reachable with model ${model}`);
      return true;
    }
    const err = await res.json().catch(() => ({}));
    console.log(`  ${model}: HTTP ${res.status} ${err?.error?.message || ''}`);
  }
  console.log('✗ None of the configured Gemini models answered. Adjust GEMINI_MODEL / GEMINI_FALLBACK_MODELS.');
  return false;
}

async function checkPayPal() {
  const { clientId, clientSecret, environment } = settings.paypal;
  if (!clientId || !clientSecret) {
    console.log('✗ PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are empty. Create a sandbox app at https://developer.paypal.com/dashboard/applications/sandbox');
    return false;
  }
  const base = environment === 'PRODUCTION' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    console.log(`✗ PayPal OAuth failed (HTTP ${res.status}). Check the client id/secret and PAYPAL_ENVIRONMENT=${environment}.`);
    return false;
  }
  const data = await res.json();
  const invoicing = String(data.scope || '').includes('invoicing');
  console.log(`✓ PayPal ${environment} OAuth token received${invoicing ? ' (invoicing scope present)' : ''}`);
  return true;
}

ok = (await checkGemini()) && ok;
ok = (await checkPayPal()) && ok;
process.exit(ok ? 0 : 1);
