// Interior 360: equirectangular panoramas in WebGL2, three viewpoints with a cross-fade; the light cannons' cones drawn over them in the same view
export function mountPano(root, { base = "assets/pano/", views = [], cannons = [] } = {}) {
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
  const link = (v, f) => { const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, v)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, f)); gl.linkProgram(pr); return pr; };
  const prog = link(vs, fs); gl.useProgram(prog);
  const quadVao = gl.createVertexArray(); gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const u = { mixAB: U("mixAB"), yaw: U("yaw"), pitch: U("pitch"), tanHalf: U("tanHalf"), aspect: U("aspect") };
  gl.uniform1i(U("tA"), 0); gl.uniform1i(U("tB"), 1);

  // the cannons' light: an open cone from each tube's opening down its axis to where the light lands, fading down its length and towards its edges,
  // added onto the picture. Positions in Blender metres; seen from a viewpoint, Blender (x, y, z) is the panorama's (x, z, -y): the picture's centre looks along +y
  const cvs = `#version 300 es
  in vec3 pos; in vec3 nrm; in float along; uniform float yaw, pitch, tanHalf, aspect; out float vAlong; out vec3 vN; out vec3 vP;
  void main() {
    vAlong = along; vN = nrm; vP = pos;
    float cy = cos(yaw), sy = sin(yaw), cp = cos(pitch), sp = sin(pitch);
    vec3 a = vec3(pos.x * cy - pos.z * sy, pos.y, pos.x * sy + pos.z * cy);
    vec3 c = vec3(a.x, a.y * cp + a.z * sp, -a.y * sp + a.z * cp);
    const float n = 0.05, f = 400.0;
    gl_Position = vec4(c.x / (tanHalf * aspect), c.y / tanHalf, c.z * (f + n) / (n - f) + 2.0 * f * n / (n - f), -c.z);
  }`;
  const cfs = `#version 300 es
  precision highp float; in float vAlong; in vec3 vN; in vec3 vP; uniform vec3 col; uniform float op; out vec4 o;
  void main() { float a = op * pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.2) * pow(abs(dot(normalize(vN), normalize(-vP))), 1.5); o = vec4(col * a, 1.0); }`;
  const cprog = cannons.length ? link(cvs, cfs) : null;
  const CU = cprog ? { yaw: gl.getUniformLocation(cprog, "yaw"), pitch: gl.getUniformLocation(cprog, "pitch"), tanHalf: gl.getUniformLocation(cprog, "tanHalf"), aspect: gl.getUniformLocation(cprog, "aspect"), col: gl.getUniformLocation(cprog, "col"), op: gl.getUniformLocation(cprog, "op") } : null;
  const hexRgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
  function coneVao(c, at) {                                   // one cone, in the panorama's axes around the viewpoint
    const P = (b) => [b[0] - at[0], b[2] - at[2], -(b[1] - at[1])];
    const m = P(c.at), t = P(c.to), d = [t[0] - m[0], t[1] - m[1], t[2] - m[2]], len = Math.hypot(...d), ax = d.map((v) => v / len);
    const ang = Math.atan(3 * c.r / len) + 0.08, r2 = c.r + Math.tan(ang) * len;
    const up = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
    const e1 = norm(cross(ax, up)), e2 = cross(ax, e1), N = 32, pos = [], nrm = [], al = [];
    const ring = (k, rad, s) => { const a = k / N * Math.PI * 2, rx = Math.cos(a), ry = Math.sin(a), n = [e1[0] * rx + e2[0] * ry, e1[1] * rx + e2[1] * ry, e1[2] * rx + e2[2] * ry];
      return { p: [m[0] + ax[0] * len * s + n[0] * rad, m[1] + ax[1] * len * s + n[1] * rad, m[2] + ax[2] * len * s + n[2] * rad], n }; };
    for (let k = 0; k < N; k++) {
      const a0 = ring(k, c.r, 0), a1 = ring(k + 1, c.r, 0), b0 = ring(k, r2, 1), b1 = ring(k + 1, r2, 1);
      for (const [v, s] of [[a0, 0], [b0, 1], [b1, 1], [a0, 0], [b1, 1], [a1, 0]]) { pos.push(...v.p); nrm.push(...v.n); al.push(s); }
    }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    for (const [name, data, size] of [["pos", pos, 3], ["nrm", nrm, 3], ["along", al, 1]]) {
      const l = gl.getAttribLocation(cprog, name); gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    return { vao, n: pos.length / 3, col: hexRgb(c.col) };
  }
  const cones = views.map((v) => (cprog && v.at ? cannons.map((c) => coneVao(c, v.at)) : []));
  function drawCones(i, w) {
    if (!cprog || !cones[i] || !cones[i].length || w <= 0.001) return;
    gl.useProgram(cprog); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(CU.yaw, rad(yaw)); gl.uniform1f(CU.pitch, rad(pitch)); gl.uniform1f(CU.tanHalf, Math.tan(rad(fov) / 2)); gl.uniform1f(CU.aspect, cv.width / cv.height);
    for (const c of cones[i]) { gl.uniform3fv(CU.col, c.col); gl.uniform1f(CU.op, 0.24 * w); gl.bindVertexArray(c.vao); gl.drawArrays(gl.TRIANGLES, 0, c.n); }
    gl.disable(gl.BLEND); gl.bindVertexArray(quadVao); gl.useProgram(prog);
  }

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
  // auto: a slow turn, on from the start; a hand on the view stops it, and it eases back in after 12 s of rest
  let cur = 0, next = -1, mixv = 0, yaw = DEF.yaw, pitch = DEF.pitch, fov = DEF.fov, auto = true, autoK = 0, idle = 0, started = false, visible = false;
  autoBtn.classList.add("on");
  const SPIN = 2.5;                                           // degrees a second
  const hint = document.createElement("div"); hint.className = "pn-hint"; hint.textContent = "Tap and drag to look around"; stage.appendChild(hint);
  const rad = (d) => d * Math.PI / 180, clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function resize() { const dpr = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.round(stage.clientWidth * dpr); cv.height = Math.round(stage.clientHeight * dpr); gl.viewport(0, 0, cv.width, cv.height); }
  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible && !started) { started = true; load(0).then(() => { msg.classList.add("done"); mark(); resize(); }).catch((e2) => { msg.textContent = e2.message; }); } }, { rootMargin: "300px" }).observe(stage);
  function render() {
    if (!tex[cur]) return;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, next >= 0 && tex[next] ? tex[next] : tex[cur]);
    gl.uniform1f(u.mixAB, next >= 0 ? mixv : 0); gl.uniform1f(u.yaw, rad(yaw)); gl.uniform1f(u.pitch, rad(pitch)); gl.uniform1f(u.tanHalf, Math.tan(rad(fov) / 2)); gl.uniform1f(u.aspect, cv.width / cv.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (next >= 0) { drawCones(cur, 1 - mixv); drawCones(next, mixv); } else drawCones(cur, 1);
    hud.textContent = views[next >= 0 && mixv > 0.5 ? next : cur].name + " · " + Math.round(fov) + "°";
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
  stage.addEventListener("pointerdown", (e) => { stage.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); stage.classList.add("drag"); hint.classList.add("gone"); autoK = 0; idle = 0; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
  stage.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return; const p = ptrs.get(e.pointerId), dx = e.clientX - p[0], dy = e.clientY - p[1]; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); fov = clamp(fov * pinch0 / d, 20, 110); pinch0 = d; return; }
    const k = fov / stage.clientHeight; look(dx * k, dy * k);                                    // across: the view follows the hand; up and down: the other way
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) stage.classList.remove("drag"); idle = 0; };
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  stage.addEventListener("wheel", (e) => { e.preventDefault(); fov = clamp(fov * Math.exp(e.deltaY * 0.0012), 20, 110); idle = 0; autoK = 0; }, { passive: false });
  stage.addEventListener("dblclick", () => { yaw = DEF.yaw; pitch = DEF.pitch; fov = DEF.fov; });
  autoBtn.addEventListener("click", () => { auto = !auto; autoK = 0; idle = 99; autoBtn.classList.toggle("on", auto); });
  root.querySelector('[data-act="zin"]').addEventListener("click", () => (fov = clamp(fov * 0.8, 20, 110)));
  root.querySelector('[data-act="zout"]').addEventListener("click", () => (fov = clamp(fov / 0.8, 20, 110)));
  root.querySelector('[data-act="full"]').addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.()));
  let last = performance.now();
  (function frame(t) {
    if (visible) {
      const dt = Math.min(0.1, (t - last) / 1000);
      if (!ptrs.size) idle += dt;
      if (auto && !ptrs.size && idle > 12) { autoK = Math.min(1, autoK + dt / 2.5); look(dt * SPIN * autoK * autoK * (3 - 2 * autoK), 0); }    // eases in over 2.5 s
      render();
    }
    last = t; requestAnimationFrame(frame);
  })(last);
  idle = 99;                                                  // at first the turn starts straight away
  resize();
}
