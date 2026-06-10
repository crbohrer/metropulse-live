import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
const TransitMap = lazy(() =>
  import("@/components/TransitMap").then((m) => ({ default: m.TransitMap }))
);
import { TransitSidebar } from "@/components/TransitSidebar";
import { mockAlerts, type Vehicle, type VehicleType } from "@/lib/mock-transit";
import { getLiveVehicles, getTripUpdates } from "@/lib/transit.functions";
import { getRouteGeometry } from "@/lib/route-shapes.functions";
import { findStopIdsByQuery } from "@/lib/stops-index";

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
  const fetchTripUpdates = useServerFn(getTripUpdates);
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
  const [selectedDirections, setSelectedDirections] = useState<string[]>([]);
  const [active, setActive] = useState<Vehicle | null>(null);
  const [isRouteViewActive, setIsRouteViewActive] = useState(false);
  const [focusedStop, setFocusedStop] = useState<{ lat: number; lng: number; key: number } | null>(null);
  const [selectedStop, setSelectedStop] = useState<{ id: string; name: string; lat: number; lng: number } | null>(null);
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

  const { data: tripUpdates } = useQuery({
    queryKey: ["trip-updates", active?.id],
    queryFn: () => fetchTripUpdates({ data: { vehicleId: active!.id } }),
    enabled: !!active && isRouteViewActive,
    refetchInterval: 15000,
  });

  // Bridge plain-text stop names -> numeric stop IDs using the master stops.json database.
  const matchedStopIds = useMemo(() => findStopIdsByQuery(search), [search]);

  const visibleVehicles = useMemo(() => {
    const q = search.trim().toLowerCase();
    const dirs = selectedDirections.map((d) => d.toLowerCase());
    const etas = tripUpdates?.etas ?? null;
    return vehicles.filter((v) => {
      if (!filters[v.vehicle_type]) return false;
      if (dirs.length > 0 && !dirs.some((d) => v.direction.toLowerCase().includes(d))) return false;
      if (q === "") return true;
      if (v.route_id.toLowerCase().includes(q) || v.direction.toLowerCase().includes(q)) return true;
      // Stop-name match: keep vehicles whose upcoming ETA stop IDs intersect matchedStopIds.
      if (matchedStopIds.size > 0 && etas && v.id === active?.id) {
        for (const sid of Object.keys(etas)) {
          const clean = String(sid).trim();
          if (matchedStopIds.has(clean) || matchedStopIds.has(clean.replace(/^0+/, ""))) return true;
        }
      }
      return false;
    });
  }, [vehicles, filters, search, selectedDirections, matchedStopIds, tripUpdates, active]);

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      {mounted && (
        <Suspense fallback={null}>
          <TransitMap
            vehicles={visibleVehicles}
            activeVehicle={active}
            routeShape={active && isRouteViewActive ? routeGeo?.shape ?? null : null}
            routeStops={active && isRouteViewActive ? routeGeo?.stops ?? null : null}
            isRouteViewActive={isRouteViewActive}
            liveEtas={isRouteViewActive ? tripUpdates?.etas ?? null : null}
            focusedStop={focusedStop}
            stopSearch={search}
            onPickStop={(s) => {
              setSelectedStop(s);
              setFocusedStop({ lat: s.lat, lng: s.lng, key: Date.now() });
            }}
            onClearSelection={() => {
              setActive(null);
              setIsRouteViewActive(false);
              setFocusedStop(null);
              setSelectedStop(null);
            }}
            onSelectVehicle={(v) => {
              setActive(v);
              setIsRouteViewActive(false);
              setFocusedStop(null);
              setSelectedStop(null);
            }}
            onShowRoute={() => setIsRouteViewActive(true)}
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
        onSelectVehicle={(v) => {
          setActive(v);
          setIsRouteViewActive(false);
        }}
        last={lastUpdated}
        activeVehicle={active}
        onClearSelection={() => {
          setActive(null);
          setIsRouteViewActive(false);
        }}
        isRouteViewActive={isRouteViewActive}
        routeShape={active && isRouteViewActive ? routeGeo?.shape ?? null : null}
        routeStops={active && isRouteViewActive ? routeGeo?.stops ?? null : null}
        liveEtas={isRouteViewActive ? tripUpdates?.etas ?? null : null}
        onSelectStop={(lat, lng) => setFocusedStop({ lat, lng, key: Date.now() })}
        selectedStop={selectedStop}
        onClearSelectedStop={() => setSelectedStop(null)}
        onPickStop={(s) => {
          setSelectedStop(s);
          setFocusedStop({ lat: s.lat, lng: s.lng, key: Date.now() });
        }}
        selectedDirections={selectedDirections}
        onToggleDirection={(d) =>
          setSelectedDirections((prev) =>
            prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
          )
        }
      />
      {feedError && (
        <div className="pointer-events-none absolute bottom-4 right-4 z-[1000] rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive backdrop-blur">
          Live feed: {feedError}
        </div>
      )}
    </main>
  );
}

