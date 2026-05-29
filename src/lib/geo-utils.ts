// Lightweight planar geometry helpers for splitting GeoJSON LineStrings.
// Coordinates are [lng, lat]. Euclidean approximations are fine at city scale.

export type LngLat = [number, number];

function distSq(a: LngLat, b: LngLat) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function projectOnSegment(p: LngLat, a: LngLat, b: LngLat) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point: LngLat = [a[0] + t * dx, a[1] + t * dy];
  return { t, point, distSq: distSq(p, point) };
}

export interface NearestResult {
  lineIndex: number;
  segIndex: number;
  t: number;
  point: LngLat;
  along: number; // distance along that line in coord units
  distSq: number;
}

export function nearestOnLines(lines: LngLat[][], p: LngLat): NearestResult | null {
  let best: NearestResult | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let acc = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const segLen = Math.sqrt(distSq(a, b));
      const proj = projectOnSegment(p, a, b);
      if (!best || proj.distSq < best.distSq) {
        best = {
          lineIndex: li,
          segIndex: i,
          t: proj.t,
          point: proj.point,
          distSq: proj.distSq,
          along: acc + proj.t * segLen,
        };
      }
      acc += segLen;
    }
  }
  return best;
}

export function splitLine(
  line: LngLat[],
  segIndex: number,
  point: LngLat
): { passed: LngLat[]; upcoming: LngLat[] } {
  const passed = [...line.slice(0, segIndex + 1), point];
  const upcoming = [point, ...line.slice(segIndex + 1)];
  return { passed, upcoming };
}

// Along-distance of an arbitrary point projected onto a line.
export function alongDistance(line: LngLat[], p: LngLat): number {
  let acc = 0;
  let bestAlong = 0;
  let bestDist = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = Math.sqrt(distSq(a, b));
    const proj = projectOnSegment(p, a, b);
    if (proj.distSq < bestDist) {
      bestDist = proj.distSq;
      bestAlong = acc + proj.t * segLen;
    }
    acc += segLen;
  }
  return bestAlong;
}

// ----- Higher-level helpers shared by Map + Sidebar ---------------------------

interface GeoFeatureLike {
  type?: string;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
}
interface GeoCollectionLike {
  features: GeoFeatureLike[];
}

function dirMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const a0 = a.split(" ")[0];
  const b0 = b.split(" ")[0];
  return a.includes(b0) || b.includes(a0);
}

// Strict: first word of each direction (case-insensitive) must be equal.
function dirStrict(a: string, b: string): boolean {
  const aw = (a || "").trim().toLowerCase().split(/\s+/)[0];
  const bw = (b || "").trim().toLowerCase().split(/\s+/)[0];
  return !!aw && !!bw && aw === bw;
}

function featureServiceType(f: GeoFeatureLike): string {
  const p = f.properties ?? {};
  return String(
    p.ServiceType ??
      p.servicetype ??
      p.service_type ??
      p.RouteType ??
      p.route_long_name ??
      p.route_short_name ??
      ""
  ).toLowerCase();
}

// Extract LineStrings from a route shape. For rail/streetcar, the upstream
// DB doesn't key features by the vehicle's route_id, so we filter by
// SYMBOLOGY/ROUTE_NUMBER + Direction instead. Buses match by direction only
// (route_id is already enforced by the server query).
export function getActiveRouteLines(
  routeShape: GeoCollectionLike | null,
  direction?: string | null,
  vehicleType?: "bus" | "rail" | "streetcar",
  routeId?: string | null
): LngLat[][] {
  if (!routeShape) return [];
  const all: { line: LngLat[]; dir: string; svc: string; routeTag: string }[] = [];
  for (const f of routeShape.features) {
    const g = f.geometry;
    if (!g) continue;
    const p = (f.properties || {}) as Record<string, unknown>;
    // Direction: prefer ROUTE_NUMBER ("... Northbound") which is authoritative
    // for rail/streetcar; fall back to any direction-like prop for buses.
    const dirSource = String(
      p.ROUTE_NUMBER ?? p.Direction ?? p.direction ?? p.DIR ?? ""
    ).toLowerCase();
    let dir = "";
    if (dirSource.includes("north")) dir = "north";
    else if (dirSource.includes("south")) dir = "south";
    else if (dirSource.includes("east")) dir = "east";
    else if (dirSource.includes("west")) dir = "west";

    const svc = (
      featureServiceType(f) +
      " " +
      String(p.SYMBOLOGY ?? "") +
      " " +
      String(p.ROUTE ?? "") +
      " " +
      String(p.ROUTE_NUMBER ?? "")
    ).toLowerCase();

    // routeTag holds a normalized route identifier for rail (a, b, s).
    let routeTag = "";
    const sym = String(p.SYMBOLOGY ?? "").toLowerCase();
    const rnum = String(p.ROUTE_NUMBER ?? "").toLowerCase();
    if (sym.includes("a-line") || /\brail a\b/.test(rnum)) routeTag = "a";
    else if (sym.includes("b-line") || /\brail b\b/.test(rnum)) routeTag = "b";
    else if (sym.includes("streetcar") || svc.includes("streetcar")) routeTag = "s";

    if (g.type === "LineString") {
      all.push({ line: g.coordinates as LngLat[], dir, svc, routeTag });
    } else if (g.type === "MultiLineString") {
      for (const part of g.coordinates as LngLat[][]) {
        all.push({ line: part, dir, svc, routeTag });
      }
    }
  }

  let pool = all;
  const rid = (routeId ?? "").trim().toLowerCase();

  if (vehicleType === "rail") {
    // STRICT: Route A must never load Route B tracks.
    if (rid === "a" || rid === "b") {
      pool = all.filter((l) => l.routeTag === rid);
    } else {
      pool = all.filter((l) => l.routeTag === "a" || l.routeTag === "b");
    }
  } else if (vehicleType === "streetcar") {
    pool = all.filter((l) => l.routeTag === "s" || l.svc.includes("streetcar"));
  }
  if (pool.length === 0) pool = all;

  const target = (direction ?? "").toLowerCase();
  if (!target) return pool.map((l) => l.line);
  const matched = pool.filter(({ dir }) => dirMatch(dir, target));
  return (matched.length ? matched : pool).map((l) => l.line);
}

