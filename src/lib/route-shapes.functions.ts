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

    let shapeUrl = "";
    if (isRail) {
      // 1. ID TRANSLATOR: Translate Light Rail to "0" for the database
      let queryId = routeId;
      if (routeId === "A" || routeId === "B") queryId = "0";
      else if (routeId === "S") queryId = "S";

      // 2. STOP THE DATA FLOOD: Fetch ONLY the single track line we need!
      const shapeWhere = `ROUTE='${queryId}'`;
      shapeUrl = `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/ValleyMetroRail/FeatureServer/0/query?where=${encodeURIComponent(shapeWhere)}&outFields=*&f=geojson`;
    } else {
      // Buses use the bus database
      const shapeWhere = `route_id='${routeId}'`;
      shapeUrl = `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/ValleyMetroBusRoutes/FeatureServer/0/query?where=${encodeURIComponent(shapeWhere)}&outFields=*&f=geojson`;
    }

    let stopsUrl =
      `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/BusStopsWAmenities/FeatureServer/0/query` +
      `?where=${encodeURIComponent(`Routes LIKE '%${routeId}%'`)}&outFields=*&f=geojson`;

    if (isRail) {
      // Rail stations are just single coordinate points, so downloading all ~40 of them 
      // with 1=1 is perfectly safe, lightning fast, and won't crash your browser!
      stopsUrl = `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/ValleyMetroRailStations/FeatureServer/0/query?where=1=1&outFields=*&f=geojson`;
    }

    const [shape, stops] = await Promise.all([
      fetchGeoJSON(shapeUrl),
      fetchGeoJSON(stopsUrl),
    ]);

    return { shape, stops, routeId };
  });
