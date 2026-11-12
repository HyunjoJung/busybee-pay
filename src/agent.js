// "Ask BusyBee" agent console: Gemini function calling over PayPal Agent Toolkit tools.
// Read tools run immediately; write tools are queued for one-click human approval.
import crypto from 'node:crypto';
import { runAgent } from './gemini.js';
import { runTool, toolJsonSchema, toolDescription } from './paypal.js';

const READ_TOOLS = ['list_invoices', 'search_invoicing', 'get_invoice', 'list_transactions'];
const WRITE_TOOLS = ['send_invoice_reminder', 'cancel_sent_invoice'];

const pending = new Map();

function compactInvoice(inv) {
  if (!inv || typeof inv !== 'object') return inv;
  const r = inv.primary_recipients?.[0]?.billing_info;
  return {
    id: inv.id,
    number: inv.detail?.invoice_number,
    status: inv.status,
    reference: inv.detail?.reference,
    invoice_date: inv.detail?.invoice_date,
    amount: inv.amount,
    due_amount: inv.due_amount,
    paid_amount: inv.payments?.paid_amount,
    recipient: r ? { email: r.email_address, business_name: r.business_name } : undefined,
    payer_link: inv.detail?.metadata?.recipient_view_url,
  };
}

// Keep tool results small so the model sees the important fields only.
function compactResult(name, result) {
  if (Array.isArray(result?.items)) return { total_items: result.total_items, items: result.items.map(compactInvoice) };
  if (name === 'get_invoice') return compactInvoice(result);
  return result;
}

export async function askAgent({ message, history, business }) {
  const tools = {};
  for (const name of READ_TOOLS) {
    tools[name] = {
      description: toolDescription(name),
      parameters: toolJsonSchema(name),
      run: async (args) => compactResult(name, await runTool(name, args)),
    };
  }
  const queued = [];
  for (const name of WRITE_TOOLS) {
    tools[name] = {
      description: `${toolDescription(name)}\nIMPORTANT: this action changes data. Calling it only QUEUES the action for the merchant to approve in the UI.`,
      parameters: toolJsonSchema(name),
      run: async (args) => {
        const id = crypto.randomUUID();
        const action = { id, tool: name, args, created_at: new Date().toISOString() };
        pending.set(id, action);
        queued.push(action);
        return { status: 'PENDING_MERCHANT_APPROVAL', approval_id: id, message: 'Queued. Tell the merchant to approve it in the UI.' };
      },
    };
  }
  const today = new Date().toISOString().slice(0, 10);
  const system = `You are BusyBee Pay, the accounts-receivable agent of ${business.business_name}. Today is ${today}.
You can look up PayPal invoices, orders and transactions with the provided PayPal tools (sandbox). Always use the tools to answer questions about invoices or payments; never guess statuses or amounts.
To find unpaid invoices use search_invoicing with resource_type "invoice" and invoice_filters.status (e.g. ["SENT","UNPAID","PARTIALLY_PAID"]).
Write actions (reminders, cancellations) are queued for merchant approval; say clearly that they are waiting for approval.
Answer in short, plain English with invoice numbers, amounts and statuses.`;
  const result = await runAgent({ system, history, message, tools });
  return { ...result, pending: queued };
}

export async function approvePending(id) {
  const action = pending.get(id);
  if (!action) throw new Error('This action was already handled or does not exist.');
  pending.delete(id);
  const result = await runTool(action.tool, action.args);
  return { action, result: compactResult(action.tool, result) };
}

export function rejectPending(id) {
  const action = pending.get(id);
  pending.delete(id);
  return action || null;
}

