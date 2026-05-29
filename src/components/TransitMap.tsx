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
    return getActiveRouteLines(routeShape, activeVehicle.direction, activeVehicle.vehicle_type);
  }, [isRouteViewActive, activeVehicle, routeShape]);

  const ghosted = useMemo(() => {
    if (!isRouteViewActive || !activeVehicle || routeLines.length === 0) return null;
    try {
      return buildGhostedRoute(routeLines, activeVehicle);
    } catch (err) {
      console.error("Turf.js failed to calculate route math. Bypassing.", err);
      return null; // Gracefully fall back to standard non-ghosted lines!
    }
  }, [isRouteViewActive, routeLines, activeVehicle]);

  // Strictly filtered stops for the active route/direction/service.
  const stops = useMemo<GeoJSONFeature[]>(() => {
    if (!isRouteViewActive) return [];
    const baseStops = filterRouteStops(routeStops, activeVehicle) as GeoJSONFeature[];

    const isRail = activeVehicle?.vehicle_type === "rail" || activeVehicle?.vehicle_type === "streetcar";
    const routeId = activeVehicle?.route_id?.toUpperCase();

    if (isRail && routeLines.length > 0) {
      return baseStops.filter((f) => {
        // 1. Hardcoded Route A & B textual filtering
        const stopDir = String(f.properties.Direction ?? f.properties.direction ?? "").toLowerCase();
        if (routeId === "A" && (stopDir.includes("north") || stopDir.includes("south"))) return false;
        if (routeId === "B" && (stopDir.includes("east") || stopDir.includes("west"))) return false;

        // 2. Spatial filtering (Keep stops within ~80m of the line)
        const coords = f.geometry?.coordinates as [number, number] | undefined;
        if (!coords || !Array.isArray(coords)) return false; // Safe bailout!
        const nearest = nearestOnLines(routeLines, coords);
        return nearest && nearest.distSq <= 0.0000006;
      });
    }

    return baseStops;
  }, [isRouteViewActive, routeStops, activeVehicle, routeLines]);
  const toLatLng = (coords?: LngLat[] | null): [number, number][] => {
    if (!coords || !Array.isArray(coords)) return [];
    return coords.map(([lng, lat]) => [lat, lng]);
  };

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

      {ghosted ? (
          <>
            {routeLines.map((line, i) => i === ghosted.lineIndex || !line || line.length === 0 ? null : (
              <Polyline key={`other-${shapeKey}-${i}`} positions={toLatLng(line)} pathOptions={{ color: activeColor, weight: 7, opacity: 1.0 }} />
            ))}
            
            {/* Only render these lines if Turf.js actually returned coordinates! */}
            {ghosted.passed && ghosted.passed.length > 0 && (
              <Polyline key={`passed-${shapeKey}`} positions={toLatLng(ghosted.passed)} pathOptions={{ color: activeColor, weight: 4, opacity: 0.3 }} />
            )}
            {ghosted.upcoming && ghosted.upcoming.length > 0 && (
              <Polyline key={`upcoming-${shapeKey}`} positions={toLatLng(ghosted.upcoming)} pathOptions={{ color: activeColor, weight: 7, opacity: 1.0 }} />
            )}
          </>
        ) : (
          <>
            {routeLines.map((line, i) => (
              <Polyline key={`other-${shapeKey}-${i}`} positions={toLatLng(line)} pathOptions={{ color: activeColor, weight: 7, opacity: 1.0 }} />
            ))}
          </>
        )}

      {stops.map((f, i) => {
          const coords = f.geometry?.coordinates as number[] | undefined;
          if (!coords || !Array.isArray(coords)) return null; // Safe bailout!
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
      
        // Check for bus IDs first, then fall back to the train IDs (StationId / NextRide / PlatformID)
       // 1. BRUTE FORCE ETA MATCH: Check every single property on this station
        let ts: number | null = null;
        for (const val of Object.values(f.properties || {})) {
          if (val === null || val === undefined) continue;
          const strVal = String(val).trim();
          
          if (strVal.length >= 3 && liveEtas?.[strVal] !== undefined) {
            ts = liveEtas[strVal];
            break;
          }
        }

        // 2. DEBUGGING PROBE: If we STILL can't find it, log it to the console!
        const isRail = activeVehicle?.vehicle_type === "rail" || activeVehicle?.vehicle_type === "streetcar";
        if (isRail && ts === null && liveEtas && Object.keys(liveEtas).length > 0) {
            console.log(`Missing ETA for ${name}. Database provided:`, f.properties);
        }

        const etaLabel =
          typeof ts === "number"
            ? new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
            : "No live ETA";

        let isPassed = false;
        // Added safety checks: Only calculate if 'chosen' and 'vehicleAlong' actually exist!
        if (ghosted && ghosted.chosen && ghosted.vehicleAlong !== undefined) {
          try {
            const stopAlong = alongDistance(ghosted.chosen, [lng, lat]);
            isPassed = stopAlong < ghosted.vehicleAlong;
          } catch (err) {
            // If Turf.js fails to calculate the distance, ignore it instead of crashing
            isPassed = false;
          }
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
