/*
 * A stand-in for the Google Maps JS API, served to the browser in place of the
 * real one during test/flow.test.js. It implements only what app.js touches,
 * but computeArea/computeDistanceBetween are the genuine spherical formulas,
 * so measurements exercised through this mock are numerically real.
 *
 * Exposes test hooks on window.__mock: tap(lat,lng), dragVertex(i,lat,lng).
 */
(function () {
  'use strict';

  var R = 6378137;
  var rad = function (d) { return d * Math.PI / 180; };

  function LatLng(lat, lng) {
    this._lat = lat;
    this._lng = lng;
  }
  LatLng.prototype.lat = function () { return this._lat; };
  LatLng.prototype.lng = function () { return this._lng; };

  function toLatLng(v) {
    if (v instanceof LatLng) return v;
    if (typeof v.lat === 'function') return new LatLng(v.lat(), v.lng());
    return new LatLng(v.lat, v.lng);
  }

  function Emitter() { this._h = {}; }
  Emitter.prototype.addListener = function (ev, fn) {
    (this._h[ev] = this._h[ev] || []).push(fn);
    return { remove: function () {} };
  };
  Emitter.prototype.emit = function (ev, arg) {
    (this._h[ev] || []).forEach(function (fn) { fn(arg); });
  };

  /* ── Map ─────────────────────────────────────────────── */
  function Map(el, opts) {
    Emitter.call(this);
    this.el = el;
    this.opts = opts || {};
    this._tilt = this.opts.tilt || 0;
    this._zoom = this.opts.zoom;
    this._center = this.opts.center;
    window.__mock.map = this;
    el.setAttribute('data-mock-map', 'ready');
  }
  Map.prototype = Object.create(Emitter.prototype);
  Map.prototype.setCenter = function (c) { this._center = c; };
  Map.prototype.getCenter = function () { return this._center; };
  Map.prototype.setZoom = function (z) { this._zoom = z; };
  Map.prototype.getZoom = function () { return this._zoom; };
  Map.prototype.setTilt = function (t) { this._tilt = t; };
  Map.prototype.getTilt = function () { return this._tilt; };

  /* ── Marker ──────────────────────────────────────────── */
  function Marker(opts) {
    Emitter.call(this);
    this.opts = opts || {};
    this._position = opts && opts.position ? toLatLng(opts.position) : null;
    this._map = opts ? opts.map : null;
    this.draggable = !!(opts && opts.draggable);
    if (this.draggable) window.__mock.vertices.push(this);
    else window.__mock.markers.push(this);
  }
  Marker.prototype = Object.create(Emitter.prototype);
  Marker.prototype.setMap = function (m) {
    this._map = m;
    if (m === null) {
      var list = this.draggable ? window.__mock.vertices : window.__mock.markers;
      var i = list.indexOf(this);
      if (i !== -1) list.splice(i, 1);
    }
  };
  Marker.prototype.getPosition = function () { return this._position; };
  Marker.prototype.setPosition = function (p) { this._position = toLatLng(p); };

  /* ── Polygon ─────────────────────────────────────────── */
  function Polygon(opts) {
    this.opts = opts || {};
    this._path = [];
    this._map = opts ? opts.map : null;
    window.__mock.polygons.push(this);
  }
  Polygon.prototype.setMap = function (m) { this._map = m; };
  Polygon.prototype.setPath = function (p) { this._path = p.slice(); };
  Polygon.prototype.getPath = function () { return this._path; };

  /* ── Geocoder ────────────────────────────────────────── */
  function Geocoder() {}
  Geocoder.prototype.geocode = function (req, cb) {
    var scripted = window.__mock.geocodeResponse;
    if (scripted === 'ZERO_RESULTS') { cb(null, 'ZERO_RESULTS'); return; }
    if (scripted === 'REQUEST_DENIED') { cb(null, 'REQUEST_DENIED'); return; }

    var loc = window.__mock.geocodeLocation;
    setTimeout(function () {
      cb([{
        formatted_address: window.__mock.geocodeAddress,
        partial_match: scripted === 'PARTIAL',
        geometry: {
          location: new LatLng(loc.lat, loc.lng),
          location_type: scripted === 'APPROXIMATE' ? 'APPROXIMATE' : 'ROOFTOP',
        },
      }], 'OK');
    }, 0);
  };

  /* ── Real spherical geometry ─────────────────────────── */
  function computeArea(path) {
    var pts = path.map(toLatLng);
    if (pts.length < 3) return 0;
    function polarTriangleArea(t1, lng1, t2, lng2) {
      var dLng = lng1 - lng2;
      var t = t1 * t2;
      return 2 * Math.atan2(t * Math.sin(dLng), 1 + t * Math.cos(dLng));
    }
    var total = 0;
    var prev = pts[pts.length - 1];
    var prevTanLat = Math.tan((Math.PI / 2 - rad(prev.lat())) / 2);
    var prevLng = rad(prev.lng());
    for (var i = 0; i < pts.length; i++) {
      var tanLat = Math.tan((Math.PI / 2 - rad(pts[i].lat())) / 2);
      var lng = rad(pts[i].lng());
      total += polarTriangleArea(tanLat, lng, prevTanLat, prevLng);
      prevTanLat = tanLat;
      prevLng = lng;
    }
    return Math.abs(total * R * R);
  }

  function computeDistanceBetween(a, b) {
    var p = toLatLng(a), q = toLatLng(b);
    var dLat = rad(q.lat() - p.lat());
    var dLng = rad(q.lng() - p.lng());
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(rad(p.lat())) * Math.cos(rad(q.lat())) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  /* ── Wire up the fake namespace ──────────────────────── */
  window.__mock = {
    map: null,
    markers: [],
    vertices: [],
    polygons: [],
    geocodeLocation: { lat: 53.4239, lng: -7.9407 },
    geocodeAddress: '12 Test Road, Athlone, Co. Westmeath',
    geocodeResponse: 'OK',

    tap: function (lat, lng) {
      window.__mock.map.emit('click', { latLng: new LatLng(lat, lng) });
    },
    dragVertex: function (i, lat, lng) {
      var m = window.__mock.vertices[i];
      m.setPosition({ lat: lat, lng: lng });
      m.emit('drag', { latLng: new LatLng(lat, lng) });
      m.emit('dragend', { latLng: new LatLng(lat, lng) });
    },
    clickVertex: function (i) {
      window.__mock.vertices[i].emit('click', {});
    },
    activePolygon: function () {
      var live = window.__mock.polygons.filter(function (p) { return p._map; });
      return live.length ? live[live.length - 1] : null;
    },
  };

  window.google = {
    maps: {
      Map: Map,
      Marker: Marker,
      Polygon: Polygon,
      Geocoder: Geocoder,
      LatLng: LatLng,
      SymbolPath: { CIRCLE: 'circle' },
      geometry: {
        spherical: {
          computeArea: computeArea,
          computeDistanceBetween: computeDistanceBetween,
        },
      },
    },
  };

  if (typeof window.__initMap === 'function') window.__initMap();
})();
