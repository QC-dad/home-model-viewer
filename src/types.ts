export type Vec3Tuple = [number, number, number];
export type Bounds = [number, number, number, number];

export interface FloorSpec {
  id: string;
  name: string;
  elevation: number;
  height: number;
  bounds: Bounds;
  polygon?: [number, number][];
  asset: string;
  ceilingAsset?: string | null;
}

export interface RoomCamera {
  position: Vec3Tuple;
  target: Vec3Tuple;
  fov?: number;
}

export interface RoomSpec {
  id: string;
  name: string;
  floorId: string;
  bounds: Bounds;
  camera: RoomCamera;
  reference?: string | null;
  materialStatus?: string;
}

export interface VariantSpec {
  id: string;
  category: string;
  name: string;
  asset: string;
  size: Vec3Tuple;
  footprint?: 'rect' | 'rectangle' | 'ellipse' | null;
}

export interface FurnitureSpec {
  id: string;
  roomId: string;
  floorId: string;
  category: string;
  variantId: string;
  position: Vec3Tuple;
  rotation: number;
  name?: string;
}

export interface MaterialSpec {
  roomId: string;
  status: string;
  reference?: string | null;
  wall: string;
  floor: string;
  wood: string;
  fabric: string;
  metal: string;
  notes?: string;
}

export interface OverviewCamera {
  position: Vec3Tuple;
  target: Vec3Tuple;
}

export interface Manifest {
  schemaVersion: 1;
  modelId: string;
  modelVersion: string;
  name: string;
  floors: FloorSpec[];
  environment?: string | null;
  exterior?: string | null;
  rooms: RoomSpec[];
  variants: VariantSpec[];
  furniture: FurnitureSpec[];
  overview: OverviewCamera;
  materials?: MaterialSpec[];
  info?: string[];
}

export interface LayoutItem {
  id: string;
  variantId: string;
  position: Vec3Tuple;
  rotation: number;
}

export interface Layout {
  schemaVersion: 1;
  modelId: string;
  modelVersion: string;
  savedAt: string;
  furniture: LayoutItem[];
}

export interface BundleFile {
  path: string;
  data: ArrayBuffer;
}

export interface ModelBundle {
  manifest: Manifest;
  files: Record<string, ArrayBuffer>;
  importedAt: string;
}

export type ViewMode = 'whole' | string;
export type RenderMode = 'material' | 'white' | 'section';

export interface FurnitureState {
  id: string;
  name?: string;
  roomId: string;
  floorId: string;
  category: string;
  variantId: string;
  position: Vec3Tuple;
  rotation: number;
}

export interface PlacementIssue {
  kind: 'outside' | 'overlap';
  id: string;
  otherId?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function cloneLayout(layout: Layout): Layout {
  return JSON.parse(JSON.stringify(layout)) as Layout;
}

export function manifestToLayout(manifest: Manifest, savedAt = new Date().toISOString()): Layout {
  return {
    schemaVersion: 1,
    modelId: manifest.modelId,
    modelVersion: manifest.modelVersion,
    savedAt,
    furniture: manifest.furniture.map((item) => ({
      id: item.id,
      variantId: item.variantId,
      position: [...item.position] as Vec3Tuple,
      rotation: item.rotation,
    })),
  };
}
