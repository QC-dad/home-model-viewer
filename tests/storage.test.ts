import {beforeEach,describe,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {ViewerStorage} from '../src/storage';
import type {ModelBundle,Layout} from '../src/types';
const bundle=(name:string):ModelBundle=>({manifest:{schemaVersion:1,modelId:'sample',modelVersion:'1',name,floors:[],rooms:[],variants:[],furniture:[],overview:{position:[2,3,4],target:[0,0,0]}},files:{'a.glb':new Uint8Array([1,2,3]).buffer},importedAt:'2026-11-07'});
const layout=(x:number):Layout=>({schemaVersion:1,modelId:'sample',modelVersion:'1',savedAt:'2026-11-07',furniture:[{id:'sofa',variantId:'a',position:[x,0,0],rotation:0}]});
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());});
describe('project persistence',()=>{
 it('restores model and edited layout through a new storage instance',async()=>{
  const s=new ViewerStorage();await s.saveProjectAndLayout(bundle('original'),layout(2));
  const restored=new ViewerStorage();expect((await restored.loadProject())?.manifest.name).toBe('original');expect((await restored.loadLatestLayout('sample','1'))?.furniture[0].position[0]).toBe(2);
 });
 it('rolls back both stores when the second write fails and recovers the queue',async()=>{
  const s=new ViewerStorage();await s.saveProjectAndLayout(bundle('original'),layout(2));
  const put=IDBObjectStore.prototype.put;
  const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){if(this.name==='layouts')throw new DOMException('fixture clone failure','DataCloneError');return put.call(this,value,key);});
  await expect(s.saveProjectAndLayout(bundle('invalid'),layout(3))).rejects.toThrow('fixture clone failure');spy.mockRestore();
  expect((await s.loadProject())?.manifest.name).toBe('original');expect((await s.loadLatestLayout('sample','1'))?.furniture[0].position[0]).toBe(2);
  await s.saveLayout(layout(4));expect((await s.loadLatestLayout('sample','1'))?.furniture[0].position[0]).toBe(4);
 });
 it('keeps the latest of queued furniture edits',async()=>{const s=new ViewerStorage();await Promise.all([s.saveLayout(layout(1)),s.saveLayout(layout(2)),s.saveLayout(layout(3))]);expect((await s.loadLatestLayout('sample','1'))?.furniture[0].position[0]).toBe(3);});
});
