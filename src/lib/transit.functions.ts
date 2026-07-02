import { createServerFn } from "@tanstack/react-start";
import type { Vehicle, VehicleType } from "./mock-transit";
import stopsData from "./stops.json";

interface FeedEntity {
  id: string;
  vehicle?: {
    trip?: { tripId?: string; routeId?: string; directionId?: number };
    position?: { latitude?: number; longitude?: number; bearing?: number; speed?: number };
    currentStatus?: string;
    timestamp?: string;
    vehicle?: { id?: string; label?: string };
  };
}

interface Feed {
  header?: { timestamp?: string };
  entity?: FeedEntity[];
}

// GTFS-Realtime Service Alerts feed. Translations live inside header_text.translation[].text
// (snake_case in the raw protobuf-as-JSON) — we also accept the camelCase shape some proxies emit.
interface GtfsTranslation { text?: string; language?: string }
interface GtfsTranslatedString { translation?: GtfsTranslation[] }
interface GtfsInformedEntity {
  route_id?: string; routeId?: string;
  stop_id?: string; stopId?: string;
  agency_id?: string; agencyId?: string;
}
interface GtfsAlert {
  header_text?: GtfsTranslatedString; headerText?: GtfsTranslatedString;
  description_text?: GtfsTranslatedString; descriptionText?: GtfsTranslatedString;
  informed_entity?: GtfsInformedEntity[]; informedEntity?: GtfsInformedEntity[];
  severity_level?: string; severityLevel?: string;
  cause?: string; effect?: string;
}
interface GtfsAlertEntity { id?: string; alert?: GtfsAlert }

export interface LiveTransitAlert {
  id: string;
  severity: "info" | "warning" | "critical";
  routes: string[];
  route: string; // primary label for back-compat
  title: string;
  description: string;
  time: string;
  isMock?: boolean;
}

const MOCK_ALERTS: LiveTransitAlert[] = [
  {
    id: "mock-1",
    severity: "warning",
    routes: ["A"],
    route: "A",
    title: "Route A: Minor delays near Downtown Tempe due to event traffic",
    description: "Expect 5–10 minute delays between Mill Ave and Veterans Way through the evening. Allow extra travel time.",
    time: "System Test Alert",
    isMock: true,
  },
  {
    id: "mock-2",
    severity: "info",
    routes: ["72"],
    route: "72",
    title: "Route 72: Operating on a normal weekday schedule",
    description: "No reported disruptions. This is a layout verification alert displayed when the live feed has no active service alerts.",
    time: "System Test Alert",
    isMock: true,
  },
];

function severityFromGtfs(level: string | undefined): "info" | "warning" | "critical" {
  const s = (level || "").toUpperCase();
  if (s === "SEVERE") return "critical";
  if (s === "WARNING") return "warning";
  if (s === "INFO" || s === "UNKNOWN_SEVERITY" || s === "") return "info";
  return "warning";
}

