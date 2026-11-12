import express from 'express';
import path from 'node:path';
import { ROOT, settings, setupStatus, loadBusiness, loadRateCard } from './config.js';
import * as store from './store.js';
import * as workflow from './workflow.js';
import * as paypal from './paypal.js';
import { askAgent, approvePending, rejectPending } from './agent.js';

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(ROOT, 'public')));

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    console.error(`[${req.method} ${req.path}]`, err.message);
    res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({ error: err.message });
  }
};

app.get('/api/status', wrap(async () => ({ ...setupStatus(), business: loadBusiness(), rateCard: loadRateCard() })));
app.get('/api/emails', wrap(async () => store.listEmails()));
app.get('/api/emails/:id', wrap(async (req) => store.getEmail(req.params.id)));
app.post(
  '/api/emails',
  wrap(async (req) => {
    const { from_name, from_email, subject, body } = req.body || {};
    if (!body || !String(body).trim()) throw Object.assign(new Error('Email body is required'), { status: 400 });
    return store.addEmail({ from_name: from_name || 'Unknown sender', from_email: from_email || 'unknown@example.com', subject: subject || '(no subject)', body: String(body) });
  }),
);
app.post('/api/emails/:id/analyze', wrap(async (req) => workflow.analyze(req.params.id)));
app.post('/api/emails/:id/approve', wrap(async (req) => workflow.approve(req.params.id)));
app.post('/api/emails/:id/refresh', wrap(async (req) => workflow.refreshInvoice(req.params.id)));
app.post('/api/emails/:id/redraft', wrap(async (req) => workflow.redraft(req.params.id)));

app.get('/api/invoices', wrap(async () => paypal.listInvoices()));
app.get('/api/invoices/:id', wrap(async (req) => paypal.getInvoice(req.params.id)));
app.get('/api/invoices/:id/qr', async (req, res) => {
  try {
    const qr = await paypal.invoiceQr(req.params.id);
    const b64 = typeof qr === 'string' ? qr : qr?.qr_code || qr?.image || qr?.text || '';
    const m = String(b64).match(/[A-Za-z0-9+/=]{200,}/);
    if (!m) throw new Error('No QR image in PayPal response');
    res.type('png').send(Buffer.from(m[0], 'base64'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(
  '/api/agent',
  wrap(async (req) => {
    const { message, history } = req.body || {};
    if (!message) throw Object.assign(new Error('message is required'), { status: 400 });
    const out = await askAgent({ message, history: Array.isArray(history) ? history : [], business: loadBusiness() });
    store.logActivity({ type: 'agent', message, tools: out.steps.map((s) => s.tool) });
    return out;
  }),
);
app.post(
  '/api/agent/approve/:id',
  wrap(async (req) => {
    const out = await approvePending(req.params.id);
    store.logActivity({ type: 'agent_action_approved', tool: out.action.tool, args: out.action.args });
    return out;
  }),
);
app.post('/api/agent/reject/:id', wrap(async (req) => ({ rejected: rejectPending(req.params.id) })));

app.get('/api/activity', wrap(async () => store.listActivity()));
app.post('/api/reset', wrap(async () => (store.reset(), { ok: true })));

app.listen(settings.port, () => {
  const s = setupStatus();
  console.log(`BusyBee Pay running at http://localhost:${settings.port}`);
  console.log(`  Gemini: ${s.gemini ? 'configured' : 'MISSING GEMINI_API_KEY'} (models: ${s.geminiModels.join(', ')})`);
  console.log(`  PayPal: ${s.paypal ? `configured (${s.paypalEnvironment})` : 'MISSING PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET'}`);
});
