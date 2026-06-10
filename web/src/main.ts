import type {
  RouteInfo,
  StationInfo,
  ShapeInfo,
  TrainState,
  TrainsResponse,
} from "../../shared/types";
import { pointAtDist, type LonLat } from "../../shared/geo";
import { MapView, prepareShapes, renderStatic, type PreparedShape } from "./map";

const POLL_MS = 15_000;
const SMOOTHING = 2.5; // 1/s; higher = snappier corrections

const canvas = document.getElementById("map") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const statusEl = document.getElementById("status")!;

interface LiveTrain {
  state: TrainState;
  /** smoothed display position (css px); null until first placement */
  x: number | null;
  y: number | null;
}

async function loadJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function main() {
  const [routes, stations, shapesArr, boroughs] = await Promise.all([
    loadJSON<Record<string, RouteInfo>>("/data/routes.json"),
    loadJSON<Record<string, StationInfo>>("/data/stations.json"),
    loadJSON<ShapeInfo[]>("/data/shapes.json"),
    loadJSON<GeoJSON.FeatureCollection>("/data/boroughs.json"),
  ]);

  const shapes = prepareShapes(shapesArr);
  const allPoints: LonLat[] = shapesArr.flatMap((s) => s.points);
  const view = new MapView(allPoints);

  let staticLayer: HTMLCanvasElement;
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    view.fit(w, h, dpr);
    staticLayer = renderStatic(view, boroughs, shapes.values(), stations, routes);
    // a resize invalidates smoothed pixel positions
    for (const t of trains.values()) {
      t.x = t.y = null;
    }
  }

  const trains = new Map<string, LiveTrain>();
  let lastUpdate = 0;

  async function poll() {
    try {
      const res = await loadJSON<TrainsResponse>("/api/trains");
      const seen = new Set<string>();
      for (const state of res.trains) {
        seen.add(state.id);
        const existing = trains.get(state.id);
        if (existing) existing.state = state;
        else trains.set(state.id, { state, x: null, y: null });
      }
      for (const id of trains.keys()) {
        if (!seen.has(id)) trains.delete(id);
      }
      lastUpdate = res.timestamp * 1000;
    } catch (err) {
      console.warn("poll failed", err);
    }
  }

  /** Where the train should be right now, in lon/lat. */
  function targetLonLat(t: TrainState): LonLat | null {
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
        return pointAtDist(shape.points, shape.cum, dist);
      }
    }
    // fallback: straight line between station coordinates
    const a = stations[t.prevStop];
    const b = stations[t.nextStop];
    if (!a) return null;
    if (t.status !== "MOVING" || !b || t.arrTime <= t.depTime) return [a.lon, a.lat];
    const f = Math.max(0, Math.min(1, (now - t.depTime) / (t.arrTime - t.depTime)));
    return [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f];
  }

  let prevFrame = performance.now();
  function frame(nowMs: number) {
    const dt = Math.min(0.1, (nowMs - prevFrame) / 1000);
    prevFrame = nowMs;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    const blend = 1 - Math.exp(-SMOOTHING * dt);
    for (const t of trains.values()) {
      const target = targetLonLat(t.state);
      if (!target) continue;
      const [tx, ty] = view.project(target[0], target[1]);
      if (t.x == null || t.y == null) {
        t.x = tx;
        t.y = ty;
      } else {
        t.x += (tx - t.x) * blend;
        t.y += (ty - t.y) * blend;
      }
      const color = routes[t.state.routeId]?.color ?? "#ffffff";
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    const age = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null;
    statusEl.textContent =
      age == null ? "connecting…" : `${trains.size} trains · updated ${age}s ago`;

    requestAnimationFrame(frame);
  }

  layout();
  window.addEventListener("resize", layout);
  await poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
}

main().catch((err) => {
  statusEl.textContent = `failed to load: ${err.message ?? err}`;
  console.error(err);
});
