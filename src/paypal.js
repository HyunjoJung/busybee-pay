// PayPal layer built on the official PayPal Agent Toolkit (@paypal/agent-toolkit).
// The same toolkit tools are used two ways:
//   1) directly, for the approved inbox workflow (create -> send -> track invoices)
//   2) as Gemini function-calling tools in the agent console (see agent.js)
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { settings } from './config.js';

const ACTIONS = {
  invoices: {
    create: true,
    list: true,
    get: true,
    send: true,
    sendReminder: true,
    search: true,
    generateQRC: true,
    cancel: true,
  },
  transactions: { list: true },
};

let toolkit = null;

export class PayPalError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

export function isConfigured() {
  return Boolean(settings.paypal.clientId && settings.paypal.clientSecret);
}

function getToolkit() {
  if (!isConfigured()) throw new PayPalError('PayPal sandbox credentials are missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.');
  if (!toolkit) {
    toolkit = new PayPalAgentToolkit({
      clientId: settings.paypal.clientId,
      clientSecret: settings.paypal.clientSecret,
      configuration: {
        actions: ACTIONS,
        context: { sandbox: settings.paypal.environment !== 'PRODUCTION' },
      },
    });
  }
  return toolkit;
}

export function getTools() {
  return getToolkit().getTools();
}

/** JSON schema of a toolkit tool (used for Gemini function declarations). */
export function toolJsonSchema(name) {
  const schema = zodToJsonSchema(getTools()[name].parameters, { $refStrategy: 'none' });
  delete schema.$schema;
  return schema;
}

export function toolDescription(name) {
  return (getTools()[name].description || '').trim();
}

