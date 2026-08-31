/*
 * Area & Quote — app wiring.
 *
 * Flow: eircode → geocode → top-down satellite at max zoom → tap the corners →
 * geodesic area in m² → rate lookup → quote.
 */
(function () {
  'use strict';

  var CFG = window.AREA_TOOL_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };

  var map = null;
  var searchMarker = null;
  var poly = null;
  var points = [];            // google.maps.LatLng[]
  var vertexMarkers = [];
  var rateState = window.Rates.load();

  var job = {
    address: null,
    query: null,
    areas: [],                // { id, label, sqm, perimeter, service, surface }
  };
  var nextAreaId = 1;
  var lastSearch = null;

  /* ══ Boot ═══════════════════════════════════════════════ */

  function boot() {
    buildRateTable();
    buildDialogSelects();
    wireUi();
    renderJob();

    var key = CFG.googleMapsApiKey;
    if (window.__configMissing || !key || key === 'PASTE_YOUR_KEY_HERE') {
      $('map-loading').hidden = true;
      $('setup-needed').hidden = false;
      return;
    }
    loadMaps(key);
  }

  function loadMaps(key) {
    window.__initMap = initMap;
    window.gm_authFailure = function () {
      $('map-loading').hidden = true;
      showBanner(
        'Google rejected the API key. Check it is correct, that Maps JavaScript API ' +
        'and Geocoding API are enabled, and that this site is allowed under the key\'s ' +
        'website restrictions.', 'error', 0);
    };

    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js' +
            '?key=' + encodeURIComponent(key) +
            '&libraries=geometry' +
            '&loading=async' +
            '&v=weekly' +
            '&callback=__initMap';
    s.async = true;
    s.onerror = function () {
      $('map-loading').hidden = true;
      showBanner('Could not reach Google Maps. Check your connection.', 'error', 0);
    };
    document.head.appendChild(s);
  }

  function initMap() {
    map = new google.maps.Map($('map'), {
      center: CFG.defaultCentre || { lat: 53.4239, lng: -7.9407 },
      zoom: CFG.defaultZoom || 7,
      mapTypeId: 'satellite',
      tilt: 0,                    // true top-down; 45° imagery would distort area
      rotateControl: false,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      zoomControl: true,
      clickableIcons: false,
      gestureHandling: 'greedy',  // one-finger pan on mobile
      maxZoom: 22,
      keyboardShortcuts: false,
    });

    // Google re-enables 45° imagery on zoom change; force it back off.
    map.addListener('tilt_changed', function () {
      if (map.getTilt() !== 0) map.setTilt(0);
    });

    map.addListener('click', function (e) {
      if (e.latLng) addPoint(e.latLng);
    });

    $('map-loading').hidden = true;
    // Only autofocus on desktop — on a phone this would pop the keyboard over the map.
    if (window.matchMedia('(min-width: 860px)').matches) {
      $('search').focus({ preventScroll: true });
    }
  }

  /* ══ Search ═════════════════════════════════════════════ */

  function doSearch() {
    var q = $('search').value.trim();
    if (!q) return;
    if (!map) { showBanner('Map is still loading.', 'warn'); return; }

    setSearching(true);
    window.Geo.geocode(q, CFG.geocodeRegion)
      .then(function (res) {
        lastSearch = res;
        map.setCenter({ lat: res.lat, lng: res.lng });
        map.setZoom(CFG.measureZoom || 20);
        map.setTilt(0);
        dropSearchMarker(res);
        clearMeasurement();

        if (!job.address) {
          job.address = res.formattedAddress;
          job.query = res.query;
        }
        renderJob();

        if (res.warning) {
          showBanner(res.warning, 'warn', 9000);
        } else {
          showBanner(res.formattedAddress, 'ok', 5000);
        }
        $('hint').hidden = false;
      })
      .catch(function (err) {
        showBanner(err.message, 'error', 0);
      })
      .finally(function () { setSearching(false); });
  }

  function setSearching(on) {
    var btn = $('search-go');
    btn.disabled = on;
    btn.textContent = on ? '…' : 'Find';
  }

  function dropSearchMarker(res) {
    if (searchMarker) searchMarker.setMap(null);
    searchMarker = new google.maps.Marker({
      position: { lat: res.lat, lng: res.lng },
      map: map,
      clickable: false,
      zIndex: 1,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: '#f85149',
        fillOpacity: 0.9,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      },
    });
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      showBanner('This device has no location support.', 'error');
      return;
    }
    if (!map) { showBanner('Map is still loading.', 'warn'); return; }

    $('locate').classList.add('is-active');
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        $('locate').classList.remove('is-active');
        map.setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        map.setZoom(CFG.measureZoom || 20);
        map.setTilt(0);
        clearMeasurement();
        $('hint').hidden = false;
        showBanner('Centred on your location (±' + Math.round(pos.coords.accuracy) + ' m).', 'ok', 5000);
      },
      function (err) {
        $('locate').classList.remove('is-active');
        showBanner(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Search by eircode instead.'
            : 'Could not get your location.', 'error');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  }

  /* ══ Measurement ════════════════════════════════════════ */

  function addPoint(latLng) {
    points.push(latLng);
    addVertexMarker(latLng, points.length - 1);
    redraw();
  }

  function addVertexMarker(latLng, index) {
    var m = new google.maps.Marker({
      position: latLng,
      map: map,
      draggable: true,
      zIndex: 3,
      cursor: 'move',
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: '#ffffff',
        fillOpacity: 1,
        strokeColor: '#2f81f7',
        strokeWeight: 3,
      },
    });

    m.addListener('drag', function (e) {
      points[indexOfMarker(m)] = e.latLng;
      redraw();
    });
    m.addListener('dragend', function (e) {
      points[indexOfMarker(m)] = e.latLng;
      redraw();
    });
    // Tap a handle to delete that corner.
    m.addListener('click', function () {
      removePointAt(indexOfMarker(m));
    });

    vertexMarkers.push(m);
    return m;
  }

  function indexOfMarker(m) {
    return vertexMarkers.indexOf(m);
  }

  function removePointAt(i) {
    if (i < 0 || i >= points.length) return;
    points.splice(i, 1);
    vertexMarkers[i].setMap(null);
    vertexMarkers.splice(i, 1);
    redraw();
  }

  function undoPoint() {
    removePointAt(points.length - 1);
  }

  function clearMeasurement() {
    points = [];
    vertexMarkers.forEach(function (m) { m.setMap(null); });
    vertexMarkers = [];
    if (poly) { poly.setMap(null); poly = null; }
    redraw();
  }

  function redraw() {
    // Polygon body
    if (points.length >= 3) {
      if (!poly) {
        poly = new google.maps.Polygon({
          map: map,
          clickable: false,       // taps fall through so you can keep adding points
          zIndex: 2,
          strokeColor: '#2f81f7',
          strokeOpacity: 1,
          strokeWeight: 3,
          fillColor: '#2f81f7',
          fillOpacity: 0.28,
        });
      }
      poly.setPath(points);
    } else if (poly) {
      poly.setMap(null);
      poly = null;
    }

    var sqm = window.Geo.areaOfPath(points);
    var perim = points.length >= 3 ? window.Geo.perimeterOfPath(points) : 0;

    var readout = $('readout');
    readout.hidden = points.length === 0;
    $('readout-sqm').textContent = window.Geo.formatArea(sqm);
    $('readout-points').textContent = points.length + (points.length === 1 ? ' point' : ' points');
    $('readout-perimeter').textContent = perim ? Math.round(perim) + ' m perimeter' : '';

    $('undo').disabled = points.length === 0;
    $('clear').disabled = points.length === 0;
    $('save-area').disabled = points.length < 3;

    if (points.length > 0) $('hint').hidden = true;
  }

  /* ══ Save-area dialog ═══════════════════════════════════ */

  function buildDialogSelects() {
    fillSelect($('dlg-surface'), window.Rates.SURFACES);
    fillSelect($('dlg-service'), window.Rates.SERVICES);
    fillSelect($('dlg-confidence'), window.Rates.CONFIDENCE);

    var pitch = $('dlg-pitch');
    pitch.innerHTML = '';
    window.Rates.PITCHES.forEach(function (p) {
      var o = document.createElement('option');
      o.value = String(p.deg);
      o.textContent = p.label + '  (×' + window.Rates.pitchMultiplier(p.deg).toFixed(2) + ')';
      pitch.appendChild(o);
    });
    pitch.value = String(window.Rates.DEFAULT_PITCH);
  }

  function fillSelect(sel, values) {
    sel.innerHTML = '';
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.textContent = v;
      o.value = v;
      sel.appendChild(o);
    });
  }

  function openSaveDialog() {
    if (points.length < 3) return;
    var sqm = window.Geo.areaOfPath(points);
    $('dlg-sqm').textContent = window.Geo.formatArea(sqm);

    // Sensible default: a saved "Driveway" already exists → next one is probably a patio.
    var used = job.areas.map(function (a) { return a.label; });
    var labelSel = $('dlg-label');
    if (used.indexOf('Driveway') !== -1 && used.indexOf('Patio') === -1) {
      labelSel.value = 'Patio';
    } else if (used.indexOf('Driveway') === -1) {
      labelSel.value = 'Driveway';
    }

    // Always reset to Clear. Confidence must be a deliberate call on each area —
    // inheriting it from the last one would quietly add contingency to a line
    // you could see perfectly well.
    $('dlg-confidence').value = 'Clear';
    $('dlg-pitch').value = String(window.Rates.DEFAULT_PITCH);

    updateDialogPrice();
    $('area-dialog').showModal();
  }

  function updateDialogPrice() {
    var sqm = window.Geo.areaOfPath(points);
    var service = $('dlg-service').value;
    var surface = $('dlg-surface').value;
    var confidence = $('dlg-confidence').value;
    var el = $('dlg-price');

    // The pitch control only makes sense for a roof.
    var roof = window.Rates.isRoof(surface);
    $('dlg-pitch-row').hidden = !roof;

    // Picking a roof surface while the label is still on a ground default means
    // the label was never a deliberate choice — correct it rather than emitting
    // a quote line that reads "Driveway — Roof cleaning".
    var labelSel = $('dlg-label');
    if (roof && (labelSel.value === 'Driveway' || labelSel.value === 'Patio')) {
      labelSel.value = 'Roof';
    }

    var pitch = roof ? parseFloat($('dlg-pitch').value) : 0;
    var mult = roof ? window.Rates.pitchMultiplier(pitch) : 1;
    var chargeSqm = sqm * mult;

    var rate = window.Rates.rateFor(rateState, service, surface);
    if (rate === null) {
      el.textContent = 'No rate set for ' + service + ' on ' + surface +
                       ' — it will be added at €0 until you set one.';
      el.classList.add('is-unpriced');
      return;
    }

    el.classList.remove('is-unpriced');
    var lines = [];
    // Only worth showing when the pitch actually changes the number.
    if (roof && pitch > 0) {
      lines.push(window.Geo.formatArea(sqm) + ' m² footprint × ' + mult.toFixed(2) +
                 ' (' + pitch + '°) = ' + window.Geo.formatArea(chargeSqm) + ' m² roof');
    }
    var base = chargeSqm * rate;
    lines.push(window.Geo.formatArea(chargeSqm) + ' m² × €' + rate.toFixed(2) + ' = ' +
               window.Geo.formatMoney(base));

    var pct = window.Rates.contingencyFor(rateState, confidence);
    if (pct > 0) {
      lines.push('+ ' + pct + '% contingency = ' + window.Geo.formatMoney(base * (1 + pct / 100)));
    }
    el.textContent = lines.join('\n');
  }

  function commitArea() {
    var sqm = window.Geo.areaOfPath(points);
    job.areas.push({
      id: nextAreaId++,
      label: $('dlg-label').value,
      sqm: sqm,
      perimeter: window.Geo.perimeterOfPath(points),
      service: $('dlg-service').value,
      surface: $('dlg-surface').value,
      confidence: $('dlg-confidence').value,
      pitch: window.Rates.isRoof($('dlg-surface').value)
        ? parseFloat($('dlg-pitch').value)
        : 0,
    });
    if (!job.address && lastSearch) {
      job.address = lastSearch.formattedAddress;
      job.query = lastSearch.query;
    }
    clearMeasurement();
    renderJob();
    openSheet(true);
    showBanner('Added ' + window.Geo.formatArea(sqm) + ' m² to the job.', 'ok', 3500);
  }

  /* ══ Job + quote rendering ══════════════════════════════ */

  function renderJob() {
    var q = window.Rates.quote(rateState, job.areas);

    var addr = $('job-address');
    if (job.address) {
      addr.hidden = false;
      addr.textContent = (job.query ? job.query + ' — ' : '') + job.address;
    } else {
      addr.hidden = true;
    }

    var list = $('area-list');
    list.innerHTML = '';
    q.lines.forEach(function (line, i) {
      var area = job.areas[i];
      var li = document.createElement('li');
      li.className = 'area-item';

      var main = document.createElement('div');
      main.className = 'area-item-main';

      var title = document.createElement('div');
      title.className = 'area-item-title';
      title.textContent = line.label + ' — ' + window.Geo.formatArea(line.chargeSqm) + ' m²';

      var meta = document.createElement('div');
      meta.className = 'area-item-meta';
      meta.textContent = line.service + ' · ' + window.Rates.surfaceLabel(line.surface) +
        (line.rate !== null ? ' · €' + line.rate.toFixed(2) + '/m²' : '');

      if (line.isRoof && line.pitch > 0) {
        meta.appendChild(document.createElement('br'));
        meta.appendChild(document.createTextNode(
          line.pitch + '° pitch · from ' + window.Geo.formatArea(line.sqm) + ' m² footprint'));
      }

      main.appendChild(title);
      main.appendChild(meta);

      if (line.uncertain) {
        var flag = document.createElement('div');
        flag.className = 'area-item-flag';
        flag.textContent = line.contingencyPct > 0
          ? line.confidence + ' · +' + line.contingencyPct + '% contingency'
          : line.confidence + ' · no contingency applied';
        main.appendChild(flag);
      }

      var price = document.createElement('div');
      price.className = 'area-item-price' + (line.unpriced ? ' is-unpriced' : '');
      price.textContent = line.unpriced ? 'no rate' : window.Geo.formatMoney(line.total);

      var rm = document.createElement('button');
      rm.className = 'remove-btn';
      rm.type = 'button';
      rm.innerHTML = '&times;';
      rm.setAttribute('aria-label', 'Remove ' + line.label);
      rm.addEventListener('click', function () {
        job.areas = job.areas.filter(function (a) { return a.id !== area.id; });
        renderJob();
      });

      li.appendChild(main);
      li.appendChild(price);
      li.appendChild(rm);
      list.appendChild(li);
    });

    var has = job.areas.length > 0;
    $('area-empty').hidden = has;
    $('quote').hidden = !has;

    $('q-subtotal').textContent = window.Geo.formatMoney(q.subtotal);
    $('q-min-row').hidden = !q.minChargeApplied;
    $('q-chargeable').textContent = window.Geo.formatMoney(q.chargeable);
    $('q-vat-row').hidden = !q.vatEnabled;
    $('q-vat-label').textContent = 'VAT ' + q.vatRate + '%';
    $('q-vat').textContent = window.Geo.formatMoney(q.vat);
    $('q-total').textContent = window.Geo.formatMoney(q.total);

    var warn = $('q-warning');
    warn.hidden = !q.hasUnpriced;
    if (q.hasUnpriced) {
      warn.textContent = 'Some lines have no rate set and are counted as €0. Set them on the Rates tab.';
    }

    $('sheet-count').textContent = has
      ? job.areas.length + (job.areas.length === 1 ? ' area · ' : ' areas · ') +
        window.Geo.formatArea(q.lines.reduce(function (s, l) { return s + l.chargeSqm; }, 0)) + ' m²'
      : 'No areas yet';
    $('sheet-total').textContent = window.Geo.formatMoney(q.total);
  }

  function quoteText() {
    var q = window.Rates.quote(rateState, job.areas);
    var out = [];
    out.push('QUOTE' + (job.query ? ' — ' + job.query : ''));
    if (job.address) out.push(job.address);
    out.push('');

    q.lines.forEach(function (l) {
      // "Driveway — Instant softwash (Block paving)". Parenthesising the surface
      // keeps it readable when a name contains its own dash or slash.
      out.push(l.label + ' — ' + l.service + ' (' + window.Rates.surfaceLabel(l.surface) + ')');
      if (l.isRoof && l.pitch > 0) {
        out.push('  ' + window.Geo.formatArea(l.sqm) + ' m² footprint at ' + l.pitch +
                 '° = ' + window.Geo.formatArea(l.chargeSqm) + ' m² roof area');
      }
      if (l.rate === null) {
        out.push('  ' + window.Geo.formatArea(l.chargeSqm) + ' m² — no rate set');
        return;
      }
      out.push('  ' + window.Geo.formatArea(l.chargeSqm) + ' m² @ €' + l.rate.toFixed(2) +
               '/m² = ' + window.Geo.formatMoney(l.contingency > 0 ? l.base : l.total));
      if (l.contingency > 0) {
        out.push('  + ' + l.contingencyPct + '% contingency = ' + window.Geo.formatMoney(l.total));
      }
    });

    out.push('');
    out.push('Subtotal   ' + window.Geo.formatMoney(q.subtotal));
    if (q.minChargeApplied) {
      out.push('Min charge ' + window.Geo.formatMoney(q.chargeable));
    }
    if (q.vatEnabled) {
      out.push('VAT ' + q.vatRate + '%  ' + window.Geo.formatMoney(q.vat));
    }
    out.push('TOTAL      ' + window.Geo.formatMoney(q.total));
    out.push('');

    // This goes out as a firm price without a site visit, so it states the basis
    // of the measurement and what would change it — rather than inviting the
    // customer to expect a visit that is not coming.
    if (q.hasUncertain) {
      out.push('Areas measured from current aerial imagery. Part of the area was');
      out.push('obscured on the imagery and has been estimated, with a contingency');
      out.push('included. Price holds unless the area on the day differs materially');
      out.push('from the above.');
    } else {
      out.push('Areas measured from current aerial imagery. Price holds unless the');
      out.push('area on the day differs materially from the above.');
    }
    return out.join('\n');
  }

  function copyQuote() {
    var text = quoteText();
    var done = function () { showBanner('Quote copied.', 'ok', 2500); };
    var fail = function () {
      window.prompt('Copy the quote:', text);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail);
    } else {
      fail();
    }
  }

  function newJob() {
    if (job.areas.length && !window.confirm('Clear this job and start a new one?')) return;
    job = { address: null, query: null, areas: [] };
    lastSearch = null;
    clearMeasurement();
    if (searchMarker) { searchMarker.setMap(null); searchMarker = null; }
    $('search').value = '';
    $('search-clear').hidden = true;
    renderJob();
    $('search').focus({ preventScroll: true });
  }

  /* ══ Rates tab ══════════════════════════════════════════ */

  function buildRateTable() {
    var table = $('rate-table');
    table.innerHTML = '';

    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    hr.appendChild(th(''));
    window.Rates.SURFACES.forEach(function (s) { hr.appendChild(th(s)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    window.Rates.SERVICES.forEach(function (svc) {
      var tr = document.createElement('tr');
      tr.appendChild(th(svc));
      window.Rates.SURFACES.forEach(function (surf) {
        var td = document.createElement('td');
        var input = document.createElement('input');
        input.type = 'number';
        input.inputMode = 'decimal';
        input.min = '0';
        input.step = '0.05';
        input.placeholder = '—';
        input.dataset.service = svc;
        input.dataset.surface = surf;
        var v = rateState.rates[svc][surf];
        input.value = (typeof v === 'number') ? v.toFixed(2) : '';
        input.setAttribute('aria-label', svc + ' on ' + surf + ', euro per square metre');
        td.appendChild(input);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var grid = $('contingency-grid');
    grid.innerHTML = '';
    window.Rates.CONFIDENCE.forEach(function (level) {
      var label = document.createElement('label');
      label.textContent = level + ' (%)';
      var input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'decimal';
      input.min = '0';
      input.step = '1';
      input.dataset.confidence = level;
      input.value = rateState.settings.contingency[level];
      input.setAttribute('aria-label', 'Contingency percentage for ' + level);
      label.appendChild(input);
      grid.appendChild(label);
    });

    $('set-min').value = rateState.settings.minCharge;
    $('set-vat').value = rateState.settings.vatRate;
    $('set-vat-on').checked = rateState.settings.vatEnabled;
  }

  function th(text) {
    var el = document.createElement('th');
    el.scope = 'col';
    el.textContent = text;
    return el;
  }

  function saveRates() {
    var inputs = $('rate-table').querySelectorAll('input');
    Array.prototype.forEach.call(inputs, function (input) {
      var raw = input.value.trim();
      var val = raw === '' ? null : parseFloat(raw);
      rateState.rates[input.dataset.service][input.dataset.surface] =
        (val !== null && isFinite(val) && val >= 0) ? val : null;
    });

    var contInputs = $('contingency-grid').querySelectorAll('input');
    Array.prototype.forEach.call(contInputs, function (input) {
      var v = parseFloat(input.value);
      rateState.settings.contingency[input.dataset.confidence] =
        (isFinite(v) && v >= 0) ? v : 0;
    });

    var min = parseFloat($('set-min').value);
    var vat = parseFloat($('set-vat').value);
    rateState.settings.minCharge = (isFinite(min) && min >= 0) ? min : 0;
    rateState.settings.vatRate = (isFinite(vat) && vat >= 0) ? vat : 0;
    rateState.settings.vatEnabled = $('set-vat-on').checked;

    var ok = window.Rates.save(rateState);
    buildRateTable();
    renderJob();
    showBanner(ok ? 'Rates saved.' : 'Rates applied, but could not be saved to this browser.',
               ok ? 'ok' : 'warn', 3000);
  }

  function resetRates() {
    if (!window.confirm('Reset all rates to the built-in placeholders?')) return;
    rateState = window.Rates.reset();
    buildRateTable();
    renderJob();
    showBanner('Rates reset to defaults.', 'ok', 3000);
  }

  /* ══ Chrome ═════════════════════════════════════════════ */

  var bannerTimer = null;
  function showBanner(msg, kind, ms) {
    var b = $('banner');
    b.textContent = msg;
    b.className = 'banner is-' + (kind || 'ok');
    b.hidden = false;
    clearTimeout(bannerTimer);
    var timeout = (ms === undefined) ? 6000 : ms;
    if (timeout > 0) {
      bannerTimer = setTimeout(function () { b.hidden = true; }, timeout);
    }
  }

  function openSheet(open) {
    $('sheet').classList.toggle('is-open', open);
    $('sheet-handle').setAttribute('aria-expanded', String(open));
  }

  function wireUi() {
    $('search-go').addEventListener('click', doSearch);
    $('search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('search').blur(); doSearch(); }
    });
    $('search').addEventListener('input', function () {
      $('search-clear').hidden = $('search').value === '';
    });
    $('search-clear').addEventListener('click', function () {
      $('search').value = '';
      $('search-clear').hidden = true;
      $('search').focus();
    });
    $('locate').addEventListener('click', useMyLocation);

    $('undo').addEventListener('click', undoPoint);
    $('clear').addEventListener('click', clearMeasurement);
    $('save-area').addEventListener('click', openSaveDialog);

    $('dlg-service').addEventListener('change', updateDialogPrice);
    $('dlg-surface').addEventListener('change', updateDialogPrice);
    $('dlg-confidence').addEventListener('change', updateDialogPrice);
    $('dlg-pitch').addEventListener('change', updateDialogPrice);

    // event.submitter is unavailable in older Safari, so track the button directly.
    var dialogConfirmed = false;
    $('dlg-ok').addEventListener('click', function () { dialogConfirmed = true; });
    $('area-form').addEventListener('submit', function (e) {
      var ok = (e.submitter ? e.submitter.value === 'ok' : dialogConfirmed);
      dialogConfirmed = false;
      if (ok) commitArea();
    });

    $('copy-quote').addEventListener('click', copyQuote);
    $('new-job').addEventListener('click', newJob);
    $('save-rates').addEventListener('click', saveRates);
    $('reset-rates').addEventListener('click', resetRates);

    $('sheet-handle').addEventListener('click', function () {
      openSheet(!$('sheet').classList.contains('is-open'));
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.addEventListener('click', function () {
        var name = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(function (t) {
          var on = t === tab;
          t.classList.toggle('is-active', on);
          t.setAttribute('aria-selected', String(on));
        });
        document.querySelectorAll('.tab-panel').forEach(function (p) {
          p.classList.toggle('is-active', p.id === 'tab-' + name);
        });
        openSheet(true);
      });
    });

    // Desktop conveniences.
    document.addEventListener('keydown', function (e) {
      if (e.target.matches('input, select, textarea')) return;
      if ((e.key === 'z' && (e.metaKey || e.ctrlKey)) || e.key === 'Backspace') {
        e.preventDefault(); undoPoint();
      } else if (e.key === 'Escape') {
        clearMeasurement();
      } else if (e.key === 'Enter' && points.length >= 3) {
        openSaveDialog();
      }
    });

    // Don't lose an in-progress job to an accidental back-swipe.
    window.addEventListener('beforeunload', function (e) {
      if (job.areas.length || points.length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
