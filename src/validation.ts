import { unzipSync, strFromU8 } from 'fflate';
import type { Bounds, Layout, Manifest, ModelBundle, ValidationResult, Vec3Tuple } from './types';
import { layoutIssues, placementInsideFloor } from './layout';

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]; // glTF

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTuple3(value: unknown): value is Vec3Tuple {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

function isBounds(value: unknown): value is Bounds {
  return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber) && value[0] < value[2] && value[1] < value[3];
}

function safeRelativePath(value: unknown): value is string {
  if (!isString(value)) return false;
  return !value.startsWith('/') && !value.includes('\\') && !value.includes('..') && !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function inspectGlb(data: ArrayBuffer | undefined): { ok: boolean; reason?: string } {
  if (!data || data.byteLength < 20) return { ok: false, reason: '文件过短' };
  const bytes = new Uint8Array(data);
  if (!GLB_MAGIC.every((byte, index) => bytes[index] === byte)) return { ok: false, reason: '缺少 glTF 魔数' };
  const view = new DataView(data);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);
  if (version !== 2 || totalLength > bytes.byteLength || totalLength < 20) return { ok: false, reason: 'GLB 头部无效' };
  let offset = 12;
  let json: Record<string, unknown> | undefined;
  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (chunkLength > totalLength - offset) return { ok: false, reason: 'GLB chunk 越界' };
    if (chunkType === 0x4e4f534a) {
      try {
        const text = new TextDecoder().decode(bytes.subarray(offset, offset + chunkLength)).replace(/[\u0000\u0020]+$/g, '');
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: 'GLB JSON chunk 无效' };
      }
    }
    offset += chunkLength;
  }
  if (!json) return { ok: false, reason: 'GLB 缺少 JSON chunk' };
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  const images = Array.isArray(json.images) ? json.images : [];
  const externalUris = [...buffers, ...images].flatMap((entry) => isObject(entry) && typeof entry.uri === 'string' && !entry.uri.startsWith('data:') ? [entry.uri] : []);
  if (externalUris.length) return { ok: false, reason: `包含外部 URI：${externalUris[0]}` };
  const unsupported = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];
  const extensions = [...(Array.isArray(json.extensionsUsed) ? json.extensionsUsed : []), ...(Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [])];
  const decoderExtension = extensions.find((extension) => typeof extension === 'string' && unsupported.includes(extension));
  if (decoderExtension) return { ok: false, reason: `需要未内置解码器：${decoderExtension}` };
  return { ok: true };
}

function push(errorList: string[], condition: boolean, message: string): void {
  if (!condition) errorList.push(message);
}

function uniqueIds<T extends { id: string }>(items: T[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) errors.push(`${label}[${index}] 的 id 重复：${item.id}`);
    seen.add(item.id);
  });
}

