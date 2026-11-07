# Home model bundle v1

Generic offline viewer. House assets must never be committed to this repository.
ZIP has manifest.json at root; all asset URIs relative to root. No external URLs.
Coordinates are right-handed Three.js Y-up in metres, yaw radians, all GLBs share world origin.
Furniture variant GLBs are centred X/Z, feet at Y=0, width X, height Y, depth Z.

```ts
interface Manifest {
 schemaVersion: 1; modelId: string; modelVersion: string; name: string;
 floors: {id: string; name: string; elevation: number; height: number;
   bounds: [number,number,number,number]; // minX,minZ,maxX,maxZ
   polygon?: [number,number][];
   asset: string; ceilingAsset?: string;
 }[];
 environment?: string; exterior?: string;
 rooms: {id: string; name: string; floorId: string;
   bounds: [number,number,number,number];
   camera: {position:[number,number,number];target:[number,number,number];fov?:number};
   reference?: string; materialStatus?: string;
 }[];
 variants: {id:string; category:string; name:string; asset:string;
   size:[number,number,number];}[];
 furniture: {id:string; roomId:string; floorId:string; category:string;
   variantId:string; position:[number,number,number];rotation:number;}[];
 overview: {position:[number,number,number];target:[number,number,number]};
 materials?: {roomId:string; status:string; reference?:string; wall:string; floor:string; wood:string; fabric:string;metal:string;notes?:string}[];
 info?: string[];
}
interface Layout {
 schemaVersion:1; modelId:string; modelVersion:string; savedAt:string;
 furniture:{id:string;variantId:string;position:[number,number,number];rotation:number}[];
}
```
GLBs use embedded textures, no decoder needed unless deliberately bundled. All furniture appears ONLY as editable variants, not duplicated in floor GLBs.
Import validates schema/IDs, finite numbers, file availability, GLBs and floor bounds before committing. Keep previous project if any failure. No external fetch for private assets. Layout export/import rejects incompatible model version or invalid placements.
