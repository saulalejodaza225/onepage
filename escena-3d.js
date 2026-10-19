(function(){
'use strict';
const $ = (id) => document.getElementById(id);
const STAGE = document.getElementById("scene-3d");
const SW = () => Math.max(1, STAGE.clientWidth), SH = () => Math.max(1, STAGE.clientHeight);
const loader = $('loader');
function fail(msg){
  loader.classList.add('done');
  const box = $('nogl'); box.hidden = false;
  if (msg) box.querySelector('p').textContent = msg;
  $('hud').hidden = true;
}
if (!window.THREE) { fail('No se pudo cargar el motor 3D. Revisa tu conexión y vuelve a cargar la página.'); return; }
const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ---------- deterministic noise for procedural textures ---------- */
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = mulberry32(20261018);
function hash2i(x, y, s){ let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967295; }
function hash3i(x, y, z, s){ let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1103515245) + Math.imul(s, 982451653)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967295; }
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// periodic value noise: tiles seamlessly when fx, fy are integers
function pnoise2(x, y, px, py, s){
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hash2i(x0, y0, s), b = hash2i(x1, y0, s), c = hash2i(x0, y1, s), d = hash2i(x1, y1, s);
  const u = fade(xf), v = fade(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function pfbm2(u, v, fx, fy, oct, s){
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++){ sum += amp * pnoise2(u * fx, v * fy, fx, fy, s + i * 17); norm += amp; amp *= 0.5; fx *= 2; fy *= 2; }
  return sum / norm;
}
function vnoise3(x, y, z, s){
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const h = (a, b, c) => hash3i(xi + a, yi + b, zi + c, s);
  const x00 = lerp(h(0,0,0), h(1,0,0), u), x10 = lerp(h(0,1,0), h(1,1,0), u);
  const x01 = lerp(h(0,0,1), h(1,0,1), u), x11 = lerp(h(0,1,1), h(1,1,1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
function fbm3(x, y, z, oct, s){
  let sum = 0, a = 0.5, n = 0, f = 1;
  for (let i = 0; i < oct; i++){ sum += a * vnoise3(x * f, y * f, z * f, s + i * 31); n += a; a *= 0.5; f *= 2.03; }
  return sum / n;
}
function heightToNormal(H, w, h, strength){
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++){
    const ym = ((y - 1 + h) % h) * w, yp = ((y + 1) % h) * w, yr = y * w;
    for (let x = 0; x < w; x++){
      const xm = (x - 1 + w) % w, xp = (x + 1) % w;
      const nx = -(H[yr + xp] - H[yr + xm]) * strength, ny = -(H[yp + x] - H[ym + x]) * strength;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + 1), i = (yr + x) * 4;
      out[i] = (nx * l * 0.5 + 0.5) * 255; out[i + 1] = (ny * l * 0.5 + 0.5) * 255; out[i + 2] = (l * 0.5 + 0.5) * 255; out[i + 3] = 255;
    }
  }
  return out;
}

const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
requestAnimationFrame(() => setTimeout(() => {
  try { init(); } catch (e) { console.error(e); fail('No se pudo construir la escena 3D en este dispositivo.'); }
}, 0));

function init(){
  const T0 = performance.now(); const stamps = {};
  /* ---------- renderer ---------- */
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false }); }
  catch (e) { fail(); return; }
  const gl2 = renderer.capabilities.isWebGL2;
  const ext = renderer.extensions;
  const canHalf = gl2 ? (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'))
                      : (ext.has('OES_texture_half_float') && ext.has('EXT_color_buffer_half_float'));
  const HDR = canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const hasPost = !!(THREE.EffectComposer && THREE.RenderPass && THREE.ShaderPass && THREE.UnrealBloomPass && THREE.CopyShader);
  const PIXEL_BUDGET = 4.2e6;
  const maxPrFor = () => Math.max(0.8, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(PIXEL_BUDGET / Math.max(1, SW() * SH()))));
  let MAX_PR = maxPrFor();
  let pr = MAX_PR;
  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());

  renderer.setPixelRatio(pr);
  renderer.setSize(SW(), SH());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  if (!hasPost){ renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputEncoding = THREE.sRGBEncoding; }
  STAGE.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, SW() / SH(), 0.05, 2400);
  camera.position.set(0.7, 1.55, 2.3);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.2, -1.6);
  controls.enableDamping = true; controls.dampingFactor = 0.06;
  controls.enablePan = false; controls.rotateSpeed = 0.55; controls.zoomSpeed = 0.7;
  controls.minDistance = 1.6; controls.maxDistance = 4.2;
  controls.minPolarAngle = 0.75; controls.maxPolarAngle = 2.2;
  // home view: straight behind the astronaut, looking down the throat
  const HOME = new THREE.Spherical(4.15, 1.24, 0);
  function goHome(){ camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(HOME)); camera.lookAt(controls.target); controls.update(); }
  goHome();

  const C = (hex) => new THREE.Color(hex).convertSRGBToLinear();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  /* ---------- texture helpers ---------- */
  function dataTex(data, w, h, srgb){
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.anisotropy = aniso;
    if (srgb) t.encoding = THREE.sRGBEncoding;
    t.needsUpdate = true;
    return t;
  }
  function makeCanvas(w, h){ const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function canvasTex(c, srgb){ const t = new THREE.CanvasTexture(c); t.anisotropy = aniso; if (srgb) t.encoding = THREE.sRGBEncoding; return t; }
  function rep(t, rx, ry){ const c = t.clone(); c.repeat.set(rx, ry); c.needsUpdate = true; return c; }

  /* beta-cloth suit fabric: plain weave, quilting seams with stitches, folds, scuffs */
  function lowField(fn){
    const LF = 256, A = new Float32Array(LF * LF);
    for (let y = 0; y < LF; y++) for (let x = 0; x < LF; x++) A[y * LF + x] = fn(x / LF, y / LF);
    return (u, v) => {
      const fx = u * LF, fy = v * LF, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const xa = x0 & 255, xb = (x0 + 1) & 255, ya = (y0 & 255) * LF, yb = ((y0 + 1) & 255) * LF;
      return lerp(lerp(A[ya + xa], A[ya + xb], tx), lerp(A[yb + xa], A[yb + xb], tx), ty);
    };
  }
  function genFabric(size){
    const H = new Float32Array(size * size), col = new Uint8Array(size * size * 4), rough = new Uint8Array(size * size * 4);
    const foldsF = lowField((u, v) => pfbm2(u, v, 2, 5, 4, 11)), mottleF = lowField((u, v) => pfbm2(u, v, 4, 4, 4, 23)), grimeF = lowField((u, v) => pfbm2(u, v, 6, 6, 4, 37));
    const N = 96;
    for (let y = 0; y < size; y++){
      const v = y / size;
      for (let x = 0; x < size; x++){
        const u = x / size, i = y * size + x;
        const tu = u * N, tv = v * N;
        const a = Math.abs(Math.sin(Math.PI * tu)), b = Math.abs(Math.sin(Math.PI * tv));
        const weave = ((tu | 0) + (tv | 0)) & 1 ? a * 0.7 + b * 0.3 : b * 0.7 + a * 0.3;
        const folds = foldsF(u, v), mottle = mottleF(u, v), grime = grimeF(u, v);
        const sv = v * 4 + 0.012 * Math.sin(Math.PI * 2 * u * 2);
        const fs = sv - Math.floor(sv) - 0.5;
        const seam = Math.exp(-fs * fs * 2600);
        const stitch = seam * (0.5 + 0.5 * Math.sin(Math.PI * 2 * u * 72));
        H[i] = weave * 0.06 + folds * 3.2 + mottle * 0.6 - seam * 0.55 + stitch * 0.09;
        const dirt = smooth(0.68, 0.88, grime) * 0.55;
        const L = 0.86 + (mottle - 0.5) * 0.07 - seam * 0.12 - weave * 0.035;
        col[i*4] = L * (1 - dirt * 0.2) * 247; col[i*4+1] = L * (1 - dirt * 0.24) * 244; col[i*4+2] = L * (1 - dirt * 0.32) * 236; col[i*4+3] = 255;
        const R = Math.min(1, 0.78 + weave * 0.08 + dirt * 0.1 + seam * 0.06) * 255;
        rough[i*4] = rough[i*4+1] = rough[i*4+2] = R; rough[i*4+3] = 255;
      }
    }
    return { color: dataTex(col, size, size, true), normal: dataTex(heightToNormal(H, size, size, 5), size, size), rough: dataTex(rough, size, size) };
  }
  /* basalt-like rock: mottled ochre/grey, ridges, mineral specks */
  function genRock(size){
    const H = new Float32Array(size * size), col = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++){
      const v = y / size;
      for (let x = 0; x < size; x++){
        const u = x / size, i = y * size + x;
        const n = pfbm2(u, v, 4, 4, 6, 51);
        const r = 1 - Math.abs(pfbm2(u, v, 8, 8, 4, 61) * 2 - 1);
        const tint = pfbm2(u, v, 3, 3, 4, 71);
        const speck = hash2i(x, y, 99) > 0.986 ? 1 : 0;
        H[i] = n * 1.6 + r * 0.55 + speck * 0.12;
        const k = 0.72 + n * 0.55;
        const rr = lerp(0.17, 0.38, tint) * k + speck * 0.35, gg = lerp(0.16, 0.30, tint) * k + speck * 0.33, bb = lerp(0.155, 0.22, tint) * k + speck * 0.3;
        col[i*4] = Math.min(255, rr * 255); col[i*4+1] = Math.min(255, gg * 255); col[i*4+2] = Math.min(255, bb * 255); col[i*4+3] = 255;
      }
    }
    return { color: dataTex(col, size, size, true), normal: dataTex(heightToNormal(H, size, size, 7), size, size) };
  }
  function genHeightNormal(w, h, fn, strength){
    const H = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H[y * w + x] = fn(x / w, y / h, x, y);
    return dataTex(heightToNormal(H, w, h, strength), w, h);
  }
  function genShell(size){
    const d = new Uint8Array(size * size * 4), c = new Uint8Array(size * size * 4);
    const scuffF = lowField((u, v) => pfbm2(u, v, 8, 2, 4, 141)), nF = lowField((u, v) => pfbm2(u, v, 4, 4, 4, 131));
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++){
      const u = x / size, v = y / size, i = (y * size + x) * 4;
      const scuff = smooth(0.62, 0.85, scuffF(u, v));
      const n = nF(u, v);
      const r = (0.26 + n * 0.14 + scuff * 0.22) * 255;
      d[i] = d[i+1] = d[i+2] = r; d[i+3] = 255;
      const L = (0.88 + (n - 0.5) * 0.05 - scuff * 0.06) * 255;
      c[i] = L; c[i+1] = L * 0.995; c[i+2] = L * 0.985; c[i+3] = 255;
    }
    return { rough: dataTex(d, size, size), color: dataTex(c, size, size, true) };
  }

  stamps.gl = performance.now();
  const fabric = genFabric(1024);
  const shellTx = genShell(512);
  const rock = genRock(512);
  const TX = {
    fabricColor: fabric.color, fabricNormal: fabric.normal, fabricRough: fabric.rough,
    rockColor: rock.color, rockNormal: rock.normal,
    foilNormal: genHeightNormal(256, 256, (u, v) => (1 - Math.abs(pfbm2(u, v, 6, 6, 5, 81) * 2 - 1)) + pfbm2(u, v, 16, 16, 3, 91) * 0.3, 6),
    metalNormal: genHeightNormal(256, 256, (u, v) => pfbm2(u, v, 1, 96, 3, 101) * 0.8 + pfbm2(u, v, 2, 12, 3, 111) * 0.2, 2.2),
    ribNormal: genHeightNormal(256, 8, (u) => Math.abs(Math.sin(Math.PI * u * 8)), 5),
    shellRough: shellTx.rough, shellColor: shellTx.color
  };

  stamps.tex = performance.now();
  /* mission patch (an original design): receding wormhole rings */
  function drawPatch(){
    const s = 512, c = makeCanvas(s, s), g = c.getContext('2d'), cx = s / 2, cy = s / 2, inner = s * 0.39;
    g.fillStyle = '#ece8de'; g.beginPath(); g.arc(cx, cy, s / 2, 0, Math.PI * 2); g.fill();
    const bg = g.createRadialGradient(cx, cy * 0.9, 10, cx, cy, inner);
    bg.addColorStop(0, '#2c1276'); bg.addColorStop(0.6, '#120934'); bg.addColorStop(1, '#07051a');
    g.fillStyle = bg; g.beginPath(); g.arc(cx, cy, inner, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(cx, cy, inner, 0, Math.PI * 2); g.clip();
    for (let i = 0; i < 80; i++){ g.fillStyle = 'rgba(255,255,255,' + (0.3 + rand() * 0.7).toFixed(2) + ')'; g.beginPath(); g.arc(cx + (rand() - 0.5) * 2 * inner, cy + (rand() - 0.5) * 2 * inner, 0.5 + rand() * 1.8, 0, Math.PI * 2); g.fill(); }
    for (let i = 0; i < 11; i++){
      const k = i / 10, rx = inner * (0.94 - k * 0.8), ry = rx * 0.38, y = cy + inner * 0.2 - k * inner * 0.36;
      g.strokeStyle = 'hsla(' + (305 - i * 17) + ',95%,' + (58 + k * 14) + '%,' + (0.95 - k * 0.3) + ')';
      g.lineWidth = 7 - k * 5; g.beginPath(); g.ellipse(cx, y, rx, ry, 0, 0, Math.PI * 2); g.stroke();
    }
    const glow = g.createRadialGradient(cx, cy - inner * 0.16, 0, cx, cy - inner * 0.16, inner * 0.28);
    glow.addColorStop(0, 'rgba(255,240,222,1)'); glow.addColorStop(1, 'rgba(255,240,222,0)');
    g.fillStyle = glow; g.fillRect(0, 0, s, s);
    g.restore();
    g.strokeStyle = '#c99a3c'; g.lineWidth = 8; g.beginPath(); g.arc(cx, cy, inner + 4, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 7; g.beginPath(); g.arc(cx, cy, s / 2 - 5, 0, Math.PI * 2); g.stroke();
    const chars = Array.from('UMBRAL · ER-7 · TRÁNSITO · ');
    g.fillStyle = '#17133b'; g.font = '600 38px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const R = (inner + s / 2) / 2 + 2, step = Math.PI * 2 / chars.length;
    chars.forEach((ch, i) => { const a = -Math.PI / 2 + i * step; g.save(); g.translate(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.rotate(a + Math.PI / 2); g.fillText(ch, 0, 0); g.restore(); });
    return canvasTex(c, true);
  }
  /* broken solar array cells */
  function drawSolar(){
    const s = 512, c = makeCanvas(s, s), g = c.getContext('2d'), n = 4, gap = 10, cs = (s - gap * (n + 1)) / n;
    g.fillStyle = '#bfc4cc'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++){
      const x = gap + i * (cs + gap), y = gap + j * (cs + gap);
      const gr = g.createLinearGradient(x, y, x + cs, y + cs);
      gr.addColorStop(0, '#0b1745'); gr.addColorStop(0.5, '#152d78'); gr.addColorStop(1, '#0a153e');
      g.fillStyle = gr; g.fillRect(x, y, cs, cs);
      g.strokeStyle = 'rgba(200,208,224,.32)'; g.lineWidth = 1;
      for (let k = 1; k < 22; k++){ const yy = y + k * cs / 22; g.beginPath(); g.moveTo(x, yy); g.lineTo(x + cs, yy); g.stroke(); }
      g.strokeStyle = '#c7ced9'; g.lineWidth = 3;
      [0.3, 0.7].forEach((f) => { g.beginPath(); g.moveTo(x + cs * f, y); g.lineTo(x + cs * f, y + cs); g.stroke(); });
      g.fillStyle = '#bfc4cc'; const k = cs * 0.12;
      [[x, y, 1, 1], [x + cs, y, -1, 1], [x, y + cs, 1, -1], [x + cs, y + cs, -1, -1]].forEach(([px, py, dx, dy]) => { g.beginPath(); g.moveTo(px, py); g.lineTo(px + dx * k, py); g.lineTo(px, py + dy * k); g.closePath(); g.fill(); });
    }
    return canvasTex(c, true);
  }
  /* chest display (DCM) */
  const screenCanvas = makeCanvas(256, 104);
  const screenTex = canvasTex(screenCanvas, true);
  function drawScreen(o2){
    const g = screenCanvas.getContext('2d');
    g.fillStyle = '#03141c'; g.fillRect(0, 0, 256, 104);
    g.font = '500 22px "IBM Plex Mono", monospace'; g.textBaseline = 'alphabetic';
    g.fillStyle = '#8ef6ff'; g.fillText('O2 ' + o2.toFixed(1).replace('.', ',') + '%', 12, 34); g.fillText('29,6 kPa', 140, 34);
    g.fillStyle = '#ffcf7a'; g.fillText('CO2 0,4', 12, 64);
    g.fillStyle = '#8ef6ff'; g.fillText('BAT 64%', 140, 64);
    g.fillStyle = 'rgba(142,246,255,.55)'; g.font = '500 15px "IBM Plex Mono", monospace'; g.fillText('DCM-7 · NOMINAL', 12, 92);
    screenTex.needsUpdate = true;
  }
  drawScreen(87);

  /* ---------- materials ---------- */
  function fabricMat(rx, ry, tint, extra){
    return new THREE.MeshPhysicalMaterial(Object.assign({
      color: C(tint || '#ffffff'),
      map: rep(TX.fabricColor, rx, ry), normalMap: rep(TX.fabricNormal, rx, ry), roughnessMap: rep(TX.fabricRough, rx, ry),
      normalScale: new THREE.Vector2(1, 1), roughness: 1, metalness: 0,
      sheen: 0.25, sheenRoughness: 0.55, sheenColor: C('#ffffff'), envMapIntensity: 0.45
    }, extra || {}));
  }
  const fTorso = fabricMat(5, 2.2), fLimb = fabricMat(2, 2.5), fSmall = fabricMat(1, 1);
  const fGlove = fabricMat(1.2, 1.2, '#d6d5cf'), fRed = fabricMat(2, 0.4, '#c4252d'), fPack = fabricMat(1.3, 1.3);
  const tetherMat = fabricMat(46, 1, '#e3d7b8', { sheen: 0.3 });
  const alu = new THREE.MeshPhysicalMaterial({ color: C('#cdd2da'), metalness: 1, roughness: 0.26, normalMap: TX.metalNormal, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.25 });
  const anodBlue = alu.clone(); anodBlue.color = C('#2e63d8'); anodBlue.roughness = 0.34;
  const anodRed = alu.clone(); anodRed.color = C('#c73a2f'); anodRed.roughness = 0.34;
  const shell = new THREE.MeshPhysicalMaterial({ color: C('#ffffff'), map: TX.shellColor, roughness: 1, roughnessMap: TX.shellRough, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.12, envMapIntensity: 0.7 });
  const shellD = shell;
  const rubber = new THREE.MeshStandardMaterial({ color: C('#1d1e22'), roughness: 0.86, metalness: 0, envMapIntensity: 0.6 });
  const plastic = new THREE.MeshPhysicalMaterial({ color: C('#9a9fa8'), map: TX.shellColor, roughness: 1, roughnessMap: TX.shellRough, clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 0.9 });
  const hoseMat = new THREE.MeshPhysicalMaterial({ color: C('#3a3d44'), metalness: 0, roughness: 0.5, normalMap: rep(TX.ribNormal, 10, 1), normalScale: new THREE.Vector2(1.2, 1.2), envMapIntensity: 0.9 });
  const visorMat = new THREE.MeshPhysicalMaterial({ color: C('#ffe3a8'), metalness: 1, roughness: 0.035, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.75, iridescenceIOR: 1.8, iridescenceThicknessRange: [180, 520], envMapIntensity: 1.7 });
  const lampLens = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: C('#d8ecff'), emissiveIntensity: 1.5, roughness: 0.2 });
  const ledG = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 3.0, 0.6) });
  const ledA = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.4, 0.1) });
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, color: new THREE.Color(1.7, 1.7, 1.7) });
  const patchMat = new THREE.MeshPhysicalMaterial({ map: drawPatch(), normalMap: rep(TX.fabricNormal, 2, 2), normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: rep(TX.fabricRough, 2, 2), roughness: 1, metalness: 0, sheen: 0.4, sheenRoughness: 0.5, sheenColor: C('#ffffff'), envMapIntensity: 0.8 });
  const goldFoil = new THREE.MeshPhysicalMaterial({ color: C('#e0a83a'), metalness: 1, roughness: 0.24, normalMap: TX.foilNormal, normalScale: new THREE.Vector2(0.9, 0.9), side: THREE.DoubleSide, envMapIntensity: 1.5 });
  const silverFoil = goldFoil.clone(); silverFoil.color = C('#d0d3da');
  const solarMat = new THREE.MeshPhysicalMaterial({ map: drawSolar(), roughnessMap: TX.shellRough, metalness: 0.2, roughness: 0.6, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.2 });
  const backMat = new THREE.MeshStandardMaterial({ color: C('#e9e6dd'), roughness: 0.7, envMapIntensity: 0.8 });

  fontsReady.then(() => { const old = patchMat.map; patchMat.map = drawPatch(); patchMat.needsUpdate = true; if (old) old.dispose(); drawScreen(87); });

  /* ---------- geometry helpers ---------- */
  function add(geo, mat, parent, p, r, s){
    const m = new THREE.Mesh(geo, mat);
    if (p) m.position.set(p[0], p[1], p[2]);
    if (r) m.rotation.set(r[0], r[1], r[2]);
    if (s) m.scale.set(s[0], s[1], s[2]);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  }
  const V2 = (r, y) => new THREE.Vector2(r, y);
  const ringGeo = (R, r) => new THREE.TorusGeometry(R, r, 12, 56).rotateX(Math.PI / 2);
  // rounded box from a subdivided cube; edge bands get extra vertices so corners stay smooth
  function roundedBox(w, h, d, r, seg, band){
    seg = seg || 12; band = band || 3;
    const g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
    const pos = g.attributes.position, nor = g.attributes.normal;
    const half = [w / 2, h / 2, d / 2], n0 = seg / 2 - band;
    const map = (t, H) => { const kf = Math.abs(t) * seg; const x = kf <= n0 ? (H - r) * kf / n0 : (H - r) + r * (kf - n0) / band; return Math.sign(t) * x; };
    const p = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++){
      p.set(map(pos.getX(i), half[0]), map(pos.getY(i), half[1]), map(pos.getZ(i), half[2]));
      c.set(THREE.MathUtils.clamp(p.x, -half[0] + r, half[0] - r), THREE.MathUtils.clamp(p.y, -half[1] + r, half[1] - r), THREE.MathUtils.clamp(p.z, -half[2] + r, half[2] - r));
      n.subVectors(p, c);
      if (n.lengthSq() < 1e-12) n.fromBufferAttribute(nor, i); else n.normalize();
      p.copy(c).addScaledVector(n, r);
      pos.setXYZ(i, p.x, p.y, p.z); nor.setXYZ(i, n.x, n.y, n.z);
    }
    return g;
  }
  function fixSeams(g){
    const pos = g.attributes.position, nor = g.attributes.normal, mapN = new Map();
    for (let i = 0; i < pos.count; i++){
      const k = pos.getX(i).toFixed(4) + ',' + pos.getY(i).toFixed(4) + ',' + pos.getZ(i).toFixed(4);
      let e = mapN.get(k); if (!e){ e = { n: new THREE.Vector3(), idx: [] }; mapN.set(k, e); }
      e.n.x += nor.getX(i); e.n.y += nor.getY(i); e.n.z += nor.getZ(i); e.idx.push(i);
    }
    mapN.forEach((e) => { if (e.idx.length > 1){ e.n.normalize(); e.idx.forEach((i) => nor.setXYZ(i, e.n.x, e.n.y, e.n.z)); } });
    nor.needsUpdate = true;
  }

  /* ---------- the astronaut ---------- */
  const astro = new THREE.Group(); scene.add(astro);
  const body = new THREE.Group(); body.position.y = -0.12; astro.add(body);   // pelvis frame
  const waist = new THREE.Group(); waist.position.y = 0.05; body.add(waist);   // waist bearing: the upper body twists and bends here
  const chest = new THREE.Group(); chest.position.y = -0.05; waist.add(chest); // upper body keeps pelvis coordinates

  // upper torso (hard shell under its fabric cover) and lower torso (brief), elliptical cross-section
  add(new THREE.LatheGeometry([V2(0,0.0),V2(0.17,0.0),V2(0.2,0.04),V2(0.215,0.12),V2(0.24,0.26),V2(0.262,0.4),V2(0.272,0.49),V2(0.266,0.57),V2(0.24,0.625),V2(0.19,0.66),V2(0.145,0.675),V2(0,0.68)], 64, Math.PI), fTorso, chest, [0,0,0], null, [1,1,0.7]);
  add(new THREE.LatheGeometry([V2(0,0.07),V2(0.19,0.07),V2(0.202,0.02),V2(0.2,-0.07),V2(0.188,-0.15),V2(0.155,-0.205),V2(0.095,-0.232),V2(0,-0.24)], 64, Math.PI), fTorso, body, [0,0,0], null, [1,1,0.76]);
  add(ringGeo(0.207, 0.02), alu, body, [0,0.045,0], null, [1,1,0.73]);
  add(ringGeo(0.209, 0.008), anodBlue, chest, [0,0.074,0], null, [1,1,0.72]);
  add(ringGeo(0.142, 0.024), alu, chest, [0,0.675,0], null, [1,1,0.95]);
  add(ringGeo(0.137, 0.011), anodRed, chest, [0,0.703,0], null, [1,1,0.95]);

  // mission patch on the left chest, laid onto the torso curve
  { const x = 0.135, a = 0.272, b = 0.272 * 0.7, z = b * Math.sqrt(1 - (x / a) ** 2);
    const pm = add(new THREE.CircleGeometry(0.042, 48), patchMat, chest, [x, 0.505, z + 0.004]);
    pm.rotation.y = Math.atan2(x / (a * a), z / (b * b)); }

  // helmet with recessed iridescent visor
  const helm = new THREE.Group(); helm.position.set(0, 0.85, 0.02); chest.add(helm);
  const VP0 = Math.PI / 2 - 1.12, VPL = 2.24, VT0 = 0.62, VTL = 1.2;
  add(new THREE.SphereGeometry(0.19, 64, 48), shell, helm);
  add(new THREE.SphereGeometry(0.197, 72, 40, VP0, VPL, VT0, VTL), visorMat, helm);
  add(new THREE.SphereGeometry(0.2045, 72, 24, 0, Math.PI * 2, 0, VT0 + 0.012), shellD, helm);
  add(new THREE.SphereGeometry(0.203, 72, 32, VP0 + VPL, Math.PI * 2 - VPL, VT0 - 0.02, 1.5), shellD, helm);
  { const pts = [], N = 120, k = 9, pc = VP0 + VPL / 2, prr = VPL / 2, tc = VT0 + VTL / 2, tr = VTL / 2, rr = 0.2058;
    for (let i = 0; i < N; i++){
      const a = i / N * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const phi = pc + prr * Math.sign(ca) * Math.pow(Math.abs(ca), 2 / k), th = tc + tr * Math.sign(sa) * Math.pow(Math.abs(sa), 2 / k);
      pts.push(V(-rr * Math.cos(phi) * Math.sin(th), rr * Math.cos(th), rr * Math.sin(phi) * Math.sin(th)));
    }
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 240, 0.0068, 10, true), alu, helm); }
  for (const s of [-1, 1]){
    const lamp = new THREE.Group(); lamp.position.set(s * 0.188, 0.075, 0.035); lamp.rotation.y = s * 0.22; helm.add(lamp);
    add(new THREE.CylinderGeometry(0.034, 0.037, 0.09, 32).rotateX(Math.PI / 2), shell, lamp);
    add(new THREE.CylinderGeometry(0.037, 0.037, 0.012, 32).rotateX(Math.PI / 2), alu, lamp, [0, 0, 0.049]);
    add(new THREE.CircleGeometry(0.028, 32), lampLens, lamp, [0, 0, 0.0556]);
    add(roundedBox(0.03, 0.022, 0.06, 0.008, 8, 2), shell, lamp, [-s * 0.03, -0.032, -0.005]);
  }
  add(roundedBox(0.045, 0.038, 0.065, 0.01, 8, 2), plastic, helm, [-0.095, 0.172, 0.05]);
  add(new THREE.CircleGeometry(0.011, 20), rubber, helm, [-0.095, 0.172, 0.0832]);

  // life-support backpack (PLSS)
  add(roundedBox(0.5, 0.64, 0.22, 0.055), fPack, chest, [0, 0.36, -0.29]);
  add(roundedBox(0.42, 0.13, 0.19, 0.04), fPack, chest, [0, -0.035, -0.285]);
  add(roundedBox(0.32, 0.09, 0.17, 0.035), shell, chest, [0, 0.705, -0.3]);
  add(roundedBox(0.19, 0.27, 0.016, 0.006, 8, 2), plastic, chest, [-0.115, 0.42, -0.403]);
  add(roundedBox(0.19, 0.27, 0.016, 0.006, 8, 2), plastic, chest, [0.115, 0.42, -0.403]);
  add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(-0.16,0.66,-0.405), V(-0.16,0.765,-0.43), V(0.16,0.765,-0.43), V(0.16,0.66,-0.405)]), 48, 0.011, 10), alu, chest);
  add(new THREE.CylinderGeometry(0.004, 0.005, 0.22, 8), alu, chest, [0.2, 0.83, -0.34]);
  add(new THREE.SphereGeometry(0.011, 12, 8), anodRed, chest, [0.2, 0.945, -0.34]);

  // chest display and control module (DCM) with hoses
  { const dcm = new THREE.Group(); dcm.position.set(0, 0.31, 0.205); dcm.rotation.x = -0.42; chest.add(dcm);
    add(roundedBox(0.25, 0.12, 0.085, 0.018, 10, 3), plastic, dcm);
    add(new THREE.PlaneGeometry(0.1, 0.04), screenMat, dcm, [0.04, 0.0606, 0.0], [-Math.PI / 2, 0, 0]);
    [-0.085, -0.045].forEach((x) => add(new THREE.CylinderGeometry(0.013, 0.014, 0.016, 24).rotateX(Math.PI / 2), alu, dcm, [x, -0.012, 0.05]));
    add(new THREE.CylinderGeometry(0.015, 0.015, 0.02, 24).rotateX(Math.PI / 2), anodRed, dcm, [0.085, -0.016, 0.05]);
    add(new THREE.SphereGeometry(0.0048, 10, 8), ledG, dcm, [0.0, 0.03, 0.044]);
    add(new THREE.SphereGeometry(0.0048, 10, 8), ledA, dcm, [0.022, 0.03, 0.044]);
    for (const s of [-1, 1]){
      const c = new THREE.CatmullRomCurve3([V(s*0.12,0.3,0.235), V(s*0.2,0.24,0.2), V(s*0.27,0.3,0.06), V(s*0.272,0.42,-0.1), V(s*0.22,0.5,-0.2)]);
      add(new THREE.TubeGeometry(c, 64, 0.0155, 12), hoseMat, chest);
    } }

  // limbs: tapered suit segments with fabric folds bunched near the joints
  const DOWN = V(0, -1, 0);
  function limbGeo(L, r0, r1, bulgeAt, bulge){
    const pts = [];
    for (let k = 0; k <= 4; k++){ const a = k / 4 * Math.PI / 2; pts.push(V2(Math.max(0.0005, r1 * Math.sin(a)), -L - r1 * 0.55 * Math.cos(a))); }
    const N = 48;
    for (let j = 1; j < N; j++){
      const s = j / N, base = lerp(r1, r0, s);
      const folds = Math.exp(-Math.pow((s - 0.1) / 0.13, 2)) + Math.exp(-Math.pow((s - 0.9) / 0.13, 2));
      const r = base + bulge * Math.exp(-Math.pow((s - bulgeAt) / 0.22, 2)) + base * 0.035 * Math.sin(s * Math.PI * 15) * folds;
      pts.push(V2(r, -L + s * L));
    }
    for (let k = 0; k <= 4; k++){ const a = k / 4 * Math.PI / 2; pts.push(V2(Math.max(0.0005, r0 * Math.cos(a)), r0 * 0.55 * Math.sin(a))); }
    return new THREE.LatheGeometry(pts, 40);
  }
  function segment(parent, L, r0, r1, mat, bulgeAt, bulge){
    const g = new THREE.Group(); parent.add(g);
    add(limbGeo(L, r0, r1, bulgeAt, bulge), mat, g);
    const end = new THREE.Group(); end.position.y = -L; g.add(end);
    return { g, end };
  }
  function bellows(parent, r, n, y0, step){ for (let i = 0; i < n; i++) add(ringGeo(r * 1.02, r * 0.2), fLimb, parent, [0, y0 - i * step, 0]); }
  const mirrorMat = new THREE.MeshStandardMaterial({ color: C('#dfe3ea'), metalness: 1, roughness: 0.04, envMapIntensity: 1.3 });
  const ph1 = new THREE.CapsuleGeometry(0.0118, 0.022, 6, 14), ph2 = new THREE.CapsuleGeometry(0.0112, 0.016, 6, 12), ph3 = new THREE.CapsuleGeometry(0.0106, 0.012, 6, 12);
  const jointGroups = [];
  function joint(parent, x, y, z){ const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); jointGroups.push(j); return j; }
  function glove(s){
    const g = new THREE.Group();
    add(new THREE.CylinderGeometry(0.062, 0.057, 0.07, 32), fGlove, g, [0, -0.04, 0]);
    add(ringGeo(0.0615, 0.0055), rubber, g, [0, -0.018, 0]);
    add(new THREE.SphereGeometry(1, 32, 24), fGlove, g, [0, -0.1, 0.004], null, [0.047, 0.056, 0.027]);
    add(new THREE.SphereGeometry(1, 24, 16), rubber, g, [0, -0.104, 0.026], null, [0.034, 0.04, 0.007]);
    const fingers = [];
    [-0.031, -0.011, 0.009, 0.028].forEach((x, i) => {
      const l = [0.92, 1, 0.97, 0.82][i];
      const f1 = joint(g, x, -0.15, 0.006);
      add(ph1, fGlove, f1, [0, -0.018 * l, 0], null, [1, l, 1]);
      const f2 = joint(f1, 0, -0.036 * l, 0);
      add(ph2, fGlove, f2, [0, -0.013 * l, 0], null, [1, l, 1]);
      const f3 = joint(f2, 0, -0.027 * l, 0);
      add(ph3, fGlove, f3, [0, -0.011 * l, 0], null, [1, l, 1]);
      fingers.push({ f1, f2, f3, x, i });
    });
    const t1 = joint(g, s * -0.042, -0.088, 0.02);
    add(ph1, fGlove, t1, [0, -0.019, 0], null, [1.12, 1, 1.12]);
    const t2 = joint(t1, 0, -0.038, 0);
    add(ph2, fGlove, t2, [0, -0.014, 0], null, [1.1, 1, 1.1]);
    g.userData = { fingers, t1, t2, s };
    return g;
  }
  // c = finger curl toward the palm (0 open, 1 fist); w = wrist flex toward the palm
  function setHand(g, c, w){
    const u = g.userData;
    g.rotation.x = -w;
    u.fingers.forEach(({ f1, f2, f3, x, i }) => {
      f1.rotation.set(-(0.12 + i * 0.05 + c * 1.15), 0, x * 1.5 * (1 - c * 0.7));
      f2.rotation.x = -(0.18 + c * 1.35);
      f3.rotation.x = -(0.12 + c * 1.0);
    });
    u.t1.rotation.set(-(0.45 + c * 0.6), 0, u.s * -0.75 * (1 - c * 0.35));
    u.t2.rotation.x = -(0.2 + c * 0.9);
  }
  function boot(){
    const g = new THREE.Group();
    add(ringGeo(0.082, 0.013), alu, g, [0, 0.016, 0]);
    add(ringGeo(0.085, 0.016), fLimb, g, [0, -0.012, 0]);
    add(new THREE.CylinderGeometry(0.081, 0.088, 0.1, 36), fLimb, g, [0, -0.06, 0]);
    add(roundedBox(0.125, 0.085, 0.27, 0.035), fPack, g, [0, -0.118, 0.055]);
    add(roundedBox(0.134, 0.028, 0.29, 0.011, 10, 2), rubber, g, [0, -0.17, 0.055]);
    add(roundedBox(0.128, 0.032, 0.062, 0.012, 8, 2), shell, g, [0, -0.1, 0.172]);
    add(roundedBox(0.112, 0.05, 0.05, 0.015, 8, 2), shell, g, [0, -0.13, -0.064]);
    return g;
  }
  const arms = [], legs = [];
  const spring3 = (v) => ({ x: v.clone(), v: new THREE.Vector3() });
  const spring1 = (x) => ({ x, v: 0 });
  for (const s of [1, -1]){
    const sh = V(s * 0.27, 0.545, -0.01);
    add(new THREE.SphereGeometry(0.102, 40, 28), fLimb, chest, [sh.x, sh.y, sh.z]);
    const up = segment(chest, 0.27, 0.078, 0.066, fLimb, 0.6, 0.006); up.g.position.copy(sh);
    add(ringGeo(0.083, 0.014), alu, up.g, [0, -0.06, 0]);
    add(ringGeo(0.085, 0.006), s > 0 ? anodRed : anodBlue, up.g, [0, -0.079, 0]);
    const fo = segment(up.end, 0.245, 0.066, 0.056, fLimb, 0.35, 0.006);
    bellows(fo.g, 0.067, 3, -0.004, 0.024);
    add(ringGeo(0.06, 0.016), s > 0 ? anodRed : anodBlue, fo.end, [0, 0.008, 0]);
    add(ringGeo(0.058, 0.009), alu, fo.end, [0, -0.01, 0]);
    if (s > 0){
      // cuff checklist on the left forearm
      add(roundedBox(0.07, 0.085, 0.02, 0.005, 8, 2), backMat, fo.g, [0, -0.16, 0.064]);
      add(roundedBox(0.074, 0.089, 0.006, 0.003, 6, 2), plastic, fo.g, [0, -0.16, 0.074]);
      add(ringGeo(0.063, 0.006), rubber, fo.g, [0, -0.16, 0]);
    } else {
      // wrist mirror on the right forearm
      add(roundedBox(0.052, 0.036, 0.009, 0.003, 6, 2), alu, fo.g, [0, -0.19, 0.06]);
      add(new THREE.PlaneGeometry(0.046, 0.03), mirrorMat, fo.g, [0, -0.19, 0.0648]);
      add(ringGeo(0.06, 0.006), rubber, fo.g, [0, -0.19, 0]);
    }
    const hand = glove(s); fo.end.add(hand);
    arms.push({ s, up, fo, hand, ph: s > 0 ? 0.3 : 2.1 });

    const hp = V(s * 0.105, -0.13, 0.0);
    add(new THREE.SphereGeometry(0.1, 36, 24), fLimb, body, [hp.x, hp.y, hp.z]);
    const th = segment(body, 0.37, 0.1, 0.082, fLimb, 0.35, 0.008); th.g.position.copy(hp);
    add(ringGeo(0.099, 0.013), alu, th.g, [0, -0.06, 0]);
    add(new THREE.CylinderGeometry(0.0995, 0.0995, 0.05, 40, 1, true), fRed, th.g, [0, -0.2, 0]);
    add(roundedBox(0.026, 0.12, 0.09, 0.01, 8, 2), fPack, th.g, [s * 0.1, -0.2, 0.0]);
    add(new THREE.SphereGeometry(1, 24, 16), shell, th.end, [0, 0.005, 0.072], null, [0.06, 0.07, 0.024]);
    const shn = segment(th.end, 0.37, 0.084, 0.07, fLimb, 0.72, 0.01);
    bellows(shn.g, 0.086, 3, -0.004, 0.028);
    const foot = boot(); shn.end.add(foot);
    legs.push({ s, up: th, fo: shn, foot, ph: s > 0 ? 4.0 : 5.3 });
  }
  // tether D-ring at the waist
  add(new THREE.TorusGeometry(0.022, 0.0045, 10, 32), alu, body, [-0.205, -0.02, 0.085], [0, 0.6, 0]);

  // Parts that never move relative to each other are merged per material: identical image, far fewer draw calls.
  const moving = new Set([waist]);
  arms.forEach((l) => { moving.add(l.up.g); moving.add(l.fo.g); moving.add(l.hand); });
  legs.forEach((l) => { moving.add(l.up.g); moving.add(l.fo.g); moving.add(l.foot); });
  jointGroups.forEach((j) => moving.add(j));
  function bakeStatic(root){
    const BGU = THREE.BufferGeometryUtils;
    if (!BGU || !BGU.mergeBufferGeometries) return;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map();
    (function walk(o){
      for (const c of o.children){
        if (moving.has(c)) continue;
        if (c.isMesh && !Array.isArray(c.material)){
          let b = buckets.get(c.material); if (!b){ b = []; buckets.set(c.material, b); }
          b.push({ mesh: c, m: new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld) });
        }
        walk(c);
      }
    })(root);
    buckets.forEach((list, mat) => {
      if (list.length < 2) return;
      const geos = list.map(({ mesh, m }) => {
        const g = mesh.geometry.clone(); g.applyMatrix4(m);
        Object.keys(g.attributes).forEach((k) => { if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k); });
        g.clearGroups(); return g;
      });
      let merged = null;
      try { merged = BGU.mergeBufferGeometries(geos, false); } catch (e) { merged = null; }
      geos.forEach((g) => g.dispose());
      if (!merged) return;
      const mm = new THREE.Mesh(merged, mat); mm.castShadow = true; mm.receiveShadow = true; root.add(mm);
      list.forEach(({ mesh }) => mesh.parent.remove(mesh));
    });
  }
  [body, chest].concat(...arms.map((l) => [l.up.g, l.fo.g, l.hand]), ...legs.map((l) => [l.up.g, l.fo.g, l.foot])).forEach(bakeStatic);

  /* ---------- body language: swimming after the ship, skydiving dives, breathing, reactions ---------- */
  // directions are in the parent's space: arms relative to the chest, legs relative to the pelvis.
  // Body axes: +Y toward the head, +Z out of the chest (belly), +X the astronaut's left.
  const P = (x, y, z) => V(x, y, z).normalize();
  const POSES = {
    // head-down dive: arms swept back along the body, legs together, toes pointed
    dive: { k: 6, waist: [0.02, 0, 0],
      arm: { 1: { u: P(0.35, -0.88, -0.22), f: P(0.3, -0.92, -0.18), c: 0.35, w: 0.2 }, '-1': { u: P(-0.35, -0.88, -0.22), f: P(-0.3, -0.92, -0.18), c: 0.35, w: 0.2 } },
      leg: { 1: { u: P(0.06, -1, 0.02), f: P(0.04, -1, -0.03), w: 0.85 }, '-1': { u: P(-0.06, -1, 0.02), f: P(-0.04, -1, -0.03), w: 0.85 } } },
    // skydiver's box position to brake: belly toward the fall, arms out with elbows bent, knees bent, back arched
    box: { k: 10, waist: [-0.24, 0, 0],
      arm: { 1: { u: P(0.9, 0.3, -0.05), f: P(0.35, 0.94, 0.0), c: 0.15, w: -0.1 }, '-1': { u: P(-0.9, 0.3, -0.05), f: P(-0.35, 0.94, 0.0), c: 0.15, w: -0.1 } },
      leg: { 1: { u: P(0.35, -0.9, -0.15), f: P(0.2, -0.3, -0.93), w: 0.5 }, '-1': { u: P(-0.35, -0.9, -0.15), f: P(-0.2, -0.3, -0.93), w: 0.5 } } },
    // flinch: forearms up in front of the visor, knees pulled in
    brace: { k: 26, waist: [0.32, 0, 0],
      arm: { 1: { u: P(0.32, -0.05, 0.95), f: P(-0.5, 0.78, 0.38), c: 0.9, w: 0.4 }, '-1': { u: P(-0.32, -0.05, 0.95), f: P(0.5, 0.78, 0.38), c: 0.9, w: 0.4 } },
      leg: { 1: { u: P(0.15, -0.45, 0.88), f: P(0.1, -0.92, -0.35), w: 0.15 }, '-1': { u: P(-0.15, -0.45, 0.88), f: P(-0.1, -0.92, -0.35), w: 0.15 } } }
  };
  const limbT = () => ({ u: V(0, -1, 0), f: V(0, -1, 0), c: 0, w: 0 });
  const swimPose = { k: 14, waist: [0, 0, 0], arm: { 1: limbT(), '-1': limbT() }, leg: { 1: limbT(), '-1': limbT() } };
  const grabPose = { k: 16, waist: [0, 0, 0], arm: { 1: limbT(), '-1': limbT() }, leg: swimPose.leg };

  // whole-body orientation for each manoeuvre (the fall runs toward -Z, where the ship is)
  const E = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
  const ROOT = { swim: E(-Math.PI / 2 + 0.32, Math.PI, 0), dive: E(-Math.PI / 2 + 0.04, Math.PI, 0), brake: E(-0.15, Math.PI, 0) };
  const MODE_NEXT = { swim: 'dive', dive: 'brake', brake: 'swim' };
  const MODE_DUR = { swim: () => 10 + rand() * 6, dive: () => 4.5 + rand() * 1.8, brake: () => 2.3 };
  const MODE_FX = { swim: 1.0, dive: 2.4, brake: 0.55 };
  const MODE_Z = { swim: 0, dive: -1.4, brake: 0.3 };
  const MODE_LABEL = { swim: 'Nadando hacia la nave', reach: 'Estirándose hacia la nave', dive: 'Caída en picada', brake: 'Posición de frenado', brace: 'Se protege de un fragmento', grab: 'Intenta atrapar un fragmento' };

  const anim = { mode: 'swim', modeT: reduceMotion ? 1e9 : 9, stroke: 0, kick: 0, mt: 0, moment: null, reachT: 3, reachHold: 0, reach: 0, react: null, cool: 7,
    hr: 92, hrT: 92, breath: 0, spin: 0, roll: 0, fx: 1, approach: 0, label: MODE_LABEL.swim,
    q: ROOT.swim.clone(), waist: spring3(V(0, 0, 0)) };
  astro.quaternion.copy(ROOT.swim);

  const _st = new THREE.Vector3(), _w = new THREE.Vector3(), _qi = new THREE.Quaternion(), _n = new THREE.Vector3(), _g = new THREE.Vector3(), _tu = new THREE.Vector3(), _tf = new THREE.Vector3();
  const _e = new THREE.Euler(), _qe = new THREE.Quaternion();
  function step3(s, target, k, dt){ const c = 2 * Math.sqrt(k) * 0.82; _st.copy(target).sub(s.x).multiplyScalar(k).addScaledVector(s.v, -c); s.v.addScaledVector(_st, dt); s.x.addScaledVector(s.v, dt); }
  function step1(s, target, k, dt){ const c = 2 * Math.sqrt(k) * 0.82; s.v += (k * (target - s.x) - c * s.v) * dt; s.x += s.v * dt; }
  // slow, never-repeating drift so no two moments look the same
  const drift = (t, ph) => Math.sin(t * 0.83 + ph) * 0.5 + Math.sin(t * 1.37 + ph * 2.1) * 0.3 + Math.sin(t * 2.71 + ph * 3.7) * 0.2;
  function wobble(v, t, ph, a){ a *= reduceMotion ? 0.4 : 1; return _w.set(v.x + drift(t, ph) * a, v.y + drift(t, ph + 1.9) * a, v.z + drift(t, ph + 3.4) * a); }
  const shoulderOf = (s) => arms.find((l) => l.s === s).up.g.position;
  function toShipFrom(origin, out){ chest.worldToLocal(out.copy(ship.position)); return out.sub(origin).normalize(); }

  // front crawl, as a competitive swimmer does it: long reach at entry, high-elbow catch (forearm vertical
  // while the upper arm stays forward), pull under the chest, push past the hip, elbow-led exit and a
  // relaxed high-elbow recovery with the forearm hanging. Arms half a cycle apart; six kicks per cycle.
  // Directions are in chest space (+Y head, +Z belly / "water", +X the astronaut's left); x is mirrored per arm.
  const CRAWL = [
    { a: 0.0, u: [0.18, 1, 0.10], f: [0.15, 1, 0.12], c: 0.12, w: 0.05 },      // entry: fingertips first, arm long
    { a: 0.6, u: [0.20, 0.97, 0.25], f: [0.12, 0.8, 0.6], c: 0.15, w: 0.2 },   // wrist flexes, catch begins
    { a: 1.25, u: [0.28, 0.72, 0.64], f: [0.05, 0.05, 1.0], c: 0.18, w: 0.25 }, // high-elbow catch: forearm vertical
    { a: 2.2, u: [0.32, -0.25, 0.92], f: [0.1, -0.75, 0.65], c: 0.18, w: 0.15 }, // pull under the chest
    { a: 2.9, u: [0.25, -0.97, 0.05], f: [0.18, -0.98, -0.05], c: 0.2, w: -0.1 }, // push past the hip
    { a: 3.6, u: [0.55, -0.6, -0.55], f: [0.25, -0.85, 0.45], c: 0.35, w: -0.05 }, // exit: the elbow leaves first
    { a: 4.6, u: [0.8, 0.15, -0.58], f: [0.3, 0.1, 0.95], c: 0.4, w: 0.0 },     // recovery: elbow high, forearm hangs
    { a: 5.6, u: [0.4, 0.85, -0.35], f: [0.2, 0.75, 0.6], c: 0.3, w: 0.0 },     // hand passes the shoulder, reaching
    { a: Math.PI * 2, u: [0.18, 1, 0.10], f: [0.15, 1, 0.12], c: 0.12, w: 0.05 }
  ];
  function crawlKey(a, s, A){
    let i = 0; while (i < CRAWL.length - 2 && a >= CRAWL[i + 1].a) i++;
    const k0 = CRAWL[i], k1 = CRAWL[i + 1], e = smooth(0, 1, (a - k0.a) / (k1.a - k0.a));
    A.u.set(s * lerp(k0.u[0], k1.u[0], e), lerp(k0.u[1], k1.u[1], e), lerp(k0.u[2], k1.u[2], e)).normalize();
    A.f.set(s * lerp(k0.f[0], k1.f[0], e), lerp(k0.f[1], k1.f[1], e), lerp(k0.f[2], k1.f[2], e)).normalize();
    A.c = lerp(k0.c, k1.c, e); A.w = lerp(k0.w, k1.w, e);
  }
  function buildSwim(t, reach){
    const ph = anim.stroke;
    for (const s of [1, -1]){
      const a = (((ph + (s > 0 ? 0 : Math.PI)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const A = swimPose.arm[s];
      crawlKey(a, s, A);
      if (reach > 0.001){
        toShipFrom(shoulderOf(s), _g);
        A.u.lerp(_g, reach).normalize(); A.f.lerp(_g, reach).normalize();
        A.c = lerp(A.c, 0, reach); A.w = lerp(A.w, -0.3, reach);
      }
      // six-beat flutter kick from the hip: legs long, the knee bends a little on the downbeat, toes pointed
      const kp = anim.kick + (s > 0 ? 0 : Math.PI);
      const L = swimPose.leg[s];
      L.u.set(s * 0.07, -1, 0.04 + 0.14 * Math.sin(kp)).normalize();
      L.f.set(s * 0.05, -1, -0.03 + 0.26 * Math.sin(kp - 0.9)).normalize();
      L.w = 0.85;
    }
    // shoulders roll toward the pulling arm; the hips follow less (the waist carries the difference)
    swimPose.waist[0] = -0.08 - 0.08 * reach; swimPose.waist[1] = -0.14 * Math.sin(ph - 0.4) * (1 - reach); swimPose.waist[2] = 0;
    swimPose.k = reach > 0.5 ? 9 : 20;
    return swimPose;
  }
  function buildGrab(R, rel){
    chest.worldToLocal(_g.copy(R.d.mesh.position));
    const s = _g.x >= 0 ? 1 : -1;
    _n.copy(_g).sub(shoulderOf(s)).normalize();
    const A = grabPose.arm[s], B = grabPose.arm[-s], closing = rel > -1.6;
    A.u.copy(_n); A.f.copy(_n).add(V(0, 0.12, 0.05)).normalize(); A.c = closing ? 1 : 0; A.w = closing ? 0.35 : -0.25;
    B.u.set(-s * 0.85, 0.2, 0.3).normalize(); B.f.set(-s * 0.7, 0.45, 0.45).normalize(); B.c = 0.2; B.w = 0;
    grabPose.waist[0] = -0.05; grabPose.waist[1] = 0.22 * s; grabPose.waist[2] = 0.1 * s;
    return grabPose;
  }
  function nearestThreat(){
    let best = null, bd = 1e9;
    for (const d of debris){
      const rx = d.mesh.position.x - astro.position.x, ry = d.mesh.position.y - astro.position.y, rz = d.mesh.position.z - astro.position.z;
      if (rz < -14 || rz > -3) continue;
      const rad = Math.hypot(rx, ry);
      if (rad > 1.75 + d.mesh.scale.x) continue;
      if (rad < bd){ bd = rad; best = d; }
    }
    return best;
  }

  let momentPose = () => null;   // set by the hidden moments: the astronaut's reaction to an event
  function animate(dt, t){
    if (dt <= 0) return;
    anim.mt += dt;
    anim.cool -= dt; anim.modeT -= dt;
    if (anim.modeT <= 0 && !anim.react){
      anim.mode = MODE_NEXT[anim.mode]; anim.modeT = MODE_DUR[anim.mode]();
      if (anim.mode === 'dive') anim.hrT = Math.min(145, anim.hrT + 26);
    }
    const mode = anim.mode;

    // heart and breathing: swimming is work, the dive is adrenaline
    const rest = mode === 'swim' ? 96 : mode === 'dive' ? 128 : 112;
    anim.hrT += (rest - anim.hrT) * Math.min(1, dt * 0.12);
    anim.hr += (anim.hrT - anim.hr) * Math.min(1, dt * 0.9);
    const stress = THREE.MathUtils.clamp((anim.hr - 86) / 50, 0, 1);
    anim.breath += dt * Math.PI * 2 / (4.4 / (1 + stress * 0.7));

    // every few seconds of swimming, a long stretch toward the ship
    if (mode === 'swim' && !anim.react){ anim.reachT -= dt; if (anim.reachT <= 0){ anim.reachHold = 1.9; anim.reachT = 5 + rand() * 4; } }
    anim.reachHold = Math.max(0, anim.reachHold - dt);
    anim.reach += ((mode === 'swim' && anim.reachHold > 0 ? 1 : 0) - anim.reach) * Math.min(1, dt * 2.5);
    const strokeRate = (3.0 - 2.2 * anim.reach) * (mode === 'swim' ? 1 : 0.25);
    anim.stroke += dt * strokeRate;
    anim.kick += dt * (mode === 'swim' ? Math.max(3 * strokeRate, 6) : 2);   // six-beat kick, kept going while reaching

    // debris: flinch from big pieces, try to catch small ones (only while swimming)
    if (mode === 'swim' && !anim.react && anim.cool <= 0 && anim.reach < 0.2){
      const d = nearestThreat();
      if (d){ const small = d.mesh.scale.x < 0.32; anim.react = { type: !reduceMotion && small && rand() < 0.65 ? 'grab' : 'brace', d, time: 0 }; anim.hrT = Math.min(145, anim.hrT + (small ? 14 : 28)); }
    }
    let pose, label = mode === 'swim' ? (anim.reach > 0.5 ? MODE_LABEL.reach : MODE_LABEL.swim) : MODE_LABEL[mode];
    if (anim.react){
      const R = anim.react; R.time += dt;
      const rel = R.d.mesh.position.z - astro.position.z;
      if (rel > 1.2 || R.time > 2.8 || mode !== 'swim'){ anim.react = null; anim.cool = 6 + rand() * 6; }
      else { pose = R.type === 'brace' ? POSES.brace : buildGrab(R, rel); label = MODE_LABEL[R.type]; }
    }
    const mp = momentPose(); if (mp){ pose = mp; label = anim.moment.mood === 'fear' ? 'Asustado' : 'Maravillado'; }
    if (!pose) pose = mode === 'swim' ? buildSwim(t, anim.reach) : POSES[mode === 'dive' ? 'dive' : 'box'];
    anim.label = label;
    const k = pose.k * (reduceMotion ? 0.6 : 1);
    const b = Math.sin(anim.breath);

    // waist: pose + breathing + drift
    _w.set(pose.waist[0] + b * 0.014 + drift(t * 0.6, 0.7) * 0.03, pose.waist[1] + drift(t * 0.5, 2.2) * 0.04, pose.waist[2] + drift(t * 0.55, 4.1) * 0.02);
    step3(anim.waist, _w, k, dt);
    waist.rotation.set(anim.waist.x.x, anim.waist.x.y, anim.waist.x.z, 'YXZ');
    chest.scale.set(1 + 0.007 * b, 1 + 0.004 * b, 1 + 0.013 * b);

    for (const l of arms){
      const p = pose.arm[l.s];
      _tu.copy(p.u); _tu.y += b * 0.02; _tf.copy(p.f);
      step3(l.su, wobble(_tu, t, l.ph, 0.05), k, dt);
      step3(l.sf, wobble(_tf, t, l.ph + 1.3, 0.06), k * 0.85, dt);
      step1(l.sc, p.c + drift(t * 0.7, l.ph) * 0.06, k * 1.4, dt);
      step1(l.sw, p.w + drift(t * 0.6, l.ph + 2) * 0.08, k, dt);
      l.up.g.quaternion.setFromUnitVectors(DOWN, _n.copy(l.su.x).normalize());
      _n.copy(l.sf.x).normalize().applyQuaternion(_qi.copy(l.up.g.quaternion).invert());
      l.fo.g.quaternion.setFromUnitVectors(DOWN, _n);
      setHand(l.hand, THREE.MathUtils.clamp(l.sc.x, 0, 1), l.sw.x);
    }
    for (const l of legs){
      const p = pose.leg[l.s];
      step3(l.su, wobble(_tu.copy(p.u), t, l.ph, 0.03), k * 0.8, dt);
      step3(l.sf, wobble(_tf.copy(p.f), t, l.ph + 1.3, 0.04), k * 0.7, dt);
      step1(l.sw, p.w + drift(t * 0.5, l.ph) * 0.1, k, dt);
      l.up.g.quaternion.setFromUnitVectors(DOWN, _n.copy(l.su.x).normalize());
      _n.copy(l.sf.x).normalize().applyQuaternion(_qi.copy(l.up.g.quaternion).invert());
      l.fo.g.quaternion.setFromUnitVectors(DOWN, _n);
      l.foot.rotation.x = l.sw.x;
    }

    // whole body: orientation of the manoeuvre, the swimmer's roll, a corkscrew in the dive,
    // and a counter-rotation against the waist (there is nothing to push against)
    anim.q.slerp(ROOT[mode], 1 - Math.exp(-dt * (mode === 'brake' ? 2.6 : mode === 'dive' ? 1.5 : 1.1)));
    if (mode === 'dive' && !reduceMotion) anim.spin += dt * 0.55;
    else { anim.spin = Math.atan2(Math.sin(anim.spin), Math.cos(anim.spin)); anim.spin *= Math.exp(-dt * 1.2); }
    const rollT = mode === 'swim' ? -0.5 * Math.sin(anim.stroke - 0.4) * (1 - anim.reach) : 0;   // about 30° of body roll, toward the pulling arm
    anim.roll += (rollT - anim.roll) * Math.min(1, dt * 4);
    const wv = anim.waist.x;
    _e.set(-0.25 * wv.x + drift(t * 0.3, 1.1) * 0.05, anim.roll + anim.spin - 0.35 * wv.y, -0.3 * wv.z + drift(t * 0.27, 2.6) * 0.05, 'XYZ');
    astro.quaternion.copy(anim.q).multiply(_qe.setFromEuler(_e));
    astro.position.set(0.12 * Math.sin(t * 0.23), 0.1 * Math.sin(t * 0.29 + 1.2), lerp(astro.position.z, MODE_Z[mode], Math.min(1, dt * 0.8)));

    // the dive speeds the fall and closes on the ship; braking lets it pull away again
    anim.fx += (MODE_FX[mode] - anim.fx) * Math.min(1, dt * (mode === 'dive' ? 0.9 : 1.6));
    anim.approach += ((mode === 'dive' ? 1 : 0) - anim.approach) * Math.min(1, dt * 0.45);
  }

  buildSwim(0, 0);
  arms.forEach((l) => { const p = swimPose.arm[l.s]; l.su = spring3(p.u); l.sf = spring3(p.f); l.sc = spring1(p.c); l.sw = spring1(p.w); });
  legs.forEach((l) => { const p = swimPose.leg[l.s]; l.su = spring3(p.u); l.sf = spring3(p.f); l.sw = spring1(p.w); });
  arms.forEach((l) => setHand(l.hand, l.sc.x, l.sw.x));

  /* ---------- the wormhole ---------- */
  const NOISE = `
    uniform sampler2D uNoise;
    float vnoise(vec3 x){
      vec3 p = floor(x); vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      vec2 uv = (p.xy + vec2(37.0, 17.0) * p.z) + f.xy;
      vec2 rg = texture2D(uNoise, (uv + 0.5) / 256.0).yx;
      return mix(rg.x, rg.y, f.z);
    }
    float snoise(vec3 v){ return vnoise(v) * 2.0 - 1.0; }
    const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
    float fbm3(vec3 p){ float s=0.0, a=0.5; for(int i=0;i<3;i++){ s+=a*snoise(p); p=ROT*p*2.03+vec3(11.3,7.1,3.7); a*=0.5; } return s; }
    float fbm2(vec3 p){ return 0.5*snoise(p) + 0.25*snoise(ROT*p*2.11+vec3(5.2,1.3,8.7)); }
    float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
  `;
  // 256² noise lattice; green holds layer z, red holds layer z+1 (offset 37,17), so one bilinear fetch gives 3D noise
  function makeNoiseTex(){
    const N = 256, H = new Uint8Array(N * N), d = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) H[i] = (hash2i(i % N, (i / N) | 0, 777) * 255) | 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++){
      const i = (y * N + x) * 4;
      d[i + 1] = H[y * N + x]; d[i] = H[((y + 17) & 255) * N + ((x + 37) & 255)]; d[i + 2] = 0; d[i + 3] = 255;
    }
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  }
  const tunnelMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFlow: { value: 0 }, uGas: { value: 0.8 }, uCore: { value: 0.5 }, uRing: { value: 0.7 }, uNoise: { value: makeNoiseTex() }, uLayers: { value: 5 } },
    side: THREE.BackSide, depthWrite: false,
    vertexShader: `
      varying vec3 vWorld;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform float uFlow; uniform float uGas; uniform float uCore; uniform float uRing; uniform float uLayers;
      varying vec3 vWorld;
      ${NOISE}
      vec3 gas(float n, float m, float deep, float fk){
        vec3 violet = vec3(0.30, 0.09, 1.00);
        vec3 magenta = vec3(1.00, 0.10, 0.50);
        vec3 cyan = vec3(0.06, 0.74, 1.00);
        vec3 teal = vec3(0.04, 0.95, 0.70);
        vec3 amber = vec3(1.00, 0.50, 0.12);
        vec3 c = mix(violet, magenta, smoothstep(-0.35, 0.45, n + fk * 0.08));
        c = mix(c, cyan, smoothstep(0.05, 0.6, m) * 0.85);
        c = mix(c, teal, smoothstep(0.45, 0.85, m) * 0.45);
        c = mix(c, amber, deep * smoothstep(-0.2, 0.55, n) * 0.8);
        return c;
      }
      void main(){
        vec3 ro = cameraPosition;
        vec3 rd = normalize(vWorld - ro);
        vec3 col = vec3(0.0);
        float T = 1.0;
        float a = max(dot(rd.xy, rd.xy), 1e-6);
        float b = dot(ro.xy, rd.xy);
        float c0 = dot(ro.xy, ro.xy);
        for (int k = 0; k < 5; k++){
          if (float(k) > uLayers - 0.5) break;
          float fk = float(k);
          float R = 4.3 + fk * 2.9;
          float disc = max(b * b - a * (c0 - R * R), 0.0);
          float t = min((-b + sqrt(disc)) / a, 4000.0);
          vec3 p = ro + rd * t;
          float dz = ro.z - p.z;
          float adz = abs(dz);
          float zf = p.z - uFlow * (1.0 - fk * 0.07);
          float sw = (k == 1 || k == 3) ? -0.75 : 1.0;
          bool outer = (float(k) > uLayers - 1.5);
          float ang = atan(p.y, p.x) + zf * 0.045 * sw + uTime * 0.11 * sw;
          float rr = R * 0.16;
          vec3 q = vec3(cos(ang) * rr, sin(ang) * rr, zf * 0.05) + vec3(fk * 13.7);
          float detail = exp(-t * 0.0045);
          float n = fbm3(q);
          float m = fbm2(q * vec3(2.3, 2.3, 1.5) + vec3(0.0, 0.0, uTime * 0.06));
          float dust = fbm2(q * vec3(3.4, 3.4, 2.2) + vec3(4.0, 2.0, 9.0));
          n = mix(0.12, n, detail); m = mix(0.25, m, detail); dust = mix(0.0, dust, detail);
          float dens = smoothstep(-0.3, 0.6, n + 0.3 * m);
          float fil = pow(1.0 - abs(snoise(q * vec3(3.2, 3.2, 0.35) + vec3(0.0, 0.0, fk * 5.0))), 12.0) * detail * smoothstep(4.0, 22.0, adz);
          float alpha = outer ? 1.0 : clamp(dens * (0.6 - fk * 0.08) + fil * 0.35, 0.0, 1.0);
          float deep = smoothstep(10.0, 80.0, dz);
          vec3 gc = gas(n, m, deep, fk);
          float bright = uGas * (0.12 + 1.15 * pow(smoothstep(0.0, 90.0, adz), 1.1)) * (0.25 + 1.1 * dens);
          bright *= 1.0 - 0.82 * smoothstep(0.05, 0.5, dust);
          vec3 lc = gc * bright + mix(gc, vec3(1.0), 0.35) * fil * (0.35 + 1.2 * smoothstep(0.0, 60.0, adz)) * uGas;
          float ring = pow(0.5 + 0.5 * sin(zf * 0.36 + fk * 1.7), 64.0);
          lc += vec3(0.55, 0.85, 1.0) * ring * (0.5 + dens) * 0.9 * uRing * smoothstep(1.0, 18.0, adz) * detail;
          if (outer){
            vec2 sc = vec2(ang * (260.0 / 6.2831853), zf * 0.35);
            vec2 id = floor(sc);
            id.x = mod(id.x, 260.0);
            vec2 f = fract(sc) - 0.5;
            float h = hash12(id + 17.0);
            float st = step(0.94, h) * exp(-(f.x * f.x * 110.0 + f.y * f.y * 7.0));
            lc += vec3(0.85, 0.92, 1.0) * st * (2.0 + 6.0 * fract(h * 31.0)) * detail;
          }
          col += T * alpha * lc;
          T *= 1.0 - alpha;
          if (T < 0.02) break;
        }
        float down = -rd.z;
        float d = max(down, 0.0);
        float th = acos(clamp(down, -1.0, 1.0));
        float hue = atan(rd.y, rd.x);
        col += vec3(1.0, 0.88, 0.74) * uCore * (pow(d, 900.0) * 7.0 + pow(d, 140.0) * 0.8 + pow(d, 22.0) * 0.12);
        vec3 rb = 0.55 + 0.45 * cos(hue + vec3(0.0, 2.1, 4.2) + uTime * 0.35);
        float e1 = (th - 0.16) * 70.0; col += rb * exp(-e1 * e1) * 1.2 * uCore;
        float e2 = (th - 0.27) * 45.0; col += rb.zxy * exp(-e2 * e2) * 0.6;
        float rays = smoothstep(0.0, 0.7, fbm2(vec3(cos(hue) * 2.5, sin(hue) * 2.5, uTime * 0.12)));
        col += vec3(1.0, 0.45, 0.8) * rays * pow(d, 10.0) * 0.35 * uCore;
        float up = max(rd.z, 0.0); col += vec3(0.35, 0.75, 1.0) * (pow(up, 40.0) * 1.6 + pow(up, 6.0) * 0.45);
        gl_FragColor = vec4(max(col, 0.0), 1.0);
      }`
  });
  const tunnel = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), tunnelMat);
  tunnel.frustumCulled = false; tunnel.renderOrder = -10; tunnel.layers.enable(1);
  scene.add(tunnel);

  // reflections: a cube camera watches only the wormhole (layer 1) and feeds every PBR material
  const cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: HDR, generateMipmaps: false });
  const cubeCam = new THREE.CubeCamera(0.1, 1500, cubeRT);
  cubeCam.children.forEach((c) => c.layers.set(1));
  scene.add(cubeCam);
  scene.environment = cubeRT.texture;

  /* ---------- dust and speed streaks ---------- */
  const LEN = 92;
  const pal = ['#8af5ff', '#ff6fd0', '#a37bff', '#ffc07a', '#ffffff', '#6dffd6'].map(C);
  function streamGeo(n, verts, rMin, rMax, sizeFn){
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(n * verts * 3), col = new Float32Array(n * verts * 3), extra = new Float32Array(n * verts);
    for (let i = 0; i < n; i++){
      const r = rMin + Math.sqrt(rand()) * (rMax - rMin), a = rand() * Math.PI * 2, z = rand() * LEN;
      const c = pal[(rand() * pal.length) | 0], b = 0.35 + rand() * 1.1, sz = sizeFn();
      for (let v = 0; v < verts; v++){
        const j = i * verts + v;
        seed[j*3] = r; seed[j*3+1] = a; seed[j*3+2] = z;
        col[j*3] = c.r * b; col[j*3+1] = c.g * b; col[j*3+2] = c.b * b;
        extra[j] = verts === 1 ? sz : v;
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * verts * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aExtra', new THREE.BufferAttribute(extra, 1));
    return g;
  }
  const STREAM_VS = `
    attribute vec3 aSeed; attribute vec3 aColor; attribute float aExtra;
    uniform float uTime, uFlow, uLen;
    vec3 streamPos(float extraZ){
      float z = mod(aSeed.z + uFlow, uLen) - uLen * 0.82 + extraZ;
      float ang = aSeed.y + z * 0.03 + uTime * 0.08;
      return vec3(cos(ang) * aSeed.x, sin(ang) * aSeed.x, z);
    }`;
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFlow: { value: 0 }, uLen: { value: LEN }, uScale: { value: 800 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: STREAM_VS + `
      uniform float uScale;
      varying vec3 vColor; varying float vA;
      void main(){
        vec3 p = streamPos(0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 0.05);
        float ps = aExtra * uScale / d;
        float blur = 0.0;
        float raw = ps;
        ps *= 1.0 + blur * 5.0;
        gl_PointSize = clamp(ps, 1.0, 90.0);
        vA = smoothstep(-uLen * 0.82, -uLen * 0.6, p.z) * (1.0 - blur * 0.85) * clamp(raw * raw, 0.0, 1.0);
        vColor = aColor;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vA;
      void main(){
        float r = length(gl_PointCoord - 0.5);
        float a = 1.0 - smoothstep(0.0, 0.5, r);
        a = a * a * (0.6 + 0.4 * (1.0 - smoothstep(0.0, 0.22, r)));
        gl_FragColor = vec4(vColor * a * vA, 1.0);
      }`
  });
  const dust = new THREE.Points(streamGeo(3000, 1, 0.45, 4.1, () => 0.012 + Math.pow(rand(), 3) * 0.05), dustMat);
  dust.frustumCulled = false; scene.add(dust);
  const streakMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFlow: { value: 0 }, uLen: { value: LEN }, uStreak: { value: 3 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: STREAM_VS + `
      uniform float uStreak;
      varying vec3 vColor; varying float vE;
      void main(){
        vec3 p = streamPos(aExtra * uStreak);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vE = aExtra * smoothstep(-uLen * 0.82, -uLen * 0.5, p.z) * smoothstep(1.5, 5.0, -mv.z);
        vColor = aColor;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vE;
      void main(){ gl_FragColor = vec4(vColor * vE * 1.6, 1.0); }`
  });
  const streaks = new THREE.LineSegments(streamGeo(420, 2, 2.3, 4.15, () => 0), streakMat);
  streaks.frustumCulled = false; scene.add(streaks);

  /* ---------- debris: rocks, gold/silver insulation foil, a broken solar array ---------- */
  function rockGeo(seed){
    const g = new THREE.SphereGeometry(1, 44, 32);
    const pos = g.attributes.position, v = new THREE.Vector3();
    const sx = 0.75 + rand() * 0.55, sy = 0.6 + rand() * 0.45, sz = 0.8 + rand() * 0.5;
    const craters = [];
    for (let i = 0; i < 5; i++) craters.push({ d: V(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize(), r: 0.18 + rand() * 0.35, depth: 0.05 + rand() * 0.08 });
    for (let i = 0; i < pos.count; i++){
      v.fromBufferAttribute(pos, i);
      let r = 0.82 + (fbm3(v.x * 1.3 + seed, v.y * 1.3, v.z * 1.3, 5, (seed * 10) | 0) - 0.5) * 0.7;
      r += (1 - Math.abs(fbm3(v.x * 3.1, v.y * 3.1 + seed, v.z * 3.1, 4, ((seed * 10) | 0) + 7) * 2 - 1)) * 0.08;
      for (const c of craters){
        const q = Math.acos(Math.max(-1, Math.min(1, v.dot(c.d)))) / c.r;
        if (q < 1.25) r += q < 1 ? -c.depth * (1 - q * q) : c.depth * 0.6 * Math.sin((q - 1) / 0.25 * Math.PI);
      }
      v.multiplyScalar(r);
      pos.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
    }
    g.computeVertexNormals(); fixSeams(g);
    return g;
  }
  function foilGeo(seed){
    const g = new THREE.PlaneGeometry(1, 0.72, 36, 26), pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++){
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, (fbm3(x * 2.2 + seed, y * 2.2, seed, 4, 300) - 0.5) * 0.42 + (1 - Math.abs(fbm3(x * 5, y * 5, seed + 3, 3, 310) * 2 - 1)) * 0.06 + x * x * 0.25);
    }
    g.computeVertexNormals();
    return g;
  }
  const rockMats = ['#ffffff', '#d9c6b2', '#b9c3cc'].map((t) => new THREE.MeshStandardMaterial({ color: C(t), map: TX.rockColor, normalMap: TX.rockNormal, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.93, metalness: 0, envMapIntensity: 0.75 }));
  const rockGeos = [1.3, 8.7, 15.1, 22.9].map(rockGeo);
  const foilGeos = [3.1, 8.4, 12.2].map(foilGeo);
  const panelGeo = new THREE.BoxGeometry(1, 0.03, 0.62);
  const debris = [];
  function addDebris(mesh, big){ scene.add(mesh); debris.push({ mesh, big, k: 1, spin: new THREE.Vector3() }); }
  for (let i = 0; i < 16; i++){ const m = new THREE.Mesh(rockGeos[i % 4], rockMats[i % 3]); const big = i < 2; m.scale.setScalar(big ? 0.75 : 0.08 + Math.pow(rand(), 2) * 0.4); addDebris(m, big); }
  for (let i = 0; i < 6; i++){ const m = new THREE.Mesh(foilGeos[i % 3], i % 2 ? silverFoil : goldFoil); m.scale.setScalar(0.22 + rand() * 0.3); addDebris(m, false); }
  for (let i = 0; i < 3; i++){ const m = new THREE.Mesh(panelGeo, [alu, alu, solarMat, backMat, alu, alu]); m.scale.setScalar(0.35 + rand() * 0.35); addDebris(m, false); }
  function place(d, initial){
    const a = rand() * Math.PI * 2, minR = d.big ? 3.0 : 1.55, r = minR + rand() * (3.95 - minR);
    d.mesh.position.set(Math.cos(a) * r, Math.sin(a) * r, initial ? -95 + rand() * 92 : -95 - rand() * 35);
    d.k = 0.8 + rand() * 0.5;
    d.spin.set((rand() - 0.5) * 1.4, (rand() - 0.5) * 1.4, (rand() - 0.5) * 1.4);
    d.mesh.rotation.set(rand() * 6, rand() * 6, rand() * 6);
  }
  debris.forEach((d) => place(d, true));

  /* ---------- the ship: always just out of reach, deeper in the throat ---------- */
  const ship = new THREE.Group(); ship.scale.setScalar(1.5); scene.add(ship);
  const shipLights = { plumes: [], nav: [], strobe: null };
  {
    const glowC = makeCanvas(128, 128), gg = glowC.getContext('2d'), gr = gg.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.22, 'rgba(170,230,255,0.9)'); gr.addColorStop(0.55, 'rgba(90,150,255,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    gg.fillStyle = gr; gg.fillRect(0, 0, 128, 128);
    const glowTex = canvasTex(glowC, true);
    const lit = (r, g, b) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), fog: false });
    const hullMat = shell.clone(); hullMat.color = C('#5f646d'); hullMat.envMapIntensity = 0.5;
    const part = (geo, mat, p, r) => { const m = new THREE.Mesh(geo, mat); if (p) m.position.set(p[0], p[1], p[2]); if (r) m.rotation.set(r[0], r[1], r[2]); ship.add(m); return m; };
    // hull: nose toward -Z (deeper into the throat), engines toward the astronaut
    part(new THREE.LatheGeometry([V2(0,-3.0),V2(0.85,-2.95),V2(1.1,-2.5),V2(1.18,-1.2),V2(1.15,0.4),V2(1.02,1.5),V2(0.74,2.35),V2(0.36,2.95),V2(0,3.12)], 48).rotateX(-Math.PI / 2), hullMat);
    part(new THREE.CylinderGeometry(1.19, 1.19, 0.35, 48, 1, true).rotateX(Math.PI / 2), plastic, [0, 0, 0.6]);
    part(new THREE.SphereGeometry(0.62, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2.4), visorMat, [0, 0.6, -1.7], [-0.5, 0, 0]);
    const win = lit(3.2, 2.3, 1.2), winGeo = new THREE.BoxGeometry(0.06, 0.16, 0.28);
    for (let i = 0; i < 5; i++) for (const sd of [-1, 1]) part(winGeo, win, [sd * 1.16, 0.2, -0.9 + i * 0.5]);
    // solar wings on struts
    const wingGeo = new THREE.BoxGeometry(4.2, 0.05, 1.5);
    for (const sd of [-1, 1]){
      part(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 10).rotateZ(Math.PI / 2), alu, [sd * 1.65, 0, 0.6]);
      part(wingGeo, [alu, alu, solarMat, backMat, alu, alu], [sd * 4.3, 0, 0.6], [0, 0, sd * 0.06]);
    }
    // engines with exhaust glow
    for (const sd of [-1, 1]){
      part(new THREE.CylinderGeometry(0.52, 0.32, 0.85, 28, 1, true).rotateX(Math.PI / 2), alu, [sd * 0.5, 0, 3.3]);
      part(new THREE.CircleGeometry(0.42, 24), lit(1.6, 2.6, 4.0), [sd * 0.5, 0, 3.62]);
      const plume = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(2.0, 2.6, 3.4), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
      plume.position.set(sd * 0.5, 0, 4.0); plume.scale.setScalar(3.4); ship.add(plume); shipLights.plumes.push(plume);
    }
    // navigation lights: red to port, green to starboard, white strobe on top
    const navGeo = new THREE.SphereGeometry(0.22, 12, 8);
    shipLights.nav.push(part(navGeo, lit(6, 0.35, 0.3), [-6.45, 0, 0.6]), part(navGeo, lit(0.3, 6, 0.8), [6.45, 0, 0.6]));
    shipLights.strobe = part(navGeo, lit(8, 8, 8), [0, 1.2, 0.4]);
  }
  function updateShip(t){
    ship.position.set(1.5 + 0.6 * Math.sin(t * 0.09), 1.1 + 0.4 * Math.sin(t * 0.07 + 1), -34 + 4 * Math.sin(t * 0.05) + 10 * anim.approach);
    // pitched and banked so its back, solar wings and lights face the chaser
    ship.rotation.set(-0.42 + 0.05 * Math.sin(t * 0.13), 0.35 + 0.08 * Math.sin(t * 0.11), 0.3 + 0.12 * Math.sin(t * 0.1));
    const blink = (t % 1.6) < 0.18;
    shipLights.nav.forEach((m) => { m.visible = blink; });
    shipLights.strobe.visible = (t % 2.3) < 0.07;
    const fl = 3.4 + 0.25 * Math.sin(t * 31) + 0.15 * Math.sin(t * 17.3);
    shipLights.plumes.forEach((p) => p.scale.setScalar(fl));
  }

  /* ---------- supernovas flaring out on the walls of the throat ---------- */
  function spriteTex(size, draw){ const c = makeCanvas(size, size), g = c.getContext('2d'); draw(g, size); return canvasTex(c, true); }
  // star core with diffraction spikes
  const novaCoreTex = spriteTex(256, (g, S) => {
    const h = S / 2;
    let gr = g.createRadialGradient(h, h, 0, h, h, h);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.06, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.18, 'rgba(255,255,255,0.35)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.06)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 6; k++){
      const a = k * Math.PI / 3 + 0.26, len = k % 3 === 0 ? h * 0.98 : h * 0.62;
      g.save(); g.translate(h, h); g.rotate(a);
      const lg = g.createLinearGradient(0, 0, len, 0);
      lg.addColorStop(0, 'rgba(255,255,255,0.85)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = lg; g.beginPath(); g.moveTo(0, -2.2); g.lineTo(len, 0); g.lineTo(0, 2.2); g.closePath(); g.fill();
      g.restore();
    }
  });
  // expanding shock shell: a ragged, filamentary ring
  const novaRingTex = spriteTex(256, (g, S) => {
    const h = S / 2;
    const img = g.createImageData(S, S), d = img.data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++){
      const dx = (x - h) / h, dy = (y - h) / h, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      const wob = 0.82 + 0.06 * Math.sin(a * 7 + 1.3) + 0.04 * Math.sin(a * 17 + 0.4) + (fbm3(Math.cos(a) * 2.5, Math.sin(a) * 2.5, r * 3, 4, 71) - 0.5) * 0.16;
      const band = Math.exp(-Math.pow((r - wob) / 0.055, 2));
      const fil = 0.55 + 0.45 * Math.pow(Math.abs(Math.sin(a * 23 + fbm3(dx * 4, dy * 4, 1.7, 3, 73) * 9)), 0.6);
      const inner = r < wob ? Math.exp(-Math.pow((r - wob) / 0.22, 2)) * 0.22 : 0;
      const v = Math.min(1, band * fil + inner) * (r < 1 ? 1 : 0);
      const i = (y * S + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(v * 255);
    }
    g.putImageData(img, 0, 0);
  });
  // soft remnant cloud
  const nebulaTex = spriteTex(256, (g, S) => {
    const img = g.createImageData(S, S), d = img.data, h = S / 2;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++){
      const dx = (x - h) / h, dy = (y - h) / h, r = Math.hypot(dx, dy);
      const n = fbm3(dx * 2.2, dy * 2.2, 3.3, 5, 91);
      const v = Math.max(0, 1 - r) * Math.max(0, n * 1.6 - 0.35);
      const i = (y * S + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(Math.min(1, v) * 255);
    }
    g.putImageData(img, 0, 0);
  });
  const sprite = (map, color) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true })); s.renderOrder = 2; return s; };

  const NOVA_TINTS = [[1.0, 0.45, 1.25], [1.25, 0.8, 0.35], [0.4, 0.95, 1.3], [1.3, 0.5, 0.35]];
  const novas = [];
  for (let i = 0; i < 4; i++){
    const g = new THREE.Group(), tint = NOVA_TINTS[i];
    const neb = sprite(nebulaTex, new THREE.Color(tint[0], tint[1], tint[2]));
    const ring = sprite(novaRingTex, new THREE.Color(tint[0], tint[1], tint[2]));
    const core = sprite(novaCoreTex, new THREE.Color(1, 1, 1));
    neb.material.rotation = rand() * 6; ring.material.rotation = rand() * 6;
    g.add(neb, ring, core); scene.add(g);
    novas.push({ g, neb, ring, core, tint, slot: i, born: -rand() * 14 - i * 4, life: 16 + rand() * 8, size: 1 });
  }
  function seatNova(n, t){
    // spread around the throat: up-left, down-right, far deep… never straight ahead of the ship
    const a = (n.slot + rand() * 0.6) * Math.PI / 2, r = 13 + rand() * 7;   // one per quadrant, out on the walls
    n.g.position.set(Math.cos(a) * r, Math.sin(a) * r, -38 - rand() * 30);
    n.born = t; n.life = 16 + rand() * 8; n.size = 0.8 + rand() * 0.6;
  }
  novas.forEach((n) => seatNova(n, n.born));
  function updateNovas(t, dt, fs){
    for (const n of novas){
      let age = t - n.born;
      if (age > n.life){ seatNova(n, t); age = 0; }
      n.g.position.z += dt * FLOW * fs * 0.04;   // far away: slow parallax
      const p = Math.max(0, age);
      const flash = p < 0.35 ? p / 0.35 : Math.exp(-(p - 0.35) * 0.55);   // fast rise, slow decay
      const fade = Math.min(1, (n.life - p) / 3);                          // gentle exit
      const tw = 1 + 0.06 * Math.sin(t * 9 + n.life);
      n.core.scale.setScalar(n.size * (2.2 + 7 * flash) * tw);
      n.core.material.opacity = Math.min(1, 0.25 + flash) * fade;
      n.core.material.color.setRGB(1.0 + n.tint[0] * 0.6 * flash, 0.95 + n.tint[1] * 0.4 * flash, 1.0 + n.tint[2] * 0.6 * flash);
      const shell = 1 - Math.exp(-p * 0.22);
      n.ring.scale.setScalar(n.size * (1 + 26 * shell));
      n.ring.material.opacity = Math.min(1, p * 3) * (1 - shell * 0.75) * 0.9 * fade;
      n.ring.material.rotation += dt * 0.02;
      n.neb.scale.setScalar(n.size * (6 + 22 * shell));
      n.neb.material.opacity = Math.min(1, p * 0.5) * 0.55 * fade;
      n.neb.material.rotation -= dt * 0.01;
    }
  }

  /* ---------- tilt the phone to look around ----------
     The device attitude (alpha/beta/gamma) becomes a quaternion, so it never flips near upright.
     The reading at the moment the gyroscope switches on is the zero point. From there the view
     follows the phone 1:1, with a short smoothing to remove sensor jitter. Press the button again to recalibrate. */
  const gyro = { on: false, seen: false, base: null, rel: new THREE.Quaternion(), cur: new THREE.Quaternion(), cal: null };
  const _dq = new THREE.Quaternion(), _de = new THREE.Euler(), _ze = new THREE.Vector3(0, 0, 1);
  const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)), _q0 = new THREE.Quaternion(), _ge = new THREE.Euler();
  function onTilt(e){
    if (e.beta == null || e.gamma == null) return;
    gyro.seen = true;
    if (!gyro.on) return;
    const D = Math.PI / 180;
    const ang = ((screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0)) * D;
    _de.set(e.beta * D, (e.alpha || 0) * D, -e.gamma * D, 'YXZ');
    _dq.setFromEuler(_de).multiply(_q1).multiply(_q0.setFromAxisAngle(_ze, -ang));
    if (!gyro.base) gyro.base = _dq.clone();   // zero point, fixed until recalibration (no drift)
    gyro.rel.copy(gyro.base).invert().multiply(_dq);
  }
  addEventListener('deviceorientation', onTilt);
  const _cp = new THREE.Vector3(), _cq = new THREE.Quaternion(), gsph = new THREE.Spherical();
  function gyroApply(raw){
    _cp.copy(camera.position); _cq.copy(camera.quaternion);
    if (!gyro.on || !gyro.base) return;
    // short exponential smoothing in quaternion space (about 50 ms): removes jitter, keeps the response tight
    gyro.cur.slerp(gyro.rel, 1 - Math.exp(-raw * 20));
    // the orbit pose at calibration is the reference; the phone's rotation is applied on top of it
    if (!gyro.cal){ gsph.setFromVector3(off.copy(camera.position).sub(controls.target)); gyro.cal = { r: gsph.radius, theta: gsph.theta, phi: gsph.phi }; }
    _ge.setFromQuaternion(gyro.cur, 'YXZ');
    // 1:1 mapping: turning the phone by X degrees turns the view by X degrees
    gsph.set(gyro.cal.r, THREE.MathUtils.clamp(gyro.cal.phi + _ge.x, 0.3, 2.85), gyro.cal.theta + _ge.y);
    camera.position.copy(controls.target).add(off.setFromSpherical(gsph));
    camera.lookAt(controls.target);
  }
  function gyroRestore(){ camera.position.copy(_cp); camera.quaternion.copy(_cq); }

  /* ---------- severed safety tether trailing from the waist ---------- */
  const tether = { mesh: null, anchor: V(-0.205, -0.02, 0.085), hook: new THREE.Group() };
  add(new THREE.TorusGeometry(0.03, 0.006, 10, 32, Math.PI * 1.6), alu, tether.hook, [0, 0, 0.03], [Math.PI / 2, 0, 0]);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 16).rotateX(Math.PI / 2), alu, tether.hook);
  scene.add(tether.hook);
  const tDir = V(-0.62, -0.3, 0.72).normalize(), tP1 = new THREE.Vector3().crossVectors(tDir, V(0, 0, 1)).normalize(), tP2 = new THREE.Vector3().crossVectors(tDir, tP1).normalize();
  const _a = new THREE.Vector3(), _o = new THREE.Vector3(), _h = new THREE.Vector3();
  function updateTether(t){
    body.localToWorld(_a.copy(tether.anchor));
    _o.set(-0.8, 0.1, 0.6).normalize().transformDirection(body.matrixWorld);
    const base = _a.clone().addScaledVector(_o, 0.12), pts = [_a.clone(), base.clone()];
    for (let i = 1; i <= 12; i++){
      const s = i / 12, p = base.clone().addScaledVector(tDir, s * 2.4);
      p.addScaledVector(tP1, Math.sin(s * 5.2 - t * 2.0) * 0.22 * s + Math.sin(s * 11.0 - t * 3.1) * 0.04 * s);
      p.addScaledVector(tP2, Math.cos(s * 4.3 - t * 1.6) * 0.18 * s);
      pts.push(p);
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 72, 0.0095, 6, false);
    if (tether.mesh){ tether.mesh.geometry.dispose(); tether.mesh.geometry = geo; }
    else { tether.mesh = new THREE.Mesh(geo, tetherMat); tether.mesh.castShadow = true; scene.add(tether.mesh); }
    const end = pts[pts.length - 1], prev = pts[pts.length - 2];
    tether.hook.position.copy(end);
    tether.hook.lookAt(_h.copy(end).multiplyScalar(2).sub(prev));
  }

  /* ---------- hidden moments ----------
     Five activation points wait in different directions around the astronaut, each marked only by a faint glint.
     Holding the view on a glint for half a second (tilting the phone, or dragging) plays one of the ten events of
     its group, picked at random without repeats until the group is used up. A spent point hides until another
     point is activated. */
  const MT = controls.target.clone();
  // direction the camera looks when it orbits the astronaut at spherical angles (theta, phi)
  const viewDir = (theta, phi) => V(-Math.sin(phi) * Math.sin(theta), -Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
  const easeIO = (x) => x * x * (3 - 2 * x);
  const env = (lt, dur, a, b) => smooth(0, a, lt) * (1 - smooth(dur - b, dur, lt));   // fade in over a, out over b
  const HC = (r, g, b) => new THREE.Color(r, g, b);   // linear colour; values above 1 bloom
  const _mf = new THREE.Vector3(), _mto = new THREE.Vector3(), _mp = new THREE.Vector3(), _mv = new THREE.Vector3(), _ms = new THREE.Vector3(), _mndc = new THREE.Vector3();
  const momentFx = { ca: 0, lensK: 0, lensX: 0.5, lensY: 0.5, lensR: 0, ripX: 0.5, ripY: 0.5, ripR: 0, ripA: 0, freeze: 0, tintA: 0, tint: new THREE.Color(1, 1, 1), dim: 0 };
  const MUI = { hint: $('moments-hint'), toast: $('moment-toast') };
  const touchUI = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  if (MUI.hint) MUI.hint.textContent = touchUI ? 'gira tu celular' : 'arrastra para buscarlos';

  /* small kit shared by the events */
  const dotTex = spriteTex(64, (g, S) => { const h = S / 2, gr = g.createRadialGradient(h, h, 0, h, h, h); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); });
  const FRES_VS = `varying vec3 vN; varying vec3 vV;
    void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`;
  // additive hologram: bright rim, faint core
  const holoMat = (c1, c2) => new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 0 }, uC1: { value: c1 }, uC2: { value: c2 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, vertexShader: FRES_VS,
    fragmentShader: `uniform float uFade; uniform vec3 uC1, uC2; varying vec3 vN; varying vec3 vV;
      void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); vec3 c = mix(uC1, uC2, f) * (0.12 + 1.6 * f * f); gl_FragColor = vec4(c * uFade, 1.0); }`
  });
  // dark body with a glowing rim: reads against the bright gas
  const rimMat = (core, rim) => new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 0 }, uCore: { value: core }, uRim: { value: rim } },
    transparent: true, vertexShader: FRES_VS,
    fragmentShader: `uniform float uFade; uniform vec3 uCore, uRim; varying vec3 vN; varying vec3 vV;
      void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(mix(uCore, uRim, f * f), uFade * (0.7 + 0.3 * f)); }`
  });
  const addMat = (color, map) => new THREE.MeshBasicMaterial({ color, map: map || null, fog: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const lit = (color) => new THREE.MeshBasicMaterial({ color, fog: false });
  const glow = (color, size) => { const s = sprite(dotTex, color); s.scale.setScalar(size || 1); return s; };
  function darkHalo(size){ const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0x000000, transparent: true, opacity: 0.7, depthWrite: false, fog: false })); s.scale.setScalar(size); return s; }
  function newGroup(){ const g = new THREE.Group(); g.visible = false; scene.add(g); return g; }
  function faceCam(o){ o.lookAt(camera.position); }
  function texOf(w, h, draw){ const c = makeCanvas(w, h); draw(c.getContext('2d'), w, h); return canvasTex(c, true); }
  function liveTex(w, h){ const c = makeCanvas(w, h); return { c, g: c.getContext('2d'), tx: canvasTex(c, true) }; }
  function pointsOf(n, size, color){
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ size, map: dotTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, sizeAttenuation: true });
    const p = new THREE.Points(geo, mat); p.frustumCulled = false;
    return { p, pos, mat, flush(){ geo.attributes.position.needsUpdate = true; } };
  }
  function segsOf(n, color){
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(n * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const l = new THREE.LineSegments(geo, mat); l.frustumCulled = false;
    return { l, pos, mat, flush(){ geo.attributes.position.needsUpdate = true; } };
  }
  // a point on the plane of an activation point: x to the right, y up, d away from the camera
  const at = (P, x, y, d, out) => (out || new THREE.Vector3()).copy(P.anchor).addScaledVector(P.right, x).addScaledVector(P.up, y).addScaledVector(P.out, d || 0);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--){ const j = (Math.random() * (i + 1)) | 0; const x = a[i]; a[i] = a[j]; a[j] = x; } return a; };
  // a copy of a rig without its userData (which holds live references)
  function cloneClean(root){
    const src = []; root.traverse((o) => src.push(o));
    const kept = src.map((o) => o.userData); src.forEach((o) => { o.userData = {}; });
    const c = root.clone(true);
    src.forEach((o, i) => { o.userData = kept[i]; });
    const dst = []; c.traverse((o) => dst.push(o));
    return { c, dst };
  }
  // positions on a plane that spell a text, for stars to gather into
  function textTargets(text, n, width){
    const W = 1024, H = 200, c = makeCanvas(W, H), g = c.getContext('2d');
    let fs = 150; g.font = '400 ' + fs + 'px "Michroma", sans-serif';
    const mw = g.measureText(text).width;
    if (mw > W * 0.92){ fs = Math.floor(fs * W * 0.92 / mw); g.font = '400 ' + fs + 'px "Michroma", sans-serif'; }
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, W / 2, H / 2);
    const d = g.getImageData(0, 0, W, H).data, cand = [];
    for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (d[(y * W + x) * 4 + 3] > 128) cand.push(x, y);
    const m = cand.length / 2, k = Math.min(n, m), out = new Float32Array(k * 2), sc = width / W;
    for (let i = 0; i < k; i++){ const j = (Math.random() * m) | 0; out[i * 2] = (cand[j * 2] - W / 2) * sc; out[i * 2 + 1] = -(cand[j * 2 + 1] - H / 2) * sc; }
    return out;
  }
  function textStars(text, width, color){
    const pts = textTargets(text, 700, width), N = pts.length / 2, stars = pointsOf(N, 0.14, color), from = new Float32Array(N * 3);
    for (let i = 0; i < N; i++){ const a = Math.random() * 6.28, r = 3 + Math.random() * 5; from[i * 3] = Math.cos(a) * r; from[i * 3 + 1] = Math.sin(a) * r; from[i * 3 + 2] = (Math.random() - 0.5) * 6; }
    return { stars, update(k, t, e){
      for (let i = 0; i < N; i++){ const q = smooth(0, 1, k * 1.3 - (i / N) * 0.3); stars.pos[i * 3] = lerp(from[i * 3], pts[i * 2], q); stars.pos[i * 3 + 1] = lerp(from[i * 3 + 1], pts[i * 2 + 1], q); stars.pos[i * 3 + 2] = from[i * 3 + 2] * (1 - q); }
      stars.flush(); stars.mat.opacity = e * (0.85 + 0.15 * Math.sin(t * 6));
    } };
  }

  // pose history of the astronaut, so an echo can replay what it did seconds ago
  const astroNodes = []; astro.traverse((o) => astroNodes.push(o));
  const HIST = 720, NA = astroNodes.length, hist = new Float32Array(HIST * NA * 4), histT = new Float64Array(HIST).fill(-1e9);
  let histHead = 0;
  function recordPose(now){ const o = histHead * NA * 4; for (let i = 0; i < NA; i++) astroNodes[i].quaternion.toArray(hist, o + i * 4); histT[histHead] = now; histHead = (histHead + 1) % HIST; }
  function poseAt(dst, now, delay){
    const want = now - delay; let idx = (histHead - 1 + HIST) % HIST;
    for (let s = 0; s < HIST - 1; s++){ const p = (idx - 1 + HIST) % HIST; if (histT[idx] <= want || histT[p] < -1e8) break; idx = p; }
    const o = idx * NA * 4;
    for (let i = 0; i < NA; i++) dst[i].quaternion.fromArray(hist, o + i * 4);
  }

  /* ===== group 1 · time ===== */
  const TIME = [
    { name: 'Eco temporal', line: 'Tu yo de hace unos segundos aparece a tu lado… y se rebobina.', dur: 8.5, make(P){
      const { c: ghost, dst } = cloneClean(astro);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uFade: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, vertexShader: FRES_VS,
        fragmentShader: `uniform float uFade, uTime; varying vec3 vN; varying vec3 vV;
          void main(){
            float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
            float scan = 0.7 + 0.3 * sin(gl_FragCoord.y * 0.9 - uTime * 24.0);
            vec3 rim = vec3(0.55, 1.6, 2.6) * (0.4 + 2.8 * f * f) * scan;
            vec3 c = mix(vec3(0.02, 0.05, 0.13), rim, 0.2 + 0.8 * smoothstep(0.0, 0.9, f));
            gl_FragColor = vec4(c, uFade * (0.6 + 0.4 * f));
          }` });
      ghost.traverse((o) => { if (o.isMesh){ o.material = mat; o.castShadow = false; o.receiveShadow = false; } });
      ghost.visible = false; ghost.scale.setScalar(1.6); scene.add(ghost);
      const halo = darkHalo(6); halo.visible = false; scene.add(halo);   // a dark patch behind the hologram so it stands out from the bright gas
      const rings = [0, 1].map(() => { const r = sprite(novaRingTex, HC(0.6, 1.6, 2.4)); r.visible = false; scene.add(r); return r; });
      const base = at(P, 0, -0.4, -3.0), D = 8.5;
      return {
        start(){ ghost.visible = halo.visible = true; rings.forEach((r) => { r.visible = true; }); },
        update(lt, raw, t){
          const inK = smooth(0, 0.8, lt), outK = 1 - smooth(D - 1.0, D, lt), rew = Math.max(0, lt - (D - 2.0));
          poseAt(dst, performance.now() / 1000, 2.5 + rew * rew * 1.4);   // the delay grows faster than time: it plays backwards
          const glitchy = lt < 0.8 || rew > 0, flick = reduceMotion || !glitchy ? 1 : (Math.sin(t * 57) > -0.2 ? 1 : 0.35);
          mat.uniforms.uFade.value = inK * outK * flick; mat.uniforms.uTime.value = t;
          ghost.position.copy(base).addScaledVector(P.right, 0.25 * Math.sin(lt * 0.7)).addScaledVector(P.up, 0.2 * Math.sin(lt * 0.9));
          halo.position.copy(ghost.position).addScaledVector(P.out, 1.4); halo.material.opacity = 0.8 * inK * outK;
          const r0 = smooth(0, 1.4, lt); rings[0].position.copy(ghost.position); rings[0].scale.setScalar(1 + 8 * r0); rings[0].material.opacity = 1 - r0;
          const r1 = smooth(D - 1.6, D, lt); rings[1].position.copy(ghost.position); rings[1].scale.setScalar(9 - 8 * r1); rings[1].material.opacity = r1 * (1 - r1) * 3;
          momentFx.ca += 0.025 * (1 - inK) + 0.03 * Math.min(1, rew);
        },
        end(){ ghost.visible = halo.visible = false; rings.forEach((r) => { r.visible = false; }); }
      };
    } },
    { name: 'Reloj derretido', line: 'Las agujas giran hacia atrás y las horas se escurren.', dur: 8, make(P){
      const G = newGroup(), gold = HC(2.2, 1.5, 0.55), white = HC(2.4, 2.3, 2.1);
      const face = new THREE.Mesh(new THREE.CircleGeometry(1.5, 64), new THREE.MeshBasicMaterial({ color: HC(0.04, 0.02, 0.08), transparent: true, opacity: 0.8, depthWrite: false, fog: false, side: THREE.DoubleSide }));
      G.add(face, new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.05, 10, 96), lit(gold)));
      const ticks = [];
      for (let i = 0; i < 12; i++){ const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, i % 3 ? 0.18 : 0.32, 0.04), lit(gold)); m.userData.a = i / 12 * Math.PI * 2; m.rotation.z = -m.userData.a; G.add(m); ticks.push(m); }
      const hand = (len, w) => { const g = new THREE.BoxGeometry(w, len, 0.03); g.translate(0, len * 0.45, 0.03); const m = new THREE.Mesh(g, lit(white)); G.add(m); return m; };
      const hourH = hand(0.75, 0.09), minH = hand(1.15, 0.05);
      const drops = pointsOf(24, 0.22, gold); G.add(drops.p);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 8, 0.8, 1.0), melt = smooth(2.0, 7.0, lt);
          G.scale.setScalar(Math.max(0.001, e));
          minH.rotation.z = lt * lt * 2.2; hourH.rotation.z = lt * lt * 0.18;   // counter-clockwise, faster and faster
          face.scale.set(1, 1 + 0.3 * melt, 1); face.position.y = -0.35 * melt;
          ticks.forEach((m) => { const c = Math.cos(m.userData.a), low = Math.max(0, -c); m.position.set(Math.sin(m.userData.a) * 1.3, c * 1.3 - melt * low * 1.1, 0.02); m.scale.y = 1 + melt * low * 3; });
          for (let i = 0; i < 24; i++){ const born = 2.2 + (i % 8) * 0.55 + Math.floor(i / 8) * 0.18, k = Math.max(0, lt - born); drops.pos.set([(i / 23 - 0.5) * 1.8, k > 0 ? -1.4 - 0.4 * melt - k * k * 1.3 : 1e4, 0.05], i * 3); }
          drops.flush(); drops.mat.opacity = e;
          momentFx.ca += 0.01 * (1 - smooth(0, 0.8, lt));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Déjà vu', line: 'La misma roca pasa tres veces… exactamente igual.', dur: 7.6, make(P){
      const rock = new THREE.Mesh(rockGeos[1], rockMats[0]); rock.scale.setScalar(0.55); rock.visible = false; scene.add(rock);
      const trail = pointsOf(40, 0.25, HC(0.5, 1.3, 2.0)); trail.p.visible = false; scene.add(trail.p);
      const flash = sprite(novaRingTex, HC(0.6, 1.4, 2.2)); flash.visible = false; scene.add(flash);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), L = 2.4;
      const pathAt = (k, out) => out.lerpVectors(a, b, k).addScaledVector(P.up, Math.sin(k * Math.PI) * 0.8);
      return {
        start(){ at(P, -5, 1.2, 0, a); at(P, 5, -1.0, -1, b); rock.visible = trail.p.visible = flash.visible = true; },
        update(lt, raw, t){
          const loop = Math.min(2, Math.floor(lt / L)), k = Math.min(1, (lt - loop * L) / L);
          pathAt(k, rock.position); rock.rotation.set(k * 4.1, k * 2.3, k * 1.7);   // identical spin on every pass
          flash.position.copy(a); const fk = Math.min(1, k * 2.5); flash.scale.setScalar(1 + 5 * fk); flash.material.opacity = 1 - fk;
          for (let i = 0; i < 40; i++){ pathAt(Math.max(0, k - i * 0.012), _mp); trail.pos.set([_mp.x, _mp.y, _mp.z], i * 3); }
          trail.flush(); trail.mat.opacity = 0.6 * (1 - smooth(7.0, 7.6, lt));
          rock.visible = lt < 7.2;
          momentFx.ca += 0.02 * (1 - fk);
        },
        end(){ rock.visible = trail.p.visible = flash.visible = false; }
      };
    } },
    { name: 'Tiempo congelado', line: 'El universo se detiene… pero tú sigues moviéndote.', dur: 6, make(P){
      const frost = pointsOf(90, 0.12, HC(1.4, 1.8, 2.4)); frost.p.visible = false; scene.add(frost.p);
      const ring = sprite(novaRingTex, HC(1.2, 1.6, 2.4)); ring.visible = false; scene.add(ring);
      const seeds = []; for (let i = 0; i < 90; i++) seeds.push([(Math.random() - 0.5) * 7, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3, Math.random() * 6.28]);
      return {
        start(){ frost.p.visible = ring.visible = true; ring.position.copy(P.anchor); },
        update(lt, raw, t){
          const f = env(lt, 6, 0.35, 1.2);
          momentFx.freeze = Math.max(momentFx.freeze, f);
          seeds.forEach((s, i) => { at(P, s[0], s[1] + 0.1 * Math.sin(lt * 0.5 + s[3]), s[2] - 2, _mp); frost.pos.set([_mp.x, _mp.y, _mp.z], i * 3); });
          frost.flush(); frost.mat.opacity = f * (0.6 + 0.4 * Math.sin(t * 7));
          const rk = smooth(0, 1.2, lt); ring.scale.setScalar(1 + 14 * rk); ring.material.opacity = 1 - rk;
        },
        end(){ frost.p.visible = ring.visible = false; }
      };
    } },
    { name: 'Reloj de arena', line: 'La arena sube: aquí el tiempo cae hacia arriba.', dur: 8.5, make(P){
      const G = newGroup(), radius = (y) => 0.1 + 0.72 * Math.pow(Math.abs(y) / 1.2, 1.3);
      const prof = []; for (let i = 0; i <= 24; i++){ const y = -1.2 + i * 0.1; prof.push(V2(radius(y), y)); }
      G.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 48), new THREE.MeshPhysicalMaterial({ color: C('#d8f2ff'), roughness: 0.05, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.6 })));
      for (const sy of [-1, 1]){ const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.1, 40), alu); cap.position.y = sy * 1.27; G.add(cap); }
      for (let i = 0; i < 3; i++){ const a = i / 3 * Math.PI * 2, rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.5, 8), alu); rod.position.set(Math.cos(a) * 0.9, 0, Math.sin(a) * 0.9); G.add(rod); }
      const N = 260, sand = pointsOf(N, 0.1, HC(2.6, 1.6, 0.5)); G.add(sand.p);
      const seeds = []; for (let i = 0; i < N; i++) seeds.push({ a: Math.random() * 6.28, r: Math.random(), h: Math.random(), d: 0.4 + (i / N) * 6.2 });
      const rest = (s, sign) => { const y = sign * (1.15 - s.h * 0.55), rr = radius(y) * 0.85 * Math.sqrt(s.r); return [Math.cos(s.a) * rr, y, Math.sin(s.a) * rr]; };
      return {
        start(){ G.position.copy(P.anchor); G.quaternion.setFromUnitVectors(V(0, 1, 0), P.up); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 8.5, 0.7, 1.0); G.scale.setScalar(Math.max(0.001, e) * 1.6); G.rotateY(raw * 0.3);
          seeds.forEach((s, i) => {
            const k = smooth(0, 1, (lt - s.d) / 0.8), lo = rest(s, -1), hi = rest(s, 1);   // each grain climbs through the neck
            const y = lerp(lo[1], hi[1], k), neck = 1 - Math.min(1, Math.abs(y) / 0.5) * (k > 0 && k < 1 ? 1 : 0);
            const squeeze = k > 0 && k < 1 ? 1 - neck * 0.95 : 1;
            sand.pos.set([lerp(lo[0], hi[0], k) * squeeze, y, lerp(lo[2], hi[2], k) * squeeze], i * 3);
          });
          sand.flush();
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Nave del futuro', line: 'Tu propia nave, oxidada, dentro de mil años.', dur: 9, make(P){
      const { c: wreck } = cloneClean(ship);
      const rust = new THREE.MeshStandardMaterial({ color: C('#7a4a2c'), map: TX.rockColor, normalMap: TX.rockNormal, normalScale: new THREE.Vector2(1.5, 1.5), roughness: 0.95, metalness: 0.35, envMapIntensity: 0.6 });
      wreck.traverse((o) => { if (o.isMesh) o.material = rust; if (o.isSprite) o.visible = false; });
      wreck.visible = false; scene.add(wreck);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      return {
        start(){ at(P, -5.5, 0.6, 1, a); at(P, 5.5, -0.4, 0, b); wreck.visible = true; wreck.rotation.set(0.4, 1.2, 0.2); },
        update(lt, raw, t){ wreck.position.lerpVectors(a, b, lt / 9); wreck.rotation.x += raw * 0.12; wreck.rotation.z += raw * 0.07; wreck.scale.setScalar(0.55 * Math.max(0.001, env(lt, 9, 1, 1.2))); },
        end(){ wreck.visible = false; }
      };
    } },
    { name: 'Ventana al pasado', line: 'Por un instante se ve la Tierra de hace 150 millones de años.', dur: 9, make(P){
      const G = newGroup(), L = liveTex(512, 512);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.7, 64), new THREE.MeshBasicMaterial({ map: L.tx, fog: false, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      G.add(disc, new THREE.Mesh(new THREE.TorusGeometry(1.72, 0.05, 10, 96), lit(HC(2.6, 1.2, 0.4))));
      const halo = sprite(novaRingTex, HC(2.0, 0.9, 0.4)); halo.scale.setScalar(4.6); G.add(halo);
      function draw(lt){
        const g = L.g, S = 512;
        const sky = g.createLinearGradient(0, 0, 0, S); sky.addColorStop(0, '#2a1446'); sky.addColorStop(0.5, '#d2562a'); sky.addColorStop(0.75, '#f3a34b');
        g.fillStyle = sky; g.fillRect(0, 0, S, S);
        g.fillStyle = 'rgba(255,220,150,0.9)'; g.beginPath(); g.arc(360, 250, 34, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#3a1d1d'; g.beginPath(); g.moveTo(40, 380); g.lineTo(170, 220); g.lineTo(205, 222); g.lineTo(330, 380); g.fill();   // volcano
        for (let i = 0; i < 6; i++){ g.fillStyle = 'rgba(70,50,60,' + (0.5 - i * 0.07) + ')'; g.beginPath(); g.arc(188 + i * 14 + Math.sin(lt + i) * 6, 205 - i * 26 - (lt * 10) % 26, 18 + i * 7, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = '#ff6a1a'; g.fillRect(183, 218, 12, 8);
        g.fillStyle = '#1d140f'; g.fillRect(0, 380, S, S - 380);
        g.strokeStyle = '#120c08'; g.lineWidth = 4;
        for (let i = 0; i < 9; i++){ const x = 20 + i * 58; g.beginPath(); g.moveTo(x, 390); g.quadraticCurveTo(x - 20, 340, x - 30, 330); g.moveTo(x, 390); g.quadraticCurveTo(x + 18, 345, x + 30, 332); g.stroke(); }
        // a long-necked dinosaur walking across
        const x = -120 + ((lt * 55) % 760), bob = Math.sin(lt * 4) * 3;
        g.fillStyle = '#0d0907';
        g.beginPath(); g.ellipse(x, 330 + bob, 70, 34, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(x + 40, 315 + bob); g.quadraticCurveTo(x + 90, 250, x + 105, 190 + bob); g.lineTo(x + 122, 192 + bob); g.quadraticCurveTo(x + 110, 260, x + 62, 330 + bob); g.fill();
        g.beginPath(); g.ellipse(x + 120, 188 + bob, 16, 9, -0.2, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(x - 60, 322 + bob); g.quadraticCurveTo(x - 130, 330, x - 170, 360); g.lineTo(x - 165, 366); g.quadraticCurveTo(x - 120, 345, x - 55, 345 + bob); g.fill();
        for (let k = 0; k < 4; k++){ const sw = Math.sin(lt * 4 + k * 1.6) * 8; g.fillRect(x - 40 + k * 27 + sw * 0.3, 350 + bob, 15, 42 - bob); }
        g.globalCompositeOperation = 'destination-in';   // soft round window
        const m = g.createRadialGradient(256, 256, 200, 256, 256, 256); m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = m; g.fillRect(0, 0, S, S);
        g.globalCompositeOperation = 'source-over';
        L.tx.needsUpdate = true;
      }
      let acc = 0;
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; draw(0); },
        update(lt, raw, t){ const e = env(lt, 9, 0.9, 1.0); G.scale.setScalar(Math.max(0.001, e)); disc.material.opacity = e; halo.material.opacity = 0.6 * e; acc += raw; if (acc > 1 / 30){ acc = 0; draw(lt); } },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Bucle de luz', line: 'Un rayo dio la vuelta al túnel y te alcanzó por la espalda.', dur: 6.5, make(P){
      const head = sprite(novaCoreTex, HC(1.6, 2.2, 2.6)); head.visible = false; scene.add(head);
      const N = 70, trail = pointsOf(N, 0.3, HC(0.6, 1.4, 2.4)); trail.p.visible = false; scene.add(trail.p);
      const hit = sprite(novaRingTex, HC(1.6, 2.0, 2.6)); hit.visible = false; scene.add(hit);
      const past = []; for (let i = 0; i < N; i++) past.push(new THREE.Vector3());
      let filled = 0;
      const path = (k, out) => {   // from the glint onto a loop around the throat, then home into the astronaut
        const a0 = Math.atan2(P.anchor.y, P.anchor.x), ang = a0 + k * Math.PI * 2.4, z = lerp(P.anchor.z, astro.position.z + 1.5, k);
        out.set(Math.cos(ang) * 3.6, Math.sin(ang) * 3.6, z);
        out.lerpVectors(P.anchor, out, smooth(0, 0.15, k));
        return out.lerp(astro.position, smooth(0.8, 1.0, k));
      };
      return {
        start(){ head.visible = trail.p.visible = true; filled = 0; },
        update(lt, raw, t){
          const k = Math.min(1, lt / 4.6);
          path(k, _mp); head.position.copy(_mp); head.scale.setScalar(1.2 + 0.3 * Math.sin(t * 30)); head.visible = k < 1;
          const last = past.pop(); last.copy(_mp); past.unshift(last); filled = Math.min(N, filled + 1);
          for (let i = 0; i < N; i++){ const p = past[Math.min(i, filled - 1)]; trail.pos.set([p.x, p.y, p.z], i * 3); }
          trail.flush(); trail.mat.opacity = 1 - smooth(5.0, 6.5, lt);
          const h = smooth(4.5, 4.7, lt) * (1 - smooth(4.8, 6.2, lt));
          hit.visible = h > 0.001; hit.position.copy(astro.position); hit.scale.setScalar(1 + 6 * smooth(4.5, 6.2, lt)); hit.material.opacity = h;
          lampLens.emissiveIntensity = 1.5 + 4 * h;
          momentFx.ca += 0.03 * h;
        },
        end(){ head.visible = trail.p.visible = hit.visible = false; lampLens.emissiveIntensity = 1.5; }
      };
    } },
    { name: 'Gato de Schrödinger', line: '', dur: 8.5, make(P, def){
      const G = newGroup();
      const card = new THREE.MeshStandardMaterial({ color: C('#b8894f'), roughness: 0.9, map: TX.fabricColor, envMapIntensity: 0.5 });
      const box = new THREE.Mesh(roundedBox(1, 0.9, 1, 0.04, 8, 2), card); G.add(box);
      const hinge = new THREE.Group(); hinge.position.set(0, 0.45, -0.5); G.add(hinge);
      const lid = new THREE.Mesh(roundedBox(1.04, 0.07, 1.04, 0.02, 6, 2), card); lid.position.set(0, 0.03, 0.52); hinge.add(lid);
      const catTex = texOf(256, 256, (g) => {
        g.fillStyle = '#9ff6ff'; g.shadowColor = '#5ce1ff'; g.shadowBlur = 18;
        g.beginPath(); g.ellipse(128, 170, 48, 56, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(128, 96, 38, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(96, 78); g.lineTo(100, 36); g.lineTo(122, 64); g.fill();
        g.beginPath(); g.moveTo(160, 78); g.lineTo(156, 36); g.lineTo(134, 64); g.fill();
        g.lineWidth = 12; g.strokeStyle = '#9ff6ff'; g.beginPath(); g.moveTo(170, 205); g.quadraticCurveTo(230, 200, 214, 130); g.stroke();
        g.shadowBlur = 0; g.fillStyle = '#0a1a24'; g.beginPath(); g.ellipse(114, 94, 6, 9, 0, 0, Math.PI * 2); g.ellipse(142, 94, 6, 9, 0, 0, Math.PI * 2); g.fill();
      });
      const qTex = texOf(256, 256, (g) => { g.fillStyle = '#ffd38a'; g.shadowColor = '#ffb04a'; g.shadowBlur = 20; g.font = '700 190px "Michroma", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 128, 136); });
      const reveal = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), addMat(HC(1.6, 1.6, 1.6), catTex)); G.add(reveal);
      return {
        start(){
          const alive = Math.random() < 0.5;
          reveal.material.map = alive ? catTex : qTex; reveal.material.needsUpdate = true;
          def.line = alive ? 'Abriste la caja: el gato está vivo… en este universo.' : 'La caja estaba vacía. En otro universo, el gato te saluda.';
          G.position.copy(P.anchor); faceCam(G); G.rotateX(0.35); G.visible = true;
        },
        update(lt, raw, t){
          const e = env(lt, 8.5, 0.8, 1.0); G.scale.setScalar(Math.max(0.001, e));
          hinge.rotation.x = -2.0 * easeIO(smooth(2.2, 3.2, lt));
          const r = smooth(3.0, 4.2, lt); reveal.visible = r > 0.001; reveal.position.set(0, 0.2 + 1.0 * r, 0); reveal.material.opacity = r * e;
          reveal.quaternion.copy(G.quaternion).invert().multiply(camera.quaternion);   // keep facing the camera inside the group
          box.rotation.y = 0.15 * Math.sin(t * 0.8);
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Clon del casco', line: 'Un casco gigante flota a tu lado… y su visor muestra una playa de la Tierra.', dur: 8.5, make(P){
      const G = newGroup(), R = 1.3;
      const beach = texOf(512, 256, (g) => {
        const sky = g.createLinearGradient(0, 0, 0, 160); sky.addColorStop(0, '#2d5fa8'); sky.addColorStop(0.6, '#f4a259'); sky.addColorStop(1, '#ffd29a'); g.fillStyle = sky; g.fillRect(0, 0, 512, 160);
        g.fillStyle = '#fff1c9'; g.beginPath(); g.arc(300, 150, 30, 0, Math.PI * 2); g.fill();
        const sea = g.createLinearGradient(0, 150, 0, 210); sea.addColorStop(0, '#2b7fa3'); sea.addColorStop(1, '#13506e'); g.fillStyle = sea; g.fillRect(0, 150, 512, 60);
        g.fillStyle = '#f1d39b'; g.fillRect(0, 205, 512, 51);
        g.strokeStyle = '#3b2a1a'; g.lineWidth = 7; g.beginPath(); g.moveTo(90, 230); g.quadraticCurveTo(100, 150, 80, 90); g.stroke();
        g.fillStyle = '#1f4a2a'; for (let i = 0; i < 6; i++){ g.beginPath(); g.ellipse(80 + Math.cos(i) * 30, 90 + Math.sin(i * 2) * 8, 40, 9, i * 1.05, 0, Math.PI * 2); g.fill(); }
      });
      G.add(new THREE.Mesh(new THREE.SphereGeometry(R, 64, 48), shell));
      const visor = new THREE.Mesh(new THREE.SphereGeometry(R * 1.037, 72, 40, VP0, VPL, VT0, VTL), new THREE.MeshPhysicalMaterial({ color: C('#ffffff'), metalness: 0.6, roughness: 0.05, clearcoat: 1, emissive: C('#ffffff'), emissiveMap: beach, emissiveIntensity: 0, envMapIntensity: 1.2 }));
      G.add(visor, new THREE.Mesh(new THREE.SphereGeometry(R * 1.076, 72, 24, 0, Math.PI * 2, 0, VT0 + 0.012), shell));
      const neck = new THREE.Mesh(new THREE.TorusGeometry(R * 0.75, 0.12, 16, 64).rotateX(Math.PI / 2), alu); neck.position.y = -R * 0.85; G.add(neck);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){ G.scale.setScalar(Math.max(0.001, env(lt, 8.5, 1.0, 1.0))); visor.material.emissiveIntensity = 1.6 * smooth(1.2, 2.6, lt) * (1 - smooth(6.8, 8.0, lt)); },
        end(){ G.visible = false; }
      };
    } }
  ];

  /* ===== group 2 · creatures ===== */
  const CREATURES = [
    { name: 'El ojo del abismo', line: 'Algo vive en las paredes del túnel… y te está mirando.', dur: 9.5, make(P){
      const RE = 2.2, D = 9.5, eye = newGroup(); eye.position.copy(P.anchor);
      const eyeMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uDilate: { value: 1 }, uGlow: { value: 1 } },
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uTime, uDilate, uGlow; varying vec3 vP;
          void main(){
            vec3 n = normalize(vP);
            float a = acos(clamp(n.z, -1.0, 1.0)), ph = atan(n.y, n.x);
            float veins = pow(1.0 - abs(sin(ph * 7.0 + sin(a * 11.0 + ph * 3.0) * 1.4)), 16.0) * smoothstep(0.55, 1.5, a);
            vec3 col = vec3(0.06, 0.015, 0.1) * (1.2 - 0.5 * smoothstep(0.6, 2.0, a)) + vec3(1.0, 0.1, 0.55) * veins * 0.9 * uGlow;
            const float R = 0.52;
            float fib = 0.62 + 0.38 * sin(ph * 64.0 + sin(ph * 11.0) * 2.5) * (0.7 + 0.3 * sin(a * 38.0 - uTime * 0.8));
            vec3 iris = mix(vec3(1.0, 0.78, 0.18), vec3(0.1, 1.0, 0.75), smoothstep(0.1, R, a)) * fib * (1.6 + 0.4 * uGlow);
            iris *= 1.0 - 0.8 * smoothstep(R - 0.1, R, a);
            col = mix(col, iris, 1.0 - smoothstep(R - 0.02, R + 0.02, a));
            float slit = length(vec2(n.x / (0.035 + 0.15 * uDilate), n.y / 0.4));
            col *= mix(1.0, smoothstep(0.85, 1.1, slit), step(0.0, n.z));
            vec2 hs = n.xy - vec2(-0.17, 0.2);
            col += vec3(1.0) * exp(-dot(hs, hs) * 500.0) * step(0.0, n.z) * 1.4;
            gl_FragColor = vec4(col, 1.0);
          }` });
      const ball = new THREE.Mesh(new THREE.SphereGeometry(RE, 64, 48), eyeMat); eye.add(ball);
      const lidMat = new THREE.MeshStandardMaterial({ color: C('#3b1838'), roughness: 0.5, metalness: 0, normalMap: TX.rockNormal, normalScale: new THREE.Vector2(1.5, 1.5), emissive: C('#ff3fae'), emissiveIntensity: 0.2, side: THREE.DoubleSide, fog: false, envMapIntensity: 0.8 });
      const upper = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.05, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2), lidMat);
      const lower = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.05, 64, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), lidMat);
      eye.add(upper, lower);
      const ring = sprite(novaRingTex, HC(1.5, 0.35, 1.2)); eye.add(ring);
      const aim = new THREE.Object3D(), sac = new THREE.Vector2(), sacNow = new THREE.Vector2(); let sacT = 0;
      return {
        start(){ eye.visible = true; aim.position.copy(eye.position); aim.lookAt(camera.position); eye.quaternion.copy(aim.quaternion); sacNow.set(0, 0); sac.set(0, 0); },
        update(lt, raw, t){
          const appear = smooth(0, 0.9, lt) * (1 - smooth(D - 0.9, D, lt));
          eye.scale.setScalar(Math.max(0.001, appear));
          let open = smooth(1.0, 2.2, lt) * (1 - smooth(7.4, 8.5, lt));
          open *= 1 - 0.95 * Math.max(0, 1 - Math.abs(lt - 4.9) / 0.18);   // one slow blink
          upper.rotation.x = -open * 1.2; lower.rotation.x = open * 1.2;
          aim.position.copy(eye.position); aim.lookAt(camera.position);
          eye.quaternion.slerp(aim.quaternion, 1 - Math.exp(-raw * 4));   // it follows you around
          sacT -= raw;
          if (sacT <= 0){ sacT = 0.35 + rand() * 0.9; sac.set((rand() - 0.5) * 0.2, (rand() - 0.5) * 0.28); }
          sacNow.lerp(sac, 1 - Math.exp(-raw * 28));
          ball.rotation.set(sacNow.x, sacNow.y, 0);
          eyeMat.uniforms.uTime.value = t;
          eyeMat.uniforms.uDilate.value = lerp(1, 0.12, smooth(2.0, 2.7, lt)) + 0.1 * Math.sin(t * 3.1);
          eyeMat.uniforms.uGlow.value = 0.7 + 0.3 * Math.sin(t * 2.2);
          lidMat.emissiveIntensity = 0.2 + 0.8 * (1 - open) * appear;
          const rk = smooth(0, 1.8, lt); ring.scale.setScalar(RE * (1.4 + 4.5 * rk)); ring.material.opacity = (1 - rk) * 0.9;
          momentFx.ca += 0.012 * (1 - smooth(0, 0.9, lt));
        },
        end(){ eye.visible = false; }
      };
    } },
    { name: 'Ballena de plasma', line: 'Un leviatán de luz nada por la pared del túnel.', dur: 10, make(P){
      const G = newGroup(), Lw = 6, prof = [];
      for (let i = 0; i <= 40; i++){ const s = i / 40; prof.push(V2(0.02 + 0.95 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.08)), 0.7) * (1 - 0.72 * s), s * Lw - Lw / 2)); }
      const mat = new THREE.ShaderMaterial({
        uniforms: { uFade: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `uniform float uTime; varying vec3 vN; varying vec3 vV; varying float vS;
          void main(){ vec3 p = position; float s = clamp((3.0 - p.z) / 6.0, 0.0, 1.0); vS = s; p.y += sin(p.z * 0.9 + uTime * 2.6) * 0.35 * s * s;
            vec4 mv = modelViewMatrix * vec4(p, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform float uFade, uTime; varying vec3 vN; varying vec3 vV; varying float vS;
          void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
            float stripes = 0.6 + 0.4 * sin(vS * 40.0 - uTime * 3.0);
            vec3 c = mix(vec3(0.15, 0.25, 1.0), vec3(0.4, 1.6, 2.2), f) * (0.1 + 1.8 * f * f) * stripes;
            gl_FragColor = vec4(c * uFade, 1.0); }` });
      G.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 48).rotateX(-Math.PI / 2), mat));   // head toward +Z
      const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.quadraticCurveTo(1.1, 0.2, 1.4, 0.9); shape.quadraticCurveTo(0.6, 0.45, 0, 0.35); shape.quadraticCurveTo(-0.6, 0.45, -1.4, 0.9); shape.quadraticCurveTo(-1.1, 0.2, 0, 0);
      const flukeMat = holoMat(HC(0.15, 0.25, 1.0), HC(0.4, 1.6, 2.2));
      const fluke = new THREE.Mesh(new THREE.ShapeGeometry(shape, 12).rotateX(-Math.PI / 2), flukeMat); fluke.position.z = -2.95; G.add(fluke);
      const dots = pointsOf(40, 0.16, HC(0.8, 2.2, 2.6)); G.add(dots.p);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      const pos = (k, out) => out.lerpVectors(a, b, k).addScaledVector(P.up, Math.sin(k * Math.PI * 2) * 1.2);
      return {
        start(){ at(P, -9, -1, 0, a); at(P, 9, 1, 0, b); G.visible = true; },
        update(lt, raw, t){
          const k = lt / 10, e = env(lt, 10, 1.0, 1.5);
          pos(k, G.position); pos(Math.min(1, k + 0.01), _mp); G.lookAt(_mp);
          mat.uniforms.uFade.value = e; mat.uniforms.uTime.value = t; flukeMat.uniforms.uFade.value = e;
          fluke.position.y = Math.sin(-2.95 * 0.9 + t * 2.6) * 0.35; fluke.rotation.x = -Math.PI / 2 * 0 + 0.4 * Math.cos(-2.95 * 0.9 + t * 2.6);
          for (let i = 0; i < 40; i++){ const s = (i % 20) / 20, z = 2.6 - s * 5, side = i < 20 ? 1 : -1, r = 0.8 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.08)), 0.7) * (1 - 0.72 * s); dots.pos.set([side * r, Math.sin(z * 0.9 + t * 2.6) * 0.35 * s * s - r * 0.3, z], i * 3); }
          dots.flush(); dots.mat.opacity = e * (0.6 + 0.4 * Math.sin(t * 4));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Medusas estelares', line: 'Un grupo de medusas bioluminiscentes cruza el vacío.', dur: 10, make(P){
      const G = newGroup(), J = 6, T8 = 8, SEG = 10, bellGeo = new THREE.SphereGeometry(0.55, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      const lines = segsOf(J * T8 * SEG, HC(1.6, 0.6, 1.8)); G.add(lines.l);
      const jellies = [];
      for (let j = 0; j < J; j++){ const m = holoMat(HC(0.9, 0.2, 1.2), HC(1.8, 1.2, 2.4)); const b = new THREE.Mesh(bellGeo, m); G.add(b); jellies.push({ b, m, x: (j - 2.5) * 1.5 + (Math.random() - 0.5), y: (Math.random() - 0.5) * 3, z: (Math.random() - 0.5) * 2, ph: Math.random() * 6.28, s: 0.6 + Math.random() * 0.6 }); }
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 10, 1.2, 1.5); let n = 0;
          jellies.forEach((q) => {
            const pulse = Math.pow(0.5 + 0.5 * Math.sin(t * 2.2 + q.ph), 3), bx = q.x, by = q.y - 2 + lt * 0.35 + pulse * 0.1, bz = q.z;
            q.b.position.set(bx, by, bz); q.b.scale.set(q.s * (1 - 0.18 * pulse), q.s * (1 + 0.25 * pulse), q.s * (1 - 0.18 * pulse));
            q.m.uniforms.uFade.value = e;
            for (let k = 0; k < T8; k++){
              const a = k / T8 * Math.PI * 2, r0 = 0.45 * q.s;
              let px = bx + Math.cos(a) * r0, py = by, pz = bz + Math.sin(a) * r0;
              for (let s = 0; s < SEG; s++){
                const nx = bx + Math.cos(a) * r0 * (1 - s * 0.06) + Math.sin(t * 2 + s * 0.6 + k) * 0.06 * s, ny = by - (s + 1) * 0.16 * q.s, nz = bz + Math.sin(a) * r0 * (1 - s * 0.06) + Math.cos(t * 1.7 + s * 0.5 + k) * 0.06 * s;
                lines.pos.set([px, py, pz, nx, ny, nz], n * 6); n++; px = nx; py = ny; pz = nz;
              }
            }
          });
          lines.flush(); lines.mat.opacity = 0.7 * e;
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Cardumen de cristal', line: 'Peces de vidrio que refractan la luz del agujero.', dur: 9, make(P){
      const N = 46, geo = new THREE.ConeGeometry(0.09, 0.42, 7).rotateX(Math.PI / 2);   // nose toward +Z
      const mat = new THREE.MeshPhysicalMaterial({ color: C('#cfefff'), metalness: 0.4, roughness: 0.04, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.6, emissive: C('#3a7cff'), emissiveIntensity: 0.35, envMapIntensity: 2.2, transparent: true, opacity: 0.85 });
      const fish = new THREE.InstancedMesh(geo, mat, N); fish.visible = false; fish.frustumCulled = false; scene.add(fish);
      const seeds = []; for (let i = 0; i < N; i++) seeds.push({ o: V(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2.4), ph: Math.random() * 6.28, sp: 0.8 + Math.random() * 0.5 });
      const dummy = new THREE.Object3D(), c0 = new THREE.Vector3(), c1 = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
      const centre = (k, out) => out.lerpVectors(a, b, k).addScaledVector(P.up, Math.sin(k * Math.PI * 2) * 1.2);
      return {
        start(){ at(P, -7, 0.5, 0, a); at(P, 7, -0.5, 0, b); fish.visible = true; },
        update(lt, raw, t){
          const k = lt / 9, e = Math.max(0.001, env(lt, 9, 0.8, 1.0));
          centre(k, c0); centre(Math.min(1, k + 0.01), c1); c1.sub(c0);
          seeds.forEach((s, i) => {
            const sw = t * s.sp + s.ph;
            dummy.position.copy(c0).add(_mv.copy(s.o).applyAxisAngle(P.out, Math.sin(sw * 0.5) * 0.6)).addScaledVector(P.up, Math.sin(sw) * 0.15);
            dummy.lookAt(_mp.copy(dummy.position).add(c1));
            dummy.rotateY(Math.sin(sw * 6) * 0.25);   // tail wiggle
            dummy.scale.setScalar(e); dummy.updateMatrix(); fish.setMatrixAt(i, dummy.matrix);
          });
          fish.instanceMatrix.needsUpdate = true;
        },
        end(){ fish.visible = false; }
      };
    } },
    { name: 'Mariposa cuántica', line: 'Cada aleteo cambia el color del universo.', dur: 9, make(P){
      const G = newGroup();
      const wingTex = texOf(256, 256, (g) => {
        const gr = g.createRadialGradient(40, 128, 10, 60, 128, 230); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(120,220,255,0.9)'); gr.addColorStop(0.8, 'rgba(200,80,255,0.7)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.beginPath(); g.moveTo(10, 128); g.bezierCurveTo(60, 0, 250, 10, 230, 110); g.bezierCurveTo(250, 170, 150, 250, 10, 140); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(160, 95, 18, 0, Math.PI * 2); g.fill(); g.fillStyle = 'rgba(40,0,80,0.9)'; g.beginPath(); g.arc(160, 95, 9, 0, Math.PI * 2); g.fill();
      });
      const wings = [];
      for (const s of [-1, 1]){ const geo = new THREE.PlaneGeometry(1.6, 1.6); geo.translate(0.8, 0, 0); const w = new THREE.Mesh(geo, addMat(HC(1.5, 1.5, 1.5), wingTex)); w.scale.x = s; G.add(w); wings.push(w); }
      G.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.7, 6, 12), lit(HC(1.2, 1.8, 2.2))));
      const dust = pointsOf(50, 0.12, HC(1.4, 1.2, 2.2)); dust.p.visible = false; scene.add(dust.p);
      const past = []; for (let i = 0; i < 50; i++) past.push(new THREE.Vector3());
      return {
        start(){ G.visible = dust.p.visible = true; at(P, 0, 0, -1, G.position); past.forEach((p) => p.copy(G.position)); },
        update(lt, raw, t){
          const e = env(lt, 9, 1.0, 1.2), flap = Math.sin(t * 9);
          at(P, 2.5 * Math.sin(lt * 0.7), 1.2 * Math.sin(lt * 1.3), -1 + 0.6 * Math.sin(lt * 0.5), G.position); faceCam(G); G.rotateZ(0.3 * Math.sin(lt * 0.9));
          wings[0].rotation.y = -flap * 0.9; wings[1].rotation.y = flap * 0.9;
          G.scale.setScalar(Math.max(0.001, e));
          momentFx.tint.setHSL((t * 0.12) % 1, 1, 0.6); momentFx.tintA = Math.max(momentFx.tintA, (0.3 + 0.1 * flap) * e);
          const last = past.pop(); last.copy(G.position); past.unshift(last);
          past.forEach((p, i) => { dust.pos.set([p.x + Math.sin(i * 7.1) * 0.1, p.y - i * 0.01, p.z], i * 3); });
          dust.flush(); dust.mat.opacity = 0.6 * e;
        },
        end(){ G.visible = dust.p.visible = false; }
      };
    } },
    { name: 'Gusano cósmico', line: 'Algo enorme emerge del gas… y vuelve a sumergirse.', dur: 9, make(P){
      const N = 26, segs = [];
      for (let i = 0; i < N; i++){ const m = new THREE.Mesh(rockGeos[i % 4], rockMats[1]); m.visible = false; scene.add(m); segs.push(m); }
      const mouth = new THREE.Group(); mouth.visible = false; scene.add(mouth);
      for (let i = 0; i < 10; i++){ const a = i / 10 * Math.PI * 2, c = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.35, 6), shell); c.position.set(Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0.2); c.rotation.x = Math.PI / 2; mouth.add(c); }
      const throat = sprite(novaCoreTex, HC(2.4, 0.6, 0.3)); throat.scale.setScalar(1.4); mouth.add(throat);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      const curve = (s, out) => out.lerpVectors(a, b, s).addScaledVector(P.up, Math.sin(Math.PI * s) * 3.2).addScaledVector(P.out, -Math.sin(Math.PI * s) * 2);
      return {
        start(){ at(P, -5, -2.6, 3, a); at(P, 5, -2.6, 3, b); },
        update(lt, raw, t){
          const h = lt / 9 * 1.7 - 0.25;
          segs.forEach((m, i) => { const s = h - i * 0.045; m.visible = s > 0 && s < 1; if (!m.visible) return; curve(s, m.position); m.scale.setScalar(0.85 * (1 - i / N * 0.65)); m.rotation.set(s * 9 + i, s * 5, 0); });
          const hs = THREE.MathUtils.clamp(h, 0, 0.99); curve(hs, mouth.position); curve(hs + 0.01, _mp); mouth.lookAt(_mp); mouth.visible = h > 0 && h < 1;
          momentFx.ca += mouth.visible ? 0.008 : 0;
        },
        end(){ segs.forEach((m) => { m.visible = false; }); mouth.visible = false; }
      };
    } },
    { name: 'Dragón de nebulosa', line: 'Una serpiente de gas ruge en silencio.', dur: 10, make(P){
      const N = 40, parts = [];
      for (let i = 0; i < N; i++){ const s = sprite(nebulaTex, new THREE.Color().setHSL(0.82 - (i / N) * 0.35, 0.9, 0.55).multiplyScalar(1.6)); s.material.rotation = Math.random() * 6; s.visible = false; scene.add(s); parts.push(s); }
      const eyes = [0, 1].map(() => { const s = sprite(novaCoreTex, HC(2.6, 0.5, 0.3)); s.visible = false; scene.add(s); return s; });
      const roar = sprite(novaRingTex, HC(1.8, 0.6, 1.6)); roar.visible = false; scene.add(roar);
      const path = (s, out) => at(P, -7 + s * 14, Math.sin(s * 9) * 1.4, Math.cos(s * 6) * 1.2, out);
      return {
        start(){ parts.concat(eyes).forEach((s) => { s.visible = true; }); },
        update(lt, raw, t){
          const e = env(lt, 10, 1.2, 1.5), head = lt / 10 * 1.15;
          parts.forEach((s, i) => { const k = head - i * 0.022; path(Math.max(0, k), s.position); s.scale.setScalar((2.6 - i * 0.045) * e); s.material.opacity = (k > 0 ? 0.8 : 0) * e; s.material.rotation += raw * 0.2; });
          path(Math.max(0, head), _mp);
          eyes.forEach((s, j) => { s.position.copy(_mp).addScaledVector(P.up, 0.35).addScaledVector(P.right, (j - 0.5) * 0.6).addScaledVector(P.out, -0.5); s.scale.setScalar(0.7 * e); s.material.opacity = e; });
          const live = lt > 4.5 && lt < 6, r = smooth(4.5, 6.0, lt);
          roar.visible = live; roar.position.copy(_mp); roar.scale.setScalar(1 + 10 * r); roar.material.opacity = 1 - r;
          momentFx.ca += live ? 0.03 * (1 - r) : 0;
        },
        end(){ parts.concat(eyes, [roar]).forEach((s) => { s.visible = false; }); }
      };
    } },
    { name: 'Mano gigante', line: 'Algo desde fuera del túnel lo acaricia.', dur: 10, make(P){
      const G = newGroup(), m = rimMat(HC(0.03, 0.01, 0.06), HC(1.4, 0.5, 2.0));
      G.add(new THREE.Mesh(roundedBox(2.0, 2.2, 0.55, 0.25), m));
      const cap = (len) => { const g = new THREE.CapsuleGeometry(0.22, len, 6, 12); g.translate(0, len / 2 + 0.11, 0); return new THREE.Mesh(g, m); };
      const fingers = [];
      [[-0.75, 1.1, 0.9], [-0.25, 1.15, 1.05], [0.25, 1.12, 1.0], [0.72, 1.05, 0.8]].forEach(([x, y, l]) => {
        const f1 = new THREE.Group(); f1.position.set(x, y, 0); G.add(f1); f1.add(cap(0.6 * l));
        const f2 = new THREE.Group(); f2.position.y = 0.6 * l + 0.1; f1.add(f2); f2.add(cap(0.45 * l));
        const f3 = new THREE.Group(); f3.position.y = 0.45 * l + 0.1; f2.add(f3); f3.add(cap(0.35 * l));
        fingers.push([f1, f2, f3]);
      });
      const thumb = new THREE.Group(); thumb.position.set(-1.0, -0.4, 0); thumb.rotation.z = 0.9; G.add(thumb); thumb.add(cap(0.9));
      const haze = sprite(nebulaTex, HC(1.0, 0.4, 1.4)); haze.scale.setScalar(9); G.add(haze);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      return {
        start(){ at(P, 7, -3, 2, a); at(P, 0.5, -1.2, 0.5, b); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 10, 1.5, 2.0), k = easeIO(smooth(0, 3.5, lt)) * (1 - easeIO(smooth(7.0, 10, lt)));
          G.position.lerpVectors(a, b, k); faceCam(G); G.rotateZ(0.5 - 0.4 * k); G.scale.setScalar(1.4);
          const curl = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(lt * 1.3));
          fingers.forEach((f, i) => { f[0].rotation.x = curl * 0.8 + i * 0.03; f[1].rotation.x = curl; f[2].rotation.x = curl * 0.9; });
          m.uniforms.uFade.value = e; haze.material.opacity = 0.5 * e;
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Flor estelar', line: 'Una flor de luz se abre solo para ti.', dur: 9, make(P){
      const G = newGroup();
      const petalTex = texOf(128, 256, (g) => { const gr = g.createLinearGradient(0, 256, 0, 0); gr.addColorStop(0, 'rgba(255,240,200,1)'); gr.addColorStop(0.5, 'rgba(255,110,200,0.85)'); gr.addColorStop(1, 'rgba(120,80,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(64, 256); g.bezierCurveTo(-10, 170, 20, 30, 64, 0); g.bezierCurveTo(108, 30, 138, 170, 64, 256); g.fill(); });
      const petals = [];
      for (let i = 0; i < 10; i++){ const hold = new THREE.Group(); hold.rotation.z = i / 10 * Math.PI * 2; G.add(hold); const geo = new THREE.PlaneGeometry(0.8, 2.0); geo.translate(0, 1.0, 0); const p = new THREE.Mesh(geo, addMat(HC(1.4, 1.4, 1.4), petalTex)); hold.add(p); petals.push(p); }
      const core = sprite(novaCoreTex, HC(2.4, 1.8, 0.8)); G.add(core);
      const pollen = pointsOf(70, 0.1, HC(2.4, 2.0, 1.0)); G.add(pollen.p);
      const ps = []; for (let i = 0; i < 70; i++) ps.push([Math.random() * 6.28, Math.random() * 3]);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 9, 0.6, 1.0), open = easeIO(smooth(0.5, 3.0, lt)) * (1 - easeIO(smooth(6.5, 8.5, lt)));
          petals.forEach((p, i) => { p.rotation.x = lerp(1.35, 0.12, open) + 0.05 * Math.sin(t * 2 + i); });
          core.scale.setScalar(0.8 + 1.6 * open);
          ps.forEach((q, i) => { const k = (lt * 0.4 + q[1]) % 3; pollen.pos.set([Math.cos(q[0]) * k * 0.6, Math.sin(q[0]) * k * 0.6, 0.3 + k * 0.5], i * 3); });
          pollen.flush(); pollen.mat.opacity = open * e;
          G.rotateZ(raw * 0.15); G.scale.setScalar(Math.max(0.001, e));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Semilla alienígena', line: 'Una semilla germina y crece un árbol de luz.', dur: 9.5, make(P){
      const G = newGroup(), branches = [];
      (function grow(x, y, ang, len, depth, born){
        const x2 = x + Math.sin(ang) * len, y2 = y + Math.cos(ang) * len; branches.push({ x, y, x2, y2, depth, born });
        if (depth >= 6) return;
        const n = depth < 2 ? 2 : (Math.random() < 0.7 ? 2 : 3);
        for (let i = 0; i < n; i++) grow(x2, y2, ang + (i - (n - 1) / 2) * (0.5 + Math.random() * 0.3), len * (0.7 + Math.random() * 0.12), depth + 1, born + 0.55);
      })(0, -2.2, 0, 1.2, 0, 1.0);
      const lines = segsOf(branches.length, HC(0.7, 2.2, 1.4)); G.add(lines.l);
      const tips = branches.filter((b) => b.depth === 6), leaves = pointsOf(tips.length, 0.22, HC(2.2, 1.0, 2.4)); G.add(leaves.p);
      const seed = sprite(novaCoreTex, HC(0.8, 2.4, 1.2)); seed.position.set(0, -2.2, 0); G.add(seed);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 9.5, 0.4, 1.2);
          branches.forEach((b, i) => { const k = smooth(b.born, b.born + 0.55, lt); lines.pos.set([b.x, b.y, 0, lerp(b.x, b.x2, k), lerp(b.y, b.y2, k), 0], i * 6); });
          lines.flush(); lines.mat.opacity = e;
          tips.forEach((b, i) => { const k = smooth(b.born + 0.5, b.born + 0.9, lt); leaves.pos.set([b.x2, b.y2 + 0.04 * Math.sin(t * 3 + i), k > 0 ? 0 : 1e4], i * 3); });
          leaves.flush(); leaves.mat.opacity = e * (0.7 + 0.3 * Math.sin(t * 4));
          seed.scale.setScalar((1.2 + 0.4 * Math.sin(t * 6)) * (1 - 0.6 * smooth(1, 2, lt)));
          G.scale.setScalar(Math.max(0.001, e) * 1.1);
        },
        end(){ G.visible = false; }
      };
    } }
  ];

  /* ===== group 3 · visitors ===== */
  const VISITORS = [
    { name: 'Visitantes curiosos', line: 'Un platillo escaneó tu traje y saltó al hiperespacio.', dur: 8.6, make(P){
      const anchor = P.anchor, ufo = newGroup(), spinG = new THREE.Group(); ufo.add(spinG);
      const hullMat = new THREE.MeshPhysicalMaterial({ color: C('#c3c9d4'), metalness: 1, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08, normalMap: TX.metalNormal, normalScale: new THREE.Vector2(0.25, 0.25), envMapIntensity: 1.7 });
      spinG.add(new THREE.Mesh(new THREE.LatheGeometry([V2(0.001, -0.2), V2(0.45, -0.19), V2(0.95, -0.09), V2(1.25, -0.01), V2(1.27, 0.02), V2(1.0, 0.08), V2(0.55, 0.16), V2(0.001, 0.19)], 72), hullMat));
      const lightMats = [], bulb = new THREE.SphereGeometry(0.055, 10, 8);
      for (let i = 0; i < 14; i++){ const a = i / 14 * Math.PI * 2, mt = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1), fog: false }); const b = new THREE.Mesh(bulb, mt); b.position.set(Math.cos(a) * 1.2, 0, Math.sin(a) * 1.2); spinG.add(b); lightMats.push(mt); }
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.46, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: C('#9dffc8'), roughness: 0.04, clearcoat: 1, transparent: true, opacity: 0.45, emissive: C('#14ff8c'), emissiveIntensity: 0.35, envMapIntensity: 1.5, depthWrite: false }));
      dome.position.y = 0.15; ufo.add(dome);
      const pilot = new THREE.Group(); pilot.position.y = 0.22; ufo.add(pilot);
      pilot.add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), new THREE.MeshStandardMaterial({ color: C('#3fae6a'), roughness: 0.5 })));
      const pupilMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.6, 2.2), fog: false });
      for (const sd of [-1, 1]){ const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), pupilMat); e.position.set(sd * 0.055, 0.03, 0.115); e.scale.set(1, 1.4, 0.6); pilot.add(e); }
      const belly = new THREE.Mesh(new THREE.CircleGeometry(0.5, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 3.0, 1.6), fog: false, side: THREE.DoubleSide }));
      belly.position.y = -0.2; ufo.add(belly);
      const beamMat = new THREE.ShaderMaterial({
        uniforms: { uOn: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
          void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform float uOn, uTime; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
          void main(){
            float core = abs(dot(normalize(vN), normalize(vV)));
            float band = pow(fract(vUv.y * 7.0 + uTime * 1.6), 10.0);
            float fade = smoothstep(0.0, 0.15, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
            gl_FragColor = vec4(vec3(0.35, 1.0, 0.65) * (0.16 + 1.3 * band) * (0.3 + 0.7 * core) * fade * uOn, 1.0);
          }` });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.85, 1, 40, 1, true), beamMat); beam.visible = false; scene.add(beam);
      const flash = sprite(novaCoreTex, HC(0.8, 2.2, 1.4)); flash.visible = false; scene.add(flash);
      const from = new THREE.Vector3(), away = V(0.35, 0.75, -1).normalize(), Yup = V(0, 1, 0), aim = new THREE.Object3D(), level = new THREE.Quaternion();
      let flashPlaced = false;
      return {
        start(){ from.copy(anchor).addScaledVector(P.out, 22).addScaledVector(P.up, 7); ufo.position.copy(from); ufo.visible = true; flashPlaced = false; },
        update(lt, raw, t){
          const A = astro.position, arrive = easeIO(smooth(0, 1.8, lt)), leave = Math.max(0, lt - 7.2);
          ufo.position.lerpVectors(from, anchor, arrive); ufo.position.y += 0.12 * Math.sin(t * 2.3);
          if (leave > 0) ufo.position.addScaledVector(away, leave * leave * 160);
          spinG.rotation.y += raw * (2.2 + 7 * (1 - arrive) + 14 * leave);
          // tip the saucer partway toward the astronaut, then a curious head tilt before leaving
          aim.position.copy(ufo.position); aim.lookAt(A); aim.rotateX(-Math.PI / 2);
          ufo.quaternion.copy(level).slerp(aim.quaternion, 0.45);
          ufo.rotateZ(0.28 * Math.sin(lt * 6.0) * smooth(6.3, 6.6, lt) * (1 - smooth(7.0, 7.2, lt)));
          ufo.updateMatrixWorld(true);
          pilot.lookAt(camera.position);
          lightMats.forEach((mt, i) => { mt.color.setHSL((t * 0.5 + i / lightMats.length) % 1, 1, 0.55).multiplyScalar(2.0 + 1.6 * Math.max(0, Math.sin(t * 9 - i))); });
          const on = smooth(1.9, 2.4, lt) * (1 - smooth(6.0, 6.4, lt));
          beam.visible = on > 0.001;
          if (beam.visible){
            _mp.copy(A).add(_mv.set(0.25 * Math.sin(t * 1.7), 0.3 * Math.sin(t * 1.1), 0));   // the beam sweeps over the suit
            ufo.localToWorld(_ms.set(0, -0.2, 0));
            _mto.copy(_ms).sub(_mp); const len = _mto.length(); _mto.normalize();
            beam.position.copy(_mp).addScaledVector(_mto, len / 2); beam.quaternion.setFromUnitVectors(Yup, _mto); beam.scale.set(1, len, 1);
          }
          beamMat.uniforms.uOn.value = on; beamMat.uniforms.uTime.value = t;
          lampLens.emissiveIntensity = 1.5 + on * (Math.sin(t * 38) > 0 ? 2.2 : -1.3);   // the helmet lamps stutter under the scan
          const fl = smooth(7.1, 7.3, lt) * (1 - smooth(7.4, 8.4, lt));
          flash.visible = fl > 0.001;
          if (flash.visible){ if (!flashPlaced){ flash.position.copy(ufo.position); flashPlaced = true; } flash.material.opacity = fl; flash.scale.setScalar(1.5 + 10 * smooth(7.1, 8.4, lt)); }
          if (lt > 8.0) ufo.visible = false;
          momentFx.ca += 0.02 * fl;
        },
        end(){ ufo.visible = beam.visible = flash.visible = false; lampLens.emissiveIntensity = 1.5; }
      };
    } },
    { name: 'Pulpo mecánico', line: 'Una sonda con tentáculos se acerca a examinarte.', dur: 9, make(P){
      const G = newGroup();
      G.add(new THREE.Mesh(new THREE.SphereGeometry(0.45, 40, 24), alu));
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 12), lit(HC(3.0, 0.3, 0.2))); eye.position.z = 0.4; G.add(eye);
      const eyeGlow = sprite(novaCoreTex, HC(2.4, 0.3, 0.2)); eyeGlow.position.z = 0.5; eyeGlow.scale.setScalar(0.8); G.add(eyeGlow);
      const T8 = 8, S = 11, balls = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), anodBlue, T8 * S); balls.frustumCulled = false; G.add(balls);
      const dummy = new THREE.Object3D(), a = new THREE.Vector3(), b = new THREE.Vector3();
      return {
        start(){ a.copy(P.anchor); b.lerpVectors(P.anchor, astro.position, 0.55); G.position.copy(a); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 9, 0.8, 1.0), k = easeIO(smooth(0.5, 3.5, lt)) * (1 - easeIO(smooth(6.0, 8.5, lt)));
          G.position.lerpVectors(a, b, k); G.lookAt(astro.position); G.scale.setScalar(Math.max(0.001, e) * 1.2);
          let n = 0;
          for (let i = 0; i < T8; i++){
            const ang = i / T8 * Math.PI * 2;
            for (let j = 0; j < S; j++){
              const s = j / S, w = Math.sin(t * 3 + i + s * 5) * 0.35 * s;
              dummy.position.set(Math.cos(ang) * (0.35 + s * 0.5) + Math.cos(ang + 1.5) * w, Math.sin(ang) * (0.35 + s * 0.5) + Math.sin(ang + 1.5) * w, -0.2 - s * 1.6);
              dummy.scale.setScalar(0.09 * (1 - s * 0.6)); dummy.updateMatrix(); balls.setMatrixAt(n++, dummy.matrix);
            }
          }
          balls.instanceMatrix.needsUpdate = true;
          eye.position.x = eyeGlow.position.x = 0.12 * Math.sin(t * 2.5);   // the eye scans
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Nave nodriza', line: 'Una sombra colosal pasa sobre el túnel.', dur: 11, make(P){
      const G = newGroup();
      const hull = new THREE.MeshStandardMaterial({ color: C('#1a1c24'), roughness: 0.6, metalness: 0.7, normalMap: TX.metalNormal, envMapIntensity: 0.6 });
      G.add(new THREE.Mesh(new THREE.LatheGeometry([V2(0.001, -1.2), V2(5, -1.0), V2(11, -0.3), V2(12, 0), V2(9, 0.8), V2(4, 1.8), V2(0.001, 2.2)], 96), hull));
      const lights = pointsOf(140, 0.5, HC(2.6, 1.8, 0.8)); G.add(lights.p);
      for (let i = 0; i < 140; i++){ const a = i / 70 * Math.PI * 2, r = i < 70 ? 11.5 : 8.5; lights.pos.set([Math.cos(a) * r, i < 70 ? -0.2 : 0.75, Math.sin(a) * r], i * 3); }
      lights.flush();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4, 0.25, 12, 96).rotateX(Math.PI / 2), lit(HC(0.6, 1.8, 2.6))); ring.position.y = -1.15; G.add(ring);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      return {
        start(){ at(P, -38, 4, 22, a); at(P, 38, 4, 22, b); G.visible = true; },
        update(lt, raw, t){ G.position.lerpVectors(a, b, lt / 11); G.rotation.y += raw * 0.05; momentFx.dim += 0.45 * env(lt, 11, 2, 2); lights.mat.opacity = 0.6 + 0.4 * Math.sin(t * 3); },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Holograma', line: 'Un mensaje grabado hace eones: «Bienvenido, terrícola».', dur: 9, make(P){
      const G = newGroup(), L = liveTex(256, 320);
      const holo = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.5), addMat(HC(1.3, 1.6, 1.6), L.tx)); holo.position.y = 0.2; G.add(holo);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.15, 32), alu); base.position.y = -1.0; G.add(base);
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 0.4, 1.6, 32, 1, true), addMat(HC(0.25, 0.6, 0.6))); cone.position.y = -0.2; G.add(cone);
      function draw(lt){
        const g = L.g; g.clearRect(0, 0, 256, 320); g.save();
        g.shadowColor = '#5ce1ff'; g.shadowBlur = 14; g.strokeStyle = '#8ff4ff'; g.fillStyle = 'rgba(92,225,255,0.35)'; g.lineWidth = 4;
        g.beginPath(); g.ellipse(128, 105, 62, 78, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = '#e8ffff'; g.beginPath(); g.ellipse(102, 100, 18, 28, -0.4, 0, Math.PI * 2); g.ellipse(154, 100, 18, 28, 0.4, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(108, 150); g.quadraticCurveTo(128, 162, 148, 150); g.stroke();
        g.save(); g.translate(215, 200); g.rotate(-0.5 + Math.sin(lt * 7) * 0.5); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -60); g.stroke();   // waving hand
        for (let f = -1; f <= 1; f++){ g.beginPath(); g.moveTo(0, -60); g.lineTo(f * 12, -82); g.stroke(); }
        g.restore();
        g.font = '600 18px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillStyle = '#c9fbff';
        const msg = 'BIENVENIDO, TERRÍCOLA'; g.fillText(msg.slice(0, Math.floor(Math.min(1, lt / 3) * msg.length)), 128, 290);
        g.restore();
        g.fillStyle = 'rgba(0,0,0,0.35)'; for (let y = (lt * 40) % 4; y < 320; y += 4) g.fillRect(0, y, 256, 1.5);   // scanlines
        L.tx.needsUpdate = true;
      }
      let acc = 0;
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; draw(0); },
        update(lt, raw, t){ const e = env(lt, 9, 0.6, 1.0), fl = reduceMotion ? 1 : (Math.sin(t * 43) > -0.85 ? 1 : 0.4); holo.material.opacity = e * fl; cone.material.opacity = 0.6 * e; acc += raw; if (acc > 1 / 30){ acc = 0; draw(lt); } },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Firma alienígena', line: 'Unos glifos se escriben solos en el aire.', dur: 8.5, make(P){
      const G = newGroup(), L = liveTex(512, 256);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.2), addMat(HC(1.6, 1.6, 1.6), L.tx)); G.add(plane);
      let strokes = [];
      function compose(){
        strokes = [];
        for (let gi = 0; gi < 6; gi++){
          const cx = 50 + gi * 82, n = 3 + ((Math.random() * 3) | 0);
          for (let s = 0; s < n; s++){
            const p = []; let x = cx + (Math.random() - 0.5) * 40, y = 128 + (Math.random() - 0.5) * 80;
            for (let k = 0; k < 4; k++){ p.push([x, y]); x = Math.max(cx - 34, Math.min(cx + 34, x + (Math.random() - 0.5) * 50)); y = Math.max(50, Math.min(206, y + (Math.random() - 0.5) * 60)); }
            strokes.push(p);
          }
        }
      }
      function draw(prog){
        const g = L.g; g.clearRect(0, 0, 512, 256); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#ffd6ff'; g.shadowColor = '#ff5fc6'; g.shadowBlur = 16; g.lineWidth = 6;
        const upto = prog * strokes.length;
        strokes.forEach((p, i) => {
          const k = THREE.MathUtils.clamp(upto - i, 0, 1); if (k <= 0) return;
          const segs = (p.length - 1) * k; g.beginPath(); g.moveTo(p[0][0], p[0][1]);
          for (let j = 1; j <= Math.ceil(segs); j++){ const f = Math.min(1, segs - (j - 1)); g.lineTo(lerp(p[j - 1][0], p[j][0], f), lerp(p[j - 1][1], p[j][1], f)); }
          g.stroke();
        });
        L.tx.needsUpdate = true;
      }
      let acc = 0;
      return {
        start(){ compose(); G.position.copy(P.anchor); faceCam(G); G.visible = true; draw(0); },
        update(lt, raw, t){ acc += raw; if (acc > 1 / 30){ acc = 0; draw(smooth(0.5, 5.5, lt)); } plane.material.opacity = env(lt, 8.5, 0.3, 1.5) * (0.85 + 0.15 * Math.sin(t * 5)); },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Faro alienígena', line: 'Te vio mirarlo… y te respondió.', dur: 8.5, make(P){
      const G = newGroup();
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.7, 0), new THREE.MeshPhysicalMaterial({ color: C('#bbffff'), metalness: 0.2, roughness: 0.05, clearcoat: 1, iridescence: 1, emissive: C('#5ce1ff'), emissiveIntensity: 0.5, envMapIntensity: 2, flatShading: true }));
      crystal.scale.y = 1.6; G.add(crystal);
      const light = sprite(novaCoreTex, HC(1.0, 2.4, 2.6)); light.scale.setScalar(3); G.add(light);
      const rings = []; for (let i = 0; i < 4; i++){ const r = sprite(novaRingTex, HC(0.6, 2.4, 1.2)); r.visible = false; scene.add(r); rings.push(r); }
      const code = [1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0];   // short and long pulses
      return {
        start(){ G.position.copy(P.anchor); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 8.5, 0.6, 1.0), answer = smooth(3.6, 4.0, lt);
          const on = code[Math.floor(lt * (answer > 0.5 ? 9 : 4)) % code.length];
          crystal.rotation.y += raw * (0.6 + 2.5 * answer); crystal.material.emissiveIntensity = (0.3 + 2.2 * on) * e;
          crystal.material.emissive.setRGB(lerp(0.36, 0.3, answer), lerp(0.88, 1.0, answer), lerp(1.0, 0.45, answer));
          light.material.opacity = (0.2 + 0.8 * on) * e; light.material.color.setRGB(lerp(1.0, 0.5, answer), 2.4, lerp(2.6, 1.0, answer));
          G.scale.setScalar(Math.max(0.001, e));
          rings.forEach((r, i) => { const live = lt > 4 + i * 0.6 && lt < 7.5; r.visible = live; if (!live) return; const k = ((lt - 4 - i * 0.6) % 2.4) / 2.4; r.position.lerpVectors(G.position, camera.position, k * 0.5); r.scale.setScalar(1 + 4 * k); r.material.opacity = (1 - k) * 0.9; });
        },
        end(){ G.visible = false; rings.forEach((r) => { r.visible = false; }); }
      };
    } },
    { name: 'Ascensor cósmico', line: 'Una plataforma sube y baja llevando a un pasajero diminuto.', dur: 9, make(P){
      const G = newGroup();
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 8, 32, 1, true), addMat(HC(0.2, 0.55, 0.4))); G.add(column);
      const plat = new THREE.Group(); G.add(plat);
      plat.add(new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.75, 0.12, 40), alu));
      const lr = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.03, 8, 64).rotateX(Math.PI / 2), lit(HC(0.5, 2.6, 1.4))); plat.add(lr);
      const alienTex = texOf(64, 128, (g) => {
        g.fillStyle = '#7dff9a'; g.shadowColor = '#3dff7a'; g.shadowBlur = 8;
        g.beginPath(); g.ellipse(32, 30, 16, 20, 0, 0, Math.PI * 2); g.fill(); g.fillRect(24, 48, 16, 44); g.fillRect(14, 54, 36, 6); g.fillRect(22, 90, 6, 30); g.fillRect(36, 90, 6, 30);
        g.shadowBlur = 0; g.fillStyle = '#003311'; g.beginPath(); g.ellipse(25, 30, 5, 8, -0.4, 0, Math.PI * 2); g.ellipse(39, 30, 5, 8, 0.4, 0, Math.PI * 2); g.fill();
      });
      const alien = new THREE.Sprite(new THREE.SpriteMaterial({ map: alienTex, transparent: true, depthWrite: false, fog: false })); alien.scale.set(0.35, 0.7, 1); alien.position.y = 0.42; plat.add(alien);
      return {
        start(){ G.position.copy(P.anchor); G.quaternion.setFromUnitVectors(V(0, 1, 0), P.up); G.visible = true; },
        update(lt, raw, t){ const e = env(lt, 9, 0.6, 1.0); plat.position.y = 3.2 * Math.sin(lt * 1.1 - 1.2); column.material.opacity = 0.6 * e; G.scale.setScalar(Math.max(0.001, e)); lr.material.color.setHSL((t * 0.2) % 1, 1, 0.6).multiplyScalar(2.2); },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Ciudad flotante', line: 'Una metrópolis alienígena asoma entre la niebla.', dur: 10, make(P){
      const G = newGroup();
      const win = texOf(64, 128, (g) => { g.fillStyle = '#05060a'; g.fillRect(0, 0, 64, 128); for (let y = 4; y < 128; y += 8) for (let x = 4; x < 64; x += 8) if (Math.random() < 0.55){ g.fillStyle = Math.random() < 0.8 ? '#ffd27a' : '#7ae8ff'; g.fillRect(x, y, 4, 4); } });
      const towerMat = new THREE.MeshStandardMaterial({ color: C('#1b1e2a'), roughness: 0.5, metalness: 0.6, emissive: C('#ffffff'), emissiveMap: win, emissiveIntensity: 1.6, envMapIntensity: 0.7 });
      const rockBase = new THREE.Mesh(rockGeos[2], rockMats[2]); rockBase.scale.set(3.4, 1.2, 2.6); rockBase.position.y = -1.1; G.add(rockBase);
      for (let i = 0; i < 18; i++){
        const h = 0.8 + Math.random() * 2.8, w = 0.25 + Math.random() * 0.35;
        const m = new THREE.Mesh(i % 3 ? new THREE.BoxGeometry(w, h, w) : new THREE.CylinderGeometry(w * 0.4, w * 0.6, h, 10), towerMat);
        m.position.set((Math.random() - 0.5) * 4.6, -0.2 + h / 2, (Math.random() - 0.5) * 3); G.add(m);
        if (i % 4 === 0){ const tip = sprite(novaCoreTex, HC(2.6, 0.4, 0.3)); tip.scale.setScalar(0.35); tip.position.set(m.position.x, -0.1 + h, m.position.z); G.add(tip); }
      }
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      return {
        start(){ at(P, 0, -0.5, 12, a); at(P, 0, -0.5, 2.5, b); G.quaternion.setFromUnitVectors(V(0, 1, 0), P.up); G.visible = true; },
        update(lt, raw, t){ G.position.lerpVectors(a, b, easeIO(smooth(0, 5, lt))); G.rotateY(raw * 0.08); G.scale.setScalar(Math.max(0.001, env(lt, 10, 1.5, 1.5))); towerMat.emissiveIntensity = 1.6 * (0.85 + 0.15 * Math.sin(t * 5)); },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Astronauta perdido', line: 'Otro astronauta te saluda a lo lejos… y se desvanece.', dur: 9, make(P){
      const { c: twin, dst } = cloneClean(astro);
      twin.traverse((o) => { if (o.isMesh){ o.castShadow = false; o.receiveShadow = false; } });
      twin.visible = false; scene.add(twin);
      const iUp = astroNodes.indexOf(arms[0].up.g), iFo = astroNodes.indexOf(arms[0].fo.g);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), aim = new THREE.Object3D(), qUp = new THREE.Quaternion(), upDir = V(0.75, 0.75, 0.25).normalize();
      return {
        start(){ at(P, 0.6, 0, 1.5, a); at(P, 2.0, 0.6, 8, b); twin.visible = true; },
        update(lt, raw, t){
          for (let i = 1; i < astroNodes.length; i++) dst[i].quaternion.copy(astroNodes[i].quaternion);   // it moves like you…
          dst[iUp].quaternion.setFromUnitVectors(DOWN, upDir);   // …except for one arm, waving
          qUp.copy(dst[iUp].quaternion).invert();
          dst[iFo].quaternion.setFromUnitVectors(DOWN, _mp.set(0.35 * Math.sin(t * 7), 1, 0.2).normalize().applyQuaternion(qUp));
          twin.position.lerpVectors(a, b, smooth(4.5, 9, lt));
          aim.position.copy(twin.position); aim.lookAt(camera.position); twin.quaternion.copy(aim.quaternion);
          twin.scale.setScalar(Math.max(0.001, env(lt, 9, 0.8, 0.8)));
        },
        end(){ twin.visible = false; }
      };
    } },
    { name: 'Satélite antiguo', line: 'Un Sputnik perdido sigue emitiendo su «bip-bip».', dur: 9, make(P){
      const G = newGroup();
      G.add(new THREE.Mesh(new THREE.SphereGeometry(0.42, 40, 24), alu));
      for (let i = 0; i < 4; i++){ const g = new THREE.CylinderGeometry(0.012, 0.012, 2.6, 6); g.translate(0, -1.3, 0); const ant = new THREE.Mesh(g, alu); ant.position.set(i < 2 ? 0.2 : -0.2, 0, i % 2 ? 0.2 : -0.2); ant.rotation.set(i % 2 ? 0.35 : -0.35, 0, i < 2 ? 2.5 : -2.5); G.add(ant); }
      const beep = sprite(novaCoreTex, HC(2.2, 2.4, 2.6)); G.add(beep);
      const ring = sprite(novaRingTex, HC(1.2, 2.0, 2.4)); G.add(ring);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      return {
        start(){ at(P, -4.5, 1.2, 0, a); at(P, 4.5, -0.8, 0.5, b); G.visible = true; },
        update(lt, raw, t){
          G.position.lerpVectors(a, b, lt / 9); G.rotation.x += raw * 0.3; G.rotation.z += raw * 0.2;
          const ph = (lt % 0.9) / 0.9, on = ph < 0.12 ? 1 : 0;
          beep.scale.setScalar(0.4 + 1.8 * on); beep.material.opacity = 0.3 + 0.7 * on; ring.scale.setScalar(0.5 + 5 * ph); ring.material.opacity = (1 - ph) * 0.7;
          G.scale.setScalar(Math.max(0.001, env(lt, 9, 0.6, 0.8)));
        },
        end(){ G.visible = false; }
      };
    } }
  ];

  /* ===== group 4 · extreme physics ===== */
  const PHYSICS = [
    { name: 'Micro agujero negro', line: 'La luz se dobla a su alrededor… y se traga un fragmento.', dur: 10, make(P){
      const RH = 0.5, bh = newGroup(); bh.position.copy(P.anchor);
      bh.add(new THREE.Mesh(new THREE.SphereGeometry(RH, 40, 24), new THREE.MeshBasicMaterial({ color: 0x000000, fog: false })));
      const diskMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uFade: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uTime, uFade; varying vec2 vP;
          void main(){
            float r = length(vP), a = atan(vP.y, vP.x);
            float k = clamp((r - 0.62) / 1.5, 0.0, 1.0);
            float swirl = 0.5 + 0.5 * sin(a * 3.0 - uTime * 3.0 / (r * r) + r * 9.0);
            float grain = 0.6 + 0.4 * sin(a * 13.0 - uTime * 5.0 / r + r * 27.0);
            float heat = pow(1.0 - k, 2.2);
            vec3 c = mix(vec3(1.0, 0.22, 0.05), vec3(1.0, 0.92, 0.75), heat);
            float beaming = 0.35 + 0.65 * (0.5 + 0.5 * sin(a));
            float I = heat * (0.35 + 0.65 * swirl * grain) * beaming * smoothstep(0.0, 0.05, k) * (1.0 - smoothstep(0.8, 1.0, k));
            gl_FragColor = vec4(c * I * 3.2 * uFade, 1.0);
          }` });
      const disk = new THREE.Mesh(new THREE.RingGeometry(0.62, 2.12, 160, 1), diskMat); disk.rotation.set(1.15, 0.3, 0); bh.add(disk);
      const halo = sprite(novaRingTex, HC(1.3, 0.8, 0.45)); halo.scale.setScalar(2.6); bh.add(halo);
      const pop = sprite(novaCoreTex, HC(1.6, 1.5, 2.4)); pop.position.copy(P.anchor); pop.visible = false; scene.add(pop);
      const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), preyScale = new THREE.Vector3();
      let prey = null, preyAng = 0;
      const release = () => { if (!prey) return; prey.mesh.scale.copy(preyScale); prey.captured = false; place(prey, false); prey = null; };
      return {
        start(){
          bh.visible = true;
          const pool = debris.filter((d) => !d.big && !d.captured && d.mesh.scale.x < 0.4);
          prey = pool.length ? pool[(Math.random() * pool.length) | 0] : null;
          if (prey){ prey.captured = true; preyScale.copy(prey.mesh.scale); preyAng = Math.random() * 6.28; }
        },
        update(lt, raw, t){
          const grow = easeIO(smooth(0, 1.2, lt)), shrink = 1 - smooth(7.0, 8.6, lt), s = Math.max(0.001, grow * shrink);
          bh.scale.setScalar(s);
          diskMat.uniforms.uTime.value = t; diskMat.uniforms.uFade.value = grow * (1 + 1.2 * smooth(6.5, 8.4, lt));   // it flares up as it evaporates
          halo.material.opacity = 0.6; halo.material.rotation += raw * 0.4;
          if (prey){
            if (lt < 6.4){
              const k = smooth(1.4, 6.4, lt), r = lerp(4.5, 0.5, easeIO(k));
              e1.set(1, 0, 0).applyQuaternion(disk.quaternion); e2.set(0, 1, 0).applyQuaternion(disk.quaternion);
              preyAng += raw * (0.5 + 2.6 / Math.max(r, 0.45));   // faster and faster as it falls in
              prey.mesh.position.copy(bh.position).addScaledVector(e1, Math.cos(preyAng) * r).addScaledVector(e2, Math.sin(preyAng) * r);
              prey.mesh.scale.copy(preyScale).multiplyScalar(Math.max(0.02, 1 - 0.95 * smooth(0.55, 1, k)));
              prey.mesh.rotation.z += raw * 8 * k;
            } else release();
          }
          const p = smooth(8.4, 8.6, lt) * (1 - smooth(8.7, 9.9, lt));   // the last flash as it evaporates
          pop.visible = p > 0.001; if (pop.visible){ pop.material.opacity = p; pop.scale.setScalar(1 + 7 * smooth(8.4, 9.9, lt)); }
          momentFx.ca += 0.02 * p;
          // gravitational lensing is drawn in the final pass, centred on the hole
          if (s > 0.01){
            _mndc.copy(bh.position).project(camera);
            if (_mndc.z < 1 && Math.abs(_mndc.x) < 1.5 && Math.abs(_mndc.y) < 1.5){
              const r = 0.5 * RH * s / (camera.position.distanceTo(bh.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
              momentFx.lensK = Math.pow(r * 2.0, 2); momentFx.lensR = r; momentFx.lensX = _mndc.x * 0.5 + 0.5; momentFx.lensY = _mndc.y * 0.5 + 0.5;
            }
          }
        },
        end(){ bh.visible = pop.visible = false; release(); }
      };
    } },
    { name: 'Teseracto', line: 'Un cubo de cuatro dimensiones se pliega sobre sí mismo.', dur: 9, make(P){
      const G = newGroup(), V4 = [], E4 = [];
      for (let i = 0; i < 16; i++) V4.push([(i & 1) ? 1 : -1, (i & 2) ? 1 : -1, (i & 4) ? 1 : -1, (i & 8) ? 1 : -1]);
      for (let i = 0; i < 16; i++) for (let b = 0; b < 4; b++){ const j = i ^ (1 << b); if (j > i) E4.push([i, j]); }
      const lines = segsOf(E4.length, HC(0.8, 2.2, 2.6)); G.add(lines.l);
      const verts = pointsOf(16, 0.22, HC(2.4, 2.4, 2.6)); G.add(verts.p);
      const P3 = new Float32Array(48);
      const rot = (p, i, j, a) => { const c = Math.cos(a), s = Math.sin(a), x = p[i], y = p[j]; p[i] = x * c - y * s; p[j] = x * s + y * c; };
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          for (let i = 0; i < 16; i++){
            const p = V4[i].slice(); rot(p, 0, 3, lt * 0.9); rot(p, 1, 2, lt * 0.6); rot(p, 2, 3, lt * 0.42);   // rotations in 4D, then a perspective drop to 3D
            const k = 1.6 / (3 - p[3]); P3[i * 3] = p[0] * k; P3[i * 3 + 1] = p[1] * k; P3[i * 3 + 2] = p[2] * k;
          }
          E4.forEach(([i, j], n) => { lines.pos.set([P3[i * 3], P3[i * 3 + 1], P3[i * 3 + 2], P3[j * 3], P3[j * 3 + 1], P3[j * 3 + 2]], n * 6); });
          verts.pos.set(P3); lines.flush(); verts.flush();
          G.scale.setScalar(Math.max(0.001, env(lt, 9, 0.8, 1.0)) * 1.3); G.rotateZ(raw * 0.1);
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Fractura del espacio', line: 'El espacio se agrieta como un vidrio… y se repara solo.', dur: 8, make(P){
      const G = newGroup(), L = liveTex(512, 512);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), addMat(HC(1.6, 1.8, 2.0), L.tx)); G.add(plane);
      let cracks = [];
      function compose(){
        cracks = [];
        const rays = 11 + ((Math.random() * 5) | 0);
        for (let i = 0; i < rays; i++){ let a = i / rays * Math.PI * 2 + Math.random() * 0.3, x = 256, y = 256; const pts = [[x, y]], len = 150 + Math.random() * 100; for (let s = 0; s < 6; s++){ a += (Math.random() - 0.5) * 0.5; x += Math.cos(a) * len / 6; y += Math.sin(a) * len / 6; pts.push([x, y]); } cracks.push(pts); }
        for (let r = 1; r <= 3; r++){ const pts = []; for (let i = 0; i <= 24; i++){ const a = i / 24 * Math.PI * 2, rr = r * 45 + (Math.random() - 0.5) * 14; pts.push([256 + Math.cos(a) * rr, 256 + Math.sin(a) * rr]); } cracks.push(pts); }
      }
      function draw(p){
        const g = L.g; g.clearRect(0, 0, 512, 512); g.strokeStyle = '#e8fbff'; g.shadowColor = '#7df3ff'; g.shadowBlur = 10; g.lineWidth = 2.5;
        if (p > 0.001) cracks.forEach((pts) => { const n = Math.max(1, Math.floor(p * (pts.length - 1) + 0.001)); g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i <= n && i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.stroke(); });
        L.tx.needsUpdate = true;
      }
      const shardGeo = new THREE.BufferGeometry().setFromPoints([V(0, 0.18, 0), V(-0.12, -0.1, 0), V(0.14, -0.08, 0)]);
      const shards = [];
      for (let i = 0; i < 26; i++){ const m = new THREE.Mesh(shardGeo, addMat(HC(1.4, 1.8, 2.2))); m.userData.dir = V(Math.random() - 0.5, Math.random() - 0.5, Math.random() * 0.8).normalize(); m.userData.spin = V(Math.random(), Math.random(), Math.random()).multiplyScalar(6); G.add(m); shards.push(m); }
      let acc = 0;
      return {
        start(){ compose(); G.position.copy(P.anchor); faceCam(G); G.visible = true; draw(0); },
        update(lt, raw, t){
          const crack = smooth(0.2, 0.9, lt) * (1 - smooth(5.0, 7.2, lt));
          acc += raw; if (acc > 1 / 30){ acc = 0; draw(crack); }
          plane.material.opacity = Math.min(1, crack * 1.5);
          const fly = smooth(0.3, 2.0, lt) * (1 - smooth(4.0, 6.2, lt));   // out, then back into place
          shards.forEach((m) => { m.position.copy(m.userData.dir).multiplyScalar(fly * 3.2); m.rotation.set(m.userData.spin.x * fly, m.userData.spin.y * fly, m.userData.spin.z * fly); m.material.opacity = fly; });
          momentFx.ca += 0.05 * smooth(0.15, 0.2, lt) * (1 - smooth(0.2, 0.8, lt));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Lago de mercurio', line: 'Gotas de mercurio se funden en un lago que te refleja… y vuelven a dispersarse.', dur: 11, make(P){
      // a real mirror: a cube camera at the mercury renders the whole scene (astronaut included) a few times a second
      const mirrorRT = new THREE.WebGLCubeRenderTarget(256, { type: HDR, generateMipmaps: false });
      const mirrorCam = new THREE.CubeCamera(0.05, 600, mirrorRT); scene.add(mirrorCam);
      const merc = new THREE.MeshStandardMaterial({ color: C('#e9eef5'), metalness: 1, roughness: 0.03, envMap: mirrorRT.texture, envMapIntensity: 1.4 });
      const G = newGroup();
      // the body: a dense sphere reshaped every frame (drop → wobbling blob → flat lake with ripples → blob → spray)
      const geo = new THREE.SphereGeometry(1, 144, 96), pos = geo.attributes.position, nor = geo.attributes.normal, base = pos.array.slice(), NV = pos.count;
      const seams = new Map();
      for (let i = 0; i < NV; i++){ const k = base[i * 3].toFixed(4) + ',' + base[i * 3 + 1].toFixed(4) + ',' + base[i * 3 + 2].toFixed(4); const a = seams.get(k); if (a) a.push(i); else seams.set(k, [i]); }
      const dupes = [...seams.values()].filter((a) => a.length > 1);
      const body = new THREE.Mesh(geo, merc); body.frustumCulled = false; G.add(body);
      // droplets that gather into the pool and are thrown out at the end
      const dropGeo = new THREE.SphereGeometry(1, 32, 20), drops = [];
      for (let i = 0; i < 18; i++){
        const m = new THREE.Mesh(dropGeo, merc); m.visible = false; G.add(m);
        const d = V(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        drops.push({ m, d, r: 0.09 + Math.random() * 0.16, arrive: 0.3 + Math.random() * 1.7, dist: 4 + Math.random() * 3, spin: Math.random() * 6 });
      }
      const sheen = sprite(dotTex, HC(0.9, 1.0, 1.15)); sheen.scale.setScalar(6); G.add(sheen);   // soft light spilling off the metal
      const nrm = new THREE.Vector3(), Yup = V(0, 1, 0);
      let frame2 = 0;
      function shape(lt, t){
        const blob = 0.25 + 0.75 * easeIO(smooth(0.4, 2.3, lt)) - 0.75 * easeIO(smooth(9.0, 10.4, lt));
        const flat = easeIO(smooth(3.0, 4.4, lt)) * (1 - easeIO(smooth(7.6, 8.9, lt)));
        const wob = 0.35 + 0.65 * (smooth(1.6, 2.6, lt) * (1 - smooth(3.0, 3.6, lt)) + smooth(8.4, 9.0, lt));
        const R = 0.95 * Math.max(0.02, blob), spread = lerp(1, 2.7, flat), squash = lerp(1, 0.075, flat);
        const c2x = 0.9 * Math.cos(lt * 0.7), c2z = 0.6 * Math.sin(lt * 0.9);   // a second, wandering ripple source
        for (let i = 0; i < NV; i++){
          const nx = base[i * 3], ny = base[i * 3 + 1], nz = base[i * 3 + 2];
          const w = 1 + wob * 0.085 * Math.sin(nx * 3.1 + t * 3.1) * Math.sin(ny * 2.6 + t * 2.3) * Math.sin(nz * 3.7 + t * 2.7);
          const x = nx * R * w * spread, z = nz * R * w * spread;
          let y = ny * R * w * squash;
          if (flat > 0.001){
            const r1 = Math.hypot(x, z), r2 = Math.hypot(x - c2x, z - c2z);
            const wave = Math.sin(r1 * 7.5 - t * 5.2) * Math.exp(-r1 * 0.45) * 0.065 + Math.sin(r2 * 10 - t * 7) * Math.exp(-r2 * 0.9) * 0.03;
            y += flat * wave * (ny > 0 ? 1 : 0.25) * smooth(0, 0.25, 1 - r1 / (2.7 * R + 0.001));   // calm at the rim
          }
          pos.setXYZ(i, x, y, z);
        }
        pos.needsUpdate = true; geo.computeVertexNormals();
        for (const a of dupes){ nrm.set(0, 0, 0); for (const i of a) nrm.x += nor.getX(i), nrm.y += nor.getY(i), nrm.z += nor.getZ(i); nrm.normalize(); for (const i of a) nor.setXYZ(i, nrm.x, nrm.y, nrm.z); }   // no seam
        nor.needsUpdate = true;
        return blob;
      }
      return {
        start(){ G.position.copy(P.anchor); G.visible = true; frame2 = 0; drops.forEach((q) => { q.m.visible = true; }); },
        update(lt, raw, t){
          // tilt the pool so it reflects the astronaut toward you: its normal halves the angle between camera and astronaut
          _mp.copy(camera.position).sub(G.position).normalize(); _ms.copy(astro.position).sub(G.position).normalize();
          G.quaternion.setFromUnitVectors(Yup, _mp.add(_ms).normalize());
          const blob = shape(lt, t);
          drops.forEach((q) => {
            const inK = smooth(q.arrive - 0.9, q.arrive, lt), outK = smooth(9.0, 10.8, lt);
            const dist = inK < 1 ? q.dist * (1 - easeIO(inK)) : outK * q.dist * 1.1;
            q.m.position.copy(q.d).multiplyScalar(dist + 0.0001);
            const s = q.r * (1 - inK) + q.r * outK * (1 - smooth(10.2, 11, lt));   // it melts into the pool, and is thrown out again at the end
            q.m.scale.setScalar(Math.max(0.001, s)); q.m.visible = s > 0.002;
          });
          sheen.material.opacity = 0.18 * blob;
          // refresh the reflection every other frame, without the mercury itself in it
          if ((frame2++ & 1) === 0){
            G.visible = false; mirrorCam.position.copy(G.position); mirrorCam.updateMatrixWorld();
            const sh = renderer.shadowMap.needsUpdate; renderer.shadowMap.needsUpdate = false;
            mirrorCam.update(renderer, scene); mirrorRT.texture.needsPMREMUpdate = true;
            renderer.shadowMap.needsUpdate = sh; G.visible = true;
          }
          momentFx.ca += 0.012 * smooth(2.0, 2.3, lt) * (1 - smooth(2.3, 3.0, lt));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Ojo de la tormenta', line: 'Un remolino gira al revés que todo lo demás.', dur: 9, make(P){
      const G = newGroup(), N = 600, pts = pointsOf(N, 0.12, HC(0.9, 1.8, 2.2)); G.add(pts.p);
      const seeds = []; for (let i = 0; i < N; i++) seeds.push({ r: 0.3 + Math.random() * 2.8, a: Math.random() * 6.28, z: Math.random() });
      const calm = sprite(novaCoreTex, HC(2.0, 2.4, 2.6)); calm.scale.setScalar(1.6); G.add(calm);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 9, 1.0, 1.2);
          seeds.forEach((s, i) => { s.a -= raw * (2.2 / s.r); s.r -= raw * 0.12; if (s.r < 0.3) s.r = 3.1; pts.pos.set([Math.cos(s.a) * s.r, Math.sin(s.a) * s.r, -(3.1 - s.r) * 0.6 + s.z * 0.3], i * 3); });
          pts.flush(); pts.mat.opacity = e; calm.material.opacity = e * (0.7 + 0.3 * Math.sin(t * 2));
          G.scale.setScalar(0.6 + 0.4 * e);
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Escalera de Penrose', line: 'Una escalera imposible: siempre sube y vuelve al inicio.', dur: 9.5, make(P){
      const G = newGroup(), N = 16, side = 4, half = 1.6, rise = 0.14;
      const stone = new THREE.MeshStandardMaterial({ color: C('#d8d2ff'), roughness: 0.6, emissive: C('#3a2a7a'), emissiveIntensity: 0.4, envMapIntensity: 0.8 });
      const corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
      const posOf = (k, out) => { const s = ((k % N) + N) % N, edge = Math.floor(s / side), f = (s % side) / side, p0 = corners[edge], p1 = corners[(edge + 1) % 4]; return out.set(lerp(p0[0], p1[0], f), 0, lerp(p0[1], p1[1], f)); };
      const topOf = (k) => -1 + 0.3 + (((k % N) + N) % N) * rise;
      for (let k = 0; k < N; k++){ const h = 0.3 + k * rise, m = new THREE.Mesh(roundedBox(0.8, h, 0.8, 0.03, 6, 2), stone); posOf(k, m.position); m.position.y = -1 + h / 2; G.add(m); }
      const walker = sprite(novaCoreTex, HC(2.4, 2.0, 1.2)); walker.scale.setScalar(0.5); G.add(walker);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.rotateX(0.75); G.visible = true; },
        update(lt, raw, t){
          const k = lt * 2.2, k0 = Math.floor(k), f = k - k0;
          posOf(k0, _mp); posOf(k0 + 1, _ms); walker.position.lerpVectors(_mp, _ms, f);
          walker.position.y = lerp(topOf(k0), topOf(k0 + 1), f) + 0.25 + 0.12 * Math.sin(f * Math.PI);
          G.rotateY(raw * 0.25); G.scale.setScalar(Math.max(0.001, env(lt, 9.5, 0.8, 1.0)));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Planeta bebé', line: 'El polvo se junta y nace un mundo diminuto.', dur: 9.5, make(P){
      const G = newGroup(), N = 420, dust = pointsOf(N, 0.09, HC(2.2, 1.4, 0.8)); G.add(dust.p);
      const seeds = []; for (let i = 0; i < N; i++) seeds.push({ r: 1 + Math.random() * 3.2, a: Math.random() * 6.28, y: (Math.random() - 0.5) * 0.8 });
      const planet = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 32), new THREE.MeshStandardMaterial({ color: C('#9a6a4a'), map: TX.rockColor, normalMap: TX.rockNormal, roughness: 0.9, emissive: C('#ff5a1a'), emissiveMap: TX.rockColor, emissiveIntensity: 3 }));
      G.add(planet);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.4, 96, 1), addMat(HC(1.4, 1.1, 0.8))); ring.rotation.x = 1.25; G.add(ring);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      return {
        start(){ a.copy(P.anchor); at(P, 4, 2.5, 6, b); G.position.copy(a); faceCam(G); G.rotateX(0.5); G.visible = true; },
        update(lt, raw, t){
          const pull = easeIO(smooth(0.3, 4.0, lt));
          seeds.forEach((s, i) => { s.a += raw * (0.6 + 2.0 / s.r); const r = s.r * (1 - pull * 0.95); dust.pos.set([Math.cos(s.a) * r, s.y * (1 - pull), Math.sin(s.a) * r], i * 3); });
          dust.flush(); dust.mat.opacity = 1 - smooth(3.5, 4.5, lt);
          planet.scale.setScalar(Math.max(0.001, easeIO(smooth(2.8, 4.6, lt)))); planet.rotation.y += raw * 0.8;
          planet.material.emissiveIntensity = 3 * (1 - smooth(4.5, 7.5, lt)) + 0.15;   // the molten crust cools down
          const rk = smooth(4.8, 6.0, lt); ring.scale.setScalar(Math.max(0.001, rk)); ring.material.opacity = 0.7 * rk;
          const go = easeIO(smooth(6.8, 9.5, lt)); G.position.lerpVectors(a, b, go); G.scale.setScalar(Math.max(0.001, 1 - go * 0.7));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Cometa', line: 'Un cometa cruza la garganta del túnel con su cola de colores.', dur: 6.5, make(P){
      const nucleus = new THREE.Mesh(rockGeos[3], rockMats[1]); nucleus.scale.setScalar(0.22); nucleus.visible = false; scene.add(nucleus);
      const coma = glow(HC(1.6, 2.2, 2.6), 2.2); coma.visible = false; scene.add(coma);
      const ion = pointsOf(90, 0.2, HC(0.6, 1.4, 2.6)), dustT = pointsOf(90, 0.24, HC(2.4, 1.6, 0.8)); ion.p.visible = dustT.p.visible = false; scene.add(ion.p, dustT.p);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), anti = new THREE.Vector3();
      const jit = []; for (let i = 0; i < 90; i++) jit.push([Math.random() - 0.5, Math.random() - 0.5]);
      return {
        start(){ at(P, -7, 3, 1, a); at(P, 7, -2.5, -1, b); dir.subVectors(b, a).normalize(); anti.copy(dir).negate().add(V(0, 0, 0.6)).normalize(); nucleus.visible = coma.visible = ion.p.visible = dustT.p.visible = true; },
        update(lt, raw, t){
          const n = nucleus.position; n.lerpVectors(a, b, lt / 6.5); coma.position.copy(n); nucleus.rotation.x += raw * 2;
          for (let i = 0; i < 90; i++){
            const d = i * 0.06, sp = i * 0.004;
            ion.pos.set([n.x + anti.x * d + jit[i][0] * sp, n.y + anti.y * d + jit[i][1] * sp, n.z + anti.z * d], i * 3);   // straight blue ion tail
            const dd = i * 0.05, sp2 = i * 0.003;
            dustT.pos.set([n.x - dir.x * dd + jit[i][0] * sp2, n.y - dir.y * dd + i * i * 0.0002 + jit[i][1] * sp2, n.z - dir.z * dd], i * 3);   // curved warm dust tail
          }
          ion.flush(); dustT.flush();
          const e = env(lt, 6.5, 0.5, 0.8); ion.mat.opacity = dustT.mat.opacity = coma.material.opacity = e;
        },
        end(){ nucleus.visible = coma.visible = ion.p.visible = dustT.p.visible = false; }
      };
    } },
    { name: 'Lluvia de meteoros', line: 'Una lluvia de estrellas fugaces del tamaño de tu casco.', dur: 7.5, make(P){
      const N = 50, segs = segsOf(N, HC(2.2, 2.0, 1.6)), heads = pointsOf(N, 0.16, HC(2.6, 2.4, 2.0)); segs.l.visible = heads.p.visible = false; scene.add(segs.l, heads.p);
      const m = [];
      const respawn = (s, lt) => { s.t0 = lt + Math.random() * 0.6; s.x = (Math.random() - 0.5) * 6; s.y = 2.5 + Math.random() * 1.5; s.d = (Math.random() - 0.5) * 2; s.v = 5 + Math.random() * 4; };
      for (let i = 0; i < N; i++){ const s = {}; respawn(s, 0); m.push(s); }
      return {
        start(){ segs.l.visible = heads.p.visible = true; m.forEach((s) => respawn(s, Math.random() * 1.5)); },
        update(lt, raw, t){
          m.forEach((s, i) => {
            if (lt - s.t0 > 0.9) respawn(s, lt);
            const age = lt - s.t0, live = age > 0 && lt < 6.8, d = Math.max(0, age) * s.v * 0.5;
            if (live){ at(P, s.x + 0.55 * d, s.y - d, s.d, _mp); at(P, s.x + 0.55 * (d - 0.35), s.y - (d - 0.35), s.d, _ms); } else { _mp.set(0, 1e4, 0); _ms.copy(_mp); }
            segs.pos.set([_ms.x, _ms.y, _ms.z, _mp.x, _mp.y, _mp.z], i * 6); heads.pos.set([_mp.x, _mp.y, _mp.z], i * 3);
          });
          segs.flush(); heads.flush(); segs.mat.opacity = heads.mat.opacity = env(lt, 7.5, 0.4, 0.8);
        },
        end(){ segs.l.visible = heads.p.visible = false; }
      };
    } },
    { name: 'Lluvia hacia arriba', line: 'Gotas de luz que caen… hacia arriba.', dur: 8, make(P){
      const N = 140, segs = segsOf(N, HC(0.7, 1.4, 2.6)); segs.l.visible = false; scene.add(segs.l);
      const splash = []; for (let i = 0; i < 10; i++){ const s = sprite(novaRingTex, HC(0.6, 1.4, 2.4)); s.visible = false; scene.add(s); splash.push({ s, t0: -9, x: 0, d: 0 }); }
      const drops = []; for (let i = 0; i < N; i++) drops.push({ x: (Math.random() - 0.5) * 7, d: (Math.random() - 0.5) * 3, ph: Math.random() * 6, v: 2.2 + Math.random() * 1.2, prev: 0 });
      let si = 0;
      return {
        start(){ segs.l.visible = true; splash.forEach((p) => { p.s.visible = true; p.t0 = -9; }); },
        update(lt, raw, t){
          const e = env(lt, 8, 0.8, 1.0);
          drops.forEach((q, i) => {
            const y = -3 + ((lt * q.v + q.ph) % 6);
            if (y < q.prev){ const p = splash[si++ % splash.length]; if (lt - p.t0 > 0.6){ p.t0 = lt; p.x = q.x; p.d = q.d; } }   // it reached the top: a ripple
            q.prev = y;
            at(P, q.x, y, q.d, _mp); at(P, q.x, y - 0.3, q.d, _ms); segs.pos.set([_ms.x, _ms.y, _ms.z, _mp.x, _mp.y, _mp.z], i * 6);
          });
          segs.flush(); segs.mat.opacity = 0.8 * e;
          splash.forEach((p) => { const k = (lt - p.t0) / 0.6; if (k < 0 || k > 1){ p.s.material.opacity = 0; return; } at(P, p.x, 3, p.d, p.s.position); p.s.scale.setScalar(0.2 + 0.8 * k); p.s.material.opacity = (1 - k) * e; });
        },
        end(){ segs.l.visible = false; splash.forEach((p) => { p.s.visible = false; }); }
      };
    } }
  ];

  /* ===== group 5 · signals ===== */
  const SIGNALS = [
    { name: 'Grieta a la Tierra', line: 'Por una grieta se ve Bogotá de noche, con Monserrate encendido.', dur: 9.5, make(P){
      const G = newGroup(), W = 768, H = 512, city = makeCanvas(W, H), cg = city.getContext('2d');
      { const sky = cg.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#060a1c'); sky.addColorStop(0.55, '#1b2350'); sky.addColorStop(0.75, '#3a2a4a'); cg.fillStyle = sky; cg.fillRect(0, 0, W, H);
        for (let i = 0; i < 120; i++){ cg.fillStyle = 'rgba(255,255,255,' + (0.3 + Math.random() * 0.6) + ')'; cg.fillRect(Math.random() * W, Math.random() * H * 0.4, 1.5, 1.5); }
        // the eastern hills, Monserrate the highest, with its white church lit on top and the cable car line
        cg.fillStyle = '#0a0d16'; cg.beginPath(); cg.moveTo(0, 300); cg.lineTo(90, 250); cg.lineTo(170, 215); cg.lineTo(250, 160); cg.lineTo(300, 150); cg.lineTo(360, 190); cg.lineTo(450, 175); cg.lineTo(540, 215); cg.lineTo(650, 230); cg.lineTo(W, 260); cg.lineTo(W, H); cg.lineTo(0, H); cg.fill();
        cg.fillStyle = '#fff6dc'; cg.shadowColor = '#ffe9a8'; cg.shadowBlur = 14; cg.fillRect(268, 138, 22, 12); cg.fillRect(276, 126, 6, 12); cg.shadowBlur = 0;
        cg.strokeStyle = 'rgba(255,220,150,0.6)'; cg.lineWidth = 1.5; cg.setLineDash([3, 5]); cg.beginPath(); cg.moveTo(279, 152); cg.lineTo(200, 300); cg.stroke(); cg.setLineDash([]);
        // the city spread over the savanna: warm lights denser toward the viewer, a few avenues
        for (let i = 0; i < 2600; i++){ const y = 300 + Math.pow(Math.random(), 0.7) * (H - 300), s = 0.8 + (y - 300) / 160; cg.fillStyle = Math.random() < 0.82 ? 'rgba(255,190,110,' + (0.5 + Math.random() * 0.5) + ')' : 'rgba(200,230,255,0.85)'; cg.fillRect(Math.random() * W, y, s, s); }
        cg.strokeStyle = 'rgba(255,170,80,0.75)'; cg.lineWidth = 2; for (let k = 0; k < 6; k++){ cg.beginPath(); cg.moveTo(Math.random() * W, H); cg.lineTo(330 + (Math.random() - 0.5) * 200, 300); cg.stroke(); }
        cg.fillStyle = '#ff3a2a'; [[520, 270], [560, 262], [600, 280]].forEach(([x, y]) => { cg.fillRect(x, y, 3, 3); });
      }
      const L = liveTex(W, H);
      G.add(new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshBasicMaterial({ map: L.tx, fog: false, transparent: true, depthWrite: false, side: THREE.DoubleSide })));
      let crack = [];
      const widthAt = (i, y, w) => w * (110 + 60 * Math.sin(i * 1.7)) * Math.sin(Math.PI * THREE.MathUtils.clamp(y / H, 0.05, 0.95));
      function draw(w){
        const g = L.g; g.clearRect(0, 0, W, H);
        if (w > 0.001){
          g.save(); g.beginPath();
          crack.forEach(([x, y], i) => { const ww = widthAt(i, y, w); if (i) g.lineTo(x - ww, y); else g.moveTo(x - ww, y); });
          for (let i = crack.length - 1; i >= 0; i--){ const [x, y] = crack[i]; g.lineTo(x + widthAt(i, y, w) * 0.8, y); }
          g.closePath();
          g.save(); g.clip(); g.drawImage(city, 0, 0); g.restore();
          g.strokeStyle = '#fff1d6'; g.shadowColor = '#ffb46a'; g.shadowBlur = 22; g.lineWidth = 4; g.stroke(); g.restore();
        }
        L.tx.needsUpdate = true;
      }
      let acc = 0;
      return {
        start(){ crack = []; for (let y = -20; y < H + 20; y += 30 + Math.random() * 40) crack.push([W / 2 + (Math.random() - 0.5) * 90, y]); G.position.copy(P.anchor); faceCam(G); G.visible = true; draw(0); },
        update(lt, raw, t){ const w = easeIO(smooth(0.4, 2.5, lt)) * (1 - easeIO(smooth(7.0, 9.0, lt))); acc += raw; if (acc > 1 / 30){ acc = 0; draw(w); } momentFx.ca += 0.02 * smooth(0.4, 0.8, lt) * (1 - smooth(0.8, 1.6, lt)); },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Mensaje en las estrellas', line: 'Las estrellas se ordenan para saludarte: «HOLA».', dur: 9, make(P){
      const G = newGroup(), T1 = textStars('HOLA', 6, HC(2.2, 2.2, 2.6)); G.add(T1.stars.p);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){ T1.update(smooth(0.5, 3.0, lt) * (1 - smooth(6.5, 8.5, lt)), t, env(lt, 9, 0.5, 0.6)); },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Coro de orbes', line: 'Siete esferas cantan una melodía de luz.', dur: 9, make(P){
      const G = newGroup(), orbs = [], melody = [0, 2, 4, 5, 4, 2, 0, 6, 4, 2, 1, 0];
      const baseY = (i) => Math.cos((i / 6 - 0.5) * 2.2) * 3 - 2.2;
      for (let i = 0; i < 7; i++){
        const c = new THREE.Color().setHSL(i / 7, 0.9, 0.55), x = Math.sin((i / 6 - 0.5) * 2.2) * 3;
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 16), lit(c.clone())); m.position.set(x, baseY(i), 0); G.add(m);
        const h = sprite(dotTex, c.clone()); h.position.copy(m.position); G.add(h);
        const r = sprite(novaRingTex, c.clone().multiplyScalar(1.6)); r.position.copy(m.position); G.add(r);
        orbs.push({ m, h, r, c, hit: -9 });
      }
      let lastBeat = -1;
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; lastBeat = -1; orbs.forEach((o) => { o.hit = -9; }); },
        update(lt, raw, t){
          const e = env(lt, 9, 0.6, 1.0), beat = Math.floor((lt - 0.8) / 0.45);
          if (beat >= 0 && beat !== lastBeat){ lastBeat = beat; if (beat < melody.length) orbs[melody[beat]].hit = lt; else if (beat === melody.length + 1) orbs.forEach((o) => { o.hit = lt; }); }   // the melody, then a chord
          orbs.forEach((o, i) => {
            const k = Math.max(0, 1 - (lt - o.hit) / 0.6), rk = Math.min(1, (lt - o.hit) / 0.8);
            o.m.material.color.copy(o.c).multiplyScalar(0.5 + 3 * k); o.h.scale.setScalar((0.8 + 2.2 * k) * e); o.h.material.opacity = (0.3 + 0.7 * k) * e;
            o.r.scale.setScalar(0.6 + 2.5 * rk); o.r.material.opacity = (1 - rk) * e;
            o.m.position.y = o.h.position.y = o.r.position.y = baseY(i) + 0.08 * Math.sin(t * 2 + i);
          });
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Huellas en la nada', line: 'Alguien caminó por aquí… donde no hay suelo.', dur: 9, make(P){
      const G = newGroup();
      const boot = texOf(128, 256, (g) => { g.fillStyle = '#bff6ff'; g.shadowColor = '#5ce1ff'; g.shadowBlur = 14; g.beginPath(); g.ellipse(64, 80, 40, 62, 0, 0, Math.PI * 2); g.fill(); g.beginPath(); g.ellipse(64, 200, 32, 40, 0, 0, Math.PI * 2); g.fill(); g.globalCompositeOperation = 'destination-out'; for (let y = 40; y < 240; y += 22) g.fillRect(20, y, 88, 7); });
      const steps = [];
      for (let i = 0; i < 14; i++){
        const side = i % 2 ? 1 : -1, m = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.84), addMat(HC(1.4, 1.8, 2.2), boot));
        m.position.set(-3.2 + i * 0.5, Math.sin(i * 0.5) * 0.8 + side * 0.22, 0); m.rotation.z = -Math.PI / 2 + Math.atan(0.8 * Math.cos(i * 0.5));
        G.add(m); steps.push(m);
      }
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.rotateX(-0.9); G.visible = true; },
        update(lt, raw, t){ steps.forEach((m, i) => { const ti = 0.6 + i * 0.45; m.material.opacity = smooth(ti, ti + 0.15, lt) * (1 - smooth(ti + 2.5, ti + 4.0, lt)); }); },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Duplicado de la nave', line: 'Aparecen dos naves idénticas. ¿Cuál es la real?', dur: 9, make(P){
      const { c: twin } = cloneClean(ship); twin.visible = false; scene.add(twin);
      const a = new THREE.Vector3();
      return {
        start(){ at(P, 0, 0, 3, a); twin.visible = true; },
        update(lt, raw, t){
          twin.position.copy(a).addScaledVector(P.right, 1.5 * Math.sin(lt * 0.6)).addScaledVector(P.up, 0.5 * Math.sin(lt * 0.9));
          twin.rotation.set(-0.42 + 0.05 * Math.sin(t * 0.13), 0.35 + 0.3 * Math.sin(lt * 0.5), 0.3 + 0.12 * Math.sin(t * 0.1));
          const glitch = lt > 6.5 && !reduceMotion ? (Math.sin(t * 47) > 0 ? 1 : 0) : 0;
          twin.scale.setScalar(0.55 * Math.max(0.001, env(lt, 9, 1.0, 1.4)) * (1 + 0.15 * glitch));
          momentFx.ca += 0.03 * glitch;
        },
        end(){ twin.visible = false; }
      };
    } },
    { name: 'Señal de radio', line: 'Una transmisión desconocida late desde el fondo del túnel.', dur: 9, make(P){
      const G = newGroup(), src = sprite(novaCoreTex, HC(2.4, 1.2, 2.4)); src.scale.setScalar(1.2); G.add(src);
      const waves = []; for (let i = 0; i < 6; i++){ const r = sprite(novaRingTex, HC(1.6, 0.8, 2.2)); G.add(r); waves.push(r); }
      const N = 160, wgeo = new THREE.BufferGeometry(); wgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      const wave = new THREE.Line(wgeo, new THREE.LineBasicMaterial({ color: HC(1.4, 2.2, 1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); wave.frustumCulled = false; G.add(wave);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 9, 0.6, 1.0);
          waves.forEach((r, i) => { const k = (lt * 0.5 + i / 6) % 1; r.scale.setScalar(0.5 + 7 * k); r.material.opacity = (1 - k) * e * 0.8; });
          const arr = wgeo.attributes.position.array;
          for (let i = 0; i < N; i++){ const x = -3 + i / (N - 1) * 6, burst = Math.max(0, Math.sin(x * 1.2 - lt * 3)); arr[i * 3] = x; arr[i * 3 + 1] = -2.2 + Math.sin(x * 9 - lt * 12) * 0.35 * burst * burst; arr[i * 3 + 2] = 0; }
          wgeo.attributes.position.needsUpdate = true; wave.material.opacity = e;
          src.material.opacity = e * (0.6 + 0.4 * Math.max(0, Math.sin(lt * 6)));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Laberinto de luz', line: 'Un laberinto de cristal se alza… y una chispa encuentra la salida.', dur: 12.5, make(P){
      const G = newGroup(), n = 11, cell = 0.42, size = n * cell, WALL_H = 0.42, THICK = 0.06, MAXW = 2 * n * (n + 1);
      // neon glass walls: dark glassy body, bright edges, a light band sweeping upward
      const wallGeo = new THREE.BoxGeometry(1, 1, 1);
      const seeds = new Float32Array(MAXW); for (let i = 0; i < MAXW; i++) seeds[i] = Math.random();
      wallGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      const wallMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uFlash: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `attribute float aSeed; varying vec3 vL; varying vec3 vN; varying vec3 vV; varying float vSeed;
          void main(){
            vSeed = aSeed; vL = position;
            vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
            vV = -mv.xyz; vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `uniform float uTime, uFade, uFlash; varying vec3 vL; varying vec3 vN; varying vec3 vV; varying float vSeed;
          void main(){
            vec3 a = abs(vL) * 2.0;
            float ex = smoothstep(0.86, 1.0, a.x), ey = smoothstep(0.86, 1.0, a.y), ez = smoothstep(0.7, 1.0, a.z);
            float edge = max(max(ex * ey, ey * ez), ex * ez);
            float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
            float h = vL.y + 0.5;
            float band = exp(-pow(h - fract(uTime * 0.55 + vSeed), 2.0) * 120.0);
            vec3 tint = mix(vec3(0.25, 0.9, 1.6), vec3(1.0, 0.45, 1.8), vSeed);
            vec3 c = tint * (0.025 + 0.12 * f + 0.75 * edge + 0.35 * band + 0.2 * pow(h, 6.0)) + vec3(0.7, 0.75, 0.85) * uFlash;
            gl_FragColor = vec4(c * uFade, 1.0);
          }`
      });
      const walls = new THREE.InstancedMesh(wallGeo, wallMat, MAXW); walls.frustumCulled = false; G.add(walls);
      // floor: a faint grid that lights up under the spark
      const floorMat = new THREE.ShaderMaterial({
        uniforms: { uFade: { value: 0 }, uOrb: { value: new THREE.Vector2(99, 99) }, uCell: { value: cell }, uHalf: { value: size / 2 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uFade, uCell, uHalf; uniform vec2 uOrb; varying vec2 vP;
          void main(){
            vec2 g = abs(fract((vP + uHalf) / uCell + 0.5) - 0.5);
            float line = exp(-min(g.x, g.y) * 40.0);
            float fade = 1.0 - smoothstep(uHalf * 0.75, uHalf * 1.25, max(abs(vP.x), abs(vP.y)));
            float pool = exp(-dot(vP - uOrb, vP - uOrb) * 6.0);
            vec3 c = vec3(0.2, 0.6, 1.2) * line * 0.35 * fade + vec3(2.2, 1.5, 0.6) * pool * 0.6;
            gl_FragColor = vec4(c * uFade, 1.0);
          }`
      });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.3, size * 1.3).rotateX(-Math.PI / 2), floorMat); floor.position.y = -0.002; G.add(floor);
      // the spark that solves it, with a golden ribbon of light behind
      const orb = sprite(novaCoreTex, HC(2.6, 1.9, 0.8)); orb.scale.setScalar(0.55); G.add(orb);
      const orbHalo = sprite(dotTex, HC(2.0, 1.2, 0.4)); orbHalo.scale.setScalar(1.4); G.add(orbHalo);
      const TRAIL = 260, trail = pointsOf(TRAIL, 0.09, HC(2.6, 1.7, 0.6)); G.add(trail.p);
      const exitRing = sprite(novaRingTex, HC(0.8, 2.4, 1.6)); G.add(exitRing);
      const startGlow = sprite(dotTex, HC(0.6, 1.8, 2.4)); G.add(startGlow);
      // when it is solved the walls rise as sparks
      const DUST = 360, dust = pointsOf(DUST, 0.07, HC(1.2, 1.8, 2.6)); G.add(dust.p);
      const dustSeed = new Float32Array(DUST * 4);
      const dummy = new THREE.Object3D();
      let wallList = [], route = [], routeLen = [], total = 0;
      function build(){
        const seen = new Uint8Array(n * n), right = new Uint8Array(n * n).fill(1), down = new Uint8Array(n * n).fill(1), prev = new Int32Array(n * n).fill(-1), stack = [0];
        seen[0] = 1;
        while (stack.length){   // depth-first maze carving
          const c = stack[stack.length - 1], x = c % n, y = (c / n) | 0, nb = [];
          if (x > 0 && !seen[c - 1]) nb.push(c - 1); if (x < n - 1 && !seen[c + 1]) nb.push(c + 1);
          if (y > 0 && !seen[c - n]) nb.push(c - n); if (y < n - 1 && !seen[c + n]) nb.push(c + n);
          if (!nb.length){ stack.pop(); continue; }
          const k = nb[(Math.random() * nb.length) | 0];
          if (k === c + 1) right[c] = 0; else if (k === c - 1) right[k] = 0; else if (k === c + n) down[c] = 0; else down[k] = 0;
          seen[k] = 1; prev[k] = c; stack.push(k);
        }
        const X = (i) => -size / 2 + i * cell, Z = (j) => -size / 2 + j * cell;
        wallList = [];
        const push = (x0, z0, x1, z1) => { const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2; wallList.push({ cx, cz, len: Math.hypot(x1 - x0, z1 - z0) + THICK, rot: x0 === x1 ? Math.PI / 2 : 0, t0: 0.4 + Math.hypot(cx, cz) * 0.45 + Math.random() * 0.25 }); };
        for (let i = 0; i < n; i++){ if (i > 0) push(X(i), Z(0), X(i + 1), Z(0)); push(X(i), Z(n), X(i + 1), Z(n)); }   // top edge (open at the entrance) and bottom edge
        for (let j = 0; j < n; j++){ push(X(0), Z(j), X(0), Z(j + 1)); }
        for (let c = 0; c < n * n; c++){
          const x = c % n, y = (c / n) | 0;
          if (right[c] && x < n - 1) push(X(x + 1), Z(y), X(x + 1), Z(y + 1));
          if (down[c] && y < n - 1) push(X(x), Z(y + 1), X(x + 1), Z(y + 1));
        }
        for (let j = 0; j < n - 1; j++) push(X(n), Z(j), X(n), Z(j + 1));   // right edge, open at the exit
        route = [];
        route.push([X(0) + cell / 2, Z(0) - cell * 0.8]);   // walk in from outside
        const cells = []; for (let c = n * n - 1; c !== -1; c = prev[c]) cells.unshift(c);
        cells.forEach((c) => route.push([X(c % n) + cell / 2, Z((c / n) | 0) + cell / 2]));
        route.push([X(n) + cell * 0.8, Z(n - 1) + cell / 2]);   // and out through the exit
        routeLen = [0]; total = 0;
        for (let i = 1; i < route.length; i++){ total += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]); routeLen.push(total); }
        for (let i = 0; i < DUST; i++){ const w = wallList[(Math.random() * wallList.length) | 0]; dustSeed[i * 4] = w.cx + (Math.random() - 0.5) * w.len * (w.rot ? 0.1 : 1); dustSeed[i * 4 + 1] = w.cz + (Math.random() - 0.5) * w.len * (w.rot ? 1 : 0.1); dustSeed[i * 4 + 2] = Math.random() * WALL_H; dustSeed[i * 4 + 3] = 0.6 + Math.random() * 1.4; }
        exitRing.position.set(route[route.length - 1][0], 0.2, route[route.length - 1][1]);
        startGlow.position.set(route[0][0], 0.15, route[0][1]);
      }
      const along = (d, out) => {   // a point at distance d along the solved route
        let i = 1; while (i < routeLen.length - 1 && routeLen[i] < d) i++;
        const k = THREE.MathUtils.clamp((d - routeLen[i - 1]) / Math.max(1e-6, routeLen[i] - routeLen[i - 1]), 0, 1);
        return out.set(lerp(route[i - 1][0], route[i][0], k), 0.17, lerp(route[i - 1][1], route[i][1], k));
      };
      return {
        start(){ build(); G.position.copy(P.anchor); faceCam(G); G.rotateX(1.0); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 12.5, 0.4, 1.2), solved = smooth(9.6, 9.9, lt), melt = smooth(9.8, 12.0, lt);
          wallMat.uniforms.uTime.value = t; wallMat.uniforms.uFade.value = e * (1 - melt); wallMat.uniforms.uFlash.value = solved * (1 - smooth(9.9, 10.8, lt));
          floorMat.uniforms.uFade.value = e;
          // the walls rise in a wave from the centre outward
          wallList.forEach((w, i) => {
            const h = WALL_H * easeIO(smooth(w.t0, w.t0 + 0.6, lt)) * (1 + 0.6 * melt);
            dummy.position.set(w.cx, h / 2 + melt * w.t0 * 0.6, w.cz); dummy.rotation.set(0, w.rot, 0); dummy.scale.set(w.len, Math.max(0.0001, h), THICK);
            dummy.updateMatrix(); walls.setMatrixAt(i, dummy.matrix);
          });
          for (let i = wallList.length; i < MAXW; i++){ dummy.scale.set(0, 0, 0); dummy.updateMatrix(); walls.setMatrixAt(i, dummy.matrix); }
          walls.instanceMatrix.needsUpdate = true;
          // the spark: it hesitates at the start, then runs the corridors and leaves through the exit
          const run = easeIO(smooth(3.6, 9.6, lt)) * total;
          along(run, orb.position); orbHalo.position.copy(orb.position);
          const on = smooth(3.2, 3.6, lt) * (1 - smooth(10.4, 11.2, lt));
          orb.material.opacity = on; orbHalo.material.opacity = 0.6 * on; orb.scale.setScalar(0.45 + 0.1 * Math.sin(t * 20));
          floorMat.uniforms.uOrb.value.set(orb.position.x, orb.position.z);
          for (let i = 0; i < TRAIL; i++){ along(Math.max(0, run - i * 0.03), _mp); trail.pos.set([_mp.x, _mp.y - 0.04 * (i / TRAIL), _mp.z], i * 3); }
          trail.flush(); trail.mat.opacity = on * 0.9;
          exitRing.scale.setScalar(0.6 + 0.3 * Math.sin(t * 4) + 2.5 * solved); exitRing.material.opacity = e * (0.5 + 0.5 * solved) * (1 - melt);
          startGlow.scale.setScalar(0.7 + 0.2 * Math.sin(t * 3)); startGlow.material.opacity = e * (1 - smooth(3.6, 5.0, lt)) * 0.8;
          // the solved maze dissolves into rising sparks
          for (let i = 0; i < DUST; i++){ const k = melt * dustSeed[i * 4 + 3]; dust.pos.set([dustSeed[i * 4], melt > 0 ? dustSeed[i * 4 + 2] + k * 2.2 : 1e4, dustSeed[i * 4 + 1]], i * 3); }
          dust.flush(); dust.mat.opacity = Math.min(1, melt * 3) * (1 - smooth(11.4, 12.4, lt));
          momentFx.ca += 0.03 * solved * (1 - smooth(9.9, 10.6, lt));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Concierto de púlsares', line: 'Cinco estrellas laten al ritmo de un corazón.', dur: 9, make(P){
      const G = newGroup(), stars = [];
      for (let i = 0; i < 5; i++){
        const g = new THREE.Group(), a = i / 5 * Math.PI * 2; g.position.set(Math.cos(a) * 2.4, Math.sin(a) * 2.0, (Math.random() - 0.5) * 1.5); G.add(g);
        const core = sprite(novaCoreTex, HC(1.8, 1.9, 2.6)); g.add(core);
        const beams = new THREE.Group(); beams.rotation.x = 0.6; g.add(beams);
        for (const s of [0, Math.PI]){ const geo = new THREE.ConeGeometry(0.18, 2.6, 16, 1, true); geo.translate(0, -1.3, 0); const cn = new THREE.Mesh(geo, addMat(HC(0.4, 0.6, 1.2))); cn.rotation.z = s; beams.add(cn); }
        stars.push({ core, beams, sp: 1.5 + i * 0.4 });
      }
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 9, 0.6, 1.0), bt = (lt % 0.83) / 0.83;   // 72 beats per minute
          const lub = Math.exp(-bt * 30) + (bt > 0.18 ? 0.7 * Math.exp(-(bt - 0.18) * 30) : 0);   // lub… dub
          stars.forEach((s) => { s.beams.rotation.z += raw * s.sp; s.core.scale.setScalar((0.8 + 2.0 * lub) * e); s.core.material.opacity = (0.4 + 0.6 * lub) * e; s.beams.children.forEach((c) => { c.material.opacity = (0.3 + 0.7 * lub) * e; }); });
          momentFx.ca += 0.008 * lub * e;
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Estás aquí', line: 'Las estrellas escriben tu lugar en el cosmos: «Estás aquí».', dur: 9, make(P){
      const G = newGroup(), T1 = textStars('ESTÁS AQUÍ', 7, HC(2.4, 2.0, 1.2)); G.add(T1.stars.p);
      const arrow = segsOf(3, HC(2.4, 2.0, 1.2)); arrow.l.visible = false; scene.add(arrow.l);
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = arrow.l.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 9, 0.5, 0.6); T1.update(smooth(0.5, 3.0, lt) * (1 - smooth(6.8, 8.6, lt)), t, e);
          // a line drawn from the words down to the astronaut, with an arrowhead
          const ak = smooth(3.0, 4.5, lt); at(P, 0, -1.0, 0, _mp); _ms.lerpVectors(_mp, astro.position, 0.85 * ak);
          _mv.subVectors(_mp, _ms).normalize().multiplyScalar(0.4); _mto.crossVectors(_mv, P.out).normalize().multiplyScalar(0.25);
          arrow.pos.set([_mp.x, _mp.y, _mp.z, _ms.x, _ms.y, _ms.z,
            _ms.x, _ms.y, _ms.z, _ms.x + _mv.x + _mto.x, _ms.y + _mv.y + _mto.y, _ms.z + _mv.z + _mto.z,
            _ms.x, _ms.y, _ms.z, _ms.x + _mv.x - _mto.x, _ms.y + _mv.y - _mto.y, _ms.z + _mv.z - _mto.z]);
          arrow.flush(); arrow.mat.opacity = ak * e;
        },
        end(){ G.visible = arrow.l.visible = false; }
      };
    } },
    { name: 'Salida del agujero', line: 'Por un segundo se ve el otro lado del puente.', dur: 8.5, make(P){
      const G = newGroup();
      const other = texOf(512, 512, (g) => {
        const sky = g.createRadialGradient(256, 300, 20, 256, 256, 360); sky.addColorStop(0, '#9fe8ff'); sky.addColorStop(0.5, '#2b6fb3'); sky.addColorStop(1, '#0b1b3a'); g.fillStyle = sky; g.fillRect(0, 0, 512, 512);
        for (let i = 0; i < 200; i++){ g.fillStyle = 'rgba(255,255,255,' + Math.random() + ')'; g.fillRect(Math.random() * 512, Math.random() * 512, 1.5, 1.5); }
        const pl = g.createRadialGradient(220, 230, 10, 256, 256, 110); pl.addColorStop(0, '#ffe7c2'); pl.addColorStop(0.6, '#d9885a'); pl.addColorStop(1, '#5a2e3a'); g.fillStyle = pl; g.beginPath(); g.arc(256, 260, 100, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(255,230,200,0.75)'; g.lineWidth = 6; g.beginPath(); g.ellipse(256, 262, 180, 40, -0.25, 0, Math.PI * 2); g.stroke();
        g.globalCompositeOperation = 'destination-in'; const m = g.createRadialGradient(256, 256, 210, 256, 256, 256); m.addColorStop(0, '#000'); m.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = m; g.fillRect(0, 0, 512, 512);
      });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(2.0, 64), new THREE.MeshBasicMaterial({ map: other, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide })); G.add(disc);
      G.add(new THREE.Mesh(new THREE.TorusGeometry(2.02, 0.07, 10, 96), lit(HC(3, 3, 3))));
      const rays = new THREE.Group(); G.add(rays);
      for (let i = 0; i < 14; i++){ const geo = new THREE.PlaneGeometry(0.12, 6); geo.translate(0, 5.1, 0); const r = new THREE.Mesh(geo, addMat(HC(1.6, 1.8, 2.0))); r.rotation.z = i / 14 * Math.PI * 2; rays.add(r); }
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.visible = true; },
        update(lt, raw, t){
          const open = easeIO(smooth(0.6, 2.2, lt)) * (1 - easeIO(smooth(6.4, 8.2, lt)));
          G.scale.setScalar(Math.max(0.001, open)); disc.material.opacity = open; rays.rotateZ(raw * 0.2);
          rays.children.forEach((r, i) => { r.material.opacity = open * (0.25 + 0.2 * Math.sin(t * 3 + i)); });
          const fl = smooth(0.6, 0.9, lt) * (1 - smooth(0.9, 2.0, lt)); momentFx.dim -= 0.6 * fl; momentFx.ca += 0.03 * fl;   // a flash of light from the other side
        },
        end(){ G.visible = false; }
      };
    } }
  ];

  /* ===== the five activation points ===== */
  const LIFT = THREE.MathUtils.degToRad(12);   // how far above the centre of the view the events appear
  const points = [
    { theta: 0.9, phi: 0.7, dist: 8, color: HC(0.5, 1.4, 2.0), defs: TIME },             // in front, down and to the left (mirrors the physics point)
    { theta: 1.75, phi: 1.75, dist: 10, color: HC(2.0, 0.5, 1.6), defs: CREATURES },      // left, a little up
    { theta: -1.5, phi: 1.7, dist: 7, color: HC(0.6, 2.2, 1.2), defs: VISITORS },         // right
    { theta: -0.9, phi: 0.7, dist: 8, color: HC(2.2, 1.3, 0.6), defs: PHYSICS },          // down and to the right
    { theta: 0.75, phi: 2.1, dist: 9, color: HC(1.6, 1.6, 2.4), defs: SIGNALS }           // up and to the left
  ].map((d) => {
    const out = viewDir(d.theta, d.phi), right = new THREE.Vector3().crossVectors(out, V(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(right, out).normalize();
    // the events sit a little above the astronaut, so the astronaut never hides them
    const anchor = MT.clone().addScaledVector(out, d.dist).addScaledVector(up, (d.dist + 4.15) * Math.tan(LIFT)), glint = sprite(novaCoreTex, d.color);
    glint.position.copy(anchor); scene.add(glint);
    const ring = sprite(novaRingTex, d.color.clone().multiplyScalar(0.8)); ring.position.copy(anchor); scene.add(ring);
    const aura = sprite(nebulaTex, d.color.clone().multiplyScalar(0.45)); aura.position.copy(anchor).addScaledVector(out, 2); aura.visible = false; scene.add(aura);
    return { anchor, out, right, up, color: d.color, ring, aura, defs: d.defs, bag: shuffle(d.defs.map((_, i) => i).slice(1)), last: 0, first: true, glint, glint0: 0.11 * (d.dist + 4), state: 'idle', time: 0, dwell: 0, cur: null, ph: Math.random() * 6.28 };
  });
  function nextIndex(p){
    if (!p.bag.length){
      p.bag = shuffle(p.defs.map((_, i) => i));
      const n = p.bag.length; if (n > 1 && p.bag[n - 1] === p.last){ const x = p.bag[0]; p.bag[0] = p.bag[n - 1]; p.bag[n - 1] = x; }   // never the same twice in a row
    }
    return p.bag.pop();
  }
  let toastTimer = 0, toastHide = 0;
  function toast(def){
    const el = MUI.toast; if (!el) return;
    el.querySelector('strong').textContent = def.name; el.querySelector('span').textContent = def.line;
    el.hidden = false; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(toastTimer); clearTimeout(toastHide);
    toastTimer = setTimeout(() => { el.classList.remove('show'); toastHide = setTimeout(() => { el.hidden = true; }, 400); }, 4500);
  }
  function playPoint(p, idx){
    const i = idx != null ? idx : p.first ? 0 : nextIndex(p), def = p.defs[i];
    p.first = false;
    p.last = i;
    try { if (!def.inst) def.inst = def.make(p, def); def.inst.start(); }
    catch (err){ console.error(err); p.state = 'spent'; p.glint.visible = false; return; }
    p.cur = def; p.state = 'on'; p.time = 0; p.dwell = 0; p.glint.visible = false;
    points.forEach((q) => { if (q !== p && q.state === 'spent') q.state = 'idle'; });   // activating a point brings the spent ones back
    toast(def);
    fireBurst(p); astroReact(def, p);
  }
  const GAZE = Math.cos(THREE.MathUtils.degToRad(12)), DWELL = 0.5;
  function updateMoments(raw, t){
    recordPose(performance.now() / 1000);
    momentFx.ca = 0; momentFx.lensK = 0; momentFx.freeze = 0; momentFx.tintA = 0; momentFx.dim = 0;
    camera.updateMatrixWorld(); camera.getWorldDirection(_mf);
    _mv.set(0, 1, 0).applyQuaternion(camera.quaternion); _mf.multiplyScalar(Math.cos(LIFT)).addScaledVector(_mv, Math.sin(LIFT)).normalize();   // the sweet spot, just above the astronaut
    for (const p of points){
      if (p.state === 'on'){
        p.ring.visible = false;
        p.time += raw;
        try { p.cur.inst.update(p.time, raw, t); } catch (err){ console.error(err); p.time = p.cur.dur; }
        if (p.time >= p.cur.dur){ try { p.cur.inst.end(); } catch (err){ console.error(err); } p.state = 'spent'; }
        continue;
      }
      if (p.state === 'spent'){ p.glint.visible = p.ring.visible = false; continue; }
      const s = _mto.copy(p.anchor).sub(camera.position).normalize().dot(_mf), near = smooth(GAZE - 0.08, GAZE, s);
      p.dwell = s > GAZE ? p.dwell + raw : Math.max(0, p.dwell - raw * 2);
      if (p.dwell >= DWELL){ playPoint(p); continue; }
      const g = p.glint, pulse = 0.5 + 0.5 * Math.sin(t * 2.6 + p.ph);
      g.visible = true;
      g.material.opacity = Math.min(1, 0.035 + 0.045 * pulse + 0.5 * near);
      g.scale.setScalar(p.glint0 * (0.28 + 0.08 * pulse + 0.7 * near + 1.1 * p.dwell / DWELL));
      p.ring.visible = near > 0.01; p.ring.material.opacity = 0.22 * near; p.ring.material.rotation += raw * 0.6;
      p.ring.scale.setScalar(p.glint0 * (1.6 + 0.2 * Math.sin(t * 1.7 + p.ph) + 1.2 * near - 0.8 * p.dwell / DWELL));   // the ring closes in while you hold the gaze
    }
    stepFx(raw, t);
  }
  /* ===== the astronaut reacts to every event ===== */
  // gestures in body space (+Y head, +Z belly, +X the astronaut's left); s is the side the event is on, d points at it
  const _rv = new THREE.Vector3(), _rw = new THREE.Vector3();
  const N3 = (x, y, z) => V(x, y, z).normalize();
  const ARM = (s, u, f, c, w) => ({ u: N3(s * u[0], u[1], u[2]), f: N3(s * f[0], f[1], f[2]), c, w });
  const LEG = (s, u, f, w) => ({ u: N3(s * u[0], u[1], u[2]), f: N3(s * f[0], f[1], f[2]), w });
  const relaxedArm = (s) => ARM(s, [0.45, -0.75, -0.25], [0.35, -0.8, 0.1], 0.4, 0.1);
  const legsRelaxed = (t) => ({ 1: LEG(1, [0.1, -1, 0.12 + 0.08 * Math.sin(t * 3)], [0.08, -1, -0.1 + 0.1 * Math.sin(t * 3 - 0.8)], 0.5), '-1': LEG(-1, [0.1, -1, 0.12 + 0.08 * Math.sin(t * 3 + Math.PI)], [0.08, -1, -0.1 + 0.1 * Math.sin(t * 3 - 0.8 + Math.PI)], 0.5) });
  const legsSym = (u, f, w) => ({ 1: LEG(1, u, f, w), '-1': LEG(-1, u, f, w) });
  const armsSym = (u, f, c, w) => ({ 1: ARM(1, u, f, c, w), '-1': ARM(-1, u, f, c, w) });
  const pair = (s, near, far) => (s > 0 ? { 1: near, '-1': far } : { 1: far, '-1': near });
  const reachArm = (s, d, c, w, spread) => ({ u: N3(d.x + s * (spread || 0), d.y, d.z), f: N3(d.x + s * (spread || 0) * 0.6, d.y + 0.05, d.z), c, w });
  const twistTo = (d, amt) => THREE.MathUtils.clamp(Math.atan2(d.x, d.z) * amt, -0.55, 0.55);
  const pose = (k, waist, arm, leg) => ({ k, waist, arm, leg });
  const GEST = {
    reach: ({ s, d, t }) => pose(12, [-0.05, twistTo(d, 0.4), 0], pair(s, reachArm(s, d, 0.1 + 0.15 * Math.sin(t * 5), -0.3), relaxedArm(-s)), legsRelaxed(t)),
    reachBoth: ({ d, t }) => pose(10, [-0.15, twistTo(d, 0.3), 0], { 1: reachArm(1, d, 0.05, -0.35, 0.18), '-1': reachArm(-1, d, 0.05, -0.35, 0.18) }, legsRelaxed(t)),
    point: ({ s, d, t }) => pose(16, [0, twistTo(d, 0.45), 0], pair(s, reachArm(s, d, 1, 0), ARM(-s, [0.2, -0.3, 0.9], [-0.6, 0.5, 0.5], 0.6, 0.2)), legsRelaxed(t)),
    helmet: () => pose(18, [0.12, 0, 0], armsSym([0.8, 0.45, 0.35], [-0.55, 0.75, 0.35], 0.25, 0.2), legsSym([0.12, -0.9, 0.3], [0.08, -0.9, -0.35], 0.4)),   // hands on the helmet
    cover: () => POSES.brace,
    shield: ({ s, d }) => pose(22, [0.2, twistTo(d, -0.3), 0], pair(s, ARM(s, [0.3, 0.1, 0.95], [-0.45, 0.8, 0.35], 0.85, 0.4), ARM(-s, [0.7, -0.4, -0.55], [0.5, -0.5, -0.7], 0.3, -0.2)), legsSym([0.15, -0.6, 0.75], [0.1, -0.95, -0.25], 0.2)),
    recoil: () => pose(26, [-0.32, 0, 0], armsSym([0.8, 0.2, -0.55], [0.4, 0.6, -0.7], 0.05, -0.45), legsSym([0.15, -0.5, 0.85], [0.1, -0.95, -0.3], 0.2)),
    fetal: () => pose(18, [0.55, 0, 0], armsSym([0.3, -0.3, 0.9], [-0.6, -0.4, 0.7], 0.95, 0.4), legsSym([0.12, -0.15, 1], [0.05, -1, 0.05], 0.1)),
    star: () => pose(8, [-0.22, 0, 0], armsSym([0.95, 0.3, 0.05], [0.7, 0.7, 0.1], 0.05, -0.25), legsSym([0.5, -0.85, 0], [0.45, -0.9, 0], 0.65)),
    wave: ({ s, d, t, o }) => pose(14, [0, twistTo(d, 0.4), 0], pair(s, ARM(s, [0.7, 0.7, 0.15], [0.3 + 0.45 * Math.sin(t * (o.speed || 8)), 1, 0.15], 0.05, 0), relaxedArm(-s)), legsRelaxed(t)),
    salute: ({ s, d }) => pose(20, [0, twistTo(d, 0.5), 0], pair(s, ARM(s, [0.75, 0.35, 0.55], [-0.6, 0.65, 0.45], 0, -0.2), ARM(-s, [0.15, -1, 0], [0.12, -1, 0.05], 0.5, 0)), legsSym([0.04, -1, 0], [0.03, -1, 0], 0.85)),
    tap: ({ s, t }) => pose(24, [0.08, 0, 0], pair(s, ARM(s, [0.4, 0.2, 0.9], [-0.3, 0.8 + 0.25 * Math.sin(t * 11), 0.5], 0.6, 0.1), ARM(-s, [0.5, -0.3, 0.5], [-0.2, 0.3, 0.9], 0.5, 0.2)), legsRelaxed(t)),   // knocks on the visor
    hug: () => pose(16, [0.3, 0, 0], armsSym([0.35, -0.35, 0.85], [-0.95, 0.15, 0.25], 0.7, 0.3), legsSym([0.06, -0.8, 0.45], [0.04, -0.9, -0.4], 0.3)),
    duck: () => pose(22, [0.38, 0, 0], armsSym([0.55, 0.75, 0.35], [-0.75, 0.45, 0.45], 0.8, 0.3), legsSym([0.15, -0.35, 0.9], [0.1, -1, -0.1], 0.2)),
    clap: ({ t }) => pose(26, [0.05, 0, 0], armsSym([0.25, 0.15, 0.95], [-(0.35 + 0.3 * Math.sin(t * 9)), 0.2, 0.9], 0.1, -0.1), legsRelaxed(t)),
    flee: ({ t }) => {   // frantic crawl, much faster than the normal stroke
      const A = {}, L = {};
      for (const s of [1, -1]){
        A[s] = { u: new THREE.Vector3(), f: new THREE.Vector3(), c: 0, w: 0 }; crawlKey((t * 7 + (s > 0 ? 0 : Math.PI)) % (Math.PI * 2), s, A[s]);
        const ph = s > 0 ? 0 : Math.PI; L[s] = LEG(s, [0.07, -1, 0.04 + 0.2 * Math.sin(t * 16 + ph)], [0.05, -1, -0.03 + 0.3 * Math.sin(t * 16 - 0.9 + ph)], 0.9);
      }
      return pose(28, [0, 0.15 * Math.sin(t * 7), 0], A, L);
    },
    look: ({ t }) => pose(10, [-0.05, 0.6 * Math.sin(t * 1.3), 0.1 * Math.sin(t * 0.9)], armsSym([0.85, -0.2, 0.2], [0.75, 0.1, 0.4], 0.3, 0), legsSym([0.25, -0.95, 0.05], [0.2, -0.95, -0.1], 0.5)),   // turns to look around
    catch: ({ d, t }) => pose(14, [0.1, twistTo(d, 0.35), 0], { 1: reachArm(1, d, 0.55, 0.5, 0.1), '-1': reachArm(-1, d, 0.55, 0.5, 0.1) }, legsRelaxed(t)),   // cupped hands
    beckon: ({ s, d, t }) => pose(12, [-0.05, twistTo(d, 0.35), 0], pair(s, reachArm(s, d, 0.35 + 0.35 * Math.sin(t * 4), 0.2), relaxedArm(-s)), legsRelaxed(t)),
    stretchUp: ({ t }) => pose(9, [-0.3, 0, 0], armsSym([0.3, 0.95, -0.05], [0.25, 1, -0.05], 0.05 + 0.1 * Math.sin(t * 3), -0.3), legsSym([0.15, -0.95, -0.1], [0.1, -0.95, -0.2], 0.7)),
    trace: ({ s, d, t }) => pose(14, [0, twistTo(d, 0.4), 0], pair(s, reachArm(s, _rv.copy(d).add(_rw.set(0.35 * Math.sin(t * 2.2), 0.25 * Math.sin(t * 3.1), 0)), 1, 0), relaxedArm(-s)), legsRelaxed(t)),   // follows the shape with a finger
    float: ({ t }) => pose(6, [-0.1 + 0.08 * Math.sin(t), 0.15 * Math.sin(t * 0.6), 0], armsSym([0.7, -0.1 + 0.15 * Math.sin(t * 0.8), 0.2], [0.6, 0.3, 0.3], 0.15, 0), legsSym([0.2, -0.95, 0.1], [0.15, -0.9, -0.2], 0.5)),   // limp, dreamy
    shake: ({ t }) => pose(30, [0.1, 0.5 * Math.sin(t * 9), 0], armsSym([0.6, -0.4, 0.6], [0.4, 0.2, 0.9], 0.8, 0.2), legsRelaxed(t * 3))   // shakes it off
  };
  function shakePose(p, t, a){   // a copy of the pose with a nervous tremor on every limb
    const q = { k: p.k, waist: p.waist.slice(), arm: {}, leg: {} }, j = (x, y, z) => _rw.set(Math.sin(t * 31 + x), Math.sin(t * 27 + y), Math.sin(t * 35 + z)).multiplyScalar(0.07 * a);
    for (const s of [1, -1]){
      const A = p.arm[s], L = p.leg[s];
      q.arm[s] = { u: A.u.clone().add(j(s, 2 * s, 3 * s)).normalize(), f: A.f.clone().add(j(4 * s, s, 2)).normalize(), c: A.c, w: A.w };
      q.leg[s] = { u: L.u.clone().add(j(5, 3 * s, s)).normalize(), f: L.f.clone().add(j(s, 6, 2 * s)).normalize(), w: L.w };
    }
    q.waist[1] += 0.03 * a * Math.sin(t * 29);
    return q;
  }
  // a different sequence for each of the 50 events: [seconds into the event, gesture, options]
  const AWE = 'awe', FEAR = 'fear';
  const REACT = {
    'Eco temporal': [AWE, [[0.6, 'wave', { speed: 3 }], [6.5, 'recoil']]],
    'Reloj derretido': [AWE, [[0.8, 'point'], [3, 'helmet']]],
    'Déjà vu': [FEAR, [[0.3, 'look'], [2.4, 'point'], [4.8, 'helmet', { tremble: 0.3 }]]],
    'Tiempo congelado': [AWE, [[0.2, 'look']]],
    'Reloj de arena': [AWE, [[0.8, 'catch']]],
    'Nave del futuro': [AWE, [[1, 'salute']]],
    'Ventana al pasado': [AWE, [[0.9, 'reachBoth']]],
    'Bucle de luz': [FEAR, [[0.3, 'trace'], [4.4, 'recoil']]],
    'Gato de Schrödinger': [AWE, [[0.5, 'beckon'], [3.2, 'clap']]],
    'Clon del casco': [AWE, [[0.8, 'tap']]],
    'El ojo del abismo': [FEAR, [[0.6, 'shield', { tremble: 0.4 }], [4.7, 'cover', { tremble: 0.6 }]]],
    'Ballena de plasma': [AWE, [[0.8, 'star']]],
    'Medusas estelares': [AWE, [[0.8, 'float']]],
    'Cardumen de cristal': [AWE, [[0.6, 'reach']]],
    'Mariposa cuántica': [AWE, [[0.6, 'beckon'], [3, 'catch'], [6, 'clap']]],
    'Gusano cósmico': [FEAR, [[0.5, 'recoil'], [1.5, 'fetal', { tremble: 0.7 }]]],
    'Dragón de nebulosa': [FEAR, [[0.6, 'point'], [4.4, 'cover', { tremble: 0.8 }]]],
    'Mano gigante': [FEAR, [[0.5, 'hug', { tremble: 0.6 }]]],
    'Flor estelar': [AWE, [[0.8, 'reachBoth'], [4, 'helmet']]],
    'Semilla alienígena': [AWE, [[0.8, 'catch'], [3.5, 'stretchUp']]],
    'Visitantes curiosos': [FEAR, [[0.5, 'point'], [1.9, 'star', { tremble: 0.5 }], [6.4, 'wave', { speed: 10 }]]],
    'Pulpo mecánico': [FEAR, [[0.5, 'shield'], [2, 'flee']]],
    'Nave nodriza': [AWE, [[1, 'stretchUp']]],
    'Holograma': [AWE, [[0.6, 'wave', { speed: 8 }]]],
    'Firma alienígena': [AWE, [[0.5, 'trace']]],
    'Faro alienígena': [AWE, [[0.5, 'point'], [3.8, 'wave', { speed: 6 }]]],
    'Ascensor cósmico': [AWE, [[0.6, 'wave', { speed: 4 }], [4, 'beckon']]],
    'Ciudad flotante': [AWE, [[1, 'helmet'], [4, 'reachBoth']]],
    'Astronauta perdido': [AWE, [[0.6, 'wave', { speed: 12 }], [4.5, 'reach']]],
    'Satélite antiguo': [AWE, [[0.6, 'tap'], [3, 'point']]],
    'Micro agujero negro': [FEAR, [[0.5, 'recoil'], [1.6, 'flee']]],
    'Teseracto': [AWE, [[0.8, 'helmet'], [3.5, 'trace']]],
    'Fractura del espacio': [FEAR, [[0.2, 'duck', { tremble: 0.5 }], [5, 'look']]],
    'Lago de mercurio': [AWE, [[0.6, 'reach'], [4.2, 'tap'], [8, 'reachBoth']]],
    'Ojo de la tormenta': [FEAR, [[0.5, 'shield'], [3, 'hug']]],
    'Escalera de Penrose': [AWE, [[0.6, 'look'], [3, 'helmet', { tremble: 0.2 }]]],
    'Planeta bebé': [AWE, [[0.5, 'catch'], [6.8, 'wave', { speed: 5 }]]],
    'Cometa': [AWE, [[0.3, 'point'], [2.5, 'star']]],
    'Lluvia de meteoros': [FEAR, [[0.2, 'duck']]],
    'Lluvia hacia arriba': [AWE, [[0.6, 'stretchUp'], [4, 'float']]],
    'Grieta a la Tierra': [AWE, [[1, 'reachBoth', { tremble: 0.15 }], [5, 'hug']]],
    'Mensaje en las estrellas': [AWE, [[1, 'wave', { speed: 7 }], [4, 'clap']]],
    'Coro de orbes': [AWE, [[0.8, 'clap']]],
    'Huellas en la nada': [FEAR, [[0.6, 'look'], [3, 'point']]],
    'Duplicado de la nave': [AWE, [[0.8, 'point'], [3, 'helmet'], [6.5, 'shake']]],
    'Señal de radio': [AWE, [[0.6, 'tap'], [3, 'float']]],
    'Laberinto de luz': [AWE, [[0.6, 'point'], [3.6, 'trace'], [9.6, 'clap']]],
    'Concierto de púlsares': [AWE, [[0.6, 'shake']]],
    'Estás aquí': [AWE, [[0.8, 'reach'], [3.5, 'salute']]],
    'Salida del agujero': [AWE, [[0.6, 'recoil'], [1.6, 'star'], [5, 'reachBoth']]]
  };
  function astroReact(def, p){
    const R = REACT[def.name]; if (!R) return;
    anim.moment = { mood: R[0], steps: R[1], t0: anim.mt, dur: def.dur, target: p.anchor };
  }
  // called from animate(): the pose for the current reaction, or null
  momentPose = function(){
    const M = anim.moment; if (!M) return null;
    const lt = anim.mt - M.t0;
    if (lt > M.dur){ anim.moment = null; return null; }
    let st = null; for (const s of M.steps) if (lt >= s[0]) st = s;
    if (!st) return null;
    chest.worldToLocal(_g.copy(M.target)); const sd = _g.x >= 0 ? 1 : -1; _g.sub(shoulderOf(sd)).normalize();
    const o = st[2] || {};
    let p = GEST[st[1]]({ s: sd, d: _g, t: lt, o });
    if (o.tremble) p = shakePose(p, lt, o.tremble);
    anim.react = null; anim.cool = 4;
    anim.hrT = Math.max(anim.hrT, M.mood === FEAR ? 138 : 108);
    return p;
  };

  /* ===== shared touches for every event: a spacetime ripple, a burst of sparks and a glowing haze ===== */
  const BURST_N = 220, burst = pointsOf(BURST_N, 0.15, HC(1, 1, 1)); burst.p.visible = false; scene.add(burst.p);
  const bVel = new Float32Array(BURST_N * 3); let bAge = 9;
  const ripple = { t: 9, p: null };
  function fireBurst(p){
    for (let i = 0; i < BURST_N; i++){
      _rv.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(1.5 + Math.random() * 5.5);
      bVel[i * 3] = _rv.x; bVel[i * 3 + 1] = _rv.y; bVel[i * 3 + 2] = _rv.z;
      burst.pos[i * 3] = p.anchor.x; burst.pos[i * 3 + 1] = p.anchor.y; burst.pos[i * 3 + 2] = p.anchor.z;
    }
    burst.mat.color.copy(p.color); burst.p.visible = true; bAge = 0; ripple.t = 0; ripple.p = p;
  }
  function stepFx(raw, t){
    if (bAge < 2.2){
      bAge += raw; const drag = Math.exp(-raw * 2.4);
      for (let i = 0; i < BURST_N * 3; i++){ bVel[i] *= drag; burst.pos[i] += bVel[i] * raw; }
      burst.flush(); burst.mat.opacity = Math.max(0, 1 - bAge / 2.2); burst.mat.size = 0.15 * (1 + bAge * 0.6);
    } else burst.p.visible = false;
    momentFx.ripA = 0;
    if (ripple.p && ripple.t < 1.5){
      ripple.t += raw;
      _mndc.copy(ripple.p.anchor).project(camera);
      if (_mndc.z < 1){ momentFx.ripX = _mndc.x * 0.5 + 0.5; momentFx.ripY = _mndc.y * 0.5 + 0.5; momentFx.ripR = ripple.t / 1.5 * 0.9; momentFx.ripA = 1 - ripple.t / 1.5; }
    }
    for (const p of points){
      const a = p.state === 'on' ? env(p.time, p.cur.dur, 1.0, 1.5) : 0;
      p.aura.visible = a > 0.001;
      if (p.aura.visible){ p.aura.material.opacity = 0.5 * a; p.aura.material.rotation += raw * 0.05; p.aura.scale.setScalar(10 + 1.5 * Math.sin(t * 0.7)); }
    }
  }
  if (/debug/.test(location.hash)) window.__momentos = {
    play: (pi, si) => playPoint(points[pi], si),
    look(pi){ setCine(false); camera.position.copy(MT).addScaledVector(points[pi].out, -4.15); camera.lookAt(MT); },
    points
  };

  /* ---------- lights ---------- */
  const rim = new THREE.DirectionalLight(C('#ffe4cf'), 1.0); rim.position.set(0.3, -0.8, -6); rim.target = astro; scene.add(rim);
  const fill = new THREE.DirectionalLight(C('#eef0ff'), 0.8); fill.position.set(2.4, 3.2, 3.6); fill.target = astro;
  fill.castShadow = true;
  fill.shadow.mapSize.set(SW() > 900 ? 2048 : 1024, SW() > 900 ? 2048 : 1024);
  Object.assign(fill.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5, near: 0.5, far: 12 });
  fill.shadow.bias = -0.0004; fill.shadow.normalBias = 0.025;
  scene.add(fill);
  const pMag = new THREE.PointLight(C('#ff4fb8'), 1.1, 8, 1.6), pCyan = new THREE.PointLight(C('#3fdcff'), 1.1, 8, 1.6);
  scene.add(pMag, pCyan);
  const bounce = new THREE.DirectionalLight(C('#f4f1ff'), 0.32); bounce.position.set(0.4, -2.2, 3.2); bounce.target = astro; scene.add(bounce);
  scene.fog = new THREE.FogExp2(C('#4a2391'), 0.016);
  scene.add(new THREE.HemisphereLight(C('#5a3cff'), C('#08303d'), 0.14));

  /* ---------- post-processing: bloom, chromatic aberration, filmic tone curve, grain ---------- */
  let composer = null, bloom = null, finalPass = null;
  if (hasPost){
    const db = new THREE.Vector2(); renderer.getDrawingBufferSize(db);
    const rtOpts = { type: HDR };
    if (gl2) rtOpts.samples = 4;
    composer = new THREE.EffectComposer(renderer, new THREE.WebGLRenderTarget(db.x, db.y, rtOpts));
    composer.setPixelRatio(pr); composer.setSize(SW(), SH());
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloom = new THREE.UnrealBloomPass(new THREE.Vector2(SW(), SH()), 0.5, 0.25, 1.1);
    [bloom.renderTargetBright].concat(bloom.renderTargetsHorizontal || [], bloom.renderTargetsVertical || []).forEach((t) => { if (t && t.texture) t.texture.type = HDR; });
    composer.addPass(bloom);
    finalPass = new THREE.ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2(0.001, 0.001) }, uExposure: { value: 0.95 }, uCA: { value: 0.004 }, uSpeed: { value: 1 }, uSharp: { value: 0.22 }, uLensPos: { value: new THREE.Vector2(0.5, 0.5) }, uLensR: { value: 0 }, uLensK: { value: 0 }, uFreeze: { value: 0 }, uRip: { value: new THREE.Vector3(0.5, 0.5, 0) }, uRipA: { value: 0 }, uTintA: { value: 0 }, uTintC: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uTime, uExposure, uCA, uSpeed, uSharp, uLensR, uLensK, uFreeze, uTintA; uniform vec2 uRes, uTexel, uLensPos; uniform vec3 uTintC, uRip; uniform float uRipA;
        varying vec2 vUv;
        float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
        vec3 toSRGB(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
        void main(){
          vec2 uv = vUv; float hole = 1.0, lensD = 1.0;
          if (uLensK > 0.0){
            float asp = uRes.x / uRes.y;
            vec2 lp = (vUv - uLensPos) * vec2(asp, 1.0);
            float d2 = max(dot(lp, lp), 1e-6);
            uv = clamp(vUv + (lp / d2) * uLensK / vec2(asp, 1.0), 0.0, 1.0);
            lensD = sqrt(d2); hole = smoothstep(uLensR * 0.9, uLensR * 1.05, lensD);
          }
          float ripW = 0.0;
          if (uRipA > 0.0){   // a ring of bent space spreading from where an event begins
            float asp2 = uRes.x / uRes.y; vec2 rd = (vUv - uRip.xy) * vec2(asp2, 1.0); float rr = length(rd);
            ripW = exp(-pow((rr - uRip.z) / 0.05, 2.0)) * uRipA;
            uv = clamp(uv + rd / max(rr, 1e-4) / vec2(asp2, 1.0) * ripW * 0.025, 0.0, 1.0);
          }
          vec2 cc = vUv - 0.5;
          vec2 ca = vec2(cc.x * uRes.x / uRes.y, cc.y);
          float r2 = dot(ca, ca);
          vec2 dir = cc * uCA * (0.6 + 0.4 * uSpeed) * min(dot(cc, cc) * 4.0, 1.0);
          vec3 col;
          col.r = texture2D(tDiffuse, uv - dir).r;
          col.g = texture2D(tDiffuse, uv).g;
          col.b = texture2D(tDiffuse, uv + dir).b;
          col = aces(col * uExposure);
          vec3 nb = aces(texture2D(tDiffuse, uv + vec2(uTexel.x, 0.0)).rgb * uExposure)
                  + aces(texture2D(tDiffuse, uv - vec2(uTexel.x, 0.0)).rgb * uExposure)
                  + aces(texture2D(tDiffuse, uv + vec2(0.0, uTexel.y)).rgb * uExposure)
                  + aces(texture2D(tDiffuse, uv - vec2(0.0, uTexel.y)).rgb * uExposure);
          col = clamp(col + (col * 4.0 - nb) * uSharp, 0.0, 1.0);
          float vig = 1.0 - smoothstep(0.35, 1.15, length(ca) * 1.15);
          if (uFreeze > 0.0){ float lum = dot(col, vec3(0.299, 0.587, 0.114)); col = mix(col, vec3(lum * 0.78, lum * 0.95, lum * 1.2), uFreeze * 0.85); }
          col = mix(col, clamp(col * uTintC * 1.5, 0.0, 1.0), uTintA);
          col += vec3(0.35, 0.6, 0.9) * ripW * 0.12;
          col *= mix(0.42, 1.0, vig);
          if (uLensK > 0.0){ col *= hole; col += vec3(1.0, 0.85, 0.6) * exp(-pow((lensD - uLensR * 1.5) / (uLensR * 0.15), 2.0)) * 0.5; }
          col = toSRGB(col);
          col += (hash(vUv * uRes + fract(uTime * 7.13) * 913.0) - 0.5) * 0.012;
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    composer.addPass(finalPass);
  }

  /* ---------- sizing and adaptive resolution ---------- */
  let baseFov = 60;
  function resize(){
    const w = SW(), h = SH(), aspect = w / h;
    camera.aspect = aspect; baseFov = aspect < 0.8 ? 72 : 60; camera.fov = baseFov; camera.updateProjectionMatrix();
    MAX_PR = maxPrFor(); pr = Math.min(pr, MAX_PR);
    renderer.setPixelRatio(pr); renderer.setSize(w, h);
    if (composer){ composer.setPixelRatio(pr); composer.setSize(w, h); finalPass.uniforms.uRes.value.set(w * pr, h * pr); finalPass.uniforms.uTexel.value.set(1 / (w * pr), 1 / (h * pr)); }
    dustMat.uniforms.uScale.value = (h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  }
  resize();
  addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(STAGE);
  stamps.build = performance.now();

  /* ---------- UI ---------- */
  const fmt = (d) => new Intl.NumberFormat('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });
  const f1 = fmt(1), f2 = fmt(2), f4 = fmt(4);
  const hms = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return [h, m, x].map((n) => String(n).padStart(2, '0')).join(':'); };
  const el = { hr: $('t-hr'), resp: $('t-resp'), depth: $('t-depth'), vel: $('t-vel'), gamma: $('t-gamma'), ship: $('t-ship'), mode: $('t-mode'), ext: $('t-ext'), o2: $('t-o2'), out: $('speed-out') };
  let speedTarget = reduceMotion ? 0.45 : 1, speed = speedTarget, paused = false, cine = !reduceMotion;
  const speedInput = $('speed'); speedInput.value = speedTarget;
  const setOut = () => { el.out.textContent = f1.format(speedTarget) + '×'; };
  setOut();
  speedInput.addEventListener('input', () => { speedTarget = parseFloat(speedInput.value); setOut(); });
  const btnPause = $('btn-pause'), btnCine = $('btn-cine');
  function setPaused(v){ paused = v; btnPause.textContent = v ? 'Reanudar' : 'Pausar'; btnPause.setAttribute('aria-pressed', String(v)); }
  function setCine(v){ cine = v; btnCine.setAttribute('aria-pressed', String(v)); }
  setCine(cine);
  btnPause.addEventListener('click', () => setPaused(!paused));
  btnCine.addEventListener('click', () => setCine(!cine));
  function setClean(v){ document.body.classList.toggle('is-clean', v); $('btn-show').hidden = !v; if (v) $('btn-show').focus({ preventScroll: true }); }
  $('btn-hud').addEventListener('click', () => setClean(true));
  $('btn-show').addEventListener('click', () => { setClean(false); $('btn-hud').focus({ preventScroll: true }); });
  addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey)) return;
    if (e.key === 'h' || e.key === 'H') setClean(!document.body.classList.contains('is-clean'));
    if (e.key === 'f' || e.key === 'F') $('perf-row').hidden = !$('perf-row').hidden;
    if (e.key === ' ' && e.target === document.body){ e.preventDefault(); setPaused(!paused); }
  });
  controls.addEventListener('start', () => { if (cine) setCine(false); });
  /* gyroscope toggle: Android sends tilt freely, iOS asks once after a tap */
  const btnGyro = $('btn-gyro'), gyroNote = $('gyro-note');
  const needsAsk = !!(window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function');
  const touchy = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches) || needsAsk;
  const fp = document.permissionsPolicy || document.featurePolicy;
  const policyBlocked = !!(fp && fp.allowsFeature && (!fp.allowsFeature('gyroscope') || !fp.allowsFeature('accelerometer')));
  let noteTimer = 0;
  function note(msg){ gyroNote.textContent = msg; gyroNote.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { gyroNote.hidden = true; }, 9000); }
  const BLOCKED = 'El visor donde se abre esta página bloquea los sensores de movimiento. Ábrela en tu propia web (con https) y el giroscopio funcionará.';
  function setGyro(v){ gyro.on = v; gyro.base = null; gyro.cal = null; gyro.cur.identity(); gyro.rel.identity(); if (v){ setCine(false); goHome(); } controls.enableRotate = !v; if (MUI.hint) MUI.hint.textContent = v ? 'gira tu celular' : 'arrastra para buscarlos'; btnGyro.setAttribute('aria-pressed', String(v)); btnGyro.textContent = v ? 'Giroscopio activo' : 'Giroscopio'; }
  async function askGyro(fromTap){
    if (needsAsk){
      try { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted'){ if (fromTap) note('Permiso de movimiento denegado. Actívalo en Ajustes › Safari › Movimiento y orientación.'); return; } }
      catch (err){ if (fromTap) note(BLOCKED); return; }
    }
    setGyro(true);
    setTimeout(() => { if (gyro.on && !gyro.seen){ setGyro(false); btnGyro.textContent = 'Giroscopio no disponible'; if (fromTap || policyBlocked) note(BLOCKED); } }, 2000);
  }
  if (window.DeviceOrientationEvent && touchy){
    btnGyro.hidden = false;
    btnGyro.addEventListener('click', () => { if (gyro.on) setGyro(false); else askGyro(true); });
    if (policyBlocked){ btnGyro.textContent = 'Giroscopio no disponible'; setTimeout(() => note(BLOCKED), 1500); }
    else {
      // the gyroscope starts with a tap anywhere (iOS requires it; every phone works the same way), and the view stays put until then
      controls.enableRotate = false;
      if (MUI.hint) MUI.hint.textContent = 'toca para activar el giroscopio';
      const once = () => {
        removeEventListener('touchend', once); removeEventListener('click', once);
        if (!gyro.on) askGyro(true).then(() => { if (!gyro.on){ controls.enableRotate = true; if (MUI.hint) MUI.hint.textContent = 'arrastra para buscarlos'; } });
      };
      addEventListener('touchend', once, { passive: true }); addEventListener('click', once);
    }
    if (!policyBlocked){ setCine(false); goHome(); }   // phones start centred and still, ready for the gyroscope
  }
  if (location.hash.indexOf('rendimiento') >= 0) $('perf-row').hidden = false;

  /* ---------- animation loop ---------- */
  const FLOW = 11;
  const clock = new THREE.Clock();
  const sph = new THREE.Spherical(), off = new THREE.Vector3();
  let probeDrop = null;
  let t = 0, wt = 0, flow = 0, frame = 0, hudAcc = 0, screenAcc = 0, perfAcc = 0, perfFrames = 0, lastDrop = -99;
  let depthKm = 0, proper = 0, external = 0, o2 = 87, gamma = 1;
  let started = false;
  const dbg = { cube: true, tether: true, adaptive: true };

  const QSTEPS = ['refl', 'msaa', 'layers', 'res'];
  const qOn = { refl: false, msaa: false, layers: false, res: false };
  let qNext = 0, qProbe = null, cubeEvery = 6, shadowEvery = 2;
  // quality steps are tried one at a time and kept only if they really buy frames
  function applyQ(){
    if (composer && gl2){ const smp = qOn.msaa ? 2 : 4; [composer.renderTarget1, composer.renderTarget2].forEach((rt) => { if (rt && rt.samples !== smp){ rt.samples = smp; rt.dispose(); } }); }
    cubeEvery = qOn.refl ? 12 : 6; shadowEvery = qOn.refl ? 4 : 2;
    tunnelMat.uniforms.uLayers.value = qOn.layers ? 4 : 5;
    const prT = qOn.res ? Math.min(1, MAX_PR) : MAX_PR;
    if (Math.abs(prT - pr) > 0.001){ pr = prT; resize(); }
  }

  function tick(){
    requestAnimationFrame(tick);

    const real = clock.getDelta();
    const raw = Math.min(real, 0.1);
    const dt = paused ? 0 : raw;
    speed += (speedTarget - speed) * Math.min(1, raw * 3);
    const tm = t * (reduceMotion ? 0.5 : 1);
    animate(dt, tm);
    const fs = speed * anim.fx;   // fall speed, including the dive
    const wdt = dt * (1 - momentFx.freeze);   // world time: a frozen moment stops everything but the astronaut
    t += dt; wt += wdt; flow += wdt * FLOW * fs;
    astro.updateMatrixWorld(true);
    if (dbg.tether) updateTether(tm);
    updateShip(wt);
    updateNovas(wt, wdt, fs);

    pMag.position.set(Math.cos(t * 0.45) * 3.0, Math.sin(t * 0.45) * 3.0, -1.2 + Math.sin(t * 0.41) * 1.0);
    pCyan.position.set(Math.cos(t * 0.45 + Math.PI) * 3.0, Math.sin(t * 0.45 + Math.PI) * 3.0, -0.4 + Math.cos(t * 0.37) * 1.0);
    pMag.intensity = 0.6 + 0.2 * Math.sin(t * 1.3);
    pCyan.intensity = 0.6 + 0.2 * Math.cos(t * 1.1);

    tunnelMat.uniforms.uTime.value = wt; tunnelMat.uniforms.uFlow.value = flow;
    dustMat.uniforms.uTime.value = wt; dustMat.uniforms.uFlow.value = flow;
    streakMat.uniforms.uTime.value = wt; streakMat.uniforms.uFlow.value = flow;
    streakMat.uniforms.uStreak.value = 0.6 + 1.7 * Math.min(fs, 3);

    for (const d of debris){
      if (d.captured) continue;
      const m = d.mesh;
      m.position.z += wdt * FLOW * fs * d.k;
      m.rotation.x += d.spin.x * wdt; m.rotation.y += d.spin.y * wdt; m.rotation.z += d.spin.z * wdt;
      // pieces slide around the ship instead of through it
      const dzs = m.position.z - ship.position.z;
      if (dzs > -4.5 && dzs < 4.5){
        const ox = m.position.x - ship.position.x, oy = m.position.y - ship.position.y, rr = Math.hypot(ox, oy), need = 2.3 + m.scale.x;
        if (rr < need){ const f = need / Math.max(rr, 0.01); m.position.x = ship.position.x + ox * f; m.position.y = ship.position.y + oy * f; }
      }
      if (m.position.z > camera.position.z + 3) place(d, false);
    }

    if (cine){
      off.copy(camera.position).sub(controls.target); sph.setFromVector3(off);
      const k = Math.min(1, raw * 1.2);
      sph.theta += (0.19 + 0.65 * Math.sin(t * 0.05) - sph.theta) * k;
      sph.phi += (1.24 + 0.07 * Math.sin(t * 0.083 + 1.3) - sph.phi) * k;
      off.setFromSpherical(sph); camera.position.copy(controls.target).add(off);
    }
    controls.update();

    // the dive widens the lens a little
    const fovT = baseFov + (anim.fx - 1) * 4;
    if (Math.abs(camera.fov - fovT) > 0.02){
      camera.fov = fovT; camera.updateProjectionMatrix();
      dustMat.uniforms.uScale.value = (SH() * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    }

    if (dbg.cube && frame % cubeEvery === 0){
      cubeCam.position.copy(astro.position);
      renderer.shadowMap.needsUpdate = false;
      cubeCam.update(renderer, scene);
      cubeRT.texture.needsPMREMUpdate = true;
    }

    renderer.shadowMap.needsUpdate = frame % shadowEvery === 0;
    gyroApply(raw);
    updateMoments(raw, t);
    if (composer){
      const u = finalPass.uniforms;
      u.uCA.value = 0.004 + momentFx.ca; u.uLensK.value = momentFx.lensK;
      if (momentFx.lensK > 0){ u.uLensPos.value.set(momentFx.lensX, momentFx.lensY); u.uLensR.value = momentFx.lensR; }
      u.uRipA.value = momentFx.ripA; u.uRip.value.set(momentFx.ripX, momentFx.ripY, momentFx.ripR);
      u.uFreeze.value = momentFx.freeze; u.uTintA.value = momentFx.tintA; u.uTintC.value.copy(momentFx.tint);
      u.uExposure.value = 0.95 * (1 - 0.5 * momentFx.dim);
    }
    const shk = reduceMotion ? 0 : 0.009 * fs;
    const sx = (Math.sin(t * 37.1) + Math.sin(t * 23.7)) * shk, sy = (Math.sin(t * 41.3) + Math.sin(t * 19.9)) * shk;
    camera.position.x += sx; camera.position.y += sy; camera.updateMatrixWorld();
    if (composer){ finalPass.uniforms.uTime.value = t; finalPass.uniforms.uSpeed.value = fs; composer.render(); }
    else renderer.render(scene, camera);
    camera.position.x -= sx; camera.position.y -= sy;
    gyroRestore();

    // telemetry
    const vel = 3.2 * fs * (1 + 0.004 * Math.sin(t * 3.7));
    depthKm += vel * dt; proper += dt;
    gamma = 1 + 0.9 * (1 - Math.exp(-depthKm / 2500));
    external += dt * gamma;
    o2 = Math.max(0, 87 - proper * 0.004);
    hudAcc += raw; screenAcc += raw;
    if (hudAcc > 0.15){
      hudAcc = 0;
      el.depth.innerHTML = f1.format(depthKm) + '<span class="u">km</span>';
      el.vel.innerHTML = f2.format(paused ? 0 : vel) + '<span class="u">km/s</span>';
      el.gamma.textContent = f4.format(gamma);
      el.ext.textContent = hms(external);
      el.o2.innerHTML = f1.format(o2) + '<span class="u">%</span>';
      el.hr.innerHTML = Math.round(anim.hr) + '<span class="u">lpm</span>'; el.hr.classList.toggle('alert', anim.hr > 112);
      const stressNow = THREE.MathUtils.clamp((anim.hr - 86) / 50, 0, 1);
      el.resp.innerHTML = Math.round(60 * (1 + stressNow * 0.7) / 4.4) + '<span class="u">rpm</span>';
      el.ship.innerHTML = Math.round(ship.position.distanceTo(astro.position)) + '<span class="u">m</span>';
      if (el.mode.textContent !== anim.label) el.mode.textContent = anim.label;
    }
    if (screenAcc > 3){ screenAcc = 0; drawScreen(o2); }

    // real frame rate (unclamped), used to adapt quality only when it actually helps
    perfAcc += real; perfFrames++;
    if (perfAcc > 2){
      const fps = perfFrames / perfAcc;
      $('t-perf').innerHTML = Math.round(fps) + '<span class="u">fps · ' + f2.format(pr) + '× · calidad ' + (QSTEPS.some((s) => qOn[s]) ? 'ajustada' : 'máxima') + ' · carga ' + f1.format(stamps.first / 1000) + ' s</span>';
      if (performance.now() - stamps.first > 6000){
        if (fps < 12 && qNext === 0 && !qProbe){ QSTEPS.forEach((st) => { qOn[st] = true; }); qNext = QSTEPS.length; applyQ(); }
        else if (qProbe){ if (fps < qProbe.fps * 1.08){ qOn[qProbe.step] = false; applyQ(); } qProbe = null; }
        else if (fps < 26 && qNext < QSTEPS.length){ const st = QSTEPS[qNext++]; qProbe = { fps: fps, step: st }; qOn[st] = true; applyQ(); }
      }
      perfAcc = 0; perfFrames = 0;
    }
    frame++;
    if (!started){ started = true; loader.classList.add('done'); stamps.first = performance.now(); }
  }
  tick();
}
})();