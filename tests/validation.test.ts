import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseBundleZip, validateLayout } from '../src/validation';
import { detectOverlaps, placementInsideFloor, updateItem } from '../src/layout';
import type { Manifest, FurnitureState, Layout } from '../src/types';

function makeGlb(json: Record<string, unknown>): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(json));
  const paddedLength = Math.ceil(raw.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + paddedLength);
  bytes.set([0x67, 0x6c, 0x54, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, 2, true);
  new DataView(bytes.buffer).setUint32(8, bytes.length, true);
  new DataView(bytes.buffer).setUint32(12, paddedLength, true);
  new DataView(bytes.buffer).setUint32(16, 0x4e4f534a, true);
  bytes.set(raw, 20);
  return bytes;
}

const glb = makeGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [] });

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    modelId: 'fixture-home',
    modelVersion: '2026.11.07',
    name: '测试户型',
    floors: [{ id: 'floor1', name: '一层', elevation: 0, height: 3, bounds: [0, 0, 10, 10], asset: 'floors/f1.glb' }],
    rooms: [{ id: 'living', name: '客厅', floorId: 'floor1', bounds: [0, 0, 10, 10], camera: { position: [5, 6, 12], target: [5, 0, 5] } }],
    variants: [{ id: 'sofa-a', category: '沙发', name: '三人位', asset: 'furniture/sofa-a.glb', size: [2, 1, 1] }],
    furniture: [{ id: 'sofa-1', roomId: 'living', floorId: 'floor1', category: '沙发', variantId: 'sofa-a', position: [5, 0, 5], rotation: 0 }],
    overview: { position: [13, 9, 13], target: [5, 0, 5] },
    ...overrides,
  };
}

function bundleZip(input: Manifest = manifest(), remove?: string): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(input)),
    'floors/f1.glb': glb,
    'furniture/sofa-a.glb': glb,
  };
  if (remove) delete entries[remove];
  return zipSync(entries);
}

describe('model bundle validation', () => {
  it('accepts a valid local bundle and keeps files in memory', () => {
    const parsed = parseBundleZip(bundleZip());
    expect(parsed.validation.ok).toBe(true);
    expect(parsed.bundle?.manifest.modelId).toBe('fixture-home');
    expect(parsed.bundle?.files['floors/f1.glb']).toBeInstanceOf(ArrayBuffer);
  });

  it('rejects a missing asset without returning a partial bundle', () => {
    const parsed = parseBundleZip(bundleZip(manifest(), 'furniture/sofa-a.glb'));
    expect(parsed.validation.ok).toBe(false);
    expect(parsed.bundle).toBeUndefined();
    expect(parsed.validation.errors.join('\n')).toContain('sofa-a.glb');
  });

  it('rejects GLB files that reference external buffers or decoder extensions', () => {
    const external = makeGlb({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.com/mesh.bin' }] });
    const entries = zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest())), 'floors/f1.glb': external, 'furniture/sofa-a.glb': glb });
    const parsed = parseBundleZip(entries);
    expect(parsed.validation.ok).toBe(false);
    expect(parsed.validation.errors.join('\n')).toContain('外部 URI');
  });

  it('rejects an out-of-bounds initial placement atomically', () => {
    const parsed = parseBundleZip(bundleZip(manifest({ furniture: [{ ...manifest().furniture[0], position: [0.1, 0, 0.1] }] })));
    expect(parsed.validation.ok).toBe(false);
    expect(parsed.bundle).toBeUndefined();
    expect(parsed.validation.errors.join('\n')).toContain('超出楼层边界');
  });
});

describe('layout geometry and backup validation', () => {
  const base = manifest();
  const item = { ...base.furniture[0], roomId: 'living', floorId: 'floor1' } satisfies FurnitureState;

  it('checks rotated footprint against floor bounds', () => {
    expect(placementInsideFloor([5, 0, 5], [2, 1, 1], Math.PI / 2, [0, 0, 10, 10])).toBe(true);
    expect(placementInsideFloor([0.5, 0, 0.5], [2, 1, 1], 0, [0, 0, 10, 10])).toBe(false);
  });

  it('reports oriented overlaps only on the same floor', () => {
    const variants = new Map([['sofa-a', [2, 1, 1] as [number, number, number]]]);
    const second = { ...item, id: 'sofa-2', position: [5.5, 0, 5] as [number, number, number] };
    expect(detectOverlaps([item, second], variants)).toHaveLength(1);
    expect(detectOverlaps([item, { ...second, floorId: 'floor2' }], variants)).toHaveLength(0);
    const bars = new Map([['bar', { size: [4, 1, 0.2] as [number, number, number], footprint: 'rect' as const }]]);
    const barA = { ...item, variantId: 'bar', position: [5, 0, 5] as [number, number, number], rotation: Math.PI / 4 };
    const barB = { ...barA, id: 'bar-2', position: [4.58, 0, 5.42] as [number, number, number] };
    expect(detectOverlaps([barA, barB], bars)).toHaveLength(0);
  });

  it('uses circular footprint for round tables instead of AABB corners', () => {
    const variants = new Map([
      ['table', { size: [2, 1, 2] as [number, number, number], footprint: 'ellipse' as const }],
      ['chair', { size: [0.2, 1, 0.2] as [number, number, number], footprint: 'rect' as const }],
    ]);
    const table = { ...item, variantId: 'table', position: [5, 0, 5] as [number, number, number] };
    const chair = { ...item, id: 'chair-1', variantId: 'chair', position: [5.9, 0, 5.9] as [number, number, number] };
    expect(detectOverlaps([table, chair], variants)).toHaveLength(0);
  });

  it('rejects incompatible layout version and placements', () => {
    const layout: Layout = { schemaVersion: 1, modelId: base.modelId, modelVersion: 'old', savedAt: new Date().toISOString(), furniture: [{ id: 'sofa-1', variantId: 'sofa-a', position: [5, 0, 5], rotation: 0 }] };
    expect(validateLayout(layout, base).ok).toBe(false);
    const invalid: Layout = { ...layout, modelVersion: base.modelVersion, furniture: [{ ...layout.furniture[0], position: [0.1, 0, 0.1] }] };
    expect(validateLayout(invalid, base).ok).toBe(false);
  });

  it('creates immutable updates suitable for an undo stack', () => {
    const first = [item];
    const next = updateItem(first, item.id, { position: [7, 0, 7] });
    expect(first[0].position).toEqual([5, 0, 5]);
    expect(next[0].position).toEqual([7, 0, 7]);
    const undo = next.map((entry) => ({ ...entry, position: [...entry.position] as [number, number, number] }));
    expect(undo).toEqual(next);
  });
});
