/**
 * One-shot setup: downloads the MTA static GTFS bundle and NYC borough
 * boundaries, then writes compact JSON to data/ for the server and client.
 *
 *   npm run preprocess
 */
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { cumulativeDist, projectOntoPolyline, simplify, type LonLat } from "../shared/geo.js";
import type { RouteInfo, ShapeInfo, StationInfo } from "../shared/types.js";

const GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";
const BOROUGHS_URL =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/NYC_Borough_Boundary/FeatureServer/0/query?where=1%3D1&outFields=BoroName&outSR=4326&f=geojson";

const ROOT = path.join(import.meta.dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache");
const DATA_DIR = path.join(ROOT, "data");
const SHAPE_TOLERANCE_M = 8;
const BOROUGH_TOLERANCE_M = 40;
// Staten Island Railway excluded by design (see project decisions)
const EXCLUDED_ROUTES = new Set(["SI", "SIR"]);

async function download(url: string, cacheFile: string): Promise<Buffer> {
  const cached = path.join(CACHE_DIR, cacheFile);
  if (fs.existsSync(cached)) {
    console.log(`using cached ${cacheFile}`);
    return fs.readFileSync(cached);
  }
  console.log(`downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, buf);
  return buf;
}

function csv<T = Record<string, string>>(zip: AdmZip, name: string, onRecord?: (r: any) => any): T[] {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`${name} missing from GTFS zip`);
  return parse(entry.getData(), {
    columns: true,
    skip_empty_lines: true,
    on_record: onRecord,
  }) as T[];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

async function main() {
  const zip = new AdmZip(await download(GTFS_URL, "gtfs_subway.zip"));

  // --- routes ---
  const routes: Record<string, RouteInfo> = {};
  for (const r of csv(zip, "routes.txt")) {
    if (EXCLUDED_ROUTES.has(r.route_id)) continue;
    routes[r.route_id] = {
      id: r.route_id,
      name: r.route_long_name || r.route_short_name,
      color: `#${r.route_color || "808183"}`,
    };
  }

  // --- trips: shape -> route, and one representative trip per shape ---
  const shapeRoute = new Map<string, string>();
  const repTripForShape = new Map<string, string>(); // shape_id -> trip_id
  const tripShape = new Map<string, string>(); // rep trip_id -> shape_id
  for (const t of csv(zip, "trips.txt")) {
    if (!t.shape_id || !routes[t.route_id]) continue;
    if (!shapeRoute.has(t.shape_id)) {
      shapeRoute.set(t.shape_id, t.route_id);
      repTripForShape.set(t.shape_id, t.trip_id);
      tripShape.set(t.trip_id, t.shape_id);
    }
  }
  console.log(`${shapeRoute.size} shapes across ${Object.keys(routes).length} routes`);

  // --- shapes: group points by shape_id ---
  const rawShapePts = new Map<string, { seq: number; p: LonLat }[]>();
  csv(zip, "shapes.txt", (r: any) => {
    if (!shapeRoute.has(r.shape_id)) return null;
    let arr = rawShapePts.get(r.shape_id);
    if (!arr) rawShapePts.set(r.shape_id, (arr = []));
    arr.push({ seq: Number(r.shape_pt_sequence), p: [Number(r.shape_pt_lon), Number(r.shape_pt_lat)] });
    return null; // keep memory flat
  });

  // --- stops: parent stations + child -> parent ---
  const stations: Record<string, StationInfo> = {};
  const parentOf = new Map<string, string>();
  for (const s of csv(zip, "stops.txt")) {
    if (s.location_type === "1") {
      stations[s.stop_id] = {
        id: s.stop_id,
        name: s.stop_name,
        lon: round6(Number(s.stop_lon)),
        lat: round6(Number(s.stop_lat)),
      };
    } else if (s.parent_station) {
      parentOf.set(s.stop_id, s.parent_station);
    }
  }

  // --- stop_times: ordered stop list for each representative trip ---
  const tripStops = new Map<string, { seq: number; station: string }[]>();
  csv(zip, "stop_times.txt", (r: any) => {
    if (!tripShape.has(r.trip_id)) return null;
    let arr = tripStops.get(r.trip_id);
    if (!arr) tripStops.set(r.trip_id, (arr = []));
    const station = parentOf.get(r.stop_id) ?? r.stop_id;
    arr.push({ seq: Number(r.stop_sequence), station });
    return null;
  });

  // --- build per-shape geometry + ordered stop distances ---
  const shapes: ShapeInfo[] = [];
  const usedStations = new Set<string>();
  for (const [shapeId, recs] of rawShapePts) {
    recs.sort((a, b) => a.seq - b.seq);
    const points = simplify(recs.map((r) => r.p), SHAPE_TOLERANCE_M).map(
      ([lon, lat]): LonLat => [round6(lon), round6(lat)]
    );
    if (points.length < 2) continue;
    const cum = cumulativeDist(points);

    const stopDist: Record<string, number> = {};
    const repTrip = repTripForShape.get(shapeId)!;
    const stopRecs = (tripStops.get(repTrip) ?? []).sort((a, b) => a.seq - b.seq);
    let fromSeg = 0;
    for (const { station } of stopRecs) {
      const st = stations[station];
      if (!st) continue;
      const proj = projectOntoPolyline([st.lon, st.lat], points, cum, fromSeg);
      stopDist[station] = Math.round(proj.along);
      fromSeg = proj.segIndex;
      usedStations.add(station);
    }

    shapes.push({ id: shapeId, routeId: shapeRoute.get(shapeId)!, points, stopDist });
  }
  shapes.sort((a, b) => a.id.localeCompare(b.id));

  const usedStationsObj: Record<string, StationInfo> = {};
  for (const id of [...usedStations].sort()) usedStationsObj[id] = stations[id];

  // --- borough outlines (best-effort; map still works without them) ---
  let boroughs: any = { type: "FeatureCollection", features: [] };
  try {
    const geo = JSON.parse((await download(BOROUGHS_URL, "boroughs.geojson")).toString());
    boroughs.features = geo.features
      .filter((f: any) => !/staten/i.test(f.properties?.BoroName ?? f.properties?.boro_name ?? ""))
      .map((f: any) => ({
        type: "Feature",
        properties: { name: f.properties?.BoroName ?? f.properties?.boro_name ?? "" },
        geometry: simplifyGeometry(f.geometry),
      }));
  } catch (err) {
    console.warn(`borough boundaries unavailable (${err}); continuing without them`);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const write = (name: string, obj: unknown) => {
    const file = path.join(DATA_DIR, name);
    fs.writeFileSync(file, JSON.stringify(obj));
    console.log(`wrote ${name} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  };
  write("routes.json", routes);
  write("stations.json", usedStationsObj);
  write("shapes.json", shapes);
  write("boroughs.json", boroughs);
  console.log(`done: ${shapes.length} shapes, ${usedStations.size} stations`);
}

function simplifyGeometry(geom: any): any {
  const simplifyRing = (ring: number[][]) => {
    const pts = simplify(ring.map(([lon, lat]): LonLat => [lon, lat]), BOROUGH_TOLERANCE_M);
    return pts.map(([lon, lat]) => [round6(lon), round6(lat)]);
  };
  if (geom.type === "Polygon") {
    return { type: "Polygon", coordinates: geom.coordinates.map(simplifyRing) };
  }
  if (geom.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geom.coordinates.map((poly: number[][][]) =>
        poly.map(simplifyRing).filter((r: number[][]) => r.length >= 4)
      ),
    };
  }
  return geom;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
