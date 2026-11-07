import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { createSectionDetail } from './section';
import type { ModelBundle, RenderMode, Vec3Tuple, ViewMode } from './types';
import type { FurnitureState } from './types';

export interface SceneCallbacks {
  onSelect?: (id: string | undefined) => void;
  onDrag?: (id: string, position: Vec3Tuple) => void;
  onDragEnd?: (id: string) => void;
  onWarning?: (message: string) => void;
}

interface FloorContent {
  group: THREE.Group;
  base: THREE.Object3D;
  ceiling?: THREE.Object3D;
}

interface SceneContent {
  root: THREE.Group;
  floors: Map<string, FloorContent>;
  environment?: THREE.Object3D;
  exterior?: THREE.Object3D;
  prototypes: Map<string, THREE.Object3D>;
  furniture: Map<string, THREE.Group>;
}

interface DragState {
  pointerId: number;
  id: string;
  y: number;
  offset: THREE.Vector3;
}

interface MaterialModes {
  original: THREE.Material;
  white: THREE.MeshStandardMaterial;
  section: THREE.MeshStandardMaterial;
}

interface CameraTween {
  startedAt: number;
  duration: number;
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromFov: number;
  toFov: number;
}

const FURNITURE_HIGHLIGHT = new THREE.Color('#bd8d56');
const SECTION_COLOR = new THREE.Color('#f5eddc');
const WHITE_COLOR = new THREE.Color('#e8e1d5');

function cloneArrayBuffer(data: ArrayBuffer): ArrayBuffer {
  return data.slice(0);
}

function materialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function createWhiteMaterial(source: THREE.Material): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: WHITE_COLOR, roughness: 0.84, metalness: 0, side: source.side });
  material.name = `${source.name || 'material'}:white`;
  material.vertexColors = false;
  material.transparent = false;
  material.opacity = 1;
  material.alphaTest = 0;
  material.depthWrite = true;
  return material;
}

function centerAndRadius(bundle: ModelBundle): { center: THREE.Vector3; radius: number } {
  const bounds = bundle.manifest.floors.reduce(
    (acc, floor) => ({ minX: Math.min(acc.minX, floor.bounds[0]), minX2: Math.max(acc.minX2, floor.bounds[2]), minZ: Math.min(acc.minZ, floor.bounds[1]), maxZ: Math.max(acc.maxZ, floor.bounds[3]) }),
    { minX: Infinity, minX2: -Infinity, minZ: Infinity, maxZ: -Infinity },
  );
  const center = new THREE.Vector3((bounds.minX + bounds.minX2) / 2, 1.3, (bounds.minZ + bounds.maxZ) / 2);
  const radius = Math.max(bounds.minX2 - bounds.minX, bounds.maxZ - bounds.minZ, 4);
  return { center, radius };
}

