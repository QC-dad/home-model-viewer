import type { Manifest, ModelBundle, RenderMode, ViewMode, FurnitureState, Vec3Tuple, Layout } from './types';
import { manifestToLayout } from './types';
import { SceneViewer } from './scene';
import { viewerStorage } from './storage';
import { layoutToState, stateToLayout, updateItem, snapshotsEqual, placementInsideFloor, detectBoundaryIssues, layoutIssues } from './layout';
import { parseBundleZip, validateLayout } from './validation';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatDimensions(size: [number, number, number] | undefined): string {
  return size ? `${size[0].toFixed(2)} × ${size[1].toFixed(2)} × ${size[2].toFixed(2)} m` : '—';
}

function fileUrl(bundle: ModelBundle, path: string): string {
  const data = bundle.files[path];
  if (!data) return '';
  const ext = path.split('.').pop()?.toLowerCase();
  const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'application/octet-stream';
  return URL.createObjectURL(new Blob([data], { type }));
}

export class ViewerApp {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly sidebar: HTMLElement;
  private readonly statusBar: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly layoutInput: HTMLInputElement;
  private readonly viewer: SceneViewer;
  private bundle?: ModelBundle;
  private items: FurnitureState[] = [];
  private initialItems: FurnitureState[] = [];
  private selectedId?: string;
  private viewMode: ViewMode = 'whole';
  private renderMode: RenderMode = 'material';
  private sectionDirection = 'x';
  private sectionPosition = 50;
  private editMode = false;
  private environmentVisible = true;
  private exteriorVisible = true;
  private undoStack: FurnitureState[][] = [];
  private dragHistory = false;
  private actionQueue: Promise<void> = Promise.resolve();
  private saveTimer?: number;
  private toastTimer?: number;
  private referenceUrl?: string;
  private referenceRoomId?: string;
  private showRuntime = false;
  private runtimeTimer?: number;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div class="brand-lockup"><div class="brand-mark">⌂</div><div><h1>离线户型查看器</h1><p>本地模型 · 不依赖网络</p></div></div>
          <div class="topbar-actions">
            <span class="offline-badge"><span class="status-dot"></span>离线就绪</span>
            <button class="button button-ghost" data-action="import">导入模型 ZIP</button>
            <button class="button button-accent" data-action="export-layout" disabled>备份布局</button>
          </div>
        </header>
        <main class="workspace">
          <aside class="sidebar" aria-label="模型控制面板"><div class="sidebar-scroll" data-role="sidebar"></div></aside>
          <section class="viewport-panel" aria-label="三维模型视图">
            <canvas class="model-canvas"></canvas>
            <div class="canvas-toolbar"><button class="icon-button" data-action="overview" title="回到总览">⌂</button><span class="canvas-tip">拖动旋转 · 滚轮缩放 · 编辑模式可拖家具</span></div>
            <div class="empty-state" data-role="empty"><div class="empty-icon">◈</div><h2>先导入一份户型模型</h2><p>选择本地 ZIP，验证通过后会保存到本机。模型资产不会上传。</p><button class="button button-accent button-large" data-action="import">选择 ZIP 文件</button><small>ZIP 根目录需包含 manifest.json</small></div>
            <div class="reference-drawer hidden" data-role="reference"><div class="drawer-head"><strong data-role="reference-title">房间参考</strong><button class="icon-button" data-action="close-reference">×</button></div><img data-role="reference-image" alt="房间参考图" /><p data-role="reference-meta"></p></div>
          </section>
        </main>
        <div class="mobile-actions"><button data-action="import">导入</button><button data-action="overview">总览</button><button data-action="toggle-edit">编辑</button><button data-action="export-layout" disabled>备份</button></div>
        <div class="toast" data-role="toast" role="status" aria-live="polite"></div>
        <input type="file" accept=".zip,application/zip" hidden data-role="file-input" />
        <input type="file" accept=".json,application/json" hidden data-role="layout-input" />
      </div>`;
    this.canvas = root.querySelector('.model-canvas') as HTMLCanvasElement;
    this.sidebar = root.querySelector('[data-role="sidebar"]') as HTMLElement;
    this.statusBar = root.querySelector('[data-role="sidebar"]') as HTMLElement;
    this.emptyState = root.querySelector('[data-role="empty"]') as HTMLElement;
    this.toast = root.querySelector('[data-role="toast"]') as HTMLElement;
    this.fileInput = root.querySelector('[data-role="file-input"]') as HTMLInputElement;
    this.layoutInput = root.querySelector('[data-role="layout-input"]') as HTMLInputElement;
    this.viewer = new SceneViewer(this.canvas, {
      onSelect: (id) => {
        this.selectedId = id;
        this.renderSidebar();
      },
      onDrag: (id, position) => this.handleDrag(id, position),
      onDragEnd: () => {
        this.dragHistory = false;
        this.scheduleSave();
      },
      onWarning: (message) => this.showToast(message, 'warning'),
    });
    this.bindStaticEvents();
    this.renderSidebar();
    void this.enqueue(() => this.restore());
  }

  private bindStaticEvents(): void {
    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const actionNode = target.closest<HTMLElement>('[data-action]');
      if (!actionNode || actionNode.hasAttribute('disabled')) return;
      if (actionNode.matches('input[type="checkbox"]')) return;
      this.handleAction(actionNode.dataset.action ?? '', actionNode);
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) void this.importBundle(file);
    });
    this.layoutInput.addEventListener('change', () => {
      const file = this.layoutInput.files?.[0];
      this.layoutInput.value = '';
      if (file) void this.importLayoutFile(file);
    });
  }

  private handleAction(action: string, node: HTMLElement): void {
    switch (action) {
      case 'import': this.fileInput.click(); break;
      case 'export-layout': this.exportLayout(); break;
      case 'import-layout': this.layoutInput.click(); break;
      case 'overview': this.editMode = false; this.viewer.setEditMode(false); this.viewMode = 'whole'; this.viewer.setViewMode('whole'); this.viewer.focusOverview(); this.renderSidebar(); break;
      case 'toggle-edit':
        this.editMode = !this.editMode;
        if (this.editMode && this.viewMode === 'whole' && this.bundle) {
          this.viewMode = this.bundle.manifest.floors[0].id;
          this.viewer.setViewMode(this.viewMode);
        }
        this.viewer.setEditMode(this.editMode); this.renderSidebar(); break;
      case 'undo': this.undo(); break;
      case 'reset-room': this.resetRoom(node.dataset.roomId); break;
      case 'rotate90': this.rotateSelected(); break;
      case 'set-section-direction': this.sectionDirection = node.dataset.direction ?? 'x'; this.viewer.setSection(this.sectionDirection, this.sectionPosition, true); this.renderSidebar(); break;
      case 'set-render': this.setRenderMode(node.dataset.mode as RenderMode); break;
      case 'set-view': this.setViewMode(node.dataset.mode as ViewMode); break;
      case 'focus-room': this.focusRoom(node.dataset.roomId); break;
      case 'toggle-environment': this.environmentVisible = node instanceof HTMLInputElement ? node.checked : !this.environmentVisible; this.viewer.setEnvironmentVisible(this.environmentVisible); this.renderSidebar(); break;
      case 'toggle-exterior': this.exteriorVisible = node instanceof HTMLInputElement ? node.checked : !this.exteriorVisible; this.viewer.setExteriorVisible(this.exteriorVisible); this.renderSidebar(); break;
      case 'show-reference': this.showReference(node.dataset.roomId); break;
      case 'close-reference': this.closeReference(); break;
      case 'toggle-runtime': this.toggleRuntime(); break;
      case 'apply-variant': this.applyVariant((node as HTMLSelectElement).value); break;
      case 'apply-rotation': this.applyCustomRotation((node as HTMLInputElement).value); break;
      case 'dismiss-info': node.closest('.info-panel')?.remove(); break;
      default: break;
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.actionQueue = this.actionQueue.then(task, task);
    return this.actionQueue;
  }

  private async restore(): Promise<void> {
    try {
      const stored = await viewerStorage.loadProject();
      if (!stored) return;
      const layout = await viewerStorage.loadLatestLayout(stored.manifest.modelId, stored.manifest.modelVersion);
      const candidate = layout ? validateLayout(layout, stored.manifest) : { ok: false, errors: [], warnings: [] };
      const items = candidate.ok && layout ? layoutToState(layout, stored.manifest) : this.toState(stored.manifest);
      await this.viewer.loadBundle(stored, items);
      this.bundle = stored;
      this.items = items;
      this.initialItems = this.toState(stored.manifest);
      this.emptyState.classList.add('hidden');
      if (candidate.warnings.length) this.showToast(candidate.warnings.join('；'), 'warning');
      this.renderSidebar();
    } catch (error) {
      this.showToast(`恢复本地项目失败：${this.errorMessage(error)}`, 'error');
    }
  }

  private toState(manifest: Manifest): FurnitureState[] {
    return manifest.furniture.map((item) => ({
      id: item.id,
      name: item.name,
      roomId: item.roomId,
      floorId: item.floorId,
      category: item.category,
      variantId: item.variantId,
      position: [...item.position] as Vec3Tuple,
      rotation: item.rotation,
    }));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async importBundle(file: File): Promise<void> {
    await this.enqueue(async () => {
      const previousBundle = this.bundle;
      const previousItems = this.items.map((item) => ({ ...item, position: [...item.position] as Vec3Tuple }));
      try {
        const parsed = parseBundleZip(await file.arrayBuffer());
        if (!parsed.validation.ok || !parsed.bundle) {
          this.showToast(`导入失败：${parsed.validation.errors.slice(0, 3).join('；')}`, 'error');
          return;
        }
        const nextBundle = parsed.bundle;
        const nextItems = this.toState(nextBundle.manifest);
        const nextLayout = manifestToLayout(nextBundle.manifest);
        await viewerStorage.saveProjectAndLayout(nextBundle, nextLayout);
        try {
          await this.viewer.loadBundle(nextBundle, nextItems);
        } catch (error) {
          if (previousBundle) await viewerStorage.saveProjectAndLayout(previousBundle, stateToLayout(previousItems, previousBundle.manifest));
          else await viewerStorage.clear();
          throw error;
        }
        this.bundle = nextBundle;
        this.items = nextItems;
        this.initialItems = this.toState(nextBundle.manifest);
        this.selectedId = undefined;
        this.undoStack = [];
        this.viewMode = 'whole';
        this.emptyState.classList.add('hidden');
        this.renderSidebar();
        const notices = [...parsed.validation.warnings];
        this.showToast(`已导入「${nextBundle.manifest.name}」${notices.length ? `；${notices.join('；')}` : ''}`, notices.length ? 'warning' : 'success');
      } catch (error) {
        if (previousBundle && this.bundle !== previousBundle) {
          try { await this.viewer.loadBundle(previousBundle, previousItems); } catch { /* preserve original error */ }
        }
        this.showToast(`导入失败，当前项目未改变：${this.errorMessage(error)}`, 'error');
      }
    });
  }

  private layoutSnapshot(): FurnitureState[] {
    return this.items.map((item) => ({ ...item, position: [...item.position] as Vec3Tuple }));
  }

  private commit(next: FurnitureState[], options: { pushUndo?: boolean; save?: boolean } = {}): void {
    if (snapshotsEqual(this.items, next)) return;
    const outside = this.bundle ? detectBoundaryIssues(next, this.bundle.manifest) : [];
    if (outside.length) { this.showToast(outside[0].message, 'warning'); this.renderSidebar(); return; }
    if (options.pushUndo !== false) {
      this.undoStack.push(this.layoutSnapshot());
      if (this.undoStack.length > 60) this.undoStack.shift();
    }
    this.items = next;
    this.viewer.updateItems(this.items);
    this.renderSidebar();
    if (options.save !== false) this.scheduleSave();
  }

  private handleDrag(id: string, position: Vec3Tuple): void {
    const item = this.items.find((candidate) => candidate.id === id);
    const manifest = this.bundle?.manifest;
    if (!item || !manifest) return;
    const variant = manifest.variants.find((candidate) => candidate.id === item.variantId);
    const floor = manifest.floors.find((candidate) => candidate.id === item.floorId);
    if (!variant || !floor) return;
    if (!this.dragHistory) {
      this.undoStack.push(this.layoutSnapshot());
      if (this.undoStack.length > 60) this.undoStack.shift();
      this.dragHistory = true;
    }
    if (!placementInsideFloor(position, variant.size, item.rotation, floor.bounds, floor.polygon)) {
      this.showToast('家具不能拖出当前楼层边界', 'warning');
      return;
    }
    this.items = updateItem(this.items, id, { position });
    this.viewer.updateItems(this.items);
    this.renderSidebar();
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return this.showToast('没有可撤销的操作', 'warning');
    this.commit(previous, { pushUndo: false });
  }

  private resetRoom(roomId?: string): void {
    if (!roomId) return;
    const ids = new Set(this.initialItems.filter((item) => item.roomId === roomId).map((item) => item.id));
    this.commit(this.items.map((item) => ids.has(item.id) ? { ...this.initialItems.find((seed) => seed.id === item.id)!, position: [...this.initialItems.find((seed) => seed.id === item.id)!.position] as Vec3Tuple } : item), { pushUndo: true });
    this.showToast('已恢复该房间初始布局', 'success');
  }

  private rotateSelected(): void {
    const item = this.items.find((candidate) => candidate.id === this.selectedId);
    if (!item) return;
    this.commit(updateItem(this.items, item.id, { rotation: item.rotation + Math.PI / 2 }));
  }

  private applyCustomRotation(raw: string): void {
    const item = this.items.find((candidate) => candidate.id === this.selectedId);
    if (!item) return;
    const degrees = Number(raw);
    if (!Number.isFinite(degrees)) return;
    this.commit(updateItem(this.items, item.id, { rotation: degrees * Math.PI / 180 }));
  }

  private applyVariant(variantId: string): void {
    const item = this.items.find((candidate) => candidate.id === this.selectedId);
    const variant = this.bundle?.manifest.variants.find((candidate) => candidate.id === variantId);
    if (!item || !variant || variant.category !== item.category) return;
    this.commit(updateItem(this.items, item.id, { variantId }));
    const issues = this.bundle ? layoutIssues(this.items, this.bundle.manifest).filter((issue) => issue.id === item.id) : [];
    if (issues.length) this.showToast(`已切换 ${variant.name}，但${issues[0].message}`, 'warning');
  }

  private scheduleSave(): void {
    if (!this.bundle) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const bundle = this.bundle;
      if (!bundle) return;
      const layout = stateToLayout(this.items.map((item) => ({ ...item, position: [...item.position] as Vec3Tuple })), bundle.manifest);
      void viewerStorage.saveLayout(layout).catch((error) => this.showToast(`自动保存失败：${this.errorMessage(error)}`, 'error'));
    }, 280);
  }

  private setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.viewer.setViewMode(mode);
    if (this.editMode) this.viewer.setEditMode(true);
    else if (this.renderMode === 'section') this.viewer.setSection(this.sectionDirection, this.sectionPosition, true);
    else if (mode !== 'whole') this.viewer.focusFloor(mode);
    else this.viewer.focusOverview();
    this.renderSidebar();
  }

  private setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
    this.viewer.setRenderMode(mode);
    this.renderSidebar();
  }

  private focusRoom(roomId?: string): void {
    if (!roomId) return;
    const room = this.bundle?.manifest.rooms.find((candidate) => candidate.id === roomId);
    if (!room) return;
    this.editMode = false;
    this.viewer.setEditMode(false);
    this.viewMode = room.floorId;
    this.viewer.focusRoom(roomId);
    this.renderSidebar();
  }

  private exportLayout(): void {
    if (!this.bundle) return;
    const layout = stateToLayout(this.items, this.bundle.manifest);
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.bundle.manifest.modelId}-${this.bundle.manifest.modelVersion}-layout.json`;
    link.click();
    URL.revokeObjectURL(url);
    this.showToast('布局备份已导出', 'success');
  }

  private async importLayoutFile(file: File): Promise<void> {
    await this.enqueue(async () => {
      if (!this.bundle) return this.showToast('请先导入模型，再恢复布局', 'warning');
      try {
        const value = JSON.parse(await file.text()) as unknown;
        const result = validateLayout(value, this.bundle.manifest);
        if (!result.ok) return this.showToast(`布局恢复失败：${result.errors.slice(0, 3).join('；')}`, 'error');
        const layout = value as Layout;
        const next = layoutToState(layout, this.bundle.manifest);
        this.commit(next, { pushUndo: true });
        if (result.warnings.length) this.showToast(`布局已恢复；${result.warnings.join('；')}`, 'warning');
        else this.showToast('布局已恢复', 'success');
      } catch (error) {
        this.showToast(`布局恢复失败：${this.errorMessage(error)}`, 'error');
      }
    });
  }

  private showReference(roomId?: string): void {
    const room = this.bundle?.manifest.rooms.find((candidate) => candidate.id === roomId);
    const bundle = this.bundle;
    if (!room || !bundle?.files || !room.reference) return this.showToast('该房间没有参考图', 'warning');
    this.closeReference();
    const url = fileUrl(bundle, room.reference);
    if (!url) return this.showToast('参考图文件缺失', 'error');
    this.referenceUrl = url;
    this.referenceRoomId = room.id;
    const drawer = this.root.querySelector('[data-role="reference"]') as HTMLElement;
    const image = this.root.querySelector('[data-role="reference-image"]') as HTMLImageElement;
    const title = this.root.querySelector('[data-role="reference-title"]') as HTMLElement;
    const meta = this.root.querySelector('[data-role="reference-meta"]') as HTMLElement;
    image.src = url;
    title.textContent = `${room.name} · 参考图`;
    meta.textContent = '模型参考与实际材质以导入包内文件为准。';
    drawer.classList.remove('hidden');
  }

  private closeReference(): void {
    const drawer = this.root.querySelector('[data-role="reference"]') as HTMLElement;
    drawer.classList.add('hidden');
    if (this.referenceUrl) URL.revokeObjectURL(this.referenceUrl);
    this.referenceUrl = undefined;
    this.referenceRoomId = undefined;
  }

  private showToast(message: string, tone: 'success' | 'warning' | 'error' = 'success'): void {
    this.toast.textContent = message;
    this.toast.dataset.tone = tone;
    this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('visible'), 4200);
  }

  private toggleRuntime(): void {
    this.showRuntime = !this.showRuntime;
    window.clearInterval(this.runtimeTimer);
    if (this.showRuntime) this.runtimeTimer = window.setInterval(() => {
      const panel = this.sidebar.querySelector('.runtime-panel');
      if (panel) panel.outerHTML = this.renderRuntimePanel();
    }, 1000);
    this.renderSidebar();
  }

  private renderSidebar(): void {
    const bundle = this.bundle;
    const manifest = bundle?.manifest;
    if (!manifest) {
      this.sidebar.innerHTML = `<div class="empty-sidebar"><p>尚未载入模型</p><p class="muted">从上方导入 ZIP 后，楼层、房间、家具控制会显示在这里。</p><div class="info-panel"><strong>iPhone 离线使用</strong><p>Safari 分享 → 添加到主屏幕。首次打开后，导入 ZIP；之后模型与布局保存在本机，可断网使用。</p></div></div>`;
      this.setTopButtons(false);
      return;
    }
    this.setTopButtons(true);
    const selected = this.items.find((item) => item.id === this.selectedId);
    const selectedVariant = selected ? manifest.variants.find((variant) => variant.id === selected.variantId) : undefined;
    const selectedRoom = selected ? manifest.rooms.find((room) => room.id === selected.roomId) : undefined;
    const categories = [...new Set(manifest.variants.map((variant) => variant.category))];
    const issues = layoutIssues(this.items, manifest);
    const statusCount = manifest.materials?.length ?? 0;
    this.sidebar.innerHTML = `
      <section class="panel model-panel"><div class="panel-heading"><span class="eyebrow">当前模型</span><span class="model-ok">本地</span></div><h2>${escapeHtml(manifest.name)}</h2><dl class="meta-grid"><div><dt>版本</dt><dd>${escapeHtml(manifest.modelVersion)}</dd></div><div><dt>楼层</dt><dd>${manifest.floors.length}</dd></div><div><dt>房间</dt><dd>${manifest.rooms.length}</dd></div><div><dt>家具</dt><dd>${manifest.furniture.length}</dd></div></dl><p class="muted small">导入于 ${formatDate(bundle.importedAt)} · ${Object.keys(bundle.files).length} 个本地文件</p></section>
      <section class="panel"><div class="panel-heading"><h3>场景</h3><button class="text-button" data-action="overview">回总览</button></div><div class="segmented floors">${['whole', ...manifest.floors.map((floor) => floor.id)].map((mode) => `<button class="segment ${this.viewMode === mode ? 'active' : ''}" data-action="set-view" data-mode="${escapeHtml(mode)}">${mode === 'whole' ? '全屋' : escapeHtml(manifest.floors.find((floor) => floor.id === mode)?.name ?? mode)}</button>`).join('')}</div><div class="mode-row"><button class="mode-chip ${this.renderMode === 'material' ? 'active' : ''}" data-action="set-render" data-mode="material">材质</button><button class="mode-chip ${this.renderMode === 'white' ? 'active' : ''}" data-action="set-render" data-mode="white">白模</button><button class="mode-chip ${this.renderMode === 'section' ? 'active' : ''}" data-action="set-render" data-mode="section">剖切</button></div>${this.renderMode === 'section' ? `<div class="section-controls"><div class="mode-row">${[['x','从右'],['-x','从左'],['z','从前'],['-z','从后']].map(([direction,label]) => `<button class="mode-chip ${this.sectionDirection === direction ? 'active' : ''}" data-action="set-section-direction" data-direction="${direction}">${label}</button>`).join('')}</div><label class="field-label">剖切位置 <input aria-label="剖切位置" type="range" min="0" max="100" value="${this.sectionPosition}" data-action="section-position" /></label></div>` : ''}<label class="switch-row"><span>环境 / 庭院</span><input type="checkbox" data-action="toggle-environment" ${this.environmentVisible ? 'checked' : ''}/><i></i></label><label class="switch-row"><span>外围遮挡</span><input type="checkbox" data-action="toggle-exterior" ${this.exteriorVisible ? 'checked' : ''}/><i></i></label></section>
      <section class="panel"><div class="panel-heading"><h3>房间预设</h3><span class="muted small">点击定位</span></div><div class="room-list">${manifest.rooms.map((room) => `<div class="room-row"><button class="room-name ${this.viewMode === room.floorId ? '' : ''}" data-action="focus-room" data-room-id="${escapeHtml(room.id)}"><span>${escapeHtml(room.name)}</span><small>${escapeHtml(manifest.floors.find((floor) => floor.id === room.floorId)?.name ?? room.floorId)}</small></button>${room.reference ? `<button class="ref-button" data-action="show-reference" data-room-id="${escapeHtml(room.id)}" title="查看参考图">▧</button>` : ''}</div>`).join('')}</div></section>
      <section class="panel editor-panel"><div class="panel-heading"><h3>布局编辑</h3><button class="edit-toggle ${this.editMode ? 'active' : ''}" data-action="toggle-edit">${this.editMode ? '退出编辑' : '开启编辑'}</button></div><div class="edit-actions"><button class="button button-small" data-action="undo" ${this.undoStack.length ? '' : 'disabled'}>↶ 撤销</button><button class="button button-small" data-action="import-layout">恢复 JSON</button></div>${selected ? this.renderInspector(selected, selectedVariant, selectedRoom, categories) : '<p class="muted small editor-hint">开启编辑后，在场景中点击家具。可拖动、旋转、替换同类别规格。</p>'}</section>
      <section class="panel status-panel"><div class="panel-heading"><h3>参考与状态</h3><span class="status-pill">${statusCount ? `${statusCount} 条材质记录` : '无材质表'}</span></div>${manifest.info?.length ? `<ul class="info-list">${manifest.info.slice(0, 4).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '<p class="muted small">模型包未提供说明文字。</p>'}${issues.length ? `<div class="issues"><strong>布局提醒 ${issues.length}</strong><p>${escapeHtml(issues.slice(0, 2).map((issue) => issue.message).join('；'))}${issues.length > 2 ? '…' : ''}</p></div>` : '<p class="ok-line">✓ 当前布局无边界或重叠提醒</p>'}<button class="text-button runtime-toggle" data-action="toggle-runtime">${this.showRuntime ? '隐藏运行信息' : '运行信息'}</button>${this.showRuntime ? this.renderRuntimePanel() : ''}</section>
      <section class="info-panel compact-info"><strong>离线提示</strong><p>添加到主屏幕后，模型、布局和应用壳都会留在本机。清理浏览器网站数据会删除本地项目。</p></section>`;
    this.bindDynamicInputs();
  }

  private renderRuntimePanel(): string {
    const stats = this.viewer.getRuntimeStats();
    return `<div class="runtime-panel"><div><span>滚动 FPS</span><strong>${stats.fps}</strong></div><div><span>渲染三角面</span><strong>${stats.triangles.toLocaleString('zh-CN')}</strong></div><div><span>绘制调用</span><strong>${stats.calls}</strong></div><p>模型解析至首帧 ${stats.firstFrameMs === undefined ? '计时中' : `${Math.round(stats.firstFrameMs)} ms`} · 以当前设备为准</p></div>`;
  }

  private renderInspector(item: FurnitureState, variant: Manifest['variants'][number] | undefined, room: Manifest['rooms'][number] | undefined, categories: string[]): string {
    const variants = this.bundle?.manifest.variants.filter((candidate) => candidate.category === item.category) ?? [];
    const degree = Math.round((item.rotation * 180) / Math.PI);
    return `<div class="selected-title"><span class="selection-dot"></span><strong>${escapeHtml(item.name ?? item.id)}</strong><span class="muted">${escapeHtml(item.category)}</span></div><p class="selected-room">${escapeHtml(room?.name ?? item.roomId)} · ${escapeHtml(this.bundle?.manifest.floors.find((floor) => floor.id === item.floorId)?.name ?? item.floorId)}</p><label class="field-label">同类别规格<select data-action="apply-variant">${variants.map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${candidate.id === item.variantId ? 'selected' : ''}>${escapeHtml(candidate.name)} · ${formatDimensions(candidate.size)}</option>`).join('')}</select></label><div class="inspector-grid"><label class="field-label">旋转°<input type="number" step="1" value="${degree}" data-action="apply-rotation" /></label><div><span class="field-label">快速操作</span><button class="button button-small full-width" data-action="rotate90">↻ 旋转 90°</button></div></div><p class="muted small">规格尺寸 ${formatDimensions(variant?.size)} · 位置 ${item.position.map((part) => part.toFixed(2)).join(', ')}</p><button class="text-button reset-room" data-action="reset-room" data-room-id="${escapeHtml(item.roomId)}">恢复此房间初始布局</button>`;
  }

  private bindDynamicInputs(): void {
    this.sidebar.querySelector<HTMLInputElement>('[data-action="section-position"]')?.addEventListener('input', event => {
      this.sectionPosition = Number((event.target as HTMLInputElement).value);
      this.viewer.setSection(this.sectionDirection, this.sectionPosition);
    });
    this.sidebar.querySelectorAll<HTMLInputElement>('input[data-action="toggle-environment"], input[data-action="toggle-exterior"]').forEach((input) => {
      input.addEventListener('change', () => this.handleAction(input.dataset.action ?? '', input));
    });
    this.sidebar.querySelectorAll<HTMLSelectElement>('select[data-action="apply-variant"]').forEach((select) => {
      select.addEventListener('change', () => this.handleAction('apply-variant', select));
    });
    this.sidebar.querySelectorAll<HTMLInputElement>('input[data-action="apply-rotation"]').forEach((input) => {
      input.addEventListener('change', () => this.handleAction('apply-rotation', input));
    });
  }

  private setTopButtons(enabled: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="export-layout"]').forEach((button) => { button.disabled = !enabled; });
  }
}
