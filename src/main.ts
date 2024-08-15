import "./style.css";
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader";
import { MTLLoader } from "three/addons/loaders/MTLLoader";
import { XRButton } from "three/addons/webxr/XRButton";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory";
import { PointerLockControls } from "three/examples/jsm/Addons.js";
import { TeleportMarker } from "./TeleportMarker";

const initialPosition = new THREE.Vector3(5, 0, 2.5);
const initialQuaternion = new THREE.Quaternion().setFromAxisAngle(
  { x: 0, y: 1, z: 0 },
  0.25 * Math.PI
);
const defaultEyeHeight = 1.6;

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

const tempMatrix = new THREE.Matrix4();

function isGroundIntersection(intersection: THREE.Intersection): boolean {
  console.log(intersection, intersection.object.name);
  return (intersection.normal?.y ?? 0) > 0.9;
}

type RayCaster = (
  ray: THREE.Ray,
  near: number,
  far: number
) => THREE.Intersection | null;

function createRayCaster(
  intersectObject: THREE.Object3D,
  recursive?: boolean
): RayCaster {
  const rayCaster = new THREE.Raycaster();
  return (ray: THREE.Ray, near: number, far: number) => {
    rayCaster.ray = ray;
    rayCaster.near = near;
    rayCaster.far = far;
    return rayCaster.intersectObject(intersectObject, recursive)?.[0] ?? null;
  };
}

class Arccaster {
  constructor(
    public gravity: THREE.Vector3,
    public readonly raycaster: THREE.Raycaster = new THREE.Raycaster()
  ) {}

  intersectObject(
    object: THREE.Object3D,
    position: THREE.Vector3,
    rotation: THREE.Quaternion
  ): { trace: THREE.Vector3[]; intersection?: THREE.Intersection } {
    position = position.clone();
    const velocity = new THREE.Vector3(0, 0, -1);
    velocity.applyQuaternion(rotation);

    const trace: THREE.Vector3[] = [position.clone()];
    const step = 0.2;
    const ray = new THREE.Ray();
    for (let x = 0; x < 50; x++) {
      velocity.addScaledVector(this.gravity, step);
      position.addScaledVector(velocity, step);

      if (trace.length > 0) {
        const lastPosition = trace[trace.length - 1];
        ray.origin.copy(lastPosition);
        ray.direction.copy(position).sub(lastPosition).normalize();
        this.raycaster.ray = ray;
        this.raycaster.near = 0;
        this.raycaster.far = lastPosition.distanceTo(position);
        const intersections = this.raycaster.intersectObject(object, true);
        if (intersections.length > 0) {
          const intersection = intersections[0];
          trace.push(intersection.point);
          return { trace, intersection };
        }
      }
      trace.push(position.clone());
    }
    return { trace };
  }
}

class TeleportationArc extends THREE.Object3D {
  public readonly line: THREE.Line;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.LineBasicMaterial;
  constructor(
    public readonly arccaster: Arccaster,
    public readonly marker: THREE.Object3D,
    public validateIntersection: (
      intersection: THREE.Intersection
    ) => boolean = isGroundIntersection
  ) {
    super();
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.LineBasicMaterial({ color: 0x00ff00 });
    this.line = new THREE.Line(this.geometry, this.material);
    this.line.frustumCulled = false;
  }

  update(object: THREE.Object3D, angle: number) {
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    this.getWorldPosition(position);
    this.getWorldQuaternion(rotation);
    const { intersection, trace } = this.arccaster.intersectObject(
      object,
      position,
      rotation
    );

    this.geometry.setFromPoints(trace);

    const hasIntersection =
      !!intersection && this.validateIntersection(intersection);

    if (hasIntersection) {
      this.marker.position.copy(intersection.point);
      if (intersection.normal) {
        this.marker.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      }
    }
    this.marker.visible = hasIntersection;
  }
}

class TeleportationControls {
  isTeleporting: boolean = false;
  teleportationAngle: number = 0;
  constructor(
    public readonly teleportationArc: TeleportationArc,
    public controller: THREE.XRTargetRaySpace
  ) {}

  start() {
    this.isTeleporting = true;
  }

  update(object: THREE.Object3D, angle: number = 0) {
    if (this.isTeleporting) {
      this.teleportationAngle = angle;
      this.teleportationArc.position.copy(this.controller.position);
      this.teleportationArc.rotation.copy(this.controller.rotation);
      this.teleportationArc.update(object, angle);
    }
    this.teleportationArc.line.visible = this.isTeleporting;
  }

