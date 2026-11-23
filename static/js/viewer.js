// The mesh viewer: each scene's ten extracted meshes, rotatable, with a
// slider through time. A scene's meshes download only when it is picked.
// They keep the scene's own axes, so the view starts at the scene's first
// training camera as its transforms give it.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const root = document.getElementById("mesh-viewer");
const stage = root.querySelector(".viewer-stage");
const status = root.querySelector(".viewer-status");
const slider = root.querySelector(".viewer-time input");
const frameLabel = root.querySelector(".viewer-frame");
const scenes = JSON.parse(root.dataset.scenes);

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch (e) {
    return false;
  }
}

function unavailable(reason) {
  stage.textContent = reason;
  root.querySelector(".viewer-time").hidden = true;
  status.textContent = "";
}

if (!hasWebGL()) {
  unavailable("The mesh viewer needs WebGL, which this browser does not provide.");
} else {
  try {
    start();
  } catch (e) {
    unavailable("The mesh viewer could not start in this browser.");
  }
}

function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // The page's own message stands in until the script runs.
  stage.textContent = "";
  stage.appendChild(renderer.domElement);
  const world = new THREE.Scene();
  world.background = new THREE.Color(0xffffff);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 1000);
  // The key light rides with the camera, so the side in view stays lit. The
  // hemisphere's sky is set to each scene's up when the scene is placed.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 1.6);
  world.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(0.3, 0.5, 1);
  camera.add(key);
  world.add(camera);
  const material = new THREE.MeshStandardMaterial({
    color: 0xc8c8c8, roughness: 0.85, metalness: 0, flatShading: true, side: THREE.DoubleSide,
  });
  // OrbitControls fixes its orbit axis from camera.up when it is created, so
  // each scene gets new controls once camera.up holds the scene's up.
  let controls = new OrbitControls(camera, renderer.domElement);

  const draco = new DRACOLoader();
  draco.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/");
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  const loaded = {};   // scene id -> {meta, meshes}
  let current = null, aspect = 16 / 9, token = 0, zoomRange = [0, Infinity];

  // The wheel zooms here rather than in OrbitControls, whose r160 step
  // divides by the pixel ratio rounded down, which is zero below a ratio of
  // one and would turn any scroll into an infinite jump. Each event moves the
  // camera a bounded fraction toward or away from the orbit target, within
  // the scene's range. Pinch zoom on touch screens stays with the controls.
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const scale = Math.exp(Math.max(-0.2, Math.min(0.2, pixels * 0.0015)));
    const offset = camera.position.clone().sub(controls.target);
    const length = Math.min(Math.max(offset.length() * scale, zoomRange[0]), zoomRange[1]);
    camera.position.copy(controls.target).add(offset.setLength(length));
  }, { capture: true, passive: false });

  function resize() {
    const width = stage.clientWidth;
    const height = Math.min(width / aspect, window.innerHeight * 0.7);
    renderer.setSize(width, height, false);
    renderer.domElement.style.height = height + "px";
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);

  function showFrame(i) {
    if (!current) return;
    current.meshes.forEach((m, k) => { m.visible = k === i; });
    frameLabel.textContent = "Frame " + current.meta.frames[i];
  }

  function placeCamera(meta, first) {
    const m = meta.camera.transform_matrix;
    const pose = new THREE.Matrix4().set(...m[0], ...m[1], ...m[2], ...m[3]);
    const position = new THREE.Vector3().setFromMatrixPosition(pose);
    const up = new THREE.Vector3(...meta.up);
    const forward = new THREE.Vector3().setFromMatrixColumn(pose, 2).normalize().negate();
    const box = new THREE.Box3().setFromObject(first);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    // The orbit target lies on the camera's axis, level with the mesh's
    // center, so the first view is the starting camera's own, turned only to
    // stand upright about the scene's up.
    const depth = Math.max(center.clone().sub(position).dot(forward), size * 0.05);
    aspect = meta.camera.aspect;
    camera.fov = THREE.MathUtils.radToDeg(meta.camera.fov_y);
    camera.near = size / 1000;
    camera.far = size * 20 + position.distanceTo(center);
    camera.position.copy(position);
    camera.up.copy(up);
    hemi.position.copy(up);
    controls.dispose();
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.panSpeed = 1.5;
    zoomRange = [size * 0.02, Math.max(size * 5, depth * 2)];
    controls.target.copy(position.clone().add(forward.multiplyScalar(depth)));
    controls.update();
    resize();
  }

  async function pick(id, button) {
    root.querySelectorAll(".viewer-scenes button").forEach((b) => b.classList.toggle("on", b === button));
    const mine = ++token;
    if (current) current.meshes.forEach((m) => { m.visible = false; });
    current = null;
    if (!loaded[id]) {
      const title = scenes.find((s) => s.id === id).title;
      status.textContent = `Loading the ${title} meshes`;
      try {
        // Revalidated, so an updated camera is never read from a stale cache.
        const meta = await (await fetch(`meshes/${id}/scene.json`, { cache: "no-cache" })).json();
        let done = 0;
        status.textContent = `Loading the ${title} meshes, 0 of ${meta.frames.length}`;
        const meshes = await Promise.all(meta.frames.map((f) =>
          loader.loadAsync(`meshes/${id}/frame_${String(f).padStart(4, "0")}.glb`).then((gltf) => {
            gltf.scene.traverse((o) => { if (o.isMesh) o.material = material; });
            gltf.scene.visible = false;
            world.add(gltf.scene);
            done += 1;
            if (mine === token) status.textContent = `Loading the ${title} meshes, ${done} of ${meta.frames.length}`;
            return gltf.scene;
          })));
        loaded[id] = { meta, meshes };
      } catch (e) {
        if (mine === token) status.textContent = `The ${title} meshes could not be loaded.`;
        return;
      }
    }
    if (mine !== token) return;
    current = loaded[id];
    status.textContent = "";
    slider.max = current.meshes.length - 1;
    slider.value = 0;
    placeCamera(current.meta, current.meshes[0]);
    showFrame(0);
  }

  slider.addEventListener("input", () => showFrame(Number(slider.value)));
  const bar = root.querySelector(".viewer-scenes");
  const buttons = scenes.map((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.title;
    b.addEventListener("click", () => pick(s.id, b));
    bar.appendChild(b);
    return b;
  });
  status.textContent = "The meshes load when the viewer comes into view.";

  // The first scene loads when the viewer first comes into view, and the
  // viewer draws only while it is on screen.
  let started = false;
  new IntersectionObserver((entries) => {
    const visible = entries[entries.length - 1].isIntersecting;
    if (visible && !started) {
      started = true;
      pick(scenes[0].id, buttons[0]);
    }
    renderer.setAnimationLoop(visible ? () => {
      controls.update();
      renderer.render(world, camera);
    } : null);
  }, { rootMargin: "200px 0px" }).observe(root);
}
