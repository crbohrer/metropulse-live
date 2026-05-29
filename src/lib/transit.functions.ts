import { createServerFn } from "@tanstack/react-start";
import type { Vehicle, VehicleType } from "./mock-transit";

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

// Replace the old fetchLiveAlerts with this:
// Replace the old getLiveAlerts with this:
export const getLiveAlerts = createServerFn({ method: "GET" }).handler(async () => {
  const key = process.env.VALLEY_METRO_API_KEY; 
  
  if (!key) {
    console.error("Missing VALLEY_METRO_API_KEY");
    return [];
  }

  const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/alerts/valleymetro?apiKey=${key}&asJson=true`;
  
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Failed to fetch alerts");
    
    const data = await response.json();
    
    // Extract alerts from the Mecatran JSON structure
    return data.entity.map((e: any) => {
      const header = e.alert.headerText?.translation?.[0]?.text || "Transit Alert";
      const desc = e.alert.descriptionText?.translation?.[0]?.text || "";
      const route = e.alert.informedEntity?.[0]?.routeId || "System";

      return {
        id: e.id,
        severity: "warning", 
        route: route,
        title: header,
        description: desc,
        time: "Live"
      };
    }); // <--- THIS closes the .map()
  } catch (error) {
    console.error("Error fetching alerts:", error);
    return [];
  }
}); // <--- THIS closes the .handler()

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

interface TripUpdateEntity {
  id: string;
  tripUpdate?: {
    trip?: { tripId?: string; routeId?: string };
    vehicle?: { id?: string };
    stopTimeUpdate?: Array<{
      stopSequence?: number;
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
        const routeId = v.trip?.routeId ?? "—";
        const tripId = v.trip?.tripId;
        const type = classify(v.trip?.routeId);
        const delay = tripId ? delaysByTrip.get(tripId) ?? 0 : 0;
        vehicles.push({
          id: v.trip?.tripId || v.vehicle?.id || e.id || `${routeId}-${vehicles.length}`,
          latitude: pos.latitude,
          longitude: pos.longitude,
          route_id: v.vehicle?.label ? `${routeId} · ${v.vehicle.label}` : routeId,
          direction: directionLabel(v.trip?.directionId, pos.bearing),
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



// Dictionary mapping physical station names to Valley Metro's 5-digit NextRide platform codes
export const RAIL_STATION_CODES: Record<string, { eastbound?: string; westbound?: string; northbound?: string; southbound?: string }> = {
  "Veterans Way/College Ave": { eastbound: "10022", westbound: "10023" },
  "Mill Ave/3rd St": { eastbound: "10020", westbound: "10021" },
  "Center Pkwy/Washington": { eastbound: "10018", westbound: "10019" },
  "University Dr/Rural": { eastbound: "10024", westbound: "10025" },
  "Dorsey Ln/Apache": { eastbound: "10026", westbound: "10027" },
  "McClintock Dr/Apache": { eastbound: "10028", westbound: "10029" },
  "Smith-Martin/Apache": { eastbound: "10030", westbound: "10031" },
  "Price-101 Fwy/Apache": { eastbound: "10032", westbound: "10033" },
};

/**
 * Direct fetcher that hits Valley Metro's NextRide API for exact rail platform predictions
 */
export async function fetchLiveRailEta(stopName: string, direction: string): Promise<number | null> {
  try {
    const cleanName = stopName.replace(" Station", "").trim();
    const station = RAIL_STATION_CODES[cleanName];
    if (!station) return null;

    // Match direction mapping string cleanly
    const dirKey = direction.toLowerCase() as 'eastbound' | 'westbound' | 'northbound' | 'southbound';
    const stopCode = station[dirKey];
    if (!stopCode) return null;

    // Hit the live NextRide JSON endpoint directly
    const response = await fetch(`https://api.valleymetro.org/nextride/v1/predictions/stop/${stopCode}`);
    if (!response.ok) return null;
    
    const data = await response.json();
    
    // Grab the ETA timestamp of the very next approaching train payload
    if (data && data.predictions && data.predictions.length > 0) {
      const nextArrival = data.predictions[0].estimated_arrival_time;
      return typeof nextArrival === "number" ? nextArrival : Date.parse(nextArrival);
    }
  } catch (error) {
    console.error("Error fetching direct rail platform ETA:", error);
  }
  return null;
}
