/*
 * Plain-node checks for the logic that does not need a browser.
 *   node test/logic.test.js
 *
 * Covers eircode parsing, the pricing model, and — most importantly — proves the
 * geodesic area formula the app relies on returns true ground area at Irish
 * latitudes, where a naive flat/pixel measurement is badly wrong.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

/* ── Load the browser modules into a stubbed window ──────── */

const store = new Map();
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const f of ['js/rates.js', 'js/geo.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
}
const { Rates, Geo } = sandbox;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n      ' + e.message);
    process.exitCode = 1;
  }
}

/* ── Eircodes ────────────────────────────────────────────── */

console.log('\nEircode parsing');

check('accepts a standard eircode', () => {
  assert.strictEqual(Geo.normaliseEircode('A65F4E2'), 'A65 F4E2');
});
check('normalises spacing, case and hyphens', () => {
  assert.strictEqual(Geo.normaliseEircode('  a65 f4e2 '), 'A65 F4E2');
  assert.strictEqual(Geo.normaliseEircode('a65-f4e2'), 'A65 F4E2');
});
check('accepts the D6W routing-key exception', () => {
  assert.strictEqual(Geo.normaliseEircode('D6WY827'), 'D6W Y827');
});
check('accepts Dublin routing keys', () => {
  assert.strictEqual(Geo.normaliseEircode('D02X285'), 'D02 X285');
});
check('rejects excluded letters in the routing key', () => {
  // B, G, I, J, L, M, O, Q, S, U, Z are not in the eircode alphabet.
  assert.strictEqual(Geo.normaliseEircode('B65F4E2'), null);
  assert.strictEqual(Geo.normaliseEircode('Z65F4E2'), null);
});
check('rejects wrong length', () => {
  assert.strictEqual(Geo.normaliseEircode('A65F4E'), null);
  assert.strictEqual(Geo.normaliseEircode('A65F4E23'), null);
});
check('rejects a plain address', () => {
  assert.strictEqual(Geo.normaliseEircode('12 Main Street, Athlone'), null);
  assert.strictEqual(Geo.looksLikeEircode('Athlone'), false);
});

/* ── Geodesic area ───────────────────────────────────────── */

console.log('\nGeodesic area (the maths behind the sqm figure)');

const R = 6378137;                       // metres — same sphere Google uses
const rad = (d) => (d * Math.PI) / 180;

/* Google's computeSignedArea, reimplemented so we can verify it offline. */
function computeArea(pts) {
  if (pts.length < 3) return 0;
  const polarTriangleArea = (t1, lng1, t2, lng2) => {
    const dLng = lng1 - lng2;
    const t = t1 * t2;
    return 2 * Math.atan2(t * Math.sin(dLng), 1 + t * Math.cos(dLng));
  };
  let total = 0;
  let prev = pts[pts.length - 1];
  let prevTanLat = Math.tan((Math.PI / 2 - rad(prev.lat)) / 2);
  let prevLng = rad(prev.lng);
  for (const p of pts) {
    const tanLat = Math.tan((Math.PI / 2 - rad(p.lat)) / 2);
    const lng = rad(p.lng);
    total += polarTriangleArea(tanLat, lng, prevTanLat, prevLng);
    prevTanLat = tanLat;
    prevLng = lng;
  }
  return Math.abs(total * R * R);
}

/* Build a rectangle of known ground dimensions around a point. */
function rectangle(lat, lng, widthM, heightM) {
  const dLat = (heightM / R) * (180 / Math.PI);
  const dLng = (widthM / (R * Math.cos(rad(lat)))) * (180 / Math.PI);
  return [
    { lat: lat,        lng: lng },
    { lat: lat,        lng: lng + dLng },
    { lat: lat + dLat, lng: lng + dLng },
    { lat: lat + dLat, lng: lng },
  ];
}

const ATHLONE = { lat: 53.4239, lng: -7.9407 };

check('a 10 m × 5 m rectangle measures 50 m² (typical patio)', () => {
  const a = computeArea(rectangle(ATHLONE.lat, ATHLONE.lng, 10, 5));
  assert.ok(Math.abs(a - 50) < 0.05, `got ${a.toFixed(3)} m², expected ~50`);
});

check('a 20 m × 6 m rectangle measures 120 m² (typical driveway)', () => {
  const a = computeArea(rectangle(ATHLONE.lat, ATHLONE.lng, 20, 6));
  assert.ok(Math.abs(a - 120) < 0.1, `got ${a.toFixed(3)} m², expected ~120`);
});

