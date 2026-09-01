# Area & Quote

Measure a driveway, patio, path or roof from aerial imagery by eircode, and
price it off your rate card — on your phone, in about fifteen seconds.

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

The **Rates** tab holds the €/m² grid of service × surface, plus contingency,
minimum charge and VAT. Edits save to that browser; to change the defaults for
every device edit `DEFAULT_RATES` in `js/rates.js`.

| | Everything else | Block paving, tarmac, limestone, resin, decking | Roof |
| --- | --- | --- | --- |
| Pressure washing | €3.50 | €4.00 | — |
| Instant softwash | €4.50 | €4.50 | — |
| Progressive softwash | €3.50 | €3.50 | — |
| Roof cleaning | — | — | €7.50 flat tiles / €8.50 other |

"Everything else" is concrete, sandstone, granite and porcelain. A blank cell
means "not offered" — the app flags such a line on the quote rather than
quietly pricing it at zero.

**Ground and roof surfaces only.** Facade stone (travertine and the like) is
deliberately absent: a facade is vertical, so tracing it on top-down imagery
gives the wall's horizontal run, not its area. Facade work is quoted in person.

The card is defined as **rules, not a 4 × 11 grid of literals**, at the top of
`js/rates.js`: a standard pressure-washing rate, a list of surfaces that take
the premium one, and a flat rate per softwash. Adding a surface is one line in
`GROUND_SURFACES`, and no cell can be missed.

### Roofs are not their footprint

Aerial imagery measures a roof's **footprint**. The surface you actually clean
is larger by `1 / cos(pitch)`, which at Irish roof pitches is not a rounding
error:

| Pitch | Multiplier | 100 m² footprint becomes |
| --- | --- | --- |
| **No pitch** | 1.00 | 100 m² |
| 25° | 1.10 | 110 m² |
| 30° | 1.15 | 115 m² |
| **35° (typical)** | **1.22** | **122 m²** |
| 45° | 1.41 | 141 m² |

Pricing the footprint at 35° would under-quote by 22% — on a €8.50/m² roof
that's €188 off a €1,038 job. So picking a roof surface reveals a **pitch**
control. It defaults to 35° so a pitched roof can't be under-quoted by
accident, and the first option is **No pitch — footprint only** for a flat roof
or when you'd rather price the plain measurement. At no pitch the conversion
line is dropped entirely; otherwise the quote prints both figures:

```
Roof — Roof cleaning (Profiled / slate)
  100.0 m² footprint at 35° = 122 m² roof area
  122 m² @ €8.50/m² = €1037.66
```

Pitch is a visual judgement from the ground or from Street View — the tool
can't infer it from top-down imagery. If you're doing the roof survey in person
anyway, this at least gets you a defensible number before you travel.

---

## Accuracy — read this before quoting off it

These quotes go out as firm prices without anyone visiting the property, so the
measurement has to stand on its own. What affects it:

| Factor | Effect |
| --- | --- |
| Your tracing | Dominant source of error. A careless corner on a 20 m drive is worth several m². |
| Imagery age | Google's Irish aerial imagery can be a few years old. A new driveway may not exist on it. |
| Tree/hedge overhang | Obscures edges, so you are estimating under the canopy. Flag the area — see below. |
| Georegistration | Imagery can be offset by up to a metre or so. Barely matters for area; matters more for a narrow path. |
| Slope | Measures plan area, exactly as Google Earth does. Under 1% for anything you'd drive a car up — but see *Roofs are not their footprint* above, where it is 22%. |

### Handling what you can't see clearly

Every saved area carries a confidence level: **Clear**, **Part obscured**, or
**Mostly estimated**. This exists because there is no site visit to fall back
on — an area you had to guess at under tree cover is real commercial risk, and
it belongs on the record rather than buried inside one number.

Flagging an area does two things:

- **Marks the line** in the job list, so you can see at a glance which parts of
  a quote are soft before you send it.
- **Optionally adds a contingency %**, set per level on the Rates tab. This is
  **off by default (0% everywhere)** — small measuring error is acceptable, so
  the flag is a note to yourself unless you deliberately want it to move the
  price. Put figures in if you'd rather it did.

The contingency prints as its own line rather than being folded into the rate,
so the customer sees an honest breakdown and you never have to explain an odd
€/m². Confidence resets to *Clear* for every new area — inheriting it from the
last one would quietly add money to a line you could see perfectly well.

### What the quote says

The wording adapts to what you flagged. A fully clear job reads:

> Areas measured from current aerial imagery. Price holds unless the area on the
> day differs materially from the above.

A job containing an obscured area also states that part of it was estimated and
carries a contingency. Neither version promises an on-site confirmation — that
would invite a visit that isn't coming and weaken the price you sent.

---

## Testing

```bash
npm test        # 60 checks — eircode parsing, geodesic area, rate card, pitch, pricing
npm run test:ui # 87 checks — full flow in a real browser against a mocked Maps API
```

`npm run test:ui` needs Playwright's Chromium (`npx playwright install chromium`),
or set `CHROMIUM_PATH` to an existing Chromium binary.

The flow test drives the genuine measure → save → quote path, and asserts a
20 m × 6 m rectangle reads 120 m² and prices correctly through to the VAT line.

Three things the tests pin down deliberately, because all three were live bugs:

- **Printed lines must add up.** Line totals are rounded to cents at
  calculation, and the subtotal is the sum of the rounded lines — so a customer
  adding up your quote gets your total. Half-cents round up, which plain
  `toFixed(2)` gets wrong on values like €1113.435.
- **`[hidden]` must beat class rules.** The UA's `[hidden] { display: none }` is
  low specificity, so `.quote-row { display: flex }` silently overrode it and
  the VAT row showed even with VAT switched off.
- **Confidence must not be sticky.** It inherited from the previous area, which
  silently added contingency to a line you could see perfectly well. It now
  resets to *Clear* every time the dialog opens.

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