function validateCamera(value: unknown, label: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${label} 缺少相机配置`);
    return;
  }
  push(errors, isTuple3(value.position), `${label}.position 必须是 3 个有限数字`);
  push(errors, isTuple3(value.target), `${label}.target 必须是 3 个有限数字`);
  if (value.fov !== undefined) push(errors, isFiniteNumber(value.fov) && value.fov > 1 && value.fov < 180, `${label}.fov 无效`);
}

export function validateManifest(value: unknown, files: Record<string, ArrayBuffer>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['manifest.json 必须是 JSON 对象'], warnings };
  push(errors, value.schemaVersion === 1, 'schemaVersion 必须为 1');
  push(errors, isString(value.modelId), 'modelId 必填');
  push(errors, isString(value.modelVersion), 'modelVersion 必填');
  push(errors, isString(value.name), 'name 必填');
  push(errors, Array.isArray(value.floors) && value.floors.length > 0, '至少需要一个楼层');
  push(errors, Array.isArray(value.rooms), 'rooms 必须是数组');
  push(errors, Array.isArray(value.variants), 'variants 必须是数组');
  push(errors, Array.isArray(value.furniture), 'furniture 必须是数组');
  if (!isObject(value.overview)) errors.push('overview 缺失');
  else validateCamera(value.overview, 'overview', errors);
  if (value.sharedMaterialNames !== undefined && value.sharedMaterialNames !== null) push(errors, Array.isArray(value.sharedMaterialNames) && value.sharedMaterialNames.every(isString), 'sharedMaterialNames 必须是字符串数组');
  if (errors.length > 0) return { ok: false, errors, warnings };

  const manifest = value as unknown as Manifest;
  uniqueIds(manifest.floors, 'floors', errors);
  uniqueIds(manifest.rooms, 'rooms', errors);
  uniqueIds(manifest.variants, 'variants', errors);
  uniqueIds(manifest.furniture, 'furniture', errors);
  const floorIds = new Set(manifest.floors.map((floor) => floor.id));
  const roomIds = new Set(manifest.rooms.map((room) => room.id));
  const variantIds = new Set(manifest.variants.map((variant) => variant.id));
  const roomById = new Map(manifest.rooms.map((room) => [room.id, room]));
  const floorById = new Map(manifest.floors.map((floor) => [floor.id, floor]));
  const variantById = new Map(manifest.variants.map((variant) => [variant.id, variant]));

  manifest.floors.forEach((floor, index) => {
    const label = `floors[${index}]`;
    push(errors, isString(floor.id), `${label}.id 必填`);
    push(errors, isString(floor.name), `${label}.name 必填`);
    push(errors, isFiniteNumber(floor.elevation), `${label}.elevation 无效`);
    push(errors, isFiniteNumber(floor.height) && floor.height > 0, `${label}.height 无效`);
    push(errors, isBounds(floor.bounds), `${label}.bounds 无效`);
    push(errors, safeRelativePath(floor.asset), `${label}.asset 必须是相对路径`);
    if (safeRelativePath(floor.asset)) {
      push(errors, Boolean(files[floor.asset]), `${label}.asset 不在 ZIP 中：${floor.asset}`);
      const glb = inspectGlb(files[floor.asset]);
      push(errors, glb.ok, `${label}.asset 不是可离线加载的 GLB：${floor.asset}${glb.reason ? `（${glb.reason}）` : ''}`);
    }
    if (floor.ceilingAsset !== undefined && floor.ceilingAsset !== null) {
      push(errors, safeRelativePath(floor.ceilingAsset), `${label}.ceilingAsset 必须是相对路径`);
      if (safeRelativePath(floor.ceilingAsset)) {
        push(errors, Boolean(files[floor.ceilingAsset]), `${label}.ceilingAsset 不在 ZIP 中：${floor.ceilingAsset}`);
        const glb = inspectGlb(files[floor.ceilingAsset]);
        push(errors, glb.ok, `${label}.ceilingAsset 不是可离线加载的 GLB：${floor.ceilingAsset}${glb.reason ? `（${glb.reason}）` : ''}`);
      }
    }
    if (floor.polygon !== undefined) {
      push(errors, Array.isArray(floor.polygon) && floor.polygon.length >= 3 && floor.polygon.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every(isFiniteNumber)), `${label}.polygon 无效`);
    }
  });

  [manifest.environment, manifest.exterior].forEach((path, index) => {
    if (path === undefined || path === null) return;
    const label = index === 0 ? 'environment' : 'exterior';
    push(errors, safeRelativePath(path), `${label} 必须是相对路径`);
    if (safeRelativePath(path)) {
      push(errors, Boolean(files[path]), `${label} 不在 ZIP 中：${path}`);
      const glb = inspectGlb(files[path]);
      push(errors, glb.ok, `${label} 不是可离线加载的 GLB：${path}${glb.reason ? `（${glb.reason}）` : ''}`);
    }
  });

  manifest.rooms.forEach((room, index) => {
    const label = `rooms[${index}]`;
    push(errors, isString(room.id), `${label}.id 必填`);
    push(errors, isString(room.name), `${label}.name 必填`);
    push(errors, floorIds.has(room.floorId), `${label}.floorId 不存在：${room.floorId}`);
    push(errors, isBounds(room.bounds), `${label}.bounds 无效`);
    validateCamera(room.camera, `${label}.camera`, errors);
    if (room.reference !== undefined && room.reference !== null) {
      push(errors, safeRelativePath(room.reference), `${label}.reference 必须是相对路径`);
      if (safeRelativePath(room.reference)) push(errors, Boolean(files[room.reference]), `${label}.reference 不在 ZIP 中：${room.reference}`);
    }
  });

  manifest.variants.forEach((variant, index) => {
    const label = `variants[${index}]`;
    push(errors, isString(variant.id), `${label}.id 必填`);
    push(errors, isString(variant.category), `${label}.category 必填`);
    push(errors, isString(variant.name), `${label}.name 必填`);
    push(errors, safeRelativePath(variant.asset), `${label}.asset 必须是相对路径`);
    push(errors, isTuple3(variant.size) && variant.size.every((part) => part > 0), `${label}.size 必须为正数`);
    if (variant.footprint !== undefined && variant.footprint !== null) push(errors, variant.footprint === 'rect' || variant.footprint === 'rectangle' || variant.footprint === 'ellipse', `${label}.footprint 必须是 rect、rectangle 或 ellipse`);
    if (safeRelativePath(variant.asset)) {
      push(errors, Boolean(files[variant.asset]), `${label}.asset 不在 ZIP 中：${variant.asset}`);
      const glb = inspectGlb(files[variant.asset]);
      push(errors, glb.ok, `${label}.asset 不是可离线加载的 GLB：${variant.asset}${glb.reason ? `（${glb.reason}）` : ''}`);
    }
  });

  manifest.furniture.forEach((item, index) => {
    const label = `furniture[${index}]`;
    push(errors, isString(item.id), `${label}.id 必填`);
    push(errors, roomIds.has(item.roomId), `${label}.roomId 不存在：${item.roomId}`);
    push(errors, floorIds.has(item.floorId), `${label}.floorId 不存在：${item.floorId}`);
    push(errors, variantIds.has(item.variantId), `${label}.variantId 不存在：${item.variantId}`);
    push(errors, isString(item.category), `${label}.category 必填`);
    push(errors, isTuple3(item.position), `${label}.position 必须是 3 个有限数字`);
    push(errors, isFiniteNumber(item.rotation), `${label}.rotation 无效`);
    const room = roomById.get(item.roomId);
    if (room && room.floorId !== item.floorId) errors.push(`${label} 的 floorId 与 room 不一致`);
    const variant = variantById.get(item.variantId);
    if (variant && variant.category !== item.category) errors.push(`${label} 的 category 与 variant 不一致`);
    const floor = floorById.get(item.floorId);
    if (floor && variant && isTuple3(item.position) && !placementInsideFloor(item.position, variant.size, item.rotation, floor.bounds, floor.polygon)) errors.push(`${label} 的占地范围超出楼层边界`);
    if (floor && isTuple3(item.position) && Math.abs(item.position[1] - floor.elevation) > 1e-4) errors.push(`${label}.position.y 必须等于 ${floor.id} 的 elevation`);
  });

  if (manifest.materials !== undefined) {
    if (!Array.isArray(manifest.materials)) errors.push('materials 必须是数组');
    else manifest.materials.forEach((material, index) => {
      const label = `materials[${index}]`;
      push(errors, roomIds.has(material.roomId), `${label}.roomId 不存在：${material.roomId}`);
      ['status', 'wall', 'floor', 'wood', 'fabric', 'metal'].forEach((key) => push(errors, isString((material as unknown as Record<string, unknown>)[key]), `${label}.${key} 必填`));
      if (material.reference !== undefined && material.reference !== null) {
        push(errors, safeRelativePath(material.reference), `${label}.reference 必须是相对路径`);
        if (safeRelativePath(material.reference)) push(errors, Boolean(files[material.reference]), `${label}.reference 不在 ZIP 中：${material.reference}`);
      }
    });
  }

  const issues = errors.length === 0 ? layoutIssues(manifest.furniture.map((item) => ({ ...item })), manifest) : [];
  if (issues.some((issue) => issue.kind === 'overlap')) warnings.push(`${issues.filter((issue) => issue.kind === 'overlap').length} 组家具存在初始重叠，请在编辑时确认`);
  if (issues.some((issue) => issue.kind === 'outside')) errors.push(...issues.filter((issue) => issue.kind === 'outside').map((issue) => issue.message));
  return { ok: errors.length === 0, errors, warnings };
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function parseBundleZip(input: ArrayBuffer | Uint8Array): { bundle?: ModelBundle; validation: ValidationResult } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(input instanceof Uint8Array ? input : new Uint8Array(input));
  } catch (error) {
    return { validation: { ok: false, errors: [`ZIP 无法读取：${error instanceof Error ? error.message : '未知错误'}`], warnings: [] } };
  }
  const files: Record<string, ArrayBuffer> = {};
  Object.entries(entries).forEach(([path, bytes]) => {
    if (path.endsWith('/') || path.startsWith('/') || path.includes('\\') || path.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return;
    files[path] = copyBytes(bytes);
  });
  if (!files['manifest.json']) return { validation: { ok: false, errors: ['ZIP 根目录缺少 manifest.json'], warnings: [] } };
  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(new Uint8Array(files['manifest.json'])));
  } catch (error) {
    return { validation: { ok: false, errors: [`manifest.json 不是有效 JSON：${error instanceof Error ? error.message : '未知错误'}`], warnings: [] } };
  }
  const validation = validateManifest(manifest, files);
  if (!validation.ok) return { validation };
  return { bundle: { manifest: manifest as Manifest, files, importedAt: new Date().toISOString() }, validation };
}

export function validateLayout(value: unknown, manifest: Manifest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['布局文件必须是 JSON 对象'], warnings };
  push(errors, value.schemaVersion === 1, '布局 schemaVersion 必须为 1');
  push(errors, value.modelId === manifest.modelId, '布局 modelId 与当前模型不一致');
  push(errors, value.modelVersion === manifest.modelVersion, '布局 modelVersion 与当前模型不一致');
  push(errors, isString(value.savedAt), '布局 savedAt 缺失');
  push(errors, Array.isArray(value.furniture), '布局 furniture 必须是数组');
  if (errors.length > 0) return { ok: false, errors, warnings };
  const layout = value as unknown as Layout;
  const expected = new Set(manifest.furniture.map((item) => item.id));
  const seen = new Set<string>();
  const variants = new Map(manifest.variants.map((variant) => [variant.id, variant]));
  const floors = new Map(manifest.floors.map((floor) => [floor.id, floor]));
  const original = new Map(manifest.furniture.map((item) => [item.id, item]));
  layout.furniture.forEach((item, index) => {
    const label = `furniture[${index}]`;
    push(errors, isString(item.id) && expected.has(item.id), `${label}.id 不存在：${item.id}`);
    if (seen.has(item.id)) errors.push(`${label}.id 重复：${item.id}`);
    seen.add(item.id);
    push(errors, isString(item.variantId) && variants.has(item.variantId), `${label}.variantId 不存在：${item.variantId}`);
    push(errors, isTuple3(item.position), `${label}.position 必须是 3 个有限数字`);
    push(errors, isFiniteNumber(item.rotation), `${label}.rotation 无效`);
    const seed = original.get(item.id);
    const variant = variants.get(item.variantId);
    const floor = seed ? floors.get(seed.floorId) : undefined;
    if (seed && variant && variant.category !== seed.category) errors.push(`${label}.variantId 的 category 必须保持为 ${seed.category}`);
    if (seed && floor && isTuple3(item.position) && Math.abs(item.position[1] - floor.elevation) > 1e-4) errors.push(`${label}.position.y 必须等于 ${floor.id} 的 elevation`);
    if (variant && floor && isTuple3(item.position) && !placementInsideFloor(item.position, variant.size, item.rotation, floor.bounds, floor.polygon)) {
      errors.push(`${label} 的占地范围超出楼层边界`);
    }
  });
  if (seen.size !== expected.size) errors.push(`布局缺少家具：${[...expected].filter((id) => !seen.has(id)).join(', ')}`);
  if (errors.length === 0) {
    const issues = layoutIssues(layout.furniture.map((item) => ({ ...item, roomId: original.get(item.id)?.roomId ?? '', floorId: original.get(item.id)?.floorId ?? '', category: original.get(item.id)?.category ?? '' })), manifest);
    if (issues.some((issue) => issue.kind === 'overlap')) warnings.push(`${issues.filter((issue) => issue.kind === 'overlap').length} 组家具存在重叠`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
