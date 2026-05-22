import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { TransitMap } from "@/components/TransitMap";
import { TransitSidebar } from "@/components/TransitSidebar";
import {
  driftVehicles,
  generateMockVehicles,
  mockAlerts,
  type Vehicle,
  type VehicleType,
} from "@/lib/mock-transit";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "MetroPulse Tempe — Live Transit Tracking" },
      { name: "description", content: "Real-time tracking of buses, light rail, and the streetcar across Tempe, Arizona." },
    ],
  }),
});

function Index() {
  const [vehicles, setVehicles] = useState<Vehicle[]>(() => generateMockVehicles(32));
  const [filters, setFilters] = useState<Record<VehicleType, boolean>>({
    bus: true,
    rail: true,
    streetcar: true,
  });
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<Vehicle | null>(null);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  // Poll every 15s — currently drifts mock data; swap for edge function later.
  useEffect(() => {
    const id = setInterval(() => {
      setVehicles((prev) => driftVehicles(prev));
      setLastUpdated(new Date());
    }, 15000);
    return () => clearInterval(id);
  }, []);

  const visibleVehicles = useMemo(
    () => vehicles.filter((v) => filters[v.vehicle_type]),
    [vehicles, filters]
  );

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <TransitMap vehicles={visibleVehicles} activeVehicle={active} />
      <TransitSidebar
        vehicles={vehicles}
        filters={filters}
        onToggle={(t) => setFilters((f) => ({ ...f, [t]: !f[t] }))}
        search={search}
        onSearch={setSearch}
        alerts={mockAlerts}
        onSelectVehicle={setActive}
        lastUpdated={lastUpdated}
      />
    </main>
  );
}
