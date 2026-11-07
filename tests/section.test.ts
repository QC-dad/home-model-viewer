import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import {createSectionDetail, sectionSegments} from '../src/section';

describe('section geometry', () => {
  it('closes a transformed solid and keeps its cap on the cutting plane', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshStandardMaterial());
    box.position.set(5, 2, -1); box.updateMatrixWorld();
    const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 5);
    expect(sectionSegments(box, plane)).toHaveLength(8);
    const detail = createSectionDetail([box], plane);
    const caps = detail.children.filter(child => child instanceof THREE.Mesh) as THREE.Mesh[];
    expect(caps.length).toBe(1);
    const pos = caps[0].geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(pos.getX(i)).toBeCloseTo(5);
    expect(new THREE.Box3().setFromObject(caps[0]).getSize(new THREE.Vector3()).toArray()).toEqual([0,3,4]);
  });

  it('does not invent a cap for an open surface or include hidden floors', () => {
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), new THREE.MeshStandardMaterial());
    const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), .5);
    const detail = createSectionDetail([surface], plane);
    expect(detail.children.some(child => child instanceof THREE.Mesh)).toBe(false);
    surface.visible = false;
    expect(createSectionDetail([surface], plane).children).toHaveLength(0);
  });
});
