/*
 * Rate card + pricing logic.
 *
 * Rates below are the real ones. To change them for every device edit
 * DEFAULT_RATES here; to change them on one device use the app's Rates tab
 * (those edits are saved to that browser's localStorage).
 */
(function (global) {
  'use strict';

  var GROUND_SURFACES = [
    'Concrete',
    'Block paving',
    'Tarmac',
    'Limestone',
    'Sandstone',
    'Granite',
    'Travertine',
    'Resin',
    'Porcelain',
    'Decking',
  ];

  /* Priced on sloped area rather than footprint — see PITCHES. */
  var ROOF_SURFACES = ['Flat tiles (roof)', 'Profiled / slate (roof)'];

  var SURFACES = GROUND_SURFACES.concat(ROOF_SURFACES);

  var SERVICES = [
    'Pressure washing',
    'Instant softwash',
    'Progressive softwash',
    'Roof cleaning',
  ];

  function isRoof(surface) {
    return ROOF_SURFACES.indexOf(surface) !== -1;
  }

  /*
   * The "(roof)" suffix disambiguates the surface picker, but on a printed
   * quote it sits beside "Roof cleaning" and just nests brackets. Strip it.
   */
  function surfaceLabel(surface) {
    return String(surface || '').replace(/\s*\(roof\)$/, '');
  }

  /*
   * The rate card, stated as rules rather than as a 4 × 12 grid of literals —
   * one place to change, and no chance of a cell being missed when a surface is
   * added. Every combination not set below is null, meaning "not offered": the
   * app flags such a line on the quote rather than pricing it at zero.
   */
  var PRESSURE_WASH_STANDARD = 3.50;
  var PRESSURE_WASH_PREMIUM = 4.00;

  /* The only surfaces that take the higher pressure-washing rate. */
  var PRESSURE_WASH_PREMIUM_SURFACES = [
    'Block paving',
    'Tarmac',
    'Limestone',
    'Resin',
    'Decking',
  ];

  var INSTANT_SOFTWASH = 4.50;
  var PROGRESSIVE_SOFTWASH = 3.50;
  var ROOF_CLEANING = {
    'Flat tiles (roof)': 7.50,
    'Profiled / slate (roof)': 8.50,
  };

  function buildDefaultRates() {
    var rates = {};
    SERVICES.forEach(function (svc) {
      rates[svc] = {};
      SURFACES.forEach(function (surf) { rates[svc][surf] = null; });
    });

    GROUND_SURFACES.forEach(function (surf) {
      rates['Pressure washing'][surf] =
        PRESSURE_WASH_PREMIUM_SURFACES.indexOf(surf) !== -1
          ? PRESSURE_WASH_PREMIUM
          : PRESSURE_WASH_STANDARD;
      rates['Instant softwash'][surf] = INSTANT_SOFTWASH;
      rates['Progressive softwash'][surf] = PROGRESSIVE_SOFTWASH;
    });

    Object.keys(ROOF_CLEANING).forEach(function (surf) {
      rates['Roof cleaning'][surf] = ROOF_CLEANING[surf];
    });

    return rates;
  }

  var DEFAULT_RATES = buildDefaultRates();

  /*
   * Aerial imagery measures a roof's FOOTPRINT. The actual surface you clean is
   * larger by 1/cos(pitch), and at Irish roof pitches that is not a rounding
   * error — a 35° roof is 22% bigger than it looks from above. Pricing the
   * footprint would under-quote by that much.
   */
  var PITCHES = [
    { label: 'No pitch — footprint only', deg: 0 },
    { label: '15° shallow', deg: 15 },
    { label: '20°', deg: 20 },
    { label: '25°', deg: 25 },
    { label: '30°', deg: 30 },
    { label: '35° (typical)', deg: 35 },
    { label: '40°', deg: 40 },
    { label: '45° steep', deg: 45 },
    { label: '50° very steep', deg: 50 },
  ];

  var DEFAULT_PITCH = 35;

  function pitchMultiplier(deg) {
    var d = (typeof deg === 'number' && isFinite(deg)) ? deg : 0;
    if (d <= 0) return 1;
    if (d >= 85) d = 85;                      // guard against a divide-by-~zero
    return 1 / Math.cos(d * Math.PI / 180);
  }

  function pitchLabel(deg) {
    for (var i = 0; i < PITCHES.length; i++) {
      if (PITCHES[i].deg === deg) return PITCHES[i].label;
    }
    return deg + '°';
  }

  /*
   * How well the imagery showed the boundary. These quotes go out without a
   * site visit, so an area you had to guess at under tree cover carries real
   * risk — this records which lines those are and optionally prices the risk in.
   */
  var CONFIDENCE = ['Clear', 'Part obscured', 'Mostly estimated'];

  var DEFAULT_SETTINGS = {
    minCharge: 120,     // € — job floor, applied to the ex-VAT subtotal
    vatRate: 13.5,      // % — Irish reduced rate typically applies to these services
    vatEnabled: true,
    // % added to a line you could not see clearly on the imagery. Off by
    // default: small measuring error is acceptable, so the confidence level is
    // a note to yourself unless you deliberately want it to move the price.
    contingency: {
      'Clear': 0,
      'Part obscured': 0,
      'Mostly estimated': 0,
    },
  };

  var STORAGE_KEY = 'areaTool.rates.v1';

  function deepClone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  /*
   * Round to cents, half-up, without binary-float surprises.
   * (1113.435).toFixed(2) gives "1113.43" because the stored double is a hair
   * below the decimal value; the exponential round-trip does the rounding in
   * decimal instead, so half-cents go up as an invoice reader expects.
   */
  function round2(v) {
    if (!isFinite(v)) return 0;
    var r = Number(Math.round(Number(v + 'e+2')) + 'e-2');
    return isFinite(r) ? r : Math.round(v * 100) / 100;
  }

  function load() {
    var state = { rates: deepClone(DEFAULT_RATES), settings: deepClone(DEFAULT_SETTINGS) };
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        // Merge rather than replace, so newly added services/surfaces still appear.
        SERVICES.forEach(function (svc) {
          if (!saved.rates || !saved.rates[svc]) return;
          SURFACES.forEach(function (surf) {
            if (Object.prototype.hasOwnProperty.call(saved.rates[svc], surf)) {
              state.rates[svc][surf] = saved.rates[svc][surf];
            }
          });
        });
        if (saved.settings) {
          Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
            if (k === 'contingency') return;   // nested — merged per level below
            if (Object.prototype.hasOwnProperty.call(saved.settings, k)) {
              state.settings[k] = saved.settings[k];
            }
          });
          // Per level, so a browser holding settings saved before contingency
          // existed still picks up the defaults for any level it lacks.
          if (saved.settings.contingency) {
            CONFIDENCE.forEach(function (level) {
              var v = saved.settings.contingency[level];
              if (typeof v === 'number' && isFinite(v) && v >= 0) {
                state.settings.contingency[level] = v;
              }
            });
          }
        }
      }
    } catch (e) {
      // Private browsing or corrupt data — fall back to defaults silently.
      console.warn('Could not read saved rates, using defaults.', e);
    }
    return state;
  }

  function save(state) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('Could not save rates.', e);
      return false;
    }
  }

  function reset() {
    try {
      global.localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* ignore */ }
    return { rates: deepClone(DEFAULT_RATES), settings: deepClone(DEFAULT_SETTINGS) };
  }

  function rateFor(state, service, surface) {
    var row = state.rates[service];
    if (!row) return null;
    var r = row[surface];
    return (typeof r === 'number' && isFinite(r)) ? r : null;
  }

  function contingencyFor(state, confidence) {
    var c = state.settings.contingency || {};
    var v = c[confidence || 'Clear'];
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
  }

  /*
   * areas: [{ label, sqm, service, surface, confidence, pitch }]
   *   sqm   — measured footprint from the imagery
   *   pitch — roof pitch in degrees; ignored for ground surfaces
   *
   * Returns a fully broken-out quote so the UI never re-derives money itself.
   */
  function quote(state, areas) {
    // Each line is rounded to cents here, and the subtotal is the sum of those
    // rounded lines — so the figures printed on a quote always add up.
    var lines = areas.map(function (a) {
      var rate = rateFor(state, a.service, a.surface);
      var confidence = a.confidence || 'Clear';
      var pct = contingencyFor(state, confidence);

      // Roofs are charged on sloped area; everything else on the footprint.
      var roof = isRoof(a.surface);
      var pitch = roof ? (a.pitch || 0) : 0;
      var mult = roof ? pitchMultiplier(pitch) : 1;
      var chargeSqm = a.sqm * mult;

      var base = (rate === null) ? null : round2(chargeSqm * rate);
      var uplift = (base === null) ? 0 : round2(base * (pct / 100));
      return {
        label: a.label,
        sqm: a.sqm,                 // footprint as measured
        chargeSqm: chargeSqm,       // what the rate is applied to
        isRoof: roof,
        pitch: pitch,
        pitchMultiplier: mult,
        service: a.service,
        surface: a.surface,
        rate: rate,
        confidence: confidence,
        uncertain: confidence !== 'Clear',
        contingencyPct: pct,
        base: base,
        contingency: uplift,
        total: (base === null) ? null : round2(base + uplift),
        unpriced: rate === null,
      };
    });

    var subtotal = round2(lines.reduce(function (sum, l) {
      return sum + (l.total || 0);
    }, 0));

    var minChargeApplied = false;
    var chargeable = subtotal;
    if (lines.length > 0 && subtotal > 0 && subtotal < state.settings.minCharge) {
      chargeable = round2(state.settings.minCharge);
      minChargeApplied = true;
    }

    var vat = state.settings.vatEnabled
      ? round2(chargeable * (state.settings.vatRate / 100))
      : 0;

    return {
      lines: lines,
      subtotal: subtotal,
      chargeable: chargeable,
      minChargeApplied: minChargeApplied,
      vat: vat,
      vatRate: state.settings.vatRate,
      vatEnabled: state.settings.vatEnabled,
      total: round2(chargeable + vat),
      hasUnpriced: lines.some(function (l) { return l.unpriced; }),
      hasUncertain: lines.some(function (l) { return l.uncertain; }),
      hasRoof: lines.some(function (l) { return l.isRoof; }),
      contingencyTotal: round2(lines.reduce(function (s, l) { return s + l.contingency; }, 0)),
    };
  }

  global.Rates = {
    round2: round2,
    SURFACES: SURFACES,
    SERVICES: SERVICES,
    CONFIDENCE: CONFIDENCE,
    GROUND_SURFACES: GROUND_SURFACES,
    ROOF_SURFACES: ROOF_SURFACES,
    surfaceLabel: surfaceLabel,
    PITCHES: PITCHES,
    DEFAULT_PITCH: DEFAULT_PITCH,
    isRoof: isRoof,
    pitchMultiplier: pitchMultiplier,
    pitchLabel: pitchLabel,
    contingencyFor: contingencyFor,
    DEFAULT_RATES: DEFAULT_RATES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    load: load,
    save: save,
    reset: reset,
    rateFor: rateFor,
    quote: quote,
  };
})(window);