check('holds at Malin Head and Mizen Head (Ireland\'s latitude range)', () => {
  for (const lat of [51.45, 55.38]) {
    const a = computeArea(rectangle(lat, -7.5, 20, 6));
    assert.ok(Math.abs(a - 120) < 0.1, `at ${lat}°N got ${a.toFixed(3)} m²`);
  }
});

check('vertex order does not change the magnitude', () => {
  const r = rectangle(ATHLONE.lat, ATHLONE.lng, 20, 6);
  assert.ok(Math.abs(computeArea(r) - computeArea(r.slice().reverse())) < 1e-6);
});

check('an L-shaped drive equals the sum of its two rectangles', () => {
  // 20×6 spine with a 6×4 apron off the end.
  const dLat6 = (6 / R) * (180 / Math.PI);
  const dLat10 = (10 / R) * (180 / Math.PI);
  const perM = (180 / Math.PI) / (R * Math.cos(rad(ATHLONE.lat)));
  const x0 = ATHLONE.lng, y0 = ATHLONE.lat;
  const L = [
    { lat: y0,          lng: x0 },
    { lat: y0,          lng: x0 + 20 * perM },
    { lat: y0 + dLat6,  lng: x0 + 20 * perM },
    { lat: y0 + dLat6,  lng: x0 + 6 * perM },
    { lat: y0 + dLat10, lng: x0 + 6 * perM },
    { lat: y0 + dLat10, lng: x0 },
  ];
  const expected = 20 * 6 + 6 * 4;   // 120 + 24
  const a = computeArea(L);
  assert.ok(Math.abs(a - expected) < 0.15, `got ${a.toFixed(3)} m², expected ~${expected}`);
});

check('flat Web Mercator pixel maths would be ~2.8× too big at 53°N', () => {
  // This is the trap the app avoids by using geodesic area rather than pixels.
  const inflation = 1 / Math.pow(Math.cos(rad(53.4239)), 2);
  assert.ok(inflation > 2.7 && inflation < 2.9, `inflation factor ${inflation.toFixed(3)}`);
});

check('fewer than 3 points is zero, not an error', () => {
  assert.strictEqual(Geo.areaOfPath([]), 0);
  assert.strictEqual(Geo.areaOfPath([{}, {}]), 0);
});

/* ── Area formatting ─────────────────────────────────────── */

console.log('\nFormatting');

check('formats areas at sensible precision', () => {
  assert.strictEqual(Geo.formatArea(4.567), '4.57');
  assert.strictEqual(Geo.formatArea(48.34), '48.3');
  assert.strictEqual(Geo.formatArea(118.6), '119');
  assert.strictEqual(Geo.formatArea(0), '0');
});

check('formats money to cents, rounding half-cents up', () => {
  assert.strictEqual(Geo.formatMoney(885), '€885.00');
  // Plain toFixed(2) gives "1113.43" here — the stored double sits just below.
  assert.strictEqual(Geo.formatMoney(1113.435), '€1113.44');
  assert.strictEqual(Geo.formatMoney(0.005), '€0.01');
  assert.strictEqual(Geo.formatMoney(2.675), '€2.68');
});

/* ── Pricing ─────────────────────────────────────────────── */

console.log('\nPricing');

const base = Rates.load();

check('prices a single area off the rate card', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Wash + seal']['Block paving'] = 7.5;
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Driveway', sqm: 100, service: 'Wash + seal', surface: 'Block paving' },
  ]);
  assert.strictEqual(q.subtotal, 750);
  assert.strictEqual(q.total, 750);
});

check('sums multiple areas in one job', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Wash + seal']['Block paving'] = 7.5;
  s.rates['Pressure wash']['Slab / natural stone'] = 4.0;
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Driveway', sqm: 100, service: 'Wash + seal', surface: 'Block paving' },
    { label: 'Patio', sqm: 25, service: 'Pressure wash', surface: 'Slab / natural stone' },
  ]);
  assert.strictEqual(q.subtotal, 850);   // 750 + 100
  assert.strictEqual(q.lines.length, 2);
});

check('applies VAT on top of the subtotal', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure wash']['Tarmac'] = 3.0;
  s.settings = { minCharge: 0, vatRate: 13.5, vatEnabled: true };
  const q = Rates.quote(s, [
    { label: 'Driveway', sqm: 100, service: 'Pressure wash', surface: 'Tarmac' },
  ]);
  assert.strictEqual(q.subtotal, 300);
  assert.ok(Math.abs(q.vat - 40.5) < 1e-9);
  assert.ok(Math.abs(q.total - 340.5) < 1e-9);
});

check('lifts a small job to the minimum charge', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure wash']['Tarmac'] = 3.0;
  s.settings = { minCharge: 120, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Path', sqm: 10, service: 'Pressure wash', surface: 'Tarmac' },
  ]);
  assert.strictEqual(q.subtotal, 30);
  assert.strictEqual(q.minChargeApplied, true);
  assert.strictEqual(q.chargeable, 120);
  assert.strictEqual(q.total, 120);
});

