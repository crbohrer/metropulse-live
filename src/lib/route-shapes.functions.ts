import { createServerFn } from "@tanstack/react-start";

// Strip any "label" suffix like "72 · 1234" → "72"
function cleanRouteId(raw: string): string {
  return raw.split("·")[0].trim();
}

export interface GeoJSONFeature {
  type: string;
  geometry: { type: string; coordinates: number[] | number[][] | number[][][] };
  properties: Record<string, string | number | boolean | null>;
}
export interface GeoJSON {
  type: string;
  features: GeoJSONFeature[];
}

async function fetchGeoJSON(url: string): Promise<GeoJSON | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as GeoJSON;
    if (!data?.features) return null;
    return data;
  } catch {
    return null;
  }
}

export const getRouteGeometry = createServerFn({ method: "GET" })
  .inputValidator((data: { routeId: string }) => data)
  .handler(async ({ data }) => {
    const routeId = cleanRouteId(data.routeId);
    if (!routeId || routeId === "—") {
      return { shape: null, stops: null, routeId };
    }

    // Rail/Streetcar vehicles use route_ids ("A","B","S") that don't match
    // the shape DB (rail is stored under route_id='0'). Fetch the whole layer
    // for rail/streetcar and let the client filter by Direction + ServiceType.
    const isRail = ["A", "B", "S"].includes(routeId);
        
        // TRANSLATE THE ID: Map real-time IDs to the official ArcGIS shape IDs
        let queryId = routeId;
        if (routeId === "A" || routeId === "B") {
            queryId = "0"; // Force Light Rail to fetch route "0"
        } 
        // (Streetcar will stay "S". If its shape is missing later, we can update this.)

        // NO MORE 1=1! Fetch only the specific translated route shape
        const shapeWhere = `route_id='${queryId}'`;
        
        const shapeUrl = `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/ValleyMetroBusRoutes/FeatureServer/0/query` +
          `?where=${encodeURIComponent(shapeWhere)}&outFields=*&f=geojson`;

    let stopsUrl =
      `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/BusStopsWAmenities/FeatureServer/0/query` +
      `?where=${encodeURIComponent(`Routes LIKE '%${routeId}%'`)}&outFields=*&f=geojson`;

    if (isRail) {
      stopsUrl = `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/ValleyMetroRailStations/FeatureServer/0/query?where=1=1&outFields=*&f=geojson`;
    }

    const [shape, stops] = await Promise.all([
      fetchGeoJSON(shapeUrl),
      fetchGeoJSON(stopsUrl),
    ]);

    return { shape, stops, routeId };
  });
