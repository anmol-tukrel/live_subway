/** Web Mercator projection + raster basemap tiles + static layer rendering. */
import type { RouteInfo, ShapeInfo, StationInfo } from "../../shared/types";
import { cumulativeDist, type LonLat } from "../../shared/geo";

const D2R = Math.PI / 180;

function lonToWorldX(lon: number): number {
  return (lon + 180) / 360;
}
function latToWorldY(lat: number): number {
  const s = Math.sin(lat * D2R);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export interface PreparedShape extends ShapeInfo {
  cum: number[];
}

export interface Theme {
  id: string;
  tileUrl: (z: number, x: number, y: number) => string;
  tileMaxZoom: number;
  /** canvas background + wash drawn over tiles to push the basemap back */
  bg: string;
  wash: string;
  /** route line color treatment: mix toward black (dark themes) or white */
  lineMixTarget: "black" | "white";
  lineMixF: number;
  stationColor: (zoom: number) => string;
  attribution: string;
  darkUI: boolean;
}

const cartoSub = (x: number, y: number) => "abcd"[(x + y) % 4];

export const THEMES: Record<string, Theme> = {
  dark: {
    id: "dark",
    tileUrl: (z, x, y) =>
      `https://${cartoSub(x, y)}.basemaps.cartocdn.com/dark_nolabels/${z}/${x}/${y}@2x.png`,
    tileMaxZoom: 19,
    bg: "#05070a",
    wash: "rgba(5, 7, 10, 0.45)",
    lineMixTarget: "black",
    lineMixF: 0.5,
    stationColor: (z) => (z > 6 ? "#566273" : "#39424e"),
    attribution: "© OpenStreetMap © CARTO",
    darkUI: true,
  },
  dusk: {
    id: "dusk",
    tileUrl: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
    tileMaxZoom: 16,
    bg: "#1f2123",
    wash: "rgba(10, 12, 15, 0.3)",
    lineMixTarget: "black",
    lineMixF: 0.35,
    stationColor: (z) => (z > 6 ? "#76828f" : "#525c66"),
    attribution: "© Esri © OpenStreetMap contributors",
    darkUI: true,
  },
  light: {
    id: "light",
    tileUrl: (z, x, y) =>
      `https://${cartoSub(x, y)}.basemaps.cartocdn.com/light_nolabels/${z}/${x}/${y}@2x.png`,
    tileMaxZoom: 19,
    bg: "#eceef0",
    wash: "rgba(248, 249, 250, 0.35)",
    lineMixTarget: "white",
    lineMixF: 0.45,
    stationColor: (z) => (z > 6 ? "#7d8794" : "#a4adb6"),
    attribution: "© OpenStreetMap © CARTO",
    darkUI: false,
  },
};

export class MapView {
  width = 0;
  height = 0;
  dpr = 1;
  zoom = 1;
  private baseScale = 1;
  private cx = 0; // viewport center in world coords ([0,1] mercator)
  private cy = 0;
  private bounds: { minX: number; minY: number; maxX: number; maxY: number };

  constructor(bboxPoints: LonLat[]) {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const [lon, lat] of bboxPoints) {
      const x = lonToWorldX(lon);
      const y = latToWorldY(lat);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.bounds = { minX, minY, maxX, maxY };
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
  }

  /** pixels per world unit */
  get scalePx(): number {
    return this.baseScale * this.zoom;
  }

  fit(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    const { minX, maxX, minY, maxY } = this.bounds;
    const pad = 1.1;
    this.baseScale = Math.min(width / ((maxX - minX) * pad), height / ((maxY - minY) * pad));
  }

  project(lon: number, lat: number): [number, number] {
    return this.worldToScreen(lonToWorldX(lon), latToWorldY(lat));
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [
      this.width / 2 + (wx - this.cx) * this.scalePx,
      this.height / 2 + (wy - this.cy) * this.scalePx,
    ];
  }

  screenToWorld(px: number, py: number): [number, number] {
    return [
      this.cx + (px - this.width / 2) / this.scalePx,
      this.cy + (py - this.height / 2) / this.scalePx,
    ];
  }

  /** Zoom by `factor`, keeping the map point under (px, py) fixed. */
  zoomAt(px: number, py: number, factor: number): void {
    const [wx, wy] = this.screenToWorld(px, py);
    this.zoom = Math.max(1, Math.min(64, this.zoom * factor));
    this.cx = wx - (px - this.width / 2) / this.scalePx;
    this.cy = wy - (py - this.height / 2) / this.scalePx;
    this.clampCenter();
  }

  panBy(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.scalePx;
    this.cy -= dyPx / this.scalePx;
    this.clampCenter();
  }

  setView(lon: number, lat: number, zoom: number): void {
    this.zoom = Math.max(1, Math.min(64, zoom));
    this.cx = lonToWorldX(lon);
    this.cy = latToWorldY(lat);
    this.clampCenter();
  }

  private clampCenter(): void {
    const { minX, maxX, minY, maxY } = this.bounds;
    this.cx = Math.max(minX, Math.min(maxX, this.cx));
    this.cy = Math.max(minY, Math.min(maxY, this.cy));
  }
}

/**
 * Dark monochrome raster basemap (CARTO "dark, no labels").
 * Tiles load async; `onReady` is called so the caller can re-render.
 */
export class TileLayer {
  private cache = new Map<string, { img: HTMLImageElement; ready: boolean }>();

  constructor(
    private theme: Theme,
    private onReady: () => void
  ) {}

  draw(ctx: CanvasRenderingContext2D, view: MapView): void {
    const scale = view.scalePx;
    const zt = Math.max(8, Math.min(this.theme.tileMaxZoom, Math.round(Math.log2(scale / 256))));
    const n = 1 << zt;
    const [wl, wt] = view.screenToWorld(0, 0);
    const [wr, wb] = view.screenToWorld(view.width, view.height);
    const x0 = Math.max(0, Math.floor(wl * n));
    const x1 = Math.min(n - 1, Math.floor(wr * n));
    const y0 = Math.max(0, Math.floor(wt * n));
    const y1 = Math.min(n - 1, Math.floor(wb * n));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 80) return; // sanity guard

    const size = scale / n;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const [dx, dy] = view.worldToScreen(x / n, y / n);
        const tile = this.getTile(zt, x, y);
        if (tile.ready) {
          // +0.5 hides hairline seams between tiles
          ctx.drawImage(tile.img, dx, dy, size + 0.5, size + 0.5);
        } else {
          this.drawFallback(ctx, zt, x, y, dx, dy, size);
        }
      }
    }

    // prefetch the parent level for the viewport: cheap (1/4 the tiles) and
    // guarantees instant (if blurry) coverage on the next zoom change
    if (zt > 8) {
      for (let x = x0 >> 1; x <= x1 >> 1; x++) {
        for (let y = y0 >> 1; y <= y1 >> 1; y++) {
          this.getTile(zt - 1, x, y);
        }
      }
    }
  }

  /** Draw a stand-in from cached coarser/finer levels while a tile loads. */
  private drawFallback(
    ctx: CanvasRenderingContext2D,
    zt: number,
    x: number,
    y: number,
    dx: number,
    dy: number,
    size: number
  ): void {
    // scaled-up crop of the nearest cached ancestor (typical when zooming in)
    for (let dz = 1; dz <= 6 && zt - dz >= 0; dz++) {
      const p = this.cache.get(`${zt - dz}/${x >> dz}/${y >> dz}`);
      if (!p?.ready) continue;
      const f = 1 << dz;
      const sw = p.img.naturalWidth / f;
      ctx.drawImage(
        p.img,
        (x % f) * sw,
        (y % f) * sw,
        sw,
        sw,
        dx,
        dy,
        size + 0.5,
        size + 0.5
      );
      return;
    }
    // scaled-down cached children (typical when zooming out)
    if (zt + 1 <= this.theme.tileMaxZoom) {
      const half = size / 2;
      for (let i = 0; i < 4; i++) {
        const c = this.cache.get(`${zt + 1}/${x * 2 + (i & 1)}/${y * 2 + (i >> 1)}`);
        if (!c?.ready) continue;
        ctx.drawImage(c.img, dx + (i & 1) * half, dy + (i >> 1) * half, half + 0.5, half + 0.5);
      }
    }
  }

  private getTile(z: number, x: number, y: number) {
    const key = `${z}/${x}/${y}`;
    let tile = this.cache.get(key);
    if (tile) return tile;
    const img = new Image();
    img.crossOrigin = "anonymous";
    tile = { img, ready: false };
    this.cache.set(key, tile);
    img.onload = () => {
      tile!.ready = true;
      this.onReady();
    };
    img.src = this.theme.tileUrl(z, x, y);
    // bounded cache: evict oldest entries (multiple zoom levels stay warm)
    if (this.cache.size > 700) {
      for (const k of this.cache.keys()) {
        if (this.cache.size <= 500) break;
        this.cache.delete(k);
      }
    }
    return tile;
  }
}

