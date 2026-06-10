/**
 * Polls the MTA GTFS-RT feeds and turns TripUpdates + VehiclePositions into
 * per-train motion segments the client can animate.
 */
import fs from "node:fs";
import path from "node:path";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { RouteInfo, ShapeInfo, TrainState, TrainsResponse } from "../shared/types.js";

const { transit_realtime } = GtfsRealtimeBindings;

// NOTE: the "/" between nyct and gtfs MUST stay percent-encoded (%2F).
// A literal slash returns 403 "Missing Authentication Token".
const FEED_SUFFIXES = ["", "-ace", "-bdfm", "-g", "-jz", "-l", "-nqrw"]; // SIR excluded by design
const feedUrl = (suffix: string) =>
  `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${suffix}`;

const DATA_DIR = path.join(import.meta.dirname, "..", "data");

function loadJSON<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
}

const routes = loadJSON<Record<string, RouteInfo>>("routes.json");
const shapes = loadJSON<ShapeInfo[]>("shapes.json");
const shapeById = new Map(shapes.map((s) => [s.id, s]));
const shapesByRoute = new Map<string, ShapeInfo[]>();
for (const s of shapes) {
  let arr = shapesByRoute.get(s.routeId);
  if (!arr) shapesByRoute.set(s.routeId, (arr = []));
  arr.push(s);
}

/** protobufjs may decode int64 as Long; normalize to number (unix seconds). */
function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const anyV = v as any;
  return typeof anyV.toNumber === "function" ? anyV.toNumber() : Number(anyV);
}

/** "R16N" -> "R16" */
function parentStation(stopId: string): string {
  return /[NS]$/.test(stopId) ? stopId.slice(0, -1) : stopId;
}

/** "058350_A..S55R" -> { path: "A..S55R", direction: "S" } */
function parseTripId(tripId: string): { path: string; direction: string } {
  const path = tripId.includes("_") ? tripId.slice(tripId.indexOf("_") + 1) : tripId;
  const dir = /\.{1,2}([NS])/.exec(path)?.[1] ?? "";
  return { path, direction: dir };
}

function normalizeRoute(routeId: string): string | null {
  if (routes[routeId]) return routeId;
  // express variants like 6X / 7X sometimes appear when the static table lacks them
  const base = routeId.replace(/X$/, "");
  return routes[base] ? base : null;
}

/**
 * Pick the shape for a trip. Exact trip-path -> shape_id match first (the
 * NYCT trip id suffix usually IS a shape id); otherwise the route's
 * same-direction shape that contains both stops in the right order.
 */
function pickShape(
  routeId: string,
  tripPath: string,
  direction: string,
  prevStop: string,
  nextStop: string
): ShapeInfo | null {
  const fits = (s: ShapeInfo) =>
    s.stopDist[prevStop] != null &&
    s.stopDist[nextStop] != null &&
    (prevStop === nextStop || s.stopDist[prevStop] < s.stopDist[nextStop]);

  const exact = shapeById.get(tripPath);
  if (exact && fits(exact)) return exact;

  const candidates = (shapesByRoute.get(routeId) ?? []).filter(
    (s) => (!direction || s.id.includes(`.${direction}`)) && fits(s)
  );
  if (candidates.length === 0) return null;
  // most stops = the fullest variant of the line
  candidates.sort((a, b) => Object.keys(b.stopDist).length - Object.keys(a.stopDist).length);
  return candidates[0];
}

interface StopTime {
  station: string;
  arrival: number | null;
  departure: number | null;
}

function tripUpdateToTrain(
  tu: GtfsRealtimeBindings.transit_realtime.ITripUpdate,
  now: number
): TrainState | null {
  const tripId = tu.trip?.tripId;
  const rawRoute = tu.trip?.routeId;
  if (!tripId || !rawRoute) return null;
  const routeId = normalizeRoute(rawRoute);
  if (!routeId) return null;

  const stus: StopTime[] = (tu.stopTimeUpdate ?? [])
    .filter((s) => s.stopId)
    .map((s) => ({
      station: parentStation(s.stopId!),
      arrival: toNum(s.arrival?.time),
      departure: toNum(s.departure?.time),
    }));
  if (stus.length === 0) return null;

  // first stop the train has not yet left
  const idx = stus.findIndex((s) => (s.departure ?? s.arrival ?? 0) > now);
  if (idx === -1) return null; // trip effectively over

  const { path: tripPath, direction } = parseTripId(tripId);
  const id = `${routeId}_${tripId}`;
  const cur = stus[idx];
  const arrived = (cur.arrival ?? cur.departure ?? Infinity) <= now;

  if (arrived || idx === 0) {
    const t = cur.departure ?? cur.arrival ?? now;
    // scheduled trips that haven't entered service yet would pile up as
    // ghost trains at terminals; only show them just before departure
    if (!arrived && t > now + 90) return null;
    return {
      id,
      routeId,
      shapeId: pickShape(routeId, tripPath, direction, cur.station, cur.station)?.id ?? null,
      status: "STOPPED",
      prevStop: cur.station,
      nextStop: cur.station,
      depTime: t,
      arrTime: t,
      direction,
    };
  }

  const prev = stus[idx - 1];
  const depTime = prev.departure ?? prev.arrival ?? now;
  const arrTime = cur.arrival ?? cur.departure ?? now;
  if (arrTime <= depTime) return null;
  const shape = pickShape(routeId, tripPath, direction, prev.station, cur.station);
  return {
    id,
    routeId,
    shapeId: shape?.id ?? null,
    status: "MOVING",
    prevStop: prev.station,
    nextStop: cur.station,
    depTime,
    arrTime,
    direction,
  };
}

async function fetchFeed(suffix: string): Promise<TrainState[]> {
  const res = await fetch(feedUrl(suffix));
  if (!res.ok) throw new Error(`feed gtfs${suffix} -> HTTP ${res.status}`);
  const msg = transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  const now = toNum(msg.header?.timestamp) ?? Math.floor(Date.now() / 1000);
  const trains: TrainState[] = [];
  for (const entity of msg.entity) {
    if (!entity.tripUpdate) continue;
    const train = tripUpdateToTrain(entity.tripUpdate, now);
    if (train) trains.push(train);
  }
  return trains;
}

let latest: TrainsResponse = { timestamp: 0, trains: [] };

export function getTrains(): TrainsResponse {
  return latest;
}

export async function pollOnce(): Promise<void> {
  const results = await Promise.allSettled(FEED_SUFFIXES.map(fetchFeed));
  const trains: TrainState[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") trains.push(...r.value);
    else console.warn(`feed gtfs${FEED_SUFFIXES[i]} failed:`, r.reason?.message ?? r.reason);
  });
  if (trains.length > 0 || latest.timestamp === 0) {
    latest = { timestamp: Math.floor(Date.now() / 1000), trains };
  }
}

export function startPolling(intervalMs = 30_000): void {
  void pollOnce();
  setInterval(() => void pollOnce(), intervalMs).unref();
}
