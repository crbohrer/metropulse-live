import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, CircleMarker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import type { Vehicle, VehicleType } from "@/lib/mock-transit";
import type { GeoJSON as RouteGeoJSON } from "@/lib/route-shapes.functions";
import { nearestOnLines, splitLine, alongDistance, type LngLat } from "@/lib/geo-utils";

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
  rail: "oklch(0.65 0.22 300)",
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

export function TransitMap({ vehicles, activeVehicle, routeShape, routeStops, isRouteViewActive, liveEtas, onClearSelection, onSelectVehicle, onShowRoute }: Props) {
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

  // Force layers to remount when route changes
  const shapeKey = activeVehicle?.route_id ?? "none";

  // Extract all LineString rings from the route shape.
  const routeLines = useMemo<LngLat[][]>(() => {
    if (!routeShape) return [];
    const lines: LngLat[][] = [];
    for (const f of routeShape.features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "LineString") {
        lines.push(g.coordinates as LngLat[]);
      } else if (g.type === "MultiLineString") {
        for (const part of g.coordinates as unknown as LngLat[][]) {
          lines.push(part);
        }
      }
    }
    return lines;
  }, [routeShape]);

  // Find nearest point on any line to the active vehicle, then split that line.
  const ghosted = useMemo(() => {
    if (!activeVehicle || routeLines.length === 0) return null;
    const p: LngLat = [activeVehicle.longitude, activeVehicle.latitude];
    const nearest = nearestOnLines(routeLines, p);
    if (!nearest) return null;
    const chosen = routeLines[nearest.lineIndex];
    const { passed: upcoming, upcoming: passed } = splitLine(chosen, nearest.segIndex, nearest.point);
    return { passed, upcoming, chosen, vehicleAlong: nearest.along, lineIndex: nearest.lineIndex };
  }, [activeVehicle, routeLines]);

  // Convert [lng,lat] → [lat,lng] for Leaflet Polyline.
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

      {ghosted ? (
        <>
          {/* Other lines (e.g. opposite direction loops) — render as upcoming */}
          {routeLines.map((line, i) =>
            i === ghosted.lineIndex ? null : (
              <Polyline
                key={`other-${shapeKey}-${i}`}
                positions={toLatLng(line)}
                pathOptions={{ color: activeColor, weight: 6, opacity: 0.85 }}
              />
            )
          )}
          <Polyline
            key={`passed-${shapeKey}`}
            positions={toLatLng(ghosted.passed)}
            pathOptions={{ color: "#6b7280", weight: 4, opacity: 0.4 }}
          />
          <Polyline
            key={`upcoming-${shapeKey}`}
            positions={toLatLng(ghosted.upcoming)}
            pathOptions={{ color: activeColor, weight: 7, opacity: 1.0 }}
          />
        </>
      ) : (
        routeLines.map((line, i) => (
          <Polyline
            key={`shape-${shapeKey}-${i}`}
            positions={toLatLng(line)}
            pathOptions={{ color: activeColor, weight: 6, opacity: 0.85 }}
          />
        ))
      )}

      {routeStops?.features.map((f, i) => {
        if (f.geometry.type !== "Point") return null;

        // 1. DIRECTION FILTER: 
        // Only show this stop if its direction matches the vehicle we clicked
        const stopDir = f.properties.Direction as string;
        if (activeVehicle?.direction && stopDir && stopDir.trim() !== "") {
           if (stopDir.toLowerCase() !== activeVehicle.direction.toLowerCase()) {
               return null; // Skip drawing this stop!
           }
        }

        const coords = f.geometry.coordinates as number[];
        const [lng, lat] = coords;
        if (typeof lat !== "number" || typeof lng !== "number") return null;
        
        // 2. STOP NAME FIX: 
        // Add "stop_name" (lowercase) to the front of the line
        const name =
          (f.properties.stop_name as string) || 
          (f.properties.Stop_Name as string) ||
          (f.properties.StopName as string) ||
          (f.properties.STOPNAME as string) ||
          "Bus stop";

        const internalStopId = String(f.properties.stop_id);
        const publicStopCode = String(f.properties.stop_code);
        const etaTs = liveEtas?.[internalStopId] || liveEtas?.[publicStopCode];

        // Mute stops that the vehicle has already passed on the chosen line.
        let isPassed = false;
        if (ghosted) {
          const stopAlong = alongDistance(ghosted.chosen, [lng, lat]);
          isPassed = stopAlong < ghosted.vehicleAlong;
        }

        return (
          <CircleMarker
            key={`stop-${shapeKey}-${i}`}
            center={[lat, lng]}
            radius={isPassed ? 3 : 4}
            pathOptions={{
              color: isPassed ? "#9ca3af" : activeColor,
              fillColor: "#0b0b15",
              fillOpacity: isPassed ? 0.35 : 1,
              weight: 2,
              opacity: isPassed ? 0.4 : 1,
            }}
          >
            <Popup>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  {isPassed ? "Passed stop" : "Stop"}
                </div>
                <div className="text-sm font-semibold">{name}</div>
                <div className="text-xs opacity-70" suppressHydrationWarning>
                  {etaTs
                    ? `Arrival: ${new Date(etaTs * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : "No live ETA available"}
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
