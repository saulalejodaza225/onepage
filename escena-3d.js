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

  const anim = { mode: 'swim', modeT: reduceMotion ? 1e9 : 9, stroke: 0, reachT: 3, reachHold: 0, reach: 0, react: null, cool: 7,
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

  // front crawl: each arm pulls under the chest from overhead to the hip, then recovers wide over the back
  function buildSwim(t, reach){
    const ph = anim.stroke;
    for (const s of [1, -1]){
      const a = (((ph + (s > 0 ? 0 : Math.PI)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const A = swimPose.arm[s];
      if (a < Math.PI){
        const sa = Math.sin(a), ca = Math.cos(a);
        A.u.set(s * 0.22, ca, sa * 0.85).normalize();
        A.f.set(s * 0.12, ca - 0.35 * sa, sa * 1.1).normalize();
        A.c = 0.22 + 0.12 * sa; A.w = 0.25;
      } else {
        const r = Math.sin(a - Math.PI), ca = Math.cos(a);
        A.u.set(s * (0.22 + 0.75 * r), ca, -0.32 * r).normalize();
        A.f.set(s * (0.15 + 0.5 * r), ca - 0.3 * r, -0.1 * r).normalize();
        A.c = 0.4; A.w = 0.05;
      }
      if (reach > 0.001){
        toShipFrom(shoulderOf(s), _g);
        A.u.lerp(_g, reach).normalize(); A.f.lerp(_g, reach).normalize();
        A.c = lerp(A.c, 0, reach); A.w = lerp(A.w, -0.3, reach);
      }
      const off = s > 0 ? 0 : Math.PI, kf = reach > 0.5 ? 6.5 : 4.4;
      const L = swimPose.leg[s];
      L.u.set(s * 0.12, -1, 0.12 + 0.2 * Math.sin(t * kf + off)).normalize();
      L.f.set(s * 0.08, -1, -0.04 + 0.16 * Math.sin(t * kf - 0.9 + off)).normalize();
      L.w = 0.7;
    }
    swimPose.waist[0] = -0.08 - 0.08 * reach; swimPose.waist[1] = 0.12 * Math.sin(ph) * (1 - reach); swimPose.waist[2] = 0;
    swimPose.k = reach > 0.5 ? 9 : 14;
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

  function animate(dt, t){
    if (dt <= 0) return;
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
    anim.stroke += dt * (2.2 - 1.5 * anim.reach) * (mode === 'swim' ? 1 : 0.25);

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
    const rollT = mode === 'swim' ? 0.26 * Math.sin(anim.stroke + Math.PI / 2) * (1 - anim.reach) : 0;
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

  /* ---------- four hidden moments ----------
     Each one waits in a different direction around the astronaut, marked only by a faint glint.
     Holding the view on a glint for half a second (tilting the phone, or dragging) sets it off;
     it can be replayed after a short rest. */
  const MT = controls.target.clone();
  // direction the camera looks when it orbits the astronaut at spherical angles (theta, phi)
  const viewDir = (theta, phi) => V(-Math.sin(phi) * Math.sin(theta), -Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
  const easeIO = (x) => x * x * (3 - 2 * x);
  const _mf = new THREE.Vector3(), _mto = new THREE.Vector3(), _mp = new THREE.Vector3(), _mv = new THREE.Vector3(), _ms = new THREE.Vector3(), _mndc = new THREE.Vector3();
  const momentFx = { ca: 0, lensK: 0, lensX: 0.5, lensY: 0.5, lensR: 0 };
  const moments = [];
  const MUI = { count: $('moments-count'), hint: $('moments-hint'), toast: $('moment-toast') };
  const touchUI = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  if (MUI.hint) MUI.hint.textContent = touchUI ? 'gira tu celular' : 'arrastra para buscarlos';
  function addMoment(def){
    const g = sprite(novaCoreTex, def.glintColor);
    g.position.copy(def.anchor); scene.add(g);
    const m = Object.assign({ state: 'idle', time: 0, dwell: 0, found: false, ph: rand() * 6.28, glint: g }, def);
    moments.push(m);
    return m;
  }

  // 1 · temporal echo: a hologram of the astronaut replays what it did 2.5 seconds ago, then rewinds
  let echoRecord = null;
  {
    const src = []; astro.traverse((o) => src.push(o));
    const kept = src.map((o) => o.userData); src.forEach((o) => { o.userData = {}; });   // userData holds live references; keep them out of the clone
    const ghost = astro.clone(true);
    src.forEach((o, i) => { o.userData = kept[i]; });
    const dst = []; ghost.traverse((o) => dst.push(o));
    const ghostMat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 0 }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform float uFade, uTime; varying vec3 vN; varying vec3 vV;
        void main(){
          float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); f *= f;
          float scan = 0.65 + 0.35 * sin(gl_FragCoord.y * 0.9 - uTime * 24.0);
          vec3 c = mix(vec3(0.2, 0.75, 1.0), vec3(1.0, 0.45, 0.9), f) * (0.12 + 1.9 * f) * scan;
          gl_FragColor = vec4(c * uFade, 1.0);
        }`
    });
    ghost.traverse((o) => { if (o.isMesh){ o.material = ghostMat; o.castShadow = false; o.receiveShadow = false; } });
    ghost.visible = false; scene.add(ghost);
    const N = src.length, HIST = 720, hist = new Float32Array(HIST * N * 4), histT = new Float64Array(HIST).fill(-1e9);
    let head = 0;
    echoRecord = (now) => { const o = head * N * 4; for (let i = 0; i < N; i++) src[i].quaternion.toArray(hist, o + i * 4); histT[head] = now; head = (head + 1) % HIST; };
    const poseAt = (now, delay) => {
      const want = now - delay; let idx = (head - 1 + HIST) % HIST;
      for (let s = 0; s < HIST - 1; s++){ const p = (idx - 1 + HIST) % HIST; if (histT[idx] <= want || histT[p] < -1e8) break; idx = p; }
      const o = idx * N * 4;
      for (let i = 0; i < N; i++) dst[i].quaternion.fromArray(hist, o + i * 4);
    };
    const anchor = MT.clone().addScaledVector(viewDir(Math.PI, 1.35), 5.5).add(V(1.3, 0.4, 0));
    addMoment({ name: 'Eco temporal', line: 'Tu yo de hace unos segundos sigue cayendo a tu lado.', anchor, dur: 8.5, glint0: 0.9, glintColor: new THREE.Color(0.5, 1.4, 2.0),
      start(){ ghost.visible = true; },
      update(lt, raw, t){
        const now = performance.now() / 1000;
        const inK = smooth(0, 0.8, lt), outK = 1 - smooth(this.dur - 1.0, this.dur, lt), rew = Math.max(0, lt - (this.dur - 2.0));
        poseAt(now, 2.5 + rew * rew * 1.4);   // the delay grows faster than time: the echo plays backwards
        const glitchy = lt < 0.8 || rew > 0;
        const flick = reduceMotion || !glitchy ? 1 : (Math.sin(t * 57) > -0.2 ? 1 : 0.35);
        ghostMat.uniforms.uFade.value = 0.85 * inK * outK * flick;
        ghostMat.uniforms.uTime.value = t;
        ghost.position.copy(this.anchor).add(_mv.set(0.25 * Math.sin(lt * 0.7), 0.2 * Math.sin(lt * 0.9), -0.12 * lt));
        momentFx.ca += 0.02 * (1 - inK) + 0.025 * Math.min(1, rew);
      },
      end(){ ghost.visible = false; } });
  }

  // 2 · the eye of the abyss: an alien eye opens in the wall of the throat and follows the camera
  {
    const anchor = MT.clone().addScaledVector(viewDir(1.75, 1.75), 11);
    const RE = 2.2;
    const eye = new THREE.Group(); eye.position.copy(anchor); eye.visible = false; scene.add(eye);
    const eyeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uDilate: { value: 1 }, uGlow: { value: 1 } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uDilate, uGlow; varying vec3 vP;
        void main(){
          vec3 n = normalize(vP);
          float a = acos(clamp(n.z, -1.0, 1.0));
          float ph = atan(n.y, n.x);
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
        }`
    });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(RE, 64, 48), eyeMat); eye.add(ball);
    const lidMat = new THREE.MeshStandardMaterial({ color: C('#3b1838'), roughness: 0.5, metalness: 0, normalMap: TX.rockNormal, normalScale: new THREE.Vector2(1.5, 1.5), emissive: C('#ff3fae'), emissiveIntensity: 0.2, side: THREE.DoubleSide, fog: false, envMapIntensity: 0.8 });
    const upper = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.05, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2), lidMat);
    const lower = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.05, 64, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), lidMat);
    eye.add(upper, lower);
    const ring = sprite(novaRingTex, new THREE.Color(1.5, 0.35, 1.2)); eye.add(ring);
    const aim = new THREE.Object3D(), sac = new THREE.Vector2(), sacNow = new THREE.Vector2(); let sacT = 0;
    addMoment({ name: 'El ojo del abismo', line: 'Algo vive en las paredes del túnel… y te está mirando.', anchor, dur: 9.5, glint0: 1.4, glintColor: new THREE.Color(2.0, 0.5, 1.6),
      start(){ eye.visible = true; aim.position.copy(eye.position); aim.lookAt(camera.position); eye.quaternion.copy(aim.quaternion); sacNow.set(0, 0); sac.set(0, 0); },
      update(lt, raw, t){
        const appear = smooth(0, 0.9, lt) * (1 - smooth(this.dur - 0.9, this.dur, lt));
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
        const rk = smooth(0, 1.8, lt);
        ring.scale.setScalar(RE * (1.4 + 4.5 * rk)); ring.material.opacity = (1 - rk) * 0.9;
        momentFx.ca += 0.012 * (1 - smooth(0, 0.9, lt));
      },
      end(){ eye.visible = false; } });
  }

  // 3 · curious visitors: a saucer scans the astronaut with a beam, tilts its head, and jumps to hyperspace
  {
    const out = viewDir(-1.5, 1.7), anchor = MT.clone().addScaledVector(out, 7);
    const ufo = new THREE.Group(); ufo.visible = false; scene.add(ufo);
    const spinG = new THREE.Group(); ufo.add(spinG);
    const hullMat = new THREE.MeshPhysicalMaterial({ color: C('#c3c9d4'), metalness: 1, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08, normalMap: TX.metalNormal, normalScale: new THREE.Vector2(0.25, 0.25), envMapIntensity: 1.7 });
    spinG.add(new THREE.Mesh(new THREE.LatheGeometry([V2(0.001,-0.2),V2(0.45,-0.19),V2(0.95,-0.09),V2(1.25,-0.01),V2(1.27,0.02),V2(1.0,0.08),V2(0.55,0.16),V2(0.001,0.19)], 72), hullMat));
    const lightMats = [], bulb = new THREE.SphereGeometry(0.055, 10, 8);
    for (let i = 0; i < 14; i++){
      const a = i / 14 * Math.PI * 2, mt = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1), fog: false });
      const b = new THREE.Mesh(bulb, mt); b.position.set(Math.cos(a) * 1.2, 0, Math.sin(a) * 1.2); spinG.add(b); lightMats.push(mt);
    }
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.46, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: C('#9dffc8'), roughness: 0.04, clearcoat: 1, transparent: true, opacity: 0.45, emissive: C('#14ff8c'), emissiveIntensity: 0.35, envMapIntensity: 1.5, depthWrite: false }));
    dome.position.y = 0.15; ufo.add(dome);
    // the pilot: a small round head with two big glowing eyes
    const pilot = new THREE.Group(); pilot.position.y = 0.22; ufo.add(pilot);
    pilot.add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), new THREE.MeshStandardMaterial({ color: C('#3fae6a'), roughness: 0.5 })));
    const pupilMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.6, 2.2), fog: false });
    for (const sd of [-1, 1]){ const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), pupilMat); e.position.set(sd * 0.055, 0.03, 0.115); e.scale.set(1, 1.4, 0.6); pilot.add(e); }
    const belly = new THREE.Mesh(new THREE.CircleGeometry(0.5, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 3.0, 1.6), fog: false, side: THREE.DoubleSide }));
    belly.position.y = -0.2; ufo.add(belly);
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { uOn: { value: 0 }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform float uOn, uTime; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){
          float core = abs(dot(normalize(vN), normalize(vV)));
          float band = pow(fract(vUv.y * 7.0 + uTime * 1.6), 10.0);
          float fade = smoothstep(0.0, 0.15, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
          vec3 c = vec3(0.35, 1.0, 0.65) * (0.16 + 1.3 * band) * (0.3 + 0.7 * core) * fade;
          gl_FragColor = vec4(c * uOn, 1.0);
        }`
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.85, 1, 40, 1, true), beamMat); beam.visible = false; scene.add(beam);
    const flash = sprite(novaCoreTex, new THREE.Color(0.8, 2.2, 1.4)); flash.visible = false; scene.add(flash);
    const from = new THREE.Vector3(), away = V(0.35, 0.75, -1).normalize(), Yup = V(0, 1, 0), aim = new THREE.Object3D(), level = new THREE.Quaternion();
    let flashPlaced = false;
    addMoment({ name: 'Visitantes curiosos', line: 'Un platillo escaneó tu traje y saltó al hiperespacio.', anchor, dur: 8.6, glint0: 1.0, glintColor: new THREE.Color(0.6, 2.2, 1.2),
      start(){ from.copy(anchor).addScaledVector(out, 22).add(_mv.set(0, 7, -6)); ufo.position.copy(from); ufo.visible = true; flashPlaced = false; },
      update(lt, raw, t){
        const A = astro.position;
        const arrive = easeIO(smooth(0, 1.8, lt)), leave = Math.max(0, lt - 7.2);
        ufo.position.lerpVectors(from, anchor, arrive);
        ufo.position.y += 0.12 * Math.sin(t * 2.3);
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
          beam.position.copy(_mp).addScaledVector(_mto, len / 2);
          beam.quaternion.setFromUnitVectors(Yup, _mto);
          beam.scale.set(1, len, 1);
        }
        beamMat.uniforms.uOn.value = on; beamMat.uniforms.uTime.value = t;
        lampLens.emissiveIntensity = 1.5 + on * (Math.sin(t * 38) > 0 ? 2.2 : -1.3);   // the helmet lamps stutter under the scan
        const fl = smooth(7.1, 7.3, lt) * (1 - smooth(7.4, 8.4, lt));
        flash.visible = fl > 0.001;
        if (flash.visible){
          if (!flashPlaced){ flash.position.copy(ufo.position); flashPlaced = true; }
          flash.material.opacity = fl; flash.scale.setScalar(1.5 + 10 * smooth(7.1, 8.4, lt));
        }
        if (lt > 8.0) ufo.visible = false;
        momentFx.ca += 0.02 * fl;
      },
      end(){ ufo.visible = false; beam.visible = false; flash.visible = false; lampLens.emissiveIntensity = 1.5; } });
  }

  // 4 · micro black hole: it bends the light behind it, swallows a fragment and evaporates in a flash
  {
    const anchor = MT.clone().addScaledVector(viewDir(-0.9, 0.7), 8);
    const RH = 0.5;
    const bh = new THREE.Group(); bh.position.copy(anchor); bh.visible = false; scene.add(bh);
    bh.add(new THREE.Mesh(new THREE.SphereGeometry(RH, 40, 24), new THREE.MeshBasicMaterial({ color: 0x000000, fog: false })));
    const diskMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFade: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uFade; varying vec2 vP;
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
        }`
    });
    const disk = new THREE.Mesh(new THREE.RingGeometry(0.62, 2.12, 160, 1), diskMat);
    disk.rotation.set(1.15, 0.3, 0); bh.add(disk);
    const halo = sprite(novaRingTex, new THREE.Color(1.3, 0.8, 0.45)); bh.add(halo);
    const pop = sprite(novaCoreTex, new THREE.Color(1.6, 1.5, 2.4)); pop.position.copy(anchor); pop.visible = false; scene.add(pop);
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), preyScale = new THREE.Vector3();
    let prey = null, preyAng = 0;
    const release = () => { if (!prey) return; prey.mesh.scale.copy(preyScale); prey.captured = false; place(prey, false); prey = null; };
    addMoment({ name: 'Micro agujero negro', line: 'La luz se dobla a su alrededor… y se traga un fragmento.', anchor, dur: 10, glint0: 1.0, glintColor: new THREE.Color(2.2, 1.3, 0.6),
      start(){
        bh.visible = true;
        const pool = debris.filter((d) => !d.big && !d.captured && d.mesh.scale.x < 0.4);
        prey = pool.length ? pool[(rand() * pool.length) | 0] : null;
        if (prey){ prey.captured = true; preyScale.copy(prey.mesh.scale); preyAng = rand() * 6.28; }
      },
      update(lt, raw, t){
        const grow = easeIO(smooth(0, 1.2, lt)), shrink = 1 - smooth(7.0, 8.6, lt), s = Math.max(0.001, grow * shrink);
        bh.scale.setScalar(s);
        diskMat.uniforms.uTime.value = t;
        diskMat.uniforms.uFade.value = grow * (1 + 1.2 * smooth(6.5, 8.4, lt));   // it flares up as it evaporates
        halo.scale.setScalar(2.6); halo.material.opacity = 0.6; halo.material.rotation += raw * 0.4;
        if (prey){
          if (lt < 6.4){
            const k = smooth(1.4, 6.4, lt), r = lerp(4.5, 0.5, easeIO(k));
            e1.set(1, 0, 0).applyQuaternion(disk.quaternion); e2.set(0, 1, 0).applyQuaternion(disk.quaternion);
            preyAng += raw * (0.5 + 2.6 / Math.max(r, 0.45));   // faster and faster as it falls in
            const pm = prey.mesh;
            pm.position.copy(bh.position).addScaledVector(e1, Math.cos(preyAng) * r).addScaledVector(e2, Math.sin(preyAng) * r);
            pm.scale.copy(preyScale).multiplyScalar(Math.max(0.02, 1 - 0.95 * smooth(0.55, 1, k)));
            pm.rotation.z += raw * 8 * k;
          } else release();
        }
        const p = smooth(8.4, 8.6, lt) * (1 - smooth(8.7, 9.9, lt));   // the last flash as it evaporates
        pop.visible = p > 0.001;
        if (pop.visible){ pop.material.opacity = p; pop.scale.setScalar(1 + 7 * smooth(8.4, 9.9, lt)); }
        momentFx.ca += 0.02 * p;
        // gravitational lensing is drawn in the final pass, centred on the hole
        if (s > 0.01){
          _mndc.copy(bh.position).project(camera);
          if (_mndc.z < 1 && Math.abs(_mndc.x) < 1.5 && Math.abs(_mndc.y) < 1.5){
            const dist = camera.position.distanceTo(bh.position);
            const r = 0.5 * RH * s / (dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
            momentFx.lensK = Math.pow(r * 2.0, 2); momentFx.lensR = r;
            momentFx.lensX = _mndc.x * 0.5 + 0.5; momentFx.lensY = _mndc.y * 0.5 + 0.5;
          }
        }
      },
      end(){ bh.visible = false; pop.visible = false; release(); } });
  }

  /* gaze: keep the centre of the view on a glint to set its moment off */
  let found = 0, toastTimer = 0, toastHide = 0;
  function announce(m){
    let fresh = false;
    if (!m.found){ m.found = true; found++; fresh = true; }
    if (MUI.count) MUI.count.textContent = found + '/' + moments.length;
    if (MUI.hint && found === moments.length) MUI.hint.textContent = '¡los encontraste todos!';
    const el = MUI.toast; if (!el) return;
    el.querySelector('strong').textContent = m.name;
    el.querySelector('span').textContent = m.line + (fresh && found === moments.length ? ' Encontraste los 4 momentos.' : '');
    el.hidden = false; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(toastTimer); clearTimeout(toastHide);
    toastTimer = setTimeout(() => { el.classList.remove('show'); toastHide = setTimeout(() => { el.hidden = true; }, 400); }, 4500);
  }
  function startMoment(m){ m.state = 'on'; m.time = 0; m.dwell = 0; m.glint.visible = false; m.start(); announce(m); }
  const GAZE = Math.cos(THREE.MathUtils.degToRad(12)), DWELL = 0.5, REST = 6;
  function updateMoments(raw, t){
    if (echoRecord) echoRecord(performance.now() / 1000);
    momentFx.ca = 0; momentFx.lensK = 0;
    camera.updateMatrixWorld();
    camera.getWorldDirection(_mf);
    for (const m of moments){
      if (m.state === 'on'){
        m.time += raw; m.update(m.time, raw, t);
        if (m.time >= m.dur){ m.state = 'rest'; m.time = 0; m.end(); }
        continue;
      }
      if (m.state === 'rest'){ m.time += raw; if (m.time >= REST){ m.state = 'idle'; m.dwell = 0; } }
      const s = _mto.copy(m.anchor).sub(camera.position).normalize().dot(_mf);
      const near = smooth(GAZE - 0.08, GAZE, s);
      if (m.state === 'idle'){
        m.dwell = s > GAZE ? m.dwell + raw : Math.max(0, m.dwell - raw * 2);
        if (m.dwell >= DWELL){ startMoment(m); continue; }
      }
      const g = m.glint; g.visible = m.state === 'idle';
      if (g.visible){
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.6 + m.ph);
        g.material.opacity = Math.min(1, (m.found ? 0.2 : 0.4) + 0.3 * pulse + 0.5 * near);
        g.scale.setScalar(m.glint0 * (0.7 + 0.3 * pulse + 0.8 * near + 1.4 * m.dwell / DWELL));
      }
    }
  }
  if (/debug/.test(location.hash)) window.__momentos = { start: (i) => startMoment(moments[i]), list: moments };

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
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2(0.001, 0.001) }, uExposure: { value: 0.95 }, uCA: { value: 0.004 }, uSpeed: { value: 1 }, uSharp: { value: 0.22 }, uLensPos: { value: new THREE.Vector2(0.5, 0.5) }, uLensR: { value: 0 }, uLensK: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uTime, uExposure, uCA, uSpeed, uSharp, uLensR, uLensK; uniform vec2 uRes, uTexel, uLensPos;
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
  function setGyro(v){ gyro.on = v; gyro.base = null; gyro.cal = null; gyro.cur.identity(); gyro.rel.identity(); if (v) setCine(false); btnGyro.setAttribute('aria-pressed', String(v)); btnGyro.textContent = v ? 'Giroscopio activo' : 'Giroscopio'; }
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
    else if (!needsAsk) askGyro(false);   // Android: on from the start
    else renderer.domElement.addEventListener('touchend', function once(){ renderer.domElement.removeEventListener('touchend', once); if (!gyro.on) askGyro(true); });
  }
  if (location.hash.indexOf('rendimiento') >= 0) $('perf-row').hidden = false;

  /* ---------- animation loop ---------- */
  const FLOW = 11;
  const clock = new THREE.Clock();
  const sph = new THREE.Spherical(), off = new THREE.Vector3();
  let probeDrop = null;
  let t = 0, flow = 0, frame = 0, hudAcc = 0, screenAcc = 0, perfAcc = 0, perfFrames = 0, lastDrop = -99;
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
    t += dt; flow += dt * FLOW * fs;
    astro.updateMatrixWorld(true);
    if (dbg.tether) updateTether(tm);
    updateShip(t);
    updateNovas(t, dt, fs);

    pMag.position.set(Math.cos(t * 0.45) * 3.0, Math.sin(t * 0.45) * 3.0, -1.2 + Math.sin(t * 0.41) * 1.0);
    pCyan.position.set(Math.cos(t * 0.45 + Math.PI) * 3.0, Math.sin(t * 0.45 + Math.PI) * 3.0, -0.4 + Math.cos(t * 0.37) * 1.0);
    pMag.intensity = 0.6 + 0.2 * Math.sin(t * 1.3);
    pCyan.intensity = 0.6 + 0.2 * Math.cos(t * 1.1);

    tunnelMat.uniforms.uTime.value = t; tunnelMat.uniforms.uFlow.value = flow;
    dustMat.uniforms.uTime.value = t; dustMat.uniforms.uFlow.value = flow;
    streakMat.uniforms.uTime.value = t; streakMat.uniforms.uFlow.value = flow;
    streakMat.uniforms.uStreak.value = 0.6 + 1.7 * Math.min(fs, 3);

    for (const d of debris){
      if (d.captured) continue;
      const m = d.mesh;
      m.position.z += dt * FLOW * fs * d.k;
      m.rotation.x += d.spin.x * dt; m.rotation.y += d.spin.y * dt; m.rotation.z += d.spin.z * dt;
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
    if (composer){ const u = finalPass.uniforms; u.uCA.value = 0.004 + momentFx.ca; u.uLensK.value = momentFx.lensK; if (momentFx.lensK > 0){ u.uLensPos.value.set(momentFx.lensX, momentFx.lensY); u.uLensR.value = momentFx.lensR; } }
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