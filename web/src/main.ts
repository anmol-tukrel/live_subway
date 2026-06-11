import type { RouteInfo, StationInfo, ShapeInfo, TrainState } from "../../shared/types";
import { FeedClient } from "./feeds";
import { pointAtDist, type LonLat } from "../../shared/geo";
import {
  MapView,
  THEMES,
  TileLayer,
  laneSpacingPx,
  lonLatToWorld,
  offsetPolylinePx,
  prepareShapes,
  renderStatic,
  routeLane,
  type PreparedShape,
} from "./map";

// default framing: lower Manhattan centered, Hudson River on the left.
// portrait screens get a wider framing tuned for a phone's aspect ratio.
const DESKTOP_VIEW = { lon: -74.008, lat: 40.7155, z: 11.5 };
const PORTRAIT_VIEW = { lon: -74.0, lat: 40.72, z: 6 };
const defaultView = () =>
  window.innerWidth < window.innerHeight ? PORTRAIT_VIEW : DESKTOP_VIEW;

const POLL_MS = 30_000; // MTA publishes ~every 30s; we fetch the feeds directly
const SMOOTHING = 2.5; // 1/s; position easing for shapeless fallback trains
const TRAIL_MAX_AGE_MS = 75_000;
const TRAIL_SAMPLE_MS = 1_000;

// intro flyby: zoom to a fast-moving train, ride along, pull back out
const INTRO_DELAY_MS = 1_500;
const INTRO_FLY_MS = 3_000;
const INTRO_FOLLOW_MS = 6_000;
const INTRO_FOLLOW_ZOOM = 52;

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

