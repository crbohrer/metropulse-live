import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, CircleMarker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import type { Vehicle, VehicleType } from "@/lib/mock-transit";
import type { GeoJSON as RouteGeoJSON, GeoJSONFeature } from "@/lib/route-shapes.functions";
import { nearestOnLines } from "@/lib/geo-utils"; // Adjust path if necessary
import { alongDistance, buildGhostedRoute, filterRouteStops, getActiveRouteLines, type LngLat } from "@/lib/geo-utils";
import { RAIL_STATION_CODES } from "@/lib/transit.functions"; // <-- Add this new import!
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

 // 1. NORMALIZE LIGHT RAIL DIRECTIONS
        const rawRid = activeVehicle?.route_id.replace("Route", "").split("·")[0].split(" · ")[0].trim() || "";
        let normalizedDir = activeVehicle?.direction || "";
        const isRail = rawRid === "A" || rawRid === "B" || rawRid === "S" || activeVehicle?.vehicle_type?.toLowerCase() === "rail";

        const dLower = normalizedDir.toLowerCase();

        // 🚨 THE BOUNCER: Force Valley Metro's chaotic API strings into strict physical tracks!
        if (rawRid === "A") {
           // Route A is East/West. If the API says "North", force it West.
           normalizedDir = (dLower.includes("west") || dLower.includes("north")) ? "Westbound" : "Eastbound";
        } else if (rawRid === "B") {
           // Route B is North/South. If the API says "East" (Baseline), force it South!
           normalizedDir = (dLower.includes("south") || dLower.includes("east")) ? "Southbound" : "Northbound";
        }

        // 2. IDENTIFY REVERSED GEOMETRY
        // The raw map data draws Eastbound and Southbound tracks completely backwards (100 -> 0).
        const isLineReversed = (rawRid === "A" && normalizedDir === "Eastbound") || (rawRid === "B" && normalizedDir === "Southbound");
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
    // Now we just use our hoisted, perfectly clean normalizedDir!
    return getActiveRouteLines(routeShape, normalizedDir, activeVehicle.vehicle_type, rawRid);
  }, [isRouteViewActive, activeVehicle, routeShape, normalizedDir, rawRid]);

  const ghosted = useMemo(
    () => (isRouteViewActive ? buildGhostedRoute(routeLines, activeVehicle) : null),
    [isRouteViewActive, routeLines, activeVehicle]
  );

  // Strictly filtered stops for the active route/direction/service.
  const stops = useMemo<GeoJSONFeature[]>(() => {
    if (!isRouteViewActive) return [];
    const baseStops = filterRouteStops(routeStops, activeVehicle) as GeoJSONFeature[];

    // SPATIAL FILTER: only keep stops physically on the drawn route line.
          if (routeLines.length === 0) return baseStops;
          return baseStops.filter((f) => {
            const coords = f.geometry.coordinates as [number, number];
            const nearest = nearestOnLines(routeLines, coords);
            
            // THE FIX: Tighten the threshold here too so the map dots match the sidebar!
            const threshold = isRail ? 0.0000005 : 0.00000004;
            
            return nearest && nearest.distSq <= threshold;
          });
  }, [isRouteViewActive, routeStops, activeVehicle, routeLines]);

  const toLatLng = (coords: LngLat[]): [number, number][] =>
    coords.map(([lng, lat]) => [lat, lng]);

  // 1. EXTRACTED KILL SWITCH: Find exactly which stops are valid for this trip
  const processedStops = useMemo(() => {
    return stops.map((f) => {
      const name = (f.properties.stop_name as string) || (f.properties.StationName as string) || (f.properties.STATION as string) || (f.properties.Stop_Name as string) || (f.properties.StopName as string) || (f.properties.STOPNAME as string) || "Transit Stop";
      const idCandidates = [f.properties.stop_id, f.properties.stop_code, f.properties.StationId, f.properties.NextRide, f.properties.PlatformID];
      
      let ts: number | null = null;
      let validForDirection = true;

      // Bus ETA Matching
      for (const c of idCandidates) {
        if (c == null) continue;
        const cleanKey = String(c).trim();
        const match = liveEtas?.[cleanKey] ?? liveEtas?.[cleanKey.replace(/^0+/, '')] ?? liveEtas?.[Number(cleanKey)];
        if (typeof match === "number") {
          ts = match;
          break;
        }
      }

      // Rail Dictionary Lookup
      if (!ts && liveEtas && (rawRid === "A" || rawRid === "B" || rawRid === "S")) {
        const cleanName = name.replace(" Station", "").replace(" Stn", "").trim();
        const stationDict = RAIL_STATION_CODES[cleanName];

        if (stationDict) {
          const possibleCodes = Object.values(stationDict);
          let foundMatch = false;
          for (const code of possibleCodes) {
            if (code && typeof liveEtas[code] === "number") {
              ts = liveEtas[code];
              foundMatch = true;
              break;
            }
          }
          
          // THE FIX: Only strictly delete the stop if it's the Streetcar!
          // We want to keep Route A and Route B stops even if their ETA hasn't generated yet.
            if (!foundMatch && rawRid === "S") {
              validForDirection = false;
            }
          } else {
            // Kill the map circle for retired/closed stations across all lines
            validForDirection = false;
          }
        }

      return { feature: f, ts, validForDirection, name };
    }).filter(s => s.validForDirection); // Only keep the green lit stops!
  }, [stops, liveEtas, rawRid]);

  // 2. HELPER: The "Closest Stop Ownership" Fix (RESTRICTED TO STREETCAR)
  const isLineValid = (line: LngLat[]) => {
    if (processedStops.length === 0) return true;
    if (!line || line.length === 0) return false;

    // 1. TEMPE STREETCAR (Route S) gets the Voronoi math to handle its parallel loop!
    if (rawRid === "S") {
      const midIdx = Math.floor(line.length / 2);
      const pt = line[midIdx];
      const ptLng = Array.isArray(pt) ? pt[0] : (pt as any).lng ?? pt[0];
      const ptLat = Array.isArray(pt) ? pt[1] : (pt as any).lat ?? pt[1];

      if (typeof ptLng !== "number" || typeof ptLat !== "number") return true;

      let closestName = "";
      let minDistSq = Infinity;
      stops.forEach((f: any) => {
        const coords = f.geometry?.coordinates;
        if (!coords || typeof coords[0] !== "number") return;
        const distSq = Math.pow(coords[0] - ptLng, 2) + Math.pow(coords[1] - ptLat, 2);
        if (distSq < minDistSq) {
          minDistSq = distSq;
          closestName = f.properties?.stop_name || f.properties?.StationName || f.properties?.STATION || f.properties?.Stop_Name || f.properties?.StopName || f.properties?.STOPNAME || "Transit Stop";
        }
      });
      return processedStops.some((ps) => ps.name === closestName);
    }

    // 2. BUSES & LIGHT RAIL (Routes A & B) go back to the reliable search radius!
    // They don't have parallel overlapping tracks, so we don't want to shatter them.
    return processedStops.some(s => {
      const coords = s.feature.geometry.coordinates as [number, number];
      const nearest = nearestOnLines([line], coords);
      
      // THE FIX: Keep the track dimming threshold perfectly consistent with the stops!
      const threshold = isRail ? 0.0000005 : 0.00000004;
      
      return nearest && nearest.distSq <= threshold;
    });
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
      <FlyToStop stop={focusedStop} />

      {ghosted ? (
          <>
            {routeLines.map((line, i) => {
              if (i === ghosted.lineIndex) return null;

              // 1. Grab the physical midpoint of this specific track segment
              const midIdx = Math.floor(line.length / 2);
              const pt = line[midIdx];
              const ptLng = Array.isArray(pt) ? pt[0] : (pt as any).lng ?? pt[0];
              const ptLat = Array.isArray(pt) ? pt[1] : (pt as any).lat ?? pt[1];

              // 2. THE FIX: Stop relying on messy array indices! 
              // Calculate the exact physical distance of this track segment.
              const segmentAlong = alongDistance(ghosted.chosen, [ptLng, ptLat]);
              const isPassedSegment = isLineReversed 
                ? segmentAlong > ghosted.vehicleAlong 
                : segmentAlong < ghosted.vehicleAlong;
              
              const isValid = isLineValid(line);

              return (
                <Polyline
                  key={`other-${shapeKey}-${i}`}
                  positions={toLatLng(line)}
                  pathOptions={{
                    color: activeColor,
                    // Dim the thickness and opacity if the track is dead
                    weight: isValid ? (isPassedSegment ? 4 : 7) : 3,
                    opacity: isValid ? (isPassedSegment ? 0.3 : 1.0) : 0.15,
                  }}
                />
              );
            })}
            <Polyline
              key={`passed-${shapeKey}`}
              positions={toLatLng(isLineReversed ? ghosted.upcoming : ghosted.passed)}
              pathOptions={{ color: activeColor, weight: 4, opacity: 0.3 }}
            />
            <Polyline
              key={`upcoming-${shapeKey}`}
              positions={toLatLng(isLineReversed ? ghosted.passed : ghosted.upcoming)}
              pathOptions={{ color: activeColor, weight: 7, opacity: 1.0 }}
            />
          </>
        ) : (
          <>
            {routeLines.map((line, i) => {
              const isValid = isLineValid(line);
              return (
                <Polyline
                  key={`solid-${shapeKey}-${i}`}
                  positions={toLatLng(line)}
                  pathOptions={{ 
                    color: activeColor, 
                    weight: isValid ? 7 : 3, 
                    opacity: isValid ? 1.0 : 0.15 
                  }}
                />
              );
            })}
          </>
        )}

        {/* 3. CLEAN RENDER: Iterate over our pre-processed valid stops! */}
        {processedStops.map((s, i) => {
          const coords = s.feature.geometry.coordinates as number[];
          const [lng, lat] = coords;
          if (typeof lat !== "number" || typeof lng !== "number") return null;

          let isPassed = false;
          let etaLabel = "No live ETA";
          let isTimePassed = false;

          // 1. Calculate GPS distance
          if (ghosted) {
            const stopAlong = alongDistance(ghosted.chosen, [lng, lat]);
            isPassed = isLineReversed ? stopAlong > ghosted.vehicleAlong : stopAlong < ghosted.vehicleAlong;
          }

          // 2. The Future ETA Override & Stale Purge
          if (typeof s.ts === "number") {
            const timeUntilMs = (s.ts * 1000) - Date.now();
            
            if (timeUntilMs > 0) {
               // Absolute veto: keep the map circle bright orange!
               isPassed = false; 
            } else if (timeUntilMs < -180000) { 
               // Stale API Purge
               isPassed = true;
            }

            const dateObj = new Date(s.ts * 1000);
            etaLabel = dateObj.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            
            // Sync text label permanently to the final physical state
            isTimePassed = isPassed; 
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
                  <div className="text-sm font-semibold">{s.name}</div>
                  <div className={`text-xs ${typeof s.ts === "number" ? (isTimePassed ? "text-amber-500 font-medium" : "text-emerald-500 font-medium") : "opacity-70"}`} suppressHydrationWarning>
                    {isTimePassed ? `Passed at: ${etaLabel}` : `Live ETA: ${etaLabel}`}
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
              {/* Stop displaying the confusing compass bearing for active vehicles! */}
              <div className="text-sm opacity-80">
                {v.id === activeVehicle?.id ? normalizedDir : v.direction}
              </div>
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
