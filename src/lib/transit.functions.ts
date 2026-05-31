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
export async function getLiveAlerts() {
  const targetUrl = "https://mna.mecatran.com/utw/ws/gtfsfeed/alerts/valleymetro?asJson=true";
  // Wrap the endpoint inside a public proxy link to bypass browser domain blocks
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
  
  try {
    const response = await fetch(proxyUrl);
    if (!response.ok) throw new Error("Failed to fetch alerts via proxy");
    
    const wrapper = await response.json();
    const data = JSON.parse(wrapper.contents); // Parse the proxied string content
    
    if (!data || !data.entity) return [];
    
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
    });
  } catch (error) {
    console.error("Error fetching alerts on client viewport:", error);
    return [];
  }
}

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
  "Dorsey Ln / Apache Blvd": { eastbound: "9010", westbound: "9038" },
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
  "Metro Parkway": { southbound: "9773", northbound: "9773" }, // Terminal station uses 9773
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
  "Buckeye / Central Ave": { southbound: "9788", northbound: "9789" },
  "Pioneer / Central Ave": { southbound: "9786", northbound: "9787" },
  "Broadway / Central Ave": { southbound: "9799", northbound: "9800" },
  "Roeser / Central Ave": { southbound: "9784", northbound: "9785" },
  "Southern / Central Ave": { southbound: "9782", northbound: "9783" },
  "Baseline / Central Ave": { southbound: "9781", northbound: "9781" },

  // Route A Terminals (East/West)
  "Downtown Phx Hub / Washington": { westbound: "9795" },
  "Downtown Phx Hub / Jefferson": { eastbound: "9794" },
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
