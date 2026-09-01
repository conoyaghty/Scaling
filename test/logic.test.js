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
  s.rates['Instant softwash']['Block paving'] = 7.5;
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Driveway', sqm: 100, service: 'Instant softwash', surface: 'Block paving' },
  ]);
  assert.strictEqual(q.subtotal, 750);
  assert.strictEqual(q.total, 750);
});

check('sums multiple areas in one job', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Instant softwash']['Block paving'] = 7.5;
  s.rates['Pressure washing']['Sandstone'] = 4.0;
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Driveway', sqm: 100, service: 'Instant softwash', surface: 'Block paving' },
    { label: 'Patio', sqm: 25, service: 'Pressure washing', surface: 'Sandstone' },
  ]);
  assert.strictEqual(q.subtotal, 850);   // 750 + 100
  assert.strictEqual(q.lines.length, 2);
});

check('applies VAT on top of the subtotal', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure washing']['Concrete'] = 3.0;
  s.settings = { minCharge: 0, vatRate: 13.5, vatEnabled: true };
  const q = Rates.quote(s, [
    { label: 'Driveway', sqm: 100, service: 'Pressure washing', surface: 'Concrete' },
  ]);
  assert.strictEqual(q.subtotal, 300);
  assert.ok(Math.abs(q.vat - 40.5) < 1e-9);
  assert.ok(Math.abs(q.total - 340.5) < 1e-9);
});

check('lifts a small job to the minimum charge', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure washing']['Concrete'] = 3.0;
  s.settings = { minCharge: 120, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Path', sqm: 10, service: 'Pressure washing', surface: 'Concrete' },
  ]);
  assert.strictEqual(q.subtotal, 30);
  assert.strictEqual(q.minChargeApplied, true);
  assert.strictEqual(q.chargeable, 120);
  assert.strictEqual(q.total, 120);
});

check('does not apply the minimum to a job already above it', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure washing']['Concrete'] = 3.0;
  s.settings = { minCharge: 120, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Driveway', sqm: 100, service: 'Pressure washing', surface: 'Concrete' },
  ]);
  assert.strictEqual(q.minChargeApplied, false);
  assert.strictEqual(q.total, 300);
});

check('VAT is charged on the minimum, not the smaller subtotal', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure washing']['Concrete'] = 3.0;
  s.settings = { minCharge: 120, vatRate: 13.5, vatEnabled: true };
  const q = Rates.quote(s, [
    { label: 'Path', sqm: 10, service: 'Pressure washing', surface: 'Concrete' },
  ]);
  assert.ok(Math.abs(q.vat - 16.2) < 1e-9, `vat was ${q.vat}`);
  assert.ok(Math.abs(q.total - 136.2) < 1e-9);
});

