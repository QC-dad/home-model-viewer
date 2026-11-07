import type { Bounds, FurnitureState, Layout, LayoutItem, Manifest, PlacementIssue, Vec3Tuple } from './types';

export interface Footprint {
  width: number;
  depth: number;
}

export interface Aabb {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const EPSILON = 1e-6;

type PolygonPoint = [number, number];

function pointInPolygon(point: PolygonPoint, polygon: PolygonPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function orientation(a: PolygonPoint, b: PolygonPoint, c: PolygonPoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: PolygonPoint, b: PolygonPoint, p: PolygonPoint): boolean {
  return Math.min(a[0], b[0]) - EPSILON <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPSILON && Math.min(a[1], b[1]) - EPSILON <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function segmentsIntersect(a: PolygonPoint, b: PolygonPoint, c: PolygonPoint, d: PolygonPoint): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if ((o1 > EPSILON && o2 < -EPSILON || o1 < -EPSILON && o2 > EPSILON) && (o3 > EPSILON && o4 < -EPSILON || o3 < -EPSILON && o4 > EPSILON)) return true;
  return Math.abs(o1) <= EPSILON && onSegment(a, b, c) || Math.abs(o2) <= EPSILON && onSegment(a, b, d) || Math.abs(o3) <= EPSILON && onSegment(c, d, a) || Math.abs(o4) <= EPSILON && onSegment(c, d, b);
}

function rotatedCorners(position: Vec3Tuple, size: Vec3Tuple, rotation: number): PolygonPoint[] {
  const halfW = Math.abs(size[0]) / 2;
  const halfD = Math.abs(size[2]) / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return [[-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]].map(([x, z]) => [position[0] + x * cos - z * sin, position[2] + x * sin + z * cos]);
}

export function rotatedFootprint(size: Vec3Tuple, rotation: number): Footprint {
  const halfW = Math.abs(size[0]) / 2;
  const halfD = Math.abs(size[2]) / 2;
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  return { width: 2 * (halfW * c + halfD * s), depth: 2 * (halfW * s + halfD * c) };
}

export function rotatedAabb(position: Vec3Tuple, size: Vec3Tuple, rotation: number): Aabb {
  const footprint = rotatedFootprint(size, rotation);
  return {
    minX: position[0] - footprint.width / 2,
    maxX: position[0] + footprint.width / 2,
    minZ: position[2] - footprint.depth / 2,
    maxZ: position[2] + footprint.depth / 2,
  };
}

export function aabbInsideBounds(aabb: Aabb, bounds: Bounds, epsilon = EPSILON): boolean {
  return (
    aabb.minX >= bounds[0] - epsilon &&
    aabb.minZ >= bounds[1] - epsilon &&
    aabb.maxX <= bounds[2] + epsilon &&
    aabb.maxZ <= bounds[3] + epsilon
  );
}

export function placementInsideFloor(position: Vec3Tuple, size: Vec3Tuple, rotation: number, bounds: Bounds, polygon?: PolygonPoint[]): boolean {
  if (!aabbInsideBounds(rotatedAabb(position, size, rotation), bounds)) return false;
  if (!polygon || polygon.length < 3) return true;
  const corners = rotatedCorners(position, size, rotation);
  if (!corners.every((corner) => pointInPolygon(corner, polygon))) return false;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let j = 0; j < polygon.length; j += 1) {
      const c = polygon[j];
      const d = polygon[(j + 1) % polygon.length];
      if (segmentsIntersect(a, b, c, d) && !onSegment(a, b, c) && !onSegment(a, b, d)) return false;
    }
  }
  return pointInPolygon([position[0], position[2]], polygon);
}

export function aabbOverlaps(a: Aabb, b: Aabb, epsilon = EPSILON): boolean {
  return a.minX < b.maxX - epsilon && a.maxX > b.minX + epsilon && a.minZ < b.maxZ - epsilon && a.maxZ > b.minZ + epsilon;
}

interface VariantFootprint {
  size: Vec3Tuple;
  footprint?: 'rect' | 'rectangle' | 'ellipse' | null;
}

interface OrientedBox {
  center: PolygonPoint;
  axes: [PolygonPoint, PolygonPoint];
  half: [number, number];
}

type VariantLookup = Vec3Tuple | VariantFootprint;

function variantParts(value: VariantLookup): VariantFootprint {
  return Array.isArray(value) ? { size: value } : value;
}

function orientedBox(position: Vec3Tuple, size: Vec3Tuple, rotation: number): OrientedBox {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return { center: [position[0], position[2]], axes: [[cos, sin], [-sin, cos]], half: [Math.abs(size[0]) / 2, Math.abs(size[2]) / 2] };
}

function dot(a: PolygonPoint, b: PolygonPoint): number {
  return a[0] * b[0] + a[1] * b[1];
}

function obbOverlaps(a: OrientedBox, b: OrientedBox): boolean {
  const axes = [...a.axes, ...b.axes];
  const delta: PolygonPoint = [b.center[0] - a.center[0], b.center[1] - a.center[1]];
  return !axes.some((axis) => {
    const distance = Math.abs(dot(delta, axis));
    const radiusA = a.half[0] * Math.abs(dot(a.axes[0], axis)) + a.half[1] * Math.abs(dot(a.axes[1], axis));
    const radiusB = b.half[0] * Math.abs(dot(b.axes[0], axis)) + b.half[1] * Math.abs(dot(b.axes[1], axis));
    return distance >= radiusA + radiusB - EPSILON;
  });
}

