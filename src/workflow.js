// Email -> AI triage -> quote / PayPal lookup -> reply draft. Write actions wait for approval.
import { loadBusiness, loadRateCard } from './config.js';
import { analyzeEmail, draftReply, draftInvoiceNote } from './ai.js';
import { buildQuote, findLane, requiredFields } from './quote.js';
import * as paypal from './paypal.js';
import * as store from './store.js';

const FIELD_LABELS = {
  weight_kg: 'total gross weight (kg)',
  pallets: 'number of pallets',
  volume_cbm: 'total volume (CBM)',
};

export async function analyze(emailId) {
  const email = store.getEmail(emailId);
  if (!email) throw new Error('Email not found');
  const business = loadBusiness();
  const rateCard = loadRateCard();
  const timeline = [];

  const { analysis, model } = await analyzeEmail({ email, rateCard, business });
  timeline.push({ step: 'Gemini triage', detail: `${analysis.intent} via ${model}` });

  let quote = null;
  let proposal = null;
  let lookup = null;
  let facts;

  if (analysis.intent === 'quote_request') {
    const lane = analysis.matched_lane_id ? findLane(rateCard, analysis.matched_lane_id) : null;
    if (!lane) {
      proposal = { type: 'reply_only', title: 'No matching lane in the rate card', detail: analysis.lane_match_reason };
      facts = { situation: 'We do not currently serve this route/mode; politely say so and offer to check alternatives.', lanes_we_serve: rateCard.lanes.map((l) => l.label) };
    } else {
      const built = buildQuote({ rateCard, lane, shipment: analysis.shipment });
      if (!built.ok) {
        const missing = built.missing.map((f) => FIELD_LABELS[f] || f);
        proposal = { type: 'request_info', title: 'Ask the customer for missing details', missing };
        facts = { situation: 'Information is missing before we can quote', lane: lane.label, missing_information: missing, required_for_this_lane: requiredFields(lane, rateCard) };
      } else {
        quote = built.quote;
        const recipient = analysis.customer.billing_email || analysis.customer.email;
        proposal = {
          type: 'create_send_invoice',
          title: `Create & send PayPal invoice: ${quote.total.toFixed(2)} ${quote.currency_code}`,
          recipient,
          requires_approval: true,
        };
        facts = null; // reply is drafted after the invoice exists (needs the real PayPal link)
      }
    }
    timeline.push({ step: 'Rate card', detail: quote ? `${quote.lane_label}: ${quote.total.toFixed(2)} ${quote.currency_code}` : proposal.title });
  } else if (analysis.intent === 'payment_status_inquiry' || analysis.intent === 'booking_confirmation') {
    if (!paypal.isConfigured()) throw new Error('PayPal sandbox credentials are missing (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).');
    const { invoices, trace } = await paypal.findInvoices({
      emails: [analysis.customer.billing_email, analysis.customer.email, ...relatedBillingEmails(email)],
      invoiceNumber: analysis.invoice_reference,
    });
    lookup = { invoices, trace };
    timeline.push({ step: 'PayPal lookup', detail: `${invoices.length} invoice(s) found via Agent Toolkit search_invoicing/get_invoice` });
    const latest = invoices[0];
    const unpaid = latest && !['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'].includes(latest.status);
    proposal = latest && unpaid
      ? { type: 'send_reminder', title: `Invoice ${latest.number} is ${latest.status}: send a PayPal reminder?`, invoice_id: latest.id, requires_approval: true }
      : { type: 'reply_only', title: latest ? `Invoice ${latest.number} is ${latest.status}` : 'No PayPal invoice found for this customer' };
    facts = {
      situation: latest ? 'Answer using the PayPal invoice status below (status values come from the PayPal Invoicing API).' : 'No PayPal invoice was found for this customer; ask for the invoice number.',
      invoices: invoices.slice(0, 3).map((i) => ({ number: i.number, status: i.status, total: i.total, paid: i.paid, currency: i.currency_code, last_payment: i.last_payment, payer_link: unpaid ? i.payer_link : undefined })),
    };
  } else {
    proposal = { type: 'no_action', title: 'No customer action needed' };
  }

  let reply = null;
  if (facts) {
    const r = await draftReply({ email, analysis, business, facts });
    reply = r.reply;
    timeline.push({ step: 'Reply draft', detail: `Gemini (${r.model})` });
  }

  const status = proposal.requires_approval ? 'awaiting_approval' : proposal.type === 'no_action' ? 'no_action' : 'replied_draft';
  const thread = store.updateThread(emailId, { status, analysis, quote, proposal, lookup, reply, invoice: null, timeline, paypal_trace: lookup?.trace || [] });
  store.logActivity({ type: 'analyzed', email_id: emailId, intent: analysis.intent, summary: proposal.title });
  return thread;
}

