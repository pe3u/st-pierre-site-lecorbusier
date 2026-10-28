// Saint-Pierre Firminy: interactive 3D viewer (white stage, real-time sun and shadows, ambient occlusion, cut-away, axonometric view, anchored notes).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const CENTRE_B = new THREE.Vector3(12.5, 11.0, 0.0);      // building centre in Blender metres; real east = +Y
const b2t = (x, y, z) => new THREE.Vector3(x - CENTRE_B.x, z, -(y - CENTRE_B.y));   // Blender (x,y,z) -> viewer (x,y,z), centred
const easeOut = (t) => 1 - Math.pow(1 - t, 3.4);
const SPIN_RATE = 2 * Math.PI / 60 * 0.55, INTRO_MS = 7000, SWEEP = 0.95;          // spin speed in rad/s (OrbitControls: 2π/60 per unit of speed), intro length, intro sweep angle
const easeOutSoft = (t) => { const k = SPIN_RATE * (INTRO_MS / 1000) / SWEEP; return (1 - k) * (1 - Math.pow(1 - t, 2.4)) + k * t; };       // fast at first, then slower, ending at exactly the spin's speed       // the sideways sweep keeps going a little longer than the approach          // the approach: fast at first, then slower and slower
const HERO_POS = new THREE.Vector3(89.59, 6.81, 42.32), HERO_TGT = new THREE.Vector3(3.33, 6.81, -2.52);   // the hero / reset camera
const HERO_TGT_S = new THREE.Vector3(3.33, 13.5, -2.52), HERO_POS_S = HERO_TGT_S.clone().add(HERO_POS.clone().sub(HERO_TGT).multiplyScalar(1.12));   // short, wide stage: aimed higher and a little further, so the cone's tip and the foot of the building are both in view
let heroShort = false;
const SPIN_SPEED = 0.55;
const SUN_RATE = 11.5 / (60 / 0.55);                       // sun hours per second: a whole day while the camera makes one turn
let sunAz = 0, camAzPrev = null, sunAcc = null, sunDone = false;                          // the sun turns round the church by the same angle as the camera while it spins: the light keeps the same angle to the view                                  // slow auto-spin (OrbitControls units: 2.0 is one turn in 30 s)
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const EXPOSURE = 2.8;
const LAT = 45.38 * Math.PI / 180; let DECL = 10.3 * Math.PI / 180;       // Firminy; the declination follows the day of the year (25 August to start)
const declFor = (n) => 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (284 + n) / 365);         // day of the year 1..365 -> solar declination
const halfDay = () => Math.acos(Math.max(-1, Math.min(1, -Math.tan(LAT) * Math.tan(DECL)))) * 12 / Math.PI;   // hours from noon to sunset

/** unit vector towards the sun in viewer space for a solar time in hours (viewer +x = Blender +x = south, viewer -z = east) */
function sunVector(hours) {
  const H = (hours - 12) * 15 * Math.PI / 180;
  const up = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H);
  const east = -Math.cos(DECL) * Math.sin(H);
  const north = Math.sin(DECL) * Math.cos(LAT) - Math.cos(DECL) * Math.sin(LAT) * Math.cos(H);
  const v = new THREE.Vector3(-north, up, -east);                      // Blender (x=-north, y=east, z=up) -> viewer (x, z, -y)
  return v.normalize();
}

// back faces are what you see through a cut in a solid wall: draw them pitch black (section poché)
const POCHE = `#include <dithering_fragment>
if (!gl_FrontFacing) gl_FragColor.rgb = vec3(0.0);`;
function withPoche(m) { const prev = m.onBeforeCompile; m.onBeforeCompile = (sh, r) => { if (prev) prev(sh, r); sh.fragmentShader = sh.fragmentShader.replace("#include <dithering_fragment>", POCHE); }; const base = m.customProgramCacheKey.bind(m); m.customProgramCacheKey = () => base() + "|poche"; return m; }

let litLamps = null; const floodRef = [];
const litU = { value: 0 };        // 0..1: the evening lights (lit windows, brighter cannons, facade floodlights), switched on from 17:30
// concrete: one flat neutral grey (same mean tone as the old texture), standard PBR lighting: no texture reads, no bump, nothing to stripe
function concreteMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x9c9c9a, roughness: 0.93, metalness: 0, side: THREE.DoubleSide });
  m.clipShadows = true;
  return withPoche(m);
}

