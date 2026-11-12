const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { emails: [], selected: null, busy: false, status: null, chat: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

const INTENT_LABEL = {
  quote_request: 'Quote request',
  payment_status_inquiry: 'Payment status inquiry',
  booking_confirmation: 'Booking confirmation',
  other: 'Other / no action',
};
const PAID = ['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'];

function statusBadge(status) {
  if (!status) return '';
  const cls = PAID.includes(status) ? 'ok' : ['CANCELLED', 'REFUNDED'].includes(status) ? 'bad' : 'blue';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function threadBadges(thread) {
  if (!thread) return '<span class="badge">New</span>';
  const b = [`<span class="badge intent">${esc(INTENT_LABEL[thread.analysis?.intent] || thread.analysis?.intent || '')}</span>`];
  if (thread.status === 'awaiting_approval') b.push('<span class="badge wait">Needs approval</span>');
  if (thread.invoice) b.push(statusBadge(thread.invoice.status));
  if (thread.status === 'reminded') b.push('<span class="badge blue">Reminder sent</span>');
  return b.join('');
}

function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function money(v, cur) {
  if (v === undefined || v === null || v === '') return '-';
  return `${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur || ''}`.trim();
}

// ---------- setup chips ----------
async function loadStatus() {
  state.status = await api('/api/status');
  const s = state.status;
  $('#setup-chips').innerHTML = `
    <span class="chip ${s.gemini ? 'ok' : 'bad'}"><span class="dot"></span>Gemini ${esc(s.geminiModels[0] || '')}</span>
    <span class="chip ${s.paypal ? 'ok' : 'bad'}"><span class="dot"></span>PayPal Agent Toolkit · ${esc(s.paypalEnvironment)}</span>
    <span class="chip"><span class="dot" style="background:#f5b301"></span>${esc(s.rateCard.lanes.length)} lanes in rate card</span>`;
}

// ---------- inbox ----------
async function loadEmails() {
  state.emails = await api('/api/emails');
  renderInbox();
}

function renderInbox() {
  $('#email-list').innerHTML = state.emails
    .map(
      (e) => `<li class="email-item ${state.selected === e.id ? 'active' : ''}" data-id="${esc(e.id)}">
        <div class="top"><span class="from">${esc(e.from_name)}</span><span class="time">${esc(fmtTime(e.received_at))}</span></div>
        <div class="subject">${esc(e.subject)}</div>
        <div class="snippet">${esc(e.body.slice(0, 160))}</div>
        <div class="badges">${threadBadges(e.thread)}</div>
      </li>`,
    )
    .join('');
}

$('#email-list').addEventListener('click', (ev) => {
  const li = ev.target.closest('.email-item');
  if (!li) return;
  state.selected = li.dataset.id;
  renderInbox();
  renderDetail();
});

// ---------- detail ----------
function current() {
  return state.emails.find((e) => e.id === state.selected);
}

function kv(label, value) {
  const empty = value === null || value === undefined || value === '';
  return `<div><div class="k">${esc(label)}</div><div class="v ${empty ? 'null' : ''}">${empty ? 'not stated' : esc(value)}</div></div>`;
}

function pipelineHtml(thread) {
  const p = thread?.proposal || {};
  const done = (cond) => Boolean(cond);
  let stages;
  if (p.type === 'create_send_invoice') {
    stages = [
      ['Gemini triage', true],
      ['Rate-card quote', done(thread.quote)],
      ['Human approval', done(p.done)],
      ['PayPal invoice', done(thread.invoice)],
      ['Reply draft + pay link', done(thread.invoice && thread.reply)],
    ];
  } else if (p.type === 'request_info') {
    stages = [['Gemini triage', true], ['Rate-card check', true], ['Ask for missing details', done(thread.reply)]];
  } else if (thread?.lookup) {
    stages = [['Gemini triage', true], ['PayPal lookup', true], ['Reply draft', done(thread.reply)]];
    if (p.type === 'send_reminder') stages.push(['Approve reminder', done(p.done)]);
  } else if (p.type === 'reply_only') {
    stages = [['Gemini triage', true], ['Reply draft', done(thread.reply)]];
  } else {
    stages = [['Gemini triage', true], ['No action needed', true]];
  }
  const firstOpen = stages.findIndex(([, d]) => !d);
  return `<div class="pipeline">${stages
    .map(([name, d], i) => `<span class="stage ${d ? 'done' : i === firstOpen ? 'active' : ''}">${d ? '✓' : i + 1} ${esc(name)}</span>`)
    .join('<span class="arrow">›</span>')}</div>`;
}
function renderDetail(error) {
  const e = current();
  const root = $('#detail');
  if (!e) {
    root.innerHTML = '<div class="empty">Select an email to start.</div>';
    return;
  }
  const t = e.thread;
  const a = t?.analysis;
  let html = `
    <div class="mail-head">
      <h2>${esc(e.subject)}</h2>
      <div class="meta">From <b>${esc(e.from_name)}</b> &lt;${esc(e.from_email)}&gt; · ${esc(fmtTime(e.received_at))}</div>
    </div>
    <div class="mail-body">${esc(e.body)}</div>
    <div class="analyze-bar">
      <button class="btn honey" id="btn-analyze" ${state.busy ? 'disabled' : ''}>${state.busy === 'analyze' ? '<span class="spinner"></span> Gemini is reading the email...' : t ? 'Re-analyze with AI' : 'Analyze with AI'}</button>
      <span class="muted">${t ? `Last run ${esc(fmtTime(t.updated_at))}` : 'Gemini classifies the email, extracts shipment facts and matches your rate card.'}</span>
    </div>
    ${t ? pipelineHtml(t) : ''}`;
  if (error) html += `<div class="error">${esc(error)}</div>`;

  if (a) {
    const s = a.shipment || {};
    html += `<div class="cards">
      <div class="card">
        <h3>AI triage <span class="src">Gemini</span></h3>
        <div class="lead"><span class="badge intent">${esc(INTENT_LABEL[a.intent] || a.intent)}</span> ${esc(a.summary)}</div>
        <div class="muted" style="margin-bottom:10px">${esc(a.intent_reason)}</div>
        <div class="kv">
          ${kv('Customer', a.customer?.name)}${kv('Company', a.customer?.company)}${kv('Bill to', a.customer?.billing_email || a.customer?.email)}
          ${a.intent === 'quote_request' ? kv('Origin', s.origin) + kv('Destination', s.destination) + kv('Mode', s.mode) + kv('Cargo', s.cargo) + kv('Weight (kg)', s.weight_kg) + kv('Pallets', s.pallets) + kv('Volume (CBM)', s.volume_cbm) + kv('Ready date', s.ready_date) + kv('Rate-card lane', a.matched_lane_id) : kv('Invoice reference', a.invoice_reference)}
        </div>
        ${a.intent === 'quote_request' ? `<div class="muted" style="margin-top:8px">Lane match: ${esc(a.lane_match_reason)}</div>` : ''}
      </div>`;

    if (t.quote) {
      const q = t.quote;
      html += `<div class="card">
        <h3>Quote <span class="src" style="color:#8a6100;background:#fff4d1">rate-card config</span></h3>
        <div class="lead">${esc(q.lane_label)} · transit ${esc(q.transit_time)}</div>
        <table class="lines"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead><tbody>
        ${q.lines.map((l) => `<tr><td>${esc(l.name)}<div class="desc">${esc(l.description)}</div></td><td class="num">${esc(l.quantity)}</td><td class="num">${money(l.unit_amount)}</td><td class="num">${money(l.line_total)}</td></tr>`).join('')}
        <tr class="total"><td colspan="3">Total</td><td class="num">${money(q.total, q.currency_code)}</td></tr></tbody></table>
      </div>`;
    }

    if (t.lookup) {
      html += `<div class="card">
        <h3>PayPal lookup <span class="src pp">Agent Toolkit</span></h3>
        ${t.lookup.invoices.length ? t.lookup.invoices.map((i) => `<div class="invoice-item"><div class="top"><span class="num">${esc(i.number)}</span>${statusBadge(i.status)}</div><div class="who">${esc(i.recipient_email || '')}</div><div class="bottom"><span class="amt">${money(i.total, i.currency_code)}</span><span class="muted">${i.last_payment ? `Paid ${esc(i.last_payment.date || '')}` : `Due ${money(i.due, i.currency_code)}`}</span></div></div>`).join('') : '<div class="muted">No PayPal invoice found for this customer.</div>'}
        <ul class="trace">${t.lookup.trace.map((s) => `<li><span class="tool">${esc(s.tool)}</span> ${esc(JSON.stringify(s.args))} → ${esc(JSON.stringify(s.result))}</li>`).join('')}</ul>
      </div>`;
    }

    if (t.proposal) {
      const p = t.proposal;
      const done = p.done || !p.requires_approval;
      html += `<div class="card proposal ${done ? 'done' : ''}">
        <h3>${done ? 'Agent action' : 'Proposed action · needs your approval'}</h3>
        <div class="row">
          <div><div class="title">${esc(p.title)}</div>
          ${p.recipient ? `<div class="muted">Recipient: ${esc(p.recipient)}</div>` : ''}
          ${p.missing ? `<ul>${p.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
          ${p.detail ? `<div class="muted">${esc(p.detail)}</div>` : ''}</div>
          ${p.requires_approval && !p.done ? `<button class="btn primary" id="btn-approve" ${state.busy ? 'disabled' : ''}>${state.busy === 'approve' ? '<span class="spinner"></span> Calling PayPal...' : p.type === 'send_reminder' ? 'Approve & send reminder' : 'Approve & send PayPal invoice'}</button>` : p.done ? '<span class="badge ok">Done</span>' : ''}
        </div>
      </div>`;
    }

    if (t.invoice) {
      const inv = t.invoice;
      html += `<div class="card">
        <h3>PayPal invoice <span class="src pp">Invoicing API via Agent Toolkit</span></h3>
        <div class="invoice-box">
          <div>
            <div class="big-status">${esc(inv.number)} ${statusBadge(inv.status)}</div>
            <div style="margin:6px 0">${money(inv.total, inv.currency_code)} · to ${esc(inv.recipient_email)}</div>
            ${inv.last_payment ? `<div class="badge ok">Payment received ${esc(inv.last_payment.date || '')} · ${esc(inv.last_payment.method || '')}</div>` : ''}
            <div style="margin-top:8px">Payment link: <a href="${esc(inv.payer_link)}" target="_blank" rel="noopener">${esc(inv.payer_link)}</a></div>
            <div style="margin-top:10px"><button class="btn ghost small" id="btn-refresh-inv" ${state.busy ? 'disabled' : ''}>${state.busy === 'refresh' ? '<span class="spinner"></span>' : 'Refresh status from PayPal'}</button></div>
          </div>
          <img alt="PayPal invoice QR code" src="/api/invoices/${encodeURIComponent(inv.id)}/qr" onerror="this.style.display='none'" />
        </div>
        ${t.paypal_trace?.length ? `<ul class="trace">${t.paypal_trace.map((s) => `<li><span class="tool">${esc(s.tool)}</span> → ${esc(JSON.stringify(s.result))}</li>`).join('')}</ul>` : ''}
      </div>`;
    }

    if (t.reply) {
      html += `<div class="card">
        <h3>Reply draft <span class="src">Gemini · facts only</span></h3>
        <div class="reply-subject">${esc(t.reply.subject)}</div>
        <div class="reply-body">${esc(t.reply.body)}</div>
        <div style="margin-top:8px"><button class="btn ghost small" id="btn-copy">Copy reply</button></div>
      </div>`;
    }
    html += '</div>';
  }
  root.innerHTML = html;

  $('#btn-analyze')?.addEventListener('click', () => run('analyze', `/api/emails/${e.id}/analyze`));
  $('#btn-approve')?.addEventListener('click', () => run('approve', `/api/emails/${e.id}/approve`));
  $('#btn-refresh-inv')?.addEventListener('click', () => run('refresh', `/api/emails/${e.id}/refresh`));
  $('#btn-copy')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(`Subject: ${t.reply.subject}\n\n${t.reply.body}`).catch(() => {});
    toast('Reply copied');
  });
}

async function run(kind, path) {
  state.busy = kind;
  renderDetail();
  let error;
  try {
    await api(path, { method: 'POST' });
    if (kind !== 'analyze') loadInvoices();
  } catch (err) {
    error = err.message;
  }
  state.busy = false;
  await loadEmails();
  renderDetail(error);
}

// ---------- invoices ----------
async function loadInvoices() {
  const list = $('#invoice-list');
  if (!state.status?.paypal) {
    list.innerHTML = '<li class="muted" style="padding:10px">Add PayPal sandbox credentials to .env to see invoices.</li>';
    return;
  }
  list.innerHTML = '<li class="muted" style="padding:10px"><span class="spinner"></span> Loading from PayPal...</li>';
  try {
    const invoices = await api('/api/invoices');
    $('#inv-updated').textContent = `Sandbox · updated ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    list.innerHTML = invoices.length
      ? invoices
          .map(
            (i) => `<li class="invoice-item"><div class="top"><span class="num">${esc(i.number)}</span>${statusBadge(i.status)}</div>
            <div class="who">${esc(i.recipient_business || i.recipient_name || '')} · ${esc(i.recipient_email || '')}</div>
            <div class="bottom"><span class="amt">${money(i.total, i.currency_code)}</span>${i.payer_link ? `<a href="${esc(i.payer_link)}" target="_blank" rel="noopener">payer view</a>` : ''}</div></li>`,
          )
          .join('')
      : '<li class="muted" style="padding:10px">No invoices yet.</li>';
  } catch (err) {
    list.innerHTML = `<li class="error" style="margin:0">${esc(err.message)}</li>`;
  }
}
$('#btn-refresh-invoices').addEventListener('click', loadInvoices);

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $('#tab-invoices').classList.toggle('hidden', btn.dataset.tab !== 'invoices');
    $('#tab-agent').classList.toggle('hidden', btn.dataset.tab !== 'agent');
  }),
);

// ---------- agent chat ----------
function addMsg(cls, html) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  $('#chat').appendChild(div);
  div.scrollIntoView({ block: 'end' });
  return div;
}

