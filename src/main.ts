import "./style.css";
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader";
import { MTLLoader } from "three/addons/loaders/MTLLoader";
import { XRButton } from "three/addons/webxr/XRButton";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory";
import { PointerLockControls } from "three/examples/jsm/Addons.js";

function exportDepthTexture(
  renderer: THREE.WebGLRenderer,
  depthTexture: THREE.DepthTexture
) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  const geometry = new THREE.PlaneGeometry(1, 1);

  // Create a shader to convert the depthTexture to a grayscale image.
  // Without this the depthTexture will be a single channel texture: red-scale.
  const material = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    // Reverse the depth value to get white for closeby and black for far away.
    fragmentShader: `
      uniform sampler2D depthTexture;
      varying vec2 vUv;
      void main() {
        float depth = 1.0 - texture2D(depthTexture, vUv).r;
        gl_FragColor = vec4(vec3(depth), 1.0);
      }
    `,
    uniforms: {
      depthTexture: { value: depthTexture },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  camera.position.set(0, 0, 1);
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);

  const image = new Image();
  image.src = renderer.domElement.toDataURL();
  document.body.appendChild(image);
}

async function loadModel(
  objUrl: string,
  mtlUrl: string
): Promise<THREE.Object3D> {
  const objLoader = new OBJLoader();
  const mtlLoader = new MTLLoader();
  const materials = await mtlLoader.loadAsync(mtlUrl);
  materials.preload();
  objLoader.setMaterials(materials);
  const object = await objLoader.loadAsync(objUrl);
  return object;
}

let baseReferenceSpace: XRReferenceSpace | null = null;
const tempMatrix = new THREE.Matrix4();

