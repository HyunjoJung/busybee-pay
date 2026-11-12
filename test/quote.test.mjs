import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuote, requiredFields } from '../src/quote.js';

// A small synthetic rate card so the tests do not depend on the demo prices.
const rateCard = {
  currency_code: 'USD',
  lanes: [
    {
      id: 'A_B_AIR',
      label: 'A -> B (Air)',
      mode: 'air',
      transit_time: '2 days',
      charges: [
        { name: 'Air freight', basis: 'per_kg', rate: 2, minimum: 100 },
        { name: 'Handling', basis: 'per_pallet', rate: 10 },
        { name: 'Docs', basis: 'per_shipment', rate: 5 },
      ],
    },
  ],
  surcharges: [{ name: 'Fuel surcharge', basis: 'percent_of', applies_to: ['Air freight'], rate: 10 }],
  basis_quantity_fields: { per_kg: 'weight_kg', per_pallet: 'pallets', per_cbm: 'volume_cbm', per_shipment: null },
};
const lane = rateCard.lanes[0];

test('required fields are derived from the lane charge bases', () => {
  assert.deepEqual(requiredFields(lane, rateCard).sort(), ['pallets', 'weight_kg']);
});

test('missing quantities are reported instead of guessing', () => {
  const r = buildQuote({ rateCard, lane, shipment: { weight_kg: 300, pallets: null } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['pallets']);
});

test('prices every line from the rate card and applies the percentage surcharge', () => {
  const r = buildQuote({ rateCard, lane, shipment: { weight_kg: 300, pallets: 2 } });
  assert.equal(r.ok, true);
  const byName = Object.fromEntries(r.quote.lines.map((l) => [l.name, l.line_total]));
  assert.equal(byName['Air freight'], 600);
  assert.equal(byName['Handling'], 20);
  assert.equal(byName['Docs'], 5);
  assert.equal(byName['Fuel surcharge'], 60);
  assert.equal(r.quote.total, 685);
});

test('minimum charge applies to small shipments', () => {
  const r = buildQuote({ rateCard, lane, shipment: { weight_kg: 20, pallets: 1 } });
  const air = r.quote.lines.find((l) => l.name === 'Air freight');
  assert.equal(air.line_total, 100);
  assert.equal(air.quantity, 1);
  const fuel = r.quote.lines.find((l) => l.name === 'Fuel surcharge');
  assert.equal(fuel.line_total, 10);
});