/** Validate args with the tool's own zod schema, execute it, and parse the JSON result. */
export async function runTool(name, args = {}) {
  const tool = getTools()[name];
  if (!tool) throw new PayPalError(`Unknown PayPal tool: ${name}`);
  const parsed = tool.parameters.safeParse(args);
  if (!parsed.success) {
    throw new PayPalError(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  let raw = await tool.execute(parsed.data, { toolCallId: `busybee-${Date.now()}`, messages: [] });
  let result = typeof raw === 'string' ? safeJson(raw) : raw;
  if (result?.error && /401|unauthori[sz]ed|expired/i.test(JSON.stringify(result.error))) {
    // Access tokens expire; rebuild the toolkit once to fetch a fresh token.
    toolkit = null;
    raw = await getTools()[name].execute(parsed.data, { toolCallId: `busybee-${Date.now()}`, messages: [] });
    result = typeof raw === 'string' ? safeJson(raw) : raw;
  }
  if (result?.error) {
    throw new PayPalError(`${name} failed: ${result.error.message || JSON.stringify(result.error)}`, result.error);
  }
  return result;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function invoiceIdFrom(result) {
  if (result?.id) return result.id;
  const href = result?.href || result?.links?.find((l) => l.rel === 'self')?.href;
  const m = href && href.match(/invoices\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return undefined;
  if (parts.length === 1) return { given_name: parts[0] };
  return { given_name: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] };
}

/** Map a PayPal invoice resource to the small shape the UI needs. */
export function summarizeInvoice(inv) {
  if (!inv) return null;
  const recipient = inv.primary_recipients?.[0]?.billing_info || {};
  const payments = inv.payments?.transactions || [];
  return {
    id: inv.id,
    number: inv.detail?.invoice_number,
    status: inv.status,
    reference: inv.detail?.reference,
    invoice_date: inv.detail?.invoice_date,
    currency_code: inv.amount?.currency_code || inv.detail?.currency_code,
    total: inv.amount?.value,
    due: inv.due_amount?.value,
    paid: inv.payments?.paid_amount?.value,
    recipient_email: recipient.email_address,
    recipient_name: [recipient.name?.given_name, recipient.name?.surname].filter(Boolean).join(' ') || recipient.business_name,
    recipient_business: recipient.business_name,
    payer_link: inv.detail?.metadata?.recipient_view_url,
    created_at: inv.detail?.metadata?.create_time,
    last_payment: payments.length
      ? {
          date: payments[payments.length - 1].payment_date,
          method: payments[payments.length - 1].method,
          amount: payments[payments.length - 1].amount?.value,
          transaction_id: payments[payments.length - 1].payment_id,
        }
      : null,
  };
}

export async function getInvoice(invoiceId) {
  return summarizeInvoice(await runTool('get_invoice', { invoice_id: invoiceId }));
}

/**
 * Create a draft PayPal invoice from a quote, send it to the customer and return the live invoice.
 * Returns { invoice, trace } where trace lists every toolkit call that was made.
 */
export async function createAndSendInvoice({ quote, customer, business, reference, note }) {
  const trace = [];
  const currency = quote.currency_code;
  const items = quote.lines.map((l) => ({
    name: l.name.slice(0, 200),
    description: l.description.slice(0, 1000),
    quantity: String(l.quantity),
    unit_amount: { currency_code: currency, value: l.unit_amount.toFixed(2) },
    unit_of_measure: 'QUANTITY',
  }));
  const billing = {
    email_address: customer.billing_email || customer.email,
    ...(customer.company ? { business_name: customer.company } : {}),
    ...(splitName(customer.name) ? { name: splitName(customer.name) } : {}),
  };
  const createArgs = {
    currency_code: currency,
    invoice_date: new Date().toISOString().slice(0, 10),
    reference: reference?.slice(0, 120),
    note: note?.slice(0, 4000),
    invoicer_business_name: business.business_name,
    primary_recipients: [{ billing_info: billing }],
    items,
  };
  const created = await runTool('create_invoice', createArgs);
  const invoiceId = invoiceIdFrom(created);
  trace.push({ tool: 'create_invoice', args: { ...createArgs, items: `${items.length} line items` }, result: { invoice_id: invoiceId } });
  if (!invoiceId) throw new PayPalError('PayPal did not return an invoice id', created);

  const sent = await runTool('send_invoice', { invoice_id: invoiceId, send_to_recipient: true });
  trace.push({ tool: 'send_invoice', args: { invoice_id: invoiceId, send_to_recipient: true }, result: sent });

  const invoice = await getInvoice(invoiceId);
  trace.push({ tool: 'get_invoice', args: { invoice_id: invoiceId }, result: { status: invoice.status, number: invoice.number } });
  if (!invoice.payer_link && sent?.href) invoice.payer_link = sent.href;
  return { invoice, trace };
}

/** Find invoices for a customer (by billing email, sender email and/or invoice number). */
export async function findInvoices({ emails = [], invoiceNumber }) {
  const trace = [];
  const found = new Map();
  const queries = [];
  if (invoiceNumber) queries.push({ invoice_number: invoiceNumber });
  for (const e of [...new Set(emails.filter(Boolean))]) queries.push({ recipient_email: e });
  for (const filters of queries) {
    const res = await runTool('search_invoicing', { resource_type: 'invoice', invoice_filters: filters, page_size: 20 });
    const items = res.items || [];
    trace.push({ tool: 'search_invoicing', args: { invoice_filters: filters }, result: { matches: items.length } });
    for (const it of items) found.set(it.id, it);
  }
  const invoices = [];
  for (const id of found.keys()) {
    invoices.push(await getInvoice(id));
    trace.push({ tool: 'get_invoice', args: { invoice_id: id }, result: { status: invoices[invoices.length - 1].status } });
  }
  invoices.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { invoices, trace };
}

export async function listInvoices() {
  const res = await runTool('list_invoices', { page: 1, page_size: 20, total_required: true });
  return (res.items || []).map(summarizeInvoice);
}

export async function sendReminder(invoiceId, note) {
  await runTool('send_invoice_reminder', { invoice_id: invoiceId, ...(note ? { note } : {}) });
  return getInvoice(invoiceId);
}

export async function invoiceQr(invoiceId) {
  return runTool('generate_invoice_qr_code', { invoice_id: invoiceId, width: 300, height: 300 });
}

