import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
const TransitMap = lazy(() =>
  import("@/components/TransitMap").then((m) => ({ default: m.TransitMap }))
);
import { TransitSidebar } from "@/components/TransitSidebar";
import { mockAlerts, type Vehicle, type VehicleType } from "@/lib/mock-transit";
import { getLiveVehicles } from "@/lib/transit.functions";
import { getRouteGeometry } from "@/lib/route-shapes.functions";

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
  const fetchVehicles = useServerFn(getLiveVehicles);
  const fetchRouteGeometry = useServerFn(getRouteGeometry);
  const { data } = useQuery({
    queryKey: ["live-vehicles"],
    queryFn: () => fetchVehicles(),
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
    staleTime: 10_000,
  });

  const vehicles: Vehicle[] = data?.vehicles ?? [];
  const lastUpdated = useMemo(
    () => (data?.fetchedAt ? new Date(data.fetchedAt) : new Date()),
    [data?.fetchedAt]
  );
  const feedError = data?.error ?? null;

  const [filters, setFilters] = useState<Record<VehicleType, boolean>>({
    bus: true,
    rail: true,
    streetcar: true,
  });
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<Vehicle | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { data: routeGeo } = useQuery({
    queryKey: ["route-geo", active?.route_id],
    queryFn: () => {
      // Split "72 · Label" and only take the "72" part to send to the database
      const cleanRouteId = active!.route_id.split(" · ")[0].trim();
      
      return fetchRouteGeometry({ data: { routeId: cleanRouteId } });
    },
    enabled: !!active?.route_id,
    staleTime: 5 * 60 * 1000,
  });

  const visibleVehicles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles.filter(
      (v) =>
        filters[v.vehicle_type] &&
        (q === "" || v.route_id.toLowerCase().includes(q))
    );
  }, [vehicles, filters, search]);

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      {mounted && (
        <Suspense fallback={null}>
          <TransitMap
            vehicles={visibleVehicles}
            activeVehicle={active}
            routeShape={active ? routeGeo?.shape ?? null : null}
            routeStops={active ? routeGeo?.stops ?? null : null}
            onClearSelection={() => setActive(null)}
            onSelectVehicle={setActive}
          />
        </Suspense>
      )}
      <TransitSidebar
        vehicles={vehicles}
        filters={filters}
        onToggle={(t) => setFilters((f) => ({ ...f, [t]: !f[t] }))}
        search={search}
        onSearch={setSearch}
        alerts={mockAlerts}
        onSelectVehicle={setActive}
        lastUpdated={lastUpdated}
        activeVehicle={active}
        onClearSelection={() => setActive(null)}
      />
      {feedError && (
        <div className="pointer-events-none absolute bottom-4 right-4 z-[1000] rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive backdrop-blur">
          Live feed: {feedError}
        </div>
      )}
    </main>
  );
}