export const getLiveAlerts = createServerFn({ method: "GET" }).handler(async (): Promise<LiveTransitAlert[]> => {
  const key = process.env.VALLEY_METRO_API_KEY;
  if (!key) {
    console.error("getLiveAlerts: VALLEY_METRO_API_KEY missing");
    return MOCK_ALERTS;
  }
  const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/alerts/valleymetro?apiKey=${key}&asJson=true`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`alerts feed ${res.status}`);
    const data = await res.json() as { entity?: GtfsAlertEntity[] };
    const entities = data?.entity ?? [];
    const alerts: LiveTransitAlert[] = [];
    for (const e of entities) {
      const a = e.alert;
      if (!a) continue;
      const header = a.header_text ?? a.headerText;
      const desc = a.description_text ?? a.descriptionText;
      const title = header?.translation?.[0]?.text?.trim() || 
                    (header?.translation as any)?.find((t: any) => t)?.text?.trim() || 
                    "Transit Alert";

      const description = desc?.translation?.[0]?.text?.trim() || 
                          (desc?.translation as any)?.find((t: any) => t)?.text?.trim() || 
                          "No description provided.";
      const informed = a.informed_entity ?? a.informedEntity ?? [];
      const routes = Array.from(
        new Set(
          informed
            .map((i) => (i.route_id ?? i.routeId ?? "").toString().trim())
            .filter(Boolean),
        ),
      );
      alerts.push({
        id: e.id || `alert-${alerts.length}`,
        severity: severityFromGtfs(a.severity_level ?? a.severityLevel),
        routes: routes.length ? routes : ["System"],
        route: routes[0] || "System",
        title,
        description,
        time: "Live",
      });
    }
    if (alerts.length === 0) return MOCK_ALERTS;
    return alerts;
  } catch (err) {
    console.error("getLiveAlerts failed:", err);
    return MOCK_ALERTS;
  }
});

// Valley Metro classification by route_id.
// Light Rail = "RAIL" / "RL"; Streetcar = "SMC" / "TS"; everything else = bus.
function classify(routeId: string | undefined): VehicleType {
  if (!routeId) return "bus";
  const r = routeId.toUpperCase();
  if (r === "0") return "bus";
  if (r === "A" || r === "B") return "rail";
  // Update this line to include the actual ID you see in your feed
  if (r === "S") return "streetcar"; 
  
  return "bus";
}

function directionLabel(d: number | undefined, bearing: number | undefined): string {
  if (typeof bearing === "number") {
    if (bearing >= 315 || bearing < 45) return "Northbound";
    if (bearing < 135) return "Eastbound";
    if (bearing < 225) return "Southbound";
    return "Westbound";
  }
  return d === 1 ? "Inbound" : "Outbound";
}

// Bounding box around Tempe + surrounding service area (keeps map relevant).
const BBOX = { minLat: 33.2, maxLat: 33.7, minLng: -112.4, maxLng: -111.7 };

export const getTripUpdates = createServerFn({ method: "GET" })
  .inputValidator((data: { vehicleId: string }) => data)
  .handler(async ({ data }): Promise<{ etas: Record<string, number> }> => {
    console.log("DEBUG: Looking for Trip/Vehicle ID:", data.vehicleId);
    const key = process.env.VALLEY_METRO_API_KEY;
    if (!key || !data.vehicleId) return { etas: {} };
    const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/realtime/valleymetro?apiKey=${key}&asJson=true`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return { etas: {} };
      const feed = (await res.json()) as { entity?: TripUpdateEntity[] };
      const etas: Record<string, number> = {};
      console.log("DEBUG: Feed entity count:", feed.entity?.length);
      for (const e of feed.entity ?? []) {
        const tu = e.tripUpdate;
        if (!tu) continue;
        if (tu.trip?.tripId === data.vehicleId || tu.vehicle?.id === data.vehicleId) {
           console.log("DEBUG: FOUND MATCH for ID:", data.vehicleId);
           console.log("DEBUG: Stop updates found:", tu.stopTimeUpdate);
        }
        if (tu.trip?.tripId !== data.vehicleId && tu.vehicle?.id !== data.vehicleId) continue;
        for (const stu of tu.stopTimeUpdate ?? []) {
          const stopId = stu.stopId;
          // Feed sometimes returns time as a string — coerce to number
          const rawT = stu.arrival?.time ?? stu.departure?.time;
          const t = typeof rawT === "string" ? Number(rawT) : rawT;
          if (stopId && typeof t === "number" && Number.isFinite(t)) {
            etas[String(stopId)] = t;
          }
        }
      }
      console.log("DEBUG: Final ETAs object:", etas);
      return { etas };
    } catch {
      return { etas: {} };
    }
  });

export interface StopDeparture {
  tripId: string;
  routeId: string;
  vehicleId: string | null;
  stopId: string;
  time: number;
  delay: number;
}

export interface TripPlanMatch {
  tripId: string;
  routeId: string;
  vehicleId: string | null;
  startStopId: string;
  endStopId: string;
  startSequence: number;
  endSequence: number;
  eta: number;
  delay: number;
  hasActiveVehicle: boolean;
}

