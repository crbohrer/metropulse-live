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

export async function fetchLiveAlerts() {
  const apiKey = import.meta.env.VITE_MECATRAN_API_KEY;
  // Inject the key into the URL using backticks (`) and ${}
  const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/alerts/valleymetro?apiKey=${apiKey}&asJson=true`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch alerts");
    const data = await response.json();
    
    // Extract alerts from the Mecatran JSON structure
    return data.entity.map((e: any) => ({
      id: e.id,
      severity: "warning", // You can map alert levels if needed
      route: e.alert.informed_entity[0]?.route_id || "General",
      title: e.alert.header_text.translation[0].text,
      time: "Live"
    }));
  } catch (error) {
    console.error("Error fetching alerts:", error);
    return [];
  }
}

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

export const getLiveVehicles = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ vehicles: Vehicle[]; fetchedAt: number; error: string | null }> => {
    const key = process.env.VALLEY_METRO_API_KEY;
    if (!key) {
      return { vehicles: [], fetchedAt: Date.now(), error: "Missing VALLEY_METRO_API_KEY" };
    }
    const url = `https://mna.mecatran.com/utw/ws/gtfsfeed/vehicles/valleymetro?apiKey=${key}&asJson=true`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
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
        const type = classify(v.trip?.routeId);
        vehicles.push({
          id: e.id || v.vehicle?.id || `${routeId}-${vehicles.length}`,
          latitude: pos.latitude,
          longitude: pos.longitude,
          route_id: v.vehicle?.label ? `${routeId} · ${v.vehicle.label}` : routeId,
          direction: directionLabel(v.trip?.directionId, pos.bearing),
          delay_seconds: 0,
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
