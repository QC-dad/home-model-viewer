import type { Layout, ModelBundle } from './types';

const DB_NAME = 'home-offline-viewer';
const DB_VERSION = 2;
const PROJECT_STORE = 'project';
const LAYOUT_STORE = 'layouts';
const PROJECT_KEY = 'current';

interface StoredProject {
  key: string;
  bundle: ModelBundle;
}

interface StoredLayout {
  key: string;
  layout: Layout;
}

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new StorageError('IndexedDB 请求失败'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new StorageError('IndexedDB 事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new StorageError('IndexedDB 事务已回滚'));
  });
}

export class ViewerStorage {
  private dbPromise?: Promise<IDBDatabase>;
  private writeQueue: Promise<void> = Promise.resolve();

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const operation = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new StorageError('当前浏览器不支持 IndexedDB'));
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(LAYOUT_STORE)) db.createObjectStore(LAYOUT_STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new StorageError('无法打开本地项目存储', { cause: request.error }));
      request.onblocked = () => reject(new StorageError('本地存储升级被旧页面占用，请关闭其他查看器页面后重试'));
    });
    return this.dbPromise;
  }

  async loadProject(): Promise<ModelBundle | undefined> {
    const db = await this.open();
    const transaction = db.transaction(PROJECT_STORE, 'readonly');
    const result = await requestResult(transaction.objectStore(PROJECT_STORE).get(PROJECT_KEY) as IDBRequest<StoredProject | undefined>);
    await transactionComplete(transaction);
    return result?.bundle;
  }

  async saveProject(bundle: ModelBundle): Promise<void> {
    return this.enqueueWrite(async () => {
      const db = await this.open();
      const transaction = db.transaction(PROJECT_STORE, 'readwrite');
      transaction.objectStore(PROJECT_STORE).put({ key: PROJECT_KEY, bundle } satisfies StoredProject);
      await transactionComplete(transaction);
    });
  }

  async saveProjectAndLayout(bundle: ModelBundle, layout: Layout): Promise<void> {
    return this.enqueueWrite(async () => {
      const db = await this.open();
      const transaction = db.transaction([PROJECT_STORE, LAYOUT_STORE], 'readwrite');
      transaction.objectStore(PROJECT_STORE).put({ key: PROJECT_KEY, bundle } satisfies StoredProject);
      transaction.objectStore(LAYOUT_STORE).put({ key: `${layout.modelId}:${layout.modelVersion}`, layout } satisfies StoredLayout);
      await transactionComplete(transaction);
    });
  }

  async loadLatestLayout(modelId: string, modelVersion: string): Promise<Layout | undefined> {
    const db = await this.open();
    const transaction = db.transaction(LAYOUT_STORE, 'readonly');
    const result = await requestResult(transaction.objectStore(LAYOUT_STORE).get(`${modelId}:${modelVersion}`) as IDBRequest<StoredLayout | undefined>);
    await transactionComplete(transaction);
    return result?.layout;
  }

  async saveLayout(layout: Layout): Promise<void> {
    return this.enqueueWrite(async () => {
      const db = await this.open();
      const transaction = db.transaction(LAYOUT_STORE, 'readwrite');
      transaction.objectStore(LAYOUT_STORE).put({ key: `${layout.modelId}:${layout.modelVersion}`, layout } satisfies StoredLayout);
      await transactionComplete(transaction);
    });
  }

  async clear(): Promise<void> {
    return this.enqueueWrite(async () => {
      const db = await this.open();
      const transaction = db.transaction([PROJECT_STORE, LAYOUT_STORE], 'readwrite');
      transaction.objectStore(PROJECT_STORE).clear();
      transaction.objectStore(LAYOUT_STORE).clear();
      await transactionComplete(transaction);
    });
  }
}

export const viewerStorage = new ViewerStorage();