// --- train marker: the official MTA route bullet — a colored disc with the
// line's letter/number (diamond for the <6X>/<7X> express variants) ---
const SPRITE_S = 96;
const spriteCache = new Map<string, HTMLCanvasElement>();
// the yellow Broadway lines use black text on their bullets
const BLACK_TEXT = new Set(["N", "Q", "R", "W"]);
function routeLabel(routeId: string): string {
  if (routeId === "GS" || routeId === "FS" || routeId === "H") return "S"; // shuttles
  return routeId.replace(/X$/, "");
}
function trainSprite(routeId: string, color: string): HTMLCanvasElement {
  let c = spriteCache.get(routeId);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = SPRITE_S;
  c.height = SPRITE_S;
  const g = c.getContext("2d")!;
  const cx = SPRITE_S / 2;
  const cy = SPRITE_S / 2;
  g.beginPath();
  if (routeId.endsWith("X")) {
    // express services ride in a diamond
    g.moveTo(cx, cy - 45);
    g.lineTo(cx + 45, cy);
    g.lineTo(cx, cy + 45);
    g.lineTo(cx - 45, cy);
    g.closePath();
  } else {
    g.arc(cx, cy, 41, 0, Math.PI * 2);
  }
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = "rgba(255,255,255,0.92)";
  g.stroke();
  const label = routeLabel(routeId);
  g.fillStyle = BLACK_TEXT.has(label) ? "#0a0a0a" : "#ffffff";
  g.font = "bold 52px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, cx, cy + 4);
  spriteCache.set(routeId, c);
  return c;
}

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
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.bg);
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
    // clientWidth/Height follow the CSS dvh sizing (mobile URL bar show/hide)
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    view.fit(w, h, dpr);
    staticDirty = true;
  }

  // --- interactions: wheel zoom, drag pan, double-click reset ---
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      cancelIntro();
      // trackpad pinch arrives as ctrl+wheel with small deltas
      const k = e.ctrlKey ? 0.014 : 0.0035;
      view.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k));
      staticDirty = true;
    },
    { passive: false }
  );
  // intro flyby camera state; any user interaction cancels it
  let intro: {
    phase: "flyIn" | "follow" | "flyOut";
    t0: number;
    trainId: string;
    from: { cx: number; cy: number; z: number };
  } | null = null;
  let introPending = false;
  const cancelIntro = () => {
    intro = null;
    introPending = false;
  };

  const zoomStep = (factor: number) => {
    cancelIntro();
    view.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
    staticDirty = true;
  };
  document.getElementById("zoom-in")!.addEventListener("click", () => zoomStep(1.6));
  document.getElementById("zoom-out")!.addEventListener("click", () => zoomStep(1 / 1.6));

  const resetView = () => {
    cancelIntro();
    const dv = defaultView();
    view.setView(dv.lon, dv.lat, dv.z);
    staticDirty = true;
  };
  canvas.addEventListener("dblclick", resetView);

  // pointer gestures: one finger/mouse pans, two fingers pinch-zoom,
  // a quick double-tap resets (touch equivalent of double-click)
  const pointers = new Map<number, { x: number; y: number }>();
  let gestureMoved = false;
  let gesturePinched = false;
  let lastTap = { t: 0, x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (e) => {
    cancelIntro();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 1) gestureMoved = false;
    else gesturePinched = true;
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 0) {
      if (pointers.size === 1) {
        view.panBy(e.clientX - p.x, e.clientY - p.y);
        staticDirty = true;
      } else {
        // pinch: pan with the midpoint, zoom with the finger spread
        const o = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
        if (o) {
          const oldDist = Math.hypot(p.x - o.x, p.y - o.y);
          const newMidX = (e.clientX + o.x) / 2;
          const newMidY = (e.clientY + o.y) / 2;
          view.panBy(newMidX - (p.x + o.x) / 2, newMidY - (p.y + o.y) / 2);
          const newDist = Math.hypot(e.clientX - o.x, e.clientY - o.y);
          if (oldDist > 1) view.zoomAt(newMidX, newMidY, newDist / oldDist);
          staticDirty = true;
        }
      }
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 1.5) gestureMoved = true;
      p.x = e.clientX;
      p.y = e.clientY;
    }
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture(e.pointerId);
    if (pointers.size === 0) {
      canvas.style.cursor = "grab";
      // double-tap reset for touch (dblclick doesn't fire there)
      if (e.type === "pointerup" && e.pointerType === "touch" && !gestureMoved && !gesturePinched) {
        const now = performance.now();
        if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
          resetView();
          lastTap.t = 0;
        } else {
          lastTap = { t: now, x: e.clientX, y: e.clientY };
        }
      }
      gesturePinched = false;
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // touch devices get touch wording in the HUD
  if (matchMedia("(pointer: coarse)").matches) {
    document.getElementById("hint")!.textContent =
      "pinch to zoom · drag to pan · double-tap to reset";
  }

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

  /** Current world position of a live train (from its smoothed track distance). */
  function trainWorld(id: string): [number, number] | null {
    const t = trains.get(id);
    if (!t?.shapeKey || t.dist == null) return null;
    const sh = shapes.get(t.shapeKey);
    if (!sh) return null;
    const [lon, lat] = pointAtDist(sh.points, sh.cum, t.dist);
    return lonLatToWorld(lon, lat);
  }

  // the City Hall pocket (WTC / Fulton / Park Row) where all the lines cross
  const INTRO_BOX = { minLon: -74.016, maxLon: -73.998, minLat: 40.704, maxLat: 40.716 };

  /** Fastest moving train in the intro box (fallback: nearest-ish fast train). */
  function pickIntroTrain(): string | null {
    const now = Date.now() / 1000;
    const dv = defaultView();
    let bestInBox: string | null = null;
    let bestInBoxSpeed = -Infinity;
    let fallback: string | null = null;
    let fallbackScore = -Infinity;
    for (const [id, t] of trains) {
      const st = t.state;
      if (st.status !== "MOVING" || !st.shapeId) continue;
      const sh = shapes.get(st.shapeId) as PreparedShape | undefined;
      if (!sh) continue;
      const d0 = sh.stopDist[st.prevStop];
      const d1 = sh.stopDist[st.nextStop];
      if (d0 == null || d1 == null || st.arrTime <= st.depTime) continue;
      if (st.arrTime - now < 12) continue; // would park mid-shot
      const speed = (d1 - d0) / (st.arrTime - st.depTime);
      if (speed < 6 || speed > MAX_SPEED) continue;
      const f = Math.max(0, Math.min(1, (now - st.depTime) / (st.arrTime - st.depTime)));
      const [lon, lat] = pointAtDist(sh.points, sh.cum, d0 + (d1 - d0) * f);
      if (
        lon >= INTRO_BOX.minLon &&
        lon <= INTRO_BOX.maxLon &&
        lat >= INTRO_BOX.minLat &&
        lat <= INTRO_BOX.maxLat
      ) {
        if (speed > bestInBoxSpeed) {
          bestInBoxSpeed = speed;
          bestInBox = id;
        }
      } else {
        const km = Math.hypot(
          (lon - dv.lon) * 111.32 * Math.cos((dv.lat * Math.PI) / 180),
          (lat - dv.lat) * 110.57
        );
        const score = speed - km * 1.5;
        if (score > fallbackScore) {
          fallbackScore = score;
          fallback = id;
        }
      }
    }
    return bestInBox ?? fallback;
  }

  const easeInOut = (f: number) =>
    f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;

  /** Advance the intro flyby camera; returns true while it drives the view. */
  function updateIntro(nowMs: number): boolean {
    if (!intro) return false;
    if (intro.phase === "follow") {
      const w = trainWorld(intro.trainId);
      if (!w || nowMs - intro.t0 >= INTRO_FOLLOW_MS) {
        const [cx, cy] = view.worldCenter;
        intro = { phase: "flyOut", t0: nowMs, trainId: intro.trainId, from: { cx, cy, z: view.zoom } };
      } else {
        view.setWorldView(w[0], w[1], INTRO_FOLLOW_ZOOM);
        return true;
      }
    }
    const f = Math.min(1, (nowMs - intro.t0) / INTRO_FLY_MS);
    let toW: [number, number] | null;
    let toZ: number;
    if (intro.phase === "flyIn") {
      toW = trainWorld(intro.trainId); // chase the live position
      toZ = INTRO_FOLLOW_ZOOM;
    } else {
      const dv = defaultView();
      toW = lonLatToWorld(dv.lon, dv.lat);
      toZ = dv.z;
    }
    if (!toW) {
      intro = null;
      return false;
    }
    const e = easeInOut(f);
    view.setWorldView(
      intro.from.cx + (toW[0] - intro.from.cx) * e,
      intro.from.cy + (toW[1] - intro.from.cy) * e,
      intro.from.z * Math.pow(toZ / intro.from.z, e)
    );
    if (f >= 1) {
      intro =
        intro.phase === "flyIn"
          ? { phase: "follow", t0: nowMs, trainId: intro.trainId, from: intro.from }
          : null;
    }
    return true;
  }

  /** Screen-space unit normal of the track at `dist` along a shape. */
  function trackNormal(shape: PreparedShape, dist: number): [number, number] | undefined {
    const a = pointAtDist(shape.points, shape.cum, Math.max(0, dist - 25));
    const b = pointAtDist(shape.points, shape.cum, dist + 25);
    const [ax, ay] = view.project(a[0], a[1]);
    const [bx, by] = view.project(b[0], b[1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return undefined;
    return [-dy / len, dx / len];
  }

  let prevFrame = performance.now();
  function frame(nowMs: number) {
    const dt = Math.min(0.1, (nowMs - prevFrame) / 1000);
    prevFrame = nowMs;
    const wallNow = Date.now();

    if (updateIntro(nowMs)) staticDirty = true;

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
        if (color.length === 7) grad.addColorStop(0.45, color + "66");
        grad.addColorStop(1, color);
        ctx.strokeStyle = grad;
        ctx.lineWidth = dotR * 1.25;
          ctx.beginPath();
          trailPts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          ctx.stroke();
        }
      }

      // MTA route bullet, always upright (the trail shows direction)
      const S = dotR * 4;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.drawImage(
        trainSprite(t.state.routeId, color),
        head[0] - S / 2,
        head[1] - S / 2,
        S,
        S
      );
      ctx.shadowBlur = 0;
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
  const dv = defaultView();
  view.setView(
    Number(params.get("lon")) || dv.lon,
    Number(params.get("lat")) || dv.lat,
    pz > 0.5 ? pz : dv.z
  );
  staticDirty = true;
  window.addEventListener("resize", layout);
  window.visualViewport?.addEventListener("resize", layout);
  await poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);

  // intro flyby on plain loads (no explicit view in the URL, ?intro=0 opts out)
  if (!params.get("lon") && !params.get("lat") && !params.get("z") && params.get("intro") !== "0") {
    introPending = true;
    setTimeout(() => {
      if (!introPending) return;
      introPending = false;
      const id = pickIntroTrain();
      if (!id) return;
      const [cx, cy] = view.worldCenter;
      intro = { phase: "flyIn", t0: performance.now(), trainId: id, from: { cx, cy, z: view.zoom } };
    }, INTRO_DELAY_MS);
  }
}

main().catch((err) => {
  statusEl.textContent = `failed to load: ${err.message ?? err}`;
  console.error(err);
});
