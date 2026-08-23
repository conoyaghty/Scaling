/*
 * Copy this file to js/config.js and paste your Google Maps API key in.
 * js/config.js is gitignored so your key never reaches GitHub.
 *
 * SECURITY — do this before you deploy anywhere public:
 *   In Google Cloud Console → Credentials → your key → Application restrictions,
 *   set "Websites" and add ONLY your own origins, e.g.
 *       https://conoyaghty.github.io/*
 *       http://localhost:8000/*
 *   Then under API restrictions, limit the key to:
 *       Maps JavaScript API, Geocoding API
 *
 * A Maps JS key is necessarily visible in the browser — that is normal and
 * expected. Referrer restriction is what stops anyone else spending your quota.
 */
window.AREA_TOOL_CONFIG = {
  googleMapsApiKey: 'PASTE_YOUR_KEY_HERE',

  // Map starts here before the first search. Default: roughly centre of Ireland.
  defaultCentre: { lat: 53.4239, lng: -7.9407 },
  defaultZoom: 7,

  // Zoom used after a successful eircode lookup. 20 is the usual max for
  // Irish aerial imagery; 21 exists in some urban areas.
  measureZoom: 20,

  // Bias geocoding to Ireland so partial/ambiguous input resolves sensibly.
  geocodeRegion: 'IE',
};