check('flags an unsupported service/surface combination', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false };
  const q = Rates.quote(s, [
    { label: 'Drive', sqm: 100, service: 'Roof cleaning', surface: 'Concrete' },
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
  s.rates['Pressure washing']['Concrete'] = 3.33;
  s.rates['Pressure washing']['Concrete'] = 4.17;
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false };

  for (let i = 0; i < 400; i++) {
    const q = Rates.quote(s, [
      { label: 'A', sqm: 10 + i * 0.137, service: 'Pressure washing', surface: 'Concrete' },
      { label: 'B', sqm: 7 + i * 0.291, service: 'Pressure washing', surface: 'Concrete' },
      { label: 'C', sqm: 3 + i * 0.033, service: 'Pressure washing', surface: 'Concrete' },
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
  s.rates['Instant softwash']['Block paving'] = 7.35;
  s.settings = { minCharge: 0, vatRate: 13.5, vatEnabled: true };
  for (let i = 0; i < 400; i++) {
    const q = Rates.quote(s, [
      { label: 'Drive', sqm: 11 + i * 0.417, service: 'Instant softwash', surface: 'Block paving' },
    ]);
    assert.strictEqual(
      Number((q.chargeable + q.vat).toFixed(2)), Number(q.total.toFixed(2)),
      `iteration ${i}`
    );
  }
});

/* ── Measurement confidence / contingency ────────────────── */

console.log('\nMeasurement confidence (quoting without a site visit)');

function withRates(overrides) {
  const s = JSON.parse(JSON.stringify(base));
  s.rates['Pressure washing']['Concrete'] = 3.0;
  s.settings = {
    minCharge: 0, vatRate: 0, vatEnabled: false,
    contingency: Object.assign({ 'Clear': 0, 'Part obscured': 10, 'Mostly estimated': 20 }, overrides),
  };
  return s;
}

check('a clear area carries no contingency', () => {
  const q = Rates.quote(withRates(), [
    { label: 'Drive', sqm: 100, service: 'Pressure washing', surface: 'Concrete', confidence: 'Clear' },
  ]);
  assert.strictEqual(q.lines[0].contingency, 0);
  assert.strictEqual(q.lines[0].uncertain, false);
  assert.strictEqual(q.total, 300);
  assert.strictEqual(q.hasUncertain, false);
});

check('a part-obscured area adds its contingency', () => {
  const q = Rates.quote(withRates(), [
    { label: 'Drive', sqm: 100, service: 'Pressure washing', surface: 'Concrete', confidence: 'Part obscured' },
  ]);
  assert.strictEqual(q.lines[0].base, 300);
  assert.strictEqual(q.lines[0].contingency, 30);
  assert.strictEqual(q.lines[0].total, 330);
  assert.strictEqual(q.lines[0].uncertain, true);
  assert.strictEqual(q.hasUncertain, true);
  assert.strictEqual(q.total, 330);
});

check('a mostly-estimated area adds the larger contingency', () => {
  const q = Rates.quote(withRates(), [
    { label: 'Drive', sqm: 100, service: 'Pressure washing', surface: 'Concrete', confidence: 'Mostly estimated' },
  ]);
  assert.strictEqual(q.lines[0].total, 360);
  assert.strictEqual(q.contingencyTotal, 60);
});

check('zeroed contingency keeps the flag but not the uplift', () => {
  const s = withRates({ 'Part obscured': 0, 'Mostly estimated': 0 });
  const q = Rates.quote(s, [
    { label: 'Drive', sqm: 100, service: 'Pressure washing', surface: 'Concrete', confidence: 'Mostly estimated' },
  ]);
  assert.strictEqual(q.lines[0].total, 300);
  assert.strictEqual(q.lines[0].uncertain, true, 'still flagged');
  assert.strictEqual(q.hasUncertain, true);
  assert.strictEqual(q.contingencyTotal, 0);
});

check('an area saved before confidence existed defaults to Clear', () => {
  const q = Rates.quote(withRates(), [
    { label: 'Drive', sqm: 100, service: 'Pressure washing', surface: 'Concrete' },   // no confidence key
  ]);
  assert.strictEqual(q.lines[0].confidence, 'Clear');
  assert.strictEqual(q.lines[0].contingency, 0);
  assert.strictEqual(q.total, 300);
});

check('contingency is mixed correctly across a multi-area job', () => {
  const s = withRates();
  s.rates['Instant softwash']['Block paving'] = 7.5;
  const q = Rates.quote(s, [
    { label: 'Drive', sqm: 100, service: 'Instant softwash', surface: 'Block paving', confidence: 'Clear' },
    { label: 'Patio', sqm: 100, service: 'Pressure washing', surface: 'Concrete', confidence: 'Part obscured' },
  ]);
  assert.strictEqual(q.lines[0].total, 750);   // clear, untouched
  assert.strictEqual(q.lines[1].total, 330);   // 300 + 10%
  assert.strictEqual(q.subtotal, 1080);
  assert.strictEqual(q.contingencyTotal, 30);
});

check('contingency lines still add up to the subtotal', () => {
  const s = withRates({ 'Part obscured': 7.5 });
  s.rates['Pressure washing']['Concrete'] = 4.17;
  for (let i = 0; i < 300; i++) {
    const q = Rates.quote(s, [
      { label: 'A', sqm: 13 + i * 0.211, service: 'Pressure washing', surface: 'Concrete', confidence: 'Part obscured' },
      { label: 'B', sqm: 9 + i * 0.373, service: 'Pressure washing', surface: 'Concrete', confidence: 'Mostly estimated' },
    ]);
    const printed = q.lines.reduce((s2, l) => s2 + Number(l.total.toFixed(2)), 0);
    assert.strictEqual(Number(printed.toFixed(2)), Number(q.subtotal.toFixed(2)), `iteration ${i}`);
    // Each line's own parts must also reconcile.
    q.lines.forEach((l) => {
      assert.strictEqual(Number((l.base + l.contingency).toFixed(2)), Number(l.total.toFixed(2)));
    });
  }
});

check('VAT and minimum charge apply on top of contingency', () => {
  const s = withRates();
  s.settings.minCharge = 0;
  s.settings.vatEnabled = true;
  s.settings.vatRate = 13.5;
  const q = Rates.quote(s, [
    { label: 'Drive', sqm: 100, service: 'Pressure washing', surface: 'Concrete', confidence: 'Part obscured' },
  ]);
  assert.strictEqual(q.subtotal, 330);           // 300 + 10%
  assert.ok(Math.abs(q.vat - 44.55) < 1e-9, `vat ${q.vat}`);
  assert.ok(Math.abs(q.total - 374.55) < 1e-9);
});

check('contingency settings survive a save/load round-trip', () => {
  const s = Rates.load();
  s.settings.contingency['Part obscured'] = 12.5;
  Rates.save(s);
  assert.strictEqual(Rates.load().settings.contingency['Part obscured'], 12.5);
  Rates.reset();
});

check('settings saved before contingency existed still get defaults', () => {
  // Simulate an older browser's stored blob with no contingency key at all.
  store.set('areaTool.rates.v1', JSON.stringify({
    rates: {}, settings: { minCharge: 99, vatRate: 23, vatEnabled: false },
  }));
  const s = Rates.load();
  assert.strictEqual(s.settings.minCharge, 99, 'old settings still honoured');
  assert.deepStrictEqual(s.settings.contingency, Rates.DEFAULT_SETTINGS.contingency,
    'missing contingency filled from defaults');
  Rates.reset();
});

/* ── The actual rate card ────────────────────────────────── */

console.log('\nRate card as quoted');

check('every surface the business works with is offered', () => {
  const expected = [
    'Concrete', 'Block paving', 'Tarmac', 'Limestone', 'Sandstone',
    'Granite', 'Travertine', 'Resin', 'Porcelain', 'Decking',
  ];
  // Joined rather than deepStrictEqual: these arrays come from the vm sandbox,
  // so their Array prototype is a different realm's and reference-equality fails.
  assert.strictEqual(Rates.GROUND_SURFACES.join('|'), expected.join('|'));
  assert.strictEqual(Rates.ROOF_SURFACES.join('|'), 'Flat tiles (roof)|Profiled / slate (roof)');
  assert.strictEqual(Rates.SURFACES.length, 12);
});

check('pressure washing is €3.50 on everything but the three premium surfaces', () => {
  ['Concrete', 'Block paving', 'Sandstone', 'Granite', 'Travertine', 'Resin', 'Porcelain']
    .forEach((surf) => {
      assert.strictEqual(Rates.rateFor(base, 'Pressure washing', surf), 3.50, surf);
    });
});

check('pressure washing is €4.00 on tarmac, limestone and decking only', () => {
  ['Tarmac', 'Limestone', 'Decking'].forEach((surf) => {
    assert.strictEqual(Rates.rateFor(base, 'Pressure washing', surf), 4.00, surf);
  });
  // Nothing else may creep into the premium band.
  const premium = Rates.GROUND_SURFACES.filter(
    (s) => Rates.rateFor(base, 'Pressure washing', s) === 4.00);
  assert.strictEqual(premium.join('|'), 'Tarmac|Limestone|Decking');
});

check('every ground surface has all three ground services priced', () => {
  Rates.GROUND_SURFACES.forEach((surf) => {
    ['Pressure washing', 'Instant softwash', 'Progressive softwash'].forEach((svc) => {
      const r = Rates.rateFor(base, svc, surf);
      assert.ok(r !== null && r > 0, `${svc} on ${surf} is unpriced`);
    });
  });
});

check('no surface is priced at both €3.50 and €4.00 by mistake', () => {
  Rates.GROUND_SURFACES.forEach((surf) => {
    const r = Rates.rateFor(base, 'Pressure washing', surf);
    assert.ok(r === 3.50 || r === 4.00, `${surf} is €${r}`);
  });
});

check('contingency is off by default — the flag does not move the price', () => {
  Rates.CONFIDENCE.forEach((level) => {
    assert.strictEqual(Rates.DEFAULT_SETTINGS.contingency[level], 0, level);
  });
  const q = Rates.quote(base, [
    { label: 'Drive', sqm: 100, service: 'Pressure washing', surface: 'Tarmac',
      confidence: 'Mostly estimated' },
  ]);
  assert.strictEqual(q.contingencyTotal, 0);
  assert.strictEqual(q.lines[0].total, 400, 'plain 100 × €4.00');
  assert.strictEqual(q.hasUncertain, true, 'still flagged for your own reference');
});

check('"No pitch" is offered and prices the bare footprint', () => {
  const zero = Rates.PITCHES[0];
  assert.strictEqual(zero.deg, 0);
  assert.ok(/no pitch/i.test(zero.label), `first option reads "${zero.label}"`);
  assert.strictEqual(Rates.pitchMultiplier(zero.deg), 1);

  const s = JSON.parse(JSON.stringify(base));
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false, contingency: { 'Clear': 0 } };
  const q = Rates.quote(s, [
    { label: 'Roof', sqm: 100, service: 'Roof cleaning',
      surface: 'Profiled / slate (roof)', pitch: 0 },
  ]);
  assert.strictEqual(q.lines[0].chargeSqm, 100, 'no uplift at all');
  assert.strictEqual(q.total, 850);
});

check('softwash instant is €4.50 on every ground surface', () => {
  ['Concrete', 'Sandstone', 'Granite', 'Porcelain', 'Tarmac', 'Block paving', 'Resin', 'Decking']
    .forEach((surf) => {
      assert.strictEqual(Rates.rateFor(base, 'Instant softwash', surf), 4.50, surf);
    });
});

check('softwash progressive is €3.50 on every ground surface', () => {
  ['Concrete', 'Sandstone', 'Granite', 'Porcelain', 'Tarmac', 'Block paving', 'Resin', 'Decking']
    .forEach((surf) => {
      assert.strictEqual(Rates.rateFor(base, 'Progressive softwash', surf), 3.50, surf);
    });
});

check('roof cleaning is €7.50 flat tiles, €8.50 everything else', () => {
  assert.strictEqual(Rates.rateFor(base, 'Roof cleaning', 'Flat tiles (roof)'), 7.50);
  assert.strictEqual(Rates.rateFor(base, 'Roof cleaning', 'Profiled / slate (roof)'), 8.50);
});

check('roof cleaning is not offered on ground surfaces, and vice versa', () => {
  assert.strictEqual(Rates.rateFor(base, 'Roof cleaning', 'Concrete'), null);
  assert.strictEqual(Rates.rateFor(base, 'Pressure washing', 'Flat tiles (roof)'), null);
  assert.strictEqual(Rates.rateFor(base, 'Instant softwash', 'Profiled / slate (roof)'), null);
});

/* ── Roof pitch ──────────────────────────────────────────── */

console.log('\nRoof pitch (footprint → actual roof area)');

check('identifies roof surfaces', () => {
  assert.strictEqual(Rates.isRoof('Flat tiles (roof)'), true);
  assert.strictEqual(Rates.isRoof('Profiled / slate (roof)'), true);
  assert.strictEqual(Rates.isRoof('Concrete'), false);
  assert.strictEqual(Rates.isRoof(undefined), false);
});

check('pitch multipliers match 1/cos(pitch)', () => {
  const cases = [[0, 1.000], [15, 1.035], [25, 1.103], [30, 1.155], [35, 1.221], [45, 1.414]];
  cases.forEach(([deg, expected]) => {
    assert.ok(Math.abs(Rates.pitchMultiplier(deg) - expected) < 0.001,
      `${deg}° gave ${Rates.pitchMultiplier(deg).toFixed(4)}, expected ${expected}`);
  });
});

check('a bad or missing pitch is treated as flat, never NaN or Infinity', () => {
  [undefined, null, NaN, 'thirty', -10].forEach((v) => {
    assert.strictEqual(Rates.pitchMultiplier(v), 1, String(v));
  });
  assert.ok(isFinite(Rates.pitchMultiplier(90)), '90° must not divide by zero');
});

check('a 35° roof is priced on 22% more than its footprint', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false, contingency: { 'Clear': 0 } };
  const q = Rates.quote(s, [
    { label: 'Roof', sqm: 100, service: 'Roof cleaning', surface: 'Profiled / slate (roof)', pitch: 35 },
  ]);
  assert.ok(Math.abs(q.lines[0].chargeSqm - 122.08) < 0.05, `chargeSqm ${q.lines[0].chargeSqm}`);
  // 122.08 m² × €8.50 — not 100 × 8.50 = €850, which is what footprint pricing gives.
  assert.ok(Math.abs(q.total - 1037.65) < 0.5, `total ${q.total}`);
  assert.ok(q.total > 850 * 1.2, 'must exceed naive footprint pricing by ~22%');
  assert.strictEqual(q.hasRoof, true);
});

