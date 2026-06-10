/** Projection + static layer rendering (boroughs, lines, stations). */
import type { RouteInfo, ShapeInfo, StationInfo } from "../../shared/types";
import { cumulativeDist, type LonLat } from "../../shared/geo";

const LAT_SCALE = 1;
const LON_SCALE = Math.cos((40.73 * Math.PI) / 180);

export interface PreparedShape extends ShapeInfo {
  cum: number[];
}

export class MapView {
  private minX = 0;
  private minY = 0;
  private scale = 1;
  private offX = 0;
  private offY = 0;
  width = 0;
  height = 0;
  dpr = 1;

  constructor(private bboxPoints: LonLat[]) {}

  /** Fit the lon/lat bounding box into the given css-pixel viewport. */
  fit(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const [lon, lat] of this.bboxPoints) {
      const x = lon * LON_SCALE;
      const y = lat * LAT_SCALE;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = 0.05;
    const dw = (maxX - minX) * (1 + pad * 2);
    const dh = (maxY - minY) * (1 + pad * 2);
    this.scale = Math.min(width / dw, height / dh);
    this.minX = minX - (maxX - minX) * pad;
    this.minY = minY - (maxY - minY) * pad;
    this.offX = (width - (maxX - minX) * (1 + pad * 2) * this.scale) / 2;
    this.offY = (height - (maxY - minY) * (1 + pad * 2) * this.scale) / 2;
  }

  /** lon/lat -> css pixels (y down) */
  project(lon: number, lat: number): [number, number] {
    const x = (lon * LON_SCALE - this.minX) * this.scale + this.offX;
    const y = this.height - ((lat * LAT_SCALE - this.minY) * this.scale + this.offY);
    return [x, y];
  }
}

function dimColor(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  return `rgb(${r},${g},${b})`;
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
  boroughs: GeoJSON.FeatureCollection,
  shapes: Iterable<ShapeInfo>,
  stations: Record<string, StationInfo>,
  routes: Record<string, RouteInfo>
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(view.dpr, view.dpr);

  // boroughs
  ctx.fillStyle = "#0c1016";
  ctx.strokeStyle = "#1a222d";
  ctx.lineWidth = 1;
  for (const f of boroughs.features ?? []) {
    const geom = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      ctx.beginPath();
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => {
          const [x, y] = view.project(lon, lat);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }
  }

  // subway lines (dimmed route colors so live trains pop)
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of shapes) {
    ctx.strokeStyle = dimColor(routes[s.routeId]?.color ?? "#555555", 0.5);
    ctx.beginPath();
    s.points.forEach(([lon, lat], i) => {
      const [x, y] = view.project(lon, lat);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // stations
  ctx.fillStyle = "#39424e";
  for (const st of Object.values(stations)) {
    const [x, y] = view.project(st.lon, st.lat);
    ctx.beginPath();
    ctx.arc(x, y, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas;
}
