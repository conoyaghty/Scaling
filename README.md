# Area & Quote

Measure a driveway, patio or path from aerial imagery by eircode, and price it
off your rate card — on your phone, in about fifteen seconds.

Replaces the manual loop of: open Google Earth → find the property → trace the
outline → read the sqm → look up the rate → do the arithmetic.

---

## Why this doesn't use Google Earth

It can't be automated — Google Earth Web draws to a WebGL canvas with no
readable measurement output, and scripting it breaks Google's terms of service.

It also doesn't need to. Google Earth's measure tool is just *polygon vertices →
geodesic area*. This app calls
[`google.maps.geometry.spherical.computeArea()`](https://developers.google.com/maps/documentation/javascript/reference/geometry),
the same calculation on the same imagery, through the official API. **The number
you get here is the number Google Earth gives you.**

That maths matters more than it sounds. Measuring pixels on a flat Web Mercator
tile at Ireland's latitude overstates area by a factor of about **2.8×**
(1 / cos²53°). `computeArea` works on the sphere, so there is no projection
error to correct. `npm test` verifies this against rectangles of known ground
size from Mizen Head to Malin Head.

---

## Setup

### 1. Get a Google Maps API key

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/).
2. Enable **Maps JavaScript API** and **Geocoding API**.
3. Create an API key under **Credentials**.
4. Attach a billing account (required even inside the free allowance).

Google's monthly free allowance comfortably covers normal quoting volumes —
you'd need hundreds of quotes a month before paying anything. Pricing changes,
so check the current rates and set a budget alert if you want a hard stop.

### 2. Lock the key down — do this before deploying

A Maps JS key is necessarily visible in the browser. That's expected and fine.
What stops someone else spending your quota is the referrer restriction:

- **Application restrictions** → *Websites* → add only your own origins, e.g.
  `https://yourname.github.io/*` and `http://localhost:8080/*`
- **API restrictions** → limit to *Maps JavaScript API* and *Geocoding API*

### 3. Add your key

```bash
cp js/config.example.js js/config.js
# paste your key into js/config.js
```

`js/config.js` is gitignored, so your key never reaches GitHub.

### 4. Run it

```bash
npm start          # http://127.0.0.1:8080
```

The Maps API won't run from a `file://` URL, so it must be served.

**On your phone:** the practical option is GitHub Pages — push this repo, enable
Pages on the branch, and add the resulting URL to your key's website
restrictions. Then add it to your home screen and it behaves like an app.

---

## Using it

1. **Type the eircode**, tap *Find*. The map jumps to the property at max zoom,
   top-down. (Or tap the crosshair to centre on where you're standing.)
2. **Tap each corner** of the driveway. Live m² readout from the third point on.
   - Drag a handle to nudge a corner
   - Tap a handle to delete that corner
   - *Undo* removes the last point, *Clear* starts over
3. **Save area** → pick what it is, the surface, and the service. You get the
   line price before you commit it.
4. **Repeat** for the patio, the path, whatever else. They all land in one job.
5. **Copy quote** puts a formatted quote on the clipboard, ready to paste into a
   text or email.

Keyboard shortcuts on desktop: `Backspace` undo, `Esc` clear, `Enter` save area.

### Rates

The **Rates** tab holds a €/m² grid of service × surface, plus your minimum
charge and VAT rate. **The shipped numbers are placeholders — put your real
rates in.** Edits save to that browser.

Leave a cell blank for combinations you don't offer; the app flags them rather
than quietly pricing them at zero.

To change the defaults for every device rather than one browser, edit
`DEFAULT_RATES` in `js/rates.js`.

---

## Accuracy — read this before quoting off it

The measurement is as good as your outline and the imagery. Specifically:

| Factor | Effect |
| --- | --- |
| Your tracing | Dominant source of error. A careless corner on a 20 m drive is worth several m². |
| Imagery age | Google's Irish aerial imagery can be a few years old. A new driveway may not exist on it. |
| Tree/hedge overhang | Obscures edges. You are guessing under the canopy — treat those jobs as site-visit only. |
| Georegistration | Imagery can be offset by up to a metre or so. Barely matters for area; matters more for a narrow path. |
| Slope | This measures plan area, exactly as Google Earth does. A sloped drive has slightly more real surface — under 1% for anything you'd drive a car up. |

It is reliable for quoting an open, clearly visible driveway or patio. It is not
a substitute for a tape measure where the boundary is ambiguous, and the quote
text it produces says so.

---

## Testing

```bash
npm test        # 29 checks — eircode parsing, geodesic area, pricing, rounding
npm run test:ui # 56 checks — full flow in a real browser against a mocked Maps API
```

`npm run test:ui` needs Playwright's Chromium (`npx playwright install chromium`),
or set `CHROMIUM_PATH` to an existing Chromium binary.

The flow test drives the genuine measure → save → quote path, and asserts a
20 m × 6 m rectangle reads 120 m² and prices correctly through to the VAT line.

Two things the tests pin down deliberately, because both were live bugs:

- **Printed lines must add up.** Line totals are rounded to cents at
  calculation, and the subtotal is the sum of the rounded lines — so a customer
  adding up your quote gets your total. Half-cents round up, which plain
  `toFixed(2)` gets wrong on values like €1113.435.
- **`[hidden]` must beat class rules.** The UA's `[hidden] { display: none }` is
  low specificity, so `.quote-row { display: flex }` silently overrode it and
  the VAT row showed even with VAT switched off.

---

## How it fits together

No build step, no framework. Four files:

| File | Role |
| --- | --- |
| `index.html` | Markup and layout |
| `css/style.css` | Mobile-first styling, high contrast for daylight |
| `js/geo.js` | Eircode parsing, geocoding, geodesic area/perimeter |
| `js/rates.js` | Rate card, currency rounding, quote calculation |
| `js/app.js` | Map, drawing, and UI wiring |

`js/rates.js` and `js/geo.js` are pure logic with no DOM dependency, which is
why they can be tested directly in Node.

---

## Where it could go next

**One-tap outlining.** The tapping is already fast, but a segmentation model
(SAM 2 or similar) would let you tap once *inside* the driveway and get the
polygon back — vertices land in the same `points` array, so everything
downstream is unchanged. That's the natural next step, and worth it if you're
doing many quotes a day.

**Fully automatic** detection from the eircode alone is possible, but you'd
still have to eyeball every result — imagery is ambiguous often enough that an
unchecked number isn't safe to quote from. The human-in-the-loop tap is doing
real work, not just filling in for missing automation.

**Saved job history**, a PDF quote, or pushing straight into your invoicing —
all straightforward from here; the quote object in `js/rates.js` is already the
right shape to hand off.