check('a flat roof is priced on its footprint exactly', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false, contingency: { 'Clear': 0 } };
  const q = Rates.quote(s, [
    { label: 'Roof', sqm: 100, service: 'Roof cleaning', surface: 'Flat tiles (roof)', pitch: 0 },
  ]);
  assert.strictEqual(q.lines[0].chargeSqm, 100);
  assert.strictEqual(q.total, 750);
});

check('pitch is ignored on a ground surface even if supplied', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false, contingency: { 'Clear': 0 } };
  const q = Rates.quote(s, [
    { label: 'Drive', sqm: 100, service: 'Progressive softwash', surface: 'Tarmac', pitch: 45 },
  ]);
  assert.strictEqual(q.lines[0].chargeSqm, 100, 'a driveway has no pitch uplift');
  assert.strictEqual(q.lines[0].isRoof, false);
  assert.strictEqual(q.total, 350);
});

check('a roof saved with no pitch does not silently inflate', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false, contingency: { 'Clear': 0 } };
  const q = Rates.quote(s, [
    { label: 'Roof', sqm: 100, service: 'Roof cleaning', surface: 'Flat tiles (roof)' },
  ]);
  assert.strictEqual(q.lines[0].chargeSqm, 100);
});

check('pitch and contingency compound in the right order', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.settings = {
    minCharge: 0, vatRate: 0, vatEnabled: false,
    contingency: { 'Clear': 0, 'Part obscured': 10, 'Mostly estimated': 20 },
  };
  const q = Rates.quote(s, [
    {
      label: 'Roof', sqm: 100, service: 'Roof cleaning',
      surface: 'Flat tiles (roof)', pitch: 30, confidence: 'Part obscured',
    },
  ]);
  // 100 × 1.1547 = 115.47 m²; × €7.50 = €866.03; + 10% = €952.63
  assert.ok(Math.abs(q.lines[0].base - 866.03) < 0.05, `base ${q.lines[0].base}`);
  assert.ok(Math.abs(q.lines[0].contingency - 86.60) < 0.05, `cont ${q.lines[0].contingency}`);
  assert.ok(Math.abs(q.total - 952.63) < 0.05, `total ${q.total}`);
});