async function run() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x505050);
  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    2,
    7
  );
  camera.position.set(0, 1, 3);

  scene.add(new THREE.HemisphereLight(0xa5a5a5, 0x898989, 3));

  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(0, 6, 0);
  scene.add(light);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100, 2, 2)
      .rotateX(-Math.PI / 2)
      .translate(0, 0.0001, 0),
    new THREE.MeshBasicMaterial({
      color: 0xbcbcbc,
    })
  );
  scene.add(floor);

  document.addEventListener("keydown", (event) => {
    if (event.key === "p") {
      event.preventDefault();
      const width = window.innerWidth;
      const height = window.innerHeight;

      const target = new THREE.WebGLRenderTarget(width, height, {});
      target.depthTexture = new THREE.DepthTexture(width, height);
      target.depthTexture.format = THREE.DepthFormat;
      target.depthTexture.type = THREE.UnsignedInt248Type;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);

      exportDepthTexture(renderer, target.depthTexture);
    }
  });

  const controllerModelFactory = new XRControllerModelFactory();
  createController(0, floor);
  createController(1, floor);

  const house = await loadModel("home/home.obj", "home/home.mtl");
  house.scale.set(0.01, 0.01, 0.01);
  scene.add(house);

  renderer.setAnimationLoop(render);
  window.addEventListener("resize", onWindowResize);
  renderer.xr.addEventListener("sessionstart", () => {
    baseReferenceSpace = renderer.xr.getReferenceSpace();
  });

  container.appendChild(renderer.domElement);

  const pointerLockControls = new PointerLockControls(camera, document.body);

  renderer.domElement.addEventListener("click", () => {
    pointerLockControls.lock();
  });

  const keyboard: { [key: string]: boolean } = {};
  document.addEventListener("keydown", (event) => {
    keyboard[event.key] = true;
    if (event.key === "Escape") {
      pointerLockControls.unlock();
    }
  });

  document.addEventListener("keyup", (event) => {
    delete keyboard[event.key];
  });

  document.body.appendChild(XRButton.createButton(renderer));

  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  function render() {
    scene.dispatchEvent({ type: "render" } as any);
    renderer.render(scene, camera);

    function bsign(b: boolean): number {
      return b ? 1 : -1;
    }
    const forward = bsign(keyboard.w) - bsign(keyboard.s);
    const right = bsign(keyboard.d) - bsign(keyboard.a);
    const localDirection = new THREE.Vector3(forward, 0, right);
    localDirection.normalize();

    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    const velocity = new THREE.Vector3();
    velocity.addScaledVector(cameraDirection, localDirection.x);
    velocity.addScaledVector(
      new THREE.Vector3(-cameraDirection.z, 0, cameraDirection.x),
      localDirection.z
    );
    camera.position.addScaledVector(velocity, 0.1);
  }

  function createController(index: number, floor: THREE.Mesh) {
    const controller = renderer.xr.getController(index);
    if (!controller) {
      return null;
    }
    let gamepad: Gamepad | undefined = undefined;
    controller.addEventListener("connected", (event) => {
      controller.add(buildController(event.data));
      scene.addEventListener("render", render);
      gamepad = event.data.gamepad;
    });
    controller.addEventListener("disconnected", () => {
      controller.remove(controller.children[0]);
      scene.removeEventListener("render", render);
    });
    scene.add(controller);

    const controllerGrip = renderer.xr.getControllerGrip(index);
    controllerGrip.add(
      controllerModelFactory.createControllerModel(controllerGrip)
    );
    scene.add(controllerGrip);

    const marker = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xbcbcbc })
    );
    scene.add(marker);

    const raycaster = new THREE.Raycaster();

    let buttonStates: boolean[] = [];

    let isSelecting = false;
    let INTERSECTION: THREE.Vector3 | undefined = undefined;
    function render() {
      const referenceSpace = renderer.xr.getReferenceSpace();
      if (!referenceSpace) return;

      const buttons = gamepad?.buttons ?? [];
      const buttonPressed = buttons.map(
        (button, index) => button.pressed && !buttonStates[index]
      );

      if (buttonPressed?.[5]) {
        house.translateY(-2.5);
      }
      if (buttonPressed?.[4]) {
        house.translateY(2.5);
      }

      buttonStates = buttons.map((button) => button.pressed);

      INTERSECTION = undefined;
      if (isSelecting) {
        tempMatrix.identity().extractRotation(controller.matrixWorld);

        raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
        raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

        const intersects = raycaster.intersectObjects([floor]);

        if (intersects.length > 0) {
          INTERSECTION = intersects[0].point;
        }
      }

      if (INTERSECTION) marker.position.copy(INTERSECTION);

      marker.visible = INTERSECTION !== undefined;
    }
    controller.addEventListener("selectstart", () => {
      isSelecting = true;
    });
    controller.addEventListener("selectend", () => {
      isSelecting = false;

      if (INTERSECTION && baseReferenceSpace) {
        const offsetPosition = {
          x: -INTERSECTION.x,
          y: -INTERSECTION.y,
          z: -INTERSECTION.z,
          w: 1,
        };
        const offsetRotation = new THREE.Quaternion();
        const transform = new XRRigidTransform(offsetPosition, offsetRotation);
        const teleportSpaceOffset =
          baseReferenceSpace.getOffsetReferenceSpace(transform);
        renderer.xr.setReferenceSpace(teleportSpaceOffset);
      }
    });

    return controller;
  }

  function buildController(data: XRInputSource) {
    switch (data.targetRayMode) {
      case "tracked-pointer":
        return buildTrackedPointerController();
      case "gaze":
        return buildGazeController();
      default:
        throw new Error("Unknown controller type");
    }
  }

  function buildTrackedPointerController(): THREE.Object3D {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3)
    );
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0, 0, 0], 3)
    );

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
    });

    return new THREE.Line(geometry, material);
  }

  function buildGazeController(): THREE.Object3D {
    const geometry = new THREE.RingGeometry(0.02, 0.04, 32).translate(0, 0, -1);
    const material = new THREE.MeshBasicMaterial({
      opacity: 0.5,
      transparent: true,
    });
    return new THREE.Mesh(geometry, material);
  }
}

run();
