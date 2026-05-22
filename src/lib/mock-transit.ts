export type VehicleType = "bus" | "rail" | "streetcar";

export interface Vehicle {
  id: string;
  latitude: number;
  longitude: number;
  route_id: string;
  direction: string;
  delay_seconds: number;
  vehicle_type: VehicleType;
}

export interface TransitAlert {
  id: string;
  severity: "info" | "warning" | "critical";
  route: string;
  title: string;
  description?: string; // Add this line
  time: string;
}

const TEMPE = { lat: 33.4255, lng: -111.94 };

function jitter(base: number, range: number) {
  return base + (Math.random() - 0.5) * range;
}

export function generateMockVehicles(count = 28): Vehicle[] {
  const routes = {
    bus: ["72", "81", "92", "108", "511", "Orbit Mercury"],
    rail: ["Valley Metro Rail"],
    streetcar: ["Tempe Streetcar"],
  };
  const directions = ["Northbound", "Southbound", "Eastbound", "Westbound"];
  const vehicles: Vehicle[] = [];

  for (let i = 0; i < count; i++) {
    const r = Math.random();
    const type: VehicleType = r < 0.7 ? "bus" : r < 0.88 ? "rail" : "streetcar";
    const routeList = routes[type];
    vehicles.push({
      id: `${type}-${1000 + i}`,
      latitude: jitter(TEMPE.lat, 0.08),
      longitude: jitter(TEMPE.lng, 0.1),
      route_id: routeList[Math.floor(Math.random() * routeList.length)],
      direction: directions[Math.floor(Math.random() * directions.length)],
      delay_seconds: Math.random() < 0.4 ? Math.floor(Math.random() * 600) : 0,
      vehicle_type: type,
    });
  }
  return vehicles;
}

export function driftVehicles(vehicles: Vehicle[]): Vehicle[] {
  return vehicles.map((v) => ({
    ...v,
    latitude: v.latitude + (Math.random() - 0.5) * 0.003,
    longitude: v.longitude + (Math.random() - 0.5) * 0.003,
    delay_seconds:
      Math.random() < 0.1
        ? Math.max(0, v.delay_seconds + Math.floor((Math.random() - 0.5) * 120))
        : v.delay_seconds,
  }));
}

export const mockAlerts: TransitAlert[] = [
  { id: "a1", severity: "warning", route: "Route 72", title: "Minor delays near Rural Rd due to traffic", time: "2 min ago" },
  { id: "a2", severity: "info", route: "Streetcar", title: "Service operating on normal schedule", time: "8 min ago" },
  { id: "a3", severity: "critical", route: "Light Rail", title: "Single tracking between Veterans Way & Mill Ave", time: "15 min ago" },
  { id: "a4", severity: "info", route: "Route 81", title: "New stop added at Apache Blvd & McClintock", time: "1 hr ago" },
  { id: "a5", severity: "warning", route: "Route 108", title: "Detour in effect through downtown Tempe", time: "2 hr ago" },
];
