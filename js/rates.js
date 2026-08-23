/*
 * Rate card + pricing logic.
 *
 * ⚠️  THE NUMBERS BELOW ARE PLACEHOLDERS. Replace them with your real rates.
 * You can edit them in the app (Rates tab) — edits are saved to this browser's
 * localStorage. To change the defaults for every device, edit DEFAULT_RATES here.
 */
(function (global) {
  'use strict';

  var SURFACES = [
    'Tarmac',
    'Concrete',
    'Block paving',
    'Slab / natural stone',
    'Gravel',
    'Decking',
  ];

  var SERVICES = [
    'Pressure wash',
    'Wash + seal',
    'Seal only',
    'Wash + re-sand',
    'Weed treatment',
  ];

  // €/m². null = we do not offer that service on that surface.
  var DEFAULT_RATES = {
    'Pressure wash': {
      'Tarmac': 3.00,
      'Concrete': 3.25,
      'Block paving': 3.75,
      'Slab / natural stone': 4.00,
      'Gravel': null,
      'Decking': 4.50,
    },
    'Wash + seal': {
      'Tarmac': 6.50,
      'Concrete': 6.75,
      'Block paving': 7.50,
      'Slab / natural stone': 8.00,
      'Gravel': null,
      'Decking': 9.00,
    },
    'Seal only': {
      'Tarmac': 4.00,
      'Concrete': 4.00,
      'Block paving': 4.50,
      'Slab / natural stone': 5.00,
      'Gravel': null,
      'Decking': 5.50,
    },
    'Wash + re-sand': {
      'Tarmac': null,
      'Concrete': null,
      'Block paving': 5.50,
      'Slab / natural stone': 5.50,
      'Gravel': null,
      'Decking': null,
    },
    'Weed treatment': {
      'Tarmac': 1.00,
      'Concrete': 1.00,
      'Block paving': 1.25,
      'Slab / natural stone': 1.25,
      'Gravel': 1.50,
      'Decking': null,
    },
  };

  var DEFAULT_SETTINGS = {
    minCharge: 120,     // € — job floor, applied to the ex-VAT subtotal
    vatRate: 13.5,      // % — Irish reduced rate typically applies to these services
    vatEnabled: true,
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
            if (Object.prototype.hasOwnProperty.call(saved.settings, k)) {
              state.settings[k] = saved.settings[k];
            }
          });
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

  /*
   * areas: [{ label, sqm, service, surface }]
   * Returns a fully broken-out quote so the UI never re-derives money itself.
   */
  function quote(state, areas) {
    // Each line is rounded to cents here, and the subtotal is the sum of those
    // rounded lines — so the figures printed on a quote always add up.
    var lines = areas.map(function (a) {
      var rate = rateFor(state, a.service, a.surface);
      var total = (rate === null) ? null : round2(a.sqm * rate);
      return {
        label: a.label,
        sqm: a.sqm,
        service: a.service,
        surface: a.surface,
        rate: rate,
        total: total,
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
    };
  }

  global.Rates = {
    round2: round2,
    SURFACES: SURFACES,
    SERVICES: SERVICES,
    DEFAULT_RATES: DEFAULT_RATES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    load: load,
    save: save,
    reset: reset,
    rateFor: rateFor,
    quote: quote,
  };
})(window);