export const getStopDepartures = createServerFn({ method: "GET" })
  .inputValidator((data: { stopIds: string[] }) => data)
  .handler(async ({ data }): Promise<{ departures: StopDeparture[] }> => {
    const key = process.env.VALLEY_METRO_API_KEY;
    if (!key || !data.stopIds?.length) return { departures: [] };
    const targets = new Set<string>();
    for (const s of data.stopIds) {
      const c = String(s).trim();
      if (!c) continue;
      targets.add(c);
      targets.add(c.replace(/^0+/, ""));
    }
    if (targets.size === 0) return { departures: [] };
    const nowSec = Math.floor(Date.now() / 1000);
    const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/realtime/valleymetro?apiKey=${key}&asJson=true`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return { departures: [] };
      const feed = (await res.json()) as { entity?: TripUpdateEntity[] };
      const out: StopDeparture[] = [];
      for (const e of feed.entity ?? []) {
        const tu = e.tripUpdate;
        if (!tu) continue;
        const tripId = tu.trip?.tripId ?? tu.vehicle?.id ?? e.id;
        const routeId = tu.trip?.routeId ?? "—";
        const vehicleId = tu.vehicle?.id ?? null;
        for (const stu of tu.stopTimeUpdate ?? []) {
          const sidRaw = stu.stopId ? String(stu.stopId).trim() : "";
          if (!sidRaw) continue;
          if (!targets.has(sidRaw) && !targets.has(sidRaw.replace(/^0+/, ""))) continue;
          const rawT = stu.arrival?.time ?? stu.departure?.time;
          const t = typeof rawT === "string" ? Number(rawT) : rawT;
          if (typeof t !== "number" || !Number.isFinite(t)) continue;
          if (t < nowSec) continue;
          const delay = stu.arrival?.delay ?? stu.departure?.delay ?? 0;
          out.push({ tripId, routeId, vehicleId, stopId: sidRaw, time: t, delay });
          break;
        }
      }
      out.sort((a, b) => a.time - b.time);
      return { departures: out };
    } catch {
      return { departures: [] };
    }
  });

export const getTripPlanMatches = createServerFn({ method: "GET" })
  .inputValidator((data: { startStopIds: string[]; endStopIds: string[]; activeTripIds?: string[] }) => data)
  .handler(async ({ data }): Promise<{ matches: TripPlanMatch[] }> => {
    const key = process.env.VALLEY_METRO_API_KEY;
    if (!key || !data.startStopIds?.length || !data.endStopIds?.length) return { matches: [] };

    const normalizeStop = (s: string) => String(s).trim().replace(/^0+/, "");
    const buildStopSet = (ids: string[]) => {
      const out = new Set<string>();
      for (const id of ids) {
        const raw = String(id).trim();
        if (!raw) continue;
        out.add(raw);
        out.add(normalizeStop(raw));
      }
      return out;
    };
    const startTargets = buildStopSet(data.startStopIds);
    const endTargets = buildStopSet(data.endStopIds);
    if (startTargets.size === 0 || endTargets.size === 0) return { matches: [] };

    const activeTrips = new Set((data.activeTripIds ?? []).map((id) => String(id).trim()).filter(Boolean));
    const nowSec = Math.floor(Date.now() / 1000);
    const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/realtime/valleymetro?apiKey=${key}&asJson=true`;

    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return { matches: [] };
      const feed = (await res.json()) as { entity?: TripUpdateEntity[] };
      const matches: TripPlanMatch[] = [];

      // Route-overlap scan: per routeId, collect which start-pool and end-pool stops are visited
      // by any trip on that route in the realtime feed. Used as a bulletproof fallback so a route
      // that serves both circles surfaces even when sequence/time data is missing.
      interface RouteOverlap {
        startStopId: string;
        endStopId: string;
        eta: number;
        delay: number;
        tripId: string;
        vehicleId: string | null;
        isActive: boolean;
      }
      const overlapByRoute = new Map<string, RouteOverlap>();
      const matchedRouteKeys = new Set<string>();

      for (const e of feed.entity ?? []) {
        const tu = e.tripUpdate;
        if (!tu?.stopTimeUpdate?.length) continue;
        const tripId = tu.trip?.tripId ?? e.id;
        const routeId = tu.trip?.routeId ?? "—";
        const vehicleId = tu.vehicle?.id ?? null;
        const isActive = activeTrips.size === 0 || activeTrips.has(tripId) || (!!vehicleId && activeTrips.has(vehicleId));

        const updates = tu.stopTimeUpdate
          .map((stu, order) => {
            const stopId = stu.stopId ? String(stu.stopId).trim() : "";
            const rawTime = stu.arrival?.time ?? stu.departure?.time;
            const time = typeof rawTime === "string" ? Number(rawTime) : rawTime;
            const rawSequence = stu.stopSequence;
            const sequence = typeof rawSequence === "string" ? Number(rawSequence) : rawSequence;
            const orderValue = typeof sequence === "number" && Number.isFinite(sequence) ? sequence : order;
            return { stopId, order, orderValue, time, delay: stu.arrival?.delay ?? stu.departure?.delay ?? 0 };
          })
          .filter((u) => u.stopId)
          .sort((a, b) => (a.orderValue === b.orderValue ? a.order - b.order : a.orderValue - b.orderValue));

        // Pass 1: sequenced match (start before end with valid future eta).
        let sequencedHit = false;
        for (let i = 0; i < updates.length; i += 1) {
          const start = updates[i];
          if (!startTargets.has(start.stopId) && !startTargets.has(normalizeStop(start.stopId))) continue;
          if (typeof start.time !== "number" || !Number.isFinite(start.time) || start.time < nowSec) continue;

          const end = updates.slice(i + 1).find((u) => endTargets.has(u.stopId) || endTargets.has(normalizeStop(u.stopId)));
          if (!end) continue;

          matches.push({
            tripId,
            routeId,
            vehicleId,
            startStopId: start.stopId,
            endStopId: end.stopId,
            startSequence: start.orderValue,
            endSequence: end.orderValue,
            eta: start.time,
            delay: start.delay,
            hasActiveVehicle: isActive,
          });
          matchedRouteKeys.add(routeId);
          sequencedHit = true;
          break;
        }
        if (sequencedHit) continue;

        // Pass 2: route-overlap fallback — does this trip visit both a start-pool stop AND an
        // end-pool stop in any order/time? If so, remember the route for synthetic emission.
        const startHit = updates.find((u) => startTargets.has(u.stopId) || startTargets.has(normalizeStop(u.stopId)));
        const endHit = updates.find((u) => endTargets.has(u.stopId) || endTargets.has(normalizeStop(u.stopId)));
        if (!startHit || !endHit) continue;
        const futureStartTime =
          typeof startHit.time === "number" && Number.isFinite(startHit.time) && startHit.time >= nowSec
            ? startHit.time
            : 0;
        const existing = overlapByRoute.get(routeId);
        if (
          !existing ||
          (futureStartTime > 0 && (existing.eta === 0 || futureStartTime < existing.eta)) ||
          (isActive && !existing.isActive)
        ) {
          overlapByRoute.set(routeId, {
            startStopId: startHit.stopId,
            endStopId: endHit.stopId,
            eta: futureStartTime,
            delay: startHit.delay,
            tripId,
            vehicleId,
            isActive,
          });
        }
      }

      // Emit synthetic fallback matches for routes that overlap both circles but had no
      // sequenced match. Marked hasActiveVehicle=false when no live trip is currently tracked.
      for (const [routeId, ov] of overlapByRoute) {
        if (matchedRouteKeys.has(routeId)) continue;
        matches.push({
          tripId: ov.tripId,
          routeId,
          vehicleId: ov.vehicleId,
          startStopId: ov.startStopId,
          endStopId: ov.endStopId,
          startSequence: 0,
          endSequence: 0,
          eta: ov.eta,
          delay: ov.delay,
          hasActiveVehicle: ov.isActive,
        });
      }

      matches.sort((a, b) => {
        if (a.hasActiveVehicle !== b.hasActiveVehicle) return a.hasActiveVehicle ? -1 : 1;
        if (a.eta === 0 && b.eta !== 0) return 1;
        if (b.eta === 0 && a.eta !== 0) return -1;
        return a.eta - b.eta;
      });
      return { matches };
    } catch {
      return { matches: [] };
    }
  });

