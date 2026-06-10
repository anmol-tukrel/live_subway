/** Lightweight planar geometry over lon/lat, accurate enough for NYC-scale work. */

const METERS_PER_DEG_LAT = 110_574;
const METERS_PER_DEG_LON = 111_320 * Math.cos((40.73 * Math.PI) / 180);

export type LonLat = [number, number];

export function toXY([lon, lat]: LonLat): [number, number] {
  return [lon * METERS_PER_DEG_LON, lat * METERS_PER_DEG_LAT];
}

export function distMeters(a: LonLat, b: LonLat): number {
  const dx = (a[0] - b[0]) * METERS_PER_DEG_LON;
  const dy = (a[1] - b[1]) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Cumulative distance (meters) at each vertex of a polyline. */
export function cumulativeDist(points: LonLat[]): number[] {
  const out = new Array<number>(points.length);
  out[0] = 0;
  for (let i = 1; i < points.length; i++) {
    out[i] = out[i - 1] + distMeters(points[i - 1], points[i]);
  }
  return out;
}

/**
 * Point at `dist` meters along the polyline. `cum` must come from
 * cumulativeDist(points). Clamps to the ends.
 */
export function pointAtDist(points: LonLat[], cum: number[], dist: number): LonLat {
  if (dist <= 0) return points[0];
  const total = cum[cum.length - 1];
  if (dist >= total) return points[points.length - 1];
  // binary search for the segment containing dist
  let lo = 0;
  let hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= dist) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi] - cum[lo];
  const t = segLen > 0 ? (dist - cum[lo]) / segLen : 0;
  const a = points[lo];
  const b = points[hi];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export interface Projection {
  /** distance along the polyline (meters) of the closest point */
  along: number;
  /** distance from the query point to the polyline (meters) */
  offset: number;
  /** index of the segment start vertex */
  segIndex: number;
}

/**
 * Project a point onto a polyline, only considering segments starting at
 * `fromSeg` or later (used to keep successive stop projections monotonic
 * on routes that pass near the same place twice).
 */
export function projectOntoPolyline(
  p: LonLat,
  points: LonLat[],
  cum: number[],
  fromSeg = 0
): Projection {
  const [px, py] = toXY(p);
  let best: Projection = { along: cum[cum.length - 1], offset: Infinity, segIndex: points.length - 2 };
  for (let i = Math.max(0, fromSeg); i < points.length - 1; i++) {
    const [ax, ay] = toXY(points[i]);
    const [bx, by] = toXY(points[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const offset = Math.hypot(px - qx, py - qy);
    if (offset < best.offset) {
      best = { along: cum[i] + t * Math.sqrt(len2), offset, segIndex: i };
    }
  }
  return best;
}

/** Douglas-Peucker simplification with tolerance in meters. */
export function simplify(points: LonLat[], toleranceM: number): LonLat[] {
  if (points.length <= 2) return points.slice();
  const xy = points.map(toXY);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    const [ax, ay] = xy[start];
    const [bx, by] = xy[end];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let maxI = -1;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = xy[i];
      let d: number;
      if (len2 === 0) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > toleranceM && maxI > 0) {
      keep[maxI] = 1;
      stack.push([start, maxI], [maxI, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}