interface ActiveVehicleLike {
  route_id: string;
  direction: string;
  vehicle_type: "bus" | "rail" | "streetcar";
  latitude: number;
  longitude: number;
}

// Strict stop filter: Routes must contain route_id (when present), Direction
// must STRICTLY match on first word (e.g. Southbound only allows South*), and
// ServiceType must match vehicle_type for rail/streetcar.
export function filterRouteStops(
  routeStops: GeoCollectionLike | null,
  activeVehicle: ActiveVehicleLike | null
): GeoFeatureLike[] {
  if (!routeStops || !activeVehicle) return [];
  const routeId = activeVehicle.route_id.split("·")[0].split(" · ")[0].trim();
  const vDir = activeVehicle.direction ?? "";
  const routeRe = new RegExp(`(^|[,;\\s])${routeId}([,;\\s]|$)`, "i");

  return routeStops.features.filter((f) => {
    if (f.geometry?.type !== "Point") return false;

    const routes = String(f.properties.Routes ?? "");
    if (routes && !routeRe.test(routes)) return false;

    const stopDir = String(f.properties.Direction ?? "");
        const isRail = activeVehicle.vehicle_type === "rail" || activeVehicle.vehicle_type === "streetcar";

        // Bypass text-based direction filtering for train stops
        if (!isRail && vDir && stopDir && !dirStrict(stopDir, vDir)) return false;

    const svc = String(
      f.properties.ServiceType ?? f.properties.servicetype ?? ""
    ).toLowerCase();
    if (activeVehicle.vehicle_type === "rail" && svc && !svc.includes("light rail")) return false;
    if (activeVehicle.vehicle_type === "streetcar" && svc && !svc.includes("streetcar")) return false;

    return true;
  });
}

// Build the ghosted-line context: nearest point on the (direction-filtered)
// lines, the chosen line, and the along-distance of the vehicle.
export interface GhostedRoute {
  lines: LngLat[][];
  chosen: LngLat[];
  lineIndex: number;
  segIndex: number;
  point: LngLat;
  vehicleAlong: number;
  passed: LngLat[];
  upcoming: LngLat[];
}

// Roughly 120 meters in squared lng/lat degrees at this latitude. If the
// vehicle is farther than this from any track segment, the snap is almost
// certainly meaningless (parallel return track, off-route reposition, GPS
// drift) — skip ghosting entirely so the path stays solid/bright.
const MAX_SNAP_DIST_SQ = 0.0000012;

export function buildGhostedRoute(
  lines: LngLat[][],
  vehicle: { latitude: number; longitude: number } | null
): GhostedRoute | null {
  if (!vehicle || lines.length === 0) return null;
  const p: LngLat = [vehicle.longitude, vehicle.latitude];
  const nearest = nearestOnLines(lines, p);
  if (!nearest) return null;
  if (nearest.distSq > MAX_SNAP_DIST_SQ) return null;
  const chosen = lines[nearest.lineIndex];
  const { passed, upcoming } = splitLine(chosen, nearest.segIndex, nearest.point);
  return {
    lines,
    chosen,
    lineIndex: nearest.lineIndex,
    segIndex: nearest.segIndex,
    point: nearest.point,
    vehicleAlong: nearest.along,
    passed,
    upcoming,
  };
}