interface TripUpdateEntity {
  id: string;
  tripUpdate?: {
    trip?: { tripId?: string; routeId?: string };
    vehicle?: { id?: string };
    stopTimeUpdate?: Array<{
      stopSequence?: number | string;
      stopId?: string;
      arrival?: { delay?: number; time?: number | string };
      departure?: { delay?: number; time?: number | string };
    }>;
  };
}

async function fetchDelaysByTripId(key: string): Promise<Map<string, number>> {
  const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/realtime/valleymetro?apiKey=${key}&asJson=true`;
  const delays = new Map<string, number>();
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return delays;
    const feed = (await res.json()) as { entity?: TripUpdateEntity[] };
    for (const e of feed.entity ?? []) {
      const tu = e.tripUpdate;
      const tripId = tu?.trip?.tripId;
      if (!tripId || !tu?.stopTimeUpdate?.length) continue;
      // Use the earliest upcoming stop's delay (first entry is typically the next stop).
      const stu = tu.stopTimeUpdate[0];
      const delay = stu?.arrival?.delay ?? stu?.departure?.delay;
      if (typeof delay === "number") delays.set(tripId, delay);
    }
  } catch {
    // swallow — vehicles still render without delay data
  }
  return delays;
}

export const getLiveVehicles = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ vehicles: Vehicle[]; fetchedAt: number; error: string | null }> => {
    const key = process.env.VALLEY_METRO_API_KEY;
    if (!key) {
      return { vehicles: [], fetchedAt: Date.now(), error: "Missing VALLEY_METRO_API_KEY" };
    }
    const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/vehicles/valleymetro?apiKey=${key}&asJson=true`;
    try {
      const [res, delaysByTrip] = await Promise.all([
        fetch(url, { headers: { accept: "application/json" } }),
        fetchDelaysByTripId(key),
      ]);
      if (!res.ok) {
        return { vehicles: [], fetchedAt: Date.now(), error: `Feed HTTP ${res.status}` };
      }
      const feed = (await res.json()) as Feed;
      const vehicles: Vehicle[] = [];
      for (const e of feed.entity ?? []) {
        const v = e.vehicle;
        const pos = v?.position;
        if (!v || !pos || typeof pos.latitude !== "number" || typeof pos.longitude !== "number") continue;
        if (
          pos.latitude < BBOX.minLat ||
          pos.latitude > BBOX.maxLat ||
          pos.longitude < BBOX.minLng ||
          pos.longitude > BBOX.maxLng
        ) {
          continue;
        }
        const rawRouteId = v.trip?.routeId?.trim();
        const tripId = v.trip?.tripId?.trim();
        // Discard out-of-service / deadheading vehicles: must have an active trip + route.
        if (!rawRouteId || !tripId) continue;
        const direction = directionLabel(v.trip?.directionId, pos.bearing);
        if (!direction || direction === "—") continue;
        const type = classify(rawRouteId);
        const delay = delaysByTrip.get(tripId) ?? 0;
        vehicles.push({
          id: tripId || v.vehicle?.id || e.id || `${rawRouteId}-${vehicles.length}`,
          latitude: pos.latitude,
          longitude: pos.longitude,
          route_id: v.vehicle?.label ? `${rawRouteId} · ${v.vehicle.label}` : rawRouteId,
          direction,
          delay_seconds: delay,
          vehicle_type: type,
        });
      }
      return { vehicles, fetchedAt: Date.now(), error: null };
    } catch (err) {
      return {
        vehicles: [],
        fetchedAt: Date.now(),
        error: err instanceof Error ? err.message : "Unknown fetch error",
      };
    }
  }
);