// Customers often reply from a personal address while invoices go to accounts payable.
// Reuse billing emails we already invoiced for the same sender.
function relatedBillingEmails(email) {
  return store
    .listEmails()
    .filter((e) => e.from_email === email.from_email && e.thread?.invoice?.recipient_email)
    .map((e) => e.thread.invoice.recipient_email);
}

export async function approve(emailId) {
  const email = store.getEmail(emailId);
  const thread = email?.thread;
  if (!thread?.proposal?.requires_approval) throw new Error('Nothing to approve for this email.');
  const business = loadBusiness();

  if (thread.proposal.type === 'create_send_invoice') {
    const note = await draftInvoiceNote({ analysis: thread.analysis, quote: thread.quote, business }).catch(() => business.invoice_note);
    const { invoice, trace } = await paypal.createAndSendInvoice({
      quote: thread.quote,
      customer: thread.analysis.customer,
      business,
      reference: `${thread.quote.lane_id} / ${email.subject}`,
      note,
    });
    const facts = {
      situation: 'Quote accepted internally; PayPal invoice created and sent. Share the quote breakdown and the payment link.',
      route: thread.quote.lane_label,
      transit_time: thread.quote.transit_time,
      quote_lines: thread.quote.lines.map((l) => ({ item: l.name, detail: l.description, amount: l.line_total })),
      total: thread.quote.total,
      currency: thread.quote.currency_code,
      paypal_invoice_number: invoice.number,
      paypal_invoice_status: invoice.status,
      payment_link: invoice.payer_link,
      terms: business.invoice_terms,
    };
    const { reply } = await draftReply({ email, analysis: thread.analysis, business, facts });
    const updated = store.updateThread(emailId, {
      status: 'invoiced',
      invoice,
      reply,
      proposal: { ...thread.proposal, requires_approval: false, done: true },
      paypal_trace: trace,
      timeline: [...(thread.timeline || []), { step: 'PayPal invoice', detail: `${invoice.number} ${invoice.status} via Agent Toolkit create_invoice + send_invoice` }, { step: 'Reply draft', detail: 'with PayPal payment link' }],
    });
    store.logActivity({ type: 'invoice_sent', email_id: emailId, invoice_id: invoice.id, number: invoice.number, total: invoice.total, currency: invoice.currency_code });
    return updated;
  }

  if (thread.proposal.type === 'send_reminder') {
    const invoice = await paypal.sendReminder(thread.proposal.invoice_id);
    const updated = store.updateThread(emailId, {
      status: 'reminded',
      proposal: { ...thread.proposal, requires_approval: false, done: true },
      timeline: [...(thread.timeline || []), { step: 'PayPal reminder', detail: `send_invoice_reminder for ${invoice.number}` }],
    });
    store.logActivity({ type: 'reminder_sent', email_id: emailId, invoice_id: invoice.id, number: invoice.number });
    return updated;
  }
  throw new Error(`Unsupported action ${thread.proposal.type}`);
}

export async function refreshInvoice(emailId) {
  const thread = store.getEmail(emailId)?.thread;
  if (!thread?.invoice?.id) throw new Error('No invoice on this thread');
  const invoice = await paypal.getInvoice(thread.invoice.id);
  return store.updateThread(emailId, { invoice });
}
