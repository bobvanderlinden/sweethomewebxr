import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/Addons.js";
import gltfUrl from "./TeleportMarker.gltf?url";

export class TeleportMarker extends THREE.Object3D {
  constructor() {
    super();

    const loader = new GLTFLoader();
    loader.load(gltfUrl, (gltf) => {
      this.add(gltf.scene);
    });
  }
}