export const RAIL_STATION_CODES: Record<string, { eastbound?: string; westbound?: string; northbound?: string; southbound?: string }> = {
  // Downtown Phoenix Hub
  "Downtown Phoenix Hub": { eastbound: "9794", westbound: "9795" },
  
  // Split Downtown Tracks: Westbound runs on Washington, Eastbound runs on Jefferson!
  "3rd St / Washington": { westbound: "9032" }, 
  "3rd St / Jefferson": { eastbound: "9004" },  
  "12th St / Washington": { westbound: "9028" }, 
  "12th St / Jefferson": { eastbound: "9000" },  
  "24th St / Washington": { westbound: "9030" }, 
  "24th St / Jefferson": { eastbound: "9002" },  

  // Shared Phoenix / Tempe / Mesa Stations
  "38th St / Washington": { eastbound: "9003", westbound: "9031" },
  "44th St / Washington": { eastbound: "9005", westbound: "9033" },
  "50th St / Washington St": { eastbound: "9765", westbound: "9764" },
  "Priest Dr / Washington St": { eastbound: "9020", westbound: "9047" },
  "Center Pkwy / Washington": { eastbound: "9008", westbound: "9036" },
  "Mill Ave / 3rd St": { eastbound: "9016", westbound: "9043" },
  "Veterans Way / College Ave": { eastbound: "9027", westbound: "9054" },
  "University Dr / Rural Rd": { eastbound: "9025", westbound: "9052" },
  "McClintock Dr / Apache Blvd": { eastbound: "9014", westbound: "9041" },
  "Smith-Martin / Apache Blvd": { eastbound: "9022", westbound: "9049" },
  "Price-101 / Apache Blvd": { eastbound: "9019", westbound: "9046" },
  "Sycamore / Main St": { eastbound: "9023", westbound: "9050" },
  "Alma School / Main St": { eastbound: "9126", westbound: "9125" },
  "Country Club / Main St": { eastbound: "9353", westbound: "9347" },
  "Center / Main St": { eastbound: "9499", westbound: "9498" },
  "Mesa Dr / Main St": { eastbound: "9508", westbound: "9502" },
  "Stapley Dr / Main St": { eastbound: "8328", westbound: "8329" },
  "Gilbert Rd / Main St": { eastbound: "9763", westbound: "9762" },

  // Northwest Extension
  "Metro Parkway": { southbound: "9773", northbound: "9774" }, // Terminal station uses 9773
  "Mountain View / 25th Ave": { southbound: "6660", northbound: "9776" },
  "25th Ave / Dunlap": { southbound: "6658", northbound: "9777" },

  // 19th Ave Corridor
  "19th Ave / Dunlap": { southbound: "6656", northbound: "6659" },
  "Northern / 19th Ave": { southbound: "9017", northbound: "6657" },
  "Glendale / 19th Ave": { southbound: "9001", northbound: "6655" },
  "Montebello / 19th Ave": { southbound: "9006", northbound: "9044" },
  "19th Ave / Camelback": { southbound: "9009", northbound: "9029" },

  // Camelback & Central Ave Corridor
  "7th Ave / Camelback": { southbound: "9007", northbound: "9034" },
  "Central Ave / Camelback": { southbound: "9012", northbound: "9037" },
  "Campbell / Central Ave": { southbound: "9018", northbound: "9035" },
  "Indian School / Central Ave": { southbound: "9024", northbound: "9040" },
  "Osborn / Central Ave": { southbound: "9024", northbound: "9045" }, 
  "Thomas / Central Ave": { southbound: "9011", northbound: "9051" },
  "Encanto / Central Ave": { southbound: "9015", northbound: "9039" },
  "McDowell / Central Ave": { southbound: "9021", northbound: "9042" },
  "Roosevelt / Central Ave": { southbound: "9026", northbound: "9048" },

  // Downtown Split: Southbound runs on 1st Ave, Northbound runs on Central Ave!
  "Van Buren / Central Ave": { northbound: "9053" },
  "Van Buren / 1st Ave": { southbound: "9792" },
  "Washington / Central Ave": { northbound: "9055" },
  "Downtown Phx Hub / 1st Ave": { southbound: "9790" },
  "Downtown Phx Hub / Central Ave": { northbound: "9793" },
  "Lincoln / Central Ave": { northbound: "9791" },
  // Note: Southbound physically skips Lincoln and goes straight to Buckeye!

  // South Central Extension (Route B)
   "Lincoln / 1st Ave": { southbound: "9775" },
  "Buckeye / Central Ave": { southbound: "9788", northbound: "9789" },
  "Pioneer / Central Ave": { southbound: "9786", northbound: "9787" },
  "Broadway / Central Ave": { southbound: "9799", northbound: "9800" },
  "Roeser / Central Ave": { southbound: "9784", northbound: "9785" },
  "Southern / Central Ave": { southbound: "9782", northbound: "9783" },
  "Baseline / Central Ave": { southbound: "9780", northbound: "9781" },

  // Route A Terminals (East/West)
  "Downtown Phx Hub / Washington": { westbound: "9795" },
  "Downtown Phx Hub / Washington St": { westbound: "9795" }, // Alias
  "Downtown Phoenix Hub / Washington": { westbound: "9795" }, // Alias
  "Downtown Phoenix Hub / Washington St": { westbound: "9795" }, // Alias
  
  "Downtown Phx Hub / Jefferson": { eastbound: "9794" },
  "Downtown Phx Hub / Jefferson St": { eastbound: "9794" }, // Alias
  "Downtown Phoenix Hub / Jefferson": { eastbound: "9794" }, // Alias
  "Downtown Phoenix Hub / Jefferson St": { eastbound: "9794" }, // Alias

  // Tempe Streetcar (Route S)
  "Dorsey / Apache": { northbound: "9721", southbound: "9694" },
  "Dorsey Ln / Apache": { northbound: "9721", southbound: "9694" },
  "Dorsey Ln / Apache Blvd": { northbound: "9721", southbound: "9694" },
  
  "Rural / Apache": { northbound: "8954", southbound: "9099" },
  "Rural Rd / Apache Blvd": { northbound: "8954", southbound: "9099" },
  
  "Paseo Del Saber / Apache": { northbound: "9666", southbound: "9666" },
  
  "College Ave / Apache": { northbound: "9771", southbound: "9769" },
  "College Ave / Apache Blvd": { northbound: "9771", southbound: "9769" },
  
  "Eleventh St / Mill": { northbound: "9731", southbound: "9546" },
  "11th St / Mill": { northbound: "9731", southbound: "9546" },
  
  "Ninth St / Mill": { northbound: "9772", southbound: "9551" },
  "Sixth St / Mill": { northbound: "9742", southbound: "9742" },
  "Third St / Mill": { northbound: "9734", southbound: "9734" },
  
  "University Dr / Ash": { southbound: "9768" },
  "Fifth St / Ash": { southbound: "9545" },
  "Third St / Ash": { southbound: "9525" },
  
  "Tempe Beach Park / Rio Salado": { southbound: "9767" },
  "Hayden Ferry / Rio Salado": { northbound: "9766", southbound: "9766" },
  "Marina Heights / Rio Salado": { northbound: "9419", southbound: "9419" },
};

