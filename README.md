# subway_simulator

An ambient, full-screen live map of the NYC subway. Dark minimalist map, lines in their
official MTA colors, and trains gliding along the tracks in near real time —
positions interpolated from the MTA's free GTFS-realtime feeds.

## Setup

```bash
npm install
npm run preprocess   # one-time: downloads MTA static GTFS + borough outlines, writes data/*.json
npm run dev          # server on :4000, Vite dev UI on :5173
```

Open http://localhost:5173 (dev) — or build and serve everything from the Node server:

```bash
npm run build
npm start            # http://localhost:4000
```

## How it works

```
MTA GTFS-RT feeds (protobuf, 7 feeds) ──poll 30s──> Node server ──/api/trains──> browser canvas
static GTFS (stops/shapes) ──npm run preprocess──> data/*.json ──────────────────^
```

- **`scripts/preprocess.ts`** downloads the MTA static GTFS bundle, simplifies each route
  shape (Douglas-Peucker), projects every station onto its shapes (distance-along-line in
  meters), and writes compact JSON to `data/`. Borough outlines come from NYC DCP's ArcGIS
  service. Staten Island Railway is excluded.
- **`server/`** polls the 7 realtime feeds every 30s (no API key needed — but the `/` in
  `nyct%2Fgtfs` must stay percent-encoded or the API returns 403), decodes the protobufs,
  and reduces each active trip to a motion segment:
  `{prevStop, nextStop, depTime, arrTime, shapeId, status}`. The NYCT trip-id suffix
  (e.g. `A..S55R`) usually matches a `shape_id` directly; otherwise the best
  same-direction shape containing both stops is used. Scheduled trips that haven't
  entered service are filtered out.
- **`web/`** renders boroughs + lines + stations once to an offscreen canvas, then each
  animation frame computes every train's distance along its shape from the segment
  timestamps (`lerp` between the two stops' precomputed distances), converts to a point
  on the polyline, and draws a glowing dot. New polls just refine the targets; an
  exponential smoothing on screen position hides corrections, so motion stays continuous
  at 60fps without rubber-banding.

## Scripts

| command              | what it does                                  |
| -------------------- | --------------------------------------------- |
| `npm run preprocess` | regenerate `data/*.json` from MTA static GTFS |
| `npm run dev`        | server (tsx watch) + Vite dev server          |
| `npm run build`      | production frontend build to `web/dist/`      |
| `npm start`          | serve API + built frontend on :4000           |
| `npm run typecheck`  | TypeScript check across the whole repo        |

## Notes

- Feeds update ~every 30s; the subway feeds publish arrival predictions, not GPS, so
  positions are interpolated and approximate (especially in express/local overlaps).
- Re-run `npm run preprocess` occasionally — the MTA updates the static GTFS a few times
  a year. Delete `.cache/` to force fresh downloads.
