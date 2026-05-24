import { createServerFn } from "@tanstack/react-start";
import type { Vehicle, VehicleType } from "./mock-transit";

interface FeedEntity {
  id: string;
  vehicle?: {
    trip?: { routeId?: string; directionId?: number };
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
// Light Rail = "RAIL" / "0" / "RL"; Streetcar = "SMC" / "TS"; everything else = bus.
function classify(routeId: string | undefined): VehicleType {
  if (!routeId) return "bus";
  const r = routeId.toUpperCase();
  if (r === "A" || r === "B" || r === "0") return "rail";
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

interface TripUpdateEntity {
  id: string;
  tripUpdate?: {
    trip?: { tripId?: string; routeId?: string };
    vehicle?: { id?: string };
    stopTimeUpdate?: Array<{
      stopSequence?: number;
      arrival?: { delay?: number };
      departure?: { delay?: number };
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
          id: e.id || v.vehicle?.id || `${routeId}-${vehicles.length}`,
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