/**
 * Client-safe fetcher that utilizes a public CORS proxy fallback 
 * to bypass Valley Metro's firewall directly from the browser viewport.
 */
export async function getLiveRailEta(data: { stopName: string; direction: string }): Promise<{ ts: number | null }> {
  try {
    const cleanName = data.stopName.replace(" Station", "").trim();
    const station = RAIL_STATION_CODES[cleanName];
    if (!station) return { ts: null };

    const dirKey = data.direction.toLowerCase() as 'eastbound' | 'westbound' | 'northbound' | 'southbound';
    const stopCode = station[dirKey];
    if (!stopCode) return { ts: null };

    // Use a public CORS proxy fallback to securely query the endpoint straight from the browser
    const targetUrl = `https://api.valleymetro.org/nextride/v1/predictions/stop/${stopCode}`;
    const proxyUrl = `https://cors-anywhere.herokuapp.com/${targetUrl}`;
    
    // Try hitting the URL directly first; if it blocks, cut straight over to the proxy tunnel
    let response = await fetch(targetUrl).catch(() => null);
    if (!response || !response.ok) {
      response = await fetch(proxyUrl);
    }
    
    if (!response.ok) return { ts: null };
    const resData = await response.json();
    
    if (resData && resData.predictions && resData.predictions.length > 0) {
      const nextArrival = resData.predictions[0].estimated_arrival_time;
      // Convert ISO schedule formats to 10-digit Unix timestamps for frontend sync
      const ts = typeof nextArrival === "number" ? nextArrival : Math.floor(Date.parse(nextArrival) / 1000);
      return { ts };
    }
  } catch (error) {
    console.error("Direct client-side rail platform ETA fetch failed:", error);
  }
  return { ts: null };
 }

// ============================================================================
// 1-Transfer Trip Planner
// ============================================================================
interface StopRow { stop_id: number; stop_code: number; stop_name: string; stop_lat: number; stop_lon: number }
const STOP_NAME_BY_ID = (() => {
  const m = new Map<string, { name: string; lat: number; lng: number }>();
  for (const s of stopsData as StopRow[]) {
    if (!s?.stop_name) continue;
    const rec = { name: s.stop_name, lat: s.stop_lat, lng: s.stop_lon };
    m.set(String(s.stop_id), rec);
    m.set(String(s.stop_id).replace(/^0+/, ""), rec);
    if (s.stop_code) {
      m.set(String(s.stop_code), rec);
      m.set(String(s.stop_code).replace(/^0+/, ""), rec);
    }
  }
  return m;
})();
function lookupStop(stopId: string) {
  return STOP_NAME_BY_ID.get(stopId) || STOP_NAME_BY_ID.get(stopId.replace(/^0+/, "")) || null;
}

export interface TransferLeg {
  routeId: string;
  vehicleType: VehicleType;
  boardStopId: string;
  boardStopName: string;
  alightStopId: string;
  alightStopName: string;
  boardEta: number;   // unix seconds
  alightEta: number;  // unix seconds
  tripId: string;
  vehicleId: string | null;
  hasActiveVehicle: boolean;
  direction: string | null; // "Northbound" | "Southbound" | "Eastbound" | "Westbound"
}
export interface TransferPlan {
  key: string;
  leg1: TransferLeg;
  leg2: TransferLeg;
  transferStopId: string;
  transferStopName: string;
  totalMinutes: number;
  steps: string[];
  /** Set when leg1 and leg2 share a route but change direction. */
  sameRouteKind?: "continuation" | "reversal";
}

type Cardinal = "N" | "S" | "E" | "W";
const CARDINAL_NAME: Record<Cardinal, string> = { N: "Northbound", S: "Southbound", E: "Eastbound", W: "Westbound" };
function isOpposite(a: Cardinal, b: Cardinal): boolean {
  return (a === "N" && b === "S") || (a === "S" && b === "N") || (a === "E" && b === "W") || (a === "W" && b === "E");
}