function circleObbOverlaps(center: PolygonPoint, radius: number, box: OrientedBox): boolean {
  const delta: PolygonPoint = [center[0] - box.center[0], center[1] - box.center[1]];
  const local: PolygonPoint = [dot(delta, box.axes[0]), dot(delta, box.axes[1])];
  const closest: PolygonPoint = [Math.max(-box.half[0], Math.min(box.half[0], local[0])), Math.max(-box.half[1], Math.min(box.half[1], local[1]))];
  const dx = local[0] - closest[0];
  const dz = local[1] - closest[1];
  return dx * dx + dz * dz < radius * radius - EPSILON;
}

function footprintsOverlap(a: FurnitureState, aVariant: VariantFootprint, b: FurnitureState, bVariant: VariantFootprint): boolean {
  const aEllipse = aVariant.footprint === 'ellipse';
  const bEllipse = bVariant.footprint === 'ellipse';
  if (!aEllipse && !bEllipse) return obbOverlaps(orientedBox(a.position, aVariant.size, a.rotation), orientedBox(b.position, bVariant.size, b.rotation));
  const aRadius = Math.max(Math.abs(aVariant.size[0]), Math.abs(aVariant.size[2])) / 2;
  const bRadius = Math.max(Math.abs(bVariant.size[0]), Math.abs(bVariant.size[2])) / 2;
  if (aEllipse && bEllipse) {
    const dx = a.position[0] - b.position[0];
    const dz = a.position[2] - b.position[2];
    return dx * dx + dz * dz < (aRadius + bRadius) * (aRadius + bRadius) - EPSILON;
  }
  if (aEllipse) return circleObbOverlaps([a.position[0], a.position[2]], aRadius, orientedBox(b.position, bVariant.size, b.rotation));
  return circleObbOverlaps([b.position[0], b.position[2]], bRadius, orientedBox(a.position, aVariant.size, a.rotation));
}

export function detectOverlaps(items: FurnitureState[], variantsById: Map<string, VariantLookup>): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const current = items[i];
    const currentVariantRaw = variantsById.get(current.variantId);
    if (!currentVariantRaw) continue;
    const currentVariant = variantParts(currentVariantRaw);
    for (let j = i + 1; j < items.length; j += 1) {
      const other = items[j];
      if (current.floorId !== other.floorId) continue;
      const otherVariantRaw = variantsById.get(other.variantId);
      if (!otherVariantRaw) continue;
      const otherVariant = variantParts(otherVariantRaw);
      if (footprintsOverlap(current, currentVariant, other, otherVariant)) {
        issues.push({
          kind: 'overlap',
          id: current.id,
          otherId: other.id,
          message: `${current.name ?? current.id} 与 ${other.name ?? other.id} 的占地范围重叠`,
        });
      }
    }
  }
  return issues;
}

export function detectBoundaryIssues(items: FurnitureState[], manifest: Manifest): PlacementIssue[] {
  const floors = new Map(manifest.floors.map((floor) => [floor.id, floor]));
  const variants = new Map(manifest.variants.map((variant) => [variant.id, variant]));
  return items.flatMap((item) => {
    const floor = floors.get(item.floorId);
    const variant = variants.get(item.variantId);
    if (!floor || !variant || (Math.abs(item.position[1] - floor.elevation) <= 1e-4 && placementInsideFloor(item.position, variant.size, item.rotation, floor.bounds, floor.polygon))) return [];
    return [{ kind: 'outside' as const, id: item.id, message: `${item.name ?? item.id} 超出 ${floor.name} 的边界` }];
  });
}

export function layoutIssues(items: FurnitureState[], manifest: Manifest): PlacementIssue[] {
  const variants = new Map(manifest.variants.map((variant) => [variant.id, variant]));
  return [...detectBoundaryIssues(items, manifest), ...detectOverlaps(items, variants)];
}

export function layoutToState(layout: Layout, manifest: Manifest): FurnitureState[] {
  const original = new Map(manifest.furniture.map((item) => [item.id, item]));
  return layout.furniture.map((item) => {
    const seed = original.get(item.id);
    return {
      id: item.id,
      name: seed?.name,
      roomId: seed?.roomId ?? '',
      floorId: seed?.floorId ?? '',
      category: seed?.category ?? '',
      variantId: item.variantId,
      position: [...item.position] as Vec3Tuple,
      rotation: item.rotation,
    };
  });
}

export function stateToLayout(items: FurnitureState[], manifest: Manifest, savedAt = new Date().toISOString()): Layout {
  return {
    schemaVersion: 1,
    modelId: manifest.modelId,
    modelVersion: manifest.modelVersion,
    savedAt,
    furniture: items.map((item): LayoutItem => ({
      id: item.id,
      variantId: item.variantId,
      position: [...item.position] as Vec3Tuple,
      rotation: item.rotation,
    })),
  };
}

export function updateItem(items: FurnitureState[], id: string, patch: Partial<Pick<FurnitureState, 'position' | 'rotation' | 'variantId'>>): FurnitureState[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch, position: patch.position ? [...patch.position] as Vec3Tuple : item.position } : item));
}

export function snapshotsEqual(a: FurnitureState[], b: FurnitureState[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
