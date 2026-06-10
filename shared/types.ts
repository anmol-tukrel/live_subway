/** Shapes of the preprocessed static data and the /api/trains payload. */

export interface RouteInfo {
  id: string;
  name: string;
  /** hex color including leading # */
  color: string;
}

export interface StationInfo {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

export interface ShapeInfo {
  id: string;
  routeId: string;
  /** [lon, lat] vertices, simplified */
  points: [number, number][];
  /** parent station id -> distance along this shape in meters, in stop order */
  stopDist: Record<string, number>;
}

export interface StaticBundle {
  routes: Record<string, RouteInfo>;
  stations: Record<string, StationInfo>;
  shapes: ShapeInfo[];
}

export type TrainStatus = "STOPPED" | "MOVING";

export interface TrainState {
  /** unique per trip */
  id: string;
  routeId: string;
  /** matched shape id, or null when no shape fit (client falls back to straight line) */
  shapeId: string | null;
  status: TrainStatus;
  /** parent station ids */
  prevStop: string;
  nextStop: string;
  /** unix seconds; for STOPPED trains dep === arr */
  depTime: number;
  arrTime: number;
  /** N or S, from the NYCT trip id */
  direction: string;
}

export interface TrainsResponse {
  /** server unix seconds when this snapshot was assembled */
  timestamp: number;
  trains: TrainState[];
}