/**
 * Lane per route, in units of lane spacing. Chosen so color families that
 * share track (2/5, A-D on CPW, J/M, F/G, ...) land on different lanes.
 * Offsets are applied along each shape's travel direction, so N/S shapes of
 * the same route separate into a double-track pair.
 */
const ROUTE_LANE: Record<string, number> = {
  "1": 1, "2": 1, "3": 1,
  "4": -1, "5": -1, "6": -1, "6X": -1,
  "7": 0, "7X": 0,
  A: 1, C: 1, E: 1, H: 1,
  B: 0, D: 0, F: 0, M: 0,
  G: -1,
  J: -1, Z: -1,
  L: 0,
  N: -1, Q: -1, R: -1, W: -1,
  GS: 0, FS: 0,
};

export function routeLane(routeId: string): number {
  return ROUTE_LANE[routeId] ?? 0;
}

export function laneSpacingPx(zoom: number): number {
  return 1.8 * Math.pow(zoom, 0.35) * 1.6;
}

/**
 * Offset a screen-space polyline perpendicular to its local direction.
 * `fallbackNormal` is used where segments are degenerate (e.g. a dwelling
 * train's trail collapsing to a point).
 */
export function offsetPolylinePx(
  pts: [number, number][],
  offset: number,
  fallbackNormal?: [number, number]
): [number, number][] {
  if (offset === 0 || pts.length === 0) return pts;
  const n = pts.length;
  // per-segment unit normals
  const segN: ([number, number] | null)[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    segN.push(len > 1e-6 ? [-dy / len, dx / len] : null);
  }
  const out: [number, number][] = new Array(n);
  let lastGood: [number, number] | null = fallbackNormal ?? null;
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? segN[i - 1] : null;
    const b = i < n - 1 ? segN[i] : null;
    let nx: number, ny: number;
    if (a && b) {
      nx = a[0] + b[0];
      ny = a[1] + b[1];
      const len = Math.hypot(nx, ny);
      if (len > 1e-6) {
        // miter normal: |a+b|/2 = cos(theta/2), clamped to avoid hairpin spikes
        const miter = Math.min(2, 2 / len);
        nx = (nx / len) * miter;
        ny = (ny / len) * miter;
      } else {
        [nx, ny] = lastGood ?? [0, 0];
      }
    } else {
      const s = a ?? b ?? lastGood;
      [nx, ny] = s ?? [0, 0];
    }
    if (nx !== 0 || ny !== 0) lastGood = [nx, ny];
    out[i] = [pts[i][0] + nx * offset, pts[i][1] + ny * offset];
  }
  return out;
}

