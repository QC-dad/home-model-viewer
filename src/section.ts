import * as THREE from 'three';

type Segment = [THREE.Vector3, THREE.Vector3];
const EPS = 1e-5;
const key = (p: THREE.Vector3) => [p.x, p.y, p.z].map(v => Math.round(v / EPS)).join(',');

export function sectionSegments(mesh: THREE.Mesh, plane: THREE.Plane): Segment[] {
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  if (!positions) return [];
  const index = geometry.index;
  const count = index?.count ?? positions.count;
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const segments: Segment[] = [];
  for (let i = 0; i < count; i += 3) {
    vertices.forEach((v, j) => v.fromBufferAttribute(positions, index ? index.getX(i + j) : i + j).applyMatrix4(mesh.matrixWorld));
    const distances = vertices.map(v => plane.distanceToPoint(v));
    if (distances.every(d => d >= EPS) || distances.every(d => d <= -EPS) || distances.every(d => Math.abs(d) < EPS)) continue;
    const points = new Map<string, THREE.Vector3>();
    for (let j = 0; j < 3; j++) {
      const next = (j + 1) % 3;
      if (Math.abs(distances[j]) < EPS) points.set(key(vertices[j]), vertices[j].clone());
      if (distances[j] * distances[next] < -EPS * EPS) {
        const point = vertices[j].clone().lerp(vertices[next], distances[j] / (distances[j] - distances[next]));
        points.set(key(point), point);
      }
    }
    if (points.size === 2) segments.push([...points.values()] as Segment);
  }
  return segments;
}

function loopsFromSegments(segments: Segment[]): THREE.Vector3[][] {
  const points = new Map<string, THREE.Vector3>();
  const edges = new Map<string, Set<string>>();
  for (const [a, b] of segments) {
    const ka = key(a), kb = key(b);
    points.set(ka, a); points.set(kb, b);
    if (!edges.has(ka)) edges.set(ka, new Set());
    if (!edges.has(kb)) edges.set(kb, new Set());
    edges.get(ka)!.add(kb); edges.get(kb)!.add(ka);
  }
  const loops: THREE.Vector3[][] = [];
  for (const start of edges.keys()) {
    if (!edges.get(start)?.size) continue;
    const path = [start];
    let current = start;
    for (let guard = 0; guard <= segments.length; guard++) {
      const next = edges.get(current)?.values().next().value as string | undefined;
      if (!next) break;
      edges.get(current)!.delete(next); edges.get(next)?.delete(current);
      if (next === start) { if (path.length >= 3) loops.push(path.map(p => points.get(p)!)); break; }
      if (path.includes(next)) break;
      path.push(next); current = next;
    }
  }
  return loops;
}

function contains(p: THREE.Vector2, loop: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function createSectionDetail(objects: THREE.Object3D[], plane: THREE.Plane): THREE.Group {
  const result = new THREE.Group();
  const axisU = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), plane.normal).normalize();
  const axisV = new THREE.Vector3(0, 1, 0);
  const origin = plane.normal.clone().multiplyScalar(-plane.constant);
  const fill = new THREE.MeshBasicMaterial({color: '#b19b7b', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1});
  const edge = new THREE.LineBasicMaterial({color: '#554c40'});
  const allSegments: Segment[] = [];
  for (const object of objects) {
    object.updateWorldMatrix(true, true);
    object.traverseVisible(node => {
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (materials.every(m => m.transparent)) return;
      const segments = sectionSegments(mesh, plane);
      allSegments.push(...segments);
      const loops = loopsFromSegments(segments).map(loop => loop.map(p => new THREE.Vector2(p.dot(axisU), p.y)));
      const areas = loops.map(loop => Math.abs(THREE.ShapeUtils.area(loop)));
      const parents = loops.map((loop, i) => loops.reduce((parent, candidate, j) => j !== i && areas[j] > areas[i] && contains(loop[0], candidate) && (parent < 0 || areas[j] < areas[parent]) ? j : parent, -1));
      const depth = (i: number): number => parents[i] < 0 ? 0 : depth(parents[i]) + 1;
      loops.forEach((loop, i) => {
        if (depth(i) % 2 || areas[i] < EPS) return;
        const shape = new THREE.Shape(loop);
        loops.forEach((hole, j) => { if (parents[j] === i) shape.holes.push(new THREE.Path(hole)); });
        const geometry = new THREE.ShapeGeometry(shape);
        const pos = geometry.getAttribute('position');
        for (let n = 0; n < pos.count; n++) {
          const world = origin.clone().addScaledVector(axisU, pos.getX(n)).addScaledVector(axisV, pos.getY(n));
          pos.setXYZ(n, world.x, world.y, world.z);
        }
        geometry.computeVertexNormals();
        result.add(new THREE.Mesh(geometry, fill));
      });
    });
  }
  if (allSegments.length) {
    const geometry = new THREE.BufferGeometry().setFromPoints(allSegments.flat());
    result.add(new THREE.LineSegments(geometry, edge));
  }
  return result;
}
