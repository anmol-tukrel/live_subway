# subway_simulator

An ambient, full-screen live map of the NYC subway. Dark minimalist map, lines in their
official MTA colors, and trains gliding along the tracks in near real time —
positions interpolated from the MTA's free GTFS-realtime feeds.

**Fully static**: the browser fetches the MTA feeds directly (they're keyless and send
CORS headers), so there is no backend — it deploys to any static host.

## Setup

```bash
npm install
npm run preprocess   # one-time: downloads MTA static GTFS, writes web/public/data/*.json
npm run dev          # Vite dev server on :5173
```

Production build / local preview:

```bash
npm run build        # outputs web/dist/
npm run preview
```

## Deployment

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`
(enable Pages with source "GitHub Actions" in the repo settings once). The workflow
also rebuilds monthly to pick up MTA static GTFS changes. Any other static host works
too — just serve `web/dist/`.

## How it works

```
MTA GTFS-RT feeds (protobuf, 7 feeds) ──fetch every 30s──> browser: decode + interpolate + render
static GTFS (stops/shapes) ──npm run preprocess──> web/public/data/*.json ──────────^
```

- **`scripts/preprocess.ts`** downloads the MTA static GTFS bundle, simplifies each route
  shape (Douglas-Peucker), projects every station onto its shapes (distance-along-line in
  meters), and writes compact JSON. Staten Island Railway is excluded.
- **`web/src/feeds.ts`** fetches the 7 realtime feeds (no API key needed — but the `/` in
  `nyct%2Fgtfs` must stay percent-encoded or the API returns 403), decodes the protobufs,
  and reduces each active trip to a motion segment:
  `{prevStop, nextStop, depTime, arrTime, shapeId, status}`. The NYCT trip-id suffix
  (e.g. `A..S55R`) usually matches a `shape_id` directly; otherwise the best
  same-direction shape containing both stops is used. Scheduled trips that haven't
  entered service are filtered out.
- **`web/src/main.ts` + `map.ts`** render a Web Mercator canvas: raster basemap tiles
  (three themes — dusk/dark/light — with multi-zoom-level fallback and caching), lane-offset
  route lines (color families that share track get parallel strands, split by direction),
  and the live trains. Each train's *distance along its track* is animated with a
  velocity model (speed chases segment-speed + error feedback), so motion is smooth and
  on-rails even across prediction corrections, with geometry-accurate comet trails.

## Scripts

| command              | what it does                                          |
| -------------------- | ----------------------------------------------------- |
| `npm run preprocess` | regenerate `web/public/data/*.json` from static GTFS  |
| `npm run dev`        | Vite dev server                                       |
| `npm run build`      | production build to `web/dist/`                       |
| `npm run preview`    | serve the production build locally                    |
| `npm run typecheck`  | TypeScript check across the whole repo                |

## Notes

- Feeds update ~every 30s; the subway feeds publish arrival predictions, not GPS, so
  positions are interpolated and approximate.
- View options: `?lon=&lat=&z=` for framing, `?theme=dusk|dark|light` (also a UI toggle,
  persisted in localStorage). Scroll/pinch to zoom, drag to pan, double-click to reset.
- Re-run `npm run preprocess` occasionally (CI does this monthly). Delete `.cache/` to
  force fresh downloads.
