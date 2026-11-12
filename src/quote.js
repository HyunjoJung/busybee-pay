// Deterministic quote engine. Every price, minimum and surcharge comes from config/rate-card.json;
// the AI only extracts shipment facts and picks the matching lane id.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Which shipment quantities a lane needs, derived from its charge bases. */
export function requiredFields(lane, rateCard) {
  const fields = new Set();
  for (const charge of lane.charges) {
    const field = rateCard.basis_quantity_fields[charge.basis];
    if (field) fields.add(field);
  }
  return [...fields];
}

export function findLane(rateCard, laneId) {
  return rateCard.lanes.find((l) => l.id === laneId) || null;
}

/**
 * Build a quote. Returns { ok: true, quote } or { ok: false, missing: [field...] }.
 */
export function buildQuote({ rateCard, lane, shipment }) {
  const missing = requiredFields(lane, rateCard).filter((f) => !(Number(shipment?.[f]) > 0));
  if (missing.length) return { ok: false, missing };

  const currency = rateCard.currency_code;
  const lines = [];
  for (const charge of lane.charges) {
    const field = rateCard.basis_quantity_fields[charge.basis];
    const qty = field ? Number(shipment[field]) : 1;
    const raw = qty * charge.rate;
    if (charge.minimum && raw < charge.minimum) {
      lines.push({
        name: charge.name,
        description: `Minimum charge applies (${qty} ${unitLabel(charge.basis)} x ${charge.rate.toFixed(2)} ${currency} is below the ${charge.minimum.toFixed(2)} minimum)`,
        quantity: 1,
        unit_amount: round2(charge.minimum),
        basis: charge.basis,
      });
    } else {
      lines.push({
        name: charge.name,
        description: `${qty} ${unitLabel(charge.basis)} x ${charge.rate.toFixed(2)} ${currency}`,
        quantity: qty,
        unit_amount: round2(charge.rate),
        basis: charge.basis,
      });
    }
  }

  for (const s of rateCard.surcharges || []) {
    if (s.basis !== 'percent_of') continue;
    const base = lines.filter((l) => s.applies_to.includes(l.name)).reduce((sum, l) => sum + l.quantity * l.unit_amount, 0);
    if (base <= 0) continue;
    lines.push({
      name: s.name,
      description: `${s.rate}% of ${s.applies_to.filter((n) => lines.some((l) => l.name === n)).join(', ')} (${round2(base).toFixed(2)} ${currency})`,
      quantity: 1,
      unit_amount: round2((base * s.rate) / 100),
      basis: 'percent_of',
    });
  }

  for (const l of lines) l.line_total = round2(l.quantity * l.unit_amount);
  const total = round2(lines.reduce((sum, l) => sum + l.line_total, 0));
  return {
    ok: true,
    quote: {
      lane_id: lane.id,
      lane_label: lane.label,
      mode: lane.mode,
      transit_time: lane.transit_time,
      currency_code: currency,
      lines,
      total,
    },
  };
}

function unitLabel(basis) {
  switch (basis) {
    case 'per_kg':
      return 'kg';
    case 'per_pallet':
      return 'pallet(s)';
    case 'per_cbm':
      return 'CBM';
    default:
      return 'shipment';
  }
}
