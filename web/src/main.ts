import type { RouteInfo, StationInfo, ShapeInfo, TrainState } from "../../shared/types";
import { FeedClient } from "./feeds";
import { pointAtDist, type LonLat } from "../../shared/geo";
import {
  MapView,
  THEMES,
  TileLayer,
  laneSpacingPx,
  offsetPolylinePx,
  prepareShapes,
  renderStatic,
  routeLane,
  type PreparedShape,
} from "./map";

// default framing: lower Manhattan + Brooklyn/Queens core
const DEFAULT_VIEW = { lon: -73.94, lat: 40.715, z: 3.6 };

const POLL_MS = 30_000; // MTA publishes ~every 30s; we fetch the feeds directly
const SMOOTHING = 2.5; // 1/s; position easing for shapeless fallback trains
const TRAIL_MAX_AGE_MS = 45_000;
const TRAIL_SAMPLE_MS = 1_000;

// velocity model: v chases (segment speed + error feedback), so prediction
// jumps become gentle sustained speed changes instead of catch-up sprints
const CATCHUP_GAIN = 0.06; // (m/s) per meter of error; error half-life ~12s
const SPEED_SMOOTH_S = 3; // seconds to blend toward the target speed
const MAX_SPEED = 45; // m/s, sanity cap (~100 mph)
const MIN_SPEED = -6; // small reverse allowed to fix overshoots quietly
const SNAP_ERROR_M = 1_500; // beyond this, jump instead of animating

const canvas = document.getElementById("map") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const statusEl = document.getElementById("status")!;

interface LiveTrain {
  state: TrainState;
  /** shape the smoothed dist refers to; reset history when it changes */
  shapeKey: string | null;
  /** smoothed distance along shape (meters), when on a shape */
  dist: number | null;
  /** current display speed along the track (m/s) */
  v: number;
  /** recent (time, dist) samples; trail = track slice back to the oldest */
  distHist: { t: number; dist: number }[];
  lastSample: number;
  /** smoothed lon/lat, only for shapeless fallback trains */
  lon: number | null;
  lat: number | null;
}

