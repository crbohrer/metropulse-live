// Lightweight planar geometry helpers for splitting GeoJSON LineStrings.
// Coordinates are [lng, lat]. Euclidean approximations are fine at city scale.

export type LngLat = [number, number];

function distSq(a: LngLat, b: LngLat) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function projectOnSegment(p: LngLat, a: LngLat, b: LngLat) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point: LngLat = [a[0] + t * dx, a[1] + t * dy];
  return { t, point, distSq: distSq(p, point) };
}

export interface NearestResult {
  lineIndex: number;
  segIndex: number;
  t: number;
  point: LngLat;
  along: number; // distance along that line in coord units
  distSq: number;
}

export function nearestOnLines(lines: LngLat[][], p: LngLat): NearestResult | null {
  let best: NearestResult | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let acc = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const segLen = Math.sqrt(distSq(a, b));
      const proj = projectOnSegment(p, a, b);
      if (!best || proj.distSq < best.distSq) {
        best = {
          lineIndex: li,
          segIndex: i,
          t: proj.t,
          point: proj.point,
          distSq: proj.distSq,
          along: acc + proj.t * segLen,
        };
      }
      acc += segLen;
    }
  }
  return best;
}

export function splitLine(
  line: LngLat[],
  segIndex: number,
  point: LngLat
): { passed: LngLat[]; upcoming: LngLat[] } {
  const passed = [...line.slice(0, segIndex + 1), point];
  const upcoming = [point, ...line.slice(segIndex + 1)];
  return { passed, upcoming };
}

// Along-distance of an arbitrary point projected onto a line.
export function alongDistance(line: LngLat[], p: LngLat): number {
  let acc = 0;
  let bestAlong = 0;
  let bestDist = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = Math.sqrt(distSq(a, b));
    const proj = projectOnSegment(p, a, b);
    if (proj.distSq < bestDist) {
      bestDist = proj.distSq;
      bestAlong = acc + proj.t * segLen;
    }
    acc += segLen;
  }
  return bestAlong;
}