/** mix a hex color toward black or white (f=0 keeps it, f=1 reaches target) */
function mixColor(hex: string, target: "black" | "white", f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const t = target === "white" ? 255 : 0;
  const mix = (c: number) => Math.round(c + (t - c) * f);
  return `rgb(${mix((n >> 16) & 0xff)},${mix((n >> 8) & 0xff)},${mix(n & 0xff)})`;
}

export function prepareShapes(shapes: ShapeInfo[]): Map<string, PreparedShape> {
  const out = new Map<string, PreparedShape>();
  for (const s of shapes) {
    out.set(s.id, { ...s, cum: cumulativeDist(s.points) });
  }
  return out;
}

export function renderStatic(
  view: MapView,
  theme: Theme,
  tiles: TileLayer,
  shapes: Iterable<ShapeInfo>,
  stations: Record<string, StationInfo>,
  routes: Record<string, RouteInfo>
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(view.dpr, view.dpr);
  const z = view.zoom;

  // basemap, washed out so the subway layer stays the hero
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, view.width, view.height);
  tiles.draw(ctx, view);
  ctx.fillStyle = theme.wash;
  ctx.fillRect(0, 0, view.width, view.height);

  // subway lines (dimmed route colors so live trains pop), offset per lane
  const spacing = laneSpacingPx(z);
  ctx.lineWidth = 1.8 * Math.pow(z, 0.35);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of shapes) {
    ctx.strokeStyle = mixColor(routes[s.routeId]?.color ?? "#888888", theme.lineMixTarget, theme.lineMixF);
    const pts = offsetPolylinePx(
      s.points.map(([lon, lat]) => view.project(lon, lat)),
      routeLane(s.routeId) * spacing
    );
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }

  // stations (more visible when zoomed in)
  ctx.fillStyle = theme.stationColor(z);
  const r = 1.3 * Math.pow(z, 0.45);
  for (const st of Object.values(stations)) {
    const [x, y] = view.project(st.lon, st.lat);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas;
}