async function loadJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** index of first element in sorted `arr` greater than `v` */
function upperBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main() {
  // relative paths so the site works at any base (e.g. GitHub Pages subpath)
  const [routes, stations, shapesArr] = await Promise.all([
    loadJSON<Record<string, RouteInfo>>("data/routes.json"),
    loadJSON<Record<string, StationInfo>>("data/stations.json"),
    loadJSON<ShapeInfo[]>("data/shapes.json"),
  ]);

  const shapes = prepareShapes(shapesArr);
  const view = new MapView(shapesArr.flatMap((s) => s.points));
  const feedClient = new FeedClient(routes, shapes.values());

  let staticLayer: HTMLCanvasElement;
  let staticDirty = true;

  // theme: ?theme= param > saved preference > dusk
  let theme = THEMES.dusk;
  let tiles!: TileLayer;
  function applyTheme(id: string) {
    theme = THEMES[id] ?? THEMES.dusk;
    tiles = new TileLayer(theme, () => {
      staticDirty = true;
    });
    document.body.classList.toggle("theme-dark", theme.darkUI);
    document.body.classList.toggle("theme-light", !theme.darkUI);
    document.body.style.background = theme.bg;
    document.getElementById("attribution")!.textContent = theme.attribution;
    document.querySelectorAll<HTMLButtonElement>("#themectl button").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === theme.id);
    });
    localStorage.setItem("theme", theme.id);
    staticDirty = true;
  }
  applyTheme(
    new URLSearchParams(location.search).get("theme") ??
      localStorage.getItem("theme") ??
      "dusk"
  );
  document.querySelectorAll<HTMLButtonElement>("#themectl button").forEach((b) => {
    b.addEventListener("click", () => applyTheme(b.dataset.theme!));
  });

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    view.fit(window.innerWidth, window.innerHeight, dpr);
    staticDirty = true;
  }

  // --- interactions: wheel zoom, drag pan, double-click reset ---
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // trackpad pinch arrives as ctrl+wheel with small deltas
      const k = e.ctrlKey ? 0.014 : 0.0035;
      view.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k));
      staticDirty = true;
    },
    { passive: false }
  );
  const zoomStep = (factor: number) => {
    view.zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor);
    staticDirty = true;
  };
  document.getElementById("zoom-in")!.addEventListener("click", () => zoomStep(1.6));
  document.getElementById("zoom-out")!.addEventListener("click", () => zoomStep(1 / 1.6));
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    view.panBy(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    staticDirty = true;
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = "grab";
  });
  canvas.addEventListener("dblclick", () => {
    view.setView(DEFAULT_VIEW.lon, DEFAULT_VIEW.lat, DEFAULT_VIEW.z);
    staticDirty = true;
  });

  const trains = new Map<string, LiveTrain>();
  let lastUpdate = 0;

  async function poll() {
    try {
      const res = await feedClient.fetchAll();
      if (res.trains.length === 0) return; // all feeds failed; keep last data
      const seen = new Set<string>();
      for (const state of res.trains) {
        seen.add(state.id);
        const existing = trains.get(state.id);
        if (existing) existing.state = state;
        else {
          trains.set(state.id, {
            state,
            shapeKey: null,
            dist: null,
            v: 0,
            distHist: [],
            lastSample: 0,
            lon: null,
            lat: null,
          });
        }
      }
      for (const id of trains.keys()) {
        if (!seen.has(id)) trains.delete(id);
      }
      lastUpdate = res.timestamp * 1000;
    } catch (err) {
      console.warn("poll failed", err);
    }
  }

  interface Target {
    pos: LonLat;
    shape: PreparedShape | null;
    dist: number;
  }

  /** Where the train should be right now. */
  function computeTarget(t: TrainState): Target | null {
    const shape = t.shapeId ? (shapes.get(t.shapeId) as PreparedShape) : null;
    const now = Date.now() / 1000;

    if (shape) {
      const d0 = shape.stopDist[t.prevStop];
      const d1 = shape.stopDist[t.nextStop];
      if (d0 != null && d1 != null) {
        let dist = d0;
        if (t.status === "MOVING" && t.arrTime > t.depTime) {
          const f = Math.max(0, Math.min(1, (now - t.depTime) / (t.arrTime - t.depTime)));
          dist = d0 + (d1 - d0) * f;
        }
        return { pos: pointAtDist(shape.points, shape.cum, dist), shape, dist };
      }
    }
    // fallback: straight line between station coordinates
    const a = stations[t.prevStop];
    const b = stations[t.nextStop];
    if (!a) return null;
    if (t.status !== "MOVING" || !b || t.arrTime <= t.depTime) {
      return { pos: [a.lon, a.lat], shape: null, dist: 0 };
    }
    const f = Math.max(0, Math.min(1, (now - t.depTime) / (t.arrTime - t.depTime)));
    return {
      pos: [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f],
      shape: null,
      dist: 0,
    };
  }

  /** Screen-space unit normal of the track at `dist` along a shape. */
  function trackNormal(shape: PreparedShape, dist: number): [number, number] | undefined {
    const a = pointAtDist(shape.points, shape.cum, Math.max(0, dist - 25));
    const b = pointAtDist(shape.points, shape.cum, dist + 25);
    const [ax, ay] = view.project(a[0], a[1]);
    const [bx, by] = view.project(b[0], b[1]);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) return undefined;
    return [-(by - ay) / len, (bx - ax) / len];
  }

  let prevFrame = performance.now();
  function frame(nowMs: number) {
    const dt = Math.min(0.1, (nowMs - prevFrame) / 1000);
    prevFrame = nowMs;
    const wallNow = Date.now();

    if (staticDirty) {
      staticLayer = renderStatic(view, theme, tiles, shapes.values(), stations, routes);
      staticDirty = false;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    const blend = 1 - Math.exp(-SMOOTHING * dt);
    const dotR = 2.6 * Math.pow(view.zoom, 0.25);
    const spacing = laneSpacingPx(view.zoom);
    ctx.lineCap = "round";

    for (const t of trains.values()) {
      const target = computeTarget(t.state);
      if (!target) continue;
      const color = routes[t.state.routeId]?.color ?? "#ffffff";
      const laneOff = routeLane(t.state.routeId) * spacing;

      let head: [number, number];
      let trailPts: [number, number][] | null = null;

      if (target.shape) {
        const sh = target.shape;
        // predicted speed for the current segment (0 while dwelling)
        const st = t.state;
        const segSpeed =
          st.status === "MOVING" && st.arrTime > st.depTime
            ? Math.min(
                MAX_SPEED,
                Math.max(0, (sh.stopDist[st.nextStop] - sh.stopDist[st.prevStop]) / (st.arrTime - st.depTime))
              )
            : 0;

        // velocity model in distance-along-track space: the dot can never
        // leave the rails, and corrections arrive as smooth speed changes
        const err = t.dist == null ? Infinity : target.dist - t.dist;
        if (t.shapeKey !== sh.id || t.dist == null || Math.abs(err) > SNAP_ERROR_M) {
          t.shapeKey = sh.id;
          t.dist = target.dist;
          t.v = segSpeed;
          t.distHist = [];
          t.lastSample = 0;
        } else {
          const vTarget = Math.max(MIN_SPEED, Math.min(MAX_SPEED, segSpeed + err * CATCHUP_GAIN));
          t.v += (vTarget - t.v) * (1 - Math.exp(-dt / SPEED_SMOOTH_S));
          t.dist += t.v * dt;
        }
        if (wallNow - t.lastSample >= TRAIL_SAMPLE_MS) {
          t.distHist.push({ t: wallNow, dist: t.dist });
          t.lastSample = wallNow;
        }
        while (t.distHist.length && wallNow - t.distHist[0].t > TRAIL_MAX_AGE_MS) {
          t.distHist.shift();
        }

        const normal = trackNormal(sh, t.dist);
        const headPos = pointAtDist(sh.points, sh.cum, t.dist);
        const tailDist = t.distHist.length
          ? Math.min(t.distHist[0].dist, t.dist)
          : t.dist;

        if (t.dist - tailDist > 1) {
          // trail = the actual track between tailDist and the head
          const raw: LonLat[] = [pointAtDist(sh.points, sh.cum, tailDist)];
          const i0 = upperBound(sh.cum, tailDist);
          const i1 = upperBound(sh.cum, t.dist); // vertices with cum < t.dist end at i1-1
          for (let i = i0; i < i1; i++) raw.push(sh.points[i]);
          raw.push(headPos);
          trailPts = offsetPolylinePx(
            raw.map(([lon, lat]) => view.project(lon, lat)),
            laneOff,
            normal
          );
          head = trailPts[trailPts.length - 1];
        } else {
          const [hx, hy] = view.project(headPos[0], headPos[1]);
          const [nx, ny] = normal ?? [0, 0];
          head = [hx + nx * laneOff, hy + ny * laneOff];
        }
      } else {
        // shapeless fallback: smooth lon/lat, no trail, no lane offset
        if (t.lon == null || t.lat == null) {
          t.lon = target.pos[0];
          t.lat = target.pos[1];
        } else {
          t.lon += (target.pos[0] - t.lon) * blend;
          t.lat += (target.pos[1] - t.lat) * blend;
        }
        t.shapeKey = null;
        head = view.project(t.lon, t.lat);
      }

      if (trailPts && trailPts.length >= 2) {
        const [tx, ty] = trailPts[0];
        if (Math.hypot(head[0] - tx, head[1] - ty) > 2) {
          const grad = ctx.createLinearGradient(tx, ty, head[0], head[1]);
          grad.addColorStop(0, "rgba(0,0,0,0)");
          grad.addColorStop(1, color);
          ctx.strokeStyle = grad;
          ctx.lineWidth = dotR;
          ctx.beginPath();
          trailPts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          ctx.stroke();
        }
      }

      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(head[0], head[1], dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = Math.max(0.8, dotR * 0.3);
      ctx.stroke();
    }

    const age = lastUpdate ? Math.round((wallNow - lastUpdate) / 1000) : null;
    statusEl.textContent =
      age == null ? "connecting…" : `${trains.size} trains · updated ${age}s ago`;

    requestAnimationFrame(frame);
  }

  layout();
  // URL overrides the Manhattan default, e.g. /?lon=-73.99&lat=40.72&z=8
  const params = new URLSearchParams(location.search);
  const pz = Number(params.get("z"));
  view.setView(
    Number(params.get("lon")) || DEFAULT_VIEW.lon,
    Number(params.get("lat")) || DEFAULT_VIEW.lat,
    pz > 1 ? pz : DEFAULT_VIEW.z
  );
  staticDirty = true;
  window.addEventListener("resize", layout);
  await poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
}

main().catch((err) => {
  statusEl.textContent = `failed to load: ${err.message ?? err}`;
  console.error(err);
});