check('does not apply the minimum to a job already above it', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure wash']['Tarmac'] = 3.0;
  s.settings = { minCharge: 120, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Driveway', sqm: 100, service: 'Pressure wash', surface: 'Tarmac' },
  ]);
  assert.strictEqual(q.minChargeApplied, false);
  assert.strictEqual(q.total, 300);
});

check('VAT is charged on the minimum, not the smaller subtotal', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure wash']['Tarmac'] = 3.0;
  s.settings = { minCharge: 120, vatRate: 13.5, vatEnabled: true };
  const q = Rates.quote(s, [
    { label: 'Path', sqm: 10, service: 'Pressure wash', surface: 'Tarmac' },
  ]);
  assert.ok(Math.abs(q.vat - 16.2) < 1e-9, `vat was ${q.vat}`);
  assert.ok(Math.abs(q.total - 136.2) < 1e-9);
});

check('flags an unsupported service/surface combination', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Drive', sqm: 100, service: 'Wash + re-sand', surface: 'Tarmac' },
  ]);
  assert.strictEqual(q.hasUnpriced, true);
  assert.strictEqual(q.lines[0].rate, null);
  assert.strictEqual(q.subtotal, 0);
});

check('an empty job is €0 with no minimum charge', () => {
  const q = Rates.quote(base, []);
  assert.strictEqual(q.total, 0);
  assert.strictEqual(q.minChargeApplied, false);
});

check('printed line totals always add up to the printed subtotal', () => {
  // Awkward areas × awkward rates — the classic penny-mismatch on a quote.
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure wash']['Tarmac'] = 3.33;
  s.rates['Pressure wash']['Concrete'] = 4.17;
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false };

  for (let i = 0; i < 400; i++) {
    const q = Rates.quote(s, [
      { label: 'A', sqm: 10 + i * 0.137, service: 'Pressure wash', surface: 'Tarmac' },
      { label: 'B', sqm: 7 + i * 0.291, service: 'Pressure wash', surface: 'Concrete' },
      { label: 'C', sqm: 3 + i * 0.033, service: 'Pressure wash', surface: 'Tarmac' },
    ]);
    const printedLines = q.lines.reduce((sum, l) => sum + Number(l.total.toFixed(2)), 0);
    assert.strictEqual(
      Number(printedLines.toFixed(2)), Number(q.subtotal.toFixed(2)),
      `iteration ${i}: lines printed ${printedLines.toFixed(2)} vs subtotal ${q.subtotal.toFixed(2)}`
    );
  }
});

check('subtotal + VAT always equals the printed total', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Wash + seal']['Block paving'] = 7.35;
  s.settings = { minCharge: 0, vatRate: 13.5, vatEnabled: true };
  for (let i = 0; i < 400; i++) {
    const q = Rates.quote(s, [
      { label: 'Drive', sqm: 11 + i * 0.417, service: 'Wash + seal', surface: 'Block paving' },
    ]);
    assert.strictEqual(
      Number((q.chargeable + q.vat).toFixed(2)), Number(q.total.toFixed(2)),
      `iteration ${i}`
    );
  }
});

/* ── Rate persistence ────────────────────────────────────── */

console.log('\nRate persistence');

check('saves and reloads edited rates', () => {
  const s = Rates.load();
  s.rates['Pressure wash']['Tarmac'] = 9.99;
  s.settings.minCharge = 200;
  assert.strictEqual(Rates.save(s), true);
  const back = Rates.load();
  assert.strictEqual(back.rates['Pressure wash']['Tarmac'], 9.99);
  assert.strictEqual(back.settings.minCharge, 200);
});

check('reset restores the built-in defaults', () => {
  const s = Rates.reset();
  assert.strictEqual(s.rates['Pressure wash']['Tarmac'], Rates.DEFAULT_RATES['Pressure wash']['Tarmac']);
  assert.strictEqual(s.settings.minCharge, Rates.DEFAULT_SETTINGS.minCharge);
  assert.strictEqual(Rates.load().settings.minCharge, Rates.DEFAULT_SETTINGS.minCharge);
});

check('a null rate survives a save/load round-trip', () => {
  const s = Rates.load();
  s.rates['Pressure wash']['Tarmac'] = null;
  Rates.save(s);
  assert.strictEqual(Rates.load().rates['Pressure wash']['Tarmac'], null);
  Rates.reset();
});

console.log('\n' + passed + ' checks passed' +
            (process.exitCode ? ' — WITH FAILURES' : '') + '\n');