export async function createViewer(root, opts) {
  const { modelUrl, contextUrl, treesUrl, hotspots = [], onProgress } = opts;
  const stage = root.querySelector(".v3-stage");
  // phones and tablets (or ?lite): lighter pipeline. Fewer real lights, smaller shadow maps, no occlusion pass, no extra shadow-casting lamps, pixel ratio 1.
  const lite = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform)) || /[?&]lite/.test(location.search);
  const renderer = new THREE.WebGLRenderer({ antialias: lite, alpha: true, powerPreference: "high-performance", stencil: false });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  let dirty = true, dirtyUntil = performance.now() + 3000, shadowStale = true;       // render on demand: frames are drawn only when something changed
  renderer.shadowMap.enabled = true; renderer.shadowMap.autoUpdate = false;           // the shadow map is redrawn only when the sun, the cut or the lights change, not on every camera move
  renderer.shadowMap.type = lite ? THREE.PCFShadowMap : THREE.VSMShadowMap;      // variance shadow maps: their blur radius gives soft shadow edges (phones keep the cheaper PCF)
  renderer.localClippingEnabled = false;
  stage.prepend(renderer.domElement);
  renderer.domElement.className = "v3-canvas";

  const scene = new THREE.Scene();
  const persp = new THREE.PerspectiveCamera(26, 1, 12, 1600);
  const ortho = new THREE.OrthographicCamera(-50, 50, 30, -30, 180, 1400);
  let camera = persp;
  const controls = new OrbitControls(persp, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.minDistance = 22; controls.maxDistance = 1400; controls.maxPolarAngle = Math.PI * 0.495;
  controls.autoRotate = false;
  controls.target.copy(HERO_TGT);
  persp.position.copy(HERO_POS);
  const heroTgt = () => (heroShort ? HERO_TGT_S : HERO_TGT), heroPos = () => (heroShort ? HERO_POS_S : HERO_POS);
  let userMoved = false;

  // ---- section plane (global clipping: it also cuts the shadow maps and the occlusion pass)
  const cutPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 80);
  const setCut = (on) => { renderer.clippingPlanes = on ? [cutPlane] : []; };

  // ---- light: sun + sky + a little image-based light for the glass
  const sun = new THREE.DirectionalLight(0xfff0dc, 4.5);
  sun.castShadow = true; sun.shadow.mapSize.set(lite ? 1024 : 4096, lite ? 1024 : 4096);
  const sc = sun.shadow.camera; sc.left = -38; sc.right = 38; sc.top = 38; sc.bottom = -38; sc.near = 1; sc.far = 260;
  sc.updateProjectionMatrix(); sun.shadow.bias = -0.001; sun.shadow.normalBias = 0.12; sun.shadow.radius = 5; sun.shadow.blurSamples = 16;
  scene.add(sun, sun.target); sun.target.position.set(0, 12, 0);
  const fill = new THREE.DirectionalLight(0xffeedd, 0); fill.position.set(140, 45, 20); scene.add(fill, fill.target); fill.target.position.set(0, 10, 0);   // stands in for the light that would come through the cut
  const hemi = new THREE.HemisphereLight(0xd4e2ff, 0xa9a39a, 0.9);
  scene.add(hemi);
  const pm = new THREE.PMREMGenerator(renderer);
  // reflections for the glass: a simple surroundings dome (sky, warm horizon, grass, sun) turned into an environment map
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: "varying vec3 vD; void main() { vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "varying vec3 vD; void main() { float h = vD.y; vec3 sky = mix(vec3(0.95, 0.86, 0.74), vec3(0.28, 0.5, 1.0), smoothstep(0.0, 0.55, h)) * 2.2; vec3 gnd = mix(vec3(0.55, 0.56, 0.5), vec3(0.16, 0.2, 0.1), smoothstep(0.0, -0.4, h)) * 1.1; gl_FragColor = vec4(h > 0.0 ? sky : mix(sky, gnd, smoothstep(0.0, -0.04, h)), 1.0); }",
  })));
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(60, 52, 40) }));
  sunBall.position.copy(sunVector(14.5)).multiplyScalar(90); envScene.add(sunBall);
  const envTex = pm.fromScene(envScene, 0.02).texture;

  // ---- model + materials
  const concrete = concreteMaterial();
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(modelUrl, (e) => { if (e.total && onProgress) onProgress(e.loaded / e.total); });
  const model = gltf.scene;
  model.position.set(-CENTRE_B.x, 0, CENTRE_B.y);                     // Blender (x,y,z) -> (x, z, -y), then centred on the building
  const glowLights = [], glowMeshes = [], glowMats = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    let n = o.name, p = o.parent; while (p && !/^web_/.test(n)) { n = p.name; p = p.parent; }
    const src = o.material, group = (n.match(/^web_(\w+?)(?:_\d+)?$/) || [])[1] || "other";
    o.frustumCulled = false;
    let mat;
    if (group === "concrete") { mat = concrete; mat.polygonOffset = true; mat.polygonOffsetFactor = 1.5; mat.polygonOffsetUnits = 2; o.castShadow = o.receiveShadow = true; }
    else if (group === "glass") {
      mat = new THREE.MeshPhysicalMaterial({ color: 0xf4f9fb, roughness: 0.015, metalness: 0, transparent: true, opacity: 0.012, side: THREE.DoubleSide, envMap: envTex, envMapIntensity: 0.55, ior: 1.5, depthWrite: false, clipShadows: true, specularIntensity: 1.0 });
      mat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace("#include <opaque_fragment>", "#include <opaque_fragment>\nfloat frG = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 3.0); gl_FragColor.a = clamp(gl_FragColor.a + frG * 0.2, 0.0, 1.0);");
      };
      mat.customProgramCacheKey = () => "glassfr6";
      o.renderOrder = 5; o.castShadow = false; o.receiveShadow = false;
    } else if (group === "ground") {
      const nm = (src.name || "").toLowerCase();
      const col = /light/.test(nm) ? 0xf6f6f4 : /road/.test(nm) ? 0xb6b6b7 : 0x7f9c58;
      mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.96, metalness: 0, side: THREE.DoubleSide, transparent: false, depthWrite: true, clipShadows: true });
      const lawn = !/road/.test(nm);          // height curves (contour lines) on the lawns only
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vGP;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvGP = (modelMatrix * vec4(position, 1.0)).xyz;");
        if (lawn) sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
{
  float hgt = vGP.y;                                   // metres above the model's zero
  float f1 = hgt / 0.1;                                // one thin curve every 10 cm of height, all the same weight
  float w1 = max(fwidth(f1), 1e-4);
  float d1 = abs(fract(f1 - 0.5) - 0.5) / w1;          // distance to the nearest curve, in pixels
  float l1 = (1.0 - clamp(d1 / 0.6, 0.0, 1.0)) * (1.0 - smoothstep(0.45, 0.85, w1)) * smoothstep(0.004, 0.03, fwidth(f1));   // a perfectly flat patch sitting exactly on a contour height would be painted entirely as a line: no line where the ground is flat   // hairline; fades out when the curves get denser than the pixels
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.05, 0.055), clamp(l1 * 0.85, 0.0, 1.0));
}`);

        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vGP;");
      };
      mat.customProgramCacheKey = () => "ground17" + (lawn ? "c" : "");
      o.castShadow = false; o.receiveShadow = true; o.userData.ground = true; o.renderOrder = -1; mat.polygonOffset = true; mat.polygonOffsetFactor = -6; mat.polygonOffsetUnits = -12;     // above the flat layers of the surroundings
    } else if (group === "glow") {
      const c = (src.emissive && src.emissive.getHex() > 0 ? src.emissive : src.color).clone();
      const k = 1.0 / Math.max(c.r, c.g, c.b, 1e-3); c.multiplyScalar(Math.min(k, 1.0));
      mat = new THREE.MeshBasicMaterial({ color: c, side: THREE.FrontSide, toneMapped: true });
      mat.color.multiplyScalar(1.3); mat.clipShadows = true; o.castShadow = false; mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
      glowMeshes.push({ o, c }); glowMats.push({ mat, base: mat.color.clone() });
    } else {
      const wood = group === "wood";
      const vc = !!o.geometry.attributes.color;          // the paints, black metal, wire and stone arrive as vertex colours on one mesh
      mat = new THREE.MeshStandardMaterial({ color: vc ? 0xffffff : src.color.clone(), vertexColors: vc, roughness: wood ? 0.5 : 0.75, metalness: 0, side: THREE.DoubleSide, clipShadows: true });
      withPoche(mat); mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1;
      o.castShadow = o.receiveShadow = true;
    }
    o.material = mat;
  });
  scene.add(model);

  // ---- the surroundings, 200 m round the church (OpenStreetMap footprints, roads and green areas; heights and roof types from IGN BD TOPO): one flat colour per kind,
  // white buildings with their real height and roof type, level with the terrain (z = -2.9) (no fade)
  const CTX_COL = { site: [0x7f9c58, -7], base: [0x7f9c58, -6], green: [0x7f9c58, -5], forest: [0x7f9c58, -5], sport: [0x7f9c58, -4], pitch: [0x7f9c58, -4], parking: [0xffffff, -4], sidewalk: [0xffffff, -3], road: [0xb6b6b7, -2] };
  const ctxLit = [];                                                  // the surroundings' white materials: their glow follows the sun, so the buildings darken towards evening and night
  const siteMeshes = [], siteRoot = new THREE.Group(); scene.add(siteRoot);
  const ctxRoot = new THREE.Group(); ctxRoot.visible = true; scene.add(ctxRoot);
  const ctxC0 = { value: new THREE.Vector2(0.25, -1.73) };                       // the church centre in viewer coordinates
  if (contextUrl) loader.loadAsync(contextUrl).then((g) => {
    g.scene.position.copy(model.position);
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      const key = (o.name.match(/^ctx_(\w+?)(?:_\d+)?$/) || [])[1]; if (!key) return;
      const bld = key.startsWith("b_"), def = bld ? [0xffffff, 0] : CTX_COL[key]; if (!def) return;
      if (key === "site") {                                   // a lawn floor under the site's terrain: it closes the hairline gaps between the terrain meshes
        o.material = new THREE.MeshStandardMaterial({ color: def[0], roughness: 0.96, metalness: 0, side: THREE.DoubleSide }); o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; siteMeshes.push(o); return;
      }
      const m = new THREE.MeshStandardMaterial({ color: def[0], roughness: 0.95, metalness: 0, transparent: false, depthWrite: true, side: bld ? THREE.FrontSide : THREE.DoubleSide });
      if (bld || key === "sidewalk" || key === "parking") { m.emissive = new THREE.Color(0xffffff); m.emissiveIntensity = bld ? 0.85 : 0.55; ctxLit.push({ m, base: m.emissiveIntensity }); }            // sunlit white faces reach the page's pure white
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uC0 = ctxC0;
        sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vCW;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvCW = (modelMatrix * vec4(position, 1.0)).xyz;");
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vCW; uniform vec2 uC0;");
      };
      m.customProgramCacheKey = () => "ctx200c";
      if (!bld) { const k = def[1] + 7; m.polygonOffset = true; m.polygonOffsetFactor = -k; m.polygonOffsetUnits = -2 * k; }      // the flat layers lie almost level: each one is drawn a step nearer than the one under it, so they no longer flicker from afar
      o.material = m; o.renderOrder = def[1]; o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false;
    });
    g.scene.updateMatrixWorld(true); for (const m of siteMeshes) siteRoot.attach(m);
    ctxRoot.add(g.scene); applySun();
  }).catch((e) => console.warn("surroundings not loaded", e));


  // interior glow: a few coloured point lights placed on the glowing parts (only switched on in the section view)
  const intLights = [];
  for (const { o, c } of glowMeshes) {
    o.geometry.computeBoundingBox();
    const pos = o.geometry.attributes.position, nv = pos.count, want = Math.min(6, Math.max(1, Math.round(nv / 120)));
    const col = c.clone(); const mx = Math.max(col.r, col.g, col.b, 1e-3); col.multiplyScalar(1 / mx);
    for (let i = 0; i < want && intLights.length < (lite ? 3 : 14); i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, Math.floor((i + 0.5) * nv / want)).add(model.position);
      const L = new THREE.PointLight(col, 0, 14, 1.6); L.position.copy(v); scene.add(L); intLights.push(L);
    }
  }

  // architectural facade lighting: one wide flood light per facade, 46 m out from the church, on the ground and aimed up the wall; these are real lights, so they cast shadows (reveals, balconies, the ramp)
  const flood = [];
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2, L = new THREE.SpotLight(0xffc38a, 0, 130, 0.405, 0.9, 1.1);
    L.position.set(Math.cos(a) * 46, 0.6, Math.sin(a) * 46); L.target.position.set(Math.cos(a) * 6, 9, Math.sin(a) * 6);
    L.castShadow = true; L.shadow.mapSize.set(lite ? 512 : 1024, lite ? 512 : 1024); L.shadow.camera.near = 2; L.shadow.camera.far = 110; L.shadow.bias = -0.0006; L.shadow.normalBias = 0.05; L.shadow.radius = lite ? 3 : 7; L.shadow.blurSamples = 16;
    scene.add(L, L.target); flood.push(L); floodRef.push(L);
  }

  // evening interior lighting: lamps hung inside, behind the windows (found from the glass); a few also cast real light on the walls
  const lampLights = [];
  {
    const gl = []; model.traverse((o) => { if (o.isMesh && o.renderOrder === 5) gl.push(o); });
    const cells = new Map(), P = new THREE.Vector3();
    for (const o of gl) { const pos = o.geometry.attributes.position; o.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i += 3) { P.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); if (P.y < 0.3) continue;
        const k = Math.floor(P.x / 4.5) + "_" + Math.floor((P.y - 0.3) / 3.4) + "_" + Math.floor(P.z / 4.5);
        const c = cells.get(k) || { n: 0, x: 0, y: 1e9, z: 0 }; c.n++; c.x += P.x; c.z += P.z; c.y = Math.min(c.y, P.y); cells.set(k, c); } }
    const list = [...cells.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 36);
    const fix = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: true });
    list.forEach((c, i) => {
      const x = c.x / c.n, z = c.z / c.n, d = Math.hypot(x, z) || 1, y = Math.min(c.y + 2.5, 15.2);
      const px = x - (x / d) * 2.4, pz = z - (z / d) * 2.4;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 0.7), fix); m.position.set(px, y, pz); scene.add(m);
      if (i < (lite ? 2 : 9)) { const L = new THREE.PointLight(0xffc88a, 0, 13, 1.5); L.position.set(px, y - 0.3, pz); scene.add(L); lampLights.push(L); }
    });
    litLamps = { fix, base: new THREE.Color(0xffd9a0), lights: lampLights };
  }

  // people for scale: slender black paper-doll figures (thin limbs, a tapered dress or coat, a small head), slowly animated:
  // walkers, pairs talking and looking at the church, people pointing up at it, and inside: standing, looking and pointing at the star wall and the roof lights
  const blk = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
  const groundMeshes = []; model.traverse((o) => { if (o.userData.ground) groundMeshes.push(o); });
  const ray = new THREE.Raycaster();
  const groundAt = (vx, vz) => { ray.set(new THREE.Vector3(vx, 80, vz), new THREE.Vector3(0, -1, 0)); const h = ray.intersectObjects(groundMeshes, false)[0]; return h ? h.point.y : null; };
  const cyl = (r0, r1, len, sx = 1, sz = 1) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 9, 1), blk); m.scale.set(sx, 1, sz); return m; };
  function stick(h, kind) {
    const root = new THREE.Group(), hip = new THREE.Group(); hip.position.y = h * 0.5; root.add(hip);
    const limb = (len, r, parent, x, y) => { const pv = new THREE.Group(); pv.position.set(x, y, 0); const m = cyl(r * 0.8, r, len); m.position.y = -len / 2; pv.add(m); parent.add(pv); return pv; };
    const L = {};
    L.thL = limb(h * 0.25, h * 0.013, hip, -h * 0.032, 0); L.thR = limb(h * 0.25, h * 0.013, hip, h * 0.032, 0);
    L.shL = limb(h * 0.25, h * 0.011, L.thL, 0, -h * 0.25); L.shR = limb(h * 0.25, h * 0.011, L.thR, 0, -h * 0.25);
    for (const sh of [L.shL, L.shR]) { const ft = new THREE.Mesh(new THREE.BoxGeometry(h * 0.02, h * 0.012, h * 0.07), blk); ft.position.set(0, -h * 0.255, h * 0.02); sh.add(ft); }
    L.torso = new THREE.Group(); hip.add(L.torso);
    const spec = { dress: [0.44, 0.115, 0.04, 0.11], coat: [0.37, 0.085, 0.042, 0.135], slim: [0.32, 0.05, 0.04, 0.16] }[kind];
    const body = cyl(spec[1] * h, spec[2] * h, spec[0] * h, 1, 0.55); body.position.y = spec[3] * h; L.torso.add(body);
    const neck = cyl(h * 0.010, h * 0.012, h * 0.05); neck.position.y = h * 0.345; L.torso.add(neck);
    L.head = new THREE.Group(); L.head.position.set(0, h * 0.355, 0); L.torso.add(L.head);
    const hd = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), blk); hd.scale.set(h * 0.034, h * 0.047, h * 0.038); hd.position.y = h * 0.045; L.head.add(hd);
    L.shL2 = limb(h * 0.17, h * 0.0105, L.torso, -h * 0.055, h * 0.30); L.shR2 = limb(h * 0.17, h * 0.0105, L.torso, h * 0.055, h * 0.30);
    L.elL = limb(h * 0.165, h * 0.0085, L.shL2, 0, -h * 0.17); L.elR = limb(h * 0.165, h * 0.0085, L.shR2, 0, -h * 0.17);
    root.traverse((m) => { if (m.isMesh) m.castShadow = true; });
    return { root, hip, h, ...L };
  }
  const TAU = Math.PI * 2, wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const CH = b2t(12.5, 11.0, 14.0);                        // the church, as a look-at point
  const anims = [];
  const yawTo = (px, pz, tx, tz) => Math.atan2(tx - px, tz - pz);
  const look = (fg, bodyYaw, tx, tz, up = 0, maxTurn = 1.1) => { const px = fg.root.position.x, pz = fg.root.position.z; fg.head.rotation.y = Math.max(-maxTurn, Math.min(maxTurn, wrap(yawTo(px, pz, tx, tz) - bodyYaw))); fg.head.rotation.x = -up; };
  const rest = (fg) => { fg.thL.rotation.x = fg.thR.rotation.x = fg.shL.rotation.x = fg.shR.rotation.x = 0; fg.shL2.rotation.set(0, 0, -0.05); fg.shR2.rotation.set(0, 0, 0.05); fg.elL.rotation.x = fg.elR.rotation.x = -0.1; };

  // --- a person who walks slowly back and forth along a polyline (Blender x, y)
  function walker(pts, h, kind, speed, phase) {
    const fg = stick(h, kind), P = pts.map(([bx, by, bz]) => { const v = b2t(bx, by, bz); v.y += 0.02; return v; });
    const seg = [0]; for (let i = 1; i < P.length; i++) seg.push(seg[i - 1] + P[i].distanceTo(P[i - 1]));
    const Ltot = seg[seg.length - 1]; scene.add(fg.root);
    anims.push((t) => {
      let d = ((t * speed + phase) % (2 * Ltot)); const back = d > Ltot; if (back) d = 2 * Ltot - d;
      let i = 1; while (i < seg.length - 1 && seg[i] < d) i++;
      const k = (d - seg[i - 1]) / Math.max(1e-6, seg[i] - seg[i - 1]), p = P[i - 1].clone().lerp(P[i], k);
      const dir = P[i].clone().sub(P[i - 1]); if (back) dir.negate();
      const w = t * speed * TAU / 1.3 + phase;           // one stride every ~2.6 m
      fg.root.position.copy(p); fg.root.rotation.y = Math.atan2(dir.x, dir.z);
      fg.hip.position.y = h * 0.5 * (1 - 0.012 * (1 - Math.cos(2 * w)) * 0.5) - 0.0;
      const sw = 0.30; fg.thL.rotation.x = -Math.sin(w) * sw; fg.thR.rotation.x = Math.sin(w) * sw;
      fg.shL.rotation.x = Math.max(0, Math.sin(w + 1.2)) * 0.45; fg.shR.rotation.x = Math.max(0, -Math.sin(w + 1.2)) * 0.45;
      fg.shL2.rotation.set(Math.sin(w) * 0.22, 0, -0.06); fg.shR2.rotation.set(-Math.sin(w) * 0.22, 0, 0.06); fg.elL.rotation.x = fg.elR.rotation.x = -0.18;
      fg.head.rotation.y = Math.sin(t * 0.3 + phase) * 0.25; fg.head.rotation.x = 0;
    });
  }
  // --- a person standing at (Blender x, y, z): "talk" with a partner, "church" looking at the church (one arm lifts as if shading eyes / pointing), "point" pointing at a target, "gaze" looking up
  const cityFolk = []; let citySink = null;                                              // people standing in the surroundings: they go with the City button
  function stander(bx, by, bz, h, kind, mode, target, phase, ghost = false, view = null) {
    const fg = stick(h, kind), v = b2t(bx, by, bz); fg.root.position.copy(v); scene.add(fg.root); if (citySink) citySink.push(fg.root);
    const tv = target ? b2t(target[0], target[1], target[2] || 0) : CH;
    const vw = view ? b2t(view[0], view[1], view[2] || 0) : CH;                           // what they look towards (the church, or the star wall inside)
    let yaw0 = yawTo(v.x, v.z, tv.x, tv.z) + (mode === "talk" ? 0.35 * (phase % 1 > 0.5 ? 1 : -1) : 0);
    if (mode === "chat") { const yc = yawTo(v.x, v.z, vw.x, vw.z); yaw0 = yaw0 + 0.7 * wrap(yc - yaw0); }       // the body turns most of the way towards the church; the head shares the look between the partner and the church
    fg.root.rotation.y = yaw0; rest(fg);
    const hdist = Math.hypot(tv.x - v.x, tv.z - v.z) + 1e-3, elev = Math.atan2(tv.y - (v.y + h * 0.9), hdist);
    anims.push((t) => {
      const w = t + phase * 7;
      fg.hip.position.y = h * 0.5 + Math.sin(w * 0.6) * h * 0.003;                       // breathing
      fg.torso.rotation.z = Math.sin(w * 0.35) * 0.025; fg.thL.rotation.x = Math.sin(w * 0.25) * 0.03; fg.thR.rotation.x = -Math.sin(w * 0.25) * 0.03;
      if (mode === "talk") {                                                             // explains with slow hand gestures, now and then looks at the church
        const g = Math.sin(w * 0.55) * 0.5 + 0.5;
        fg.shR2.rotation.set(-0.45 - 0.5 * g, 0.2, 0.25); fg.elR.rotation.x = -1.2 + 0.5 * Math.sin(w * 0.9);
        fg.shL2.rotation.set(-0.2 + 0.15 * Math.sin(w * 0.4), -0.1, -0.12); fg.elL.rotation.x = -0.5 + 0.2 * Math.sin(w * 0.7);
        const toChurch = Math.sin(w * 0.12) > 0.55;
        look(fg, fg.root.rotation.y, toChurch ? CH.x : tv.x, toChurch ? CH.z : tv.z, toChurch ? 0.15 : 0);
      } else if (mode === "chat") {                                                      // talks with small hand gestures, and keeps looking up at the church
        const g = Math.sin(w * 0.55) * 0.5 + 0.5;
        fg.shR2.rotation.set(-0.45 - 0.45 * g, 0.2, 0.25); fg.elR.rotation.x = -1.2 + 0.5 * Math.sin(w * 0.9);
        fg.shL2.rotation.set(-0.2 + 0.15 * Math.sin(w * 0.4), -0.1, -0.12); fg.elL.rotation.x = -0.5 + 0.2 * Math.sin(w * 0.7);
        const atPartner = Math.sin(w * 0.16) > 0.45;                                  // mostly the church, now and then the partner
        const vh = Math.hypot(vw.x - v.x, vw.z - v.z) + 1e-3, ve = Math.atan2(vw.y - (v.y + h * 0.9), vh);
        look(fg, fg.root.rotation.y, atPartner ? tv.x : vw.x, atPartner ? tv.z : vw.z, atPartner ? 0.05 : Math.min(0.6, Math.max(0.08, ve)));
      } else if (mode === "church") {                                                    // stands and looks up at the building, an arm slowly rises to point
        const up = 0.5 + 0.5 * Math.sin(w * 0.18);
        fg.shR2.rotation.set(-1.25 - 0.5 * elev * 0 - 0.25 * up, 0.12, 0.08); fg.elR.rotation.x = -0.05;
        fg.shL2.rotation.set(0, 0, -0.1); fg.elL.rotation.x = -0.25;
        look(fg, fg.root.rotation.y, tv.x, tv.z, Math.min(0.6, Math.max(0, elev) + 0.15 * up));
      } else if (mode === "point") {                                                     // points at the target and turns to look at it
        const ex = 1.45 + Math.max(0, elev) * 0.9;
        fg.shR2.rotation.set(-(ex + 0.05 * Math.sin(w * 0.5)), 0.1, 0.05); fg.elR.rotation.x = -0.04;
        fg.shL2.rotation.set(-0.2, 0, -0.1); fg.elL.rotation.x = -0.9;
        look(fg, fg.root.rotation.y, tv.x, tv.z, Math.min(0.7, Math.max(0, elev) + 0.1));
      } else {                                                                           // gaze: looks up, hand on chin
        fg.shR2.rotation.set(-0.9, 0.35, 0.1); fg.elR.rotation.x = -1.7; fg.shL2.rotation.set(-0.3, 0, -0.1); fg.elL.rotation.x = -0.3;
        look(fg, fg.root.rotation.y, tv.x, tv.z, Math.min(0.8, Math.max(0.3, elev)));
      }
    });
    return fg;
  }
  // --- a person sitting on a bench: still, with a slow turn of the head and a small gesture
  function sitter(bx, by, bz, h, kind, phase) {
    const fg = stick(h, kind), v = b2t(bx, by, bz); fg.root.position.copy(v); scene.add(fg.root);
    const tv = b2t(6.5, 20.5, 12);
    fg.root.rotation.y = yawTo(v.x, v.z, tv.x, tv.z);
    fg.hip.position.y = h * 0.5 - h * 0.5 + h * 0.035;                                   // hip just above the seat; the legs fold forward
    fg.thL.rotation.x = fg.thR.rotation.x = -1.5; fg.shL.rotation.x = fg.shR.rotation.x = 1.5;
    anims.push((t) => {
      const w = t + phase * 9;
      look(fg, fg.root.rotation.y, tv.x, tv.z, 0.25 + 0.15 * Math.sin(w * 0.2));
      fg.head.rotation.y += Math.sin(w * 0.25) * 0.25;
      fg.shR2.rotation.set(-0.9 - 0.5 * Math.max(0, Math.sin(w * 0.3)), 0.2, 0.15); fg.elR.rotation.x = -0.9 + 0.5 * Math.sin(w * 0.45);
      fg.shL2.rotation.set(-0.9, -0.1, -0.1); fg.elL.rotation.x = -0.25;
    });
  }

  // ---- the cast (Blender metres). Heights z measured on the model.
  const CHURCH = [12.5, 11, 14];
  // slow walkers outside, on the paving and lawns (paths sampled every 0.4 m on the model)
  citySink = cityFolk;
  // outside: pairs standing on the sidewalks and paths of the surroundings (not on the roads), talking and looking towards the church; positions measured on the model
  stander(-62, 43.5, -2.82, 1.76, "slim", "chat", [-60.5, 43.5, -1.33], 0.10); stander(-60.5, 43.5, -2.83, 1.63, "dress", "chat", [-62, 43.5, -1.3199999999999998], 0.55);
  stander(-63.5, 48, -2.82, 1.8, "coat", "chat", [-65, 49.5, -1.3199999999999998], 0.23); stander(-65, 49.5, -2.82, 1.6, "dress", "chat", [-63.5, 48, -1.3199999999999998], 0.66);
  stander(44.5, 45, 0.19, 1.62, "dress", "chat", [43, 45, 1.69], 0.36); stander(43, 45, 0.19, 1.78, "slim", "chat", [44.5, 45, 1.69], 0.77);
  stander(89.5, 52.5, -2.81, 1.74, "slim", "chat", [91, 54, -1.31], 0.49); stander(91, 54, -2.81, 1.66, "coat", "chat", [89.5, 52.5, -1.31], 0.88);
  stander(67, 15, -1.33, 1.76, "slim", "chat", [65.5, 13.5, 0.1299999999999999], 0.62); stander(65.5, 13.5, -1.37, 1.63, "dress", "chat", [67, 15, 0.16999999999999993], 0.99);
  stander(64, 10.5, -1.45, 1.8, "coat", "chat", [65.5, 12, 0.1100000000000001], 0.75); stander(65.5, 12, -1.39, 1.6, "dress", "chat", [64, 10.5, 0.050000000000000044], 1.10);
  stander(52, -24, -2.84, 1.62, "dress", "chat", [53.5, -24, -1.3399999999999999], 0.88); stander(53.5, -24, -2.84, 1.78, "slim", "chat", [52, -24, -1.3399999999999999], 1.21);
  stander(49, -49.5, -2.85, 1.74, "slim", "chat", [49, -51, -1.35], 1.01); stander(49, -51, -2.85, 1.66, "coat", "chat", [49, -49.5, -1.35], 1.32);
  stander(19, -43.5, -2.83, 1.76, "slim", "chat", [19, -45, -1.33], 1.14); stander(19, -45, -2.83, 1.63, "dress", "chat", [19, -43.5, -1.33], 1.43);
  stander(-14, -52.5, -2.84, 1.8, "coat", "chat", [-14, -54, -1.3399999999999999], 1.27); stander(-14, -54, -2.84, 1.6, "dress", "chat", [-14, -52.5, -1.3399999999999999], 1.54);
  stander(-48.5, -18, -2.84, 1.62, "dress", "chat", [-50, -19.5, -1.3399999999999999], 1.40); stander(-50, -19.5, -2.84, 1.78, "slim", "chat", [-48.5, -18, -1.3399999999999999], 1.65);
  stander(-60.5, -16.5, -2.84, 1.74, "slim", "chat", [-59, -16.5, -1.3399999999999999], 1.53); stander(-59, -16.5, -2.84, 1.66, "coat", "chat", [-60.5, -16.5, -1.3399999999999999], 1.76);
  // along the paths that ring the church: more pairs, talking and looking towards it (positions measured on the paving)
  stander(-30.5, 15, -1.31, 1.78, "coat", "chat", [-29.5, 14, 0.18999999999999995], 0.20); stander(-29.5, 14, -1.31, 1.62, "dress", "chat", [-30.5, 15, 0.18999999999999995], 0.70);
  stander(-12.5, 32, -1.3, 1.74, "slim", "chat", [-13.5, 31, 0.19999999999999996], 0.37); stander(-13.5, 31, -1.3, 1.66, "dress", "chat", [-12.5, 32, 0.19999999999999996], 0.79);
  stander(-7.5, 39, -1.31, 1.6, "dress", "chat", [-9.5, 39, 0.18999999999999995], 0.54); stander(-9.5, 39, -1.31, 1.8, "slim", "chat", [-7.5, 39, 0.18999999999999995], 0.88);
  stander(28.5, 29, 0.09, 1.82, "slim", "chat", [29.5, 30, 1.6], 0.71); stander(29.5, 30, 0.1, 1.58, "coat", "chat", [28.5, 29, 1.59], 0.97);
  stander(51.5, 28, 0.46, 1.64, "dress", "chat", [52.5, 27, 2.01], 0.88); stander(52.5, 27, 0.51, 1.76, "coat", "chat", [51.5, 28, 1.96], 1.06);
  stander(46.5, 15, 1.46, 1.78, "coat", "chat", [45.5, 14, 3.05], 1.05); stander(45.5, 14, 1.55, 1.62, "dress", "chat", [46.5, 15, 2.96], 1.15);
  stander(44.5, 9, 1.97, 1.74, "slim", "chat", [45.5, 8, 3.53], 1.22); stander(45.5, 8, 2.03, 1.66, "dress", "chat", [44.5, 9, 3.4699999999999998], 1.24);
  stander(36.5, -6, 3.06, 1.6, "dress", "chat", [34.5, -6, 4.59], 1.39); stander(34.5, -6, 3.09, 1.8, "slim", "chat", [36.5, -6, 4.5600000000000005], 1.33);
  stander(40.5, -21, -2.29, 1.82, "slim", "chat", [39.5, -22, -0.81], 1.56); stander(39.5, -22, -2.31, 1.58, "coat", "chat", [40.5, -21, -0.79], 1.42);
  stander(20.5, -26, -2.48, 1.64, "dress", "chat", [20.5, -24, -0.98], 1.73); stander(20.5, -24, -2.48, 1.76, "coat", "chat", [20.5, -26, -0.98], 1.51);
  stander(-4.5, -24, -2.26, 1.78, "coat", "chat", [-3.5, -23, -0.77], 1.90); stander(-3.5, -23, -2.27, 1.62, "dress", "chat", [-4.5, -24, -0.7599999999999998], 1.60);
  stander(-9.5, -23, -2.17, 1.74, "slim", "chat", [-10.5, -24, -0.6600000000000001], 2.07); stander(-10.5, -24, -2.16, 1.66, "dress", "chat", [-9.5, -23, -0.6699999999999999], 1.69);
  stander(-30.5, 12, -1.31, 1.6, "dress", "chat", [-29.5, 11, 0.18999999999999995], 2.24); stander(-29.5, 11, -1.31, 1.8, "slim", "chat", [-30.5, 12, 0.18999999999999995], 1.78);
  citySink = null;
  // on the ramp up to the entrance: pairs standing and talking, looking towards the door
  stander(22, -6.9, 3.8, 1.76, "slim", "chat", [24, -6.1, 5.15], 0.1, false, [16, -6.5, 5.4]); stander(24, -6.1, 3.65, 1.62, "dress", "chat", [22, -6.9, 5.3], 0.60, false, [16, -6.5, 5.4]);
  stander(27, -6.1, 3.43, 1.8, "coat", "chat", [28.7, -6.9, 4.8100000000000005], 0.35, false, [16, -6.5, 5.4]); stander(28.7, -6.9, 3.31, 1.64, "dress", "chat", [27, -6.1, 4.93], 0.85, false, [16, -6.5, 5.4]);
  stander(20, -6, 3.94, 1.66, "dress", "chat", [19.9, -7, 5.45], 0.6, false, [16, -6.5, 5.4]); stander(19.9, -7, 3.95, 1.74, "slim", "chat", [20, -6, 5.4399999999999995], 1.10, false, [16, -6.5, 5.4]);
  // inside: pairs standing and talking, looking up at the star wall and the roof lights
  stander(10, 16, 5.2, 1.72, "slim", "chat", [8, 18.5, 5.42 + 1.5], 0.1, false, [6.5, 20.5, 12]); stander(8, 18.5, 5.42, 1.70, "dress", "chat", [10, 16, 5.2 + 1.5], 0.8, false, [6.5, 20.5, 12]);
  stander(14, 17.5, 5.4, 1.66, "dress", "chat", [11.5, 17.5, 5.4 + 1.5], 0.5, false, [6.5, 20.5, 12]); stander(11.5, 17.5, 5.4, 1.68, "coat", "chat", [14, 17.5, 5.4 + 1.5], 0.6, false, [6.5, 20.5, 12]);
  stander(17, 15.5, 4.93, 1.78, "coat", "chat", [18.5, 13.5, 4.774 + 1.5], 0.3, false, [14, 4, 27]); stander(18.5, 13.5, 4.774, 1.62, "dress", "chat", [17, 15.5, 4.93 + 1.5], 0.7, false, [14, 4, 27]);
  stander(12, 13.2, 5.4, 1.76, "slim", "talk", [13.6, 11.8, 6.5], 0.4); stander(13.6, 11.8, 4.737, 1.60, "dress", "talk", [12, 13.2, 6.9], 0.9);
  // inside: sitting on the benches
  [[11, 5, 7.57, "slim"], [13, 5, 7.59, "dress"], [19, 7, 8.17, "coat"], [19, 9, 8.14, "dress"], [9, 9, 6.79, "slim"], [7, 11, 6.75, "dress"], [17, 5, 8.34, "coat"], [21, 9, 8.54, "slim"]].forEach(([bx, by, bz, kind], i) => sitter(bx, by, bz, 1.7, kind, i * 0.37));

  // ---- trees: architectural-model style, green and see-through, one instanced mesh per shape (7 shapes: slim cone, clipped column, sphere, tall ellipsoid, umbrella crown, egg, hedge cushion).
  // Positions come from the map data (woods, hedges and open green space, never on roads, buildings or pavements); heights from the ground under each tree.
  if (treesUrl) fetch(treesUrl).then((r) => r.json()).then((trees) => {
    const flat = (g) => { const n = g.index ? g.toNonIndexed() : g; n.deleteAttribute("uv"); return n; };
    const cyl = (r0, r1, h, y, seg = 5) => { const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1); g.translate(0, y, 0); return flat(g); };
    const cone = (r, h, y, seg = 6) => { const g = new THREE.ConeGeometry(r, h, seg, 1); g.translate(0, y, 0); return flat(g); };
    const ico = (r, x, y, z, sx = 1, sy = 1, sz = 1, det = 0) => { const g = new THREE.IcosahedronGeometry(r, det); g.scale(sx, sy, sz); g.translate(x, y, z); return flat(g); };
    const box = (w, h, d, x, y, z, ry = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.rotateY(ry); g.translate(x, y, z); return flat(g); };
    const sph = (r, y, sx = 1, sy = 1, sz = 1) => { const g = new THREE.SphereGeometry(r, 20, 14); g.scale(sx, sy, sz); g.translate(0, y, 0); return flat(g); };
    const stem = (h) => cyl(0.022, 0.026, h, h / 2, 8);                                                                     // a thin straight rod, like a model-maker's tree
    const shapes = [                                                                                                        // architectural-model trees: one clean, smooth volume on a thin stem
      [stem(0.2), cone(0.25, 0.86, 0.63, 18)],                                                                              // slim cone (conifer)
      [stem(0.3), cyl(0.21, 0.21, 0.6, 0.6, 18), sph(0.21, 0.9, 1, 0.28, 1)],                                              // clipped column
      [stem(0.36), sph(0.34, 0.68)],                                                                                         // sphere
      [stem(0.3), sph(0.27, 0.7, 1, 1.55, 1)],                                                                              // tall ellipsoid
      [stem(0.56), sph(0.4, 0.74, 1, 0.42, 1)],                                                                             // umbrella crown
      [stem(0.32), sph(0.3, 0.68, 1, 1.22, 1)],                                                                             // egg
      [sph(0.5, 0.3, 1.15, 0.6, 1.15)],                                                                                      // hedge cushion
    ].map((parts) => mergeGeometries(parts, false));
    const shades = [new THREE.Color(0x86a874), new THREE.Color(0x779a68), new THREE.Color(0x96b583)];        // muted greens
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: false, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.36, depthWrite: false, side: THREE.DoubleSide });
    mat.clipShadows = true;
    const byKind = shapes.map(() => []); for (const t of trees) byKind[t[2]].push(t);
    const group = new THREE.Group(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), sv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    shapes.forEach((geo, k) => {
      const list = byKind[k]; if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, mat, list.length); im.frustumCulled = false; im.castShadow = false; im.receiveShadow = false; im.renderOrder = 4;
      list.forEach((t, i) => {
        const v = b2t(t[0], t[1], 0); let y = -2.9;
        if (Math.hypot(v.x - 0.25, v.z + 1.73) < 95) { const gy = groundAt(v.x, v.z); if (gy !== null) y = gy; }
        const h = t[3], w = h * (k === 6 ? 1.0 : 0.8 + 0.05 * ((t[0] * 7 + t[1] * 13) % 5));
        q.setFromAxisAngle(up, ((t[0] * 3.1 + t[1] * 1.7) % 6.283)); pv.set(v.x, y, v.z); sv.set(w, h, w); m4.compose(pv, q, sv); im.setMatrixAt(i, m4); im.setColorAt(i, shades[t[4] % 3]);
      });
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; group.add(im);
    });
    ctxRoot.add(group); markDirty();
  }).catch((e) => console.warn("trees not loaded", e));

  // ground level of the model
  const box = new THREE.Box3().setFromObject(model);
  const groundY = box.min.y;

  // faint indicator of the section plane
  const planeViz = new THREE.Group();
  planeViz.add(new THREE.Mesh(new THREE.PlaneGeometry(64, 44), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false })));
  planeViz.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(64, 44)), new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.35 })));
  planeViz.visible = false; scene.add(planeViz);

  // ghost of the part the section removes: the same geometry, very faint, drawn in a second pass clipped by the opposite plane
  const ghostScene = new THREE.Scene(), ghostPlane = new THREE.Plane(), ghostFloor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 2.9);      // ghostFloor: only above the terrain (y -2.9), the buried parts stay hidden
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x8c9196, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, depthFunc: THREE.LessEqualDepth, toneMapped: false });
  const ghostDepth = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });          // depth first: only the front-most ghost surface gets tinted, not every layer behind it
  const ghostEdge = new THREE.LineBasicMaterial({ color: 0x6f747a, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!o.isMesh || o.material.transparent) return;                  // no glass
    for (const [g, m] of [[o.geometry, ghostDepth], [o.geometry, ghostMat], [new THREE.EdgesGeometry(o.geometry, 40), ghostEdge]]) {
      const c = m === ghostEdge ? new THREE.LineSegments(g, m) : new THREE.Mesh(g, m);
      c.matrixAutoUpdate = false; c.matrix.copy(o.matrixWorld); c.frustumCulled = false; ghostScene.add(c);
    }
  });
  // ---- Info: overall dimensions, dotted. The plan dimensions run along the two sides nearest the camera, the height up the
  // corner at the left of the building on screen. The height in metres from the upper terrace (east entrance, Blender z = 0).
  const SQ0 = 0.1, SQ1 = 25.4, OFF = 3.0, TOP = box.max.y;                  // the square base in Blender metres; viewer y = Blender z
  const dimRoot = new THREE.Group(); scene.add(dimRoot);
  const dimMat = new THREE.LineDashedMaterial({ color: 0x3c3f43, dashSize: 0.22, gapSize: 0.38, depthTest: false, transparent: true, opacity: 0.85 });      // dotted
  const dimLayer = document.createElement("div"); dimLayer.className = "v3-dims"; stage.appendChild(dimLayer);
  const dimTag = (txt, cls) => { const e = document.createElement("span"); e.className = cls; e.textContent = txt; dimLayer.appendChild(e); return { e, p: new THREE.Vector3() }; };
  const tagW = dimTag((SQ1 - SQ0).toFixed(1) + " m", "v3-dim"), tagD = dimTag((SQ1 - SQ0).toFixed(1) + " m", "v3-dim"), tagH = dimTag(TOP.toFixed(1) + " m", "v3-dim v3-dim-h");
  const corners = [[SQ0 - OFF, SQ0 - OFF], [SQ1 + OFF, SQ0 - OFF], [SQ1 + OFF, SQ1 + OFF], [SQ0 - OFF, SQ1 + OFF]];
  let dimKey = "", dimLines = null;
  function edgeDim(a, b, tg, pts) {                                          // a dimension along the side between two offset corners, measuring the square itself
    const sx = a[0] === b[0], c = sx ? a[0] : a[1], tk = 0.7;
    const P = (u) => (sx ? b2t(c, u, 0) : b2t(u, c, 0));
    pts.push(P(SQ0), P(SQ1));
    for (const u of [SQ0, SQ1]) { const q = P(u); pts.push(q.clone().add(new THREE.Vector3(-tk, 0, -tk)), q.clone().add(new THREE.Vector3(tk, 0, tk))); }   // 45 degree ticks
    tg.p.copy(P((SQ0 + SQ1) / 2));
  }
  function buildDims(kn, kv) {
    const pts = [];
    edgeDim(corners[kn], corners[(kn + 1) % 4], tagW, pts); edgeDim(corners[kn], corners[(kn + 3) % 4], tagD, pts);
    const [vx, vy] = corners[kv], base = b2t(vx, vy, 0), tk = 0.8;
    pts.push(base.clone(), base.clone().setY(TOP));
    for (const z of [0, TOP]) { const q = base.clone().setY(z); pts.push(q.clone().add(new THREE.Vector3(-tk, 0, 0)), q.clone().add(new THREE.Vector3(tk, 0, 0))); }
    tagH.p.copy(base).setY(TOP / 2);
    if (dimLines) { dimRoot.remove(dimLines); dimLines.geometry.dispose(); }
    dimLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), dimMat); dimLines.computeLineDistances(); dimLines.renderOrder = 23; dimLines.frustumCulled = false; dimRoot.add(dimLines);
  }
  const dimV = new THREE.Vector3();
  function updateDims(r) {
    const show = notesOn && !enhanced; dimRoot.visible = show;                 // no building dimensions over the site views
    if (!show) { for (const t of [tagW, tagD, tagH]) t.e.style.display = "none"; return; }
    let kn = 0, best = Infinity, left = [];                                  // the corner nearest the camera, and the screen x of each corner
    corners.forEach(([x, y], k) => { const w = b2t(x, y, 0); const d = w.distanceToSquared(camera.position); if (d < best) { best = d; kn = k; } left[k] = dimV.copy(w).project(camera).x; });
    const n1 = (kn + 1) % 4, n3 = (kn + 3) % 4, kv = left[n1] < left[n3] ? n1 : n3;          // the height goes up the neighbour that sits further left on screen
    const key = kn + "" + kv; if (key !== dimKey) { dimKey = key; buildDims(kn, kv); }
    for (const t of [tagW, tagD, tagH]) {
      dimV.copy(t.p).project(camera); const vis = dimV.z < 1 && Math.abs(dimV.x) < 1.1 && Math.abs(dimV.y) < 1.1;
      t.e.style.display = vis ? "" : "none";
      if (vis) t.e.style.transform = `translate(${((dimV.x + 1) / 2) * r.width}px, ${((1 - dimV.y) / 2) * r.height}px)`;
    }
  }

  function ghostSetup() { ghostPlane.copy(cutPlane).negate(); ghostMat.opacity = (lite ? 0.10 : 0.06) * cutK; ghostEdge.opacity = (lite ? 0.14 : 0.09) * cutK; }      // the desktop finish brightens it: fainter there
  function drawGhost() {                                               // phones: straight onto the canvas, over the scene's own depth
    if (cutK <= 0.001) return;
    ghostSetup();
    const ac = renderer.autoClear, cp = renderer.clippingPlanes;
    renderer.autoClear = false; renderer.clippingPlanes = [ghostPlane, ghostFloor];
    renderer.render(ghostScene, camera);
    renderer.autoClear = ac; renderer.clippingPlanes = cp;
  }

  for (const an of anims) an(9.0);                                   // figures are posed once and stay still: no per-frame animation
  {                                                                  // ...so their ~500 little meshes become ONE (and the window lamps one): hundreds of draw calls fewer
    scene.updateMatrixWorld(true);
    const inCity = (o) => { for (let p = o; p; p = p.parent) if (cityFolk.includes(p)) return true; return false; };
    const bake = (mat, cast, city = null) => {
      const gs = [], rm = [];
      scene.traverse((o) => { if (o.isMesh && o.material === mat && !o.userData.merged && (city === null || inCity(o) === city)) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); gs.push(g); rm.push(o); } });
      if (gs.length < 2) return;
      let mg; try { mg = mergeGeometries(gs, false); } catch (e) { console.warn("merge failed", e); return; }
      for (const o of rm) o.removeFromParent();
      const m = new THREE.Mesh(mg, mat); m.frustumCulled = false; m.castShadow = cast; m.userData.merged = true; scene.add(m); return m;
    };
    const cityMesh = bake(blk, true, true); bake(blk, true, false);          // the people of the surroundings stay one separate mesh, so the City button can hide them
    cityFolk.length = 0; if (cityMesh) cityFolk.push(cityMesh);
     if (litLamps) bake(litLamps.fix, false);
  }

  // ---- sun path and compass, both 100 m in radius and centred on the church: the sun's day arc as a thin dotted line with the sun as a small yellow disc,
  // and a flat compass ring on the ground with a mark at north (north is -x here)
  const SKY_R = 100, SK = SKY_R / 50, SKY_C = new THREE.Vector3(CH.x, 0, CH.z);
  const skyRoot = new THREE.Group(); skyRoot.position.copy(SKY_C); scene.add(skyRoot);
  const lineMat = (col) => new THREE.LineDashedMaterial({ color: col, dashSize: 0.55 * SK, gapSize: 0.8 * SK, depthTest: false, transparent: true, opacity: 0.95 });
  const sunPath = new THREE.Group(); skyRoot.add(sunPath);                              // turns with the spin, like the sun does
  const arc = new THREE.Line(new THREE.BufferGeometry(), lineMat(0xd6a100)); arc.renderOrder = 20; arc.frustumCulled = false; sunPath.add(arc);
  const arcBold = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xe0a400, depthTest: false, transparent: true })); arcBold.renderOrder = 20; arcBold.visible = false; sunPath.add(arcBold);   // the site views: a thick arc, legible from far above
  function buildArc() {                                                  // the day's arc, rebuilt when the day of the year changes
    const pts = [];
    for (let h = 2.0; h <= 22.0; h += 0.05) { const d = sunVector(h); if (d.y >= 0) pts.push(d.clone().multiplyScalar(SKY_R)); }
    arc.geometry.dispose(); arc.geometry = new THREE.BufferGeometry().setFromPoints(pts); arc.computeLineDistances();
    arcBold.geometry.dispose(); arcBold.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 1.1, 6, false);
  }
  buildArc();
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(1.05 * SK * 0.9, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffd21a, depthTest: false })); sunDisc.renderOrder = 21; skyRoot.add(sunDisc);
  const rayGroup = new THREE.Group(); skyRoot.add(rayGroup);                         // dotted ray from the sun to the church, with an arrow head
  const rayLine = new THREE.Line(new THREE.BufferGeometry(), lineMat(0xd6a100)); rayLine.renderOrder = 20; rayLine.frustumCulled = false; rayGroup.add(rayLine);
  const rayHead = new THREE.Mesh(new THREE.ConeGeometry(0.9 * SK, 3.2 * SK, 16), new THREE.MeshBasicMaterial({ color: 0xe8b400, depthTest: false })); rayHead.renderOrder = 21; rayGroup.add(rayHead);
  const RAY_TARGET = new THREE.Vector3(0, 14, 0), rayDir = new THREE.Vector3();
  const compass3 = new THREE.Group(); compass3.position.y = 0.2; skyRoot.add(compass3);
  {
    const ring = []; for (let i = 0; i <= 180; i++) { const a = (i / 180) * Math.PI * 2; ring.push(new THREE.Vector3(Math.sin(a) * SKY_R, 0, Math.cos(a) * SKY_R)); }
    const rl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: 0x4a4d50, depthTest: false, transparent: true, opacity: 0.8 })); rl.renderOrder = 19; compass3.add(rl);
    const ticks = [];                                                                       // a tick every 15 degrees, longer at the four cardinal points
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2, len = (i % 6 === 0 ? 3.2 : 1.1) * SK, sx = Math.sin(a), cz = Math.cos(a); ticks.push(new THREE.Vector3(sx * SKY_R, 0, cz * SKY_R), new THREE.Vector3(sx * (SKY_R + len), 0, cz * (SKY_R + len))); }
    const tl = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), new THREE.LineBasicMaterial({ color: 0x4a4d50, depthTest: false, transparent: true, opacity: 0.8 })); tl.renderOrder = 19; compass3.add(tl);
    const label = (txt, ax, az, col, size) => {                                             // a letter lying flat on the ground, readable from above
      const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d"); g.fillStyle = col; g.font = "600 92px Helvetica, Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, 64, 70);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false })); m.rotation.order = "YXZ"; m.rotation.set(-Math.PI / 2, Math.PI / 2, 0); m.position.set(ax, 0, az); m.renderOrder = 22; return m;      // flat, with the top of the letter towards north
    };
    const R2 = SKY_R + 6.2 * SK;                                                                  // north = -x, east = -z, south = +x, west = +z (viewer coordinates)
    compass3.add(label("N", -R2, 0, "#c9483b", 5.4 * SK), label("E", 0, -R2, "#4a4d50", 3.6 * SK), label("S", R2, 0, "#4a4d50", 3.6 * SK), label("W", 0, R2, "#4a4d50", 3.6 * SK));
    const tg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-(SKY_R - 0.4 * SK), 0, 0), new THREE.Vector3(-(SKY_R - 3.8 * SK), 0, -1.5 * SK), new THREE.Vector3(-(SKY_R - 3.8 * SK), 0, 1.5 * SK)]); tg.computeVertexNormals();
    const tri = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: 0xc9483b, side: THREE.DoubleSide, depthTest: false })); tri.renderOrder = 22; compass3.add(tri);       // an arrow head just inside the ring, pointing north
  }
  // the other buildings of the Site Le Corbusier (OpenStreetMap, metres north / east of the church): flat arrows on the ground, shown in the site views
  const POIS = [
    { name: "Piscine", n: 52.5, e: 53.9 }, { name: "Stade", n: -32, e: 139, dy: -13 },
    { name: "Maison de la Culture", n: -19.7, e: 235.7, dy: 12 }, { name: "Unité d'habitation", n: -644, e: -384 },
  ];
  const poiRoot = new THREE.Group(); poiRoot.position.y = 0.3; poiRoot.visible = false; skyRoot.add(poiRoot);
  {
    const mat = new THREE.MeshBasicMaterial({ color: 0xc9483b, side: THREE.DoubleSide, depthTest: false });          // the red of the north mark: legible by day and by night
    for (const p of POIS) {
      const dist = Math.hypot(p.n, p.e), dx = -p.n / dist, dz = -p.e / dist;          // viewer: north = -x, east = -z
      p.dist = dist; const a = dist < 95 ? 26 : 86, b = dist < 95 ? dist - 9 : SKY_R + 8;    // inside the ring: up to the building; further away: out across the ring
      const nx = -dz, nz = dx, w = 0.9, hl = 7, hw = 3.4;
      const P = (s, o) => new THREE.Vector3(dx * s + nx * o, 0, dz * s + nz * o);
      p.draw = (k) => {                                                                  // k 0..1: the arrow grows from its tail; the head rides on the tip
        const t = a + (b - a) * k, s = Math.max(a, t - hl * Math.min(1, k * 3));
        p.mesh.geometry.setFromPoints([P(a, -w), P(s, -w), P(s, w), P(a, -w), P(s, w), P(a, w), P(s, -hw * Math.min(1, k * 3)), P(t, 0), P(s, hw * Math.min(1, k * 3))]);
      };
      p.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat); p.mesh.renderOrder = 22; p.mesh.frustumCulled = false; poiRoot.add(p.mesh); p.draw(1);
      p.at = P(dist < 95 ? dist + 4 : 74, 0).add(skyRoot.position);                    // where its name sits: by the building, or inside the ring before the arrow
    }
  }

  // ---- time of day
  let solar = 10.0, sunK = 1;                                       // sunK: how strongly the sun and its path show (fainter in the site view)
  const tmpSun = new THREE.Vector3();
  const bgNow = new THREE.Vector3(1, 1, 1); let nightK = 0;                // stage background (display colour) and how night it is, 0..1
  function applySun() {
    dirty = true; shadowStale = true;
    tmpSun.copy(sunVector(solar)).applyAxisAngle(THREE.Object3D.DEFAULT_UP, sunAz);
    const el = Math.asin(Math.max(-1, Math.min(1, tmpSun.y)));
    sun.position.copy(sun.target.position).addScaledVector(tmpSun, 120);
    sunPath.rotation.y = sunAz; sunDisc.position.copy(tmpSun).multiplyScalar(SKY_R); sunDisc.visible = tmpSun.y > 0.0;
    { const up = tmpSun.y > 0.0; rayGroup.visible = up;
      if (up) {                                                                          // the dotted arrow starts at the sun and is half the old length, its head pointing towards the church
        rayDir.copy(RAY_TARGET).sub(sunDisc.position); const dist = rayDir.length(); rayDir.normalize();
        const a0 = 2.2 * SK, a1 = a0 + (dist - 28 * SK / 2 - a0) / 2 * 4 / 3, P0 = sunDisc.position.clone().addScaledVector(rayDir, a0), P1 = sunDisc.position.clone().addScaledVector(rayDir, a1);
        rayLine.geometry.setFromPoints([P0, P1]); rayLine.computeLineDistances();
        rayHead.visible = false;                              // no arrow tip: the dotted line alone
      } }
    const f = Math.max(0, Math.sin(el));
    const warm = 1 - THREE.MathUtils.smoothstep(THREE.MathUtils.radToDeg(el), 3, 30);
    sun.color.setRGB(1.0, THREE.MathUtils.lerp(0.95, 0.62, warm), THREE.MathUtils.lerp(0.88, 0.34, warm));
    sun.intensity = 3.6 * Math.pow(f, 0.6);
    sun.visible = f > 0.01;
    hemi.intensity = 0.2 + 1.6 * Math.pow(f, 0.5);
    hemi.color.setRGB(0.80, 0.88 - 0.06 * warm, 1.0 - 0.2 * warm);
    // as the sun goes down from 18 to 2 degrees the background and the light go down to night (17:00 to 18:30 on 25 August; it follows the day of the year)
    const elD = THREE.MathUtils.radToDeg(el);
    nightK = 1 - THREE.MathUtils.smoothstep(elD, 2.1, 17.8);
    { const vis = 1 - 0.98 * nightK;                                                    // the sun, its path and its ray fade away as night comes
      sunDisc.material.transparent = true; sunDisc.material.opacity = vis * sunK; arc.material.opacity = 0.95 * vis; arcBold.material.opacity = 0.95 * vis * sunK; rayLine.material.opacity = 0.95 * vis; }
    { const dayK = (1 - 0.88 * nightK) * (0.2 + 0.8 * THREE.MathUtils.smoothstep(THREE.MathUtils.radToDeg(el), 2, 30)); for (const c of ctxLit) c.m.emissiveIntensity = c.base * dayK; }
    sun.intensity *= 1 - 0.92 * nightK;
    hemi.intensity = hemi.intensity * (1 - 0.82 * nightK) + 0.16 * nightK;
    hemi.color.lerp(new THREE.Color(0.45, 0.55, 0.95), nightK);             // cold moonlit sky
    bgNow.set(THREE.MathUtils.lerp(1, 0.035, nightK), THREE.MathUtils.lerp(1, 0.045, nightK), THREE.MathUtils.lerp(1, 0.075, nightK));
    root.style.setProperty("--v3-bg", "rgb(" + bgNow.toArray().map((c) => Math.round(c * 255)).join(",") + ")");
    root.classList.toggle("is-night", nightK > 0.5);
    litU.value = 1 - THREE.MathUtils.smoothstep(elD, 8.4, 12.6);           // architectural lights on below about 12 degrees (17:30 on 25 August)
    for (const g of glowMats) g.mat.color.copy(g.base).multiplyScalar(1 + 1.4 * litU.value);
    for (const L of floodRef) L.intensity = 70 * litU.value;
    if (litLamps) { litLamps.fix.color.copy(litLamps.base).multiplyScalar(litU.value * 2.2); for (const L of litLamps.lights) L.intensity = 7 * litU.value; }
  }
  applySun();

  // ---- post: occlusion, then our own tone map that keeps the stage pure white
  const size = new THREE.Vector2(1, 1);
  const mobile = lite; if (lite) renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: mobile ? 4 : Math.min(8, renderer.capabilities.maxSamples || 4) });
  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(scene, persp);
  const gtao = new GTAOPass(scene, persp, 1, 1);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.6, thickness: 1.2, scale: 1.2, samples: 16, distanceFallOff: 1.0, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
  gtao.blendIntensity = 1.0;
  const finalPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uExposure: { value: EXPOSURE }, uBg: { value: new THREE.Vector3(1, 1, 1) } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uExposure; uniform vec3 uBg;
      vec3 aces(vec3 x) { x *= uExposure * 0.6; return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main() {
        vec4 t = texture2D(tDiffuse, vUv);
        vec3 rgb = toSrgb(aces(t.rgb));
        float a = clamp(t.a, 0.0, 1.0);
        gl_FragColor = vec4(rgb + (1.0 - a) * uBg, 1.0);
      }`,
  });
  const ghostPass = new RenderPass(ghostScene, persp); ghostPass.clear = false;          // the ghost goes into the scene buffer, tested against its depth (the ground hides what is buried)
  { const base = ghostPass.render.bind(ghostPass); ghostPass.render = (r, ...a) => { if (cutK <= 0.001) return; ghostSetup(); const cp = r.clippingPlanes; r.clippingPlanes = [ghostPlane, ghostFloor]; base(r, ...a); r.clippingPlanes = cp; }; }
  composer.addPass(renderPass); composer.addPass(ghostPass); composer.addPass(gtao); composer.addPass(finalPass); if (!lite) composer.addPass(new SMAAPass(1, 1));   // SMAA steadies thin lines and small details while the model moves
  gtao.enabled = !mobile;                                // the occlusion pass is the heaviest and the least stable on phones
  const clip = { on: { value: 0 } };

  // ---- notes (hotspots)
  const layer = root.querySelector(".v3-notes");
  const card = root.querySelector(".v3-card");
  const spots = hotspots.map((h, i) => {
    const el = document.createElement("button");
    el.className = "v3-dot"; el.type = "button"; el.setAttribute("aria-label", h.title); el.innerHTML = `<span>${i + 1}</span>`;
    layer.appendChild(el);
    const s = { h, el, pos: b2t(...h.pos), face: h.face ? new THREE.Vector3(h.face[0], h.face[2], -h.face[1]).normalize() : null, side: h.side };
    el.addEventListener("click", (ev) => { ev.stopPropagation(); openCard(s); });
    return s;
  });
  let active = null;
  function openCard(s) {
    active = s; controls.autoRotate = false; autoBtn?.classList.remove("on");
    card.querySelector("h3").textContent = s.h.title; card.querySelector("p").textContent = s.h.text;
    card.querySelector(".v3-kicker").textContent = String(spots.indexOf(s) + 1).padStart(2, "0") + " · " + (s.side === "int" ? "Interior" : "Exterior");
    card.classList.add("show"); spots.forEach((x) => x.el.classList.toggle("active", x === s));
    if (root.clientWidth <= 900) root.querySelector(".v3-panel").after(card);          // small screens: the note sits below the 3D view
    else root.querySelector(".v3-stage").after(card);
  }
  const lineSvg = root.querySelector(".v3-line"), lineEl = lineSvg.querySelector("line"), dotEl = lineSvg.querySelector("circle");
  function placeCard(px, py) {
    const W = stage.clientWidth, wide = root.clientWidth > 900;
    card.dataset.side = px < W / 2 ? "left" : "right";
    lineSvg.style.display = wide ? "block" : "none";
    if (!wide) return;
    const ax = card.dataset.side === "left" ? card.offsetLeft + card.offsetWidth : card.offsetLeft, ay = card.offsetTop + Math.min(card.offsetHeight / 2, 54);
    lineEl.setAttribute("x1", px); lineEl.setAttribute("y1", py); lineEl.setAttribute("x2", ax); lineEl.setAttribute("y2", ay);
    dotEl.setAttribute("cx", px); dotEl.setAttribute("cy", py);
  }
  function closeCard() { active = null; card.classList.remove("show"); lineSvg.style.display = "none"; spots.forEach((x) => x.el.classList.remove("active")); }
  card.querySelector(".v3-close").addEventListener("click", closeCard);

  // ---- state + tweens
  let opened = false, notesOn = true, axo = false, idleTimer = 0, tween = null, cutK = 0;
  let onResize = null, siteLock = false, lens30 = false, fovWant = 26, fovSet = false;                            // siteLock: the site and light views hold the fitted top view (until the visitor drags it)
  let spinSun = true, spinMul = 1;                                   // spinSun: the sun runs with the spin (auto play); spinMul: slower spin when idle
  const tmp = new THREE.Vector3();
  function flyTo(pos, target, ms = 1300) {
    const p0 = camera.position.clone(), t0 = controls.target.clone(); tween = { t: 0, ms, p0, t0, p1: pos.clone(), t1: target.clone() };
  }
  function setOpen(v) {
    opened = v; setCut(true); root.classList.toggle("is-open", v);
    openBtn?.classList.toggle("on", v); closeCard();
    cutTween = { from: cutK, to: v ? 1 : 0, t: 0 };
    if (v) { axoOff(); cutFly(); controls.autoRotate = false; autoBtn?.classList.remove("on"); }
    else { flyTo(new THREE.Vector3(82, 40, 64), new THREE.Vector3(0, 12, 0)); }
  }
  let cutTween = null;
  const cutDir = new THREE.Vector3(1, 0, 0); let cutS = 0, cutAng = 0, cutH = 14, horiz = false;      // plane faces the camera side: keeps everything behind dot(p, cutDir) <= cutS
  function dirFlyTo() {
    const p = new THREE.Vector3(cutDir.x * 78 - cutDir.z * 4, 26, cutDir.z * 78 + cutDir.x * 4), t = new THREE.Vector3(-cutDir.x * 2, 13, -cutDir.z * 2); flyTo(p, t);
  }
  function axoOn() {
    axo = true; camera = ortho; controls.object = ortho; renderPass.camera = ortho; ghostPass.camera = ortho; gtao.camera = ortho; ortho.zoom = 1; root.classList.add("is-axo"); axoBtn?.classList.add("on");
    const d = new THREE.Vector3(1, 1.15, 1).normalize().multiplyScalar(300);        // 'from the top towards the bottom'
    ortho.position.copy(d); controls.target.set(0, 12, 0); ortho.updateProjectionMatrix(); controls.autoRotate = false; autoBtn?.classList.remove("on");
    controls.minDistance = 10; controls.maxDistance = 600; controls.maxPolarAngle = Math.PI * 0.5; resize();
  }
  function axoOff() {
    if (!axo) return; axo = false; camera = persp; controls.object = persp; renderPass.camera = persp; ghostPass.camera = persp; gtao.camera = persp; root.classList.remove("is-axo"); axoBtn?.classList.remove("on");
    controls.minDistance = 22; controls.maxDistance = 1400; resize();
  }
  let spinK = 0;
  function introFlight() {                                // from far away to the hero framing, fast to slow; then the slow spin eases in
    const HT = heroTgt(), HP = heroPos(); const s1 = new THREE.Spherical().setFromVector3(HP.clone().sub(HT)); userMoved = false;
    const s0 = new THREE.Spherical(s1.radius * 2.55, s1.phi - 0.3, s1.theta + 0.95);       // far, a little higher, and 55 degrees round to the right: the camera sweeps to the left as it closes in
    persp.position.setFromSpherical(s0).add(HT); controls.target.copy(HT); controls.autoRotate = false; autoBtn?.classList.remove("on"); spinK = 0;
    tween = { intro: true, t: 0, ms: INTRO_MS, sph0: s0, sph1: s1, p0: persp.position.clone(), t0: HT.clone(), p1: HP.clone(), t1: HT.clone(), ease: easeOut, easeA: easeOutSoft, then: () => startSpin() };      // the spin takes over at full speed, with no ramp (auto play only)
  }
  function resetView() { if (axo) axoOff(); closeCard(); if (opened) setOpen(false); introFlight(); }


  // ---- north button: a compass that shows where north is and turns the view to north-up; visible in bird's-eye views (high camera, far camera, axonometric)
  const NORTH_W = new THREE.Vector2(-1, 0);                      // north in viewer coordinates (x, z): real north = -X in the model
  const compass = document.createElement("button"); compass.type = "button"; compass.className = "v3-north"; compass.setAttribute("aria-label", "Turn the view to north"); compass.title = "North up";
  compass.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><g class="needle"><path d="M24 7l6 17H18z" fill="#c9483b"/><path d="M24 41l6-17H18z" fill="currentColor" opacity=".35"/></g><circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5"/><text x="24" y="6.2" text-anchor="middle" font-size="7" font-weight="600" fill="currentColor" font-family="sans-serif">N</text></svg>';
  stage.appendChild(compass);
  const needle = compass.querySelector(".needle");
  function northUp() {
    const T = controls.target.clone(), off = camera.position.clone().sub(T), sp = new THREE.Spherical().setFromVector3(off);
    let dth = Math.PI / 2 - sp.theta; dth = Math.atan2(Math.sin(dth), Math.cos(dth));                 // the shortest way round to the camera standing south of the target
    const s1 = new THREE.Spherical(sp.radius, sp.phi, sp.theta + dth);
    controls.autoRotate = false; autoBtn?.classList.remove("on");
    tween = { t: 0, ms: 1100, sph0: sp.clone(), sph1: s1, p0: camera.position.clone(), t0: T.clone(), p1: camera.position.clone(), t1: T.clone(), ease: ease, easeA: ease };
  }
  compass.addEventListener("click", northUp);
  function updateCompass() {
    const off = camera.position.clone().sub(controls.target), dist = off.length(), elev = Math.atan2(off.y, Math.hypot(off.x, off.z));
    const bird = axo || elev > 0.55 || dist > 190;                 // about 32 degrees above the horizon, or far away
    compass.classList.toggle("show", bird && !renderer.xr.isPresenting);
    const fx = -off.x, fz = -off.z, fl = Math.hypot(fx, fz) || 1, f = new THREE.Vector2(fx / fl, fz / fl), r = new THREE.Vector2(-f.y, f.x);
    needle.style.transform = "rotate(" + (Math.atan2(NORTH_W.dot(r), NORTH_W.dot(f)) * 180 / Math.PI).toFixed(1) + "deg)"; needle.style.transformOrigin = "24px 24px";
  }

  // ---- City button: shows or hides the surroundings
  const cityBtn0 = root.querySelector('[data-act="city"]');
  cityBtn0?.classList.add("on");
  cityBtn0?.addEventListener("click", () => { ctxRoot.visible = !ctxRoot.visible; for (const p of cityFolk) p.visible = ctxRoot.visible; cityBtn0.classList.toggle("on", ctxRoot.visible); markDirty(); });

  // ---- toolbar
  const q = (s) => root.querySelector(s);
  const autoBtn = q('[data-act="spin"]'), openBtn = q('[data-act="open"]'), axoBtn = q('[data-act="axo"]'), notesBtn = q('[data-act="notes"]'), resetBtn = q('[data-act="reset"]'), fsBtn = q('[data-act="full"]');
  autoBtn?.classList.add("on");
  autoBtn?.addEventListener("click", () => { controls.autoRotate = !controls.autoRotate; autoBtn.classList.toggle("on", controls.autoRotate); });
  openBtn?.addEventListener("click", () => setOpen(!opened));
  axoBtn?.addEventListener("click", () => (axo ? axoOff() : axoOn()));
  notesBtn?.addEventListener("click", () => {                            // Info: the notes, the sun path, the compasses, the dimensions and the levels, all together
    notesOn = !notesOn; notesBtn.classList.toggle("on", notesOn); layer.style.display = notesOn ? "" : "none"; if (!notesOn) closeCard();
    skyRoot.visible = dimRoot.visible = notesOn; root.classList.toggle("info-off", !notesOn); dirty = true;
  });
  notesBtn?.classList.add("on");
  resetBtn?.addEventListener("click", resetView);
  const pseudoFs = (on) => { root.classList.toggle("is-fs", on); document.documentElement.classList.toggle("v3-lock", on); if (on) window.scrollTo(0, 0); resize(); setTimeout(resize, 60); };
  const toggleFs = () => {
    const nat = document.fullscreenElement || document.webkitFullscreenElement;
    if (nat) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (root.classList.contains("is-fs")) { pseudoFs(false); return; }
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req) { try { const p = req.call(root); if (p && p.catch) p.catch(() => pseudoFs(true)); return; } catch (e) { /* fall through */ } }
    pseudoFs(true);
  };
  fsBtn?.addEventListener("click", toggleFs);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && root.classList.contains("is-fs")) pseudoFs(false); });
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(ev, () => { resize(); setTimeout(resize, 80); });
  controls.addEventListener("start", () => { userMoved = true; controls.autoRotate = false; autoBtn?.classList.remove("on"); clearTimeout(idleTimer); tween = null; siteLock = false; takeOver(); });
  controls.addEventListener("end", () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { }, 6000); });
  stage.addEventListener("pointerdown", (e) => { if (e.target === renderer.domElement && active) closeCard(); });

  let prCap = Math.min(window.devicePixelRatio || 1, 1.5), perfN = 0, perfSum = 0, lastR = 0;       // phones start at 1.5x and drop to 1x if they cannot hold about 25 fps
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight; const pr = prCap; dirty = true; renderer.setPixelRatio(pr); renderer.setSize(w, h, false); if (!lite) { composer.setPixelRatio(pr); composer.setSize(w, h); }
    const short = h < 450 && w / h > 1.3, was = heroShort; heroShort = short;
    if (was !== short && !userMoved && !tween && !axo && persp.position.distanceTo(controls.target) > 5) {          // refit, keeping the direction the camera looks from
      const off = persp.position.clone().sub(controls.target), sp = new THREE.Spherical().setFromVector3(off), want = new THREE.Spherical().setFromVector3(heroPos().clone().sub(heroTgt()));
      sp.radius = want.radius; sp.phi = want.phi; controls.target.copy(heroTgt()); persp.position.setFromSpherical(sp).add(controls.target);
    }
    persp.aspect = w / h; fovWant = lens30 ? 2 * Math.atan(0.6 / Math.max(1, w / h)) * 180 / Math.PI : (w / h < 1 ? Math.min(60, 26 / Math.max(0.5, w / h)) : 26);      // lens30: a 30 mm lens, its 36 mm side on the long side of the view
    if (!fovSet) { fovSet = true; persp.fov = fovWant; } persp.updateProjectionMatrix();
    const vh = 66, vw = vh * (w / h); ortho.left = -vw / 2; ortho.right = vw / 2; ortho.top = vh / 2; ortho.bottom = -vh / 2; ortho.updateProjectionMatrix();
    if (onResize) onResize();
  }
  function fitPage() {                                      // the viewer fits the first screen, from its top to the bottom of the window; the controls, when they sit below the view, fit in too
    const top = Math.max(document.querySelector("header.top")?.offsetHeight || 0, stage.getBoundingClientRect().top + scrollY), panel = root.querySelector(".v3-panel");     // the whole viewer on the first screen, under the page title
    const below = panel && panel.offsetHeight > 0 && getComputedStyle(root).display !== "grid";
    root.style.setProperty("--v3h", Math.max(220, window.innerHeight - top - (below ? panel.offsetHeight : 0) - 10) + "px");
  }
  addEventListener("resize", fitPage); new ResizeObserver(fitPage).observe(root.querySelector(".v3-panel")); fitPage();
  new ResizeObserver(resize).observe(stage); resize();

  // ---- VR (WebXR, Meta Quest 3): the page button enters / leaves an immersive session. In VR the post-processing chain is bypassed (direct render with the
  // renderer's own tone mapping, shadow maps lighter), the viewer stands on the lawn looking at the church. Left stick walks, right stick turns (snap) and moves the sun,
  // A opens / closes the church, X jumps between noon and the evening lights, Y leaves VR.
  const vrBtn = q('[data-act="vr"]');
  const rig = new THREE.Group(); scene.add(rig);
  let xrSession = null, xrSaved = null, xrCool = 0, xrTick = 0; const xrPrev = {};
  const xrFwd = new THREE.Vector3(), xrRight = new THREE.Vector3(), xrBg = new THREE.Color();
  const vrLabel = (on) => { if (!vrBtn) return; vrBtn.classList.toggle("on", on); const sp = vrBtn.querySelector("span"); if (sp) sp.textContent = on ? "Exit VR" : "VR"; vrBtn.title = on ? "Leave VR" : "Enter VR (Meta Quest 3 browser)"; };
  if (vrBtn) {
    if (!navigator.xr) vrBtn.classList.add("off");
    else navigator.xr.isSessionSupported("immersive-vr").then((ok) => { if (!ok) vrBtn.classList.add("off"); }).catch(() => vrBtn.classList.add("off"));
  }
  const vrHint = (t) => { const h = root.querySelector(".v3-hint"); if (!h) return; const o = h.dataset.o || (h.dataset.o = h.textContent); h.textContent = t; clearTimeout(vrHint.t); vrHint.t = setTimeout(() => { h.textContent = o; }, 5000); };
  async function toggleVR() {
    if (xrSession) { xrSession.end(); return; }
    if (!navigator.xr || vrBtn.classList.contains("off")) { vrHint("VR needs a headset browser (Meta Quest 3) and an https address"); return; }
    try {
      const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor"] });
      renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType("local-floor"); renderer.xr.setFramebufferScaleFactor(1.0);
      await renderer.xr.setSession(session); xrSession = session;
      xrSaved = { p: persp.position.clone(), q: persp.quaternion.clone(), cam: camera, tm: renderer.toneMapping, shMap: sun.shadow.mapSize.x };
      camera = persp; controls.enabled = false; tween = null; if (axo) axoOff(); closeCard();
      rig.add(persp); persp.position.set(0, 0, 0); persp.quaternion.identity(); persp.fov = 60; persp.near = 0.1; persp.updateProjectionMatrix();
      rig.position.set(44, 0, 36); rig.rotation.set(0, Math.atan2(44, 36), 0); const h0 = groundAt(rig.position.x, rig.position.z); if (h0 !== null) rig.position.y = h0;
      renderer.toneMapping = THREE.ACESFilmicToneMapping; sun.shadow.mapSize.set(2048, 2048); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      for (const L of floodRef) L.castShadow = false;                      // lighter on the headset
      for (const k of Object.keys(xrPrev)) delete xrPrev[k];
      session.addEventListener("end", endVR); vrLabel(true);
    } catch (e) { console.warn("VR not started", e); vrHint("VR could not start: " + (e && e.message ? e.message : e)); xrSession = null; }
  }
  function endVR() {
    if (!xrSession) return; xrSession = null;
    rig.remove(persp); persp.position.copy(xrSaved.p); persp.quaternion.copy(xrSaved.q); persp.near = 12; persp.updateProjectionMatrix();
    renderer.toneMapping = xrSaved.tm; scene.background = null; sun.shadow.mapSize.set(xrSaved.shMap, xrSaved.shMap); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    for (const L of floodRef) L.castShadow = true;
    controls.enabled = true; controls.update(); renderer.xr.enabled = false; vrLabel(false); resize();
  }
  vrBtn?.addEventListener("click", toggleVR);
  function xrStep(dt) {
    const cam = renderer.xr.getCamera(); xrCool -= dt;
    for (const src of xrSession.inputSources) {
      const gp = src.gamepad; if (!gp) continue; const hand = src.handedness, ax = gp.axes, x = ax[2] || 0, y = ax[3] || 0, prev = xrPrev[hand] || (xrPrev[hand] = []);
      const press = (i) => { const d = !!(gp.buttons[i] && gp.buttons[i].pressed), r = d && !prev[i]; prev[i] = d; return r; };
      if (hand === "left") {
        if (Math.hypot(x, y) > 0.15) {
          cam.getWorldDirection(xrFwd); xrFwd.y = 0; xrFwd.normalize(); xrRight.set(-xrFwd.z, 0, xrFwd.x);
          rig.position.addScaledVector(xrFwd, -y * 6 * dt).addScaledVector(xrRight, x * 6 * dt);
          const r = Math.hypot(rig.position.x, rig.position.z); if (r > 130) { rig.position.x *= 130 / r; rig.position.z *= 130 / r; }
        }
        if (press(4)) { sunIn.value = solar < 17 ? 18 : 12; upd(); }
        if (press(5)) { xrSession.end(); return; }
      } else if (hand === "right") {
        if (Math.abs(x) > 0.7 && xrCool <= 0) { rig.rotation.y -= Math.sign(x) * Math.PI / 6; xrCool = 0.3; }
        if (Math.abs(y) > 0.4) { sunIn.value = THREE.MathUtils.clamp(+sunIn.value - y * dt * 1.5, 7, 18.5); upd(); }
        if (press(4)) setOpen(!opened);
      }
    }
    if ((xrTick++ % 6) === 0) { const h = groundAt(rig.position.x, rig.position.z); if (h !== null) rig.position.y += (h - rig.position.y) * 0.5; }
    xrBg.setRGB(bgNow.x, bgNow.y, bgNow.z, THREE.SRGBColorSpace); scene.background = xrBg;
    renderer.toneMappingExposure = EXPOSURE * 0.36 * (1 + 0.35 * cutK) * (1 + 0.7 * nightK);
  }

  // ---- loop
  let last = performance.now(), visible = true;
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(stage);
  const camDir = new THREE.Vector3();
  function frame(now) {
    if (!visible && !renderer.xr.isPresenting) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (tween) {
      tween.t += dt * 1000 / tween.ms; const k = (tween.ease || ease)(Math.min(1, tween.t));
      if (tween.sph0) { const ka = tween.easeA(Math.min(1, tween.t)), a = tween.sph0, b = tween.sph1; camera.position.setFromSphericalCoords(a.radius + (b.radius - a.radius) * k, a.phi + (b.phi - a.phi) * k, a.theta + (b.theta - a.theta) * ka).add(tween.t1); controls.target.copy(tween.t1); }
      else { camera.position.lerpVectors(tween.p0, tween.p1, k); controls.target.lerpVectors(tween.t0, tween.t1, k); } if (tween.t >= 1) { const th = tween.then; tween = null; if (th) th(); }
    }
    if (cutTween) {
      shadowStale = true; cutTween.t += dt / 1.4; cutK = cutTween.from + (cutTween.to - cutTween.from) * ease(Math.min(1, cutTween.t));
      if (cutTween.t >= 1) { cutTween = null; if (cutK === 0) setCut(false); }
    }
    if (cutK > 0) {
      if (horiz) { cutPlane.normal.set(0, -1, 0); cutPlane.constant = THREE.MathUtils.lerp(80, groundY + cutH, cutK); }          // horizontal plan cut: keeps everything below this height
      else { cutPlane.normal.copy(cutDir).negate(); cutPlane.constant = THREE.MathUtils.lerp(80, cutS, cutK); }
    }
    planeViz.visible = false;                                          // the plane indicator is kept but hidden
    if (planeViz.visible) { planeViz.position.copy(cutDir).multiplyScalar(cutS).setY(13); planeViz.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cutDir); }
    if (renderer.xr.isPresenting && xrSession) {
      for (const L of intLights) L.intensity = 3.5 * Math.max(0, (cutK - 0.3) / 0.7);
      fill.intensity = 1.6 * cutK; xrStep(dt); if (shadowStale) { renderer.shadowMap.needsUpdate = true; shadowStale = false; } if (xrSession) renderer.render(scene, camera); return;
    }
    if (controls.autoRotate) { spinK = Math.min(1, spinK + dt / 3.0); controls.autoRotateSpeed = SPIN_SPEED * spinMul * spinK * spinK * (3 - 2 * spinK); } else spinK = 0;     // the spin eases in over 3 s; spinMul: slower when idle
    controls.dampingFactor = controls.autoRotate ? 1 : 0.07;                       // damping would make the spin creep up to speed over about a quarter of a second: no lag while it spins
    const moved = controls.update();
    if (Math.abs(persp.fov - fovWant) > 0.01 && !renderer.xr.isPresenting) { persp.fov += (fovWant - persp.fov) * Math.min(1, dt * 3); persp.updateProjectionMatrix(); dirty = true; }     // the lens changes smoothly
    if (siteLock && !tween) { const v = lockView(); camera.position.copy(v.p); controls.target.copy(v.t); camera.lookAt(v.t); }     // the compass always fills the view
    { const T = controls.target, caz = Math.atan2(camera.position.x - T.x, camera.position.z - T.z);
      if (controls.autoRotate && spinSun && camAzPrev !== null && !axo && !renderer.xr.isPresenting) {
        let d = caz - camAzPrev; d = Math.atan2(Math.sin(d), Math.cos(d));
        // the time of day runs with the spin (one whole day, 07:00 to 18:30, per turn of the camera) and the Sun slider moves with it; the sun's direction is corrected by the
        // difference, so that its angle to the camera stays the same: only its height follows the day
        if (!sunDone) {                                                                      // at the end of the day (18:30) the sun stops for good; the spin goes on alone
          if (sunAcc === null || Math.abs(sunAcc - solar) > 0.06) sunAcc = solar;           // the slider holds steps of 0.05 h only, so the running time is kept separately
          const az0 = Math.atan2(sunVector(solar).x, sunVector(solar).z);
          const dusk = Math.min(20, 12 + halfDay() - 0.2); sunAcc = Math.min(dusk, sunAcc + dt * SUN_RATE); solar = sunAcc;
          const az1 = Math.atan2(sunVector(solar).x, sunVector(solar).z); let daz = az1 - az0; daz = Math.atan2(Math.sin(daz), Math.cos(daz));
          sunAz += d - daz; sunIn.value = solar; sunOut.textContent = fmt(solar) + " solar"; applySun();
          if (sunAcc >= dusk) sunDone = true;
        }
      } else { sunAcc = null; sunDone = false; }
      camAzPrev = caz; }
    director(dt);
    if (!(moved || tween || cutTween || controls.autoRotate || dirty || now < dirtyUntil)) return;     // nothing changed: this frame is skipped
    dirty = false;
    updateCompass();
    camera.getWorldDirection(camDir);
    const r = stage.getBoundingClientRect();
    for (const s of spots) {
      const showSide = s.side === "int" ? opened && cutK > 0.85 : !opened || cutK < 0.3;
      tmp.copy(s.pos).project(camera);
      let vis = showSide && notesOn && tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
      if (vis && s.face) vis = s.face.dot(camDir) < 0.25;                          // facing away from the camera: hide
      if (vis && s.side !== "int" && !axo) {                                      // hide notes that sit behind the building (cheap test on the horizon of the model)
        const toCam = camera.position.clone().sub(s.pos).normalize(); if (s.face === null && toCam.y < -0.2) vis = false;
      }
      s.el.style.display = vis ? "" : "none";
      if (vis) s.el.style.transform = `translate(${((tmp.x + 1) / 2) * r.width}px, ${((1 - tmp.y) / 2) * r.height}px) translate(-50%, -50%)`;
      if (s === active) {
        if (!vis) closeCard(); else { const x = ((tmp.x + 1) / 2) * r.width, y = ((1 - tmp.y) / 2) * r.height; placeCard(x, y); }
      }
    }
    updateDims(r); updateTags(r);
    for (const L of intLights) L.intensity = 3.5 * Math.max(0, (cutK - 0.3) / 0.7);
    fill.intensity = 1.6 * cutK; finalPass.uniforms.uExposure.value = EXPOSURE * (1 + 0.35 * cutK) * (1 + 0.7 * nightK); finalPass.uniforms.uBg.value.copy(bgNow);
    if (shadowStale) { renderer.shadowMap.needsUpdate = true; shadowStale = false; }
    if (lite) { renderer.toneMappingExposure = EXPOSURE * 0.36 * (1 + 0.35 * cutK) * (1 + 0.7 * nightK); renderer.render(scene, camera); } else composer.render();
    if (lite) drawGhost();
    if (lite && prCap > 1 && (tween || controls.autoRotate)) {          // frame-rate guard while the camera is animating
      if (lastR) { perfSum += now - lastR; perfN++; } lastR = now;
      if (perfN === 90) { if (perfSum / perfN > 40) { prCap = 1; resize(); } perfN = 0; perfSum = 0; }
    } else lastR = 0;
  }
  renderer.setAnimationLoop(frame);
  const markDirty = () => { dirty = true; shadowStale = true; };
  for (const ev of ["input", "click", "pointerup", "keyup", "change"]) root.addEventListener(ev, markDirty, true);
  document.addEventListener("visibilitychange", markDirty);
  // ---- sun-of-the-day slider
  const sunUi = document.createElement("div"); sunUi.className = "v3-sun";
  sunUi.innerHTML = '<span class="label">Sun</span><input type="range" min="7" max="18.5" step="0.05" value="' + solar + '" aria-label="Time of day"><output></output>';
  root.querySelector(".v3-panel").appendChild(sunUi);
  const sunIn = sunUi.querySelector("input"), sunOut = sunUi.querySelector("output");
  const fmt = (h) => String(Math.floor(h)).padStart(2, "0") + ":" + String(Math.round((h % 1) * 60) % 60).padStart(2, "0");
  const upd = () => { solar = +sunIn.value; sunOut.textContent = fmt(solar) + " solar"; applySun(); };
  sunIn.addEventListener("input", upd); upd();
  sunIn.addEventListener("pointerdown", (e) => { e.stopPropagation(); controls.autoRotate = false; autoBtn?.classList.remove("on"); });      // taking the Sun slider is also taking over: the spin and the moving sun stop

  // ---- cuts: two vertical sections, 8 m off the centre, and three plans (heights above the bottom of the model)
  const CUTS = { sWE: { ang: 0, s: 8 }, sNS: { ang: 90, s: 8 }, p14: { h: 14 }, p55: { h: 5.5 }, p2: { h: 2 } };
  function applyCut(c) {
    horiz = c.h !== undefined;
    if (horiz) cutH = c.h; else { cutS = c.s; cutAng = c.ang * Math.PI / 180; cutDir.set(Math.cos(cutAng), 0, Math.sin(cutAng)); }
    shadowStale = true; dirty = true;
  }
  function cutFly() { if (horiz) flyTo(new THREE.Vector3(9, 96, 0), new THREE.Vector3(0, groundY + cutH - 4, 0)); else dirFlyTo(); }      // plan: from above, a little south of the target, so north is up
  function openCut(c) { applyCut(c); opened = true; setCut(true); root.classList.add("is-open"); cutTween = { from: 0, to: 1, t: 0 }; }     // each cut slides in from above / from the side
  function closeCut() { if (!opened && cutK === 0) return; opened = false; root.classList.remove("is-open"); cutTween = { from: cutK, to: 0, t: 0 }; }

  // ---- the spatial viewer: auto play (a loop of scenes, each with its name, a typed caption and a countdown bar) and take over (any touch: the scene stays,
  // and the controls for it appear). The captions are sample texts for now.
  const SCENES = [
    { id: "intro", name: "Intro", kind: "intro", dur: 15, text: "Le Corbusier's last church, designed from 1960 for Firminy-Vert. Left unfinished in 1978, completed by José Oubrerie in 2006." },
    { id: "site", name: "Site: Site Le Corbusier", kind: "site", dur: 10, text: "The church, the Maison de la Culture, the stadium, the swimming pool and the Unité d'habitation: the largest group of Le Corbusier's works in Europe." },
    { id: "light", name: "Light", kind: "light", dur: 15, text: "One day of sun on the concrete shell, from first light to dusk. Inside, daylight enters through the star holes, the light cannons and coloured slits.", text2: "At dusk the lights inside come on and the church glows through its openings, a lantern over the lawns of Firminy-Vert." },
    { id: "p14", name: "Plan +14", kind: "cut", dur: 7, text: "The nave: about 429 m², open to the full height of the concrete shell, lit through the star holes of the east wall." },
    { id: "p55", name: "Plan +5.5", kind: "cut", dur: 7, text: "Exhibition rooms: about 259 m² in the square base beneath the nave, the floors first planned for the parish rooms." },
    { id: "p2", name: "Plan +2", kind: "cut", dur: 7, text: "Lecture hall and exhibition space: about 148 m² on the lowest floor of the square base, under the exhibition rooms." },
    { id: "sWE", name: "Cross section W–E", kind: "cut", dur: 7, text: "West–east section: the square base with its floors below, the nave above, and the shell rising 33 m to the sloping circular roof." },
    { id: "sNS", name: "Cross section N–S", kind: "cut", dur: 7, text: "North–south section: the walls lean as the plan turns from a square at the base to a circle at the top, cut on a slant 33 m up." },
  ];
  // floor areas measured in the model (Blender metres; the floor under each plan cut); names after the published programme
  const AREAS = { p14: [["Nave", 429, 12.66, 11.09, 6.0], ["Landing", 21, 18.61, 19.83, 7.6]], p55: [["Exhibition rooms", 259, 15.55, 7.58, 1.4]], p2: [["Lecture hall · exhibition", 148, 12.92, 9.29, -1.3]] };
  let mode = "play", sceneI = 0, sceneT = 0, idleT = 0, firstRun = true, lightPhase = 0, nightOn = false, enhanced = false, poiT = 99;
  const ov = document.createElement("div"); ov.className = "v3-ov";
  ov.innerHTML = '<div class="v3-scene"></div><p class="v3-cap"></p><div class="v3-count"><i></i></div>';
  stage.appendChild(ov);
  const sceneEl = ov.querySelector(".v3-scene"), capEl = ov.querySelector(".v3-cap"), countEl = ov.querySelector(".v3-count i");
  const capRoom = () => Math.round((parseFloat(getComputedStyle(capEl).fontSize) || 14) * 1.2 * 3 + 36);     // room kept free for the caption (three lines) under the fitted views
  const capSize = () => { capEl.style.fontSize = Math.max(11, stage.clientHeight / 36).toFixed(1) + "px"; };     // three lines of caption stay within a tenth of the view's height
  new ResizeObserver(capSize).observe(stage); capSize();
  let typeTimer = 0;
  function typeCap(txt) { clearInterval(typeTimer); capEl.textContent = ""; let i = 0; typeTimer = setInterval(() => { i += 1; capEl.textContent = txt.slice(0, i); if (i >= txt.length) clearInterval(typeTimer); }, Math.min(38, 2500 / txt.length)); }
  function showCap(txt) { clearInterval(typeTimer); capEl.textContent = txt; }
  const capFor = () => { const S = SCENES[sceneI]; return lightPhase && S.text2 ? S.text2 : S.text; };
  // labels in the view: the other buildings of the site (site views) and the floor areas (plans)
  const tags = [];
  const mkTag = (html, cls, p, on, dy = 0) => { const e = document.createElement("span"); e.className = cls; e.innerHTML = html; dimLayer.appendChild(e); tags.push({ e, p, on, dy }); };
  for (const p of POIS) mkTag(`${p.name} <i>${p.dist < 1000 ? Math.round(p.dist / 5) * 5 : (p.dist / 1000).toFixed(1) + " k"} m</i>`, "v3-poi", p.at, () => enhanced && SCENES[sceneI].kind === "site" && p.k > 0.95, p.dy || 0);
  for (const id of Object.keys(AREAS)) for (const [nm, a, x, y, z] of AREAS[id]) mkTag(`${nm} <i>${a} m²</i>`, "v3-area", b2t(x, y, z), () => SCENES[sceneI].id === id && opened && cutK > 0.9);
  function updateTags(r) {
    for (const t of tags) {
      let vis = notesOn && t.on(); if (vis) { dimV.copy(t.p).project(camera); vis = dimV.z < 1 && Math.abs(dimV.x) < 1.1 && Math.abs(dimV.y) < 1.1; }
      t.e.style.display = vis ? "" : "none";
      if (vis) t.e.style.transform = `translate(${((dimV.x + 1) / 2) * r.width}px, ${((1 - dimV.y) / 2) * r.height + t.dy}px) translate(-50%, -50%)`;
    }
  }
  function enhance(on) { const site = SCENES[sceneI].kind === "site"; sunK = on && site ? 0.4 : 1; enhanced = on; arcBold.visible = on; arc.visible = !on; sunDisc.scale.setScalar(on ? (site ? 1.6 : 2.6) : 1); applySun(); poiRoot.visible = on && SCENES[sceneI].kind === "site"; dirty = true; }     // the arrows to the other buildings: site view only
  function setSolar(h) { solar = h; sunIn.value = h; sunOut.textContent = fmt(h) + " solar"; applySun(); }
  const nightHour = () => Math.min(20.5, 12 + halfDay() + 0.6);
  function siteView() {                                     // straight down on the compass, north up; the ring fitted between the title and the caption
    const w = stage.clientWidth, h = stage.clientHeight, top = 64, bottom = capRoom();
    const avail = Math.max(120, Math.min(w - 24, h - top - bottom)), t = Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    const D = (SKY_R + 18) * h / (avail * t), dy = ((bottom - top) / 2) * (2 * D * t / h);          // the ring sits in the free band: the camera aims a little south of it
    const T = new THREE.Vector3(SKY_C.x + dy, 0, SKY_C.z);
    return { p: T.clone().add(new THREE.Vector3(D * Math.sin(0.03), D * Math.cos(0.03), 0)), t: T };
  }
  function secView() {                                      // cross sections: one-point perspective, the camera square to the cut, the section fitted between the title and the caption
    const w = stage.clientWidth, h = stage.clientHeight, top = 64, bottom = capRoom(), t = Math.tan(THREE.MathUtils.degToRad(fovWant / 2));
    const side = new THREE.Vector3(-cutDir.z, 0, cutDir.x), c = new THREE.Vector3(0.15, (groundY + 33.3) / 2, -1.65), sz = new THREE.Vector3(25.3, 33.3 - groundY, 25.3);     // the church: its 25.3 m square and its height
    const W = Math.abs(side.x) * sz.x + Math.abs(side.z) * sz.z + 4, H = sz.y + 4;
    const D = Math.max(H * h / (2 * t * Math.max(120, h - top - bottom)), W * h / (2 * t * Math.max(120, w - 24))), dy = ((bottom - top) / 2) * (2 * D * t / h);
    const T = cutDir.clone().multiplyScalar(cutS).addScaledVector(side, side.dot(c)).setY(c.y - dy);
    return { p: T.clone().addScaledVector(cutDir, D), t: T };
  }
  const lockView = () => (lens30 ? secView() : siteView());
  function flyHero(ms, then) {                              // back to the hero framing, along a sphere round the church
    const HT = heroTgt(), s1 = new THREE.Spherical().setFromVector3(heroPos().clone().sub(HT)), s0 = new THREE.Spherical().setFromVector3(camera.position.clone().sub(HT));
    let d = s1.theta - s0.theta; d = Math.atan2(Math.sin(d), Math.cos(d)); s1.theta = s0.theta + d;
    tween = { t: 0, ms, sph0: s0, sph1: s1, p0: camera.position.clone(), t0: HT.clone(), p1: heroPos().clone(), t1: HT.clone(), ease, easeA: ease, then };
  }
  onResize = () => { if (siteLock) dirty = true; };          // a new size: the next frame refits the top view
  const startSpin = () => { if (mode !== "play") return; controls.autoRotate = true; spinSun = true; spinMul = 1; spinK = 1; };
  function enterScene(i) {
    sceneI = i; sceneT = 0; lightPhase = 0; const S = SCENES[i], play = mode === "play";
    root.dataset.scene = S.kind; sceneEl.textContent = S.name; (play ? typeCap : showCap)(S.text);
    for (const [act, k] of [["prev", -1], ["next", 1]]) { const b = q(`[data-act="${act}"]`), nm = SCENES[(i + k + SCENES.length) % SCENES.length].name; if (b) { b.querySelector("span").textContent = nm; b.title = nm; } }     // the buttons carry the names of the scenes they lead to
    controls.autoRotate = false; spinSun = false; spinMul = 1; tween = null; sunAz = 0; camAzPrev = null; userMoved = S.kind !== "intro";
    enhance(S.kind === "site" || S.kind === "light"); siteLock = S.kind === "site" || S.kind === "light";
    const sec = S.kind === "cut" && CUTS[S.id].h === undefined; if (sec !== lens30) { lens30 = sec; resize(); }
    if (S.kind === "site") { poiT = 0; for (const p of POIS) { p.k = 0; p.draw(0); } }                     // the arrows are drawn in, one after the other
    if (S.kind === "intro") {
      closeCut(); if (play) setSolar(firstRun ? 10 : 9);
      if (firstRun) { firstRun = false; introFlight(); } else flyHero(play ? 2200 : 1500, startSpin);
    } else if (S.kind === "site" || S.kind === "light") {
      closeCut(); const v = siteView(); flyTo(v.p, v.t, 1600);
      setSolar(S.kind === "light" ? 12 - halfDay() - 0.4 : 10.5);
    } else { openCut(CUTS[S.id]); setSolar(nightOn ? nightHour() : 12); if (sec) { siteLock = true; const v = secView(); flyTo(v.p, v.t, 1600); } else cutFly(); }
    dirty = true;
  }
  function director(dt) {
    if (renderer.xr.isPresenting) return;
    if (poiT < 4) {                                         // site view: each arrow grows out in 0.8 s, 0.35 s after the one before, once the camera has landed
      poiT += dt; POIS.forEach((p, i) => { const k = THREE.MathUtils.clamp((poiT - 1.4 - i * 0.35) / 0.8, 0, 1); if (k !== p.k) { p.k = k; p.draw(ease(k)); } }); dirty = true;
    }
    const S = SCENES[sceneI];
    if (mode === "play") {
      sceneT += dt;
      if (S.kind === "light") {
        const rise = 12 - halfDay(), set = 12 + halfDay();
        if (sceneT < 9) { const u = Math.min(1, sceneT / 9), e = u * u * (3 - 2 * u); setSolar(rise - 0.4 + (set - rise + 1.0) * e); }   // night to night in 9 s, slow at dawn and dusk
        else if (!lightPhase) { lightPhase = 1; siteLock = false; enhance(false); typeCap(S.text2); flyHero(3000, startSpin); }   // then back down to the spin
      }
      countEl.style.transform = `scaleX(${Math.max(0, 1 - sceneT / S.dur).toFixed(4)})`;
      if (sceneT >= S.dur) enterScene((sceneI + 1) % SCENES.length);
    } else {
      idleT += dt;
      if (idleT > 30 && !controls.autoRotate && !tween) { controls.autoRotate = true; spinMul = 0.3; spinSun = false; }   // idle for 30 s: a slow spin
    }
  }
  const coarse = matchMedia("(pointer: coarse)").matches;
  let touchRatio = 1;
  function setTouch() {                                     // phones: in auto play the page scrolls through the view, and a tap or a sideways drag takes over
    if (!coarse) return; controls.enabled = mode !== "play";
    renderer.domElement.style.touchAction = mode === "play" ? "pan-y" : (touchRatio >= 0.85 ? "none" : "pan-y");
  }
  function setHint() { const h = root.querySelector(".v3-hint"); if (h) h.textContent = mode === "play" ? "" : "drag to turn"; }          // in auto play the Tap to explore button says it
  root.querySelector(".v3-explore")?.addEventListener("click", () => takeOver());
  const PLAY_ICON = '<path d="M8 5l11 7-11 7z"/>', PAUSE_ICON = '<path d="M8 5v14M16 5v14"/>';
  function setMode(m) {
    mode = m; root.classList.toggle("is-play", m === "play"); root.classList.toggle("is-take", m === "take"); if (m === "take") root.classList.add("was-take");
    const pb = q('[data-act="play"]'); if (pb) { pb.querySelector("svg").innerHTML = m === "play" ? PAUSE_ICON : PLAY_ICON; pb.querySelector("span").textContent = m === "play" ? "Pause" : "Play"; pb.title = m === "play" ? "Pause" : "Auto play"; }
    idleT = 0; setTouch(); setHint(); fitPage(); dirty = true;
  }
  function takeOver() {
    idleT = 0;
    if (mode === "take") { if (spinMul < 1 && controls.autoRotate) controls.autoRotate = false; return; }
    setMode("take"); spinSun = false; controls.autoRotate = false;
    if (SCENES[sceneI].kind === "light" && lightPhase) { lightPhase = 0; enhance(true); siteLock = true; const v = siteView(); flyTo(v.p, v.t, 1200); }     // the light study stays on the sun path
    showCap(capFor());
  }
  {
    let pd = null; const el = renderer.domElement;
    el.addEventListener("pointerdown", (e) => { pd = { x: e.clientX, y: e.clientY }; idleT = 0; });
    el.addEventListener("pointermove", (e) => { if (pd && mode === "play" && Math.abs(e.clientX - pd.x) > 14 && Math.abs(e.clientX - pd.x) > Math.abs(e.clientY - pd.y)) { takeOver(); pd = null; } });
    el.addEventListener("pointerup", (e) => { if (pd && Math.hypot(e.clientX - pd.x, e.clientY - pd.y) < 10) takeOver(); pd = null; });
    el.addEventListener("pointercancel", () => { pd = null; });
    el.addEventListener("wheel", takeOver, { passive: true });
    root.querySelector(".v3-panel").addEventListener("pointerdown", () => { idleT = 0; if (spinMul < 1) controls.autoRotate = false; });
    if (coarse) new IntersectionObserver((e) => { touchRatio = e[0].intersectionRatio; setTouch(); }, { threshold: [0, 0.5, 0.85, 1] }).observe(stage);
  }
  // take-over controls: previous / play / next and info; per scene the sun, the day of the year, or day / night
  q('[data-act="prev"]')?.addEventListener("click", () => { setMode("take"); enterScene((sceneI + SCENES.length - 1) % SCENES.length); });
  q('[data-act="next"]')?.addEventListener("click", () => { setMode("take"); enterScene((sceneI + 1) % SCENES.length); });
  q('[data-act="play"]')?.addEventListener("click", () => { if (mode === "play") takeOver(); else { setMode("play"); enterScene(sceneI); } });     // play / pause
  q('[data-act="restart"]')?.addEventListener("click", () => {                                   // from the very beginning: as on first load, with the intro flight
    root.classList.remove("was-take"); if (!notesOn) notesBtn?.click();
    nightOn = false; dnBtn.textContent = "Night"; dnBtn.classList.remove("on"); dayIn.value = 237; updDay();
    firstRun = true; setMode("play"); enterScene(0);
  });
  sunIn.min = 4; sunIn.max = 20.5;
  const dayUi = document.createElement("div"); dayUi.className = "v3-sun v3-day";
  dayUi.innerHTML = '<span class="label">Day</span><input type="range" min="1" max="365" step="1" value="237" aria-label="Day of the year"><output></output>';
  root.querySelector(".v3-panel").appendChild(dayUi);
  const dayIn = dayUi.querySelector("input"), dayOut = dayUi.querySelector("output");
  const updDay = () => { const n = +dayIn.value; DECL = declFor(n); buildArc(); dayOut.textContent = new Date(2026, 0, n).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); applySun(); };
  dayIn.addEventListener("input", updDay); updDay();
  for (const el of [sunIn, dayIn]) el.addEventListener("input", () => { if (mode === "play") takeOver(); });          // moving a slider pauses the auto play
  const dnBtn = document.createElement("button"); dnBtn.type = "button"; dnBtn.className = "v3-dn"; dnBtn.textContent = "Night"; dnBtn.title = "Switch between day and night";
  dnBtn.addEventListener("click", () => { if (mode === "play") takeOver(); nightOn = !nightOn; dnBtn.textContent = nightOn ? "Day" : "Night"; dnBtn.classList.toggle("on", nightOn); setSolar(nightOn ? nightHour() : 12); });
  root.querySelector(".v3-panel").appendChild(dnBtn);
  for (const el of [sunUi, dayUi, dnBtn]) el.addEventListener("pointerdown", (e) => e.stopPropagation());

  if (/[?&]debug/.test(location.search)) window.__v3 = { renderer, scene, ghostScene, ghostMat, ghostEdge, gtao, finalPass, sun, hemi, composer, controls, camera: () => camera };
  root.classList.add("is-ready");
  // phones: turning to landscape fills the screen with the viewer (real full screen where the browser allows it without a tap, otherwise a fixed full-window
  // layer); turning back to portrait leaves it
  if (coarse) {
    const land = matchMedia("(orientation: landscape)");
    land.addEventListener("change", () => {
      const nat = document.fullscreenElement || document.webkitFullscreenElement, pseudo = root.classList.contains("is-fs");
      if (land.matches) {
        if (nat || pseudo) return;
        const req = root.requestFullscreen || root.webkitRequestFullscreen; let p = null;
        try { p = req ? req.call(root) : null; } catch (e) { p = null; }
        if (p && p.catch) p.catch(() => pseudoFs(true)); else if (!nat) pseudoFs(true);
      } else {
        if (nat) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        if (pseudo) { pseudoFs(false); root.scrollIntoView({ block: "start" }); }
      }
    });
  }
  setMode("play"); enterScene(0);                                   // auto play from the start
  return { setOpen, resetView, controls, renderer };
}