$('#chat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMsg('user', esc(message));
  const thinking = addMsg('bot', '<span class="spinner"></span> Thinking with PayPal tools...');
  try {
    const out = await api('/api/agent', { method: 'POST', body: { message, history: state.chat } });
    thinking.remove();
    if (out.steps?.length) addMsg('tools', out.steps.map((s) => `▸ ${esc(s.tool)}(${esc(JSON.stringify(s.args))})`).join('\n'));
    addMsg('bot', esc(out.text));
    for (const p of out.pending || []) {
      const div = addMsg('pending', `<b>Approval needed:</b> ${esc(p.tool)} ${esc(JSON.stringify(p.args))}<div class="actions"><button class="btn primary small" data-act="approve">Approve</button><button class="btn ghost small" data-act="reject">Reject</button></div>`);
      div.addEventListener('click', async (e2) => {
        const act = e2.target.dataset?.act;
        if (!act) return;
        div.querySelectorAll('button').forEach((b) => (b.disabled = true));
        try {
          const r = await api(`/api/agent/${act}/${p.id}`, { method: 'POST' });
          div.innerHTML = act === 'approve' ? `<b>Done:</b> ${esc(p.tool)} executed in PayPal. ${r.result?.status ? `Status: ${esc(r.result.status)}` : ''}` : '<b>Rejected.</b>';
          loadInvoices();
        } catch (err) {
          div.innerHTML = `<b>Failed:</b> ${esc(err.message)}`;
        }
      });
    }
    state.chat.push({ role: 'user', text: message }, { role: 'assistant', text: out.text });
  } catch (err) {
    thinking.innerHTML = `Error: ${esc(err.message)}`;
  }
});

$('#suggest').addEventListener('click', (ev) => {
  const b = ev.target.closest('.chip-btn');
  if (!b) return;
  $('#chat-input').value = b.textContent.trim();
  $('#chat-form').requestSubmit();
});

// ---------- paste email ----------
$('#btn-paste').addEventListener('click', () => $('#paste-dialog').showModal());
$('#paste-form').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'add') return;
  const fd = new FormData(ev.target);
  const body = Object.fromEntries(fd.entries());
  try {
    const rec = await api('/api/emails', { method: 'POST', body });
    ev.target.reset();
    state.selected = rec.id;
    await loadEmails();
    renderDetail();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- boot ----------
await loadStatus().catch((err) => toast(err.message));
await loadEmails();
if (state.emails.length) {
  state.selected = state.emails[0].id;
  renderInbox();
  renderDetail();
}
loadInvoices();


