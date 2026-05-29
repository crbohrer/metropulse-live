import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, CircleMarker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import type { Vehicle, VehicleType } from "@/lib/mock-transit";
import type { GeoJSON as RouteGeoJSON, GeoJSONFeature } from "@/lib/route-shapes.functions";
import { nearestOnLines } from "@/lib/geo-utils"; // Adjust path if necessary
import {
  alongDistance,
  buildGhostedRoute,
  filterRouteStops,
  getActiveRouteLines,
  type LngLat,
} from "@/lib/geo-utils";

const TEMPE_CENTER: [number, number] = [33.4255, -111.94];

const typeClass: Record<VehicleType, string> = {
  bus: "marker-bus",
  rail: "marker-rail",
  streetcar: "marker-streetcar",
};

const typeLabel: Record<VehicleType, string> = {
  bus: "Bus",
  rail: "Light Rail",
  streetcar: "Streetcar",
};

const typeColor: Record<VehicleType, string> = {
  bus: "oklch(0.7 0.18 240)",
  rail: "#7e22ce",
  streetcar: "oklch(0.75 0.18 55)",
};

function buildIcon(type: VehicleType) {
  return L.divIcon({
    className: "",
    html: `<div class="vehicle-marker ${typeClass[type]}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function FlyToActive({ vehicle }: { vehicle: Vehicle | null }) {
  const map = useMap();
  useEffect(() => {
    if (vehicle) {
      map.flyTo([vehicle.latitude, vehicle.longitude], Math.max(map.getZoom(), 14), {
        duration: 0.8,
      });
    }
  }, [vehicle, map]);
  return null;
}

function MapClickHandler({ onBackgroundClick }: { onBackgroundClick: () => void }) {
  useMapEvents({ click: () => onBackgroundClick() });
  return null;
}

function FlyToStop({ stop }: { stop: { lat: number; lng: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (stop) {
      map.flyTo([stop.lat, stop.lng], Math.max(map.getZoom(), 16), { duration: 0.7 });
    }
  }, [stop, map]);
  return null;
}

function formatDelay(seconds: number) {
  if (!seconds) return "On time";
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  if (seconds < 0) return `${m}m ${s}s early`;
  return `+${m}m ${s}s late`;
}

interface Props {
  vehicles: Vehicle[];
  activeVehicle: Vehicle | null;
  routeShape: RouteGeoJSON | null;
  routeStops: RouteGeoJSON | null;
  isRouteViewActive: boolean;
  liveEtas: Record<string, number> | null;
  focusedStop: { lat: number; lng: number; key: number } | null;
  onClearSelection: () => void;
  onSelectVehicle: (v: Vehicle) => void;
  onShowRoute: () => void;
}

export function TransitMap({
  vehicles,
  activeVehicle,
  routeShape,
  routeStops,
  isRouteViewActive,
  liveEtas,
  focusedStop,
  onClearSelection,
  onSelectVehicle,
  onShowRoute,
}: Props) {
  // Hide all other vehicles when in route view.
  const displayedVehicles = isRouteViewActive && activeVehicle
    ? vehicles.filter((v) => v.id === activeVehicle.id)
    : vehicles;

  const icons = useMemo(
    () => ({
      bus: buildIcon("bus"),
      rail: buildIcon("rail"),
      streetcar: buildIcon("streetcar"),
    }),
    []
  );

  const activeColor = activeVehicle ? typeColor[activeVehicle.vehicle_type] : typeColor.bus;
  const shapeKey = activeVehicle?.route_id ?? "none";

  // Direction-filtered lines for the active vehicle.
  const routeLines = useMemo<LngLat[][]>(() => {
    if (!isRouteViewActive || !activeVehicle) return [];
    const rid = activeVehicle.route_id.split("·")[0].split(" · ")[0].trim();
    return getActiveRouteLines(routeShape, activeVehicle.direction, activeVehicle.vehicle_type, rid);
  }, [isRouteViewActive, activeVehicle, routeShape]);

  const ghosted = useMemo(
    () => (isRouteViewActive ? buildGhostedRoute(routeLines, activeVehicle) : null),
    [isRouteViewActive, routeLines, activeVehicle]
  );

  // Strictly filtered stops for the active route/direction/service.
  const stops = useMemo<GeoJSONFeature[]>(() => {
    if (!isRouteViewActive) return [];
    const baseStops = filterRouteStops(routeStops, activeVehicle) as GeoJSONFeature[];

    // SPATIAL FILTER: only keep stops physically on the drawn route line.
    // Applied to all modes — keeps the itinerary clean for buses too.
    if (routeLines.length === 0) return baseStops;
    return baseStops.filter((f) => {
      const coords = f.geometry.coordinates as [number, number];
      const nearest = nearestOnLines(routeLines, coords);
      // ~50m in squared lng/lat degrees at this latitude.
      return nearest && nearest.distSq <= 0.0000002;
    });
  }, [isRouteViewActive, routeStops, activeVehicle, routeLines]);

  const toLatLng = (coords: LngLat[]): [number, number][] =>
    coords.map(([lng, lat]) => [lat, lng]);

  return (
    <MapContainer
      center={TEMPE_CENTER}
      zoom={13}
      zoomControl={false}
      className="absolute inset-0 z-0"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      <MapClickHandler onBackgroundClick={onClearSelection} />
      <FlyToActive vehicle={activeVehicle} />
      <FlyToStop stop={focusedStop} />

      {ghosted ? (
        <>
          {routeLines.map((line, i) => {
            if (i === ghosted.lineIndex) return null;
            // Lines before the active line are "passed"; lines after are upcoming.
            const isPassedSegment = i < ghosted.lineIndex;
            return (
              <Polyline
                key={`other-${shapeKey}-${i}`}
                positions={toLatLng(line)}
                pathOptions={{
                  color: activeColor,
                  weight: isPassedSegment ? 4 : 7,
                  opacity: isPassedSegment ? 0.3 : 1.0,
                }}
              />
            );
          })}
          <Polyline
            key={`passed-${shapeKey}`}
            positions={toLatLng(ghosted.passed)}
            pathOptions={{ color: activeColor, weight: 4, opacity: 0.3 }}
          />
          <Polyline
            key={`upcoming-${shapeKey}`}
            positions={toLatLng(ghosted.upcoming)}
            pathOptions={{ color: activeColor, weight: 7, opacity: 1.0 }}
          />
        </>
      ) : (
        // No reliable snap (vehicle off-line / parallel return track) — render
        // everything bright and solid; do NOT dim any segment.
        <>
          {routeLines.map((line, i) => (
            <Polyline
              key={`solid-${shapeKey}-${i}`}
              positions={toLatLng(line)}
              pathOptions={{ color: activeColor, weight: 7, opacity: 1.0 }}
            />
          ))}
        </>
      )}


      {stops.map((f, i) => {
        const coords = f.geometry.coordinates as number[];
        const [lng, lat] = coords;
        if (typeof lat !== "number" || typeof lng !== "number") return null;

        const name =
          (f.properties.stop_name as string) ||
          (f.properties.StationName as string) ||
          (f.properties.STATION as string) ||
          (f.properties.Stop_Name as string) ||
          (f.properties.StopName as string) ||
          (f.properties.STOPNAME as string) ||
          "Transit Stop";

        // Rail/Streetcar stops expose StationId/NextRide/PlatformID instead of stop_id/stop_code.
        const idCandidates = [
          f.properties.stop_id,
          f.properties.stop_code,
          f.properties.StationId,
          f.properties.NextRide,
          f.properties.PlatformID,
          f.properties.PlatformId,
          f.properties.platform_id,
        ];
        const sid = String(idCandidates[0] ?? "");
        let ts: number | null = null;
        for (const c of idCandidates) {
          if (c == null) continue;
          const v = liveEtas?.[String(c)];
          if (typeof v === "number") { ts = v; break; }
        }
        const etaLabel =
          typeof ts === "number"
            ? new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
            : "No live ETA";

        let isPassed = false;
        if (ghosted) {
          const stopAlong = alongDistance(ghosted.chosen, [lng, lat]);
          isPassed = stopAlong < ghosted.vehicleAlong;
        }

        return (
          <CircleMarker
            key={`stop-${shapeKey}-${i}`}
            center={[lat, lng]}
            radius={isPassed ? 4 : 6}
            pathOptions={{
              color: isPassed ? "#6b7280" : activeColor,
              fillColor: "#0b0b15",
              fillOpacity: isPassed ? 0.4 : 1,
              weight: 2.5,
              opacity: isPassed ? 0.45 : 1,
            }}
          >
            <Popup>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  {isPassed ? "Passed stop" : "Upcoming stop"}
                </div>
                <div className="text-sm font-semibold">{name}</div>
                <div
                  className={`text-xs ${typeof ts === "number" ? "text-emerald-500 font-medium" : "opacity-70"}`}
                  suppressHydrationWarning
                >
                  Live ETA: {etaLabel}
                </div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      {displayedVehicles.map((v) => (
        <Marker
          key={v.id}
          position={[v.latitude, v.longitude]}
          icon={icons[v.vehicle_type]}
          zIndexOffset={activeVehicle?.id === v.id ? 1000 : 0}
          eventHandlers={{ click: () => onSelectVehicle(v) }}
        >
          <Popup>
            <div className="space-y-2 min-w-[180px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  {typeLabel[v.vehicle_type]}
                </span>
                <span className="text-xs font-mono opacity-60">#{v.id.split("-")[1]}</span>
              </div>
              <div className="text-base font-semibold">Route {v.route_id}</div>
              <div className="text-sm opacity-80">{v.direction}</div>
              <div
                className={`text-sm font-medium ${
                  v.delay_seconds > 60 ? "text-amber-500" : "text-emerald-500"
                }`}
              >
                {formatDelay(v.delay_seconds)}
              </div>
              {!isRouteViewActive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowRoute();
                  }}
                  className="mt-1 w-full rounded-md px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
                  style={{ backgroundColor: typeColor[v.vehicle_type] }}
                >
                  Show Route
                </button>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