check('a mixed roof-and-driveway job totals correctly', () => {
  const s = JSON.parse(JSON.stringify(base));
  s.settings = { minCharge: 0, vatRate: 0, vatEnabled: false, contingency: { 'Clear': 0 } };
  const q = Rates.quote(s, [
    { label: 'Roof', sqm: 80, service: 'Roof cleaning', surface: 'Flat tiles (roof)', pitch: 0 },
    { label: 'Driveway', sqm: 100, service: 'Instant softwash', surface: 'Block paving' },
  ]);
  assert.strictEqual(q.lines[0].total, 600);   // 80 × 7.50
  assert.strictEqual(q.lines[1].total, 450);   // 100 × 4.50
  assert.strictEqual(q.subtotal, 1050);
  assert.strictEqual(q.hasRoof, true);
});

/* ── Rate persistence ────────────────────────────────────── */

console.log('\nRate persistence');

check('saves and reloads edited rates', () => {
  const s = Rates.load();
  s.rates['Pressure washing']['Concrete'] = 9.99;
  s.settings.minCharge = 200;
  assert.strictEqual(Rates.save(s), true);
  const back = Rates.load();
  assert.strictEqual(back.rates['Pressure washing']['Concrete'], 9.99);
  assert.strictEqual(back.settings.minCharge, 200);
});

check('reset restores the built-in defaults', () => {
  const s = Rates.reset();
  assert.strictEqual(s.rates['Pressure washing']['Concrete'], Rates.DEFAULT_RATES['Pressure washing']['Concrete']);
  assert.strictEqual(s.settings.minCharge, Rates.DEFAULT_SETTINGS.minCharge);
  assert.strictEqual(Rates.load().settings.minCharge, Rates.DEFAULT_SETTINGS.minCharge);
});

check('a null rate survives a save/load round-trip', () => {
  const s = Rates.load();
  s.rates['Pressure washing']['Concrete'] = null;
  Rates.save(s);
  assert.strictEqual(Rates.load().rates['Pressure washing']['Concrete'], null);
  Rates.reset();
});

console.log('\n' + passed + ' checks passed' +
            (process.exitCode ? ' — WITH FAILURES' : '') + '\n');