  _stop() {
    this.isTeleporting = false;
    this.teleportationArc.line.visible = false;
    this.teleportationArc.marker.visible = false;
  }

  cancel() {
    this._stop();
  }

  commit(session: ThreeXRSession) {
    this._stop();

    session.setOffset(
      this.teleportationArc.marker.position,
      this.teleportationAngle
    );
  }
}

async function requestReferenceSpace(
  session: XRSession,
  type: "local-floor"
): Promise<XRReferenceSpace | null>;
async function requestReferenceSpace(
  session: XRSession,
  type: "viewer"
): Promise<XRReferenceSpace | null>;
async function requestReferenceSpace(
  session: XRSession,
  type: XRReferenceSpaceType
): Promise<XRReferenceSpace | XRBoundedReferenceSpace | null> {
  try {
    return await session.requestReferenceSpace(type);
  } catch (e: unknown) {
    console.warn(e);
    if (e instanceof DOMException && e.name === "NotSupportedError") {
      return null;
    }
    throw e;
  }
}

async function requestLocalFloorReferenceSpace(session: XRSession) {
  return await requestReferenceSpace(session, "local-floor");
}

async function requestViewerReferenceSpace(session: XRSession) {
  console.log("Using viewer reference space");
  const referenceSpace = await requestReferenceSpace(session, "viewer");
  return referenceSpace?.getOffsetReferenceSpace(
    new XRRigidTransform({ x: 0, y: -defaultEyeHeight, z: 0 })
  );
}

async function initializeThreeXRSession(webxrManager: THREE.WebXRManager) {
  const session = webxrManager.getSession();
  if (!session) {
    throw new Error("No session available");
  }
  const baseReferenceSpace =
    (await requestLocalFloorReferenceSpace(session)) ??
    (await requestViewerReferenceSpace(session));
  if (!baseReferenceSpace) {
    throw new Error("No supported reference space available");
  }
  return new ThreeXRSession(webxrManager, baseReferenceSpace);
}

class ThreeXRSession {
  constructor(
    public readonly webxrManager: THREE.WebXRManager,
    public readonly baseReferenceSpace: XRReferenceSpace
  ) {}

  setOffset(_position: THREE.Vector3, angle: number) {
    const rotation = new THREE.Quaternion();
    rotation.setFromAxisAngle({ x: 0, y: 1, z: 0 }, -angle);
    const position = new THREE.Vector3();
    position.copy(_position).negate().applyQuaternion(rotation);
    const offset = new XRRigidTransform(position, rotation);

    offset.orientation.matrixTransform();
    const offsetSpace = this.baseReferenceSpace.getOffsetReferenceSpace(offset);
    this.webxrManager.setReferenceSpace(offsetSpace);
  }
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

interface Disposable {
  dispose(): void;
}

class ThreeXRConnectedController extends THREE.Object3D {
  public readonly gamepad: Gamepad;
  public readonly controllerMesh = new THREE.Object3D();

  constructor(
    public readonly controller: ThreeXRController,
    inputSource: XRInputSource
  ) {
    super();
    const gamepad = inputSource.gamepad;
    if (!gamepad) {
      throw new Error("Gamepad not available");
    }
    if (gamepad.axes.length < 4) {
      throw new Error("Gamepad axes not available");
    }
    this.gamepad = inputSource.gamepad;
    this.controllerMesh = buildController(inputSource);
    this.add(this.controllerMesh);
  }
}

class ThreeXRController extends THREE.Object3D {
  public connectedController?: ThreeXRConnectedController;
  constructor(
    public readonly controller: THREE.XRTargetRaySpace,
    public readonly grip: THREE.XRGripSpace
  ) {
    super();
    this.handleControllerConnected = this.handleControllerConnected.bind(this);
    this.handleControllerDisconnected =
      this.handleControllerDisconnected.bind(this);
    controller.addEventListener("connected", this.handleControllerConnected);
    controller.addEventListener(
      "disconnected",
      this.handleControllerDisconnected
    );
  }

  handleControllerConnected(event: { data: XRInputSource }) {
    if (this.connectedController) {
      throw new Error("Controller already connected");
    }
    this.connectedController = new ThreeXRConnectedController(this, event.data);
    this.add(this.connectedController);
  }

  handleControllerDisconnected(_event: THREE.Event) {
    if (!this.connectedController) {
      return;
    }
    this.remove(this.connectedController);
    this.connectedController = undefined;
  }