export const getTripPlanTransfers = createServerFn({ method: "GET" })
  .inputValidator((data: { startStopIds: string[]; endStopIds: string[]; activeTripIds?: string[] }) => data)
  .handler(async ({ data }): Promise<{ transfers: TransferPlan[] }> => {
    const key = process.env.VALLEY_METRO_API_KEY;
    if (!key || !data.startStopIds?.length || !data.endStopIds?.length) return { transfers: [] };

    const norm = (s: string) => String(s).trim().replace(/^0+/, "");
    const buildSet = (ids: string[]) => {
      const out = new Set<string>();
      for (const id of ids) {
        const raw = String(id).trim();
        if (!raw) continue;
        out.add(raw);
        out.add(norm(raw));
      }
      return out;
    };
    const startTargets = buildSet(data.startStopIds);
    const endTargets = buildSet(data.endStopIds);
    const activeTrips = new Set((data.activeTripIds ?? []).map((id) => String(id).trim()).filter(Boolean));
    const nowSec = Math.floor(Date.now() / 1000);
    const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/realtime/valleymetro?apiKey=${key}&asJson=true`;

    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return { transfers: [] };
      const feed = (await res.json()) as { entity?: TripUpdateEntity[] };

      // Parse trips: routeId -> Trip[]
      interface StopHit { stopId: string; sequence: number; time: number }
      interface Trip { tripId: string; vehicleId: string | null; isActive: boolean; hits: StopHit[]; stopIndex: Map<string, number>; direction: Cardinal | null }
      const tripsByRoute = new Map<string, Trip[]>();
      const stopsByRoute = new Map<string, Set<string>>(); // normalized stop ids

      const computeTripDirection = (hits: StopHit[]): Cardinal | null => {
        if (hits.length < 2) return null;
        const first = lookupStop(hits[0].stopId);
        const last = lookupStop(hits[hits.length - 1].stopId);
        if (!first || !last) return null;
        const dLat = last.lat - first.lat;
        const dLng = last.lng - first.lng;
        if (Math.abs(dLat) < 1e-6 && Math.abs(dLng) < 1e-6) return null;
        if (Math.abs(dLat) >= Math.abs(dLng)) return dLat > 0 ? "N" : "S";
        return dLng > 0 ? "E" : "W";
      };

      for (const e of feed.entity ?? []) {
        const tu = e.tripUpdate;
        if (!tu?.stopTimeUpdate?.length) continue;
        const tripId = tu.trip?.tripId ?? e.id;
        const routeId = tu.trip?.routeId ?? "—";
        const vehicleId = tu.vehicle?.id ?? null;
        const isActive = activeTrips.has(tripId) || (!!vehicleId && activeTrips.has(vehicleId));

        const hits: StopHit[] = tu.stopTimeUpdate
          .map((stu, order) => {
            const stopId = stu.stopId ? String(stu.stopId).trim() : "";
            const rawTime = stu.arrival?.time ?? stu.departure?.time;
            const time = typeof rawTime === "string" ? Number(rawTime) : rawTime;
            const rawSeq = stu.stopSequence;
            const seqNum = typeof rawSeq === "string" ? Number(rawSeq) : rawSeq;
            const sequence = typeof seqNum === "number" && Number.isFinite(seqNum) ? seqNum : order;
            return { stopId, sequence, time: typeof time === "number" && Number.isFinite(time) ? time : 0 };
          })
          .filter((h) => h.stopId)
          .sort((a, b) => a.sequence - b.sequence);
        if (!hits.length) continue;

        const stopIndex = new Map<string, number>();
        hits.forEach((h, i) => {
          stopIndex.set(h.stopId, i);
          stopIndex.set(norm(h.stopId), i);
        });

        (tripsByRoute.get(routeId) ?? tripsByRoute.set(routeId, []).get(routeId)!).push({
          tripId, vehicleId, isActive, hits, stopIndex, direction: computeTripDirection(hits),
        });
        let set = stopsByRoute.get(routeId);
        if (!set) { set = new Set(); stopsByRoute.set(routeId, set); }
        for (const h of hits) set.add(norm(h.stopId));
      }

      // A route is "direct" only when some single trip visits a start target and later an end target.
      const direct = new Set<string>();
      for (const [routeId, trips] of tripsByRoute) {
        for (const trip of trips) {
          let seenStart = false;
          for (const h of trip.hits) {
            const nid = norm(h.stopId);
            if (!seenStart) { if (startTargets.has(nid)) seenStart = true; }
            else if (endTargets.has(nid)) { direct.add(routeId); break; }
          }
          if (direct.has(routeId)) break;
        }
      }

      // Find best leg for (route, fromTargets -> toTargets), optionally excluding trips going a given direction.
      interface LegResult { boardHit: StopHit; alightHit: StopHit; trip: Trip }
      const bestLeg = (
        routeId: string,
        fromTargets: Set<string>,
        toTargets: Set<string>,
        minBoardTime: number,
        excludeDir?: Cardinal,
      ): LegResult | null => {
        const trips = tripsByRoute.get(routeId);
        if (!trips) return null;
        let best: LegResult | null = null;
        for (const trip of trips) {
          if (excludeDir && trip.direction === excludeDir) continue;
          for (let i = 0; i < trip.hits.length; i++) {
            const board = trip.hits[i];
            if (!fromTargets.has(norm(board.stopId))) continue;
            if (board.time && board.time < minBoardTime) continue;
            for (let j = i + 1; j < trip.hits.length; j++) {
              const alight = trip.hits[j];
              if (!toTargets.has(norm(alight.stopId))) continue;
              const boardT = board.time || minBoardTime;
              if (!best) { best = { boardHit: board, alightHit: alight, trip }; break; }
              const curT = best.boardHit.time || minBoardTime;
              if (boardT < curT || (boardT === curT && trip.isActive && !best.trip.isActive)) {
                best = { boardHit: board, alightHit: alight, trip };
              }
              break;
            }
          }
        }
        return best;
      };


      const plans: TransferPlan[] = [];
      const usedKeys = new Set<string>();

      for (const r1 of startRoutes) {
        if (direct.has(r1)) continue;
        const r1Stops = stopsByRoute.get(r1)!;
        for (const r2 of endRoutes) {
          if (direct.has(r2) || r1 === r2) continue;
          const r2Stops = stopsByRoute.get(r2)!;
          // candidate transfer stops = r1 ∩ r2, excluding start/end targets
          let bestPlan: TransferPlan | null = null;
          for (const s of r1Stops) {
            if (!r2Stops.has(s)) continue;
            if (startTargets.has(s) || endTargets.has(s)) continue;
            const transferSet = new Set<string>([s]);
            const leg1 = bestLeg(r1, startTargets, transferSet, nowSec);
            if (!leg1) continue;
            const arriveTransfer = leg1.alightHit.time || (leg1.boardHit.time ? leg1.boardHit.time + 300 : nowSec + 600);
            const leg2 = bestLeg(r2, transferSet, endTargets, arriveTransfer);
            if (!leg2) continue;

            const transferInfo = lookupStop(s) || lookupStop(leg1.alightHit.stopId);
            const transferName = transferInfo?.name || `Stop ${s}`;
            const boardInfo1 = lookupStop(leg1.boardHit.stopId);
            const alightInfo2 = lookupStop(leg2.alightHit.stopId);
            const boardEta1 = leg1.boardHit.time || nowSec;
            const alightEta1 = leg1.alightHit.time || boardEta1 + 300;
            const boardEta2 = leg2.boardHit.time || alightEta1;
            const alightEta2 = leg2.alightHit.time || boardEta2 + 300;

            const l1: TransferLeg = {
              routeId: r1,
              vehicleType: classify(r1),
              boardStopId: leg1.boardHit.stopId,
              boardStopName: lookupStop(leg1.boardHit.stopId)?.name || `Stop ${leg1.boardHit.stopId}`,
              alightStopId: leg1.alightHit.stopId,
              alightStopName: transferName,
              boardEta: boardEta1,
              alightEta: alightEta1,
              tripId: leg1.trip.tripId,
              vehicleId: leg1.trip.vehicleId,
              hasActiveVehicle: leg1.trip.isActive,
            };
            const l2: TransferLeg = {
              routeId: r2,
              vehicleType: classify(r2),
              boardStopId: leg2.boardHit.stopId,
              boardStopName: transferName,
              alightStopId: leg2.alightHit.stopId,
              alightStopName: alightInfo2?.name || `Stop ${leg2.alightHit.stopId}`,
              boardEta: boardEta2,
              alightEta: alightEta2,
              tripId: leg2.trip.tripId,
              vehicleId: leg2.trip.vehicleId,
              hasActiveVehicle: leg2.trip.isActive,
            };
            const totalMinutes = Math.max(1, Math.round((alightEta2 - boardEta1) / 60));
            const steps = [
              `Board ${routeLabel(l1)} near your location${boardInfo1 ? ` at ${boardInfo1.name}` : ""}.`,
              `Ride to ${transferName} and get off.`,
              `Transfer to ${routeLabel(l2)} at the same platform.`,
              `Ride to ${l2.alightStopName} near your destination.`,
            ];
            const key = `${r1}|${r2}|${s}`;
            const plan: TransferPlan = {
              key, leg1: l1, leg2: l2, transferStopId: s, transferStopName: transferName,
              totalMinutes, steps,
            };
            if (!bestPlan || plan.leg1.boardEta < bestPlan.leg1.boardEta) bestPlan = plan;
          }
          if (bestPlan && !usedKeys.has(bestPlan.key)) {
            usedKeys.add(bestPlan.key);
            plans.push(bestPlan);
          }
        }
      }

      plans.sort((a, b) => {
        const aa = a.leg1.hasActiveVehicle && a.leg2.hasActiveVehicle ? 0 : 1;
        const bb = b.leg1.hasActiveVehicle && b.leg2.hasActiveVehicle ? 0 : 1;
        if (aa !== bb) return aa - bb;
        return a.leg1.boardEta - b.leg1.boardEta;
      });
      return { transfers: plans.slice(0, 6) };
    } catch {
      return { transfers: [] };
    }
  });

function routeLabel(l: TransferLeg): string {
  if (l.vehicleType === "rail") return `Light Rail ${l.routeId}`;
  if (l.vehicleType === "streetcar") return "the Streetcar";
  return `Route ${l.routeId}`;
}
