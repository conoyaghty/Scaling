/*
 * Eircode handling, geocoding, and area maths.
 *
 * Area is computed with google.maps.geometry.spherical.computeArea(), which is
 * the same geodesic calculation Google Earth's measure tool performs: it treats
 * vertices as points on a sphere of radius 6 378 137 m and returns true ground
 * area in m². It is NOT a flat pixel-count, so there is no projection error to
 * correct for — an important detail, since naively measuring Web Mercator pixels
 * at Ireland's latitude (~53°N) overstates area by roughly 2.8×.
 */
(function (global) {
  'use strict';

  // Eircode alphabet deliberately omits B, G, I, J, L, M, O, Q, S, U, Z.
  // Routing key is a letter + two digits, with D6W as the one documented exception.
  var EIRCODE_RE = /^(?:[AC-FHKNPRTV-Y][0-9]{2}|D6W)[ -]?[0-9AC-FHKNPRTV-Y]{4}$/i;

  function normaliseEircode(input) {
    if (!input) return null;
    var cleaned = String(input).toUpperCase().replace(/[\s-]/g, '');
    if (cleaned.length !== 7) return null;
    var spaced = cleaned.slice(0, 3) + ' ' + cleaned.slice(3);
    return EIRCODE_RE.test(spaced) ? spaced : null;
  }

  function looksLikeEircode(input) {
    return normaliseEircode(input) !== null;
  }

  /*
   * Resolve a query (eircode or free-text address) to a point.
   * Resolves with { lat, lng, formattedAddress, precise, warning }.
   */
  function geocode(query, region) {
    return new Promise(function (resolve, reject) {
      if (!global.google || !global.google.maps) {
        reject(new Error('Google Maps has not finished loading.'));
        return;
      }

      var eircode = normaliseEircode(query);
      var request = {
        address: eircode || query,
        region: region || 'IE',
        componentRestrictions: { country: 'IE' },
      };

      new global.google.maps.Geocoder().geocode(request, function (results, status) {
        if (status !== 'OK' || !results || !results.length) {
          reject(new Error(describeGeocodeFailure(status, eircode)));
          return;
        }

        var best = results[0];
        var loc = best.geometry.location;
        var locType = best.geometry.location_type; // ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
        var precise = locType === 'ROOFTOP' || locType === 'RANGE_INTERPOLATED';

        var warning = null;
        if (best.partial_match) {
          warning = 'Only a partial match — check this is the right property before measuring.';
        } else if (!precise) {
          warning = eircode
            ? 'This resolved to an approximate point, not a specific building. It may be the centre of the ' +
              eircode.slice(0, 3) + ' routing area. Check the imagery before measuring.'
            : 'Approximate location only — check the imagery before measuring.';
        }

        resolve({
          lat: loc.lat(),
          lng: loc.lng(),
          formattedAddress: best.formatted_address,
          locationType: locType,
          precise: precise,
          warning: warning,
          query: eircode || query,
          wasEircode: !!eircode,
        });
      });
    });
  }

  function describeGeocodeFailure(status, eircode) {
    switch (status) {
      case 'ZERO_RESULTS':
        return eircode
          ? 'No match for eircode ' + eircode + '. Double-check it, or search the address instead.'
          : 'No match for that address. Try including the town and county.';
      case 'OVER_QUERY_LIMIT':
        return 'Google quota exceeded for today. Check billing in Cloud Console.';
      case 'REQUEST_DENIED':
        return 'Request denied — the Geocoding API is probably not enabled for this key, ' +
               'or the key\'s referrer restriction does not cover this site.';
      case 'INVALID_REQUEST':
        return 'Empty or malformed search.';
      default:
        return 'Lookup failed (' + status + '). Check your connection and try again.';
    }
  }

  /* Ground area in m² for an array of google.maps.LatLng. Needs ≥3 vertices. */
  function areaOfPath(latLngs) {
    if (!latLngs || latLngs.length < 3) return 0;
    return global.google.maps.geometry.spherical.computeArea(latLngs);
  }

  /* Closed perimeter in metres — handy sanity check against a tape measure. */
  function perimeterOfPath(latLngs) {
    if (!latLngs || latLngs.length < 2) return 0;
    var spherical = global.google.maps.geometry.spherical;
    var total = 0;
    for (var i = 0; i < latLngs.length; i++) {
      var next = latLngs[(i + 1) % latLngs.length];
      total += spherical.computeDistanceBetween(latLngs[i], next);
    }
    return total;
  }

  function formatArea(sqm) {
    if (!sqm) return '0';
    if (sqm < 10) return sqm.toFixed(2);
    if (sqm < 100) return sqm.toFixed(1);
    return Math.round(sqm).toString();
  }

  /* Uses Rates.round2 so display rounding matches the rounding used to price. */
  function formatMoney(v) {
    var rounded = (global.Rates && global.Rates.round2) ? global.Rates.round2(v) : v;
    return '€' + rounded.toFixed(2);
  }

  global.Geo = {
    EIRCODE_RE: EIRCODE_RE,
    normaliseEircode: normaliseEircode,
    looksLikeEircode: looksLikeEircode,
    geocode: geocode,
    areaOfPath: areaOfPath,
    perimeterOfPath: perimeterOfPath,
    formatArea: formatArea,
    formatMoney: formatMoney,
  };
})(window);
