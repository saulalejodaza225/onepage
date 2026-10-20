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
  };
  const limbT = () => ({ u: V(0, -1, 0), f: V(0, -1, 0), c: 0, w: 0 });
  const swimPose = { k: 14, waist: [0, 0, 0], arm: { 1: limbT(), '-1': limbT() }, leg: { 1: limbT(), '-1': limbT() } };
  const grabPose = { k: 16, waist: [0, 0, 0], arm: { 1: limbT(), '-1': limbT() }, leg: swimPose.leg };
  const marvelPose = { k: 8, waist: [0, 0, 0], arm: { 1: limbT(), '-1': limbT() }, leg: swimPose.leg };

  // whole-body orientation for each manoeuvre (the fall runs toward -Z, where the ship is)
  const E = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
  const ROOT = { swim: E(-Math.PI / 2 + 0.32, Math.PI, 0), dive: E(-Math.PI / 2 + 0.04, Math.PI, 0), brake: E(-0.15, Math.PI, 0) };
  const Q_MARVEL = ROOT.swim.clone().slerp(ROOT.brake, 0.55);   // half upright, to take in the view
  const _faceObj = new THREE.Object3D();
  const MODE_NEXT = { swim: 'dive', dive: 'brake', brake: 'swim' };
  const MODE_DUR = { swim: () => 10 + rand() * 6, dive: () => 4.5 + rand() * 1.8, brake: () => 2.3 };
  const MODE_FX = { swim: 1.0, dive: 2.4, brake: 0.55 };
  const MODE_Z = { swim: 0, dive: -1.4, brake: 0.3 };
  const MODE_LABEL = { swim: 'Nadando hacia la nave', reach: 'Estirándose hacia la nave', dive: 'Caída en picada', brake: 'Posición de frenado', marvel: 'Maravillado con el paisaje', grab: 'Intenta atrapar un fragmento' };

  const anim = { mode: 'swim', modeT: reduceMotion ? 1e9 : 9, stroke: 0, kick: 0, mt: 0, moment: null, marvelT: 14, baseZ: 0, off: new THREE.Vector3(), xspin: 0, reachT: 3, reachHold: 0, reach: 0, react: null, cool: 7,
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
  // wonder: the arms open, the body straightens a little and turns to look around, the legs keep kicking
  function buildMarvel(t, rt){
    buildSwim(t, 0);
    const open = smooth(0, 0.8, rt);
    for (const s of [1, -1]){
      const A = marvelPose.arm[s];
      A.u.set(s * (0.6 + 0.25 * open), 0.2 + 0.25 * Math.sin(t * 0.8 + s), 0.45).normalize();
      A.f.set(s * 0.35, 0.65 + 0.15 * Math.sin(t * 1.1 + s), 0.6).normalize();
      A.c = 0.1; A.w = -0.25;
    }
    marvelPose.waist[0] = -0.22 * open; marvelPose.waist[1] = 0.55 * Math.sin(rt * 0.9) * open; marvelPose.waist[2] = 0.1 * Math.sin(rt * 0.7);
    return marvelPose;
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
      if (d){ const small = d.mesh.scale.x < 0.32; anim.react = !reduceMotion && small && rand() < 0.65 ? { type: 'grab', d, time: 0 } : { type: 'marvel', d: null, time: 0 }; anim.hrT = Math.min(145, anim.hrT + (small ? 14 : 4)); }
    }
    // now and then, with nothing in the way, it simply stops to admire the tunnel
    if (mode === 'swim' && !anim.react && !anim.moment){ anim.marvelT -= dt; if (anim.marvelT <= 0){ anim.react = { type: 'marvel', d: null, time: 0 }; anim.marvelT = 18 + rand() * 14; } }
    let pose, label = mode === 'swim' ? (anim.reach > 0.5 ? MODE_LABEL.reach : MODE_LABEL.swim) : MODE_LABEL[mode];
    if (anim.react){
      const R = anim.react; R.time += dt;
      const rel = R.d ? R.d.mesh.position.z - astro.position.z : 0;
      if ((R.d && rel > 1.2) || R.time > (R.type === 'marvel' ? 4.2 : 2.8) || mode !== 'swim'){ anim.react = null; anim.cool = 6 + rand() * 6; }
      else { pose = R.type === 'marvel' ? buildMarvel(t, R.time) : buildGrab(R, rel); label = MODE_LABEL[R.type]; }
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
    // during an event it turns to face it (unless it is fleeing); when marvelling it straightens up a little
    let rootT = ROOT[mode], rootRate = mode === 'brake' ? 2.6 : mode === 'dive' ? 1.5 : 1.1;
    if (anim.react && anim.react.type === 'marvel'){ rootT = Q_MARVEL; rootRate = 1.2; }
    if (anim.moment && anim.moment.cur && anim.moment.cur !== 'flee' && anim.moment.tgt){ _faceObj.position.copy(astro.position); _faceObj.lookAt(anim.moment.tgt); rootT = _faceObj.quaternion; rootRate = 1.8; }
    anim.q.slerp(rootT, 1 - Math.exp(-dt * rootRate));
    if (mode === 'dive' && !reduceMotion) anim.spin += dt * 0.55;
    else { anim.spin = Math.atan2(Math.sin(anim.spin), Math.cos(anim.spin)); anim.spin *= Math.exp(-dt * 1.2); }
    const calm = !!anim.moment || (anim.react && anim.react.type === 'marvel');
    const rollT = mode === 'swim' && !calm ? -0.5 * Math.sin(anim.stroke - 0.4) * (1 - anim.reach) : 0;   // about 30° of body roll, toward the pulling arm
    anim.roll += (rollT - anim.roll) * Math.min(1, dt * 4);
    const wv = anim.waist.x;
    // events can push the astronaut around and set it spinning; it drifts back when they let go
    anim.xspin += momentFx.astroSpin * dt;
    if (!momentFx.astroSpin){ anim.xspin = Math.atan2(Math.sin(anim.xspin), Math.cos(anim.xspin)); anim.xspin *= Math.exp(-dt * 1.0); }
    anim.off.lerp(momentFx.astro, 1 - Math.exp(-dt * 1.6));
    _e.set(-0.25 * wv.x + drift(t * 0.3, 1.1) * 0.05, anim.roll + anim.spin - 0.35 * wv.y + anim.xspin, -0.3 * wv.z + drift(t * 0.27, 2.6) * 0.05, 'XYZ');
    astro.quaternion.copy(anim.q).multiply(_qe.setFromEuler(_e));
    anim.baseZ = lerp(anim.baseZ, MODE_Z[mode], Math.min(1, dt * 0.8));
    astro.position.set(0.12 * Math.sin(t * 0.23), 0.1 * Math.sin(t * 0.29 + 1.2), anim.baseZ).add(anim.off);

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
  const GYRO_GAIN = 2.4;
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
    gyro.cur.slerp(gyro.rel, 1 - Math.exp(-raw * 14));   // a touch more smoothing, since the movement is amplified
    // the orbit pose at calibration is the reference; the phone's rotation is applied on top of it
    if (!gyro.cal){ gsph.setFromVector3(off.copy(camera.position).sub(controls.target)); gyro.cal = { r: gsph.radius, theta: gsph.theta, phi: gsph.phi }; }
    _ge.setFromQuaternion(gyro.cur, 'YXZ');
    // amplified: turning the phone by X degrees turns the view by about 2.4X, so a small tilt is enough
    gsph.set(gyro.cal.r, THREE.MathUtils.clamp(gyro.cal.phi + _ge.x * GYRO_GAIN, 0.3, 2.85), gyro.cal.theta + _ge.y * GYRO_GAIN);
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
     Five lights wait around the centre of the first view, so they can be seen from the start. Tapping a light, or
     bringing the view onto it (tilting the phone, or dragging) and holding it there for half a second, plays one of
     the ten events of its group, picked at random without repeats until the group is used up. A spent point hides
     until another point is activated. */
  const MT = controls.target.clone();
  // direction the camera looks when it orbits the astronaut at spherical angles (theta, phi)
  const viewDir = (theta, phi) => V(-Math.sin(phi) * Math.sin(theta), -Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
  const easeIO = (x) => x * x * (3 - 2 * x);
  const env = (lt, dur, a, b) => smooth(0, a, lt) * (1 - smooth(dur - b, dur, lt));   // fade in over a, out over b
  const HC = (r, g, b) => new THREE.Color(r, g, b);   // linear colour; values above 1 bloom
  const _mf = new THREE.Vector3(), _mto = new THREE.Vector3(), _mp = new THREE.Vector3(), _mv = new THREE.Vector3(), _ms = new THREE.Vector3(), _mndc = new THREE.Vector3();
  const momentFx = { ca: 0, lensK: 0, lensX: 0.5, lensY: 0.5, lensR: 0, ripX: 0.5, ripY: 0.5, ripR: 0, ripA: 0, freeze: 0, tintA: 0, tint: new THREE.Color(1, 1, 1), dim: 0,
    astro: new THREE.Vector3(), astroSpin: 0,   // push and spin the astronaut
    look: new THREE.Vector3(), lookOn: false,   // where the astronaut should look
    music: 0, beat: 0, beatN: 0,                // a musical event is playing: loudness, the current beat's punch, beat count
    flowMul: 1,                                 // speed (or direction) of the fall through the tunnel
    crack: 0, shatter: 0, crackX: 0.5, crackY: 0.5 };   // the screen breaking like glass
  const residents = [];   // creatures that stay in the tunnel after their event (the whale, the jellyfish, the school…)
  const MUI = { hint: $('moments-hint'), toast: $('moment-toast') };
  const touchUI = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  if (MUI.hint) MUI.hint.textContent = 'arrastra y sigue la flecha';

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
    { name: 'Eco temporal', line: 'Se abre una grieta en el tiempo y salen tus ecos de hace unos segundos. Al verse unos a otros, la paradoja los hace implosionar en cadena.', dur: 11.2, make(P){
      // the rift: a clock-like portal with turning ticks and a swirl inside
      const portal = newGroup();
      portal.add(new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.05, 12, 128), lit(HC(0.8, 1.8, 2.6))));
      portal.add(new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.018, 8, 128), lit(HC(0.6, 1.2, 2.2))));
      const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.16, 0.02), lit(HC(1.4, 2.0, 2.6)), 60); const dm = new THREE.Object3D();
      for (let i = 0; i < 60; i++){ const a = i / 60 * Math.PI * 2; dm.position.set(Math.cos(a) * 1.45, Math.sin(a) * 1.45, 0); dm.rotation.set(0, 0, a + Math.PI / 2); dm.scale.set(1, i % 5 ? 1 : 1.8, 1); dm.updateMatrix(); ticks.setMatrixAt(i, dm.matrix); }
      const tickRing = new THREE.Group(); tickRing.add(ticks); portal.add(tickRing);
      const swirl = []; for (let i = 0; i < 3; i++){ const s = sprite(nebulaTex, new THREE.Color().setHSL(0.55 + i * 0.08, 0.8, 0.5).multiplyScalar(1.4)); s.scale.setScalar(3.2 - i * 0.5); portal.add(s); swirl.push(s); }
      const core = sprite(novaCoreTex, HC(1.6, 2.2, 2.6)); core.scale.setScalar(1.4); portal.add(core);
      const shock = sprite(novaRingTex, HC(1.0, 1.8, 2.6)); shock.visible = false; scene.add(shock);
      /* three echoes of you, each one further back in time. They wear the real suit (same materials, same light) and replay
         what you did seconds ago, until each one notices the one before it: the most recent turns to you, the next to it, the
         oldest to the next. Every look ties a thread between their visors; the loop of looks is a paradox, and it collapses
         from the oldest echo down the chain toward the present, each echo imploding into a point. */
      const S = astro.scale.x, bb = new THREE.Box3().setFromObject(astro), HEAD = (bb.max.y - astro.position.y) * 0.8;
      const COLS = [HC(0.55, 1.7, 2.6), HC(0.6, 1.0, 2.6), HC(1.4, 0.6, 2.6)], DELAY = [1.2, 2.4, 3.6];
      const OUT = [1.0, 1.6, 2.2], SEE = [3.6, 4.7, 5.8], BOOM = [8.8, 7.9, 7.0];   // stepping out · noticing · imploding (the oldest first)
      const ALONG = [0.3, 0.52, 0.74], SIDE = [1.8, -1.6, 1.3], RISE = [0.4, 0.75, 0.3];   // where each one stands, from you toward the rift
      const echoes = COLS.map((col) => {
        const { c: ghost, dst } = cloneClean(astro);
        ghost.traverse((o) => { if (o.isMesh){ o.castShadow = false; o.receiveShadow = false; } });
        ghost.visible = false; scene.add(ghost);
        const shade = darkHalo(2.6); shade.material.opacity = 0.3; shade.visible = false; scene.add(shade);   // a little contrast against the bright tunnel
        const ring = sprite(novaRingTex, col.clone().multiplyScalar(0.55)); ring.visible = false; scene.add(ring);   // the faint ring of its own time
        const thread = pointsOf(80, 0.09, col.clone().multiplyScalar(1.5)); thread.p.visible = false; scene.add(thread.p);
        const lineG = new THREE.BufferGeometry(), linePos = new Float32Array(24 * 3); lineG.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
        const line = new THREE.Line(lineG, new THREE.LineBasicMaterial({ color: col.clone().multiplyScalar(1.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })); line.frustumCulled = false; line.visible = false; scene.add(line);
        const voidS = darkHalo(1); voidS.material.opacity = 0.9; voidS.visible = false; scene.add(voidS);
        const flash = sprite(novaCoreTex, HC(2.6, 2.4, 2.4)); flash.visible = false; scene.add(flash);
        const wave = sprite(novaRingTex, col.clone().multiplyScalar(1.8)); wave.visible = false; scene.add(wave);
        const glint = sprite(novaCoreTex, col.clone().multiplyScalar(2.2)); glint.visible = false; scene.add(glint);   // the spark in its visor as it notices
        const sparks = pointsOf(80, 0.07, col.clone().multiplyScalar(1.8)); sparks.p.visible = false; scene.add(sparks.p);
        const seed = []; for (let k = 0; k < 80; k++) seed.push(V(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(0.4 + Math.random() * 1.1));
        return { ghost, dst, shade, ring, thread, line, linePos, voidS, flash, wave, glint, sparks, seed, pos: new THREE.Vector3(), head: new THREE.Vector3(), gone: false };
      });
      const pulse = sprite(novaCoreTex, HC(2.6, 2.3, 2.6)); pulse.visible = false; scene.add(pulse);   // the collapse running down the chain
      const hitFlash = sprite(novaCoreTex, HC(2.4, 2.2, 2.6)); hitFlash.visible = false; scene.add(hitFlash);
      const home = at(P, 0, 0, 1), aim = new THREE.Object3D(), side = new THREE.Vector3(), upW = new THREE.Vector3(), tmp = new THREE.Vector3(), base = new THREE.Vector3(), youHead = new THREE.Vector3();
      const headOf = (obj, out) => out.set(0, HEAD, 0).applyQuaternion(obj.quaternion).multiplyScalar(obj.scale.y / S).add(obj.position);
      const lensAt = (p, rr) => {   // a tiny black hole where an echo collapses
        _mndc.copy(p).project(camera); if (_mndc.z > 1 || Math.abs(_mndc.x) > 1.4 || Math.abs(_mndc.y) > 1.4 || rr <= 0.001) return;
        const r = 0.5 * rr / (camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
        if (r * r * 5.76 > momentFx.lensK){ momentFx.lensK = Math.pow(r * 2.4, 2); momentFx.lensR = r; momentFx.lensX = _mndc.x * 0.5 + 0.5; momentFx.lensY = _mndc.y * 0.5 + 0.5; }
      };
      const ripAt = (p, a, r) => { _mndc.copy(p).project(camera); if (_mndc.z < 1 && a > momentFx.ripA){ momentFx.ripA = a; momentFx.ripX = _mndc.x * 0.5 + 0.5; momentFx.ripY = _mndc.y * 0.5 + 0.5; momentFx.ripR = r; } };
      return {
        start(){
          portal.position.copy(home); faceCam(portal); portal.visible = shock.visible = true;
          echoes.forEach((E) => { E.gone = false; E.ghost.visible = E.shade.visible = E.ring.visible = E.thread.p.visible = E.line.visible = E.voidS.visible = E.flash.visible = E.wave.visible = E.glint.visible = E.sparks.p.visible = true; E.ghost.scale.setScalar(0.001); });
          pulse.visible = hitFlash.visible = true;
        },
        update(lt, raw, t){
          const now = performance.now() / 1000, open = easeIO(smooth(0, 1.0, lt)) * (1 - easeIO(smooth(9.6, 10.2, lt)));
          const paradox = smooth(6.2, 6.9, lt) * (1 - smooth(9.2, 9.8, lt));
          portal.scale.setScalar(Math.max(0.001, open)); tickRing.rotation.z -= raw * (0.6 + 6 * paradox);   // the clock races backwards while the paradox lasts
          swirl.forEach((s, i) => { s.material.rotation += raw * (0.4 + i * 0.3 + 2 * paradox) * (i % 2 ? -1 : 1); s.material.opacity = 0.7 * open; });
          core.material.opacity = open * (0.7 + 0.3 * Math.sin(t * 9));
          side.set(1, 0, 0).applyQuaternion(camera.quaternion); upW.set(0, 1, 0);
          headOf(astro, youHead);
          echoes.forEach((E, i) => {
            const pred = i === 0 ? astro : echoes[i - 1].ghost, predHead = i === 0 ? youHead : echoes[i - 1].head;
            // where it stands: on the line from you to the rift, a little to the side, breathing
            base.lerpVectors(astro.position, home, ALONG[i]).addScaledVector(side, SIDE[i]).addScaledVector(upW, RISE[i] + 0.12 * Math.sin(t * 0.9 + i * 2));
            const out = easeIO(smooth(OUT[i], OUT[i] + 1.1, lt));
            E.pos.lerpVectors(home, base, out);
            // it notices the one before it: a start, a turn of the whole body, and then it stays frozen, staring
            const see = smooth(SEE[i], SEE[i] + 0.7, lt), jolt = Math.exp(-Math.pow((lt - SEE[i] - 0.25) / 0.22, 2));
            if (jolt > 0.01) E.pos.addScaledVector(tmp.copy(E.pos).sub(pred.position).normalize(), 0.3 * jolt);
            // the collapse: sucked into a point, spinning and stretching
            const kk = smooth(BOOM[i] - 0.5, BOOM[i], lt), after = smooth(BOOM[i], BOOM[i] + 0.9, lt);
            const tremble = paradox * (1 - kk) * 0.03 * Math.sin(t * 70 + i * 3);
            E.ghost.position.copy(E.pos).addScaledVector(side, tremble);
            poseAt(E.dst, now, DELAY[i] + Math.max(0, lt - SEE[i]));   // replays your past moves, and holds still once it has seen
            aim.position.copy(E.pos); aim.lookAt(pred.position); E.ghost.quaternion.slerp(aim.quaternion, see);
            if (kk > 0) E.ghost.rotateY(kk * kk * 10);
            const sc = S * Math.max(0.001, out) * Math.max(0.001, 1 - Math.pow(kk, 1.8));
            E.ghost.scale.set(sc * (1 - 0.4 * kk), sc * (1 + 0.9 * kk * (1 - kk)), sc * (1 - 0.4 * kk));
            const flick = (lt < OUT[i] + 0.45 || (kk > 0 && kk < 1)) && !reduceMotion ? Math.sin(t * 61 + i * 5) > -0.5 : true;   // unstable as it arrives and as it goes
            E.ghost.visible = !E.gone && out > 0.01 && kk < 1 && flick;
            if (kk >= 1) E.gone = true;
            headOf(E.ghost, E.head);
            const alive = out * (1 - kk);
            E.shade.position.copy(E.pos).add(tmp.copy(E.pos).sub(camera.position).normalize().multiplyScalar(0.8)); E.shade.material.opacity = 0.3 * alive;
            E.ring.position.copy(E.pos); E.ring.scale.setScalar(1.6 + 0.15 * Math.sin(t * 2 + i)); E.ring.material.opacity = 0.35 * alive; E.ring.material.rotation += raw * (0.5 + paradox * 4);
            // the visor sparks when it notices, and a thread of light ties the two visors together
            const g = Math.exp(-Math.pow((lt - SEE[i] - 0.3) / 0.18, 2)); E.glint.position.copy(E.head); E.glint.scale.setScalar(0.5 + 1.2 * g); E.glint.material.opacity = g * alive;
            const ruin = smooth(BOOM[i] + 0.35, BOOM[i] + 0.6, lt);   // the thread burns away once the collapse has run through it
            const th = smooth(SEE[i] + 0.35, SEE[i] + 0.9, lt) * (1 - ruin);
            for (let k = 0; k < 80; k++){
              const q = ((k / 80) + lt * (0.4 + paradox)) % 1;
              tmp.lerpVectors(E.head, predHead, q).addScaledVector(upW, Math.sin(q * Math.PI) * 0.18);
              E.thread.pos.set([tmp.x, tmp.y, tmp.z], k * 3);
            }
            E.thread.flush(); const flick2 = paradox > 0 ? 0.5 + 0.5 * Math.sin(t * 38 + i) : 1; E.thread.mat.opacity = th * (0.55 + 0.45 * flick2);
            for (let k = 0; k < 24; k++){ const q = k / 23; tmp.lerpVectors(E.head, predHead, q).addScaledVector(upW, Math.sin(q * Math.PI) * 0.18); E.linePos[k * 3] = tmp.x; E.linePos[k * 3 + 1] = tmp.y; E.linePos[k * 3 + 2] = tmp.z; }
            E.line.geometry.attributes.position.needsUpdate = true; E.line.material.opacity = th * (0.5 + 0.5 * flick2);
            // the implosion: darkness swallows it, a flash, a ring of light, the sparks pulled in and then thrown out
            E.voidS.position.copy(E.pos); E.voidS.scale.setScalar(Math.max(0.001, 2.6 * Math.sin(Math.PI * Math.min(1, kk * 1.05)))); E.voidS.material.opacity = 0.85 * Math.sin(Math.PI * kk);
            const f = Math.exp(-Math.pow((lt - BOOM[i]) / 0.09, 2)); E.flash.position.copy(E.pos); E.flash.scale.setScalar(0.3 + 3.2 * f); E.flash.material.opacity = f;
            E.wave.position.copy(E.pos); E.wave.scale.setScalar(0.4 + 6 * after); E.wave.material.opacity = after > 0 ? (1 - after) * 0.85 : 0;
            for (let k = 0; k < 80; k++){ const sd = E.seed[k], r = kk < 1 ? (1 - kk) * 1.1 : after * 3.2; tmp.copy(E.pos).addScaledVector(sd, r); E.sparks.pos.set([tmp.x, tmp.y, tmp.z], k * 3); }
            E.sparks.flush(); E.sparks.mat.opacity = kk > 0 ? (kk < 1 ? kk : 1 - after) * 0.95 : 0;
            if (kk > 0.15 && kk < 1) lensAt(E.pos, 0.32 * Math.sin(Math.PI * kk));
            if (after > 0 && after < 1) ripAt(E.pos, (1 - after) * 0.9, after * 0.8);
            momentFx.ca += 0.035 * f + 0.004 * kk * (1 - kk) * 4;
          });
          // the collapse runs down the threads: from each imploded echo to the one before it, and at last to you
          let pk = -1, pa = null, pb = null;
          for (let i = 2; i >= 0; i--){ const q = smooth(BOOM[i] + 0.05, BOOM[i] + 0.4, lt); if (q > 0 && q < 1){ pk = q; pa = echoes[i].pos; pb = i === 0 ? youHead : echoes[i - 1].head; } }
          pulse.visible = pk >= 0; if (pk >= 0){ pulse.position.lerpVectors(pa, pb, pk); pulse.scale.setScalar(0.8 + 0.4 * Math.sin(t * 40)); pulse.material.opacity = 1; }
          // the last of it reaches you: a flash at your visor and a shove; you are the only one left
          const hit = Math.exp(-Math.pow((lt - (BOOM[0] + 0.42)) / 0.1, 2)), shove = smooth(BOOM[0] + 0.4, BOOM[0] + 0.55, lt) * (1 - smooth(BOOM[0] + 0.8, BOOM[0] + 1.9, lt));
          hitFlash.position.copy(youHead); hitFlash.scale.setScalar(0.4 + 2.6 * hit); hitFlash.material.opacity = hit;
          if (shove > 0){ momentFx.astro.addScaledVector(tmp.copy(astro.position).sub(echoes[0].pos).normalize(), 0.6 * shove); momentFx.astroSpin += 1.6 * hit; }
          // the real you looks at its newest echo once it has noticed you, and keeps watching the chain until it is gone
          if (lt > SEE[0] - 0.4 && lt < BOOM[0] + 0.3){ momentFx.look.copy(echoes[0].pos); momentFx.lookOn = true; }
          const sk = smooth(10.0, 10.9, lt); shock.position.copy(home); shock.scale.setScalar(1 + 12 * sk); shock.material.opacity = smooth(9.95, 10.1, lt) * (1 - sk);   // the rift snaps shut
          momentFx.ca += 0.02 * (1 - smooth(0, 1.0, lt)) + 0.006 * paradox + 0.04 * hit + 0.05 * smooth(9.95, 10.1, lt) * (1 - sk);
          momentFx.dim += 0.2 * paradox;
        },
        end(){ portal.visible = shock.visible = pulse.visible = hitFlash.visible = false; echoes.forEach((E) => { E.ghost.visible = E.shade.visible = E.ring.visible = E.thread.p.visible = E.line.visible = E.voidS.visible = E.flash.visible = E.wave.visible = E.glint.visible = E.sparks.p.visible = false; }); }
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
    { name: 'Gato de Schrödinger', line: '', dur: 10, make(P, def){
      const G = newGroup();
      // a real cardboard box: fibres, packing tape, a radiation warning and a label
      const boxTex = texOf(512, 512, (g) => {
        g.fillStyle = '#b48a55'; g.fillRect(0, 0, 512, 512);
        for (let i = 0; i < 900; i++){ g.fillStyle = 'rgba(' + (Math.random() < 0.5 ? '90,60,30' : '230,200,150') + ',' + (Math.random() * 0.08) + ')'; g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 30, 1 + Math.random() * 2); }
        g.fillStyle = 'rgba(205,175,125,0.6)'; g.fillRect(0, 232, 512, 52);
        g.save(); g.translate(256, 140);
        g.fillStyle = '#f2c400'; g.beginPath(); g.moveTo(0, -72); g.lineTo(74, 56); g.lineTo(-74, 56); g.closePath(); g.fill();
        g.fillStyle = '#111'; for (let k = 0; k < 3; k++){ g.beginPath(); g.moveTo(0, 14); g.arc(0, 14, 36, -Math.PI / 2 + k * 2.094 - 0.5, -Math.PI / 2 + k * 2.094 + 0.5); g.closePath(); g.fill(); }
        g.fillStyle = '#f2c400'; g.beginPath(); g.arc(0, 14, 10, 0, 6.28); g.fill(); g.fillStyle = '#111'; g.beginPath(); g.arc(0, 14, 6, 0, 6.28); g.fill();
        g.restore();
        g.fillStyle = '#2a1a0c'; g.textAlign = 'center';
        g.font = '700 42px "IBM Plex Mono", monospace'; g.fillText('NO ABRIR', 256, 350);
        g.font = '500 24px "IBM Plex Mono", monospace'; g.fillText('CONTIENE 1 GATO (?)', 256, 392); g.fillText('↑ ESTE LADO ARRIBA', 256, 440);
      });
      const card = new THREE.MeshStandardMaterial({ color: C('#ffffff'), map: boxTex, roughness: 0.88, envMapIntensity: 0.5 });
      const boxGeo = roundedBox(1.1, 1.0, 1.1, 0.03, 8, 2);
      const box = new THREE.Mesh(boxGeo, card); G.add(box);
      const hinge = new THREE.Group(); hinge.position.set(0, 0.5, -0.55); G.add(hinge);
      const lid = new THREE.Mesh(roundedBox(1.14, 0.06, 1.14, 0.02, 6, 2), card); lid.position.set(0, 0.03, 0.57); hinge.add(lid);
      // superposition: two translucent copies of the box shiver around it until you look
      const ghosts = [HC(0.3, 1.4, 2.2), HC(2.0, 0.4, 1.6)].map((c) => { const m = new THREE.Mesh(boxGeo, holoMat(c, c.clone().multiplyScalar(1.6))); G.add(m); return m; });
      const waveRing = segsOf(96, HC(0.6, 1.6, 2.4)); G.add(waveRing.l);   // the wave function, a ring rippling around the box
      const stateTex = liveTex(512, 96);
      const stateLabel = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.45), addMat(HC(1.4, 1.4, 1.4), stateTex.tx)); stateLabel.position.set(0, 1.25, 0); G.add(stateLabel);
      const glowTop = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0).rotateX(-Math.PI / 2), addMat(HC(1.6, 2.0, 2.4))); glowTop.position.y = 0.505; G.add(glowTop);
      const rays = new THREE.Group(); rays.position.y = 0.5; G.add(rays);
      for (let i = 0; i < 8; i++){ const gg = new THREE.PlaneGeometry(0.1, 2.4); gg.translate(0, 1.2, 0); const r = new THREE.Mesh(gg, addMat(HC(0.8, 1.2, 1.6))); r.rotation.set(0, i / 8 * Math.PI, (i % 2 ? 1 : -1) * 0.18); rays.add(r); }
      const flash = sprite(novaRingTex, HC(1.4, 1.8, 2.4)); flash.position.y = 0.6; G.add(flash);
      // the cat, drawn three ways: tail left, tail right, eyes shut
      const catFrame = (tail, eyes) => texOf(512, 512, (g) => {
        g.save(); g.shadowColor = '#5ce1ff'; g.shadowBlur = 30; g.fillStyle = '#a8f4ff';
        g.beginPath(); g.moveTo(190, 470); g.bezierCurveTo(150, 380, 170, 280, 230, 250); g.bezierCurveTo(300, 230, 350, 300, 345, 380); g.bezierCurveTo(342, 430, 330, 465, 300, 470); g.closePath(); g.fill();
        g.beginPath(); g.ellipse(256, 190, 78, 68, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(196, 150); g.lineTo(200, 80); g.lineTo(245, 128); g.fill();
        g.beginPath(); g.moveTo(316, 150); g.lineTo(312, 80); g.lineTo(267, 128); g.fill();
        g.fillRect(215, 380, 26, 92); g.fillRect(262, 380, 26, 92);
        g.lineWidth = 22; g.lineCap = 'round'; g.strokeStyle = '#a8f4ff'; g.beginPath(); g.moveTo(330, 455); g.quadraticCurveTo(440, 450, 420 + tail * 40, 350 - tail * 14); g.stroke();
        g.restore();
        g.fillStyle = '#062431';
        if (eyes){ g.beginPath(); g.ellipse(226, 185, 14, 19, 0, 0, Math.PI * 2); g.ellipse(286, 185, 14, 19, 0, 0, Math.PI * 2); g.fill(); g.fillStyle = '#f4ffff'; g.beginPath(); g.ellipse(226, 185, 4, 14, 0, 0, Math.PI * 2); g.ellipse(286, 185, 4, 14, 0, 0, Math.PI * 2); g.fill(); }
        else { g.lineWidth = 4; g.strokeStyle = '#062431'; g.beginPath(); g.moveTo(212, 188); g.quadraticCurveTo(226, 196, 240, 188); g.moveTo(272, 188); g.quadraticCurveTo(286, 196, 300, 188); g.stroke(); }
        g.fillStyle = '#ff9fc8'; g.beginPath(); g.moveTo(248, 212); g.lineTo(264, 212); g.lineTo(256, 222); g.fill();
        g.strokeStyle = 'rgba(6,36,49,0.8)'; g.lineWidth = 2.5;
        for (const sd of [-1, 1]) for (let k = 0; k < 3; k++){ g.beginPath(); g.moveTo(256 + sd * 20, 220 + k * 6); g.lineTo(256 + sd * 72, 210 + k * 12); g.stroke(); }
      });
      const frames = [catFrame(0, true), catFrame(1, true), catFrame(0.5, false)];
      const qTex = texOf(256, 256, (g) => { g.fillStyle = '#ffd38a'; g.shadowColor = '#ffb04a'; g.shadowBlur = 24; g.font = '700 190px "Michroma", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 128, 136); });
      const reveal = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), addMat(HC(1.6, 1.6, 1.6), frames[0])); G.add(reveal);
      const motes = pointsOf(120, 0.06, HC(1.6, 2.0, 2.6)); G.add(motes.p);
      const ms = []; for (let i = 0; i < 120; i++) ms.push([Math.random() * 6.28, Math.random(), 0.6 + Math.random() * 1.6]);
      let alive = true;
      function drawState(lt){
        const g = stateTex.g; g.clearRect(0, 0, 512, 96); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '400 40px "Michroma", sans-serif';
        if (lt < 3.0){ const flip = Math.sin(lt * 70) > 0; g.fillStyle = flip ? '#7df3ff' : '#ff8fd8'; g.fillText(flip ? 'VIVO' : 'MUERTO', 256, 48); }   // both at once, until observed
        else { g.fillStyle = alive ? '#7df3ff' : '#ffd38a'; g.fillText(alive ? 'VIVO' : 'VACÍO', 256, 48); }
        stateTex.tx.needsUpdate = true;
      }
      let acc = 0;
      return {
        start(){
          alive = Math.random() < 0.5;
          def.line = alive ? 'Al mirarla, la función de onda colapsa: el gato está vivo… en este universo.' : 'Al mirarla, la función de onda colapsa: la caja está vacía. En otro universo, el gato te saluda.';
          G.position.copy(P.anchor); faceCam(G); G.rotateX(0.3); G.visible = true; drawState(0);
        },
        update(lt, raw, t){
          const e = env(lt, 10, 0.8, 1.0), superpos = 1 - smooth(2.8, 3.1, lt), open = easeIO(smooth(3.1, 4.1, lt));
          G.scale.setScalar(1.6 * Math.max(0.001, e));
          box.rotation.y = 0.12 * Math.sin(t * 0.8) * superpos;
          ghosts.forEach((m, i) => { const sg = i ? -1 : 1; m.position.set(sg * (0.12 + 0.06 * Math.sin(t * 23 + i)), 0.04 * Math.sin(t * 31 + i * 2), sg * 0.05 * Math.sin(t * 17)); m.material.uniforms.uFade.value = 0.8 * superpos * e; });
          for (let i = 0; i < 96; i++){ const a0 = i / 96 * 6.28, a1 = (i + 1) / 96 * 6.28, r0 = 1.05 + 0.08 * Math.sin(a0 * 8 - t * 6), r1 = 1.05 + 0.08 * Math.sin(a1 * 8 - t * 6); waveRing.pos.set([Math.cos(a0) * r0, 0, Math.sin(a0) * r0, Math.cos(a1) * r1, 0, Math.sin(a1) * r1], i * 6); }
          waveRing.flush(); waveRing.mat.opacity = 0.8 * superpos * e;
          acc += raw; if (acc > 1 / 20){ acc = 0; drawState(lt); }
          stateLabel.material.opacity = e * smooth(0.6, 1.0, lt) * (1 - smooth(7.5, 8.5, lt));
          const fk = smooth(2.9, 3.6, lt); flash.scale.setScalar(0.5 + 5 * fk); flash.material.opacity = smooth(2.9, 3.0, lt) * (1 - fk);   // the collapse
          momentFx.ca += 0.04 * smooth(2.9, 3.0, lt) * (1 - smooth(3.0, 3.5, lt));
          hinge.rotation.x = -2.0 * open;
          glowTop.material.opacity = open * e * (0.8 + 0.2 * Math.sin(t * 9));
          rays.rotation.y += raw * 0.3; rays.children.forEach((r) => { r.material.opacity = open * e * 0.35 * (1 - smooth(6.5, 8, lt)); });
          const rise = easeIO(smooth(3.6, 5.2, lt));
          reveal.visible = rise > 0.001; reveal.position.set(0, 0.35 + 1.15 * rise + 0.05 * Math.sin(t * 2), 0); reveal.scale.setScalar(0.4 + 0.6 * rise);
          reveal.material.opacity = rise * e;
          reveal.quaternion.copy(G.quaternion).invert().multiply(camera.quaternion);   // always facing you
          if (alive){ const blink = (lt % 2.6) > 2.45; reveal.material.map = blink ? frames[2] : frames[Math.floor(lt * 2.2) % 2]; }
          else reveal.material.map = qTex;
          ms.forEach((q, i) => { const k = (lt * 0.35 * q[2] + q[1]) % 1; motes.pos.set([Math.cos(q[0]) * 0.4 * (1 + k), 0.5 + k * 2.4, Math.sin(q[0]) * 0.4 * (1 + k)], i * 3); });
          motes.flush(); motes.mat.opacity = open * e * (1 - smooth(7, 9, lt));
        },
        end(){ G.visible = false; }
      };
    } },
    { name: 'Premonición', line: 'Todo va a estar bien.', dur: 10, make(P){
      const G = newGroup(), R = 1.25;
      const helmet = new THREE.Group(); G.add(helmet);
      helmet.add(new THREE.Mesh(new THREE.SphereGeometry(R, 64, 48, 0, Math.PI * 2, 0.96, Math.PI - 0.96).rotateX(Math.PI / 2), shell));   // the shell, open at the front for the visor
      const neck = new THREE.Mesh(new THREE.TorusGeometry(R * 0.72, 0.13, 16, 64).rotateX(Math.PI / 2), alu); neck.position.y = -R * 0.86; helmet.add(neck);
      for (const sd of [-1, 1]){ const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.4, 24).rotateX(Math.PI / 2), shell); lamp.position.set(sd * R * 0.98, 0.25, 0.25); helmet.add(lamp); }
      // the visor is a round window facing you: gold and mirrored at first, then it shows the premonition
      const gold = new THREE.Mesh(new THREE.CircleGeometry(R * 0.82, 96), new THREE.MeshPhysicalMaterial({ color: C('#ffcf6a'), metalness: 1, roughness: 0.06, clearcoat: 1, iridescence: 0.6, envMapIntensity: 1.8 }));
      gold.position.z = R * 0.70; helmet.add(gold);
      const L = liveTex(512, 512);
      const screen = new THREE.Mesh(new THREE.CircleGeometry(R * 0.82, 96), new THREE.MeshBasicMaterial({ map: L.tx, fog: false, transparent: true, opacity: 0 }));
      screen.position.z = R * 0.705; helmet.add(screen);
      const rimRing = new THREE.Mesh(new THREE.TorusGeometry(R * 0.83, 0.055, 12, 96), new THREE.MeshPhysicalMaterial({ color: C('#d7a640'), metalness: 1, roughness: 0.2, envMapIntensity: 1.4 })); rimRing.position.z = R * 0.716; helmet.add(rimRing);
      const shine = new THREE.Mesh(new THREE.CircleGeometry(R * 0.82, 96), addMat(HC(0.5, 0.5, 0.55), texOf(256, 256, (g) => {   // a glassy highlight across the visor
        const gr = g.createLinearGradient(40, 30, 160, 150); gr.addColorStop(0, 'rgba(255,255,255,0.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.ellipse(95, 80, 70, 30, -0.6, 0, Math.PI * 2); g.fill();
      }))); shine.position.z = R * 0.712; helmet.add(shine);
      const warm = sprite(dotTex, HC(2.0, 1.2, 0.6)); warm.scale.setScalar(7); warm.position.z = 0.4; helmet.add(warm);
      // the premonition, animated: a calm sea at sunset, and the astronaut floating in a ring with a cocktail
      function draw(lt){
        const g = L.g, S = 512;
        const sky = g.createLinearGradient(0, 0, 0, 300); sky.addColorStop(0, '#1d3f88'); sky.addColorStop(0.5, '#ef8a5a'); sky.addColorStop(1, '#ffcf8f'); g.fillStyle = sky; g.fillRect(0, 0, S, 300);
        const sun = g.createRadialGradient(330, 285, 6, 330, 285, 110); sun.addColorStop(0, '#fff7dc'); sun.addColorStop(0.35, '#ffd27a'); sun.addColorStop(1, 'rgba(255,170,90,0)'); g.fillStyle = sun; g.fillRect(200, 160, 260, 140);
        g.strokeStyle = 'rgba(40,30,60,0.7)'; g.lineWidth = 3;   // two gulls
        for (let k = 0; k < 2; k++){ const x = (lt * 30 + k * 160) % 600 - 40, y = 90 + k * 30 + Math.sin(lt * 2 + k) * 6, w = Math.sin(lt * 6 + k) * 4; g.beginPath(); g.moveTo(x - 14, y - w); g.quadraticCurveTo(x - 6, y - 8, x, y); g.quadraticCurveTo(x + 6, y - 8, x + 14, y - w); g.stroke(); }
        const sea = g.createLinearGradient(0, 290, 0, S); sea.addColorStop(0, '#3a8fb5'); sea.addColorStop(1, '#0d4c6c'); g.fillStyle = sea; g.fillRect(0, 290, S, S - 290);
        for (let i = 0; i < 18; i++){ const y = 300 + i * 9, w = 60 - i * 2, x = 330 - w / 2 + Math.sin(lt * 3 + i) * 8; g.fillStyle = 'rgba(255,230,170,' + (0.75 - i * 0.035) + ')'; g.fillRect(x, y, w * (0.6 + 0.4 * Math.sin(lt * 5 + i * 2)), 2); }   // the sun's glitter
        g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2; for (let i = 0; i < 9; i++){ const y = 320 + i * 22; g.beginPath(); for (let x = 0; x <= S; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + lt * 2 + i) * 3); g.stroke(); }
        g.fillStyle = '#10241a'; g.beginPath(); g.moveTo(0, 300); g.quadraticCurveTo(40, 270, 90, 300); g.fill();   // a little island with a palm
        g.strokeStyle = '#10241a'; g.lineWidth = 6; g.beginPath(); g.moveTo(45, 290); g.quadraticCurveTo(60, 230, 50, 190); g.stroke();
        g.fillStyle = '#10241a'; for (let i = 0; i < 6; i++){ g.save(); g.translate(50, 190); g.rotate(i * 1.05 + Math.sin(lt) * 0.05); g.beginPath(); g.ellipse(30, 0, 34, 7, 0.2, 0, Math.PI * 2); g.fill(); g.restore(); }
        // the float, bobbing
        const bob = Math.sin(lt * 1.8) * 6, fx = 230, fy = 400 + bob;
        g.fillStyle = 'rgba(0,30,50,0.4)'; g.beginPath(); g.ellipse(fx, fy + 26, 130, 22, 0, 0, Math.PI * 2); g.fill();
        for (let i = 0; i < 12; i++){ g.fillStyle = i % 2 ? '#ffffff' : '#ff5f9e'; g.beginPath(); g.moveTo(fx, fy); g.ellipse(fx, fy, 124, 40, 0, i / 12 * Math.PI * 2, (i + 1) / 12 * Math.PI * 2); g.fill(); }
        g.fillStyle = '#2b78a0'; g.beginPath(); g.ellipse(fx, fy - 2, 70, 19, 0, 0, Math.PI * 2); g.fill();
        // the astronaut, lying back
        g.fillStyle = '#f4f4f4'; g.strokeStyle = '#bfc4cc'; g.lineWidth = 3;
        g.beginPath(); g.ellipse(fx - 10, fy - 36, 56, 36, -0.3, 0, Math.PI * 2); g.fill(); g.stroke();
        g.save(); g.translate(fx + 34, fy - 40); g.rotate(0.15 + Math.sin(lt * 1.2) * 0.05); g.fillRect(0, -13, 96, 26); g.restore();   // legs over the ring
        g.fillStyle = '#c4252d'; g.fillRect(fx + 70, fy - 50, 12, 26);
        g.fillStyle = '#f4f4f4'; g.beginPath(); g.arc(fx - 62, fy - 76, 38, 0, Math.PI * 2); g.fill(); g.stroke();   // helmet
        const vis = g.createLinearGradient(fx - 84, fy - 96, fx - 40, fy - 56); vis.addColorStop(0, '#ffe39a'); vis.addColorStop(1, '#c47a1a'); g.fillStyle = vis; g.beginPath(); g.ellipse(fx - 56, fy - 76, 25, 19, -0.3, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.ellipse(fx - 64, fy - 84, 8, 4, -0.3, 0, Math.PI * 2); g.fill();
        // the arm raising the cocktail: a toast, every few seconds
        const toast = Math.max(0, Math.sin(lt * 1.6)), ang = -1.05 - 0.35 * toast;
        g.save(); g.translate(fx - 22, fy - 58); g.rotate(ang); g.fillStyle = '#f4f4f4'; g.fillRect(0, -11, 78, 22); g.restore();
        const hx = fx - 22 + Math.cos(ang) * 82, hy = fy - 58 + Math.sin(ang) * 82;
        g.fillStyle = 'rgba(220,240,255,0.85)'; g.beginPath(); g.moveTo(hx - 24, hy - 30); g.lineTo(hx + 24, hy - 30); g.lineTo(hx, hy - 2); g.fill(); g.fillRect(hx - 2, hy - 2, 4, 18); g.fillRect(hx - 13, hy + 14, 26, 4);
        g.fillStyle = '#ff8a2a'; g.beginPath(); g.moveTo(hx - 18, hy - 25); g.lineTo(hx + 18, hy - 25); g.lineTo(hx, hy - 6); g.fill();
        g.strokeStyle = '#ff3b6b'; g.lineWidth = 3; g.beginPath(); g.moveTo(hx + 6, hy - 20); g.lineTo(hx + 20, hy - 54); g.stroke();
        g.fillStyle = '#4ad1ff'; g.beginPath(); g.moveTo(hx - 34, hy - 48); g.quadraticCurveTo(hx - 16, hy - 74, hx + 2, hy - 48); g.fill();
        g.strokeStyle = '#7a5a2a'; g.lineWidth = 2; g.beginPath(); g.moveTo(hx - 16, hy - 58); g.lineTo(hx - 10, hy - 28); g.stroke();
        g.fillStyle = '#ffe14a'; g.beginPath(); g.arc(hx + 22, hy - 30, 8, 0, Math.PI * 2); g.fill();
        if (toast > 0.92){ g.fillStyle = 'rgba(255,255,255,0.95)'; for (let k = 0; k < 4; k++){ const a = k * 1.57 + lt * 4; g.fillRect(hx + 30 + Math.cos(a) * 14, hy - 60 + Math.sin(a) * 14, 4, 4); } }   // a little sparkle at the top of the toast
        // a soft circular vignette
        const vg = g.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.52); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)'); g.fillStyle = vg; g.fillRect(0, 0, S, S);
        L.tx.needsUpdate = true;
      }
      const from = new THREE.Vector3(), home = new THREE.Vector3(), away = new THREE.Vector3(), aim = new THREE.Object3D();
      let acc = 0;
      return {
        start(){ at(P, -7, 1.5, 3, from); at(P, 0, -0.3, -2.4, home); at(P, 7, 2, 4, away); G.position.copy(from); G.visible = true; draw(0); },
        update(lt, raw, t){
          // it drifts in, turns its visor toward you, shows the premonition, and drifts away
          const arrive = easeIO(smooth(0, 1.8, lt)), leave = easeIO(smooth(8.4, 10, lt));
          G.position.lerpVectors(from, home, arrive); if (leave > 0) G.position.lerp(away, leave);
          G.position.addScaledVector(P.up, 0.12 * Math.sin(t * 0.9));
          aim.position.copy(G.position); aim.lookAt(camera.position);
          const turn = easeIO(smooth(1.0, 2.4, lt)) * (1 - easeIO(smooth(8.2, 9.6, lt)));
          G.quaternion.copy(aim.quaternion); G.rotateY((1 - turn) * 2.4); G.rotateZ(0.06 * Math.sin(t * 0.7));
          G.scale.setScalar(1.75 * Math.max(0.001, env(lt, 10, 0.8, 0.8)));
          const show = smooth(2.2, 3.2, lt) * (1 - smooth(7.6, 8.6, lt));
          screen.material.opacity = show; shine.material.opacity = 0.35 + 0.25 * show; warm.material.opacity = 0.18 * show;
          acc += raw; if (acc > 1 / 30){ acc = 0; draw(lt); }
          momentFx.tint.setRGB(1.0, 0.75, 0.45); momentFx.tintA = Math.max(momentFx.tintA, 0.16 * show);   // a warm afterglow over everything
        },
        end(){ G.visible = false; }
      };
    } }

  ];

  /* ===== group 2 · creatures ===== */
  const CREATURES = [
    { name: 'El ojo del abismo', line: 'Un ojo colosal se abre en el abismo. Mira al astronauta… y luego te mira a ti.', dur: 12, make(P){
      const RE = 3.0, eye = newGroup();
      const eyeMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uDilate: { value: 1 }, uPulse: { value: 0 }, uRage: { value: 0 }, uDark: { value: 0 } },
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uTime, uDilate, uPulse, uRage, uDark; varying vec3 vP;
          void main(){
            vec3 n = normalize(vP);
            float a = acos(clamp(n.z, -1.0, 1.0)), ph = atan(n.y, n.x);
            // a sickly, bloodshot sclera, darker toward the back, its veins throbbing
            vec3 scl = mix(vec3(0.5, 0.4, 0.26), vec3(0.12, 0.03, 0.02), smoothstep(0.7, 1.45, a));
            float va = pow(1.0 - abs(sin(ph * 9.0 + sin(a * 13.0 + ph * 2.0) * 1.6)), 12.0), vb = pow(1.0 - abs(sin(ph * 23.0 - sin(a * 7.0) * 2.5)), 18.0);
            float veins = (va + vb * 0.7) * smoothstep(0.6, 0.95, a);
            vec3 col = mix(scl * 0.7, vec3(0.75, 0.02, 0.01), min(1.0, veins * (0.8 + 1.2 * uPulse)));
            // a molten iris: gold at the pupil, burning red outward, a black limbal ring
            const float R = 0.62;
            float fib = 0.55 + 0.45 * sin(ph * 90.0 + sin(ph * 17.0) * 3.0) * (0.6 + 0.4 * sin(a * 45.0 - uTime * 1.2));
            vec3 iris = mix(vec3(1.8, 0.95, 0.15), vec3(1.0, 0.05, 0.02), smoothstep(0.06, R, a)) * fib * (1.1 + 1.1 * uRage);
            iris *= 1.0 - 0.9 * smoothstep(R - 0.13, R, a);
            col = mix(col, iris, 1.0 - smoothstep(R - 0.02, R + 0.03, a));
            // the pupil: a vertical slit that narrows to a thread when it focuses, with a burning rim
            float slit = length(vec2(n.x / (0.022 + 0.2 * uDilate), n.y / 0.52));
            col = mix(col, vec3(0.0), (1.0 - smoothstep(0.85, 1.05, slit)) * step(0.0, n.z));
            col += vec3(1.6, 0.3, 0.04) * exp(-pow((slit - 1.0) * 6.0, 2.0)) * step(0.0, n.z) * (0.5 + 1.2 * uRage);
            vec2 h1 = n.xy - vec2(-0.2, 0.24), h2 = n.xy - vec2(0.18, -0.12);   // wet highlights
            col += vec3(1.0) * (exp(-dot(h1, h1) * 700.0) * 1.6 + exp(-dot(h2, h2) * 2500.0) * 0.8) * step(0.0, n.z);
            float irisM = 1.0 - smoothstep(R - 0.02, R + 0.03, a);
            col *= 1.0 - uDark * (0.92 - 0.6 * irisM);
            gl_FragColor = vec4(col, 1.0);
          }` });
      const ball = new THREE.Mesh(new THREE.SphereGeometry(RE, 72, 54), eyeMat); eye.add(ball);
      // flesh: wrinkled lids, a lumpy socket, and tendrils reaching into the gas
      const flesh = new THREE.MeshStandardMaterial({ color: C('#3a1418'), roughness: 0.42, metalness: 0, normalMap: TX.rockNormal, normalScale: new THREE.Vector2(2.2, 2.2), emissive: C('#ff2a10'), emissiveIntensity: 0.08, envMapIntensity: 0.9, side: THREE.DoubleSide, fog: false });
      const FLESH = C('#3a1418'), BLACK = C('#050102');
      const lumpy = (geo, amp, f) => { const p = geo.attributes.position, v = new THREE.Vector3(); for (let i = 0; i < p.count; i++){ v.fromBufferAttribute(p, i); const k = 1 + (fbm3(v.x * f, v.y * f, v.z * f, 4, 17) - 0.5) * amp; p.setXYZ(i, v.x * k, v.y * k, v.z * k); } geo.computeVertexNormals(); return geo; };
      const upper = new THREE.Mesh(lumpy(new THREE.SphereGeometry(RE * 1.07, 72, 24, 0, Math.PI * 2, 0, Math.PI / 2), 0.08, 2.2), flesh);
      const lower = new THREE.Mesh(lumpy(new THREE.SphereGeometry(RE * 1.07, 72, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), 0.08, 2.2), flesh);
      eye.add(upper, lower);
      const socket = new THREE.Mesh(lumpy(new THREE.TorusGeometry(RE * 1.3, RE * 0.42, 28, 120), 0.25, 1.1), flesh); socket.position.z = -RE * 0.25; eye.add(socket);
      const tendrils = new THREE.Group(); eye.add(tendrils);
      for (let i = 0; i < 14; i++){
        const a = i / 14 * Math.PI * 2 + Math.random() * 0.2, pts = [];
        for (let k = 0; k <= 6; k++){ const r = RE * 1.5 + k * 1.3, w = Math.sin(k * 0.9 + i) * 0.6; pts.push(V(Math.cos(a + w * 0.15) * r, Math.sin(a + w * 0.15) * r, -RE * 0.4 - k * 0.7)); }
        const curve = new THREE.CatmullRomCurve3(pts), tg = new THREE.TubeGeometry(curve, 48, 0.42 - i % 3 * 0.07, 10), tp = tg.attributes.position, cv = new THREE.Vector3(), pv = new THREE.Vector3();
        for (let v = 0; v < tp.count; v++){ const u = Math.floor(v / 11) / 48; curve.getPointAt(u, cv); pv.fromBufferAttribute(tp, v).sub(cv).multiplyScalar(Math.pow(1 - u, 1.4) * 0.95 + 0.05); tp.setXYZ(v, cv.x + pv.x, cv.y + pv.y, cv.z + pv.z); }
        tg.computeVertexNormals(); const tube = new THREE.Mesh(tg, flesh); tendrils.add(tube);
      }
      const redHaze = []; for (let i = 0; i < 4; i++){ const s = sprite(nebulaTex, HC(0.9, 0.08, 0.05)); s.material.rotation = Math.random() * 6; s.position.z = -RE; eye.add(s); redHaze.push(s); }
      const ring = sprite(novaRingTex, HC(1.8, 0.3, 0.15)); eye.add(ring);
      // after it sinks away it stays out there, watching: a faint red slit that sometimes opens
      const lurk = { live: false, pos: new THREE.Vector3(), next: 6, open: 0 };
      const lurkGlow = sprite(dotTex, HC(2.2, 0.25, 0.1)); lurkGlow.visible = false; scene.add(lurkGlow);
      const lurkSlit = sprite(texOf(64, 128, (g) => { const gr = g.createRadialGradient(32, 64, 2, 32, 64, 60); gr.addColorStop(0, 'rgba(255,220,120,1)'); gr.addColorStop(0.4, 'rgba(255,60,20,0.9)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.ellipse(32, 64, 9, 60, 0, 0, Math.PI * 2); g.fill(); }), HC(2, 1, 1)); lurkSlit.visible = false; scene.add(lurkSlit);
      function lurking(raw, t){
        lurk.next -= raw; if (lurk.next <= 0){ lurk.open = 1.6; lurk.next = 9 + Math.random() * 10; }
        lurk.open = Math.max(0, lurk.open - raw);
        const o = Math.sin(Math.min(1, lurk.open / 1.6) * Math.PI);
        lurkGlow.position.copy(lurk.pos); lurkGlow.scale.setScalar(3 + 2 * o); lurkGlow.material.opacity = 0.18 + 0.4 * o;
        lurkSlit.position.copy(lurk.pos); lurkSlit.scale.set(0.5, 1.4 * (0.15 + 0.85 * o), 1); lurkSlit.material.opacity = 0.25 + 0.75 * o;
      }
      const aim = new THREE.Object3D(), look = new THREE.Vector3(), sac = new THREE.Vector2(), home = new THREE.Vector3(), deep = new THREE.Vector3(), Zf = V(0, 0, 1), qb = new THREE.Quaternion();
      let sacT = 0;
      return {
        start(){
          lurkGlow.visible = lurkSlit.visible = false;
          home.copy(P.anchor).addScaledVector(P.out, 2); deep.copy(P.anchor).addScaledVector(P.out, 38).addScaledVector(P.up, -3);
          eye.position.copy(lurk.live ? deep : home); eye.visible = true;
          aim.position.copy(eye.position); aim.lookAt(camera.position); eye.quaternion.copy(aim.quaternion);
        },
        update(lt, raw, t){
          // rises out of the depths, opens, stares at the astronaut, then turns its gaze on you; squints, and sinks away
          const rise = easeIO(smooth(0, 1.6, lt)), sink = easeIO(smooth(9.0, 12, lt));
          eye.position.lerpVectors(lurk.live ? deep : home, home, rise); if (sink > 0) eye.position.lerp(deep, sink);
          eye.scale.setScalar(Math.max(0.001, lerp(0.3, 1, rise) * (1 - 0.6 * sink)));
          aim.position.copy(eye.position); aim.lookAt(camera.position); eye.quaternion.slerp(aim.quaternion, 1 - Math.exp(-raw * 3));
          let open = smooth(1.0, 2.0, lt) * (1 - 0.55 * smooth(7.6, 8.4, lt)) * (1 - smooth(10.2, 11.2, lt));
          open *= 1 - 0.95 * Math.max(0, 1 - Math.abs(lt - 4.4) / 0.12);   // one fast blink before it looks at you
          upper.rotation.x = -open * 1.2; lower.rotation.x = open * 1.2;
          // where the pupil points: the astronaut first, then the camera (you)
          const atYou = smooth(4.4, 4.9, lt);
          look.copy(astro.position).lerp(camera.position, atYou);
          eye.worldToLocal(_mp.copy(look)).normalize();
          sacT -= raw; if (sacT <= 0){ sacT = 0.25 + Math.random() * 0.5; sac.set((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05); }
          _mp.x += sac.x; _mp.y += sac.y; _mp.normalize();
          qb.setFromUnitVectors(Zf, _mp); ball.quaternion.slerp(qb, 1 - Math.exp(-raw * 9));
          eyeMat.uniforms.uTime.value = t;
          const focus = smooth(2.0, 2.6, lt), stare = smooth(4.9, 5.4, lt);
          eyeMat.uniforms.uDilate.value = lerp(1, 0.08, focus) + 0.9 * Math.max(0, 1 - Math.abs(lt - 4.75) / 0.25) - 0.05 * stare;   // it dilates for an instant when it finds you
          const beat = Math.pow(Math.max(0, Math.sin(t * (4 + 4 * stare))), 8);
          eyeMat.uniforms.uPulse.value = beat; eyeMat.uniforms.uRage.value = 0.3 * focus + 0.7 * stare;
          flesh.emissiveIntensity = (0.06 + 0.25 * beat * focus) * (1 - sink); flesh.color.copy(FLESH).lerp(BLACK, sink); eyeMat.uniforms.uDark.value = sink;
          tendrils.rotation.z = 0.05 * Math.sin(t * 0.7); tendrils.children.forEach((c, i) => { c.rotation.z = 0.06 * Math.sin(t * 1.3 + i); c.rotation.x = 0.08 * Math.sin(t * 0.9 + i * 1.7) + 0.3 * sink; });   // they writhe, and fold back as it sinks
          redHaze.forEach((s, i) => { s.scale.setScalar(RE * (4 + i) * (1 + 0.15 * beat)); s.material.opacity = 0.35 * rise * (1 - sink); s.material.rotation += raw * 0.03 * (i % 2 ? 1 : -1); });
          const rk = smooth(0.9, 2.6, lt); ring.scale.setScalar(RE * (1.4 + 5 * rk)); ring.material.opacity = (1 - rk) * 0.8;
          // when it stares at you the light turns red and the world closes in
          momentFx.tint.setRGB(1.0, 0.25, 0.2); momentFx.tintA = Math.max(momentFx.tintA, 0.3 * stare * (1 - sink) + 0.12 * focus * (1 - sink));
          momentFx.dim += (0.25 + 0.3 * stare) * (1 - sink) * rise; momentFx.ca += 0.015 * focus * (1 - sink) + 0.04 * beat * stare * (1 - sink);
          momentFx.look.copy(eye.position); momentFx.lookOn = true;
          momentFx.astro.addScaledVector(_ms.copy(eye.position).sub(astro.position).normalize(), 0.5 * focus * (1 - atYou) * (1 - sink));   // it draws the astronaut toward it, then lets go
        },
        end(){
          eye.visible = false;
          lurk.pos.copy(deep); lurkGlow.visible = lurkSlit.visible = true;
          if (!lurk.live){ lurk.live = true; residents.push(lurking); }
        }
      };
    } },
    { name: 'Ballena de plasma', line: 'Un leviatán de luz emerge de las profundidades… y se queda nadando a tu alrededor.', dur: 12, make(P){
      const G = newGroup(), Lw = 6, prof = [];
      for (let i = 0; i <= 48; i++){ const s = i / 48; prof.push(V2(0.02 + 0.95 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.08)), 0.7) * (1 - 0.72 * s), s * Lw - Lw / 2)); }
      // living colour: hues drift along the body in bands, bright at the rim; the whole body undulates
      const mat = new THREE.ShaderMaterial({
        uniforms: { uFade: { value: 0 }, uTime: { value: 0 }, uBeat: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `uniform float uTime, uBeat; varying vec3 vN; varying vec3 vV; varying float vS; varying vec3 vP;
          void main(){ vec3 p = position; float s = clamp((3.0 - p.z) / 6.0, 0.0, 1.0); vS = s; vP = p;
            p.y += sin(p.z * 0.9 + uTime * 1.8) * 0.35 * s * s;
            p.xy *= 1.0 + 0.08 * uBeat;   // it swells on every beat
            vec4 mv = modelViewMatrix * vec4(p, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform float uFade, uTime, uBeat; varying vec3 vN; varying vec3 vV; varying float vS; varying vec3 vP;
          vec3 hsv(float h, float s, float v){ vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); return v * mix(vec3(1.0), k, s); }
          void main(){
            float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
            float hue = fract(vS * 0.9 - uTime * 0.06 + f * 0.25);
            float bands = 0.55 + 0.45 * sin(vS * 46.0 - uTime * 2.4);
            float spots = pow(max(0.0, sin(vP.x * 9.0 + uTime) * sin(vP.y * 7.0 - uTime * 0.7) * sin(vP.z * 5.0)), 6.0) * 3.0;
            vec3 c = hsv(hue, 0.75, 1.0) * (0.08 + 2.0 * f * f) * bands + hsv(fract(hue + 0.5), 0.6, 1.0) * spots * (0.6 + 1.4 * uBeat);
            gl_FragColor = vec4(c * uFade * (1.0 + 1.3 * uBeat), 1.0);
          }` });
      G.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 64).rotateX(-Math.PI / 2), mat));   // head toward +Z
      const fl = new THREE.Shape(); fl.moveTo(0, 0); fl.quadraticCurveTo(1.2, 0.2, 1.6, 1.0); fl.quadraticCurveTo(0.6, 0.5, 0, 0.38); fl.quadraticCurveTo(-0.6, 0.5, -1.6, 1.0); fl.quadraticCurveTo(-1.2, 0.2, 0, 0);
      G.add(new THREE.Mesh(new THREE.ShapeGeometry(fl, 16).rotateX(-Math.PI / 2).translate(0, 0, -2.95), mat));
      for (const sd of [-1, 1]){
        const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.quadraticCurveTo(sd * 1.0, -0.3, sd * 2.2, -1.1); fin.quadraticCurveTo(sd * 1.2, -0.4, 0, -0.5); fin.lineTo(0, 0);
        G.add(new THREE.Mesh(new THREE.ShapeGeometry(fin, 16).rotateX(-Math.PI / 2 + 0.3).translate(sd * 0.55, -0.15, 1.3), mat));
      }
      const WAKE = 700, wgeo = new THREE.BufferGeometry(), wp = new Float32Array(WAKE * 3), wc = new Float32Array(WAKE * 3), tc = new THREE.Color();
      for (let i = 0; i < WAKE; i++){ tc.setHSL(Math.random(), 0.9, 0.6).multiplyScalar(1.6); wc[i * 3] = tc.r; wc[i * 3 + 1] = tc.g; wc[i * 3 + 2] = tc.b; }
      wgeo.setAttribute('position', new THREE.BufferAttribute(wp, 3)); wgeo.setAttribute('color', new THREE.BufferAttribute(wc, 3));
      const wmat = new THREE.PointsMaterial({ size: 0.16, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const wake = new THREE.Points(wgeo, wmat); wake.frustumCulled = false; scene.add(wake); wake.visible = false;
      const wseed = []; for (let i = 0; i < WAKE; i++) wseed.push([Math.random(), (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2]);
      const songs = []; for (let i = 0; i < 6; i++){ const r = sprite(novaRingTex, new THREE.Color().setHSL(i / 6, 0.9, 0.6).multiplyScalar(1.6)); r.visible = false; scene.add(r); songs.push({ r, t0: -99 }); }
      const past = []; for (let i = 0; i < 120; i++) past.push(new THREE.Vector3());
      // it keeps circling the whole scene, a lap about every minute, rising and sinking as it goes
      const SCALE = 2.8, R = 12.5, W = 0.105;
      const orbit = (T, out) => { const a = T * W; return out.set(Math.cos(a) * R, 2.4 * Math.sin(a * 2) + 1.2 * Math.sin(a * 0.7), Math.sin(a) * R * 0.85).add(MT); };
      const W8 = { live: false, T: 0, intro: 0, time: 0, spin: 0, lastBeat: -1, si: 0, from: new THREE.Vector3(), ctrl: new THREE.Vector3(), fade: 0 };
      const next = new THREE.Vector3(), cur = new THREE.Vector3(), orb = new THREE.Vector3(), aimW = new THREE.Object3D(), headQ = new THREE.Quaternion();
      // its entrance: out of the depths, a slow pass right across your view, then it joins its orbit
      const bez = (k, end, out) => out.copy(W8.from).multiplyScalar((1 - k) * (1 - k)).addScaledVector(W8.ctrl, 2 * (1 - k) * k).addScaledVector(end, k * k);
      function sing(t){ const S = songs[W8.si++ % songs.length]; S.t0 = t; G.localToWorld(S.r.position.set(0, 0, 3.2)); S.r.visible = true; }
      function step(raw, t){   // runs every frame for as long as the page is open
        W8.T += raw; W8.intro = Math.min(1, W8.intro + raw / 9); W8.fade = Math.min(1, W8.fade + raw / 2);
        const k = easeIO(W8.intro);
        orbit(W8.T, orb); orbit(W8.T + 0.6, next);
        if (k < 1){ bez(k, orb, cur); if (k < 0.97) bez(Math.min(1, k + 0.03), orb, next); } else cur.copy(orb);
        G.position.copy(cur); aimW.position.copy(cur); aimW.lookAt(next); headQ.slerp(aimW.quaternion, 1 - Math.exp(-raw * 2.5)); G.quaternion.copy(headQ);
        // music: when a musical event plays and the whale is in view, it dances — brighter, faster, a barrel roll, a song on every beat
        _mndc.copy(G.position).project(camera);
        const inView = _mndc.z < 1 && Math.abs(_mndc.x) < 1.2 && Math.abs(_mndc.y) < 1.2 ? 1 : 0, react = momentFx.music * inView;
        if (react > 0.3) W8.spin += raw * 2.4; else { W8.spin = Math.atan2(Math.sin(W8.spin), Math.cos(W8.spin)) * Math.exp(-raw * 0.8); }
        G.rotateZ(0.3 * Math.sin(W8.T * 0.5) + W8.spin);
        W8.time += raw * (1 + 2.5 * react);
        mat.uniforms.uTime.value = W8.time; mat.uniforms.uBeat.value = momentFx.beat * react; mat.uniforms.uFade.value = W8.fade;
        if (react > 0.3 && momentFx.beatN !== W8.lastBeat){ W8.lastBeat = momentFx.beatN; sing(t); }
        G.scale.setScalar(SCALE);
        G.localToWorld(_ms.set(0, 0, -3.2)); const last = past.pop(); last.copy(_ms); past.unshift(last);
        for (let i = 0; i < WAKE; i++){ const q = wseed[i], p = past[Math.min(119, (q[0] * 119) | 0)], spread = 0.4 + q[0] * 3.5; wp[i * 3] = p.x + q[1] * spread; wp[i * 3 + 1] = p.y + q[2] * spread + q[0] * 1.5; wp[i * 3 + 2] = p.z + q[1] * q[2] * spread; }
        wgeo.attributes.position.needsUpdate = true; wmat.opacity = 0.9 * W8.fade * (1 + momentFx.beat * react);
        songs.forEach((S) => { const q = (t - S.t0) / 2.4; if (q < 0 || q > 1){ S.r.material.opacity = 0; return; } S.r.scale.setScalar(2 + 22 * q); S.r.material.opacity = (1 - q) * 0.7; });
        // when it swims close, its current pushes the astronaut aside
        _mp.copy(astro.position).sub(G.position); const d = _mp.length();
        if (d < 9) momentFx.astro.addScaledVector(_mp.normalize(), (9 - d) / 9 * 1.1);
      }
      return {
        start(t){
          if (!W8.live){
            W8.live = true; G.visible = wake.visible = true;
            W8.T = Math.atan2((P.anchor.z - MT.z) / 0.85, P.anchor.x - MT.x) / W;   // it joins its orbit near where you saw it
            // it comes in from the side and crosses your whole view broadside, so you see all of it, then curves into its orbit
            camera.getWorldDirection(_ms); _mv.set(1, 0, 0).applyQuaternion(camera.quaternion);
            W8.from.copy(camera.position).addScaledVector(_ms, 30).addScaledVector(_mv, -36).add(_mf.set(0, -5, 0)); past.forEach((p) => p.copy(W8.from)); W8.intro = 0; W8.fade = 0;
            _mp.copy(camera.position).addScaledVector(_ms, 25).add(_mf.set(0, 1.5, 0));
            orbit(W8.T + 9, cur); W8.ctrl.copy(_mp).multiplyScalar(2).addScaledVector(W8.from, -0.5).addScaledVector(cur, -0.5);
            aimW.position.copy(W8.from); aimW.lookAt(_mp); headQ.copy(aimW.quaternion);
            residents.push(step);
          }
        },
        update(lt, raw, t){
          if (lt > 2.5 && lt < 10 && Math.floor(lt / 2.2) !== Math.floor((lt - raw) / 2.2)) sing(t);   // it sings as it arrives
          momentFx.look.copy(G.position); momentFx.lookOn = true;
          momentFx.tint.setHSL((t * 0.05) % 1, 0.8, 0.6); momentFx.tintA = Math.max(momentFx.tintA, 0.18 * env(lt, 12, 2, 2));
        },
        end(){}   // it stays
      };
    } },
    { name: 'Medusas estelares', line: 'Un grupo de medusas bioluminiscentes se queda flotando por todo el túnel.', dur: 10, make(P){
      // each jellyfish wanders its own slow loop around the whole scene, bell first, tentacles trailing
      const J = 7, T8 = 8, SEG = 11, bellGeo = new THREE.SphereGeometry(0.55, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      const lines = segsOf(J * T8 * SEG, HC(1.6, 0.6, 1.8)); lines.l.visible = false; scene.add(lines.l);
      const jellies = [];
      for (let j = 0; j < J; j++){
        const hue = 0.78 + j * 0.035, m = holoMat(new THREE.Color().setHSL(hue, 0.9, 0.35), new THREE.Color().setHSL(hue + 0.08, 0.9, 0.6).multiplyScalar(2));
        const b = new THREE.Mesh(bellGeo, m); b.visible = false; scene.add(b);
        const glowS = sprite(dotTex, new THREE.Color().setHSL(hue, 0.9, 0.6).multiplyScalar(1.4)); glowS.visible = false; scene.add(glowS);
        jellies.push({ b, m, glowS, R: 6 + Math.random() * 6, W: (0.05 + Math.random() * 0.05) * (j % 2 ? 1 : -1), a: Math.random() * 6.28, h: (Math.random() - 0.5) * 6, tilt: (Math.random() - 0.5) * 0.8, ph: Math.random() * 6.28, s: 0.7 + Math.random() * 0.7, pos: new THREE.Vector3(), vel: new THREE.Vector3(0, 1, 0), from: new THREE.Vector3() });
      }
      const route = (q, a, out) => out.set(Math.cos(a) * q.R, q.h + Math.sin(a * 2 + q.ph) * 1.6 + Math.sin(a) * q.tilt * q.R * 0.3, Math.sin(a) * q.R).add(MT);
      const st = { live: false, intro: 0, fade: 0 }, qd = new THREE.Quaternion(), tmp = new THREE.Vector3(), Y = V(0, 1, 0);
      function step(raw, t){
        st.intro = Math.min(1, st.intro + raw / 6); st.fade = Math.min(1, st.fade + raw / 1.5);
        const k = easeIO(st.intro); let n = 0;
        jellies.forEach((q) => {
          const pulse = Math.pow(0.5 + 0.5 * Math.sin(t * 2.2 + q.ph), 3);
          q.a += raw * q.W * (1 + 2.5 * pulse);   // it surges with each contraction of the bell
          route(q, q.a, tmp); if (k < 1) tmp.lerpVectors(q.from, tmp, k);
          q.vel.copy(tmp).sub(q.pos); if (q.vel.lengthSq() > 1e-8) q.vel.normalize(); q.pos.copy(tmp);
          q.b.position.copy(q.pos); q.b.quaternion.slerp(qd.setFromUnitVectors(Y, q.vel), 1 - Math.exp(-raw * 2));
          const sc = q.s * (1 + 0.6 * momentFx.beat * momentFx.music);   // they pulse to the music too
          q.b.scale.set(sc * (1 - 0.18 * pulse), sc * (1 + 0.25 * pulse), sc * (1 - 0.18 * pulse));
          q.m.uniforms.uFade.value = st.fade * (1 + momentFx.beat * momentFx.music);
          q.glowS.position.copy(q.pos); q.glowS.scale.setScalar(1.6 * q.s); q.glowS.material.opacity = 0.35 * st.fade;
          // tentacles hang from the rim and trail behind the motion, waving
          _mv.set(1, 0, 0).applyQuaternion(q.b.quaternion); _ms.set(0, 0, 1).applyQuaternion(q.b.quaternion);
          for (let kk = 0; kk < T8; kk++){
            const ang = kk / T8 * Math.PI * 2, r0 = 0.45 * q.s;
            let px = q.pos.x + (_mv.x * Math.cos(ang) + _ms.x * Math.sin(ang)) * r0, py = q.pos.y + (_mv.y * Math.cos(ang) + _ms.y * Math.sin(ang)) * r0, pz = q.pos.z + (_mv.z * Math.cos(ang) + _ms.z * Math.sin(ang)) * r0;
            for (let sg = 0; sg < SEG; sg++){
              const w = Math.sin(t * 2 + sg * 0.6 + kk) * 0.05 * sg, len = 0.17 * q.s;
              const nx = px - q.vel.x * len + _mv.x * w, ny = py - q.vel.y * len + _mv.y * w, nz = pz - q.vel.z * len + _mv.z * w;
              lines.pos.set([px, py, pz, nx, ny, nz], n * 6); n++; px = nx; py = ny; pz = nz;
            }
          }
          // a gentle bump if one drifts into the astronaut
          tmp.copy(astro.position).sub(q.pos); const d = tmp.length(); if (d < 2.5) momentFx.astro.addScaledVector(tmp.normalize(), (2.5 - d) * 0.25);
        });
        lines.flush(); lines.mat.opacity = 0.7 * st.fade;
      }
      return {
        start(){
          if (st.live) return;
          st.live = true; lines.l.visible = true;
          jellies.forEach((q, i) => { q.from.copy(at(P, (i - 3) * 1.4, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2)); q.pos.copy(q.from); q.b.visible = q.glowS.visible = true; q.a = Math.atan2(P.anchor.z - MT.z, P.anchor.x - MT.x) + (Math.random() - 0.5); });
          residents.push(step);
        },
        update(lt){ momentFx.look.copy(jellies[0].pos); momentFx.lookOn = true; },
        end(){}   // they stay
      };
    } },
    { name: 'Cardumen de cristal', line: 'Un cardumen de peces de vidrio gira en remolino… y se queda nadando por todo el túnel.', dur: 10, make(P){
      const prof = []; for (let i = 0; i <= 18; i++){ const s = i / 18; prof.push(V2(0.001 + 0.105 * Math.sin(Math.PI * Math.pow(s, 0.75)) * (1 - 0.3 * s), s * 0.62 - 0.31)); }
      const bodyG = new THREE.LatheGeometry(prof, 14).rotateX(-Math.PI / 2); bodyG.scale(0.55, 1, 1);
      const tail = new THREE.Shape(); tail.moveTo(0, 0); tail.lineTo(0.2, 0.13); tail.lineTo(0.15, 0); tail.lineTo(0.2, -0.13); tail.lineTo(0, 0);
      const tailG = new THREE.ShapeGeometry(tail).rotateY(Math.PI / 2).translate(0, 0, -0.27);
      const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(-0.12, 0.09); fin.lineTo(-0.16, 0); fin.lineTo(0, 0);
      const finG = new THREE.ShapeGeometry(fin).rotateY(Math.PI / 2).translate(0, 0.07, 0.02);
      [bodyG, tailG, finG].forEach((g) => { Object.keys(g.attributes).forEach((k) => { if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k); }); });
      const fishG = THREE.BufferGeometryUtils.mergeBufferGeometries([bodyG, tailG, finG]) || bodyG;
      const mat = new THREE.MeshPhysicalMaterial({ color: C('#e4f7ff'), metalness: 0.3, roughness: 0.04, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.55, emissive: C('#2a6bd8'), emissiveIntensity: 0.3, envMapIntensity: 2.6, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
      const N = 150, fish = new THREE.InstancedMesh(fishG, mat, N); fish.visible = false; fish.frustumCulled = false; scene.add(fish);
      const tint = new THREE.Color(), F = [];
      for (let i = 0; i < N; i++){
        const n = V(Math.random() - 0.5, 1.5 + Math.random(), Math.random() - 0.5).normalize(), u = new THREE.Vector3().crossVectors(n, V(1, 0, 0.3)).normalize(), v = new THREE.Vector3().crossVectors(n, u);
        F.push({ u, v, r: 0.5 + Math.pow(Math.random(), 0.7) * 1.4, a: Math.random() * 6.28, sp: (1.4 + Math.random() * 0.8), ph: Math.random() * 6.28, s: 0.8 + Math.random() * 0.5, lag: Math.random() * 0.25 });
        tint.setHSL(0.5 + Math.random() * 0.4, 0.5, 0.75); fish.setColorAt(i, tint);
      }
      // the school's centre follows a long, tilted loop through the whole scene; each fish swirls around it
      const R = 9.5, W = 0.16;
      const route = (T, out) => { const a = T * W; return out.set(Math.cos(a) * R, 3 * Math.sin(a * 1.5), Math.sin(a) * R * 0.75 + 2 * Math.cos(a * 2)).add(MT); };
      const st = { live: false, T: 0, intro: 0, fade: 0, scatter: 0 }, from = new THREE.Vector3(), c = new THREE.Vector3(), c2 = new THREE.Vector3(), dir = new THREE.Vector3(), p = new THREE.Vector3(), tg = new THREE.Vector3(), away = new THREE.Vector3(), dummy = new THREE.Object3D();
      function step(raw, t){
        st.T += raw; st.intro = Math.min(1, st.intro + raw / 7); st.fade = Math.min(1, st.fade + raw / 1.5);
        const k = easeIO(st.intro);
        route(st.T, c); route(st.T + 0.3, c2); if (k < 1){ c.lerpVectors(from, c, k); c2.lerpVectors(from, c2, Math.min(1, k + 0.02)); }
        dir.copy(c2).sub(c); if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0); dir.normalize();
        // near the astronaut the school parts around it like a startled shoal
        away.copy(c).sub(astro.position); const dA = away.length(); st.scatter += ((dA < 4 ? 1 : 0) - st.scatter) * Math.min(1, raw * 3); away.normalize();
        const tight = lerp(2.2, 1, k);
        F.forEach((f, i) => {
          f.a += raw * f.sp;
          const ca = Math.cos(f.a), sa = Math.sin(f.a), r = f.r * tight * (1 + 1.6 * st.scatter);
          p.copy(c).addScaledVector(dir, -f.lag * 6).addScaledVector(f.u, ca * r).addScaledVector(f.v, sa * r);
          tg.copy(dir).multiplyScalar(2.2).addScaledVector(f.u, -sa * 0.6).addScaledVector(f.v, ca * 0.6);
          dummy.position.copy(p); dummy.lookAt(_mp.copy(p).add(tg));
          dummy.rotateY(Math.sin(t * 14 + f.ph) * 0.25);
          dummy.scale.setScalar(f.s * st.fade * 2.6); dummy.updateMatrix(); fish.setMatrixAt(i, dummy.matrix);
        });
        fish.instanceMatrix.needsUpdate = true;
        mat.emissiveIntensity = 0.25 + 0.25 * Math.max(0, Math.sin(t * 2.3)) + 0.8 * momentFx.beat * momentFx.music;   // flashes to the music
        if (dA < 3) momentFx.astro.addScaledVector(away, -(3 - dA) * 0.15);
      }
      return {
        start(){
          if (st.live) return;
          st.live = true; fish.visible = true; from.copy(P.anchor);
          st.T = Math.atan2((P.anchor.z - MT.z) / 0.75, P.anchor.x - MT.x) / W;
          residents.push(step);
        },
        update(lt){ momentFx.look.copy(c); momentFx.lookOn = true; },
        end(){}   // they stay
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
    { name: 'Mano gigante', line: 'Una mano colosal surge de las profundidades, recoge al astronauta en su palma… y lo devuelve a su viaje.', dur: 15, make(P){
      const G = newGroup();
      const skin = new THREE.MeshPhysicalMaterial({ color: C('#a8857a'), roughness: 0.55, metalness: 0, sheen: 0.8, sheenRoughness: 0.45, sheenColor: C('#ffd2cc'), normalMap: TX.fabricNormal, normalScale: new THREE.Vector2(0.3, 0.3), envMapIntensity: 0.55 });
      const nail = new THREE.MeshPhysicalMaterial({ color: C('#e8d6cf'), roughness: 0.25, clearcoat: 1, envMapIntensity: 0.8 });
      const rim = holoMat(HC(0.3, 0.12, 0.5), HC(0.9, 0.45, 1.4));
      function build(mat, withNails){
        const root = new THREE.Group(), joints = [];
        const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat); palm.scale.set(1.08, 1.22, 0.36); palm.position.y = 0.05; root.add(palm);
        const heel = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 20), mat); heel.scale.set(1.5, 0.7, 0.55); heel.position.set(-0.2, -1.0, 0.05); root.add(heel);
        const seg = (len, r0, r1) => { const g = new THREE.CylinderGeometry(r1, r0, len, 24, 1); g.translate(0, len / 2, 0); return g; };
        [[-0.74, 1.0, 0.62, 0.42, 0.235], [-0.25, 1.1, 0.7, 0.46, 0.25], [0.25, 1.02, 0.66, 0.44, 0.24], [0.72, 0.8, 0.5, 0.36, 0.2]].forEach(([x, l1, l2, l3, r]) => {
          const base = new THREE.Group(); base.position.set(x, 1.05 - Math.abs(x) * 0.12, 0); root.add(base);
          base.add(new THREE.Mesh(new THREE.SphereGeometry(r * 1.12, 24, 16), mat));
          let parent = base; const lens = [l1, l2, l3], chain = [];
          lens.forEach((L, k) => {
            const j = new THREE.Group(); if (k) j.position.y = lens[k - 1]; parent.add(j);
            const rr = r * Math.pow(0.88, k);
            j.add(new THREE.Mesh(seg(L, rr, rr * 0.9), mat));
            const cap = new THREE.Mesh(new THREE.SphereGeometry(rr * 0.92, 20, 14), mat); cap.position.y = L; j.add(cap);
            if (withNails && k === 2){ const n = new THREE.Mesh(new THREE.SphereGeometry(rr * 0.8, 20, 12), nail); n.scale.set(0.9, 1.1, 0.35); n.position.set(0, L * 0.72, -rr * 0.72); j.add(n); }
            chain.push(j); parent = j;
          });
          joints.push(chain);
        });
        const tb = new THREE.Group(); tb.position.set(-1.05, -0.45, 0.15); tb.rotation.set(0.2, 0, 0.9); root.add(tb);
        tb.add(new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 16), mat));
        let parent = tb; const tl = [0.75, 0.55, 0.42], thumb = [];
        tl.forEach((L, k) => { const j = new THREE.Group(); if (k) j.position.y = tl[k - 1]; parent.add(j); const rr = 0.3 * Math.pow(0.9, k); j.add(new THREE.Mesh(seg(L, rr, rr * 0.9), mat)); const cap = new THREE.Mesh(new THREE.SphereGeometry(rr * 0.92, 20, 14), mat); cap.position.y = L; j.add(cap); if (withNails && k === 2){ const n = new THREE.Mesh(new THREE.SphereGeometry(rr * 0.8, 20, 12), nail); n.scale.set(0.9, 1.1, 0.35); n.position.set(0, L * 0.7, -rr * 0.72); j.add(n); } thumb.push(j); parent = j; });
        joints.push(thumb);
        const wrist = new THREE.Mesh(seg(7, 0.82, 0.62), mat); wrist.rotation.x = Math.PI; wrist.position.y = -1.0; wrist.scale.set(1, 1, 0.62); root.add(wrist);
        return { root, joints };
      }
      const H = build(skin, true), Hr = build(rim, false);
      Hr.root.scale.setScalar(1.035); H.root.add(Hr.root); G.add(H.root);
      const haze = []; for (let i = 0; i < 6; i++){ const s = sprite(nebulaTex, new THREE.Color().setHSL(0.75 + i * 0.03, 0.7, 0.45)); s.material.rotation = Math.random() * 6; s.position.set(0, -4 - i * 1.2, -0.5); G.add(s); haze.push(s); }
      const glowPalm = sprite(dotTex, HC(1.4, 1.0, 0.9)); glowPalm.position.set(0, 0.2, 0.9); G.add(glowPalm);   // warm light cupped in the palm
      const ripples = []; for (let i = 0; i < 4; i++){ const r = sprite(novaRingTex, HC(1.2, 0.9, 1.8)); r.visible = false; scene.add(r); ripples.push({ r, t0: -9 }); }
      // the hand works in the camera's frame: it comes up from below the astronaut, palm up, fingers pointing away from you
      const fwd = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3(), basis = new THREE.Matrix4(), q0 = new THREE.Quaternion();
      const home = new THREE.Vector3(), deep = new THREE.Vector3(), lift = new THREE.Vector3();
      const SCALE = 1.45;
      return {
        start(){
          camera.getWorldDirection(fwd); fwd.y *= 0.3; fwd.normalize(); up.set(0, 1, 0).applyQuaternion(camera.quaternion); up.addScaledVector(fwd, -up.dot(fwd)).normalize(); right.crossVectors(fwd, up).normalize();
          basis.makeBasis(right, fwd, up); q0.setFromRotationMatrix(basis);   // local +Y (fingers) → away from you, local +Z (palm) → up
          home.copy(astro.position).addScaledVector(up, -1.35).addScaledVector(fwd, -1.0);
          deep.copy(home).addScaledVector(up, -16).addScaledVector(fwd, 6);
          G.visible = true; G.position.copy(deep); G.quaternion.copy(q0); G.scale.setScalar(SCALE);
          ripples.forEach((R) => { R.r.visible = true; R.t0 = -9; });
        },
        update(lt, raw, t){
          const e = env(lt, 15, 1.0, 1.5);
          const rise = easeIO(smooth(0, 3.4, lt)), sink = easeIO(smooth(11.6, 15, lt));
          const carry = easeIO(smooth(5.0, 7.0, lt)) * (1 - easeIO(smooth(8.8, 10.6, lt)));   // lifts the astronaut, holds it up to look at it, sets it back
          lift.copy(up).multiplyScalar(1.8 * carry).addScaledVector(fwd, 0.8 * carry);
          G.position.lerpVectors(deep, home, rise).add(lift); if (sink > 0) G.position.lerp(deep, sink);
          G.quaternion.copy(q0); G.rotateY(0.35 * carry * Math.sin(lt * 0.6)); G.rotateX(-0.25 * carry);   // turning it gently, as if examining it
          // fingers: open as it rises, close into a cup around the astronaut, the thumb strokes it, then open to let go
          const cup = smooth(3.2, 4.8, lt) * (1 - smooth(9.6, 10.8, lt));
          const stroke = smooth(6.0, 6.5, lt) * (1 - smooth(8.6, 9.0, lt));
          [H, Hr].forEach((hh) => hh.joints.forEach((chain, fi) => {
            const isThumb = fi === 4;
            chain.forEach((j, k) => {
              const bend = isThumb ? 0.15 + 0.55 * cup + 0.35 * stroke * Math.max(0, Math.sin(t * 2.2)) : 0.08 + (k === 0 ? 0.7 : 0.55) * cup + 0.03 * Math.sin(t * 0.8 + fi + k);
              j.rotation.set(bend, 0, k === 0 && !isThumb ? (fi - 1.5) * 0.12 * (1 - cup) : 0);
            });
          }));
          rim.uniforms.uFade.value = 0.35 * e; glowPalm.material.opacity = 0.5 * cup; glowPalm.scale.setScalar(3 + 0.4 * Math.sin(t * 2));
          haze.forEach((s, i) => { s.scale.setScalar(5 + i); s.material.opacity = 0.4 * e * (1 - 0.5 * carry); s.material.rotation += raw * 0.05; });
          // the astronaut rides in the palm
          momentFx.astro.addScaledVector(lift, 1);
          momentFx.look.copy(G.position).addScaledVector(fwd, 2); momentFx.lookOn = true;
          // where the fingertips close, the tunnel trembles
          if (lt > 3.6 && lt < 4.4){ ripples.forEach((R, i) => { if (R.t0 < 0 && lt > 3.6 + i * 0.18){ R.t0 = lt; H.joints[i][2].localToWorld(R.r.position.set(0, 0.45, 0)); } }); }
          let rp = 0; ripples.forEach((R) => { const q = (lt - R.t0) / 1.6; if (q < 0 || q > 1){ R.r.material.opacity = 0; return; } R.r.scale.setScalar(0.5 + 8 * q); R.r.material.opacity = (1 - q) * 0.8; rp = Math.max(rp, 1 - q); });
          momentFx.ca += 0.02 * rp + 0.005 * e; momentFx.dim += 0.3 * rise * (1 - sink);
          momentFx.tint.setRGB(1.0, 0.8, 0.7); momentFx.tintA = Math.max(momentFx.tintA, 0.15 * cup);
        },
        end(){ G.visible = false; ripples.forEach((R) => { R.r.visible = false; }); }
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
          momentFx.astro.addScaledVector(_mv.copy(ufo.position).sub(astro.position).normalize(), 1.1 * on); momentFx.astroSpin += 0.9 * on;   // the beam lifts the astronaut toward it
          momentFx.look.copy(ufo.position); momentFx.lookOn = true;
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
    { name: 'Nave nodriza', line: 'Una nave colosal se detiene sobre ti. Su ojo rojo se abre y sus reflectores te buscan.', dur: 12, make(P){
      const G = newGroup();
      // a black, jagged hull many times larger than everything else, covered in structures
      const hull = new THREE.MeshStandardMaterial({ color: C('#0d0f14'), roughness: 0.55, metalness: 0.8, normalMap: TX.metalNormal, normalScale: new THREE.Vector2(1.5, 1.5), envMapIntensity: 0.5 });
      G.add(new THREE.Mesh(new THREE.LatheGeometry([V2(0.001, -1.6), V2(3, -1.5), V2(7, -1.1), V2(12, -0.4), V2(14, 0), V2(12.5, 0.6), V2(9, 1.2), V2(5, 2.4), V2(2, 3.4), V2(0.001, 3.8)], 128), hull));
      const greeble = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), hull, 260); const dm = new THREE.Object3D();
      for (let i = 0; i < 260; i++){
        const a = Math.random() * 6.28, r = 2 + Math.random() * 11, top = Math.random() < 0.5;
        const yb = top ? lerp(3.4, 0.4, (r - 2) / 11) : lerp(-1.5, -0.3, (r - 2) / 11);
        dm.position.set(Math.cos(a) * r, yb + (top ? 0.2 : -0.2), Math.sin(a) * r); dm.rotation.set(0, -a, 0);
        dm.scale.set(0.3 + Math.random() * 1.6, 0.2 + Math.random() * (top ? 1.4 : 0.6), 0.3 + Math.random() * 0.9); dm.updateMatrix(); greeble.setMatrixAt(i, dm.matrix);
      }
      G.add(greeble);
      // the underside eye: a red core that opens, and rings of red lights
      const eyeMat = new THREE.MeshBasicMaterial({ color: HC(3, 0.2, 0.1), fog: false });
      const eye = new THREE.Mesh(new THREE.CircleGeometry(1.4, 64).rotateX(Math.PI / 2), eyeMat); eye.position.y = -1.62; G.add(eye);
      const eyeGlow = sprite(novaCoreTex, HC(2.6, 0.25, 0.15)); eyeGlow.position.y = -1.9; G.add(eyeGlow);
      const lights = pointsOf(220, 0.45, HC(2.8, 0.3, 0.2)); G.add(lights.p);
      for (let i = 0; i < 220; i++){ const ring = i % 3, a = i / 220 * Math.PI * 2 * 3, r = [13.6, 9.5, 5.5][ring]; lights.pos.set([Math.cos(a) * r, [-0.35, -1.0, -1.35][ring], Math.sin(a) * r], i * 3); }
      lights.flush();
      // searchlights sweeping below
      const beams = [];
      for (let i = 0; i < 3; i++){
        const geo = new THREE.ConeGeometry(1.6, 26, 32, 1, true); geo.translate(0, -13, 0);
        const m = new THREE.Mesh(geo, addMat(HC(0.5, 0.06, 0.04))); const pivot = new THREE.Group(); const a = i / 3 * Math.PI * 2; pivot.position.set(Math.cos(a) * 7, -1.2, Math.sin(a) * 7); pivot.add(m); G.add(pivot);
        beams.push({ pivot, m, ph: i * 2.1 });
      }
      const a = new THREE.Vector3(), over = new THREE.Vector3(), b = new THREE.Vector3();
      return {
        start(){ at(P, -46, 6, 24, a); at(P, 0, 6, 18, over); at(P, 46, 9, 26, b); G.visible = true; },
        update(lt, raw, t){
          // it glides in, stops right above, then moves on
          const arrive = easeIO(smooth(0, 4.5, lt)), leave = easeIO(smooth(8.6, 12, lt));
          G.position.lerpVectors(a, over, arrive); if (leave > 0) G.position.lerp(b, leave);
          G.position.addScaledVector(P.up, 0.3 * Math.sin(t * 0.6));
          G.rotation.y += raw * 0.03;
          const e = env(lt, 12, 2.5, 2.5), open = smooth(4.6, 5.6, lt) * (1 - smooth(8.4, 9.2, lt));
          eye.scale.setScalar(Math.max(0.001, open)); eyeMat.color.setRGB(3 * (0.7 + 0.3 * Math.sin(t * 5)), 0.2, 0.1);
          eyeGlow.scale.setScalar(2 + 10 * open * (0.85 + 0.15 * Math.sin(t * 5))); eyeGlow.material.opacity = open;
          lights.mat.opacity = (0.5 + 0.5 * Math.sin(t * 2.2)) * e;
          beams.forEach((B) => { B.pivot.rotation.set(0.45 * Math.sin(t * 0.7 + B.ph), 0, 0.45 * Math.cos(t * 0.5 + B.ph)); B.m.material.opacity = open * 0.9; });
          // the light goes, the colour drains to red, the view trembles
          momentFx.dim += 0.62 * e; momentFx.tint.setRGB(1.0, 0.3, 0.25); momentFx.tintA = Math.max(momentFx.tintA, 0.35 * open);
          momentFx.ca += 0.012 * e + 0.02 * open;
        },
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
    { name: 'Ascensor cósmico', line: 'Un ascensor espacial sube por su cable, se detiene a tu altura… y sale disparado hacia la estación.', dur: 10, make(P){
      const G = newGroup();   // local +Y follows the screen's up
      // the tether: a bright core inside a faint sheath, with pulses of light running up it
      G.add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 70, 8, 1, true), lit(HC(1.0, 1.1, 1.2))));
      G.add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 70, 16, 1, true), addMat(HC(0.12, 0.35, 0.55))));
      const pulses = pointsOf(36, 0.2, HC(0.6, 1.8, 2.6)); G.add(pulses.p);
      // the station waiting above
      const station = new THREE.Group(); station.position.y = 11; G.add(station);
      station.add(new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.24, 16, 120).rotateX(Math.PI / 2), alu));
      for (let i = 0; i < 6; i++){ const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 6.4, 8).rotateZ(Math.PI / 2), alu); sp.rotation.y = i / 6 * Math.PI; station.add(sp); }
      station.add(new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.4, 32), alu));
      const sLights = pointsOf(60, 0.28, HC(2.4, 1.8, 0.8)); station.add(sLights.p);
      for (let i = 0; i < 60; i++){ const a = i / 60 * Math.PI * 2; sLights.pos.set([Math.cos(a) * 3.2, -0.25, Math.sin(a) * 3.2], i * 3); } sLights.flush();
      // the climber pod with a band of lit windows (and a few passengers)
      const pod = new THREE.Group(); G.add(pod);
      const podMat = new THREE.MeshPhysicalMaterial({ color: C('#d9dde5'), metalness: 0.9, roughness: 0.22, clearcoat: 1, normalMap: TX.metalNormal, normalScale: new THREE.Vector2(0.2, 0.2), envMapIntensity: 1.5 });
      pod.add(new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.1, 48), podMat));
      const capT = new THREE.Mesh(new THREE.SphereGeometry(0.62, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), podMat); capT.position.y = 0.55; pod.add(capT);
      const capB = new THREE.Mesh(new THREE.SphereGeometry(0.62, 48, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), podMat); capB.position.y = -0.55; pod.add(capB);
      const winTex = texOf(1024, 96, (g) => {
        g.fillStyle = '#0c1018'; g.fillRect(0, 0, 1024, 96);
        for (let i = 0; i < 12; i++){
          const x = 12 + i * 85; const gr = g.createLinearGradient(0, 14, 0, 82); gr.addColorStop(0, '#ffe3b0'); gr.addColorStop(1, '#ff9f5a'); g.fillStyle = gr; g.fillRect(x, 14, 66, 68);
          if (i % 3 === 1){ g.fillStyle = '#123'; g.beginPath(); g.ellipse(x + 33, 40, 11, 13, 0, 0, Math.PI * 2); g.fill(); g.fillRect(x + 22, 52, 22, 30); g.fillStyle = '#ffe3b0'; g.beginPath(); g.ellipse(x + 29, 40, 3, 4, 0, 0, Math.PI * 2); g.ellipse(x + 37, 40, 3, 4, 0, 0, Math.PI * 2); g.fill(); }   // a passenger looking out
        }
      });
      winTex.wrapS = THREE.RepeatWrapping;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.625, 0.625, 0.34, 48, 1, true), new THREE.MeshBasicMaterial({ map: winTex, color: HC(1.5, 1.4, 1.3), fog: false })); band.position.y = 0.12; pod.add(band);
      for (const y of [0.95, -0.95]){ const clamp = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.22, 16), alu); clamp.position.y = y; pod.add(clamp); }
      const navL = pointsOf(12, 0.12, HC(1, 1, 1)); pod.add(navL.p);
      for (let i = 0; i < 12; i++){ const a = i / 12 * Math.PI * 2; navL.pos.set([Math.cos(a) * 0.6, -0.42, Math.sin(a) * 0.6], i * 3); } navL.flush();
      const jet = pointsOf(90, 0.14, HC(0.7, 1.6, 2.6)); G.add(jet.p);   // exhaust trail when it leaves
      const streaks = segsOf(24, HC(0.8, 1.6, 2.4)); G.add(streaks.l);
      const sd = []; for (let i = 0; i < 24; i++) sd.push([Math.random() * 6.28, 0.9 + Math.random() * 0.8, Math.random()]);
      const podY = (lt) => lt < 3.4 ? -15 * Math.pow(1 - smooth(0, 3.4, lt), 3) : lt < 6.4 ? 0.06 * Math.sin((lt - 3.4) * 3) : 22 * Math.pow(smooth(6.4, 9.0, lt), 2.2);
      return {
        start(){ G.position.copy(P.anchor); G.quaternion.setFromUnitVectors(V(0, 1, 0), P.up); G.visible = true; },
        update(lt, raw, t){
          const e = env(lt, 10, 0.6, 1.0), y = podY(lt), v = (podY(lt + 0.05) - y) / 0.05;
          pod.position.y = y; pod.rotation.y = lt * 0.25;
          G.children.forEach((c) => { if (c.material && c.material.transparent && c !== jet.p && c !== streaks.l && c !== pulses.p) c.material.opacity = 0.7 * e; });
          for (let i = 0; i < 36; i++) pulses.pos.set([0, -20 + ((lt * 9 + i * 1.1) % 40), 0], i * 3);
          pulses.flush(); pulses.mat.opacity = e;
          navL.mat.color.setHSL((t * 0.3) % 1, 1, 0.6).multiplyScalar(2); navL.mat.opacity = (Math.sin(t * 8) > 0 ? 1 : 0.3) * e;
          // leaving: a trail below the pod and speed lines around it
          const fast = THREE.MathUtils.clamp(Math.abs(v) / 18, 0, 1), up = lt > 6.4;
          for (let i = 0; i < 90; i++) jet.pos.set([(Math.random() - 0.5) * 0.3, y - 0.8 - i * 0.06 * (1 + fast * 3), (Math.random() - 0.5) * 0.3], i * 3);
          jet.flush(); jet.mat.opacity = up ? fast * e : 0;
          sd.forEach((q, i) => { const yy = y + (q[2] - 0.5) * 3; streaks.pos.set([Math.cos(q[0]) * q[1], yy, Math.sin(q[0]) * q[1], Math.cos(q[0]) * q[1], yy - 0.6 - fast * 2.5, Math.sin(q[0]) * q[1]], i * 6); });
          streaks.flush(); streaks.mat.opacity = fast * e * 0.8;
          station.rotation.y += raw * 0.15; sLights.mat.opacity = (0.6 + 0.4 * Math.sin(t * 3)) * e;
          momentFx.ca += 0.02 * smooth(6.4, 7.0, lt) * (1 - smooth(7.0, 8.0, lt));
        },
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
    { name: 'Satélite antiguo', line: 'El Sputnik pasa rozándote y su «bip-bip» se vuelve más agudo al acercarse.', dur: 10, make(P){
      const G = newGroup(), body = new THREE.Group(); G.add(body);
      // Sputnik 1: a polished sphere, the seam of its two half-shells, four swept-back whip antennas
      const polished = new THREE.MeshPhysicalMaterial({ color: C('#e9ecf1'), metalness: 1, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.9 });
      body.add(new THREE.Mesh(new THREE.SphereGeometry(0.45, 64, 48), polished));
      body.add(new THREE.Mesh(new THREE.TorusGeometry(0.452, 0.012, 10, 96), alu));
      const antGeo = new THREE.CylinderGeometry(0.006, 0.011, 1, 8); antGeo.translate(0, -0.5, 0);
      [[1, 1, 2.9], [-1, 1, 2.9], [1, -1, 2.4], [-1, -1, 2.4]].forEach(([sx, sy, len]) => {
        const q = new THREE.Quaternion().setFromUnitVectors(V(0, -1, 0), V(sx * 0.32, sy * 0.32, -1).normalize());
        const a = new THREE.Mesh(antGeo, alu); a.scale.set(1, len, 1); a.position.set(sx * 0.2, sy * 0.2, 0.36); a.quaternion.copy(q); body.add(a);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.09, 12), alu); m.position.copy(a.position); m.quaternion.copy(q); body.add(m);
      });
      const glint = sprite(novaCoreTex, HC(2.6, 2.6, 2.6)); G.add(glint);   // the sun catching the polished shell
      // radio rings, emitted in pairs: bip-bip
      const rings = []; for (let i = 0; i < 10; i++){ const r = sprite(novaRingTex, HC(0.9, 1.9, 2.4)); r.visible = false; scene.add(r); rings.push({ r, t0: -9 }); }
      // a floating tag with its name and the signal's trace
      const tag = liveTex(320, 120);
      const tagMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.6), addMat(HC(1.3, 1.6, 1.6), tag.tx)); G.add(tagMesh);
      const trace = new Float32Array(64);
      function drawTag(level){
        const g = tag.g; g.clearRect(0, 0, 320, 120);
        g.strokeStyle = 'rgba(125,243,255,0.6)'; g.lineWidth = 1.5; g.strokeRect(2, 2, 316, 116);
        g.fillStyle = '#c9fbff'; g.font = '500 22px "IBM Plex Mono", monospace'; g.fillText('ПС-1 · 1957', 14, 32);
        g.font = '400 14px "IBM Plex Mono", monospace'; g.fillStyle = 'rgba(201,251,255,0.7)'; g.fillText('20,005 MHz', 196, 30);
        for (let i = 0; i < 63; i++) trace[i] = trace[i + 1]; trace[63] = level;
        g.strokeStyle = '#7df3ff'; g.lineWidth = 2; g.beginPath();
        for (let i = 0; i < 64; i++){ const x = 14 + i * 4.5, y = 86 - trace[i] * 30 * (i % 2 ? 1 : -1) * 0.5 - trace[i] * 8; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
        g.stroke(); tag.tx.needsUpdate = true;
      }
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      let nextBip = 0, pair = 0, ri = 0, acc = 0, level = 0;
      return {
        start(){ at(P, -6.5, 1.8, 3.5, a); at(P, 6, -1.0, -2.6, b); G.visible = true; nextBip = 0.4; pair = 0; trace.fill(0); body.rotation.set(0.5, 0.8, 0); },
        update(lt, raw, t){
          G.position.lerpVectors(a, b, easeIO(lt / 10) * 0.6 + (lt / 10) * 0.4);
          body.rotation.x += raw * 0.18; body.rotation.y += raw * 0.27; body.rotation.z += raw * 0.07;
          G.scale.setScalar(Math.max(0.001, env(lt, 10, 0.8, 1.0)));
          const g2 = Math.pow(Math.max(0, Math.sin(t * 1.3 + Math.sin(t * 0.7))), 40);
          glint.position.set(0.15, 0.2, 0.35); glint.scale.setScalar(0.3 + 2.2 * g2); glint.material.opacity = g2;
          // closer means a higher pitch: the pairs of rings come faster (Doppler)
          const dist = camera.position.distanceTo(G.position), period = THREE.MathUtils.clamp(lerp(0.32, 0.9, (dist - 6) / 10), 0.32, 0.9);
          if (lt >= nextBip && lt < 9){ const R = rings[ri++ % rings.length]; R.t0 = lt; R.r.position.copy(G.position); R.r.visible = true; level = 1; pair++; nextBip = lt + (pair % 2 ? 0.13 : period); }
          rings.forEach((R) => { const k = (lt - R.t0) / 1.3; if (k < 0 || k > 1){ R.r.material.opacity = 0; return; } R.r.scale.setScalar(0.4 + 4 * k); R.r.material.opacity = (1 - k) * 0.8; });
          level *= Math.exp(-raw * 14);
          acc += raw; if (acc > 1 / 30){ acc = 0; drawTag(level); }
          tagMesh.position.set(0.9, 0.75, 0); tagMesh.quaternion.copy(body.parent.quaternion).invert().multiply(camera.quaternion);
          tagMesh.material.opacity = smooth(1, 1.6, lt) * (1 - smooth(8.6, 9.6, lt));
        },
        end(){ G.visible = false; rings.forEach((R) => { R.r.visible = false; }); }
      };
    } },

  ];

  /* ===== group 4 · extreme physics ===== */
  const PHYSICS = [
    { name: 'Micro agujero negro', line: 'Nace un agujero negro: dobla la luz, devora todo lo que hay cerca… y tira de ti.', dur: 11.5, make(P){
      const RH = 0.55, bh = newGroup(); bh.position.copy(P.anchor);
      bh.add(new THREE.Mesh(new THREE.SphereGeometry(RH, 40, 24), new THREE.MeshBasicMaterial({ color: 0x000000, fog: false })));
      const diskMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uFade: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uTime, uFade; varying vec2 vP;
          void main(){
            float r = length(vP), a = atan(vP.y, vP.x);
            float k = clamp((r - 0.68) / 2.0, 0.0, 1.0);
            float swirl = 0.5 + 0.5 * sin(a * 3.0 - uTime * 3.0 / (r * r) + r * 9.0);
            float grain = 0.6 + 0.4 * sin(a * 13.0 - uTime * 5.0 / r + r * 27.0);
            float heat = pow(1.0 - k, 2.2);
            vec3 c = mix(vec3(1.0, 0.22, 0.05), vec3(1.0, 0.92, 0.75), heat);
            float beaming = 0.35 + 0.65 * (0.5 + 0.5 * sin(a));
            float I = heat * (0.35 + 0.65 * swirl * grain) * beaming * smoothstep(0.0, 0.05, k) * (1.0 - smoothstep(0.8, 1.0, k));
            gl_FragColor = vec4(c * I * 3.2 * uFade, 1.0);
          }` });
      const disk = new THREE.Mesh(new THREE.RingGeometry(0.68, 2.7, 160, 1), diskMat); disk.rotation.set(1.15, 0.3, 0); bh.add(disk);
      const halo = sprite(novaRingTex, HC(1.3, 0.8, 0.45)); halo.scale.setScalar(3.2); bh.add(halo);
      const pop = sprite(novaCoreTex, HC(1.6, 1.5, 2.4)); pop.position.copy(P.anchor); pop.visible = false; scene.add(pop);
      // a wide current of dust spiralling in from far away
      const DN = 520, dust = pointsOf(DN, 0.08, HC(2.2, 1.4, 0.8)); dust.p.visible = false; scene.add(dust.p);
      const ds = []; for (let i = 0; i < DN; i++) ds.push({ r: 3 + Math.random() * 11, a: Math.random() * 6.28, h: (Math.random() - 0.5) * 2.5 });
      const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), e3 = new THREE.Vector3(), rel = new THREE.Vector3();
      let prey = [];
      const free = (q) => { if (q.done) return; q.done = true; q.d.mesh.scale.copy(q.scale0); q.d.captured = false; place(q.d, false); };
      return {
        start(){
          bh.visible = dust.p.visible = true;
          e1.set(1, 0, 0).applyQuaternion(disk.quaternion); e2.set(0, 1, 0).applyQuaternion(disk.quaternion); e3.set(0, 0, 1).applyQuaternion(disk.quaternion);
          // everything loose within 16 units is pulled in, nearest first
          prey = debris.filter((d) => !d.big && !d.captured && d.mesh.position.distanceTo(bh.position) < 16)
            .sort((a, b) => a.mesh.position.distanceTo(bh.position) - b.mesh.position.distanceTo(bh.position)).slice(0, 7)
            .map((d, i) => { d.captured = true; rel.copy(d.mesh.position).sub(bh.position); return { d, scale0: d.mesh.scale.clone(), r0: Math.max(2.5, rel.length()), ang: Math.atan2(rel.dot(e2), rel.dot(e1)), lift: rel.dot(e3), t0: 0.9 + i * 0.45, done: false }; });
        },
        update(lt, raw, t){
          const grow = easeIO(smooth(0, 1.2, lt)), shrink = 1 - smooth(8.2, 9.8, lt), s = Math.max(0.001, grow * shrink), pull = grow * shrink;
          bh.scale.setScalar(s);
          diskMat.uniforms.uTime.value = t; diskMat.uniforms.uFade.value = grow * (1 + 1.2 * smooth(7.6, 9.6, lt));
          halo.material.opacity = 0.6; halo.material.rotation += raw * 0.4;
          prey.forEach((q) => {
            if (q.done) return;
            const k = smooth(q.t0, q.t0 + 4.6, lt), r = lerp(q.r0, 0.45, easeIO(k));
            q.ang += raw * (0.35 + 2.8 / Math.max(r, 0.45)) * pull;   // faster and faster as it falls in
            const m = q.d.mesh;
            m.position.copy(bh.position).addScaledVector(e1, Math.cos(q.ang) * r).addScaledVector(e2, Math.sin(q.ang) * r).addScaledVector(e3, q.lift * (1 - k));
            m.scale.copy(q.scale0).multiplyScalar(Math.max(0.02, 1 - 0.95 * smooth(0.6, 1, k)));
            m.scale.x *= 1 + 2.5 * smooth(0.5, 1, k);   // stretched as it nears the horizon
            m.rotation.z += raw * 8 * k;
            if (k >= 1 || lt > 9.4) free(q);
          });
          ds.forEach((d, i) => {
            d.r -= raw * (0.4 + 5 / Math.max(d.r, 0.6)) * pull; d.a += raw * (0.3 + 3 / Math.max(d.r, 0.6)) * pull;
            if (d.r < 0.6){ d.r = 11 + Math.random() * 4; d.a = Math.random() * 6.28; }
            _mp.copy(bh.position).addScaledVector(e1, Math.cos(d.a) * d.r).addScaledVector(e2, Math.sin(d.a) * d.r).addScaledVector(e3, d.h * Math.min(1, d.r / 6));
            dust.pos[i * 3] = _mp.x; dust.pos[i * 3 + 1] = _mp.y; dust.pos[i * 3 + 2] = _mp.z;
          });
          dust.flush(); dust.mat.opacity = 0.9 * pull;
          // it pulls the astronaut toward it, spinning it slowly, until it evaporates
          rel.copy(bh.position).sub(astro.position); const dist = rel.length(); rel.normalize();
          momentFx.astro.addScaledVector(rel, Math.min(2.6, 16 / (dist * dist + 4)) * pull); momentFx.astroSpin += 0.9 * pull;
          momentFx.look.copy(bh.position); momentFx.lookOn = true;
          const p = smooth(9.6, 9.8, lt) * (1 - smooth(9.9, 11.2, lt));   // the last flash as it evaporates
          pop.visible = p > 0.001; if (pop.visible){ pop.material.opacity = p; pop.scale.setScalar(1 + 9 * smooth(9.6, 11.2, lt)); }
          momentFx.ca += 0.02 * p + 0.006 * pull;
          if (s > 0.01){   // gravitational lensing, drawn in the final pass
            _mndc.copy(bh.position).project(camera);
            if (_mndc.z < 1 && Math.abs(_mndc.x) < 1.5 && Math.abs(_mndc.y) < 1.5){
              const r = 0.5 * RH * s / (camera.position.distanceTo(bh.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
              momentFx.lensK = Math.pow(r * 2.4, 2); momentFx.lensR = r; momentFx.lensX = _mndc.x * 0.5 + 0.5; momentFx.lensY = _mndc.y * 0.5 + 0.5;
            }
          }
        },
        end(){ bh.visible = pop.visible = dust.p.visible = false; prey.forEach(free); prey = []; }
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
    { name: 'Fractura del espacio', line: 'El espacio se agrieta como un cristal, se rompe en pedazos… y se rehace.', dur: 9.5, make(P){
      // a map of glass shards for the final pass: each texel stores its shard's drift (rg), a random tone (b) and the crack lines (a)
      const S = 256, data = new Uint8Array(S * S * 4);
      const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat); tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
      function compose(cx, cy){
        const seeds = [];
        for (let i = 0; i < 70; i++){ const a = Math.random() * 6.28, r = Math.pow(Math.random(), 1.5) * 0.85; seeds.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 1.4, Math.random()]); }   // denser near the impact
        const rings = [0.08, 0.17, 0.3, 0.46];
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++){
          const u = x / S, v = y / S;
          let d1 = 9, d2 = 9, id = 0;
          for (let k = 0; k < seeds.length; k++){ const dx = u - seeds[k][0], dy = (v - seeds[k][1]) * 0.7, d = dx * dx + dy * dy; if (d < d1){ d2 = d1; d1 = d; id = k; } else if (d < d2) d2 = d; }
          const edge = Math.sqrt(d2) - Math.sqrt(d1);
          const rc = Math.hypot(u - cx, (v - cy) * 0.7);
          let line = Math.max(0, 1 - edge / 0.006);
          rings.forEach((rr) => { line = Math.max(line, Math.max(0, 1 - Math.abs(rc - rr) / 0.004) * 0.8); });   // concentric breaks, like a spider web
          const sd = seeds[id], dx = sd[0] - cx, dy = sd[1] - cy, dl = Math.hypot(dx, dy) + 1e-4;
          const i = (y * S + x) * 4;
          data[i] = Math.round((dx / dl * 0.5 + 0.5) * 255); data[i + 1] = Math.round((dy / dl * 0.5 + 0.5) * 255); data[i + 2] = Math.round(sd[2] * 255); data[i + 3] = Math.round(Math.min(1, line) * 255);
        }
        tex.needsUpdate = true;
      }
      // glass splinters flying off the impact, close to the camera
      const flakeG = new THREE.BufferGeometry().setFromPoints([V(0, 0.22, 0), V(-0.15, -0.12, 0), V(0.17, -0.1, 0)]); flakeG.computeVertexNormals();
      const FL = 40, flakes = new THREE.InstancedMesh(flakeG, new THREE.MeshPhysicalMaterial({ color: C('#e8f6ff'), metalness: 0.2, roughness: 0, clearcoat: 1, transparent: true, opacity: 0.85, side: THREE.DoubleSide, envMapIntensity: 2.5, emissive: C('#7ab8ff'), emissiveIntensity: 0.4 }), FL);
      flakes.frustumCulled = false; flakes.visible = false; scene.add(flakes);
      const FD = []; for (let i = 0; i < FL; i++) FD.push({ v: V(Math.random() - 0.5, Math.random() - 0.5, Math.random() * 0.6).normalize().multiplyScalar(2 + Math.random() * 5), spin: V(Math.random(), Math.random(), Math.random()).multiplyScalar(8), s: 0.5 + Math.random() });
      const dummy = new THREE.Object3D(), origin = new THREE.Vector3();
      let cx = 0.5, cy = 0.6;
      return {
        start(){
          _mndc.copy(P.anchor).project(camera); cx = THREE.MathUtils.clamp(_mndc.x * 0.5 + 0.5, 0.15, 0.85); cy = THREE.MathUtils.clamp(_mndc.y * 0.5 + 0.5, 0.2, 0.85);
          compose(cx, cy); if (finalPass) finalPass.uniforms.uShard.value = tex;
          origin.copy(P.anchor).lerp(camera.position, 0.55); flakes.visible = true;
        },
        update(lt, raw, t){
          // impact → cracks race outward → the glass shatters and drifts apart → time rewinds and it heals
          const crack = smooth(0.15, 1.2, lt) * (1 - smooth(7.6, 8.8, lt));
          const shatter = easeIO(smooth(2.2, 4.0, lt)) * (1 - easeIO(smooth(5.6, 7.4, lt)));
          momentFx.crack = Math.max(momentFx.crack, crack); momentFx.shatter = Math.max(momentFx.shatter, shatter + 0.04 * Math.sin(t * 3) * shatter);
          momentFx.crackX = cx; momentFx.crackY = cy;
          const hit = smooth(0.0, 0.12, lt) * (1 - smooth(0.12, 0.7, lt)), heal = smooth(7.2, 7.4, lt) * (1 - smooth(7.4, 8.2, lt));
          momentFx.ca += 0.06 * hit + 0.03 * shatter + 0.05 * heal; momentFx.dim -= 0.8 * hit + 0.6 * heal;
          momentFx.freeze = Math.max(momentFx.freeze, 0.7 * shatter);   // the world stands still while it is broken
          momentFx.flowMul *= 1 - 2.2 * smooth(5.6, 6.0, lt) * (1 - smooth(7.0, 7.4, lt));   // and runs backwards as it heals
          // splinters: out on the impact, back in as it heals
          const out = smooth(0.05, 1.6, lt) * (1 - smooth(5.6, 7.4, lt));
          FD.forEach((f, i) => {
            dummy.position.copy(origin).addScaledVector(f.v, out * 1.2);
            dummy.rotation.set(f.spin.x * out, f.spin.y * out, f.spin.z * out); dummy.scale.setScalar(f.s * Math.max(0.001, out));
            dummy.updateMatrix(); flakes.setMatrixAt(i, dummy.matrix);
          });
          flakes.instanceMatrix.needsUpdate = true;
          // the shock throws the astronaut back a little
          momentFx.astro.addScaledVector(_mp.copy(astro.position).sub(P.anchor).normalize(), 1.2 * smooth(0.1, 0.4, lt) * (1 - smooth(1.2, 3.0, lt)));
          momentFx.astroSpin += 1.5 * hit;
        },
        end(){ flakes.visible = false; }
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
    { name: 'Lluvia hacia arriba', line: 'La lluvia cae hacia arriba… y te lleva con ella hasta la nube.', dur: 12, make(P){
      const G = newGroup();   // local +Y follows the screen's up
      // the pool of light below, rippling where each drop lifts off
      const SLOTS = 10, rip = []; for (let i = 0; i < SLOTS; i++) rip.push(new THREE.Vector4(0, 0, -9, 0));
      const poolMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uR: { value: rip } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uTime, uFade; uniform vec4 uR[${SLOTS}]; varying vec2 vP;
          void main(){
            float d0 = length(vP), base = exp(-d0 * d0 * 0.18) * 0.35, ring = 0.0;
            for (int i = 0; i < ${SLOTS}; i++){ float age = uTime - uR[i].z; if (age > 0.0 && age < 1.4){ float d = length(vP - uR[i].xy); ring += exp(-pow((d - age * 1.3) / 0.05, 2.0)) * (1.0 - age / 1.4); } }
            float caustic = 0.5 + 0.5 * sin(vP.x * 5.0 + uTime * 1.3) * sin(vP.y * 4.0 - uTime * 1.1);
            vec3 c = vec3(0.25, 0.75, 1.4) * (base * (0.6 + 0.4 * caustic) + ring * 1.4);
            gl_FragColor = vec4(c * uFade * (1.0 - smoothstep(2.6, 3.2, d0)), 1.0);
          }` });
      const pool = new THREE.Mesh(new THREE.CircleGeometry(3.2, 96).rotateX(-Math.PI / 2), poolMat); pool.position.y = -3; G.add(pool);
      const dropMat = new THREE.MeshPhysicalMaterial({ color: C('#d8f3ff'), metalness: 0, roughness: 0, clearcoat: 1, emissive: C('#3aa0ff'), emissiveIntensity: 0.7, envMapIntensity: 2.4, transparent: true, opacity: 0.9 });
      const N = 240, drops = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), dropMat, N); drops.frustumCulled = false; G.add(drops);
      const D = []; for (let i = 0; i < N; i++){ const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * 2.6; D.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, t0: 0.6 + Math.random() * 7.2, launched: false, size: 0.09 + Math.random() * 0.07 }); }
      const cloud = []; for (let i = 0; i < 6; i++){ const s = sprite(nebulaTex, new THREE.Color().setHSL(0.56 + i * 0.015, 0.6, 0.6)); s.position.set((i - 2.5) * 0.8, 3.3 + (i % 2) * 0.3, (i % 3 - 1) * 0.4); s.material.rotation = Math.random() * 6; G.add(s); cloud.push(s); }
      const glowC = sprite(dotTex, HC(0.8, 1.6, 2.6)); glowC.position.y = 3.3; G.add(glowC);
      // the same rain around the astronaut: drops stream up past the suit and carry it up
      const NA = 90, aDrops = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), dropMat, NA); aDrops.frustumCulled = false; aDrops.visible = false; scene.add(aDrops);
      const AD = []; for (let i = 0; i < NA; i++){ const a = Math.random() * 6.28, r = 0.5 + Math.random() * 1.6; AD.push({ a, r, ph: Math.random() * 4, sp: 1.8 + Math.random() * 1.6, size: 0.04 + Math.random() * 0.035 }); }
      const dummy = new THREE.Object3D();
      let slot = 0, caught = 0;
      return {
        start(){
          G.position.copy(P.anchor); G.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(P.right, P.up, _mv.copy(P.out).negate())); G.rotateX(-0.45);
          G.visible = aDrops.visible = true; D.forEach((d) => { d.launched = false; }); caught = 0; rip.forEach((r) => { r.z = -9; });
        },
        update(lt, raw, t){
          const e = env(lt, 12, 0.8, 1.2);
          poolMat.uniforms.uTime.value = lt; poolMat.uniforms.uFade.value = e;
          caught = 0;
          D.forEach((d, i) => {
            const tau = lt - d.t0;
            let y = -3, vs = 0, show = tau > -0.3 && lt < 11.2;
            if (tau > 0){
              if (!d.launched){ d.launched = true; const r = rip[slot++ % SLOTS]; r.x = d.x; r.y = d.z; r.z = lt; }
              y = -3 + 1.9 * tau * tau; vs = 3.8 * tau;
              if (y > 3.2){ show = false; caught++; }
            } else { y = -3 + 0.08 * Math.max(0, 1 + tau / 0.3); }
            dummy.position.set(d.x + 0.05 * Math.sin(t * 3 + i), y, d.z);
            dummy.scale.set(d.size, show ? d.size * (1 + Math.min(4, vs * 0.45)) : 0.0001, d.size); dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix(); drops.setMatrixAt(i, dummy.matrix);
          });
          drops.instanceMatrix.needsUpdate = true; dropMat.opacity = 0.9 * e;
          const fill = Math.min(1, caught / (N * 0.7));
          cloud.forEach((s, i) => { s.scale.setScalar(2 + 3.5 * fill + 0.2 * Math.sin(t + i)); s.material.opacity = (0.15 + 0.6 * fill) * e; s.material.rotation += raw * 0.05; });
          glowC.scale.setScalar(3 + 4 * fill); glowC.material.opacity = (0.2 + 0.5 * fill * (0.7 + 0.3 * Math.sin(t * 7))) * e;
          // around the astronaut: a column of rising drops, and the astronaut lifted gently with them
          const around = smooth(1.5, 3, lt) * (1 - smooth(10, 11.5, lt));
          AD.forEach((q, i) => {
            const y = -2.6 + ((lt * q.sp + q.ph) % 5.2);
            dummy.position.copy(astro.position).addScaledVector(P.right, Math.cos(q.a + lt * 0.3) * q.r).addScaledVector(P.out, Math.sin(q.a + lt * 0.3) * q.r).addScaledVector(P.up, y);
            dummy.scale.set(q.size, around > 0.01 ? q.size * (2 + q.sp) : 0.0001, q.size);
            dummy.quaternion.setFromUnitVectors(V(0, 1, 0), P.up); dummy.updateMatrix(); aDrops.setMatrixAt(i, dummy.matrix);
          });
          aDrops.instanceMatrix.needsUpdate = true;
          momentFx.astro.addScaledVector(P.up, 1.3 * around); momentFx.astroSpin += 0.25 * around;
          G.localToWorld(momentFx.look.set(0, 3.3, 0)); momentFx.lookOn = true;
        },
        end(){ G.visible = aDrops.visible = false; }
      };
    } }

  ];

  /* ===== group 5 · signals ===== */
  const SIGNALS = [
    { name: 'Grieta a la Tierra', line: 'Una grieta se abre sobre Bogotá… y caes hacia Monserrate, con toda la ciudad a sus pies.', dur: 17, prewarm: true, make(P){
      const job = (function* (){
      /* a small Bogotá in 3D, filmed by its own drone camera into a texture and seen through the crack: the sanctuary of
         Monserrate on its summit (white walls, red tile roofs, the round apse, the bell tower), the forest of the eastern
         hills, and the savanna covered in city up to the far mountains, under a sunset sky.
         Units: 1 = 10 m. The summit is y = 0, the city lies 500 m below, to the west (-Z); north is +X. */
      const rnd = mulberry32(4711);
      const dio = new THREE.Scene(), HAZE = C('#bdb4a8');
      dio.fog = new THREE.FogExp2(HAZE, 0.0027);
      const SUN = V(-0.8, 0.2, -0.55).normalize();
      dio.add(new THREE.HemisphereLight(C('#e2e5ee'), C('#55603f'), 0.9));
      const sunL = new THREE.DirectionalLight(C('#ffd49c'), 1.25); sunL.position.copy(SUN).multiplyScalar(100); dio.add(sunL);
      const PL = -50, SZ = 900;
      const hgt = (x, z) => {
        const crest = -6 + 10 * (1 - Math.exp(-x * x / 1200)) + 3.5 * Math.sin(x * 0.031) + 3 * Math.sin(x * 0.009 + 1);   // Monserrate low on the ridge, Guadalupe higher to the north
        let h = PL + (crest - PL) * smooth(-62, 6, z);
        const fold = smooth(-66, -40, z) * (1 - smooth(0, 14, z));   // the creases of the hillside (only where they show, it is the costly part)
        if (fold > 0) h += 5.2 * (pnoise2(x * 0.06 + 500, z * 0.06 + 500, 4096, 4096, 7) - 0.5) * fold;
        const r = Math.hypot(x, z + 0.5); h = lerp(h, -0.02 * r * r, smooth(22, 8, r));   // the summit, a dome levelled for the sanctuary
        h += 34 * smooth(-240, -420, z) * (0.55 + 0.45 * Math.sin(x * 0.017 + 1.3)) + 26 * smooth(220, 400, Math.abs(x));   // the far ranges
        return h;
      };
      // the big avenues: Carrera Séptima and Caracas along the hills, Calle 26 to the west, the Avenida 68 across
      const AVES = [[-260, -67, 260, -63], [-260, -112, 260, -104], [26, -64, 72, -420], [230, -92, -210, -340], [-260, -196, 260, -178]];
      const dSeg = (x, z, a) => { const dx = a[2] - a[0], dz = a[3] - a[1], k = THREE.MathUtils.clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1); return Math.hypot(x - a[0] - dx * k, z - a[1] - dz * k); };
      const ROOF = [[150, 74, 52], [172, 92, 60], [138, 64, 48], [128, 120, 112], [178, 162, 142], [200, 192, 180]];
      // the ground, painted once: forest on the hills, the patchwork of roofs and streets on the savanna, parks
      const GT = 512, gcv = makeCanvas(GT, GT), gx = gcv.getContext('2d'), img = gx.createImageData(GT, GT), px8 = img.data;
      for (let j = 0; j < GT; j++){
        if ((j & 7) === 7) yield;
        const z = (j / GT - 0.5) * SZ;
        for (let i = 0; i < GT; i++){
          const x = (i / GT - 0.5) * SZ, o = (j * GT + i) * 4;
          const n = pnoise2(i / 15, j / 15, 64, 64, 3), m = rnd();
          let r = 46 + 26 * m, g = 76 + 34 * m + 14 * n, b = 42 + 16 * m;
          const city = smooth(-54, -66, z) * (1 - smooth(-280, -360, z)) * (1 - smooth(230, 320, Math.abs(x)));
          if (city > 0){
            const street = ((i + (j >> 4)) % 5 === 0) || (j % 5 === 0);
            let c = ROOF[(rnd() * ROOF.length) | 0];
            if (rnd() < 0.7 * smooth(25, -20, x) * smooth(-130, -75, z)) c = ROOF[(rnd() * 3) | 0];   // La Candelaria and the old south: red tile everywhere
            const sh = 0.72 + 0.4 * rnd();
            let cr = c[0] * sh, cgg = c[1] * sh, cb = c[2] * sh;
            if (street){ cr = cgg = 98; cb = 100; }
            if (n > 0.8){ cr = 70; cgg = 108; cb = 60; }   // parks
            r = lerp(r, cr, city); g = lerp(g, cgg, city); b = lerp(b, cb, city);
          }
          px8[o] = r; px8[o + 1] = g; px8[o + 2] = b; px8[o + 3] = 255;
        }
      }
      gx.putImageData(img, 0, 0);
      const W2P = (v) => (v / SZ + 0.5) * GT;
      gx.strokeStyle = 'rgb(124,122,118)'; gx.lineWidth = 2.4;
      AVES.forEach((a) => { gx.beginPath(); gx.moveTo(W2P(a[0]), W2P(a[1])); gx.lineTo(W2P(a[2]), W2P(a[3])); gx.stroke(); });
      const tg = new THREE.PlaneGeometry(SZ, SZ, 180, 180); tg.rotateX(-Math.PI / 2);
      { const p = tg.attributes.position; for (let k = 0; k < p.count; k++){ p.setY(k, hgt(p.getX(k), p.getZ(k))); if ((k & 4095) === 4095) yield; } tg.computeVertexNormals(); }
      yield;
      dio.add(new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ map: canvasTex(gcv, true) })));

      const dm = new THREE.Object3D(), col = new THREE.Color(), unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const setC = (mesh, k, rgb, s) => { col.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255).convertSRGBToLinear().multiplyScalar(s); mesh.setColorAt(k, col); };
      // the city seen from above: a fine carpet of roofs, streets and parks laid over the savanna (about 5 m a pixel)
      const CX0 = -260, CX1 = 260, CZ0 = -56, CZ1 = -246, CW = 1024, CH = 384, BLK = 8;
      const ccv = makeCanvas(CW, CH), cx2 = ccv.getContext('2d'), cimg = cx2.createImageData(CW, CH), c8 = cimg.data;
      for (let j = 0; j < CH; j++){
        if ((j & 7) === 7) yield;
        const z = CZ1 + (CZ0 - CZ1) * (j + 0.5) / CH;
        let pk = 0;
        for (let i = 0; i < CW; i++){
          const x = CX0 + (CX1 - CX0) * (i + 0.5) / CW, o = (j * CW + i) * 4, li = i >> 1, lj = j >> 1;
          if ((i & 7) === 0) pk = pnoise2(i / 44, j / 44, 64, 64, 21);
          const street = ((i + ((j / 37) | 0) * 3) % BLK === 0) || (j % BLK === 0);   // the grid shifts a little from one neighbourhood to the next
          const old = smooth(25, -25, x) * smooth(-140, -70, z), north = smooth(40, 90, x);
          let c = ROOF[(hash2i(li, lj, 77) * ROOF.length) | 0];
          if (hash2i(li, lj, 5) < 0.6 * old) c = ROOF[(hash2i(li, lj, 6) * 3) | 0];   // La Candelaria: red tile everywhere
          else if (hash2i(li, lj, 8) < 0.45 * north) c = ROOF[3 + ((hash2i(li, lj, 9) * 3) | 0)];   // the north: concrete and white
          const sh = 0.7 + 0.45 * hash2i(i, j, 11);
          let r = c[0] * sh, g = c[1] * sh, b = c[2] * sh;
          if (street){ r = 92; g = 90; b = 92; }
          if (pk > 0.79){ r = 64 + 24 * sh; g = 100 + 26 * sh; b = 54; }   // parks
          c8[o] = r; c8[o + 1] = g; c8[o + 2] = b; c8[o + 3] = 255;
        }
      }
      cx2.putImageData(cimg, 0, 0);
      const C2X = (x) => (x - CX0) / (CX1 - CX0) * CW, C2Y = (z) => (z - CZ1) / (CZ0 - CZ1) * CH;
      cx2.strokeStyle = 'rgb(128,126,122)'; cx2.lineWidth = 4;
      AVES.forEach((a) => { cx2.beginPath(); cx2.moveTo(C2X(a[0]), C2Y(a[1])); cx2.lineTo(C2X(a[2]), C2Y(a[3])); cx2.stroke(); });
      dio.add(new THREE.Mesh(new THREE.PlaneGeometry(CX1 - CX0, CZ0 - CZ1).rotateX(-Math.PI / 2).translate((CX0 + CX1) / 2, PL + 0.04, (CZ0 + CZ1) / 2),
        new THREE.MeshLambertMaterial({ map: canvasTex(ccv, true), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
      // up close, the houses rise off the carpet: small, packed, low; taller around the centre
      const NH = 9000, houses = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial(), NH);
      let nh = 0;
      yield;
      for (let tries = 0; nh < NH && tries < NH * 4; tries++){
        if (tries % 1000 === 999) yield;
        const x = -110 + rnd() * 280, z = -58 - Math.pow(rnd(), 1.3) * 95;
        const ci = C2X(x), cj = C2Y(z);
        if (((ci | 0) + ((cj / 37) | 0) * 3) % BLK < 1.5 || (cj | 0) % BLK < 1.5) continue;   // off the streets
        const h0 = hgt(x, z); if (h0 > PL + 2.5 || AVES.some((a) => dSeg(x, z, a) < 1.8)) continue;
        const down = Math.exp(-((x - 25) * (x - 25)) / 900 - ((z + 80) * (z + 80)) / 500), old = smooth(25, -25, x) * smooth(-140, -70, z);
        dm.position.set(x, Math.max(PL, h0) - 0.08, z); dm.rotation.set(0, (rnd() - 0.5) * 0.08, 0);
        dm.scale.set(0.55 + rnd() * 0.7, 0.25 + rnd() * 0.55 + down * rnd() * 3 + (rnd() < 0.05 ? 1 + rnd() * 2 : 0), 0.55 + rnd() * 0.7);
        dm.updateMatrix(); houses.setMatrixAt(nh, dm.matrix); setC(houses, nh, ROOF[rnd() < old * 0.7 ? (rnd() * 3) | 0 : [0, 0, 1, 1, 2, 2, 3, 3, 4, 5][(rnd() * 10) | 0]], 0.75 + 0.3 * rnd()); nh++;
      }
      houses.count = nh; dio.add(houses);
      // the towers of the centre, at the foot of the hill: Colpatria, the twin BD Bacatá, Torres del Parque, Atrio
      const winC = makeCanvas(64, 256), wg = winC.getContext('2d');
      wg.fillStyle = '#9fb2c4'; wg.fillRect(0, 0, 64, 256);
      for (let y = 0; y < 256; y += 8){ wg.fillStyle = 'rgba(28,36,50,0.55)'; wg.fillRect(0, y + 5, 64, 3); }
      for (let x = 0; x < 64; x += 8){ wg.fillStyle = 'rgba(28,36,50,0.35)'; wg.fillRect(x, 0, 1.5, 256); }
      { const gr = wg.createLinearGradient(0, 0, 64, 256); gr.addColorStop(0, 'rgba(255,255,255,0.28)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,214,170,0.22)'); wg.fillStyle = gr; wg.fillRect(0, 0, 64, 256); }
      const NT = 72, towers = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial({ map: canvasTex(winC, true) }), NT);
      const TW = [[14, -68, 2.4, 2.0, 19.6, [96, 130, 170]], [25.2, -72, 1.7, 1.7, 26, [92, 98, 110]], [27.6, -72.6, 1.7, 1.7, 24, [92, 98, 110]],
        [6, -64, 2.2, 2.2, 9, [150, 70, 48]], [8, -69, 2.0, 2.0, 11, [150, 70, 48]], [36, -80, 2.6, 2.0, 20, [80, 120, 160]], [39.4, -80.6, 2.2, 1.8, 26.8, [80, 120, 160]]];
      while (TW.length < NT){
        const zone = rnd(), x = zone < 0.55 ? 16 + (rnd() + rnd() - 1) * 26 : zone < 0.8 ? 40 + (rnd() + rnd() - 1) * 14 : 88 + (rnd() + rnd() - 1) * 44;
        const z = zone < 0.55 ? -75 + (rnd() + rnd() - 1) * 13 : zone < 0.8 ? -86 + (rnd() + rnd() - 1) * 10 : -84 + (rnd() + rnd() - 1) * 18;
        if (z > -62 || (x < 10 && z > -67) || hgt(x, z) > PL + 2 || TW.some((q) => Math.abs(q[0] - x) < 3.2 && Math.abs(q[1] - z) < 3.2) || AVES.some((a) => dSeg(x, z, a) < 2.2)) continue;
        const pal = [[110, 140, 172], [140, 150, 160], [168, 120, 96], [120, 128, 140], [186, 176, 160], [150, 80, 60]][(rnd() * 6) | 0], tall = Math.pow(rnd(), 2.4);
        TW.push([x, z, 1.3 + rnd() * 1.4, 1.3 + rnd() * 1.4, (zone < 0.8 ? 3 : 2.5) + tall * (zone < 0.8 ? 15 : 8), pal]);
      }
      TW.forEach((q, k) => { dm.position.set(q[0], hgt(q[0], q[1]) - 0.2, q[1]); dm.rotation.set(0, (rnd() - 0.5) * 0.1, 0); dm.scale.set(q[2], q[4], q[3]); dm.updateMatrix(); towers.setMatrixAt(k, dm.matrix); setC(towers, k, q[5], 1); });
      dio.add(towers);
      // the forest of the hills: eucalyptus and pine, thickest around the sanctuary
      const NTR = 4200, trees = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial(), NTR);
      const GREENS = [[38, 62, 34], [52, 80, 40], [66, 94, 46], [34, 54, 38], [80, 100, 50], [96, 108, 60]];
      let nt = 0;
      yield;
      for (let tries = 0; nt < NTR && tries < NTR * 6; tries++){
        if (tries % 1000 === 999) yield;
        const close = rnd() < 0.6, a = rnd() * 6.283, rr = 5.6 + Math.pow(rnd(), 1.5) * 34;
        const x = close ? Math.cos(a) * rr : (rnd() - 0.5) * 240, z = close ? Math.sin(a) * rr - 0.5 : -64 + rnd() * 110, h0 = hgt(x, z);
        if (h0 < PL + 1.5 || (x > -7.8 && x < 4.6 && z > -6.8 && z < 7.6)) continue;   // not on the city, the sanctuary or the plaza
        const s = 0.32 + rnd() * 0.5;
        dm.position.set(x, h0 + s * 1.2, z); dm.rotation.set(rnd() * 0.3, rnd() * 6.28, 0); dm.scale.set(s * (0.8 + rnd() * 0.5), s * (1.3 + rnd() * 0.8), s * (0.8 + rnd() * 0.5));
        dm.updateMatrix(); trees.setMatrixAt(nt, dm.matrix); setC(trees, nt, GREENS[(rnd() * GREENS.length) | 0], 0.75 + 0.4 * rnd()); nt++;
      }
      trees.count = nt; dio.add(trees);

      yield;
      /* the sanctuary: nave from the round apse (east, +Z) to the bell tower (west, -Z), a lower wing with an arcade on the
         plaza side, red tile everywhere */
      const san = new THREE.Group(); dio.add(san);
      const white = new THREE.MeshLambertMaterial({ color: C('#f4f0e7') }), stone = new THREE.MeshLambertMaterial({ color: C('#7d776e') });
      const redT = new THREE.MeshLambertMaterial({ color: C('#a63f28') }), dark = new THREE.MeshLambertMaterial({ color: C('#4e2a20') });
      const winRed = new THREE.MeshLambertMaterial({ color: C('#8a2618') }), ochre = new THREE.MeshLambertMaterial({ color: C('#d9b66e') });
      const tileC = makeCanvas(128, 128), tc = tileC.getContext('2d');
      tc.fillStyle = '#b4502f'; tc.fillRect(0, 0, 128, 128);
      for (let y = 0; y < 128; y += 8){ for (let x = ((y / 8) % 2) * 6 - 6; x < 128; x += 12){ const v = rnd(); tc.fillStyle = 'rgba(' + (130 + v * 70 | 0) + ',' + (48 + v * 34 | 0) + ',' + (28 + v * 18 | 0) + ',0.6)'; tc.fillRect(x, y, 11, 7); } tc.fillStyle = 'rgba(60,20,10,0.5)'; tc.fillRect(0, y + 7, 128, 1); }
      const tileTex = (rx, ry) => { const t = canvasTex(tileC, true); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); return t; };
      const roofLong = new THREE.MeshLambertMaterial({ map: tileTex(2, 9) }), roofRound = new THREE.MeshLambertMaterial({ map: tileTex(14, 2), side: THREE.DoubleSide });
      const drumC = makeCanvas(256, 64), dc = drumC.getContext('2d');
      dc.fillStyle = '#f4f0e7'; dc.fillRect(0, 0, 256, 64);
      for (let x = 4; x < 256; x += 16){ dc.fillStyle = '#4a3328'; dc.beginPath(); dc.moveTo(x, 50); dc.lineTo(x, 26); dc.arc(x + 4, 26, 4, Math.PI, 0); dc.lineTo(x + 8, 50); dc.fill(); }
      const drumM = new THREE.MeshLambertMaterial({ map: canvasTex(drumC, true) });
      const add = (geo, mat, x, y, z, rx, ry, rz) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx || 0, ry || 0, rz || 0); san.add(m); return m; };
      const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
      add(B(9.6, 1.6, 11.6), stone, -1.4, -0.79, 0.5);   // the stone terrace of the summit
      const paveC = makeCanvas(64, 64), pc = paveC.getContext('2d'); pc.fillStyle = '#b0644a'; pc.fillRect(0, 0, 64, 64);
      for (let y = 0; y < 64; y += 4) for (let x = (y % 8) ? 0 : 3; x < 64; x += 6){ pc.fillStyle = 'rgba(' + (120 + rnd() * 60 | 0) + ',60,44,0.5)'; pc.fillRect(x, y, 5, 3); }
      const paveT = canvasTex(paveC, true); paveT.wrapS = paveT.wrapT = THREE.RepeatWrapping; paveT.repeat.set(5, 9);
      add(B(4.6, 0.06, 10), new THREE.MeshLambertMaterial({ map: paveT }), -4.1, 0.04, 0.6);   // the plaza
      // nave and its gabled roof
      add(B(2.0, 1.6, 5.8), white, 0, 0.8, -0.1);
      const RA = Math.atan2(0.72, 1.22), RL = Math.hypot(1.22, 0.72);
      add(B(RL, 0.07, 6.1), roofLong, -0.61, 1.6 + 0.36, -0.1, 0, 0, RA); add(B(RL, 0.07, 6.1), roofLong, 0.61, 1.6 + 0.36, -0.1, 0, 0, -RA);
      const gable = new THREE.Shape(); gable.moveTo(-1.0, 0); gable.lineTo(1.0, 0); gable.lineTo(0, 0.68); gable.closePath();
      add(new THREE.ShapeGeometry(gable), white, 0, 1.6, -2.99, 0, Math.PI, 0); add(new THREE.ShapeGeometry(gable), white, 0, 1.6, 2.79);
      // the lower wings, with the arcade on the plaza side
      [-1, 1].forEach((sd) => {
        add(B(1.3, 1.05, 4.9), white, sd * 1.65, 0.53, -0.25);
        add(B(1.55, 0.06, 5.1), roofLong, sd * 1.7, 1.13, -0.25, 0, 0, -sd * 0.24);
        for (let k = 0; k < 6; k++){ const z = -2.3 + k * 0.85; add(B(0.04, 0.3, 0.22), ochre, sd * 1.01, 1.36, z); add(B(0.05, 0.22, 0.14), dark, sd * 1.01, 1.36, z); }   // clerestory windows
      });
      for (let k = 0; k < 5; k++){ const z = -2.2 + k * 0.95; add(B(0.05, 0.58, 0.5), dark, -2.29, 0.31, z); add(new THREE.CylinderGeometry(0.25, 0.25, 0.05, 12, 1, false, 0, Math.PI), dark, -2.29, 0.6, z, 0, 0, Math.PI / 2); }   // the arches
      for (let k = 0; k < 5; k++){ const z = -2.1 + k * 0.95; add(B(0.04, 0.32, 0.26), ochre, 2.31, 0.55, z); add(B(0.05, 0.24, 0.17), winRed, 2.31, 0.55, z); }
      add(B(0.05, 0.5, 0.36), new THREE.MeshLambertMaterial({ color: C('#8a5a34') }), -2.31, 0.27, 2.0);   // the wooden door
      // the round apse, its tile cone and the little drum with its ring of arched windows
      const AR = 2.35;
      add(new THREE.CylinderGeometry(AR, AR, 1.3, 48, 1, true, -Math.PI / 2, Math.PI), white, 0, 0.65, 2.8);
      add(B(2 * AR, 1.3, 0.05), white, 0, 0.65, 2.8);
      add(new THREE.ConeGeometry(AR + 0.18, 0.95, 48, 1, true, -Math.PI / 2, Math.PI), roofRound, 0, 1.3 + 0.47, 2.8);
      add(new THREE.CylinderGeometry(0.95, 0.95, 0.45, 32, 1, true, -Math.PI / 2, Math.PI), drumM, 0, 2.05, 2.45);
      add(new THREE.ConeGeometry(1.05, 0.36, 32, 1, true, -Math.PI / 2, Math.PI), roofRound, 0, 2.27 + 0.18, 2.45);
      // the bell tower: white shaft, red bands, arched openings, a pointed spire and its cross
      const TZ = -3.5;
      add(B(0.95, 3.5, 0.95), white, 0, 1.75, TZ);
      [[1.0, 3.5], [0.86, 4.27], [0.68, 4.86]].forEach(([s, y]) => add(B(s, 0.08, s), redT, 0, y, TZ));
      add(B(0.8, 0.74, 0.8), white, 0, 3.88, TZ); add(B(0.3, 0.42, 0.82), dark, 0, 3.86, TZ); add(B(0.82, 0.42, 0.3), dark, 0, 3.86, TZ);
      add(B(0.62, 0.55, 0.62), white, 0, 4.56, TZ); add(B(0.2, 0.26, 0.64), winRed, 0, 4.57, TZ); add(B(0.64, 0.26, 0.2), winRed, 0, 4.57, TZ);
      add(new THREE.ConeGeometry(0.46, 1.15, 4), white, 0, 4.9 + 0.575, TZ, 0, Math.PI / 4, 0);
      add(B(0.035, 0.34, 0.035), dark, 0, 6.2, TZ); add(B(0.18, 0.035, 0.035), dark, 0, 6.25, TZ);
      [1.2, 2.4].forEach((y) => { add(B(0.22, 0.34, 0.97), winRed, 0, y, TZ); add(B(0.97, 0.34, 0.22), winRed, 0, y, TZ); });
      add(B(0.36, 0.6, 0.04), new THREE.MeshLambertMaterial({ color: C('#8a5a34') }), 0, 0.3, TZ - 0.49);
      yield;
      // the flag on the roof
      const flC = makeCanvas(48, 32), fc = flC.getContext('2d'); fc.fillStyle = '#fcd116'; fc.fillRect(0, 0, 48, 16); fc.fillStyle = '#003893'; fc.fillRect(0, 16, 48, 8); fc.fillStyle = '#ce1126'; fc.fillRect(0, 24, 48, 8);
      add(B(0.025, 0.7, 0.025), dark, 0.75, 2.25, -2.55);
      const flag = add(new THREE.PlaneGeometry(0.36, 0.24).translate(0.18, 0, 0), new THREE.MeshLambertMaterial({ map: canvasTex(flC, true), side: THREE.DoubleSide }), 0.76, 2.48, -2.55);
      // pilgrims on the plaza
      const NP = 60, people = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.045, 0.17, 6).translate(0, 0.085, 0), new THREE.MeshLambertMaterial(), NP);
      for (let k = 0; k < NP; k++){ dm.position.set(-6.2 + rnd() * 4.0, 0.07, -3.8 + rnd() * 8.6); dm.rotation.set(0, 0, 0); dm.scale.set(1, 0.8 + rnd() * 0.4, 1); dm.updateMatrix(); people.setMatrixAt(k, dm.matrix); setC(people, k, [[40, 40, 52], [120, 40, 40], [60, 70, 100], [200, 190, 170], [30, 30, 30]][(rnd() * 5) | 0], 1); }
      san.add(people);
      // the cable car, from its station by the plaza down to the city, with a red cabin riding it
      add(B(1.4, 0.8, 1.1), white, -5.4, 0.4, 5.2); add(B(1.6, 0.06, 1.3), redT, -5.4, 0.84, 5.2);
      const cable = new THREE.QuadraticBezierCurve3(V(-5.4, 0.9, 4.6), V(-17, -6, -22), V(-28, PL + 3, -68));
      dio.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(cable.getPoints(40)), new THREE.LineBasicMaterial({ color: C('#3a3a3a') })));
      const cabin = new THREE.Mesh(B(0.42, 0.34, 0.34), redT); dio.add(cabin);
      // traffic: yellow taxis, white cars and the red TransMilenio buses on the avenues
      const NC = 260, cars = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial(), NC), CAR = [];
      for (let k = 0; k < NC; k++){ const bus = rnd() < 0.18, a = bus ? AVES[1 + ((rnd() * 2) | 0)] : AVES[(rnd() * AVES.length) | 0]; CAR.push({ a, s: rnd(), v: (0.004 + rnd() * 0.006) * (rnd() < 0.5 ? 1 : -1), bus, lane: (rnd() < 0.5 ? -1 : 1) * 0.35 }); setC(cars, k, bus ? [196, 30, 34] : rnd() < 0.45 ? [240, 196, 30] : [235, 235, 230], 1.2); }
      dio.add(cars);
      yield;
      // sky: a sunset haze at the horizon, heavy clouds above, the sun breaking through toward the city
      const skyM = new THREE.ShaderMaterial({
        uniforms: { uSun: { value: SUN }, uHaze: { value: HAZE }, uT: { value: 0 } }, side: THREE.BackSide, depthWrite: false, fog: false,
        vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform vec3 uSun, uHaze; uniform float uT; varying vec3 vD;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
          float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
          void main(){
            vec3 d = normalize(vD); float e = d.y, s = max(dot(d, uSun), 0.0);
            vec3 col = mix(uHaze * 1.1, vec3(0.09, 0.11, 0.17), smoothstep(-0.02, 0.45, e));
            col += vec3(1.1, 0.72, 0.4) * pow(s, 8.0) * 0.55 + vec3(3.0, 2.3, 1.5) * pow(s, 500.0);
            if (e > 0.0){
              vec2 p = d.xz / (e + 0.12) * 1.1 + vec2(uT * 0.015, 0.0);
              float c = smoothstep(0.4, 0.76, fbm(p)) * smoothstep(-0.01, 0.07, e);
              vec3 cc = mix(vec3(0.15, 0.15, 0.18), vec3(1.15, 0.78, 0.5), pow(s, 5.0) * 0.9 + 0.04);
              col = mix(col, cc, c * 0.93);
            }
            col = mix(col, uHaze, smoothstep(0.04, -0.12, e));
            gl_FragColor = vec4(col, 1.0);
          }` });
      dio.add(new THREE.Mesh(new THREE.SphereGeometry(950, 48, 24), skyM));
      // shafts of light falling from the gaps in the clouds onto the city
      const rayC = makeCanvas(32, 256), rc = rayC.getContext('2d');
      { const gv = rc.createLinearGradient(0, 0, 0, 256); gv.addColorStop(0, 'rgba(255,255,255,0)'); gv.addColorStop(0.3, 'rgba(255,255,255,1)'); gv.addColorStop(1, 'rgba(255,255,255,0)'); rc.fillStyle = gv; rc.fillRect(0, 0, 32, 256);
        rc.globalCompositeOperation = 'destination-in'; const gh = rc.createLinearGradient(0, 0, 32, 0); gh.addColorStop(0, 'rgba(0,0,0,0)'); gh.addColorStop(0.5, 'rgba(0,0,0,1)'); gh.addColorStop(1, 'rgba(0,0,0,0)'); rc.fillStyle = gh; rc.fillRect(0, 0, 32, 256); }
      const rayT = canvasTex(rayC, true), rays = [];
      for (let k = 0; k < 7; k++){
        const m = new THREE.Mesh(new THREE.PlaneGeometry(14 + rnd() * 16, 190), new THREE.MeshBasicMaterial({ map: rayT, color: C('#ffc98a'), transparent: true, opacity: 0.1 + rnd() * 0.1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
        m.position.set(-150 + k * 42 + rnd() * 20, 30, -170 - rnd() * 110); dio.add(m); rays.push({ m, tilt: -0.28 + (rnd() - 0.5) * 0.12 });
      }
      /* the drone: high behind the apse (the classic view), over the nave and past the tower, then down the slope into the
         towers of the centre */
      const camP = new THREE.CatmullRomCurve3([V(5.5, 7.6, 11.5), V(-7.2, 5.2, 6.8), V(2.6, 4.8, 1.0), V(2.6, 3.6, -9.5), V(4, -16, -33), V(3, -37, -57)]);
      const camT = new THREE.CatmullRomCurve3([V(0, 0.4, -4.5), V(-1, 0.6, -1), V(-0.3, 3.4, -6.0), V(5, -18, -60), V(16, -40, -90), V(24, -40, -100)]);
      const KT = [3.0, 6.0, 8.6, 10.4, 12.0, 13.6];   // when the drone reaches each key
      const dcam = new THREE.PerspectiveCamera(52, 1.5, 0.1, 2400), look = new THREE.Vector3();
      const rt = new THREE.WebGLRenderTarget(1100, 734, { samples: gl2 ? 2 : 0 });   // light on memory: 8-bit colour, a little antialiasing
      function film(t, k, qs){
        camP.getPoint(k, dcam.position); camT.getPoint(k, look);
        dcam.position.x += 0.25 * Math.sin(t * 0.7); dcam.position.y += 0.15 * Math.sin(t * 0.9 + 1);   // a drone never holds perfectly still
        dcam.lookAt(look); if (qs) dcam.quaternion.multiply(qs); dcam.updateMatrixWorld();
        skyM.uniforms.uT.value = t;
        flag.rotation.y = 0.35 * Math.sin(t * 3.1) + 0.15 * Math.sin(t * 7.3);
        cable.getPoint((t * 0.03) % 1, cabin.position);
        CAR.forEach((c, k2) => {
          c.s = (c.s + c.v * 0.033 + 1) % 1; const a = c.a, dx = a[2] - a[0], dz = a[3] - a[1], L2 = Math.hypot(dx, dz);
          const x = a[0] + dx * c.s - dz / L2 * c.lane, z = a[1] + dz * c.s + dx / L2 * c.lane;
          dm.position.set(x, hgt(x, z) + 0.02, z); dm.rotation.set(0, Math.atan2(dx, dz), 0); dm.scale.set(c.bus ? 0.26 : 0.18, c.bus ? 0.32 : 0.14, c.bus ? 1.8 : 0.4);
          dm.updateMatrix(); cars.setMatrixAt(k2, dm.matrix);
        });
        cars.instanceMatrix.needsUpdate = true;
        rays.forEach((r) => { r.m.quaternion.copy(dcam.quaternion); r.m.rotateZ(r.tilt); });
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(rt); renderer.clear(); renderer.render(dio, dcam); renderer.setRenderTarget(prev);
      }
      // the crack: a mask painted on a canvas (black inside, a hot rim around it); the drone's picture shows through it
      const W = 1024, H = 683, L = liveTex(W, H);
      const crackM = new THREE.ShaderMaterial({
        uniforms: { tMask: { value: L.tx }, tDio: { value: rt.texture } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D tMask, tDio; varying vec2 vUv;
          void main(){ vec4 m = texture2D(tMask, vUv); vec3 d = texture2D(tDio, vUv).rgb; gl_FragColor = vec4(d * (1.0 - min(m.rgb, vec3(1.0))) + m.rgb * 2.0, m.a); }` });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), crackM);
      const G = newGroup(); G.add(plane);
      let crack = [];
      const halfW = (i, y, w) => w * (95 + 55 * Math.sin(i * 1.7)) * Math.sin(Math.PI * THREE.MathUtils.clamp(y / H, 0.04, 0.96));
      function drawMask(w, open){
        const g = L.g; g.clearRect(0, 0, W, H);
        if (w > 0.001){
          g.save(); g.beginPath();
          crack.forEach(([x, y], i) => { const hw = lerp(halfW(i, y, w), W, open); if (i) g.lineTo(x - hw, y); else g.moveTo(x - hw, y); });
          for (let i = crack.length - 1; i >= 0; i--){ const [x, y] = crack[i]; g.lineTo(x + lerp(halfW(i, y, w) * 0.8, W, open), y); }
          g.closePath(); g.fillStyle = '#000'; g.fill();
          if (open < 0.98){ g.strokeStyle = 'rgba(255,241,214,' + (1 - open) + ')'; g.shadowColor = '#ffb46a'; g.shadowBlur = 24; g.lineWidth = 4; g.stroke(); }
          g.restore();
          if (open > 0.02){   // once it is wide open the picture melts softly into the tunnel at its edges
            g.save(); g.globalCompositeOperation = 'destination-in';
            const m = g.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.62); m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,' + (1 - open) + ')');
            g.fillStyle = m; g.fillRect(0, 0, W, H); g.restore();
          }
        }
        L.tx.needsUpdate = true;
      }
      yield;
      // its shaders are handed to the driver now, without waiting for them (they finish in parallel, long before the show)
      { const kids = dio.children.slice(), lights = kids.filter((o) => o.isLight);   // one piece at a time, leaving everything as it was between pieces
        for (const o of kids){
          if (o.isLight) continue;
          const ce = renderer.debug.checkShaderErrors; renderer.debug.checkShaderErrors = false;
          dio.children = lights.concat([o]); renderer.compile(dio, dcam); dio.children = kids;
          renderer.debug.checkShaderErrors = ce;
          yield;
        } }
      yield;
      const home = new THREE.Vector3(), near = new THREE.Vector3(), fwd = new THREE.Vector3(), faceQ = new THREE.Quaternion();
      const qRef = new THREE.Quaternion(), qD = new THREE.Quaternion(), qS = new THREE.Quaternion(), qI = new THREE.Quaternion();
      let acc = 0, kf = 0, lookRef = false;
      return {
        start(t){
          crack = []; for (let y = -20; y < H + 20; y += 26 + Math.random() * 34) crack.push([W / 2 + (Math.random() - 0.5) * 80, y]);
          // the window takes the shape of the screen, so a phone held upright gets an upright view of the city
          const asp = THREE.MathUtils.clamp(camera.aspect, 0.55, 1.7);
          plane.scale.set(4 * asp, 4, 1);
          if (asp < 1) rt.setSize(Math.round(960 * asp), 960); else rt.setSize(1100, Math.round(1100 / asp));
          dcam.aspect = asp; dcam.fov = asp < 1 ? 68 : 52; dcam.filmOffset = asp < 1 ? -3 : 0; dcam.updateProjectionMatrix();   // upright phones: the subject sits a little right of centre, clear of the astronaut
          home.copy(P.anchor); G.position.copy(home); faceCam(G); G.visible = true; acc = 1; kf = 0; lookRef = false; qS.identity();
          film(t || 0, 0); drawMask(0, 0);
        },
        update(lt, raw, t){
          // the crack opens; the portal comes forward with the classic view of Monserrate and opens wide; only then the drone sets off
          let w = easeIO(smooth(0.3, 1.6, lt)) * (1 - easeIO(smooth(15.4, 16.8, lt)));
          let win = easeIO(smooth(1.4, 3.4, lt)) * (1 - easeIO(smooth(14.8, 16.2, lt)));
          let i = 0; while (i < KT.length - 2 && lt > KT[i + 1]) i++;
          let kT = lt <= KT[0] ? 0 : Math.min(1, (i + THREE.MathUtils.clamp((lt - KT[i]) / (KT[i + 1] - KT[i]), 0, 1)) / (KT.length - 1));
          if (this.peek != null){ w = 1; win = 1; kT = kf = this.peek; }   // debug: any point of the flight
          kf += (kT - kf) * (1 - Math.exp(-raw * 2.2));   // eased, so the drone never jerks from one key to the next
          const open = smooth(0.15, 0.85, win);
          // the portal stops just behind the astronaut and fills most of the view, never the whole of it: the astronaut stays in front, looking in
          camera.getWorldDirection(fwd);
          const dP = Math.max(_ms.copy(astro.position).sub(camera.position).dot(fwd) + 2.6, 5.5);
          const fillS = 2 * dP * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / 4 * 0.9;
          near.copy(camera.position).addScaledVector(fwd, dP);
          G.position.lerpVectors(home, near, win); faceCam(G); faceQ.copy(G.quaternion); G.quaternion.copy(faceQ).slerp(camera.quaternion, win); G.scale.setScalar(lerp(1, fillS, win));
          // with the portal open, turning the phone looks around inside Bogotá
          if (win > 0.5){ if (!lookRef){ qRef.copy(camera.quaternion); lookRef = true; } qD.copy(qRef).invert().multiply(camera.quaternion); qI.identity().slerp(qD, 0.9); }
          else { lookRef = false; qI.identity(); }
          qS.slerp(qI, 1 - Math.exp(-raw * 6));
          acc += raw;
          if (acc > 1 / 30){ acc = 0; if (w > 0.001) film(t, kf, qS); drawMask(w, open); }
          momentFx.look.copy(G.position); momentFx.lookOn = true;   // the astronaut watches the portal
          _mp.set(1, 0, 0).applyQuaternion(camera.quaternion); momentFx.astro.addScaledVector(_mp, -0.6 * win); _mp.set(0, 1, 0).applyQuaternion(camera.quaternion); momentFx.astro.addScaledVector(_mp, -0.3 * win);   // and drifts to the side, so the view of the city stays clear
          momentFx.ca += 0.02 * smooth(0.3, 0.7, lt) * (1 - smooth(0.7, 1.5, lt)) + 0.01 * smooth(1.4, 2.2, lt) * (1 - smooth(2.2, 3.4, lt));
          momentFx.dim -= 0.25 * win;   // the light of the city spills into the tunnel
        },
        end(){ G.visible = false; }
      };
      })();
      let inst = null;
      const finish = () => { while (!inst){ const r = job.next(); if (r.done) inst = r.value; } return inst; };
      return {
        step(){ if (!inst){ const r = job.next(); if (r.done) inst = r.value; } return !!inst; },
        start(t){ finish().start(t); },
        update(lt, raw, t){ inst.peek = this.peek; inst.update(lt, raw, t); },
        end(){ if (inst) inst.end(); }
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
    { name: 'Coro de orbes', line: 'Siete esferas de colores cantan y el túnel entero se tiñe con cada nota.', dur: 15, make(P){
      // the show is fixed to the camera, so it fills the screen wherever you are looking
      const stage = newGroup(), N = 7, orbs = [];
      const COL = (i) => new THREE.Color().setHSL(i / N * 0.85, 0.95, 0.55);
      for (let i = 0; i < N; i++){
        const c = COL(i), g = new THREE.Group(); stage.add(g);
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.55, 32, 20), lit(c.clone().multiplyScalar(0.8))); g.add(core);
        const halo = sprite(dotTex, c.clone().multiplyScalar(1.6)); halo.scale.setScalar(2.6); g.add(halo);
        const wave = sprite(novaRingTex, c.clone().multiplyScalar(2)); wave.visible = false; stage.add(wave);
        const pg = new THREE.PlaneGeometry(0.5, 30); pg.translate(0, 15, 0); const pillar = new THREE.Mesh(pg, addMat(c.clone().multiplyScalar(0.5))); g.add(pillar);
        orbs.push({ g, core, halo, wave, pillar, c, hit: -9 });
      }
      // a rainbow ribbon that follows the melody from orb to orb
      const RIB = 600, rgeo = new THREE.BufferGeometry(), rp = new Float32Array(RIB * 3), rc = new Float32Array(RIB * 3);
      rgeo.setAttribute('position', new THREE.BufferAttribute(rp, 3)); rgeo.setAttribute('color', new THREE.BufferAttribute(rc, 3));
      const rmat = new THREE.PointsMaterial({ size: 0.14, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const ribbon = new THREE.Points(rgeo, rmat); ribbon.frustumCulled = false; stage.add(ribbon);
      const head = new THREE.Vector3(), hist = []; for (let i = 0; i < RIB; i++) hist.push(new THREE.Vector3(0, 0, -10));
      // the melody: a rising and falling arpeggio, then faster triads, then a chord that swirls into one light
      const NOTES = [];
      const up = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 0];
      up.forEach((n, i) => NOTES.push([1.4 + i * 0.36, n]));
      [0, 2, 4, 1, 3, 5, 2, 4, 6, 6, 4, 2, 5, 3, 1, 4, 2, 0].forEach((n, i) => NOTES.push([6.2 + i * 0.24, n]));
      const CHORD = 10.8;
      const basePos = (i, out) => { const a = (i / (N - 1) - 0.5) * 2.4; return out.set(Math.sin(a) * 6.2, -2.4 + Math.cos(a) * 3.4, -10); };
      let ni = 0, cur = 0;
      return {
        start(){ stage.visible = true; ni = 0; orbs.forEach((o) => { o.hit = -9; }); hist.forEach((h) => h.set(0, 0, -10)); },
        update(lt, raw, t){
          stage.position.copy(camera.position); stage.quaternion.copy(camera.quaternion);
          const e = env(lt, 15, 1.2, 1.8), chord = smooth(CHORD, CHORD + 1.2, lt), finale = smooth(13.0, 13.4, lt) * (1 - smooth(13.4, 14.6, lt));
          while (ni < NOTES.length && lt >= NOTES[ni][0]){ cur = NOTES[ni][1]; orbs[cur].hit = lt; ni++; }
          if (lt >= CHORD && lt - raw < CHORD) orbs.forEach((o) => { o.hit = lt; });
          let beat = 0;
          orbs.forEach((o, i) => {
            const k = Math.max(0, 1 - (lt - o.hit) / 0.5); beat = Math.max(beat, k);
            basePos(i, _mp);
            // in the chord the orbs leave their arc and whirl around the centre of the view
            const a = lt * 2.2 + i / N * Math.PI * 2, rr = lerp(6, 2.5 + 2 * Math.sin(lt * 3), smooth(CHORD + 1.5, 13, lt));
            _ms.set(Math.cos(a) * rr, Math.sin(a) * rr * 0.8, -9);
            o.g.position.lerpVectors(_mp, _ms, chord); o.g.position.y += 0.2 * Math.sin(t * 2 + i);
            o.g.scale.setScalar(Math.max(0.001, e * (1 + 0.6 * k)));
            o.core.material.color.copy(o.c).multiplyScalar(0.5 + 3 * k);
            o.halo.material.opacity = (0.35 + 0.65 * k) * e; o.halo.scale.setScalar(2.4 + 3 * k);
            o.pillar.material.opacity = (0.08 + 0.5 * k) * e * (1 - chord);
            const wk = Math.min(1, (lt - o.hit) / 1.4);   // each note sends a ring of its colour across the whole screen
            o.wave.visible = wk < 1 && wk >= 0; o.wave.position.copy(o.g.position); o.wave.scale.setScalar(1 + 30 * wk); o.wave.material.opacity = (1 - wk) * 0.8 * e;
          });
          // the ribbon chases the orb that is singing
          head.lerp(orbs[cur].g.position, 1 - Math.exp(-raw * 10));
          const last = hist.pop(); last.copy(head).add(_mv.set(Math.sin(t * 7) * 0.3, Math.cos(t * 5) * 0.3, 0)); hist.unshift(last);
          for (let i = 0; i < RIB; i++){ const h = hist[i]; rp[i * 3] = h.x; rp[i * 3 + 1] = h.y; rp[i * 3 + 2] = h.z; const c = orbs[Math.floor(i / RIB * N)].c; rc[i * 3] = c.r * 2; rc[i * 3 + 1] = c.g * 2; rc[i * 3 + 2] = c.b * 2; }
          rgeo.attributes.position.needsUpdate = true; rgeo.attributes.color.needsUpdate = true; rmat.opacity = 0.9 * e;
          // the whole tunnel takes the colour of the note, flashes with it, and ripples
          momentFx.tint.copy(orbs[cur].c); if (chord > 0) momentFx.tint.setHSL((t * 0.6) % 1, 1, 0.55);
          momentFx.tintA = Math.max(momentFx.tintA, (0.3 + 0.35 * beat) * e);
          momentFx.dim -= (0.3 * beat + 0.7 * finale) * e; momentFx.ca += 0.012 * beat * e + 0.05 * finale;
          momentFx.music = e; momentFx.beat = Math.max(momentFx.beat, beat * e); momentFx.beatN = ni;
          if (beat > 0.9){ momentFx.ripA = Math.max(momentFx.ripA, 0.6 * e); momentFx.ripX = 0.5; momentFx.ripY = 0.55; momentFx.ripR = (1 - beat) * 3; }
        },
        end(){ stage.visible = false; }
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
            vV = -mv.xyz; vec3 nn = normalMatrix * mat3(instanceMatrix) * normal; vN = nn / max(length(nn), 1e-5);
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
            vec3 c = tint * (0.025 + 0.12 * f + 0.75 * edge + 0.35 * band + 0.2 * pow(h, 6.0)) + vec3(0.55, 0.42, 0.16) * uFlash * (0.3 + edge);
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
        start(){ build(); walls.count = wallList.length; G.position.copy(P.anchor); faceCam(G); G.rotateX(1.0); G.visible = true; },
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
          for (let i = 0; i < TRAIL; i++){ const d = run - i * 0.03; if (d < 0){ trail.pos.set([0, 1e4, 0], i * 3); continue; } along(d, _mp); trail.pos.set([_mp.x, _mp.y - 0.04 * (i / TRAIL), _mp.z], i * 3); }   // only the part already travelled, never piled up on one spot
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
    { name: 'Concierto de púlsares', line: 'Las estrellas se vuelven un concierto: todo el túnel late con la música.', dur: 16, make(P){
      const stage = newGroup(), BPM = 124, BEAT = 60 / BPM;
      // eight pulsars around the view, each sweeping two beams of light across the screen
      const pulsars = [];
      for (let i = 0; i < 8; i++){
        const a = i / 8 * Math.PI * 2 + 0.2, g = new THREE.Group(); g.position.set(Math.cos(a) * 7.5, Math.sin(a) * 4.8, -11 - (i % 2) * 4); stage.add(g);
        const hue = i / 8, core = sprite(novaCoreTex, new THREE.Color().setHSL(hue, 0.8, 0.7).multiplyScalar(1.8)); core.scale.setScalar(1.5); g.add(core);
        const beams = new THREE.Group(); beams.rotation.x = 0.4 + i * 0.3; g.add(beams);
        for (const s of [0, Math.PI]){ const geo = new THREE.ConeGeometry(0.45, 28, 20, 1, true); geo.translate(0, -14, 0); const cn = new THREE.Mesh(geo, addMat(new THREE.Color().setHSL(hue, 0.9, 0.5).multiplyScalar(0.9))); cn.rotation.z = s; beams.add(cn); }
        pulsars.push({ g, core, beams, hue, sp: (1.2 + i * 0.25) * (i % 2 ? 1 : -1), on: 0.3 + i * 0.25 });
      }
      // the heart of the show: a giant star at the centre of the tunnel, and lasers fanning out from it
      const sun = sprite(novaCoreTex, HC(2.4, 2.2, 2.0)); sun.position.set(0, 0, -20); stage.add(sun);
      const LZ = 40, lasers = segsOf(LZ, HC(1, 1, 1)); stage.add(lasers.l);
      for (let i = 0; i < LZ; i++){ const a = i / LZ * Math.PI * 2; lasers.pos.set([0, 0, -20, Math.cos(a) * 26, Math.sin(a) * 18, -4], i * 6); } lasers.flush();
      const rings = []; for (let i = 0; i < 6; i++){ const r = sprite(novaRingTex, HC(1.4, 1.4, 2)); r.visible = false; r.position.set(0, 0, -12); stage.add(r); rings.push({ r, t0: -9 }); }
      const SN = 500, stars = pointsOf(SN, 0.12, HC(1.4, 1.4, 1.8)); stage.add(stars.p);
      for (let i = 0; i < SN; i++){ const a = Math.random() * 6.28, r = 2 + Math.random() * 16; stars.pos.set([Math.cos(a) * r, Math.sin(a) * r * 0.7, -6 - Math.random() * 20], i * 3); } stars.flush();
      let lastBeat = -1, ri = 0;
      return {
        start(){ stage.visible = true; lastBeat = -1; },
        update(lt, raw, t){
          stage.position.copy(camera.position); stage.quaternion.copy(camera.quaternion);
          const e = env(lt, 16, 1.5, 2.0), bt = Math.max(0, lt - 1.6), beatN = Math.floor(bt / BEAT), ph = (bt % BEAT) / BEAT, playing = lt > 1.6 && lt < 14.5 ? 1 : 0;
          const kick = Math.exp(-ph * 7) * playing, hat = Math.exp(-((ph + 0.5) % 1) * 16) * 0.5 * playing;
          const bar = Math.floor(beatN / 4), drop = smooth(8.6, 8.8, lt) * (1 - smooth(8.8, 10.6, lt));   // the drop: everything flashes white
          const hue = (bar * 0.13 + lt * 0.02) % 1;
          if (beatN !== lastBeat && playing){ lastBeat = beatN; const R = rings[ri++ % rings.length]; R.t0 = lt; R.r.visible = true; R.r.material.color.setHSL(hue, 0.9, 0.6).multiplyScalar(2); }
          pulsars.forEach((q, i) => {
            const lit2 = smooth(q.on, q.on + 0.4, lt) * e;   // they light up one by one
            q.beams.rotation.z += raw * q.sp * (1 + 2.5 * kick + 3 * drop);
            q.core.scale.setScalar((1.2 + 2.6 * kick) * lit2); q.core.material.opacity = (0.4 + 0.6 * kick) * lit2;
            q.beams.children.forEach((c) => { c.material.opacity = (0.15 + 0.55 * (i % 2 ? kick : hat * 2) + 0.6 * drop) * lit2; c.material.color.setHSL((q.hue + hue) % 1, 0.9 - 0.8 * drop, 0.5).multiplyScalar(0.9 + drop); });
          });
          sun.scale.setScalar((4 + 6 * kick + 14 * drop) * e); sun.material.opacity = (0.5 + 0.5 * kick) * e;
          lasers.mat.color.setHSL((hue + 0.5) % 1, 1 - drop, 0.55).multiplyScalar(1.6); lasers.mat.opacity = ((beatN % 2 ? 0.5 : 0.2) * kick + 0.6 * drop) * e;
          stars.mat.opacity = (0.3 + 0.7 * hat + 0.5 * kick) * e;
          rings.forEach((R) => { const q = (lt - R.t0) / 1.2; if (q < 0 || q > 1){ R.r.material.opacity = 0; return; } R.r.scale.setScalar(1 + 26 * q); R.r.material.opacity = (1 - q) * 0.7 * e; });
          // the whole tunnel pulses: colour per bar, a flash on every kick, ripples, and the fall speeds up with the beat
          momentFx.tint.setHSL(hue, 0.95, 0.55); momentFx.tintA = Math.max(momentFx.tintA, (0.32 + 0.25 * kick) * e * (1 - drop));
          momentFx.dim -= (0.35 * kick + 0.9 * drop) * e; momentFx.ca += (0.02 * kick + 0.05 * drop) * e;
          momentFx.flowMul *= 1 + (1.5 * kick + 2 * drop) * e;
          momentFx.music = e; momentFx.beat = Math.max(momentFx.beat, kick * e); momentFx.beatN = beatN;
          if (kick > 0.8){ momentFx.ripA = Math.max(momentFx.ripA, 0.7 * e); momentFx.ripX = 0.5; momentFx.ripY = 0.5; momentFx.ripR = ph * 3; }
          momentFx.astroSpin += 0.6 * drop;
        },
        end(){ stage.visible = false; rings.forEach((R) => { R.r.visible = false; }); }
      };
    } },
    { name: 'Estás aquí', line: 'Un mapa de la galaxia se despliega, se acerca al Sol… y te señala: «Estás aquí».', dur: 12, make(P){
      const G = newGroup();
      // the Milky Way: a warm core and two spiral arms of blue and pink stars
      const NG = 4200, ggeo = new THREE.BufferGeometry(), gp = new Float32Array(NG * 3), gc = new Float32Array(NG * 3), tc = new THREE.Color();
      for (let i = 0; i < NG; i++){
        const core = i < NG * 0.22, r = core ? Math.pow(Math.random(), 1.6) * 0.55 : 0.35 + Math.pow(Math.random(), 0.7) * 2.3;
        const a = core ? Math.random() * 6.28 : (i % 2) * Math.PI + r * 2.3 + (Math.random() - 0.5) * (0.55 / (0.4 + r * 0.3));
        gp[i * 3] = Math.cos(a) * r; gp[i * 3 + 1] = Math.sin(a) * r; gp[i * 3 + 2] = (Math.random() - 0.5) * 0.12 * (1.5 - Math.min(1, r / 2.6));
        if (core) tc.setRGB(2.4, 1.7, 1.0); else tc.setHSL(Math.random() < 0.7 ? 0.6 : 0.88, 0.8, 0.6).multiplyScalar(1.3 + Math.random());
        gc[i * 3] = tc.r; gc[i * 3 + 1] = tc.g; gc[i * 3 + 2] = tc.b;
      }
      ggeo.setAttribute('position', new THREE.BufferAttribute(gp, 3)); ggeo.setAttribute('color', new THREE.BufferAttribute(gc, 3));
      const gmat = new THREE.PointsMaterial({ size: 0.05, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, sizeAttenuation: true });
      const galaxy = new THREE.Points(ggeo, gmat); galaxy.frustumCulled = false;
      const gpivot = new THREE.Group(); gpivot.add(galaxy); G.add(gpivot);
      const coreGlow = glow(HC(2.0, 1.3, 0.7), 1.8); galaxy.add(coreGlow);
      const SUN = V(Math.cos(2.3 * 1.6) * 1.6, Math.sin(2.3 * 1.6) * 1.6, 0);   // out in a spiral arm, where the Sun is
      const marker = sprite(novaRingTex, HC(0.6, 2.2, 1.4)); marker.position.copy(SUN); galaxy.add(marker);
      // the solar system, revealed by the zoom, with the Earth pulsing
      const sys = new THREE.Group(); G.add(sys);
      const planets = [0.35, 0.55, 0.8, 1.05, 1.5, 1.95].map((r, i) => {
        const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.005, r + 0.005, 128), addMat(HC(0.4, 0.7, 1.0))); sys.add(ring);
        const pl = sprite(dotTex, i === 2 ? HC(0.6, 1.4, 2.6) : HC(1.6, 1.3, 1.0)); pl.scale.setScalar(i === 2 ? 0.24 : 0.12 + i * 0.025); sys.add(pl);
        return { ring, pl, r, a: 0, sp: 0.9 / Math.pow(r, 1.5) };
      });
      const sun = glow(HC(2.6, 2.0, 1.0), 0.7); sys.add(sun);
      const earthPulse = sprite(novaRingTex, HC(0.6, 1.6, 2.6)); sys.add(earthPulse);
      // the map's own frame: range rings and a caption
      const grid = new THREE.Group(); G.add(grid);
      for (let i = 1; i <= 3; i++) grid.add(new THREE.Mesh(new THREE.RingGeometry(i - 0.005, i + 0.005, 128), addMat(HC(0.25, 0.5, 0.8))));
      const caption = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.45), addMat(HC(1.2, 1.4, 1.6), texOf(640, 80, (g) => { g.font = '500 28px "IBM Plex Mono", monospace'; g.fillStyle = '#bfe9ff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('VÍA LÁCTEA · BRAZO DE ORIÓN · SISTEMA SOLAR', 320, 40); })));
      caption.position.set(0, -2.9, 0); G.add(caption);
      const words = textStars('ESTÁS AQUÍ', 5.5, HC(2.4, 2.0, 1.2)); words.stars.p.position.set(0, 2.5, 0.2); G.add(words.stars.p);
      const arrow = segsOf(3, HC(2.4, 2.0, 1.2)); arrow.l.visible = false; scene.add(arrow.l);
      const Z = V(0, 0, 1), sunNow = new THREE.Vector3();
      return {
        start(){ G.position.copy(P.anchor); faceCam(G); G.rotateX(-0.5); G.visible = arrow.l.visible = true; planets.forEach((q) => { q.a = Math.random() * 6.28; }); },
        update(lt, raw, t){
          const e = env(lt, 12, 0.8, 1.2), zoom = easeIO(smooth(3.6, 6.8, lt));
          galaxy.rotation.z = lt * 0.12;
          // fly into the Sun's place: the galaxy grows around it until the solar system takes over
          const s = 1 + 16 * zoom * zoom; gpivot.scale.setScalar(s);
          sunNow.copy(SUN).applyAxisAngle(Z, galaxy.rotation.z); gpivot.position.copy(sunNow).multiplyScalar(-s * zoom);
          gmat.opacity = e * (1 - smooth(5.5, 7.0, lt)); gmat.size = 0.05 * (1 + zoom * 2);
          coreGlow.material.opacity = e * (1 - smooth(4, 6, lt));
          marker.material.opacity = e * smooth(2.4, 3.0, lt) * (1 - smooth(5.0, 5.8, lt)); marker.scale.setScalar(0.25 + 0.08 * Math.sin(t * 6));
          grid.children.forEach((r) => { r.material.opacity = 0.5 * e * (1 - zoom); });
          const on = smooth(5.6, 7.0, lt) * e; sys.scale.setScalar(Math.max(0.001, 0.4 + 0.6 * on));
          planets.forEach((q) => { q.a += raw * q.sp; q.pl.position.set(Math.cos(q.a) * q.r, Math.sin(q.a) * q.r, 0); q.pl.material.opacity = on; q.ring.material.opacity = 0.6 * on; });
          sun.material.opacity = on;
          const earth = planets[2].pl, pk = (lt * 0.8) % 1;
          earthPulse.position.copy(earth.position); earthPulse.scale.setScalar(0.2 + 0.8 * pk); earthPulse.material.opacity = on * (1 - pk) * smooth(7, 7.5, lt);
          caption.material.opacity = e * smooth(1.2, 2.2, lt);
          words.update(smooth(7.2, 9.0, lt) * (1 - smooth(10.6, 11.8, lt)), t, e);
          // a line from the Earth on the map down to the astronaut, with an arrowhead
          const ak = smooth(8.0, 9.4, lt) * (1 - smooth(10.8, 11.8, lt));
          earth.getWorldPosition(_mp); _ms.lerpVectors(_mp, astro.position, 0.9 * ak);
          _mv.subVectors(_mp, _ms).normalize().multiplyScalar(0.35); _mto.crossVectors(_mv, P.out).normalize().multiplyScalar(0.2);
          arrow.pos.set([_mp.x, _mp.y, _mp.z, _ms.x, _ms.y, _ms.z,
            _ms.x, _ms.y, _ms.z, _ms.x + _mv.x + _mto.x, _ms.y + _mv.y + _mto.y, _ms.z + _mv.z + _mto.z,
            _ms.x, _ms.y, _ms.z, _ms.x + _mv.x - _mto.x, _ms.y + _mv.y - _mto.y, _ms.z + _mv.z - _mto.z]);
          arrow.flush(); arrow.mat.opacity = ak;
          momentFx.ca += 0.015 * smooth(3.8, 4.4, lt) * (1 - smooth(4.4, 6.0, lt));
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
  // the five lights sit on an ellipse around the aim, 32° wide and 22° tall, at evenly spaced angles: the closest pairs are
  // about 28° apart (they were about 18°). None is within reach of the aim from the first view (the catch radius is 16.5°);
  // a few are on screen at the start, the rest are found by following the guiding arrow
  const LIGHTS = document.getElementById('lights');
  const D2R = THREE.MathUtils.degToRad;
  const cam0 = new THREE.PerspectiveCamera(); cam0.position.copy(MT).add(new THREE.Vector3().setFromSpherical(HOME)); cam0.lookAt(MT); cam0.updateMatrixWorld();   // the first view
  const RING_X = 32, RING_Y = 22, RING_LIFT = 12, RING_AT = [18, 90, 162, 234, 306];   // degrees: the ellipse, the aim's height, where each light sits
  const ringPoint = (k) => { const a = D2R(RING_AT[k]); return { yaw: RING_X * Math.cos(a), pitch: RING_LIFT + RING_Y * Math.sin(a) }; };
  const points = [
    { ...ringPoint(1), dist: 14, color: HC(0.5, 1.4, 2.0), defs: TIME },                 // straight above the ship
    { ...ringPoint(0), dist: 14, color: HC(2.0, 0.5, 1.6), defs: CREATURES },            // right, above the ship
    { ...ringPoint(2), dist: 14, color: HC(0.6, 2.2, 1.2), defs: VISITORS },             // left, above the ship
    { ...ringPoint(3), dist: 14, color: HC(2.2, 1.3, 0.6), defs: PHYSICS },              // left, below the ship
    { ...ringPoint(4), dist: 14, color: HC(1.0, 0.8, 2.6), defs: SIGNALS }               // right, below the ship
  ].map((d) => {
    const y = D2R(d.yaw), x = D2R(d.pitch);
    const out = V(Math.sin(y) * Math.cos(x), Math.sin(x), -Math.cos(y) * Math.cos(x)).applyQuaternion(cam0.quaternion).normalize();
    const right = new THREE.Vector3().crossVectors(out, V(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(right, out).normalize();
    const anchor = cam0.position.clone().addScaledVector(out, d.dist), glint = sprite(novaCoreTex, d.color);
    glint.position.copy(anchor); scene.add(glint);
    const ring = sprite(novaRingTex, d.color.clone().multiplyScalar(0.8)); ring.position.copy(anchor); scene.add(ring);
    const aura = sprite(nebulaTex, d.color.clone().multiplyScalar(0.3)); aura.position.copy(anchor).addScaledVector(out, 2); aura.visible = false; scene.add(aura);
    // its twin on the page: a crisp orb over the canvas, always readable even against the bright throat, and tappable
    const orb = document.createElement('button'); orb.type = 'button'; orb.className = 'light'; orb.setAttribute('aria-label', 'Descubrir un momento oculto'); orb.innerHTML = '<i></i>';
    const cc = d.color.clone(), mx = Math.max(cc.r, cc.g, cc.b); cc.multiplyScalar(1 / mx).convertLinearToSRGB();
    const orbCss = (k) => 'rgb(' + Math.round(k.r * 255) + ',' + Math.round(k.g * 255) + ',' + Math.round(k.b * 255) + ')';
    orb.style.setProperty('--c', orbCss(cc));
    orb.style.setProperty('--l', orbCss(cc.clone().lerp(new THREE.Color(1, 1, 1), 0.5)));
    orb.style.setProperty('--d', orbCss(cc.clone().multiplyScalar(0.2)));
    if (LIGHTS) LIGHTS.appendChild(orb);
    return { anchor, out, right, up, color: d.color, ring, aura, orb, defs: d.defs, bag: shuffle(d.defs.map((_, i) => i).slice(1)), last: 0, first: true, glint, glint0: 0.075 * d.dist, state: 'idle', time: 0, dwell: 0, cur: null, ph: Math.random() * 6.28 };
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
  /* when an event starts, the camera glides to the view that frames it best: its light at the sweet spot above the astronaut
     (the spot every event is built around). With the gyroscope on, the reference of the phone shifts instead, so you keep
     looking around from that new centre. */
  let focus = null, cineBack = false;
  const _fv = new THREE.Vector3(), _fd = new THREE.Vector3(), _fr = new THREE.Vector3(), _fu = new THREE.Vector3(), _fs = new THREE.Spherical();
  const YAXIS = V(0, 1, 0), wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  function viewScore(r, phi, theta, anchor){
    _fv.setFromSphericalCoords(r, phi, theta).add(controls.target);   // the camera there, looking at the astronaut
    _fd.copy(controls.target).sub(_fv).normalize(); _fr.crossVectors(_fd, YAXIS).normalize(); _fu.crossVectors(_fr, _fd);
    _fd.multiplyScalar(Math.cos(LIFT)).addScaledVector(_fu, Math.sin(LIFT));
    return _fd.dot(_fr.copy(anchor).sub(_fv).normalize());
  }
  function bestView(anchor, r, phi, theta){   // a short climb over the orbit
    let best = viewScore(r, phi, theta, anchor), step = 0.35;
    for (let it = 0; it < 60 && step > 0.002; it++){
      let moved = false;
      for (const [dp, dt] of [[step, 0], [-step, 0], [0, step], [0, -step]]){
        const p2 = THREE.MathUtils.clamp(phi + dp, 0.78, 2.15), sc = viewScore(r, p2, theta + dt, anchor);
        if (sc > best){ best = sc; phi = p2; theta += dt; moved = true; }
      }
      if (!moved) step *= 0.5;
    }
    return { phi, theta };
  }
  function focusOn(anchor){
    if (typeof stab !== 'undefined') stab = null;
    if (cineOn()){ cineBack = true; setCine(false); }
    _fs.setFromVector3(_fv.copy(camera.position).sub(controls.target));
    const r = _fs.radius;
    if (gyro.on && gyro.cal){
      // where the phone points now, on top of the reference; move the reference so that this pose shows the event
      _ge.setFromQuaternion(gyro.cur, 'YXZ');
      const nowPhi = THREE.MathUtils.clamp(gyro.cal.phi + _ge.x * GYRO_GAIN, 0.3, 2.85), nowTheta = gyro.cal.theta + _ge.y * GYRO_GAIN;
      const b = bestView(anchor, gyro.cal.r, nowPhi, nowTheta);
      focus = { t: 0, d: 1.3, gy: true, p0: gyro.cal.phi, t0: gyro.cal.theta, p1: gyro.cal.phi + (b.phi - nowPhi), t1: gyro.cal.theta + wrapA(b.theta - nowTheta) };
    } else {
      const b = bestView(anchor, r, _fs.phi, _fs.theta);
      focus = { t: 0, d: 1.3, gy: false, r, p0: _fs.phi, t0: _fs.theta, p1: b.phi, t1: _fs.theta + wrapA(b.theta - _fs.theta) };
    }
  }
  function stepFocus(raw){
    if (!focus) return;
    focus.t += raw; const k = easeIO(Math.min(1, focus.t / focus.d)), ph = lerp(focus.p0, focus.p1, k), th = lerp(focus.t0, focus.t1, k);
    if (focus.gy){ if (gyro.on && gyro.cal){ gyro.cal.phi = ph; gyro.cal.theta = th; } }
    else camera.position.copy(controls.target).add(_fv.setFromSphericalCoords(focus.r, ph, th));
    if (focus.t >= focus.d) focus = null;
  }
  function playPoint(p, idx){
    const i = idx != null ? idx : p.first ? 0 : nextIndex(p), def = p.defs[i];
    p.first = false;
    p.last = i;
    try { if (!def.inst) def.inst = def.make(p, def); def.inst.start(); }
    catch (err){ console.error(err); p.state = 'spent'; p.glint.visible = false; return; }
    p.cur = def; p.state = 'on'; p.time = 0; p.dwell = 0; p.glint.visible = false; found++;
    points.forEach((q) => { if (q !== p && q.state === 'spent') q.state = 'idle'; });   // activating a point brings the spent ones back
    toast(def);
    fireBurst(p); astroReact(def, p); focusOn(p.anchor);
  }
  // the heaviest event builds its little world in a quiet moment after the page loads, so it opens instantly
  const idle = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 300 }) : (f) => setTimeout(() => f({ timeRemaining: () => 8 }), 30);
  setTimeout(() => points.forEach((p) => p.defs.forEach((d) => {
    if (!d.prewarm || d.inst) return;
    try { d.inst = d.make(p, d); } catch (err){ console.error(err); return; }
    const go = (dl) => { try { while (!d.inst.step()){ if (dl.timeRemaining() < 3 || points.some((q) => q.state === 'on')){ idle(go); return; } } } catch (err){ console.error(err); } };   // a few milliseconds at a time, and never while an event is playing
    idle(go);
  })), 3500);
  // the aim recognises a light within 16.5° of its centre, and starts to colour from 26°
  const GAZE = Math.cos(D2R(16.5)), NEAR = Math.cos(D2R(26)), DWELL = 0.55;
  let found = 0;
  const cineOn = () => { try { return cine; } catch (err){ return false; } };   // declared further down, with the UI
  /* tap a light to play it: a short tap (not a drag) close to where the light is on screen */
  const tapAt = { x: 0, y: 0, t: 0 };
  function lightAt(cx, cy){
    const r = renderer.domElement.getBoundingClientRect(); let best = null, bd = Math.max(34, r.width * 0.075);
    for (const p of points){
      if (p.state !== 'idle') continue;
      _mndc.copy(p.anchor).project(camera); if (_mndc.z > 1) continue;
      const d = Math.hypot(r.left + (_mndc.x * 0.5 + 0.5) * r.width - cx, r.top + (0.5 - _mndc.y * 0.5) * r.height - cy);
      if (d < bd){ bd = d; best = p; }
    }
    return best;
  }
  points.forEach((p) => {
    p.orb.addEventListener('click', (e) => { e.preventDefault(); if (p.state === 'idle' && !points.some((q) => q.state === 'on')) playPoint(p); });
  });
  renderer.domElement.addEventListener('pointerdown', (e) => { tapAt.x = e.clientX; tapAt.y = e.clientY; tapAt.t = performance.now(); });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (performance.now() - tapAt.t > 450 || Math.hypot(e.clientX - tapAt.x, e.clientY - tapAt.y) > 12) return;
    const p = lightAt(e.clientX, e.clientY); if (!p || points.some((q) => q.state === 'on')) return;
    playPoint(p);
  });
  /* the guide: a small label that points at a light until people have found a few */
  const hintEl = document.getElementById('light-hint'), quizEl = document.getElementById('quiz');
  const hint = { t: -2.2, n: 0, p: null, on: false, tilt: false, key: '' };
  const AIM = document.getElementById('aim'), aim = { on: false, y: 0.29, px: 0, py: 0, ang: 0 };
  function showHint(v){ if (!hintEl || hint.on === v) return; hint.on = v; hintEl.classList.toggle('show', v); }
  function updateHint(raw){
    if (!hintEl) return;
    const busy = points.some((p) => p.state === 'on') || (quizEl && !quizEl.hidden) || document.body.classList.contains('is-clean');   // same rules as the orbs
    if (gyro.on !== hint.tilt){ hint.tilt = gyro.on; hint.p = null; if (gyro.on){ hint.n = 0; hint.t = Math.max(hint.t, 0.4); } }   // the gyroscope just woke up: teach the tilt
    if (busy || hint.n >= 6 || found >= 4 || !points.some((p) => p.state === 'idle')){ showHint(false); if (busy) hint.t = Math.min(hint.t, -1.6); hint.p = null; return; }
    hint.t += raw;
    if (hint.t < 0){ showHint(false); return; }
    // a light in view gets the label; with none in view, the label sits on the aim and points you along the arrow
    hint.p = null; let bd = 9;
    for (const p of points){ if (p.state !== 'idle') continue; _mndc.copy(p.anchor).project(camera); if (_mndc.z > 1 || Math.abs(_mndc.x) > 0.85 || Math.abs(_mndc.y) > 0.85) continue; const d = Math.hypot(_mndc.x, _mndc.y - aim.y); if (d < bd){ bd = d; hint.p = p; } }
    const waiting = !gyro.on && !controls.enableRotate;   // a phone that has not been tapped yet
    const other = found ? 'otra ' : 'la ';
    const text = hint.p
      ? (gyro.on ? 'inclina tu celular hacia ' + other + 'luz' : touchUI ? 'toca ' + other + 'luz' : 'haz clic en ' + other + 'luz')
      : (gyro.on ? 'sigue la flecha con tu celular' : waiting ? 'toca la pantalla y sigue la flecha' : 'arrastra siguiendo la flecha');
    if (text !== hint.key){ hint.key = text; hintEl.firstChild.textContent = text; }
    hintEl.classList.toggle('on-aim', !hint.p); hintEl.classList.toggle('below', !hint.p && Math.sin(aim.ang) < -0.3);   // on the aim, the label keeps clear of the arrow
    if (hint.p){ _mndc.copy(hint.p.anchor).project(camera); const r = renderer.domElement.getBoundingClientRect(); hintEl.style.left = ((_mndc.x * 0.5 + 0.5) * r.width).toFixed(1) + 'px'; hintEl.style.top = ((0.5 - _mndc.y * 0.5) * r.height).toFixed(1) + 'px'; }
    else { hintEl.style.left = aim.px.toFixed(1) + 'px'; hintEl.style.top = aim.py.toFixed(1) + 'px'; }
    showHint(true);
    if (hint.t > 7){ showHint(false); hint.n++; hint.t = -8; }   // shows for a few seconds, then again a little later
  }
  function updateMoments(raw, t){
    recordPose(performance.now() / 1000);
    momentFx.ca = 0; momentFx.lensK = 0; momentFx.freeze = 0; momentFx.tintA = 0; momentFx.dim = 0; momentFx.ripA = 0;
    momentFx.astro.set(0, 0, 0); momentFx.astroSpin = 0; momentFx.lookOn = false; momentFx.music = 0; momentFx.beat = 0; momentFx.flowMul = 1;
    momentFx.crack = 0; momentFx.shatter = 0;
    for (const r of residents){ try { r(raw, t); } catch (err){ console.error(err); } }
    camera.updateMatrixWorld(); camera.getWorldDirection(_mf);
    _mv.set(0, 1, 0).applyQuaternion(camera.quaternion); _mf.multiplyScalar(Math.cos(LIFT)).addScaledVector(_mv, Math.sin(LIFT)).normalize();   // the sweet spot, just above the astronaut
    const playing = points.some((p) => p.state === 'on'), quiet = playing || (quizEl && !quizEl.hidden) || document.body.classList.contains('is-clean');
    const cr = renderer.domElement.getBoundingClientRect();
    for (const p of points){
      let show = false;
      if (p.state === 'idle' && !quiet){
        _mndc.copy(p.anchor).project(camera);
        if (_mndc.z < 1 && Math.abs(_mndc.x) < 1.05 && Math.abs(_mndc.y) < 1.05){ show = true; p.orb.style.transform = 'translate(' + ((_mndc.x * 0.5 + 0.5) * cr.width).toFixed(1) + 'px,' + ((0.5 - _mndc.y * 0.5) * cr.height).toFixed(1) + 'px)'; }
      }
      if (show !== p.orbOn){ p.orbOn = show; p.orb.classList.toggle('on', show); p.orb.tabIndex = show ? 0 : -1; }
    }
    let aimP = null, aimS = -2;   // with such a wide aim two lights can be in reach: only the one nearest the centre counts
    for (const p of points){ if (p.state !== 'idle') continue; const sd = _mto.copy(p.anchor).sub(camera.position).normalize().dot(_mf); if (sd > aimS){ aimS = sd; aimP = p; } }
    for (const p of points){
      if (p.state === 'on'){
        p.ring.visible = false;
        p.time += raw;
        try { p.cur.inst.update(p.time, raw, t); const fx = ENVFX[p.cur.name]; if (fx) fx(p.time, raw, t, p); } catch (err){ console.error(err); p.time = p.cur.dur; }
        if (p.time >= p.cur.dur){ try { p.cur.inst.end(); } catch (err){ console.error(err); } p.state = 'spent'; if (cineBack){ cineBack = false; setCine(true); } }
        continue;
      }
      if (p.state === 'spent'){ p.glint.visible = p.ring.visible = false; continue; }
      const s = _mto.copy(p.anchor).sub(camera.position).normalize().dot(_mf), near = smooth(NEAR, GAZE, s);
      p.dwell = p === aimP && s > GAZE && !cineOn() && !playing ? p.dwell + raw : Math.max(0, p.dwell - raw * 2);   // the slow cinematic drift never fires a light by itself, nor does anything while an event plays
      if (p.dwell >= DWELL){ playPoint(p); continue; }
      const g = p.glint, pulse = 0.5 + 0.5 * Math.sin(t * 2.6 + p.ph), pi = points.indexOf(p);
      const wave = Math.exp(-Math.pow(((t % 7) - 1 - pi * 0.22) / 0.16, 2));   // every few seconds a flare runs from light to light
      const call = hint.on && hint.p === p ? 0.5 + 0.5 * Math.sin(t * 6) : 0;
      g.visible = true; p.orb.style.setProperty('--k', (p.dwell / DWELL).toFixed(2)); p.orb.classList.toggle('flare', wave > 0.5 || call > 0.6);
      g.material.opacity = Math.min(1, 0.32 + 0.22 * pulse + 0.5 * near + 0.5 * wave);
      g.scale.setScalar(p.glint0 * (0.42 + 0.1 * pulse + 0.5 * near + 0.45 * wave + 0.2 * call + 1.0 * p.dwell / DWELL));
      p.ring.visible = true; p.ring.material.opacity = Math.min(1, 0.16 + 0.12 * pulse + 0.4 * near + 0.35 * wave + 0.3 * call); p.ring.material.rotation += raw * 0.6;
      p.ring.scale.setScalar(p.glint0 * (1.25 + 0.15 * Math.sin(t * 1.7 + p.ph) + 0.5 * wave + 0.6 * near - 0.8 * p.dwell / DWELL));   // the ring closes in while you hold the gaze
    }
    _mndc.copy(camera.position).add(_mf).project(camera); aim.y = _mndc.y;
    const ax = (_mndc.x * 0.5 + 0.5) * cr.width, ay = (0.5 - _mndc.y * 0.5) * cr.height; aim.px = ax; aim.py = ay;
    if (AIM){
      const show = !quiet && points.some((p) => p.state === 'idle');
      if (show !== aim.on){ aim.on = show; AIM.classList.toggle('on', show); }
      if (show){
        AIM.style.transform = 'translate(' + ax.toFixed(1) + 'px,' + ay.toFixed(1) + 'px)';
        let best = null, bs = -2, bk = 0;
        for (const p of points){ if (p.state !== 'idle') continue; const sd = _mto.copy(p.anchor).sub(camera.position).normalize().dot(_mf); if (sd > bs){ bs = sd; best = p; } bk = Math.max(bk, p.dwell / DWELL); }
        AIM.style.setProperty('--k', Math.min(1, bk).toFixed(3));
        if (best){
          AIM.style.setProperty('--c', best.orb.style.getPropertyValue('--c'));
          _mndc.copy(best.anchor).project(camera);
          let dx = (_mndc.x * 0.5 + 0.5) * cr.width - ax, dy = (0.5 - _mndc.y * 0.5) * cr.height - ay; if (_mndc.z > 1){ dx = -dx; dy = -dy; }
          aim.ang = Math.atan2(dy, dx); AIM.style.setProperty('--a', aim.ang.toFixed(3) + 'rad');
          AIM.classList.toggle('near', bs > NEAR); AIM.classList.toggle('far', bs <= NEAR);
        } else AIM.classList.remove('near', 'far');
      }
    }
    updateHint(raw);
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
    gasp: ({ d, t }) => pose(20, [-0.28, twistTo(d, 0.3), 0], armsSym([0.75, 0.15, 0.55], [0.45, 0.75, 0.45], 0.05, -0.35), legsSym([0.2, -0.85, 0.35 + 0.05 * Math.sin(t * 2)], [0.12, -0.95, -0.25], 0.4)),   // frozen in amazement, open hands
    dance: ({ t }) => {   // pumps a fist on every beat, swaps arms each beat, bounces
      const b = momentFx.beat, sd = (momentFx.beatN % 2) ? 1 : -1;
      return pose(30, [-0.1 + 0.15 * b, 0.3 * sd, 0.1 * sd], pair(sd, ARM(sd, [0.35, 0.6 + 0.35 * b, 0.25], [0.2, 0.9 + 0.1 * b, 0.1], 0.9, 0), ARM(-sd, [0.5, -0.2, 0.6], [-0.3, 0.6, 0.7], 0.6, 0.1)), legsSym([0.15, -0.9, 0.25 + 0.3 * b], [0.1, -0.95, -0.2 - 0.2 * b], 0.5));
    },
    conduct: ({ t }) => pose(14, [-0.12, 0.25 * Math.sin(t * 1.2), 0], { 1: ARM(1, [0.6 + 0.25 * Math.sin(t * 2.4), 0.4 + 0.35 * Math.sin(t * 2.4 + 1), 0.5], [0.3, 0.8, 0.4], 0.35, 0), '-1': ARM(-1, [0.6 + 0.25 * Math.sin(t * 2.4 + 2), 0.4 + 0.35 * Math.sin(t * 2.4 + 3), 0.5], [0.3, 0.8, 0.4], 0.35, 0) }, legsRelaxed(t)),   // conducting the choir
    recoil: () => pose(26, [-0.32, 0, 0], armsSym([0.8, 0.2, -0.55], [0.4, 0.6, -0.7], 0.05, -0.45), legsSym([0.15, -0.5, 0.85], [0.1, -0.95, -0.3], 0.2)),
    star: () => pose(8, [-0.22, 0, 0], armsSym([0.95, 0.3, 0.05], [0.7, 0.7, 0.1], 0.05, -0.25), legsSym([0.5, -0.85, 0], [0.45, -0.9, 0], 0.65)),
    wave: ({ s, d, t, o }) => pose(14, [0, twistTo(d, 0.4), 0], pair(s, ARM(s, [0.7, 0.7, 0.15], [0.3 + 0.45 * Math.sin(t * (o.speed || 8)), 1, 0.15], 0.05, 0), relaxedArm(-s)), legsRelaxed(t)),
    salute: ({ s, d }) => pose(20, [0, twistTo(d, 0.5), 0], pair(s, ARM(s, [0.75, 0.35, 0.55], [-0.6, 0.65, 0.45], 0, -0.2), ARM(-s, [0.15, -1, 0], [0.12, -1, 0.05], 0.5, 0)), legsSym([0.04, -1, 0], [0.03, -1, 0], 0.85)),
    tap: ({ s, t }) => pose(24, [0.08, 0, 0], pair(s, ARM(s, [0.4, 0.2, 0.9], [-0.3, 0.8 + 0.25 * Math.sin(t * 11), 0.5], 0.6, 0.1), ARM(-s, [0.5, -0.3, 0.5], [-0.2, 0.3, 0.9], 0.5, 0.2)), legsRelaxed(t)),   // knocks on the visor
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
    'Eco temporal': [AWE, [[0.6, 'gasp'], [2.6, 'wave', { speed: 3 }], [4.0, 'reach'], [6.4, 'gasp', { tremble: 0.6 }], [9.2, 'recoil'], [10.4, 'look']]],
    'Reloj derretido': [AWE, [[0.8, 'point'], [3, 'helmet']]],
    'Déjà vu': [FEAR, [[0.3, 'look'], [2.4, 'point'], [4.8, 'helmet', { tremble: 0.3 }]]],
    'Tiempo congelado': [AWE, [[0.2, 'look']]],
    'Reloj de arena': [AWE, [[0.8, 'catch']]],
    'Nave del futuro': [AWE, [[1, 'salute']]],
    'Ventana al pasado': [AWE, [[0.9, 'reachBoth']]],
    'Bucle de luz': [FEAR, [[0.3, 'trace'], [4.4, 'recoil']]],
    'Gato de Schrödinger': [AWE, [[0.5, 'beckon'], [3.2, 'clap']]],
    'Premonición': [AWE, [[0.8, 'tap'], [3.2, 'float'], [6, 'wave', { speed: 3 }]]],
    'El ojo del abismo': [FEAR, [[0.6, 'gasp', { tremble: 0.5 }], [4.6, 'recoil'], [5.4, 'gasp', { tremble: 0.8 }], [8.4, 'look']]],
    'Ballena de plasma': [AWE, [[0.8, 'gasp'], [2.6, 'star'], [6.5, 'wave', { speed: 2 }]]],
    'Medusas estelares': [AWE, [[0.8, 'float']]],
    'Cardumen de cristal': [AWE, [[0.6, 'reach']]],
    'Mariposa cuántica': [AWE, [[0.6, 'beckon'], [3, 'catch'], [6, 'clap']]],
    'Gusano cósmico': [FEAR, [[0.5, 'recoil'], [1.5, 'flee']]],
    'Dragón de nebulosa': [FEAR, [[0.6, 'point'], [4.4, 'gasp', { tremble: 0.6 }], [6.5, 'recoil']]],
    'Mano gigante': [AWE, [[0.5, 'gasp', { tremble: 0.4 }], [4.5, 'float'], [7.5, 'reachBoth'], [11, 'wave', { speed: 3 }]]],
    'Flor estelar': [AWE, [[0.8, 'reachBoth'], [4, 'helmet']]],
    'Semilla alienígena': [AWE, [[0.8, 'catch'], [3.5, 'stretchUp']]],
    'Visitantes curiosos': [FEAR, [[0.5, 'point'], [1.9, 'star', { tremble: 0.5 }], [6.4, 'wave', { speed: 10 }]]],
    'Pulpo mecánico': [FEAR, [[0.5, 'gasp', { tremble: 0.4 }], [3, 'flee']]],
    'Nave nodriza': [FEAR, [[0.8, 'stretchUp'], [4.6, 'gasp', { tremble: 0.6 }], [8.8, 'look']]],
    'Holograma': [AWE, [[0.6, 'wave', { speed: 8 }]]],
    'Firma alienígena': [AWE, [[0.5, 'trace']]],
    'Faro alienígena': [AWE, [[0.5, 'point'], [3.8, 'wave', { speed: 6 }]]],
    'Ascensor cósmico': [AWE, [[0.6, 'wave', { speed: 4 }], [4, 'beckon']]],
    'Ciudad flotante': [AWE, [[1, 'helmet'], [4, 'reachBoth']]],
    'Astronauta perdido': [AWE, [[0.6, 'wave', { speed: 12 }], [4.5, 'reach']]],
    'Satélite antiguo': [AWE, [[0.6, 'tap'], [3, 'point']]],
    'Micro agujero negro': [FEAR, [[0.5, 'recoil'], [1.6, 'flee']]],
    'Teseracto': [AWE, [[0.8, 'helmet'], [3.5, 'trace']]],
    'Fractura del espacio': [FEAR, [[0.2, 'recoil'], [1.2, 'gasp', { tremble: 0.5 }], [5.5, 'look']]],
    'Lago de mercurio': [AWE, [[0.6, 'reach'], [4.2, 'tap'], [8, 'reachBoth']]],
    'Ojo de la tormenta': [AWE, [[0.5, 'look'], [3, 'star']]],
    'Escalera de Penrose': [AWE, [[0.6, 'look'], [3, 'helmet', { tremble: 0.2 }]]],
    'Planeta bebé': [AWE, [[0.5, 'catch'], [6.8, 'wave', { speed: 5 }]]],
    'Cometa': [AWE, [[0.3, 'point'], [2.5, 'star']]],
    'Lluvia de meteoros': [AWE, [[0.2, 'look'], [2.5, 'point']]],
    'Lluvia hacia arriba': [AWE, [[0.6, 'stretchUp'], [3.5, 'float'], [7.5, 'star']]],
    'Grieta a la Tierra': [AWE, [[1, 'reachBoth', { tremble: 0.15 }], [3.6, 'gasp'], [6.4, 'point'], [10.4, 'star'], [14.6, 'float']]],
    'Mensaje en las estrellas': [AWE, [[1, 'wave', { speed: 7 }], [4, 'clap']]],
    'Coro de orbes': [AWE, [[0.6, 'gasp'], [1.6, 'conduct'], [11.5, 'star']]],
    'Huellas en la nada': [FEAR, [[0.6, 'look'], [3, 'point']]],
    'Duplicado de la nave': [AWE, [[0.8, 'point'], [3, 'helmet'], [6.5, 'shake']]],
    'Señal de radio': [AWE, [[0.6, 'tap'], [3, 'dance']]],
    'Laberinto de luz': [AWE, [[0.6, 'point'], [3.6, 'trace'], [9.6, 'clap']]],
    'Concierto de púlsares': [AWE, [[0.6, 'gasp'], [1.8, 'dance']]],
    'Estás aquí': [AWE, [[0.8, 'reach'], [3.5, 'salute']]],
    'Salida del agujero': [AWE, [[0.6, 'recoil'], [1.6, 'star'], [5, 'reachBoth']]]
  };
  /* ===== what each event does to the world or to the astronaut (on top of what it shows) =====
     Every event has at least one: it touches the astronaut, changes the environment (colour, light,
     the flow of time and of the fall), moves through the whole space, or is a musical show. */
  const pushFrom = (pos, k) => momentFx.astro.addScaledVector(_rv.copy(astro.position).sub(pos).normalize(), k);
  const pullTo = (pos, k) => momentFx.astro.addScaledVector(_rv.copy(pos).sub(astro.position).normalize(), k);
  const tintTo = (r, g, b, a) => { momentFx.tint.setRGB(r, g, b); momentFx.tintA = Math.max(momentFx.tintA, a); };
  const ENVFX = {
    // time: the fall slows, stops or runs backwards
    'Eco temporal': (lt) => { momentFx.flowMul *= 1 - 1.8 * smooth(6.2, 6.9, lt) * (1 - smooth(9.2, 9.8, lt)); },   // the fall runs backwards while the paradox lasts
    'Reloj derretido': (lt) => { const m = smooth(2, 7, lt) * (1 - smooth(7.2, 8, lt)); momentFx.flowMul *= 1 - 1.8 * m; tintTo(1.0, 0.75, 0.4, 0.25 * m); },
    'Déjà vu': (lt) => { const loopK = (lt % 2.4) / 2.4; momentFx.flowMul *= loopK < 0.12 ? -3 : 1; momentFx.ca += loopK < 0.12 ? 0.03 : 0; },   // each pass rewinds the world for an instant
    'Reloj de arena': (lt) => { const k = env(lt, 8.5, 1.5, 1.5); momentFx.flowMul *= 1 - 1.7 * k; tintTo(1.0, 0.8, 0.45, 0.25 * k); },
    'Nave del futuro': (lt) => { const k = env(lt, 9, 1.5, 1.5); tintTo(0.95, 0.75, 0.5, 0.35 * k); momentFx.dim += 0.2 * k; momentFx.freeze = Math.max(momentFx.freeze, 0.3 * k); },   // everything ages to sepia
    'Ventana al pasado': (lt) => { const k = env(lt, 9, 1, 1.5); tintTo(1.0, 0.6, 0.3, 0.3 * k); momentFx.flowMul *= 1 - 0.7 * k; },
    'Bucle de luz': (lt) => { const h = smooth(4.5, 4.7, lt) * (1 - smooth(4.8, 6.0, lt)); momentFx.astroSpin += 4 * h; momentFx.astro.y += 0.6 * h; },   // the light hits you and sets you spinning
    'Gato de Schrödinger': (lt, raw, t) => { const sp = 1 - smooth(2.8, 3.1, lt); if (sp > 0) tintTo(Math.sin(t * 40) > 0 ? 0.4 : 1.0, 0.6, 1.0, 0.25 * sp * smooth(0.5, 1, lt)); momentFx.freeze = Math.max(momentFx.freeze, 0.8 * smooth(2.9, 3.0, lt) * (1 - smooth(3.0, 3.6, lt))); },
    'Tiempo congelado': (lt) => { momentFx.flowMul *= 1 - env(lt, 6, 0.35, 1.2); },
    // creatures
    'Mariposa cuántica': (lt, raw, t) => { const e = env(lt, 9, 1, 1.2), flap = Math.floor(t * 9 / (Math.PI * 2)); momentFx.tint.setHSL((flap * 0.17) % 1, 1, 0.55); momentFx.tintA = Math.max(momentFx.tintA, 0.62 * e); momentFx.dim -= 0.15 * e * (0.5 + 0.5 * Math.sin(t * 9)); },   // every wingbeat repaints the whole tunnel
    'Gusano cósmico': (lt, raw, t, p) => { const k = env(lt, 9, 1, 1); momentFx.ca += 0.01 * k; momentFx.astro.addScaledVector(p.up, 0.6 * Math.sin(t * 1.3) * k); momentFx.astroSpin += 0.4 * Math.sin(t * 0.9) * k; },   // the gas it stirs rocks the astronaut
    'Dragón de nebulosa': (lt, raw, t, p) => { const roar = smooth(4.5, 4.7, lt) * (1 - smooth(4.7, 6.2, lt)); pushFrom(p.anchor, 2.2 * roar); momentFx.astroSpin += 2 * roar; tintTo(0.8, 0.3, 1.0, 0.3 * env(lt, 10, 1.2, 1.5)); momentFx.dim -= 0.4 * roar; },
    'Flor estelar': (lt) => { const k = env(lt, 9, 1, 1.5); tintTo(1.0, 0.55, 0.85, 0.35 * k); momentFx.flowMul *= 1 - 0.75 * k; },   // the world slows to watch it bloom
    'Semilla alienígena': (lt) => { const k = smooth(1, 5, lt) * (1 - smooth(8, 9.5, lt)); tintTo(0.5, 1.0, 0.6, 0.35 * k); momentFx.dim -= 0.15 * k; },
    // visitors
    'Pulpo mecánico': (lt, raw, t) => { const k = easeIO(smooth(0.5, 3.5, lt)) * (1 - easeIO(smooth(6.0, 8.5, lt))); lampLens.emissiveIntensity = 1.5 + 2 * k * (Math.sin(t * 20) > 0 ? 1 : -0.6); momentFx.astroSpin += 0.5 * k; },
    'Holograma': (lt, raw, t) => { tintTo(0.4, 1.0, 1.0, 0.25 * env(lt, 9, 0.6, 1) * (Math.sin(t * 43) > -0.85 ? 1 : 0.3)); },
    'Firma alienígena': (lt) => { tintTo(1.0, 0.4, 0.9, 0.3 * env(lt, 8.5, 1, 1.5)); momentFx.dim += 0.25 * env(lt, 8.5, 1, 1.5); },
    'Faro alienígena': (lt) => { const e = env(lt, 8.5, 0.6, 1); const on = [1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0][Math.floor(lt * (lt > 3.8 ? 9 : 4)) % 18]; momentFx.dim += (0.45 - 0.6 * on) * e; },   // the whole tunnel blinks with its code
    'Ascensor cósmico': (lt, raw, t, p) => { const go = smooth(6.4, 7.2, lt) * (1 - smooth(8.5, 9.6, lt)); momentFx.flowMul *= 1 + 2.5 * go; momentFx.astro.addScaledVector(p.up, 1.0 * go); },   // its launch drags you along
    'Ciudad flotante': (lt) => { const k = env(lt, 10, 1.5, 1.5); momentFx.dim += 0.35 * k; tintTo(1.0, 0.8, 0.55, 0.2 * k); },
    'Astronauta perdido': (lt, raw, t, p) => { pullTo(p.anchor, 0.9 * smooth(1, 3, lt) * (1 - smooth(4.5, 7, lt))); },   // you drift toward the other astronaut, then it fades away
    'Satélite antiguo': (lt, raw, t) => { const ph = (lt % 0.9) / 0.9; lampLens.emissiveIntensity = 1.5 + (ph < 0.12 ? 3 : 0); },   // your helmet lamps answer its beeps
    'Visitantes curiosos': () => {},
    // physics
    'Teseracto': (lt, raw, t) => { const k = env(lt, 9, 0.8, 1); momentFx.ca += 0.02 * k; if ((lt % 1.3) < raw * 1.5){ momentFx.ripA = Math.max(momentFx.ripA, 0.8 * k); momentFx.ripX = 0.5; momentFx.ripY = 0.55; momentFx.ripR = 0; } },   // space folds in waves
    'Lago de mercurio': (lt) => { momentFx.dim -= 0.2 * smooth(3, 4.4, lt) * (1 - smooth(7.6, 9, lt)); },
    'Ojo de la tormenta': (lt) => { const k = env(lt, 9, 1, 1.2); momentFx.astroSpin -= 2.2 * k; momentFx.flowMul *= 1 - 1.6 * k; tintTo(0.5, 0.9, 1.0, 0.2 * k); },   // the whirlpool spins you, against the tunnel
    'Escalera de Penrose': (lt, raw, t) => { const k = env(lt, 9.5, 0.8, 1); momentFx.flowMul *= 1 - 2 * k * (Math.sin(t * 1.4) > 0 ? 1 : 0); },   // up and down at the same time
    'Planeta bebé': (lt, raw, t, p) => { const k = smooth(2.8, 4.6, lt) * (1 - smooth(6.8, 8.5, lt)); pullTo(p.anchor, 0.8 * k); tintTo(1.0, 0.6, 0.35, 0.2 * k); },   // its young gravity tugs at you
    'Cometa': (lt, raw, t, p) => { const k = Math.exp(-Math.pow((lt - 3.2) / 0.9, 2)); pushFrom(p.anchor, 0.9 * k); tintTo(0.5, 0.8, 1.0, 0.3 * k); momentFx.astroSpin += 1.2 * k; },
    'Lluvia de meteoros': (lt, raw, t) => { const k = env(lt, 7.5, 0.4, 0.8); momentFx.astro.x += 0.25 * Math.sin(t * 6.1) * k; momentFx.astro.y += 0.2 * Math.sin(t * 4.3) * k; momentFx.ca += 0.008 * k; },
    // signals
    'Mensaje en las estrellas': (lt) => { momentFx.dim += 0.4 * env(lt, 9, 0.8, 1); },
    'Huellas en la nada': (lt, raw, t, p) => { momentFx.dim += 0.3 * env(lt, 9, 1, 1); momentFx.astro.addScaledVector(p.right, 0.3 * Math.sin(lt * 4.4)); },
    'Duplicado de la nave': (lt, raw, t) => { if (lt > 6.5) momentFx.flowMul *= Math.sin(t * 47) > 0 ? -1 : 2; },
    'Señal de radio': (lt) => { const e = env(lt, 9, 0.6, 1), b = Math.pow(Math.max(0, Math.sin(lt * 6)), 6); momentFx.music = Math.max(momentFx.music, e); momentFx.beat = Math.max(momentFx.beat, b * e); momentFx.beatN = Math.floor(lt * 6 / Math.PI); momentFx.ca += 0.01 * b * e; },
    'Laberinto de luz': (lt) => { momentFx.dim += 0.65 * env(lt, 12.5, 1.2, 1.5); },   // the lights go out so the maze glows alone
    'Estás aquí': (lt) => { momentFx.dim += 0.35 * env(lt, 12, 1, 1.2); },
    'Salida del agujero': (lt, raw, t, p) => { pullTo(p.anchor, 1.2 * smooth(1, 2.5, lt) * (1 - smooth(6, 8, lt))); },   // the other side draws you in
    'Grieta a la Tierra': (lt) => { const k = smooth(2.6, 6, lt) * (1 - smooth(14.6, 16.4, lt)); tintTo(1.0, 0.82, 0.6, 0.16 * k); }   // the sunset over the city warms the tunnel
  };
  function astroReact(def, p){
    const R = REACT[def.name]; if (!R) return;
    anim.react = null;
    anim.moment = { mood: R[0], steps: R[1], t0: anim.mt, dur: def.dur, target: p.anchor, tgt: p.anchor, cur: null };
  }
  // called from animate(): the pose for the current reaction, or null
  momentPose = function(){
    const M = anim.moment; if (!M) return null;
    const lt = anim.mt - M.t0;
    if (lt > M.dur){ anim.moment = null; return null; }
    let st = null; for (const s of M.steps) if (lt >= s[0]) st = s;
    M.tgt = momentFx.lookOn ? momentFx.look : M.target;
    M.cur = st ? st[1] : null;
    if (!st) return null;
    chest.worldToLocal(_g.copy(M.tgt)); const sd = _g.x >= 0 ? 1 : -1; _g.sub(shoulderOf(sd)).normalize();
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
    if (ripple.p && ripple.t < 1.5){
      ripple.t += raw;
      _mndc.copy(ripple.p.anchor).project(camera);
      if (_mndc.z < 1 && 1 - ripple.t / 1.5 > momentFx.ripA){ momentFx.ripX = _mndc.x * 0.5 + 0.5; momentFx.ripY = _mndc.y * 0.5 + 0.5; momentFx.ripR = ripple.t / 1.5 * 0.9; momentFx.ripA = 1 - ripple.t / 1.5; }
    }
    for (const p of points){
      const a = p.state === 'on' ? env(p.time, p.cur.dur, 1.0, 1.5) : 0;
      p.aura.visible = a > 0.001;
      if (p.aura.visible){ p.aura.material.opacity = 0.28 * a; p.aura.material.rotation += raw * 0.05; p.aura.scale.setScalar(10 + 1.5 * Math.sin(t * 0.7)); }
    }
  }
  if (/debug/.test(location.hash)) window.__momentos = {
    play: (pi, si) => playPoint(points[pi], si),
    look(pi){ setCine(false); camera.position.copy(MT).addScaledVector(points[pi].out, -4.15); camera.lookAt(MT); },
    points, momentFx, camera, astro, residents, renderer, gyro, setGyro: (v) => setGyro(v), step(n, dt){ for (let i = 0; i < (n || 1); i++) stepFrame(dt || 1 / 30); }, get fp(){ return typeof finalPass !== "undefined" ? finalPass : null; }
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
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2(0.001, 0.001) }, uExposure: { value: 0.95 }, uCA: { value: 0.004 }, uSpeed: { value: 1 }, uSharp: { value: 0.22 }, uLensPos: { value: new THREE.Vector2(0.5, 0.5) }, uLensR: { value: 0 }, uLensK: { value: 0 }, uFreeze: { value: 0 }, uRip: { value: new THREE.Vector3(0.5, 0.5, 0) }, uRipA: { value: 0 }, uShard: { value: null }, uCrack: { value: 0 }, uShatter: { value: 0 }, uCrackC: { value: new THREE.Vector2(0.5, 0.5) }, uTintA: { value: 0 }, uTintC: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uTime, uExposure, uCA, uSpeed, uSharp, uLensR, uLensK, uFreeze, uTintA; uniform vec2 uRes, uTexel, uLensPos; uniform vec3 uTintC, uRip; uniform float uRipA, uCrack, uShatter; uniform sampler2D uShard; uniform vec2 uCrackC;
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
          float crackLine = 0.0, gap = 0.0, shardTone = 1.0;
          if (uCrack > 0.0){   // glass: cracks spread from the impact, then the shards drift apart (and come back)
            vec4 sd = texture2D(uShard, vUv);
            float reach = length((vUv - uCrackC) * vec2(uRes.x / uRes.y, 1.0));
            float grown = 1.0 - smoothstep(uCrack * 1.7 - 0.06, uCrack * 1.7, reach);
            crackLine = sd.a * grown;
            vec2 dir = (sd.rg - 0.5) * 2.0;
            uv = clamp(uv + dir * uShatter * (0.03 + 0.1 * sd.b) + (vUv - uCrackC) * uShatter * 0.12 * sd.b, 0.0, 1.0);
            gap = smoothstep(0.2, 1.0, sd.a) * uShatter;
            shardTone = 1.0 + (sd.b - 0.5) * 0.5 * (uShatter + 0.3 * grown);
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
          if (uCrack > 0.0){ col *= shardTone; col = mix(col, vec3(0.06, 0.02, 0.14), gap * 0.85); col += vec3(0.85, 0.95, 1.0) * crackLine * (0.75 - 0.45 * uShatter); }
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
  let stab = null; const _stP = new THREE.Vector3(), _stH = new THREE.Vector3();
  function stabilize(){
    focus = null;
    setCine(false);
    if (gyro.on){ goHome(); gyro.base = null; gyro.cal = null; gyro.cur.identity(); gyro.rel.identity(); return; }   // with the gyroscope, the current pose becomes the new centre
    stab = { t: 0, from: camera.position.clone() };
  }
  const btnStab = document.getElementById('btn-estabilizar');
  if (btnStab) btnStab.addEventListener('click', stabilize);
  function setGyro(v){ gyro.on = v; gyro.base = null; gyro.cal = null; gyro.cur.identity(); gyro.rel.identity(); if (v){ setCine(false); goHome(); } controls.enableRotate = !v; if (MUI.hint) MUI.hint.textContent = v ? 'mueve tu celular y sigue la flecha' : ('arrastra y sigue la flecha'); btnGyro.setAttribute('aria-pressed', String(v)); btnGyro.textContent = v ? 'Giroscopio activo' : 'Giroscopio'; }
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
      if (MUI.hint) MUI.hint.textContent = 'toca la pantalla y mueve tu celular';
      const once = () => {
        removeEventListener('touchend', once); removeEventListener('click', once);
        if (!gyro.on) askGyro(true).then(() => { if (!gyro.on){ controls.enableRotate = true; if (MUI.hint) MUI.hint.textContent = ('arrastra y sigue la flecha'); } });
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
    stepFrame();
  }
  function stepFrame(fixed){
    const real = fixed || clock.getDelta();
    const raw = Math.min(real, 0.1);
    const dt = paused ? 0 : raw;
    speed += (speedTarget - speed) * Math.min(1, raw * 3);
    const tm = t * (reduceMotion ? 0.5 : 1);
    animate(dt, tm);
    const fs = speed * anim.fx;   // fall speed, including the dive
    const wdt = dt * (1 - momentFx.freeze);   // world time: a frozen moment stops everything but the astronaut
    t += dt; wt += wdt; flow += wdt * FLOW * fs * momentFx.flowMul;
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
      m.position.z += wdt * FLOW * fs * d.k * momentFx.flowMul;
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
    stepFocus(raw);   // gliding to the best view of an event that has just started
    if (stab){   // gliding back to the home view
      stab.t += raw; const k = easeIO(Math.min(1, stab.t / 0.9));
      _stP.copy(controls.target).add(_stH.setFromSpherical(HOME)); camera.position.lerpVectors(stab.from, _stP, k);
      if (stab.t >= 0.9) stab = null;
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
      u.uCrack.value = u.uShard.value ? momentFx.crack : 0; u.uShatter.value = momentFx.shatter; u.uCrackC.value.set(momentFx.crackX, momentFx.crackY);
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