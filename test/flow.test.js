/*
 * End-to-end check of the real user flow, driven through a mocked Maps API:
 *   search eircode → tap corners → read sqm → save area → quote.
 *
 *   npm run test:ui
 *
 * Starts its own static server, so nothing needs to be running first.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8231;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

/* Ireland — the latitude where naive flat measurement goes badly wrong. */
const ORIGIN = { lat: 53.4239, lng: -7.9407 };
const R = 6378137;
const degLat = (m) => (m / R) * (180 / Math.PI);
const degLng = (m, lat) => (m / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);

/* Corners of a rectangle of known ground size, anticlockwise from ORIGIN. */
function rectCorners(widthM, heightM) {
  const dLat = degLat(heightM);
  const dLng = degLng(widthM, ORIGIN.lat);
  return [
    [ORIGIN.lat, ORIGIN.lng],
    [ORIGIN.lat, ORIGIN.lng + dLng],
    [ORIGIN.lat + dLat, ORIGIN.lng + dLng],
    [ORIGIN.lat + dLat, ORIGIN.lng],
  ];
}

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const server = await serve();
  const launchOpts = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  // "New job" asks for confirmation; Playwright dismisses dialogs by default,
  // which would read as the user cancelling.
  page.on('dialog', (d) => d.accept());

  // Supply a config so the app boots, and swap the Maps script for the mock.
  await page.route('**/js/config.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.AREA_TOOL_CONFIG={googleMapsApiKey:'test-key',defaultCentre:{lat:53.42,lng:-7.94},defaultZoom:7,measureZoom:20,geocodeRegion:'IE'};`,
    }));

  const mock = fs.readFileSync(path.join(__dirname, 'mock-maps.js'), 'utf8');
  await page.route('**maps.googleapis.com/maps/api/js**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: mock }));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#map[data-mock-map="ready"]', { timeout: 5000 });

  console.log('\nBoot');
  ok('map initialises with the mock API', await page.getAttribute('#map', 'data-mock-map') === 'ready');
  ok('setup overlay not shown when a key is present', !(await page.isVisible('#setup-needed')));
  ok('imagery starts top-down (tilt 0)', await page.evaluate(() => window.__mock.map.getTilt() === 0));

  /* ── Search ────────────────────────────────────────── */
  console.log('\nEircode search');

  await page.fill('#search', 'a65 f4e2');
  await page.click('#search-go');
  await page.waitForTimeout(150);

  ok('recentres on the geocoded point',
    await page.evaluate(() => window.__mock.map.getCenter().lat.toFixed(4)) === '53.4239');
  ok('zooms in to measuring zoom',
    await page.evaluate(() => window.__mock.map.getZoom()) === 20);
  ok('shows the resolved address',
    (await page.textContent('#banner')).includes('Athlone'));
  ok('drops a locator pin', await page.evaluate(() => window.__mock.markers.length) === 1);
  ok('shows the tap hint', await page.isVisible('#hint'));

  // Approximate matches must warn — this is the "wrong house" failure mode.
  await page.evaluate(() => { window.__mock.geocodeResponse = 'APPROXIMATE'; });
  await page.fill('#search', 'D02X285');
  await page.click('#search-go');
  await page.waitForTimeout(150);
  ok('warns when the match is only approximate',
    (await page.textContent('#banner')).toLowerCase().includes('approximate'),
    await page.textContent('#banner'));
  ok('approximate match is styled as a warning',
    (await page.getAttribute('#banner', 'class')).includes('is-warn'));

  await page.evaluate(() => { window.__mock.geocodeResponse = 'ZERO_RESULTS'; });
  await page.fill('#search', 'A99Z999');
  await page.click('#search-go');
  await page.waitForTimeout(150);
  ok('reports an unmatched eircode as an error',
    (await page.getAttribute('#banner', 'class')).includes('is-error'));

  await page.evaluate(() => { window.__mock.geocodeResponse = 'OK'; });
  await page.fill('#search', 'A65F4E2');
  await page.click('#search-go');
  await page.waitForTimeout(150);

  /* ── Measuring ─────────────────────────────────────── */
  console.log('\nMeasuring a 20 m × 6 m driveway (120 m²)');

  const drive = rectCorners(20, 6);
  await page.evaluate((c) => window.__mock.tap(c[0], c[1]), drive[0]);
  ok('one point: no polygon yet, save disabled',
    await page.isDisabled('#save-area') && await page.evaluate(() => window.__mock.activePolygon() === null));
  ok('one point: readout appears', await page.isVisible('#readout'));
  ok('one point: undo enabled', !(await page.isDisabled('#undo')));

  await page.evaluate((c) => window.__mock.tap(c[0], c[1]), drive[1]);
  ok('two points: still not saveable', await page.isDisabled('#save-area'));

  await page.evaluate((c) => window.__mock.tap(c[0], c[1]), drive[2]);
  ok('three points: polygon drawn', await page.evaluate(() => window.__mock.activePolygon() !== null));
  ok('three points: save enabled', !(await page.isDisabled('#save-area')));

  await page.evaluate((c) => window.__mock.tap(c[0], c[1]), drive[3]);

  const sqm = parseFloat(await page.textContent('#readout-sqm'));
  ok(`reads 120 m² for a 20×6 driveway (got ${sqm})`, near(sqm, 120, 0.6), `got ${sqm}`);
  ok('point count shown', (await page.textContent('#readout-points')) === '4 points');
  const perim = await page.textContent('#readout-perimeter');
  ok(`perimeter reads ~52 m (got "${perim}")`, near(parseFloat(perim), 52, 0.5));
  ok('hint disappears once measuring starts', !(await page.isVisible('#hint')));
  ok('four vertex handles placed', await page.evaluate(() => window.__mock.vertices.length) === 4);

  /* Undo and redo a corner. */
  await page.click('#undo');
  ok('undo drops the last corner', (await page.textContent('#readout-points')) === '3 points');
  ok('undo removes its handle', await page.evaluate(() => window.__mock.vertices.length) === 3);
  await page.evaluate((c) => window.__mock.tap(c[0], c[1]), drive[3]);
  ok('re-tapping restores 120 m²', near(parseFloat(await page.textContent('#readout-sqm')), 120, 0.6));

  /* Dragging a handle must change the measurement. */
  const widened = [ORIGIN.lat + degLat(12), ORIGIN.lng];
  await page.evaluate((c) => window.__mock.dragVertex(3, c[0], c[1]), widened);
  const dragged = parseFloat(await page.textContent('#readout-sqm'));
  ok(`dragging a corner updates the area (120 → ${dragged})`, dragged > 140 && dragged < 200);
  await page.evaluate((c) => window.__mock.dragVertex(3, c[0], c[1]), drive[3]);
  ok('dragging back restores 120 m²', near(parseFloat(await page.textContent('#readout-sqm')), 120, 0.6));

  /* Tapping a handle deletes that corner. */
  await page.evaluate(() => window.__mock.clickVertex(0));
  ok('tapping a handle deletes that corner', (await page.textContent('#readout-points')) === '3 points');
  await page.click('#clear');
  ok('clear resets the readout', !(await page.isVisible('#readout')));
  ok('clear removes every handle', await page.evaluate(() => window.__mock.vertices.length) === 0);
  ok('clear removes the polygon', await page.evaluate(() => window.__mock.activePolygon() === null));

  /* ── Saving an area and pricing it ─────────────────── */
  console.log('\nSaving areas and building the quote');

  // Known rates so the expected money is unambiguous.
  await page.click('.tab[data-tab="rates"]');
  await page.evaluate(() => {
    const set = (svc, surf, v) => {
      const el = document.querySelector(`#rate-table input[data-service="${svc}"][data-surface="${surf}"]`);
      el.value = v;
    };
    set('Instant softwash', 'Block paving', '7.50');
    set('Pressure washing', 'Sandstone', '4.00');
    document.getElementById('set-min').value = '0';
    document.getElementById('set-vat').value = '13.5';
    document.getElementById('set-vat-on').checked = true;
  });
  await page.click('#save-rates');
  await page.click('.tab[data-tab="job"]');

  for (const c of drive) await page.evaluate((p) => window.__mock.tap(p[0], p[1]), c);
  await page.click('#save-area');
  await page.waitForTimeout(120);

  ok('dialog opens with the measured area',
    near(parseFloat(await page.textContent('#dlg-sqm')), 120, 0.6));
  ok('dialog defaults the label to Driveway',
    (await page.inputValue('#dlg-label')) === 'Driveway');

  await page.selectOption('#dlg-surface', 'Block paving');
  await page.selectOption('#dlg-service', 'Instant softwash');
  await page.waitForTimeout(60);
  const preview = await page.textContent('#dlg-price');
  ok(`dialog previews the line price (${preview.trim()})`, preview.includes('€7.50') && preview.includes('€900'));

  await page.click('#dlg-ok');
  await page.waitForTimeout(150);

  ok('area added to the job', await page.locator('.area-item').count() === 1);
  ok('measurement cleared after saving', !(await page.isVisible('#readout')));
  ok('quote block now visible', await page.isVisible('#quote'));
  ok('line price is 120 × €7.50 = €900',
    (await page.textContent('.area-item-price')).includes('900'),
    await page.textContent('.area-item-price'));

  // Second area: a 5 m × 5 m patio.
  const patio = rectCorners(5, 5);
  for (const c of patio) await page.evaluate((p) => window.__mock.tap(p[0], p[1]), c);
  await page.click('#save-area');
  await page.waitForTimeout(120);
  ok('second area defaults the label to Patio', (await page.inputValue('#dlg-label')) === 'Patio');
  await page.selectOption('#dlg-surface', 'Sandstone');
  await page.selectOption('#dlg-service', 'Pressure washing');
  await page.click('#dlg-ok');
  await page.waitForTimeout(150);

  ok('two areas in the job', await page.locator('.area-item').count() === 2);

  const subtotal = await page.textContent('#q-subtotal');
  const vat = await page.textContent('#q-vat');
  const total = await page.textContent('#q-total');
  // 120 m² × 7.50 = 900, 25 m² × 4.00 = 100 → 1000 + 13.5% = 1135
  ok(`subtotal is €1000 (got ${subtotal})`, near(parseFloat(subtotal.replace('€', '')), 1000, 3));
  ok(`VAT is €135 (got ${vat})`, near(parseFloat(vat.replace('€', '')), 135, 0.5));
  ok(`total is €1135 (got ${total})`, near(parseFloat(total.replace('€', '')), 1135, 3.5));
  ok('sheet summary shows the combined area',
    (await page.textContent('#sheet-count')).includes('2 areas'));
  ok('sheet summary shows the total', (await page.textContent('#sheet-total')) === total);

  /* Quote text must match what is on screen. */
  const text = await page.evaluate(async () => {
    let captured = '';
    navigator.clipboard.writeText = (t) => { captured = t; return Promise.resolve(); };
    document.getElementById('copy-quote').click();
    await new Promise((r) => setTimeout(r, 60));
    return captured;
  });
  ok('quote text names the eircode', text.includes('A65 F4E2'), text.slice(0, 80));
  ok('quote text includes the address', text.includes('Athlone'));
  ok('quote text lists both areas', text.includes('Driveway') && text.includes('Patio'));
  ok('quote text carries the same total', text.includes(total.replace('€', '')));
  ok('quote text notes areas are from imagery', text.toLowerCase().includes('aerial imagery'));

  /* Removing a line re-prices the job. */
  await page.locator('.area-item .remove-btn').first().click();
  await page.waitForTimeout(80);
  ok('removing a line drops it from the list', await page.locator('.area-item').count() === 1);
  ok('removing a line re-prices the job',
    near(parseFloat((await page.textContent('#q-subtotal')).replace('€', '')), 100, 1));

  /* VAT toggle must actually hide the VAT row (the [hidden] bug). */
  await page.click('.tab[data-tab="rates"]');
  await page.uncheck('#set-vat-on');
  await page.click('#save-rates');
  await page.click('.tab[data-tab="job"]');
  ok('switching VAT off hides the VAT row', !(await page.isVisible('#q-vat-row')));
  ok('switching VAT off removes VAT from the total',
    near(parseFloat((await page.textContent('#q-total')).replace('€', '')), 100, 1));

  /* Minimum charge. */
  await page.click('.tab[data-tab="rates"]');
  await page.fill('#set-min', '250');
  await page.click('#save-rates');
  await page.click('.tab[data-tab="job"]');
  ok('minimum-charge row appears when it bites', await page.isVisible('#q-min-row'));
  ok('minimum charge lifts the total to €250',
    near(parseFloat((await page.textContent('#q-total')).replace('€', '')), 250, 0.5));

  /* ── Confidence + contingency ──────────────────────── */
  console.log('\nObscured areas (no site visit to fall back on)');

  await page.click('#new-job');
  await page.waitForTimeout(100);
  await page.click('.tab[data-tab="rates"]');
  await page.evaluate(() => {
    document.querySelector('#rate-table input[data-service="Progressive softwash"][data-surface="Tarmac"]').value = '3.00';
    document.querySelector('#contingency-grid input[data-confidence="Part obscured"]').value = '10';
    document.getElementById('set-min').value = '0';
    document.getElementById('set-vat-on').checked = false;
  });
  await page.click('#save-rates');
  await page.click('.tab[data-tab="job"]');

  ok('contingency grid renders one field per level',
    await page.locator('#contingency-grid input').count() === 3);

  await page.fill('#search', 'A65F4E2');
  await page.click('#search-go');
  await page.waitForTimeout(150);

  const cd = rectCorners(20, 5);   // 100 m²
  for (const c of cd) await page.evaluate((p) => window.__mock.tap(p[0], p[1]), c);
  await page.click('#save-area');
  await page.waitForTimeout(120);

  ok('confidence defaults to Clear', (await page.inputValue('#dlg-confidence')) === 'Clear');
  const clearPreview = await page.textContent('#dlg-price');
  ok('clear preview shows no contingency line', !clearPreview.includes('contingency'), clearPreview);

  await page.selectOption('#dlg-surface', 'Tarmac');
  await page.selectOption('#dlg-service', 'Progressive softwash');
  await page.selectOption('#dlg-confidence', 'Part obscured');
  await page.waitForTimeout(80);
  const obscuredPreview = await page.textContent('#dlg-price');
  ok(`preview shows the uplift (${obscuredPreview.replace(/\n/g, ' | ')})`,
    obscuredPreview.includes('10% contingency') && obscuredPreview.includes('€330'));

  await page.click('#dlg-ok');
  await page.waitForTimeout(150);

  ok('obscured line is flagged in the job list', await page.isVisible('.area-item-flag'));
  ok('flag names the level and the uplift',
    (await page.textContent('.area-item-flag')).includes('Part obscured') &&
    (await page.textContent('.area-item-flag')).includes('+10%'));
  ok('line price includes the contingency',
    near(parseFloat((await page.textContent('.area-item-price')).replace('€', '')), 330, 1));

  const obsQuote = await page.evaluate(async () => {
    let captured = '';
    navigator.clipboard.writeText = (t) => { captured = t; return Promise.resolve(); };
    document.getElementById('copy-quote').click();
    await new Promise((r) => setTimeout(r, 60));
    return captured;
  });
  ok('quote breaks out the contingency as its own line',
    obsQuote.includes('10% contingency'), obsQuote);
  ok('quote no longer promises an on-site confirmation',
    !obsQuote.toLowerCase().includes('on-site confirmation'), obsQuote);
  ok('quote states the area was estimated',
    obsQuote.toLowerCase().includes('estimated'), obsQuote);
  ok('quote gives the price as holding, not provisional',
    obsQuote.toLowerCase().includes('price holds'), obsQuote);

  /* A fully clear job gets the firm wording instead. */
  await page.click('#new-job');
  await page.waitForTimeout(100);
  await page.fill('#search', 'A65F4E2');
  await page.click('#search-go');
  await page.waitForTimeout(150);
  for (const c of cd) await page.evaluate((p) => window.__mock.tap(p[0], p[1]), c);
  await page.click('#save-area');
  await page.waitForTimeout(120);
  await page.selectOption('#dlg-surface', 'Tarmac');
  await page.selectOption('#dlg-service', 'Pressure washing');
  await page.click('#dlg-ok');
  await page.waitForTimeout(150);

  ok('new job cleared the previous areas', await page.locator('.area-item').count() === 1);
  ok('confidence resets to Clear rather than inheriting the last area',
    await page.locator('.area-item-flag').count() === 0);
  ok('a clear job carries no flag', await page.locator('.area-item-flag').count() === 0);
  const clearQuote = await page.evaluate(async () => {
    let captured = '';
    navigator.clipboard.writeText = (t) => { captured = t; return Promise.resolve(); };
    document.getElementById('copy-quote').click();
    await new Promise((r) => setTimeout(r, 60));
    return captured;
  });
  ok('clear quote omits the estimation caveat',
    !clearQuote.toLowerCase().includes('estimated'), clearQuote);
  ok('clear quote still states the measurement basis',
    clearQuote.toLowerCase().includes('aerial imagery'));

  /* ── Roof pitch ────────────────────────────────────── */
  console.log('\nRoof measuring (footprint is not the roof area)');

  await page.click('#new-job');
  await page.waitForTimeout(100);
  await page.click('.tab[data-tab="rates"]');
  await page.evaluate(() => {
    document.querySelectorAll('#contingency-grid input').forEach((i) => { i.value = '0'; });
    document.getElementById('set-min').value = '0';
    document.getElementById('set-vat-on').checked = false;
  });
  await page.click('#save-rates');
  await page.click('.tab[data-tab="job"]');
  await page.fill('#search', 'A65F4E2');
  await page.click('#search-go');
  await page.waitForTimeout(150);

  const roof = rectCorners(10, 10);   // 100 m² footprint
  for (const c of roof) await page.evaluate((p) => window.__mock.tap(p[0], p[1]), c);
  await page.click('#save-area');
  await page.waitForTimeout(120);

  ok('pitch control hidden for a ground surface', !(await page.isVisible('#dlg-pitch-row')));

  await page.selectOption('#dlg-surface', 'Profiled / slate (roof)');
  await page.waitForTimeout(80);
  ok('pitch control appears once a roof surface is chosen', await page.isVisible('#dlg-pitch-row'));
  ok('pitch defaults to 35°', (await page.inputValue('#dlg-pitch')) === '35');

  await page.selectOption('#dlg-service', 'Roof cleaning');
  await page.waitForTimeout(80);
  const roofPreview = await page.textContent('#dlg-price');
  ok(`preview converts footprint to roof area (${roofPreview.replace(/\n/g, ' | ')})`,
    roofPreview.includes('footprint') && roofPreview.includes('122'), roofPreview);
  ok('preview prices the roof area, not the footprint',
    roofPreview.includes('1037') || roofPreview.includes('1038'), roofPreview);

  ok('a "no pitch" option is offered first in the list',
    /no pitch/i.test(await page.locator('#dlg-pitch option').first().textContent()),
    await page.locator('#dlg-pitch option').first().textContent());

  await page.selectOption('#dlg-pitch', '0');
  await page.waitForTimeout(80);
  const noPitch = await page.textContent('#dlg-price');
  ok('no pitch prices the bare footprint', noPitch.includes('850'), noPitch);
  ok('no pitch shows no conversion line', !noPitch.includes('footprint ×'), noPitch);

  await page.selectOption('#dlg-pitch', '35');
  await page.waitForTimeout(80);
  await page.click('#dlg-ok');
  await page.waitForTimeout(150);

  ok('job list shows the roof area, not the footprint',
    (await page.textContent('.area-item-title')).includes('122'),
    await page.textContent('.area-item-title'));
  ok('job list still records the measured footprint',
    (await page.textContent('.area-item-meta')).includes('footprint') &&
    (await page.textContent('.area-item-meta')).includes('35°'),
    await page.textContent('.area-item-meta'));
  ok('roof line priced on sloped area',
    near(parseFloat((await page.textContent('.area-item-price')).replace('€', '')), 1037.65, 1));

  const roofQuote = await page.evaluate(async () => {
    let captured = '';
    navigator.clipboard.writeText = (t) => { captured = t; return Promise.resolve(); };
    document.getElementById('copy-quote').click();
    await new Promise((r) => setTimeout(r, 60));
    return captured;
  });
  ok('quote shows the footprint-to-roof conversion',
    roofQuote.includes('footprint at 35°') && roofQuote.includes('roof area'), roofQuote);

  /* Switching back to a ground surface must drop the pitch uplift. */
  for (const c of roof) await page.evaluate((p) => window.__mock.tap(p[0], p[1]), c);
  await page.click('#save-area');
  await page.waitForTimeout(120);
  await page.selectOption('#dlg-surface', 'Flat tiles (roof)');
  await page.waitForTimeout(60);
  await page.selectOption('#dlg-surface', 'Tarmac');
  await page.waitForTimeout(80);
  ok('pitch control hides again when leaving a roof surface',
    !(await page.isVisible('#dlg-pitch-row')));
  await page.selectOption('#dlg-service', 'Progressive softwash');
  await page.waitForTimeout(80);
  // Tarmac/softwash-progressive was set to €3.00 by the contingency section above.
  ok('ground surface prices the plain 100 m² footprint',
    (await page.textContent('#dlg-price')).includes('€300'), await page.textContent('#dlg-price'));
  ok('ground preview shows no footprint conversion',
    !(await page.textContent('#dlg-price')).includes('footprint'));

  console.log('\nJS errors: ' + (jsErrors.length ? '\n  ' + jsErrors.join('\n  ') : 'none'));
  console.log('\n' + passed + '/' + (passed + failed) + ' flow checks passed\n');

  await browser.close();
  server.close();
  process.exit(failed || jsErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
