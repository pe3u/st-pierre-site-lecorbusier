// Interior 360: equirectangular panoramas in WebGL2, three viewpoints with a cross-fade.
export function mountPano(root, { base = "assets/pano/", views = [] } = {}) {
  const stage = root.querySelector(".pn-stage"), cv = root.querySelector("canvas"), msg = root.querySelector(".pn-msg");
  const hud = root.querySelector(".pn-hud"), vbox = root.querySelector(".pn-views"), autoBtn = root.querySelector('[data-act="auto"]');
  const gl = cv.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) { msg.textContent = "This panorama needs WebGL2."; return; }
  const DEF = { yaw: 0, pitch: 8, fov: 78 };
  const vs = `#version 300 es
  in vec2 p; out vec2 ndc; void main(){ ndc = p; gl_Position = vec4(p, 0.0, 1.0); }`;
  const fs = `#version 300 es
  precision highp float; in vec2 ndc; out vec4 o;
  uniform sampler2D tA, tB; uniform float mixAB, yaw, pitch, tanHalf, aspect;
  const float PI = 3.14159265358979;
  vec3 smp(sampler2D t, vec3 d) {
    vec2 uv = vec2(atan(d.x, -d.z) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
    vec2 dx = vec2(dFdx(uv.x), dFdx(uv.y)), dy = vec2(dFdy(uv.x), dFdy(uv.y));
    dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);
    return textureGrad(t, uv, dx, dy).rgb;
  }
  void main() {
    vec3 r = normalize(vec3(ndc.x * tanHalf * aspect, ndc.y * tanHalf, -1.0));
    float cp = cos(pitch), sp = sin(pitch), cy = cos(yaw), sy = sin(yaw);
    r = vec3(r.x, r.y * cp - r.z * sp, r.y * sp + r.z * cp);
    r = vec3(r.x * cy + r.z * sy, r.y, -r.x * sy + r.z * cy);
    vec3 c = smp(tA, r); if (mixAB > 0.0) c = mix(c, smp(tB, r), mixAB);
    o = vec4(c, 1.0);
  }`;
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const u = { mixAB: U("mixAB"), yaw: U("yaw"), pitch: U("pitch"), tanHalf: U("tanHalf"), aspect: U("aspect") };
  gl.uniform1i(U("tA"), 0); gl.uniform1i(U("tB"), 1);
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  const tex = new Array(views.length), loading = new Array(views.length);
  function makeTexture(img) {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE); let src = img;
    if (img.naturalWidth > max) { const c = document.createElement("canvas"); c.width = max; c.height = max / 2; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); src = c; }
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  }
  function load(i) {
    if (tex[i]) return Promise.resolve(tex[i]); if (loading[i]) return loading[i];
    return (loading[i] = new Promise((res, rej) => { const im = new Image(); im.onload = () => { try { tex[i] = makeTexture(im); res(tex[i]); } catch (e) { rej(new Error("The browser blocked the image: open this page through the local server (Open site.bat).")); } }; im.onerror = () => rej(new Error("could not load " + views[i].file)); im.src = base + views[i].file; }));
  }
  let cur = 0, next = -1, mixv = 0, yaw = DEF.yaw, pitch = DEF.pitch, fov = DEF.fov, auto = false, started = false, visible = false;
  const rad = (d) => d * Math.PI / 180, clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function resize() { const dpr = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.round(stage.clientWidth * dpr); cv.height = Math.round(stage.clientHeight * dpr); gl.viewport(0, 0, cv.width, cv.height); }
  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible && !started) { started = true; load(0).then(() => { msg.classList.add("done"); mark(); resize(); }).catch((e2) => { msg.textContent = e2.message; }); } }, { rootMargin: "300px" }).observe(stage);
  function render() {
    if (!tex[cur]) return;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, next >= 0 && tex[next] ? tex[next] : tex[cur]);
    gl.uniform1f(u.mixAB, next >= 0 ? mixv : 0); gl.uniform1f(u.yaw, rad(yaw)); gl.uniform1f(u.pitch, rad(pitch)); gl.uniform1f(u.tanHalf, Math.tan(rad(fov) / 2)); gl.uniform1f(u.aspect, cv.width / cv.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3); hud.textContent = views[next >= 0 && mixv > 0.5 ? next : cur].name + " · " + Math.round(fov) + "°";
  }
  const look = (dy, dp) => { yaw = ((yaw + dy + 540) % 360) - 180; pitch = clamp(pitch + dp, -89, 89); };
  views.forEach((v, i) => { const b = document.createElement("button"); b.textContent = `${i + 1} ${v.name}`; b.addEventListener("click", () => go(i)); vbox.appendChild(b); });
  const mark = () => [...vbox.children].forEach((b, i) => b.classList.toggle("on", i === cur));
  async function go(i) {
    if (i === cur || next >= 0) return; msg.textContent = "Loading " + views[i].name + "…"; msg.classList.remove("done");
    try { await load(i); } catch (e) { msg.textContent = e.message; return; }
    msg.classList.add("done"); next = i; const t0 = performance.now();
    (function step(t) { mixv = Math.min(1, (t - t0) / 700); if (mixv < 1) requestAnimationFrame(step); else { cur = i; next = -1; mixv = 0; mark(); } })(t0);
  }
  const ptrs = new Map(); let pinch0 = 0;
  stage.addEventListener("pointerdown", (e) => { stage.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); stage.classList.add("drag"); auto = false; autoBtn.classList.remove("on"); if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
  stage.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return; const p = ptrs.get(e.pointerId), dx = e.clientX - p[0], dy = e.clientY - p[1]; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); fov = clamp(fov * pinch0 / d, 20, 110); pinch0 = d; return; }
    const k = fov / stage.clientHeight; look(dx * k, -dy * k);                                   // reversed pan: the view follows the hand
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) stage.classList.remove("drag"); };
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  stage.addEventListener("wheel", (e) => { e.preventDefault(); fov = clamp(fov * Math.exp(e.deltaY * 0.0012), 20, 110); }, { passive: false });
  stage.addEventListener("dblclick", () => { yaw = DEF.yaw; pitch = DEF.pitch; fov = DEF.fov; });
  autoBtn.addEventListener("click", () => { auto = !auto; autoBtn.classList.toggle("on", auto); });
  root.querySelector('[data-act="zin"]').addEventListener("click", () => (fov = clamp(fov * 0.8, 20, 110)));
  root.querySelector('[data-act="zout"]').addEventListener("click", () => (fov = clamp(fov / 0.8, 20, 110)));
  root.querySelector('[data-act="full"]').addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.()));
  let last = performance.now();
  (function frame(t) { if (visible) { if (auto && !ptrs.size) look((t - last) / 1000 * 6, 0); render(); } last = t; requestAnimationFrame(frame); })(last);
  resize();
}