  dispose() {
    this.controller.removeEventListener(
      "connected",
      this.handleControllerConnected
    );
    this.controller.removeEventListener(
      "disconnected",
      this.handleControllerDisconnected
    );
  }

  static fromWebXRManager(xrManager: THREE.WebXRManager, index: number) {
    const controller = xrManager.getController(index);
    if (!controller) {
      return null;
    }
    const grip = xrManager.getControllerGrip(index);
    const controllerModelFactory = new XRControllerModelFactory();
    grip.add(controllerModelFactory.createControllerModel(grip));
    return new ThreeXRController(controller, grip);
  }
}

async function run() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x505050);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
  camera.position.copy(initialPosition);
  camera.position.add({ x: 0, y: defaultEyeHeight, z: 0 });

  camera.quaternion.copy(initialQuaternion);

  scene.add(new THREE.HemisphereLight(0xa5a5a5, 0x898989, 3));

  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(0, 6, 0);
  scene.add(light);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  // const floor = new THREE.Mesh(
  //   new THREE.PlaneGeometry(100, 100, 2, 2)
  //     .rotateX(-Math.PI / 2)
  //     .translate(0, 0.0001, 0),
  //   new THREE.MeshBasicMaterial({
  //     color: 0xbcbcbc,
  //   })
  // );
  // scene.add(floor);

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

  const house = await loadModel("home/home.obj", "home/home.mtl");
  house.scale.set(0.01, 0.01, 0.01);
  scene.add(house);

  renderer.setAnimationLoop(render);
  onWindowResize();
  window.addEventListener("resize", onWindowResize);

  renderer.xr.addEventListener("sessionstart", async () => {
    const session = await initializeThreeXRSession(renderer.xr);

    session.setOffset(initialPosition, 0.25 * Math.PI);

    createController(0, scene, session);
    createController(1, scene, session);
  });

  container.appendChild(renderer.domElement);

  const pointerLockControls = new PointerLockControls(camera, document.body);

  pointerLockControls.addEventListener("lock", () => {
    renderer.domElement.ownerDocument.addEventListener("mousedown", mousedown);
  });

  pointerLockControls.addEventListener("unlock", () => {
    renderer.domElement.ownerDocument.removeEventListener(
      "mousedown",
      mousedown
    );
  });

  function mousedown(_e: MouseEvent) {}

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

  function createController(
    index: number,
    scene: THREE.Scene,
    session: ThreeXRSession
  ) {
    const controller = renderer.xr.getController(index);
    if (!controller) {
      return null;
    }
    scene.add(controller);

    const grip = renderer.xr.getControllerGrip(index);
    const controllerModelFactory = new XRControllerModelFactory();
    grip.add(controllerModelFactory.createControllerModel(grip));
    scene.add(grip);
    const threeController = new ThreeXRController(controller, grip);

    const marker = new TeleportMarker();
    marker.visible = false;
    scene.add(marker);
    const arc = new TeleportationArc(
      new Arccaster(new THREE.Vector3(0, -0.1, 0)),
      marker
    );
    scene.add(arc.line);
    scene.add(arc);
    const teleportationControls = new TeleportationControls(
      arc,
      threeController.controller
    );

    scene.addEventListener("render", update);

    function update() {
      const connectedController = threeController?.connectedController;
      if (!connectedController) {
        return;
      }
      const gamepad = connectedController.gamepad;
      const [, , x, y] = connectedController.gamepad.axes;
      const gamepadStickAngle = new THREE.Vector2(-y, -x).angle();
      const controllerAngle = new THREE.Euler().setFromQuaternion(
        threeController.controller.quaternion,
        "YXZ"
      ).y;
      const teleportAngle = gamepadStickAngle + controllerAngle;

      if (teleportationControls.isTeleporting) {
        if (x === 0 && y === 0) {
          if (marker.visible) {
            teleportationControls.commit(session);
          } else {
            teleportationControls.cancel();
          }
        } else {
          teleportationControls.update(house, teleportAngle);
        }
      } else {
        if (Math.sqrt(x * x + y * y) > 0.5) {
          teleportationControls.start();
        }
      }

      const buttons = gamepad?.buttons ?? [];
      const buttonStates = gamepad.buttons.map((button) => button.pressed);
      const buttonPressed = buttons.map(
        (button, index) => button.pressed && !buttonStates[index]
      );

      if (buttonPressed?.[5]) {
        house.translateY(-2.5);
      }
      if (buttonPressed?.[4]) {
        house.translateY(2.5);
      }
    }

    return threeController;
  }
}

run();