export class SceneViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
  readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly ao: SSAOPass;
  private readonly canvas: HTMLCanvasElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly intersection = new THREE.Vector3();
  private readonly sectionPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private readonly loader = new GLTFLoader();
  private readonly callbacks: SceneCallbacks;
  private content?: SceneContent;
  private bundle?: ModelBundle;
  private layoutItems: FurnitureState[] = [];
  private drag?: DragState;
  private selectedId?: string;
  private viewMode: ViewMode = 'whole';
  private renderMode: RenderMode = 'material';
  private environmentVisible = true;
  private exteriorVisible = true;
  private editMode = false;
  private roomView?: string;
  private resizeObserver?: ResizeObserver;
  private cameraTween?: CameraTween;
  private sharedMaterialNames = new Set<string>();
  private sharedMaterials = new Map<string, THREE.Material>();
  private startedAt = performance.now();
  private firstFrameMs?: number;
  private loading = false;
  private slowSince?: number;
  private qualityStep = 0;
  private sectionDetail?: THREE.Group;
  private sectionTimer?: number;
  private sectionDirection = 'x';
  private sectionPosition = 50;
  private readonly frameTimes: number[] = [];
  private readonly contactTexture = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d')!;
    const gradient = context.createRadialGradient(64, 64, 12, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(45,35,25,.25)');
    gradient.addColorStop(.62, 'rgba(45,35,25,.12)');
    gradient.addColorStop(1, 'rgba(45,35,25,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
  })();

  constructor(canvas: HTMLCanvasElement, callbacks: SceneCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.setClearColor('#f2efe8');
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color('#f2efe8');
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const roomEnvironment = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(roomEnvironment, 0.04).texture;
    roomEnvironment.dispose();
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight('#fff6df', '#899394', 1.0));
    const key = new THREE.DirectionalLight('#fff1d8', 3.0);
    key.position.set(-8, 15, 13);
    key.target.position.set(0, 1.3, 1);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, {left: -18, right: 18, top: 18, bottom: -18, near: 0.5, far: 55});
    key.shadow.bias = -0.00015;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 3;
    this.scene.add(key.target);
    this.scene.add(key);
    this.renderer.info.autoReset = false;
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, samples: 2});
    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new SSAOPass(this.scene, this.camera, 512, 512, 8);
    this.ao.kernelRadius = 0.35;
    this.ao.minDistance = 0.0002;
    this.ao.maxDistance = 0.004;
    this.composer.addPass(this.ao);
    this.composer.addPass(new OutputPass());
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 250;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.camera.position.set(9, 7, 9);
    this.controls.target.set(0, 1, 0);
    this.bindPointerEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.animate();
  }

  private bindPointerEvents(): void {
    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('dblclick', () => {
      if (this.selectedId) this.focusFurniture(this.selectedId);
    });
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth || this.canvas.clientWidth || 1;
    const height = parent?.clientHeight || this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
    this.ao?.setSize(Math.max(1, Math.round(width * 0.7)), Math.max(1, Math.round(height * 0.7)));
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    if (this.cameraTween) {
      const tween = this.cameraTween;
      const progress = Math.min(1, (performance.now() - tween.startedAt) / tween.duration);
      const eased = 1 - (1 - progress) ** 3;
      this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
      this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
      this.camera.fov = tween.fromFov + (tween.toFov - tween.fromFov) * eased;
      this.camera.updateProjectionMatrix();
      if (progress >= 1) this.cameraTween = undefined;
    }
    this.controls.update();
    this.renderer.info.reset();
    // SSAOPass captures the projection at construction; room views change both FOV and depth range.
    this.ao.ssaoMaterial.uniforms.cameraNear.value = this.camera.near;
    this.ao.ssaoMaterial.uniforms.cameraFar.value = this.camera.far;
    this.ao.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix);
    this.ao.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(this.camera.projectionMatrixInverse);
    this.ao.enabled = !!this.content && this.renderMode !== 'section' && this.qualityStep < 2;
    this.composer.render();
    const now = performance.now();
    if (this.content && !this.loading && this.firstFrameMs === undefined) this.firstFrameMs = now - this.startedAt;
    this.frameTimes.push(now);
    while (this.frameTimes.length && this.frameTimes[0] < now - 1000) this.frameTimes.shift();
    if (this.content && !this.loading && document.visibilityState === 'visible' && now - this.startedAt > 4000 && this.frameTimes.length < 28) {
      this.slowSince ??= now;
      if (now - this.slowSince > 2500 && this.qualityStep < 2) {
        this.qualityStep++;
        this.renderer.setPixelRatio(1);
        this.composer.setPixelRatio(1);
        this.resize();
        this.slowSince = undefined;
      }
    } else this.slowSince = undefined;
  };

  private transitionCamera(position: THREE.Vector3, target: THREE.Vector3, fov = this.camera.fov): void {
    this.cameraTween = {
      startedAt: performance.now(),
      duration: 240,
      fromPosition: this.camera.position.clone(),
      toPosition: position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      fromFov: this.camera.fov,
      toFov: fov,
    };
  }

  private getFile(bundle: ModelBundle, path: string): ArrayBuffer {
    const data = bundle.files[path];
    if (!data) throw new Error(`缺少模型文件：${path}`);
    return cloneArrayBuffer(data);
  }

  private async loadGltf(bundle: ModelBundle, path: string): Promise<THREE.Object3D> {
    const data = this.getFile(bundle, path);
    return new Promise((resolve, reject) => {
      this.loader.parse(data, '', (gltf) => {
        this.dedupeSharedMaterials(gltf.scene);
        resolve(gltf.scene);
      }, (error) => reject(error instanceof Error ? error : new Error(`GLB 解析失败：${path}`)));
    });
  }

  private dedupeSharedMaterials(object: THREE.Object3D): void {
    if (!this.sharedMaterialNames.size) return;
    const duplicates = new Set<THREE.Material>();
    object.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      const materials = materialList(mesh.material);
      const deduped = materials.map((material) => {
        if (!material.name || !this.sharedMaterialNames.has(material.name)) return material;
        const canonical = this.sharedMaterials.get(material.name);
        if (!canonical) {
          this.sharedMaterials.set(material.name, material);
          return material;
        }
        if (canonical !== material) duplicates.add(material);
        return canonical;
      });
      mesh.material = Array.isArray(mesh.material) ? deduped : deduped[0];
    });
    duplicates.forEach((material) => material.dispose());
  }

  private async buildContent(bundle: ModelBundle, items: FurnitureState[]): Promise<SceneContent> {
    const root = new THREE.Group();
    root.name = 'model-bundle';
    const floors = new Map<string, FloorContent>();
    const prototypes = new Map<string, THREE.Object3D>();
    const furniture = new Map<string, THREE.Group>();
    try {
      for (const floor of bundle.manifest.floors) {
        const group = new THREE.Group();
        group.name = `floor:${floor.id}`;
        const base = await this.loadGltf(bundle, floor.asset);
        this.prepareObjectMaterials(base);
        group.add(base);
        let ceiling: THREE.Object3D | undefined;
        if (floor.ceilingAsset) {
          ceiling = await this.loadGltf(bundle, floor.ceilingAsset);
          this.prepareObjectMaterials(ceiling);
          ceiling.name = `ceiling:${floor.id}`;
          group.add(ceiling);
        }
        root.add(group);
        floors.set(floor.id, { group, base, ceiling });
      }
      const environment = bundle.manifest.environment ? await this.loadGltf(bundle, bundle.manifest.environment) : undefined;
      const exterior = bundle.manifest.exterior ? await this.loadGltf(bundle, bundle.manifest.exterior) : undefined;
      if (environment) {
        this.prepareObjectMaterials(environment);
        environment.name = 'environment';
        root.add(environment);
      }
      if (exterior) {
        this.prepareObjectMaterials(exterior);
        exterior.name = 'exterior';
        root.add(exterior);
      }
      for (const variant of bundle.manifest.variants) {
        prototypes.set(variant.id, await this.loadGltf(bundle, variant.asset));
      }
      for (const item of items) {
        const group = this.makeFurnitureGroup(item, prototypes);
        furniture.set(item.id, group);
        root.add(group);
      }
      return { root, floors, environment, exterior, prototypes, furniture };
    } catch (error) {
      this.disposeObject(root);
      prototypes.forEach((prototype) => this.disposeObject(prototype));
      this.sharedMaterials.forEach((material) => material.dispose());
      throw error;
    }
  }

  private makeFurnitureGroup(item: FurnitureState, prototypes: Map<string, THREE.Object3D>): THREE.Group {
    const group = new THREE.Group();
    group.name = `furniture:${item.id}`;
    group.userData.furnitureId = item.id;
    group.userData.variantId = item.variantId;
    const prototype = prototypes.get(item.variantId);
    if (prototype) {
      const instance = cloneSkeleton(prototype);
      this.prepareObjectMaterials(instance);
      group.add(instance);
    }
    this.addContactShadow(group, prototype);
    this.setTransform(group, item.position, item.rotation);
    return group;
  }

  private addContactShadow(group: THREE.Group, prototype?: THREE.Object3D): void {
    if (!prototype) return;
    const box = new THREE.Box3().setFromObject(prototype);
    const size = box.getSize(new THREE.Vector3());
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(size.x * 1.3, size.z * 1.3), new THREE.MeshBasicMaterial({map: this.contactTexture, transparent: true, depthWrite: false, toneMapped: false}));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.024;
    shadow.userData.ignorePick = true;
    shadow.renderOrder = 1;
    group.add(shadow);
  }

  private prepareObjectMaterials(object: THREE.Object3D): void {
    object.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      const sourceMaterials = materialList(mesh.material);
      mesh.castShadow = sourceMaterials.every((material) => !material.transparent);
      mesh.receiveShadow = true;
      const modes: MaterialModes[] = sourceMaterials.map((source) => {
        const original = source.clone();
        if ((original as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          const pbr = original as THREE.MeshStandardMaterial;
          pbr.envMapIntensity = pbr.metalness > 0.3 ? 0.85 : 0.28;
          if (pbr.map) pbr.map.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
        }
        const white = createWhiteMaterial(original);
        const section = white.clone();
        section.color.copy(SECTION_COLOR);
        section.name = `${white.name}:section`;
        return { original, white, section };
      });
      mesh.userData.viewerMaterialModes = modes;
      mesh.userData.viewerMaterialArray = Array.isArray(mesh.material);
      mesh.material = modes.map((entry) => entry.original);
      if (!mesh.userData.viewerMaterialArray) mesh.material = modes[0].original;
    });
  }

  private setTransform(group: THREE.Object3D, position: Vec3Tuple, rotation: number): void {
    group.position.set(position[0], position[1], position[2]);
    group.rotation.set(0, rotation, 0);
  }

  async loadBundle(bundle: ModelBundle, items: FurnitureState[]): Promise<void> {
    this.startedAt = performance.now();
    this.loading = true;
    this.firstFrameMs = undefined;
    this.roomView = undefined;
    const previousSharedNames = this.sharedMaterialNames;
    const previousSharedMaterials = this.sharedMaterials;
    this.sharedMaterialNames = new Set((bundle.manifest.sharedMaterialNames ?? []).filter(Boolean));
    this.sharedMaterials = new Map();
    let next: SceneContent;
    try {
      next = await this.buildContent(bundle, items);
    } catch (error) {
      this.loading = false;
      this.sharedMaterialNames = previousSharedNames;
      this.sharedMaterials = previousSharedMaterials;
      throw error;
    }
    if (this.content) {
      this.scene.remove(this.content.root);
      this.disposeContent(this.content, previousSharedMaterials);
    }
    this.content = next;
    this.loading = false;
    this.bundle = bundle;
    this.layoutItems = items;
    this.scene.add(next.root);
    this.renderer.shadowMap.needsUpdate = true;
    this.selectedId = undefined;
    this.callbacks.onSelect?.(undefined);
    const { center, radius } = centerAndRadius(bundle);
    this.camera.near = 0.08;
    this.camera.far = Math.max(100, radius * 5);
    this.camera.updateProjectionMatrix();
    this.camera.position.fromArray(bundle.manifest.overview.position);
    this.controls.target.fromArray(bundle.manifest.overview.target);
    this.camera.up.set(0, 1, 0);
    this.controls.enableRotate = true;
    this.controls.update();
    this.sectionPlane.constant = center.x;
    this.viewMode = 'whole';
    this.applyVisibility();
    this.applyRenderMode();
  }

  updateItems(items: FurnitureState[]): void {
    this.layoutItems = items;
    const content = this.content;
    if (!content) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const [id, group] of content.furniture) {
      const item = byId.get(id);
      if (!item) continue;
      if (group.userData.variantId !== item.variantId) {
        const nextPrototype = content.prototypes.get(item.variantId);
        // Clone instances share prototype geometry; dispose only instance materials here.
        this.disposeObject(group, false);
        group.clear();
        if (nextPrototype) {
          const instance = cloneSkeleton(nextPrototype);
          this.prepareObjectMaterials(instance);
          group.add(instance);
        }
        this.addContactShadow(group, nextPrototype);
        group.userData.variantId = item.variantId;
        this.applyMaterialToObject(group);
      }
      this.setTransform(group, item.position, item.rotation);
    }
    this.applyMaterialToObject(content.root);
    this.renderer.shadowMap.needsUpdate = true;
  }

  private updatePointer(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private findFurnitureHit(): { id: string; object: THREE.Object3D } | undefined {
    if (!this.content) return undefined;
    const visibleFurniture = [...this.content.furniture.values()].filter((group) => group.visible);
    const hits = this.raycaster.intersectObjects(visibleFurniture, true);
    const hit = hits.find((candidate) => {
      if (candidate.object.userData.ignorePick) return false;
      let node: THREE.Object3D | null = candidate.object;
      while (node) {
        if (typeof node.userData.furnitureId === 'string') return true;
        node = node.parent;
      }
      return false;
    });
    if (!hit) return undefined;
    let node: THREE.Object3D | null = hit.object;
    while (node && typeof node.userData.furnitureId !== 'string') node = node.parent;
    return node ? { id: node.userData.furnitureId as string, object: hit.object } : undefined;
  }

  private onPointerDown(event: PointerEvent): void {
    this.cameraTween = undefined;
    this.updatePointer(event);
    const hit = this.findFurnitureHit();
    this.select(hit?.id);
    if (!hit || !this.editMode || !this.bundle) return;
    const item = this.layoutItems.find((candidate) => candidate.id === hit.id);
    if (!item) return;
    this.groundPlane.constant = -item.position[1];
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, this.intersection)) return;
    const group = this.content?.furniture.get(hit.id);
    if (!group) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.controls.enabled = false;
    this.drag = { pointerId: event.pointerId, id: hit.id, y: item.position[1], offset: group.position.clone().sub(this.intersection) };
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.updatePointer(event);
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, this.intersection)) return;
    const next = this.intersection.clone().add(this.drag.offset);
    this.callbacks.onDrag?.(this.drag.id, [next.x, this.drag.y, next.z]);
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const id = this.drag.id;
    this.drag = undefined;
    this.controls.enabled = true;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.callbacks.onDragEnd?.(id);
  }

  private select(id: string | undefined): void {
    this.selectedId = id;
    this.applySelection();
    this.callbacks.onSelect?.(id);
  }

  private applySelection(): void {
    if (!this.content) return;
    for (const [id, group] of this.content.furniture) {
      group.traverse((node) => {
        if (!(node as THREE.Mesh).isMesh) return;
        const mesh = node as THREE.Mesh;
        materialList(mesh.material).forEach((entry) => {
          const mat = entry as THREE.MeshStandardMaterial;
          if (mat.color) {
            if (mat.userData.selectionBaseColor === undefined) mat.userData.selectionBaseColor = mat.color.getHex();
            const base = new THREE.Color(mat.userData.selectionBaseColor as number);
            mat.color.copy(id === this.selectedId ? base.lerp(FURNITURE_HIGHLIGHT, 0.28) : base);
          }
          if (mat.emissive) {
            if (mat.userData.selectionBaseEmissive === undefined) mat.userData.selectionBaseEmissive = mat.emissive.getHex();
            mat.emissive.set(id === this.selectedId ? FURNITURE_HIGHLIGHT : mat.userData.selectionBaseEmissive as number);
            mat.emissiveIntensity = id === this.selectedId ? 0.3 : 0;
          }
        });
      });
    }
  }

  private applyMaterialToObject(object: THREE.Object3D): void {
    object.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      const modes = mesh.userData.viewerMaterialModes as MaterialModes[] | undefined;
      if (!modes) return;
      const active = modes.map((entry) => {
        if (this.renderMode === 'white') return entry.white;
        if (this.renderMode === 'section') return entry.section;
        return entry.original;
      });
      active.forEach((material) => {
        material.clippingPlanes = this.renderMode === 'section' ? [this.sectionPlane] : [];
        material.clipShadows = this.renderMode === 'section';
      });
      mesh.material = mesh.userData.viewerMaterialArray ? active : active[0];
    });
  }

  private applyRenderMode(): void {
    if (this.content) this.applyMaterialToObject(this.content.root);
    this.applySelection();
  }

  private applyVisibility(): void {
    if (!this.content || !this.bundle) return;
    this.renderer.shadowMap.needsUpdate = true;
    const floorIds = this.bundle.manifest.floors.map((floor) => floor.id);
    for (const floor of this.bundle.manifest.floors) {
      const content = this.content.floors.get(floor.id);
      if (!content) continue;
      const visible = this.viewMode === 'whole' || this.viewMode === floor.id;
      content.group.visible = visible;
      if (content.ceiling) content.ceiling.visible = this.viewMode === 'whole' || this.roomView === floor.id;
    }
    if (this.content.environment) this.content.environment.visible = this.environmentVisible;
    if (this.content.exterior) this.content.exterior.visible = this.exteriorVisible && this.viewMode === 'whole';
    for (const item of this.layoutItems) {
      const group = this.content.furniture.get(item.id);
      if (group) group.visible = this.viewMode === 'whole' || this.viewMode === item.floorId;
    }
  }

  setViewMode(mode: ViewMode): void {
    this.roomView = undefined;
    this.viewMode = mode;
    this.applyVisibility();
    if (this.renderMode === 'section') this.setSection(this.sectionDirection, this.sectionPosition);
  }

  setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
    this.applyRenderMode();
    this.renderer.shadowMap.needsUpdate = true;
    if (mode === 'section') {
      this.roomView = undefined;
      this.applyVisibility();
      this.setSection(this.sectionDirection, this.sectionPosition, true);
    } else if (this.sectionDetail) this.sectionDetail.visible = false;
  }

  setSection(direction: string, percent: number, focus = false): void {
    if (!this.bundle) return;
    this.sectionDirection = direction;
    this.sectionPosition = Math.max(0, Math.min(100, percent));
    const floors = this.bundle.manifest.floors.filter(f => this.viewMode === 'whole' || f.id === this.viewMode);
    const all = floors.length ? floors : this.bundle.manifest.floors;
    const minX = Math.min(...all.map(f => f.bounds[0])), maxX = Math.max(...all.map(f => f.bounds[2]));
    const minZ = Math.min(...all.map(f => f.bounds[1])), maxZ = Math.max(...all.map(f => f.bounds[3]));
    const isX = direction.endsWith('x'), sign = direction.startsWith('-') ? 1 : -1;
    const min = isX ? minX : minZ, max = isX ? maxX : maxZ;
    const value = min + (max - min) * this.sectionPosition / 100;
    this.sectionPlane.normal.set(isX ? sign : 0, 0, isX ? 0 : sign);
    this.sectionPlane.constant = -sign * value;
    this.renderer.shadowMap.needsUpdate = true;
    if (focus) {
      const target = new THREE.Vector3((minX + maxX) / 2, all[0].elevation + all[0].height * .5, (minZ + maxZ) / 2);
      const span = Math.max(maxX - minX, maxZ - minZ);
      const offset = this.sectionPlane.normal.clone().multiplyScalar(-span * 2.6);
      offset.y = span * .65;
      this.transitionCamera(target.clone().add(offset), target, 24);
    }
    window.clearTimeout(this.sectionTimer);
    this.sectionTimer = window.setTimeout(() => {
      if (this.sectionDetail) {
        this.scene.remove(this.sectionDetail);
        this.sectionDetail.traverse(node => {
          const drawable = node as THREE.Mesh;
          drawable.geometry?.dispose();
          if (drawable.material) materialList(drawable.material).forEach(m => m.dispose());
        });
      }
      if (!this.content || this.renderMode !== 'section') return;
      const visibleBases = [...this.content.floors.values()].filter(f => f.group.visible).map(f => f.base);
      this.sectionDetail = createSectionDetail(visibleBases, this.sectionPlane);
      this.scene.add(this.sectionDetail);
    }, 80);
  }

  setEnvironmentVisible(visible: boolean): void {
    this.environmentVisible = visible;
    this.applyVisibility();
  }

  setExteriorVisible(visible: boolean): void {
    this.exteriorVisible = visible;
    this.applyVisibility();
  }

  setEditMode(enabled: boolean): void {
    this.editMode = enabled;
    if (enabled) {
      this.cameraTween = undefined;
      this.camera.fov = 42;
      this.camera.updateProjectionMatrix();
      this.roomView = undefined;
      this.applyVisibility();
      this.focusEditTopDown();
      this.controls.enableRotate = false;
    } else {
      this.drag = undefined;
      this.controls.enabled = true;
      this.controls.enableRotate = true;
      this.camera.up.set(0, 1, 0);
    }
  }

  private focusEditTopDown(): void {
    if (!this.bundle) return;
    const floors = this.viewMode === 'whole' ? this.bundle.manifest.floors : this.bundle.manifest.floors.filter((floor) => floor.id === this.viewMode);
    const selectedFloors = floors.length ? floors : this.bundle.manifest.floors;
    const bounds = selectedFloors.reduce((acc, floor) => ({ minX: Math.min(acc.minX, floor.bounds[0]), maxX: Math.max(acc.maxX, floor.bounds[2]), minZ: Math.min(acc.minZ, floor.bounds[1]), maxZ: Math.max(acc.maxZ, floor.bounds[3]) }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
    const center = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, selectedFloors[0].elevation, (bounds.minZ + bounds.maxZ) / 2);
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 4);
    this.camera.position.set(center.x, center.y + span * 1.35, center.z + 0.01);
    this.camera.up.set(0, 0, -1);
    this.controls.target.copy(center);
    this.controls.update();
  }

  focusOverview(): void {
    if (!this.bundle) return;
    const position = new THREE.Vector3().fromArray(this.bundle.manifest.overview.position);
    const target = new THREE.Vector3().fromArray(this.bundle.manifest.overview.target);
    this.camera.fov = 42;
    this.camera.updateProjectionMatrix();
    this.camera.up.set(0, 1, 0);
    this.controls.enableRotate = true;
    this.transitionCamera(position, target, 42);
  }

  focusFloor(floorId: string): void {
    const floor = this.bundle?.manifest.floors.find((candidate) => candidate.id === floorId);
    if (!floor) return;
    const center = new THREE.Vector3((floor.bounds[0] + floor.bounds[2]) / 2, floor.elevation, (floor.bounds[1] + floor.bounds[3]) / 2);
    const span = Math.max(floor.bounds[2] - floor.bounds[0], floor.bounds[3] - floor.bounds[1], 4);
    this.camera.fov = 42;
    const position = center.clone().add(new THREE.Vector3(span * 1.08, span * 0.92, span * 1.08));
    this.camera.up.set(0, 1, 0);
    this.controls.enableRotate = true;
    this.camera.updateProjectionMatrix();
    this.transitionCamera(position, center, 42);
  }

  focusRoom(roomId: string): void {
    const room = this.bundle?.manifest.rooms.find((candidate) => candidate.id === roomId);
    if (!room) return;
    this.setViewMode(room.floorId);
    this.roomView = room.id === 'garden' ? undefined : room.floorId;
    this.applyVisibility();
    this.camera.fov = room.camera.fov ?? 42;
    this.camera.updateProjectionMatrix();
    this.transitionCamera(new THREE.Vector3().fromArray(room.camera.position), new THREE.Vector3().fromArray(room.camera.target), room.camera.fov ?? 42);
  }

  private focusFurniture(id: string): void {
    const item = this.layoutItems.find((candidate) => candidate.id === id);
    if (!item) return;
    const target = new THREE.Vector3(item.position[0], item.position[1], item.position[2]);
    this.camera.position.copy(target.clone().add(new THREE.Vector3(3, 3, 3)));
    this.controls.target.copy(target);
    this.controls.update();
  }

  selectFurniture(id: string | undefined): void {
    this.select(id);
  }

  getRuntimeStats(): { fps: number; triangles: number; calls: number; firstFrameMs?: number } {
    return {
      fps: this.frameTimes.length,
      triangles: this.renderer.info.render.triangles,
      calls: this.renderer.info.render.calls,
      firstFrameMs: this.firstFrameMs,
    };
  }

  private disposeObject(object: THREE.Object3D, disposeGeometry = true): void {
    const disposedMaterials = new Set<THREE.Material>();
    object.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      if (disposeGeometry) mesh.geometry.dispose();
      const modes = mesh.userData.viewerMaterialModes as MaterialModes[] | undefined;
      if (modes) modes.forEach((entry) => [entry.original, entry.white, entry.section].forEach((material) => {
        if (!disposedMaterials.has(material)) {
          material.dispose();
          disposedMaterials.add(material);
        }
      }));
      else materialList(mesh.material).forEach((material) => {
        if (!disposedMaterials.has(material)) {
          material.dispose();
          disposedMaterials.add(material);
        }
      });
    });
  }

  private disposeContent(content: SceneContent, sharedMaterials = this.sharedMaterials): void {
    this.disposeObject(content.root);
    content.prototypes.forEach((prototype) => this.disposeObject(prototype));
    sharedMaterials.forEach((material) => material.dispose());
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
    this.composer.dispose();
    this.ao.dispose();
    if (this.content) this.disposeContent(this.content);
  }
}
