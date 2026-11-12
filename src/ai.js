// Gemini prompts: email triage + extraction, and customer reply drafting.
import { generateJSON } from './gemini.js';

const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });

export const INTENTS = ['quote_request', 'payment_status_inquiry', 'booking_confirmation', 'other'];

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: INTENTS,
      description:
        'quote_request = customer asks for a price for a shipment; payment_status_inquiry = customer asks whether a payment/invoice was received or what is owed; booking_confirmation = customer accepts a quote or asks to proceed; other = anything else (newsletters, spam, unrelated).',
    },
    intent_reason: { type: 'string', description: 'One short sentence explaining the classification, citing the email.' },
    summary: { type: 'string', description: 'One-sentence summary of what the customer wants.' },
    customer: {
      type: 'object',
      properties: {
        name: nullable('string', { description: 'Sender person name' }),
        company: nullable('string'),
        email: nullable('string', { description: 'Sender email address' }),
        billing_email: nullable('string', { description: 'Email the customer explicitly asked to bill/invoice; null if not stated' }),
      },
      required: ['name', 'company', 'email', 'billing_email'],
    },
    shipment: {
      type: 'object',
      properties: {
        origin: nullable('string'),
        destination: nullable('string'),
        mode: { type: 'string', enum: ['air', 'ocean', 'road', 'unknown'] },
        cargo: nullable('string'),
        weight_kg: nullable('number', { description: 'Total gross weight in kilograms, converted if given in other units' }),
        pallets: nullable('integer'),
        volume_cbm: nullable('number', { description: 'Total volume in cubic meters' }),
        ready_date: nullable('string', { description: 'Pickup/ready date as written or ISO date' }),
        deadline: nullable('string'),
      },
      required: ['origin', 'destination', 'mode', 'cargo', 'weight_kg', 'pallets', 'volume_cbm', 'ready_date', 'deadline'],
    },
    matched_lane_id: nullable('string', {
      description: 'id of the rate-card lane that matches origin, destination AND mode; null if no lane fits or this is not a shipment request.',
    }),
    lane_match_reason: { type: 'string' },
    invoice_reference: nullable('string', { description: 'Invoice number or reference the customer mentions, if any' }),
  },
  required: ['intent', 'intent_reason', 'summary', 'customer', 'shipment', 'matched_lane_id', 'lane_match_reason', 'invoice_reference'],
};

export async function analyzeEmail({ email, rateCard, business }) {
  const lanes = rateCard.lanes.map((l) => ({ id: l.id, origin: l.origin, destination: l.destination, mode: l.mode }));
  const system = `You are the inbox triage agent for ${business.business_name}, ${business.industry}.
Read one customer email and return structured data. Extract only facts that are stated or directly implied in the email; use null for anything not given. Never invent weights, volumes, pallet counts or emails.
For lane matching, compare the shipment to this rate card and choose the single lane whose origin, destination and transport mode all fit (cities in the same metro area or port region count as a match). If the mode is not stated, match only when exactly one lane fits the route.
Rate card lanes (JSON): ${JSON.stringify(lanes)}`;
  const prompt = `Email
From: ${email.from_name || ''} <${email.from_email || ''}>
Subject: ${email.subject || ''}
Received: ${email.received_at || ''}

${email.body}`;
  const { data, model } = await generateJSON({ system, prompt, schema: ANALYSIS_SCHEMA });
  if (data.matched_lane_id && !rateCard.lanes.some((l) => l.id === data.matched_lane_id)) data.matched_lane_id = null;
  if (!data.customer.email) data.customer.email = email.from_email || null;
  return { analysis: data, model };
}

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body: { type: 'string', description: 'Plain-text email body, ready to send.' },
  },
  required: ['subject', 'body'],
};

/**
 * Draft the reply to the customer from verified facts only (quote lines, PayPal invoice data).
 */
export async function draftReply({ email, analysis, business, facts }) {
  const system = `You write concise, friendly, professional customer emails for ${business.business_name}.
Use ONLY the facts provided in FACTS (amounts, invoice numbers, statuses, links, dates). Do not invent prices, dates, tracking numbers or promises.
If FACTS.situation says information is missing, ask for exactly the missing items in a short bulleted list.
Always mention the PayPal invoice number when one is given. If a PayPal payment link is provided, include it on its own line. Sign as "${business.reply_signature}".
Format the body as plain text with real line breaks: a greeting line, one or two short sentences, then (when quote lines are given) a bulleted list "- item: amount currency", the total on its own line, the payment link on its own line, and the sign-off. Keep it under 170 words.`;
  const prompt = `ORIGINAL EMAIL
From: ${email.from_name || ''} <${email.from_email || ''}>
Subject: ${email.subject}

${email.body}

TRIAGE
${JSON.stringify({ intent: analysis.intent, summary: analysis.summary }, null, 1)}

FACTS
${JSON.stringify(facts, null, 1)}`;
  const { data, model } = await generateJSON({ system, prompt, schema: REPLY_SCHEMA });
  return { reply: data, model };
}

const NOTE_SCHEMA = {
  type: 'object',
  properties: { note: { type: 'string', description: 'Short invoice note to the customer, max 3 sentences.' } },
  required: ['note'],
};

/** A short, shipment-specific note printed on the PayPal invoice. */
export async function draftInvoiceNote({ analysis, quote, business }) {
  const system = `You write the note printed on a PayPal invoice for ${business.business_name}. Mention the route, cargo and transit time from the data, then the merchant's standard terms. Use only the given data. Max 3 sentences.`;
  const prompt = JSON.stringify({ shipment: analysis.shipment, lane: quote.lane_label, transit_time: quote.transit_time, standard_note: business.invoice_note, terms: business.invoice_terms });
  const { data } = await generateJSON({ system, prompt, schema: NOTE_SCHEMA });
  return data.note;
}
