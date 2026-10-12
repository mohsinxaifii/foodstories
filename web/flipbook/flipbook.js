/*
 * Food Stories flipbook: a real 3D magazine (three.js / WebGL), seen from above.
 *
 * Paper physics: a turning page is folded around a cylinder whose axis is the fold line.
 * The fold line is always perpendicular to the direction the page is pulled, so the paper
 * follows the cursor: a corner peels into a tight curl, the curl widens into a tall arch over
 * the middle of the turn, and the page settles flat on the other side. The page stays attached
 * at the spine, so it can't be pulled further than real paper could go. Covers are paper too.
 *
 * Light and shadows are real: a key light casts shadow maps from turning pages onto the pages
 * beneath and onto the table, and pages dip into the spine so the gutter is shaded by its shape.
 *
 * Turns are never skipped: each press/swipe starts its own sheet, sheets already in the air keep
 * flying, and a press in the other direction reverses a sheet from wherever it is.
 */
(function () {
  'use strict';

  const data = window.FLIPBOOK;
  const N = data.pages.length;
  const S = Math.ceil(N / 2); // sheets: sheet i carries page 2i+1 on the front, 2i+2 on the back

  // ---------- tuning ----------
  const W = 1; // page width (world units)
  const H = 1; // page height (square pages)
  // Low-end devices (phones, few cores, little memory) start with a lighter setup; on every device
  // the rendering resolution then adapts to keep the frame rate up (see adaptResolution).
  const LOW_END = matchMedia('(pointer: coarse)').matches ||
    (navigator.deviceMemory || 8) <= 4 || (navigator.hardwareConcurrency || 8) <= 4;
  const SX = LOW_END ? 44 : 64; // mesh segments across the page
  const SY = LOW_END ? 26 : 40; // ... and down the page (diagonal folds need both)
  const GAP = 0.0016; // paper thickness
  const EPS = 0.00025; // separation of sheets at the spine
  const GUTTER = 0.12; // how far from the spine the page curves down into the binding
  const R_MAX = 0.28; // fold radius mid-turn (the page arches up into the air); it tightens toward both ends
  const ARC = 0.32; // button turns: how far the pulled corner rises on its way over
  const STAGGER = 0.2; // minimum gap between sheets in the air, so they never touch
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SPEED = (reduceMotion ? 3.5 : 1.7) * 2 * W; // corner speed (world units / s)
  const ACC = (reduceMotion ? 14 : 6.5) * 2 * W;
  const DRAG_SPEED = 8 * W; // fastest a dragged page can move (world units / s)
  // Coated magazine paper: a soft sheen that reflects the room. Lights are calibrated so a page
  // lying flat still shows the artwork's true colours.
  const PAPER_ROUGHNESS = 0.42;
  const SHEEN = 0.7;
  const AMBIENT = 0.34;
  const KEY = 0.44;
  const FOV = 30;
  const PORTRAIT_BELOW = 640; // px: one page at a time on narrow screens

  const $ = (id) => document.getElementById(id);
  const host = $('scene');
  const loader = $('loader');
  const counter = $('counter');
  document.title = data.title;

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const smooth = (x) => x * x * (3 - 2 * x);

  // ---------- renderer ----------

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: !LOW_END, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    host.classList.add('no-webgl');
    loader.innerHTML = 'This browser can’t show the 3D magazine. <a href="pages-hd/page-01.jpg">Open the pages</a>';
    return;
  }
  const PR_MAX = Math.min(window.devicePixelRatio || 1, 2);
  const PR_MIN = Math.min(PR_MAX, 0.75);
  let pixelRatio = LOW_END ? Math.min(PR_MAX, 1.5) : PR_MAX;
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // filtered (radius) for soft edges
  renderer.shadowMap.autoUpdate = false; // only redrawn when something casting a shadow moved
  const canvas = renderer.domElement;
  host.appendChild(canvas);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);

  // Lights are balanced so a page lying flat shows its true colours (ambient + key = 1),
  // paper turned toward the lamp gets brighter and paper in shadow drops to the ambient level.
  const KEY_POS = new THREE.Vector3(-2.0, 1.3, 3.4); // a lamp above the table, up and to the left
  const flatFacing = KEY_POS.clone().normalize().z;
  scene.add(new THREE.AmbientLight(0xfffaf3, AMBIENT * Math.PI));
  const key = new THREE.DirectionalLight(0xfff4e6, (KEY * Math.PI) / flatFacing);
  scene.environment = studioEnvironment();

  // A soft studio for the coated paper to reflect: a dim warm room with a bright softbox up and to
  // the left. A page lying flat reflects the area around the softbox, so it shows a gentle glare;
  // a page curling over reflects other parts of the room, so highlights sweep across the bend.
  function studioEnvironment() {
    const w = 256;
    const h = 128;
    const px = new Uint16Array(w * h * 4);
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const v = 1 - (y + 0.5) / h; // 1 = straight up
        const room = 0.05 + 0.1 * v; // brighter overhead, darker toward the floor
        const du = (u - 0.8) / 0.05;
        const dv = (v - 0.63) / 0.07;
        const box = 3 * Math.exp(-(du * du + dv * dv)); // softbox (HDR, so it shows through the coating)
        const i = (y * w + x) * 4;
        px[i] = toHalf(room * 1.05 + box);
        px[i + 1] = toHalf(room + box * 0.97);
        px[i + 2] = toHalf(room * 0.9 + box * 0.9);
        px[i + 3] = toHalf(1);
      }
    }
    const tex = new THREE.DataTexture(px, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    pmrem.dispose();
    return env;
  }
  key.position.copy(KEY_POS);
  key.castShadow = true;
  key.shadow.mapSize.setScalar(LOW_END ? 1024 : 2048);
  Object.assign(key.shadow.camera, { left: -1.7, right: 1.7, top: 1.3, bottom: -1.3, near: 1, far: 8 });
  key.shadow.radius = 5;
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.012;
  scene.add(key, key.target);

  // The table: transparent, so the CSS lamp-lit background shows, but it catches shadows.
  const table = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.3 }));
  table.position.z = -0.0012;
  table.receiveShadow = true;
  scene.add(table);

  const book = new THREE.Group();
  scene.add(book);

  // soft contact shadow under the book
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: softRectTexture(), transparent: true, opacity: 0.6, depthWrite: false })
  );
  contact.position.z = -0.0008;
  book.add(contact);

  // page edges of the book block
  const edgeSideMat = new THREE.MeshStandardMaterial({ map: edgeTexture(true), roughness: 0.95 });
  const edgeBottomMat = new THREE.MeshStandardMaterial({ map: edgeTexture(false), roughness: 0.95 });
  const blocks = {
    rightSide: edgeBox(edgeSideMat, 0.003, H, W + 0.0015, 0),
    rightBottom: edgeBox(edgeBottomMat, W, 0.003, W / 2, -H / 2 - 0.0015),
    leftSide: edgeBox(edgeSideMat, 0.003, H, -W - 0.0015, 0),
    leftBottom: edgeBox(edgeBottomMat, W, 0.003, -W / 2, -H / 2 - 0.0015),
  };

  function edgeBox(mat, sx, sy, x, y) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    m.scale.set(sx, sy, 0.001);
    m.position.set(x, y, 0);
    m.castShadow = true;
    m.receiveShadow = true;
    book.add(m);
    return m;
  }

  function edgeTexture(vertical) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    // paper edges: light at the top of the block, slightly shaded toward the table
    const grad = vertical ? g.createLinearGradient(64, 0, 0, 0) : g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#f4efe6');
    grad.addColorStop(1, '#d9d0c2');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function softRectTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.shadowColor = '#000';
    g.shadowBlur = 34;
    g.shadowOffsetX = 1000;
    g.fillStyle = '#000';
    g.fillRect(48 - 1000, 48, 160, 160);
    return new THREE.CanvasTexture(c);
  }

  // ---------- textures (loaded near the reader, low-res stand-ins until then) ----------

  const paperTex = new THREE.DataTexture(new Uint8Array([248, 245, 239, 255]), 1, 1);
  paperTex.colorSpace = THREE.SRGBColorSpace;
  paperTex.needsUpdate = true;

  const cache = new Map(); // url -> { tex, used, hi }
  const loading = new Set();
  let hiSet = data.pages;
  let coverShown = false;

  function request(url, hi) {
    if (!url || cache.has(url) || loading.has(url)) return;
    loading.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    img.decode().then(() => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      tex.needsUpdate = true;
      uploads.push({ url, tex, hi });
    }).catch(() => loading.delete(url));
  }

  // Sending a big picture to the GPU can take a frame or two on slow devices, so it's done between
  // turns (one per frame), or at most every 300 ms while pages are moving. Until then the page
  // shows its low-res stand-in.
  const uploads = [];
  let lastUpload = 0;
  function uploadPending(moving) {
    if (!uploads.length) return;
    const now = performance.now();
    if (moving && now - lastUpload < 300) return;
    // small stand-ins first: they're quick and they're what's missing
    const k = uploads.findIndex((u) => !u.hi);
    const { url, tex, hi } = uploads.splice(k < 0 ? 0 : k, 1)[0];
    renderer.initTexture(tex);
    cache.set(url, { tex, used: now, hi });
    loading.delete(url);
    lastUpload = now;
    prune();
    dirty = true;
  }

  function prune() {
    for (const hi of [true, false]) {
      const list = [...cache].filter(([, e]) => e.hi === hi).sort((a, b) => a[1].used - b[1].used);
      const max = hi ? 12 : 40;
      while (list.length > max) {
        const [url, e] = list.shift();
        e.tex.dispose();
        cache.delete(url);
      }
    }
  }

  function texFor(p) {
    if (p >= N) return paperTex;
    const now = performance.now();
    let e = cache.get(hiSet[p]);
    if (e) { e.used = now; return e.tex; }
    request(hiSet[p], true);
    e = cache.get(data.xs[p]);
    if (e) { e.used = now; return e.tex; }
    request(data.xs[p], false);
    return paperTex;
  }

  // ---------- sheets ----------

  function makeGeometry() {
    const count = (SX + 1) * (SY + 1);
    const pos = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const nor = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const uvF = new Float32Array(count * 2);
    const uvB = new Float32Array(count * 2);
    for (let j = 0; j <= SY; j++) {
      for (let k = 0; k <= SX; k++) {
        const v = j * (SX + 1) + k;
        uvF[v * 2] = k / SX;
        uvB[v * 2] = 1 - k / SX;
        uvF[v * 2 + 1] = uvB[v * 2 + 1] = j / SY;
      }
    }
    const index = [];
    for (let j = 0; j < SY; j++) {
      for (let k = 0; k < SX; k++) {
        const a = j * (SX + 1) + k;
        index.push(a, a + 1, a + SX + 2, a, a + SX + 2, a + SX + 1);
      }
    }
    const front = new THREE.BufferGeometry();
    const back = new THREE.BufferGeometry();
    for (const [g, uv] of [[front, uvF], [back, uvB]]) {
      g.setIndex(index);
      g.setAttribute('position', pos);
      g.setAttribute('normal', nor);
      g.setAttribute('color', col);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    return { front, back, pos, col };
  }

  // All geometry is described in the frame of a page lying on the right: x from the spine (0)
  // to the outer edge (W), y from bottom (-H/2) to top. A sheet has a "pulled point" p0 on the
  // page and the place c where that point currently is. Lying right: c = p0. Lying left: c is
  // p0 mirrored across the spine. Everything in between is a turn.
  const DEFAULT_GRAB = { x: W, y: -H / 2 }; // button turns pull the bottom outer corner
  const mirror = (pt) => ({ x: -pt.x, y: pt.y });

  const sheets = [];
  for (let i = 0; i < S; i++) {
    const geo = makeGeometry();
    const matOpts = { map: paperTex, vertexColors: true, roughness: PAPER_ROUGHNESS, metalness: 0, envMapIntensity: SHEEN };
    const front = new THREE.Mesh(geo.front, new THREE.MeshStandardMaterial({ ...matOpts, side: THREE.FrontSide }));
    const back = new THREE.Mesh(geo.back, new THREE.MeshStandardMaterial({ ...matOpts, side: THREE.BackSide }));
    for (const m of [front, back]) {
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.castShadow = true;
      book.add(m);
    }
    sheets.push({
      i, geo, front, back,
      p0: { ...DEFAULT_GRAB }, c: { ...DEFAULT_GRAB },
      target: 0, // 0 = lie right, 1 = lie left
      path: null, // { from, to, arc, len } the pulled point is travelling along
      q: 0, v: 0, // position along the path (0..1) and speed (world units / s)
      drag: false,
      peel: 0, peelTarget: 0, peelCorner: { ...DEFAULT_GRAB },
      dragTo: { ...DEFAULT_GRAB }, dvx: 0, dvy: 0, // where the hand is pulling, and how fast the paper moves
      shaped: { cx: NaN, cy: NaN, px: NaN, py: NaN }, // the pose the mesh was last built for
    });
  }

  // How far a sheet is through its turn (0 = right, 1 = left).
  function progress(sh) {
    const r = sh.c.x / sh.p0.x;
    return clamp((1 - r) / 2, 0, 1);
  }

  const endPoint = (sh, target) => (target === 1 ? mirror(sh.p0) : { ...sh.p0 });

  // Shape of a sheet for its current pulled point.
  function shape(sh) {
    const p = progress(sh);
    const sp = Math.sin(Math.PI * p);
    const restR = (S - sh.i) * GAP;
    const restL = (sh.i + 1) * GAP;
    const baseFlip = restR + (restL - restR) * smooth(p); // height of the part that has turned over
    const root = (S - sh.i + (2 * sh.i + 1 - S) * p) * EPS;
    const gw = (1 - sp) * (1 - sp); // spine curve: full when lying down, gone mid-turn
    const pos = sh.geo.pos.array;
    const col = sh.geo.col.array;

    // fold line: perpendicular to the pull, placed so the pulled point lands on c
    let nx = sh.p0.x - sh.c.x;
    let ny = sh.p0.y - sh.c.y;
    const len = Math.hypot(nx, ny);
    const folded = len > 1e-5;
    const r = R_MAX * sp;
    let F = Infinity;
    if (folded) {
      nx /= len;
      ny /= len;
      F = (sh.c.x * nx + sh.c.y * ny + sh.p0.x * nx + sh.p0.y * ny - Math.PI * r) / 2;
      F = Math.max(F, (Math.abs(ny) * H) / 2); // the spine edge stays attached
    }

    for (let j = 0; j <= SY; j++) {
      const y = (j / SY - 0.5) * H;
      for (let k = 0; k <= SX; k++) {
        const x = (k / SX) * W;
        let X = x;
        let Y = y;
        let Z = 0;
        let base = restR; // the part still lying on the right stays on top of the right stack
        if (folded) {
          const d = x * nx + y * ny - F;
          if (d > 0) {
            let off;
            if (d < Math.PI * r) {
              const th = d / r;
              off = r * Math.sin(th) - d;
              Z = r * (1 - Math.cos(th));
              base = restR + (baseFlip - restR) * (th / Math.PI);
            } else {
              off = Math.PI * r - 2 * d;
              Z = 2 * r;
              base = baseFlip;
            }
            X += off * nx;
            Y += off * ny;
          }
        }
        // the page curves down into the binding
        const ax = Math.abs(X);
        const g = ax < GUTTER ? (1 - ax / GUTTER) ** 2 : 0;
        Z += base - (base - root) * g * gw;
        const v = (j * (SX + 1) + k) * 3;
        pos[v] = X;
        pos[v + 1] = Y;
        pos[v + 2] = Z;
        col[v] = col[v + 1] = col[v + 2] = 1 - 0.55 * g * (0.3 + 0.7 * gw); // occlusion deep in the gutter
      }
    }
    sh.geo.pos.needsUpdate = true;
    sh.geo.col.needsUpdate = true;
    sh.geo.front.computeVertexNormals();
  }

  // Paper can't stretch: a point on the page stays within its distance of the spine's ends.
  function constrain(sh, pt) {
    const out = { x: Math.max(pt.x, -W * 1.02), y: pt.y };
    for (let k = 0; k < 3; k++) {
      for (const ey of [-H / 2, H / 2]) {
        const max = Math.hypot(sh.p0.x, sh.p0.y - ey);
        const dx = out.x;
        const dy = out.y - ey;
        const dist = Math.hypot(dx, dy);
        if (dist > max) {
          out.x = (dx * max) / dist;
          out.y = ey + (dy * max) / dist;
        }
      }
    }
    return out;
  }

  // ---------- reading state ----------

  let pos = 0; // sheets turned (where the reader is heading)
  let side = 'R'; // single-page view: which page of the spread is shown
  let portrait = false;
  let dirty = true;

  // Send a sheet toward a side. Keeps it moving if it's already in the air.
  function turn(i, target, arc) {
    const sh = sheets[i];
    if (sh.drag) return;
    if (sh.target === target && (sh.path || sh.c.x === endPoint(sh, target).x)) return;
    const atRest = !sh.path;
    if (atRest) {
      // a fresh turn: pull the bottom outer corner
      sh.p0 = { ...DEFAULT_GRAB };
      sh.c = target === 1 ? { ...sh.p0 } : mirror(sh.p0);
    }
    sh.target = target;
    setPath(sh, endPoint(sh, target), arc === undefined ? ARC : arc);
  }

  function setPath(sh, to, arc) {
    const from = { ...sh.c };
    const len = Math.max(1e-4, Math.hypot(to.x - from.x, to.y - from.y));
    // carry the current speed over, projected onto the new direction (a reversal slows, then returns)
    let v = 0;
    if (sh.path) {
      const odx = (sh.path.to.x - sh.path.from.x) / sh.path.len;
      const ody = (sh.path.to.y - sh.path.from.y) / sh.path.len;
      v = sh.v * (odx * (to.x - from.x) + ody * (to.y - from.y)) / len;
    }
    sh.path = { from, to, arc: arc * Math.min(1, len / (2 * W)), len };
    sh.q = 0;
    sh.v = v;
  }

  function next() {
    if (portrait && side === 'L' && pos > 0 && pos < S) {
      side = 'R';
    } else if (pos < S) {
      turn(pos, 1);
      pos++;
      side = 'L';
    } else return;
    afterNav();
  }

  function prev() {
    if (portrait && side === 'R' && pos > 0) {
      side = 'L';
    } else if (pos > 0) {
      pos--;
      turn(pos, 0);
      side = 'R';
    } else return;
    afterNav();
  }

  function goToPage(p, instant) {
    p = clamp(p, 1, N);
    pos = Math.floor(p / 2);
    side = p % 2 ? 'R' : 'L';
    for (const sh of sheets) {
      const target = sh.i < pos ? 1 : 0;
      if (instant) {
        sh.target = target;
        sh.p0 = { ...DEFAULT_GRAB };
        sh.c = endPoint(sh, target);
        sh.path = null;
        sh.v = 0;
      } else turn(sh.i, target);
    }
    afterNav();
  }

  function shownPages() {
    // 0-based page indexes currently facing the reader
    if (portrait) return [side === 'R' ? 2 * pos : 2 * pos - 1];
    if (pos === 0) return [0];
    if (pos >= S) return [N - 1];
    return [2 * pos - 1, 2 * pos];
  }

  function afterNav() {
    if (pos === 0) side = 'R';
    if (pos >= S) side = 'L';
    const shown = shownPages();
    const first = shown[0] + 1;
    let label;
    if (shown.length === 2) label = `${first}–${first + 1} / ${N}`;
    else label = first === 1 ? 'Cover' : first === N ? 'Back cover' : `${first} / ${N}`;
    counter.textContent = label;
    $('first').disabled = $('prev').disabled = pos === 0;
    $('last').disabled = $('next').disabled = pos >= S;
    history.replaceState(null, '', first === 1 ? location.pathname + location.search : `#page=${first}`);
    for (let i = Math.max(0, pos - 2); i <= Math.min(S - 1, pos + 2); i++) {
      texFor(2 * i);
      texFor(2 * i + 1);
    }
    dirty = true;
  }

  // ---------- animation ----------

  // Must this sheet wait so it doesn't run into the sheet ahead of it?
  function held(sh) {
    if (sh.target === 1) {
      const ahead = sheets[sh.i - 1];
      return ahead && ahead.target === 1 && progress(ahead) < 1 && progress(ahead) < progress(sh) + STAGGER;
    }
    const ahead = sheets[sh.i + 1];
    return ahead && ahead.target === 0 && progress(ahead) > 0 && progress(ahead) > progress(sh) - STAGGER;
  }

  function step(dt) {
    let active = false;
    for (const sh of sheets) {
      if (sh.drag) {
        // the paper follows the hand with a little lag; it never jumps
        const k = 1 - Math.exp(-dt * 28);
        let mx = (sh.dragTo.x - sh.c.x) * k;
        let my = (sh.dragTo.y - sh.c.y) * k;
        const m = Math.hypot(mx, my);
        const cap = DRAG_SPEED * dt; // however fast the hand moves, paper has mass
        if (m > cap) { mx *= cap / m; my *= cap / m; }
        const nx = sh.c.x + mx;
        const ny = sh.c.y + my;
        if (dt > 0) {
          sh.dvx = sh.dvx * 0.6 + (0.4 * (nx - sh.c.x)) / dt;
          sh.dvy = sh.dvy * 0.6 + (0.4 * (ny - sh.c.y)) / dt;
        }
        sh.c = constrain(sh, { x: nx, y: ny });
        active = true;
        continue;
      }

      // mouse near a corner: the page lifts a little there
      sh.peel += (sh.peelTarget - sh.peel) * Math.min(1, dt * 10);
      if (!sh.path && (sh.peel > 1e-4 || sh.peelTarget > 0)) {
        const rest = endPoint(sh, sh.target);
        const dir = sh.target === 1 ? 1 : -1;
        sh.c = { x: rest.x + dir * 0.09 * sh.peel, y: rest.y - Math.sign(rest.y) * 0.06 * sh.peel };
        if (sh.peel < 1e-4 && sh.peelTarget === 0) {
          sh.peel = 0;
          sh.c = rest;
        }
        active = true;
        continue;
      }

      const path = sh.path;
      if (!path) continue;
      active = true;
      if (held(sh)) { sh.v = 0; continue; }
      // accelerate, cruise, then ease into the landing
      const remaining = (1 - sh.q) * path.len;
      const want = Math.min(SPEED, Math.sqrt(2 * ACC * Math.max(0, remaining)));
      sh.v += clamp(want - sh.v, -ACC * 1.6 * dt, ACC * 1.6 * dt);
      sh.q += (sh.v * dt) / path.len;
      if (sh.q >= 1) {
        sh.c = { ...path.to };
        sh.path = null;
        sh.v = 0;
        sh.q = 0;
        continue;
      }
      const e = sh.q;
      const lift = path.arc * Math.sin(Math.PI * clamp(e, 0, 1));
      sh.c = constrain(sh, {
        x: path.from.x + (path.to.x - path.from.x) * e,
        y: path.from.y + (path.to.y - path.from.y) * e + lift,
      });
    }
    return active;
  }

  // ---------- camera (looking down at the book from above) ----------

  let dist = 3;
  let shift = 0;
  let camX = 0;
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };

  function placeCamera(cx, d, tx, ty) {
    camera.position.set(cx + tx * 0.05 * d, -ty * 0.04 * d, d);
    camera.up.set(0, 1, 0);
    camera.lookAt(cx, 0, 0);
    camera.updateMatrixWorld();
  }

  const probe = new THREE.Vector3();
  function fits(d, halfW) {
    placeCamera(0, d, 0, 0);
    for (const x of [-halfW, halfW]) {
      for (const y of [-H / 2, H / 2]) {
        probe.set(x, y, 0).project(camera);
        if (Math.abs(probe.x) > 0.92 || Math.abs(probe.y) > 0.86) return false;
      }
    }
    return true;
  }

  function fit() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const wasPortrait = portrait;
    portrait = w < PORTRAIT_BELOW || w / h < 0.85;
    let lo = 0.5;
    let hi = 30;
    for (let k = 0; k < 32; k++) {
      const d = (lo + hi) / 2;
      if (fits(d, portrait ? W / 2 : W)) hi = d;
      else lo = d;
    }
    dist = hi;
    // texture size to match how big a page is on screen
    const pagePx = (H / (2 * dist * Math.tan((FOV * Math.PI) / 360))) * h * renderer.getPixelRatio();
    hiSet = pagePx > 1500 && !LOW_END ? data.zoom : pagePx > 900 ? data.pages : data.sm;
    if (portrait !== wasPortrait) {
      if (portrait) side = pos >= S ? 'L' : 'R';
      afterNav();
    }
    dirty = true;
  }

  // ---------- frame ----------

  let shadowsChanged = true;

  function render(dt) {
    let maxT = 0;
    let minT = 1;
    let right = 0;
    const prog = sheets.map(progress);
    for (const p of prog) {
      maxT = Math.max(maxT, p);
      minT = Math.min(minT, p);
      if (p < 0.5) right++;
    }
    const left = S - right;

    // a closed book lies centred on the table and slides over as it opens
    const shiftTarget = portrait ? 0 : (-W / 2) * (1 - smooth(maxT)) + (W / 2) * smooth(minT);
    const camTarget = portrait ? (side === 'R' ? W / 2 : -W / 2) : 0;
    const k = Math.min(1, dt * 5);
    shift += (shiftTarget - shift) * k;
    camX += (camTarget - camX) * k;
    tilt.x += (tilt.tx - tilt.x) * Math.min(1, dt * 3);
    tilt.y += (tilt.ty - tilt.y) * Math.min(1, dt * 3);
    const settling = Math.abs(shiftTarget - shift) > 1e-4 || Math.abs(camTarget - camX) > 1e-4 ||
      Math.abs(tilt.tx - tilt.x) > 1e-3 || Math.abs(tilt.ty - tilt.y) > 1e-3;
    if (book.position.x !== shift) shadowsChanged = true;
    book.position.x = shift;
    placeCamera(camX, dist, tilt.x, tilt.y);

    // only sheets that can be seen: those in the air and the top sheet on each side
    let topR = -1;
    let topL = -1;
    sheets.forEach((sh, i) => {
      const resting = !sh.path && !sh.drag;
      if (resting && prog[i] === 0 && topR < 0) topR = i;
      if (resting && prog[i] === 1) topL = i;
    });
    sheets.forEach((sh, i) => {
      const visible = sh.drag || !!sh.path || sh.peel > 0 || i === topR || i === topL;
      if (sh.front.visible !== visible) shadowsChanged = true;
      sh.front.visible = sh.back.visible = visible;
      if (!visible) return;
      if (sh.c.x !== sh.shaped.cx || sh.c.y !== sh.shaped.cy || sh.p0.x !== sh.shaped.px || sh.p0.y !== sh.shaped.py) {
        shape(sh);
        sh.shaped = { cx: sh.c.x, cy: sh.c.y, px: sh.p0.x, py: sh.p0.y };
        shadowsChanged = true;
      }
      sh.front.material.map = texFor(2 * i);
      sh.back.material.map = texFor(2 * i + 1);
    });

    // the block of pages under the top sheet (kept just below it so the two never fight)
    const depthR = Math.max(0, (right - 0.6) * GAP);
    const depthL = Math.max(0, (left - 0.6) * GAP);
    for (const [m, depth] of [[blocks.rightSide, depthR], [blocks.rightBottom, depthR], [blocks.leftSide, depthL], [blocks.leftBottom, depthL]]) {
      m.visible = depth > GAP * 0.3;
      m.scale.z = Math.max(depth, 0.0001);
      m.position.z = depth / 2;
    }

    const x0 = -W * smooth(maxT);
    const x1 = W * (1 - smooth(minT));
    contact.visible = x1 - x0 > 0.01;
    contact.scale.set((x1 - x0) / 0.625, H / 0.625, 1);
    contact.position.set((x0 + x1) / 2 + 0.015, -0.02, contact.position.z);

    if (shadowsChanged) renderer.shadowMap.needsUpdate = true;
    shadowsChanged = false;
    renderer.render(scene, camera);

    if (!coverShown && sheets.some((sh) => sh.front.visible && (sh.front.material.map !== paperTex || sh.back.material.map !== paperTex))) {
      coverShown = true;
      loader.classList.add('done');
      canvas.classList.add('ready');
    }
    return settling;
  }

  // Adaptive resolution: while things move, watch the frame time. If frames are slow, render
  // fewer pixels so motion stays fluid; if there's headroom, step back up toward full sharpness.
  let avgMs = 16;
  let sampled = 0;
  function adaptResolution(frameMs) {
    avgMs += (Math.min(frameMs, 200) - avgMs) * 0.15; // smoothed, so one odd frame doesn't decide
    sampled++;
    let next = pixelRatio;
    if (sampled >= 6 && avgMs > 22 && pixelRatio > PR_MIN) next = Math.max(PR_MIN, pixelRatio - (avgMs > 45 ? 0.5 : 0.25));
    else if (sampled >= 120 && avgMs < 14 && pixelRatio < PR_MAX) next = Math.min(PR_MAX, pixelRatio + 0.25);
    if (next !== pixelRatio) {
      pixelRatio = next;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      sampled = 0; // let the new setting show its frame time before judging again
      avgMs = 16;
    }
  }

  let last = performance.now();
  let wasRendering = false;
  function frame(now) {
    const frameMs = now - last;
    // keep pace with real time even when a frame is late, so motion never drags
    const dt = Math.min(0.1, frameMs / 1000);
    last = now;
    const active = step(dt);
    uploadPending(active);
    if (active || dirty) {
      if (wasRendering && active) adaptResolution(frameMs);
      dirty = render(dt) || cache.size === 0;
      wasRendering = true;
    } else wasRendering = false;
    requestAnimationFrame(frame);
  }

  // ---------- pointer: drag, swipe, click, corner peel ----------

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const bookPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hit = new THREE.Vector3();

  function toBook(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(bookPlane, hit)) return null;
    return { x: hit.x - book.position.x, y: hit.y };
  }

  let press = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    press = { cx: e.clientX, cy: e.clientY, time: performance.now(), b: toBook(e), drag: null };
    canvas.setPointerCapture(e.pointerId);
    clearPeel();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && !LOW_END) {
      const r = canvas.getBoundingClientRect();
      tilt.tx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      tilt.ty = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
      if (!reduceMotion && !LOW_END) dirty = true;
    }
    if (!press) {
      if (e.pointerType === 'mouse') hover(toBook(e));
      return;
    }
    const dx = e.clientX - press.cx;
    if (!press.drag && Math.hypot(dx, e.clientY - press.cy) > 6) press.drag = beginDrag(dx) || 'swipe';
    if (press.drag && press.drag !== 'swipe') moveDrag(press.drag, toBook(e));
  });

  function release(e) {
    if (!press) return;
    const p = press;
    press = null;
    if (p.drag && p.drag !== 'swipe') return endDrag(p.drag);
    const dx = e.clientX - p.cx;
    if (p.drag === 'swipe') {
      if (dx < -40) next();
      else if (dx > 40) prev();
      return;
    }
    if (performance.now() - p.time > 600) return;
    // a tap/click: right side goes forward, left side goes back
    let forward;
    if (portrait || !p.b) {
      const r = canvas.getBoundingClientRect();
      forward = e.clientX > r.left + r.width / 2;
    } else forward = p.b.x >= 0;
    if (forward) next();
    else prev();
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') {
      tilt.tx = tilt.ty = 0;
      clearPeel();
      dirty = true;
    }
  });

  function beginDrag(dx) {
    const b = press.b;
    if (!b || Math.abs(b.y) > H / 2 || Math.abs(b.x) > W) return null;
    let sh = null;
    let fwd = false;
    if (dx < 0 && pos < S && (portrait ? side === 'R' : b.x > 0)) {
      const c = sheets[pos];
      if (!c.path && c.target === 0) { sh = c; fwd = true; }
    } else if (dx > 0 && pos > 0 && (portrait ? side === 'L' : b.x < 0)) {
      const c = sheets[pos - 1];
      if (!c.path && c.target === 1) sh = c;
    }
    if (!sh) return null;
    // Wherever the page is grabbed, its outer edge at that height is what gets pulled, and the
    // hand's travel is scaled so that dragging across the book carries the edge all the way over.
    // (Pulling the grabbed point itself would fold the paper beyond it over in one go.)
    const grab = { x: clamp(Math.abs(b.x), 0.12, W), y: clamp(b.y, -H / 2, H / 2) };
    sh.peel = sh.peelTarget = 0;
    sh.p0 = { x: W, y: grab.y };
    sh.c = fwd ? { ...sh.p0 } : mirror(sh.p0);
    sh.dragTo = { ...sh.c };
    sh.dvx = sh.dvy = 0;
    sh.drag = true;
    return { sh, fwd, grab, startY: b.y };
  }

  function moveDrag(d, b) {
    if (!b) return;
    const sh = d.sh;
    const gx = d.grab.x;
    const x = d.fwd
      ? W - ((gx - b.x) * 2 * W) / (gx + W)
      : -W + ((b.x + gx) * 2 * W) / (gx + W);
    const c = constrain(sh, { x, y: sh.p0.y + (b.y - d.startY) });
    // never pass a sheet that is still in the air
    const before = sheets[sh.i - 1];
    const after = sheets[sh.i + 1];
    if (d.fwd && before && before.path) {
      const maxP = Math.max(0, progress(before) - STAGGER);
      c.x = Math.max(c.x, sh.p0.x * (1 - 2 * maxP));
    }
    if (!d.fwd && after && after.path) {
      const minP = Math.min(1, progress(after) + STAGGER);
      c.x = Math.min(c.x, sh.p0.x * (1 - 2 * minP));
    }
    sh.dragTo = c;
    dirty = true;
  }

  function endDrag(d) {
    const sh = d.sh;
    sh.drag = false;
    const vx = clamp(sh.dvx, -6, 6);
    const vy = clamp(sh.dvy, -6, 6);
    const p = progress(sh);
    const need = portrait ? 0.25 : 0.5; // phones: past the middle of the page is enough
    const flick = 1.2; // world units / s toward the other side counts as a throw
    const commit = d.fwd ? (p > need && vx < 0.8) || vx < -flick : (p < 1 - need && vx > -0.8) || vx > flick;
    if (commit) {
      if (d.fwd) { pos++; side = 'L'; } else { pos--; side = 'R'; }
    }
    sh.target = d.fwd === commit ? 1 : 0;
    // keep the momentum of the throw
    const to = endPoint(sh, sh.target);
    const len = Math.max(1e-4, Math.hypot(to.x - sh.c.x, to.y - sh.c.y));
    sh.path = { from: { ...sh.c }, to, arc: 0.06 * Math.min(1, len / (2 * W)), len };
    sh.q = 0;
    sh.v = Math.max(0, (vx * (to.x - sh.c.x) + vy * (to.y - sh.c.y)) / len);
    afterNav();
  }

  // lift the corner of the top page when the mouse is near it
  function hover(b) {
    clearPeel();
    if (!b || Math.abs(b.y) > H / 2 || H / 2 - Math.abs(b.y) > 0.2) return;
    if (b.x > W - 0.2 && b.x <= W && pos < S && !sheets[pos].path && sheets[pos].target === 0) {
      peel(sheets[pos], { x: W, y: Math.sign(b.y) * (H / 2) || -H / 2 });
    } else if (b.x < -W + 0.2 && b.x >= -W && pos > 0 && !sheets[pos - 1].path && sheets[pos - 1].target === 1) {
      peel(sheets[pos - 1], { x: W, y: Math.sign(b.y) * (H / 2) || -H / 2 });
    }
  }
  function peel(sh, corner) {
    if (sh.peel === 0) sh.p0 = corner;
    else if (sh.p0.y !== corner.y) return;
    sh.peelTarget = 1;
    canvas.style.cursor = 'grab';
    dirty = true;
  }
  function clearPeel() {
    for (const sh of sheets) sh.peelTarget = 0;
    canvas.style.cursor = '';
  }

  // ---------- controls ----------

  $('prev').onclick = prev;
  $('next').onclick = next;
  $('first').onclick = () => goToPage(1, false);
  $('last').onclick = () => goToPage(N, false);

  const fsBtn = $('fullscreen');
  const root = document.documentElement;
  if (!root.requestFullscreen && !root.webkitRequestFullscreen) fsBtn.hidden = true;
  fsBtn.onclick = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    }
  };

  // Zoom: the open page(s) large enough to read; scroll or pinch to pan.
  const zoomView = $('zoomView');
  const zoomPages = $('zoomPages');
  function openZoom() {
    const nums = shownPages();
    const zw = Math.max(900, Math.round((window.innerWidth * 1.5) / nums.length));
    zoomPages.style.setProperty('--zw', Math.min(zw, 2400) + 'px');
    zoomPages.innerHTML = nums.map((k) => `<img src="${data.zoom[k]}" alt="Page ${k + 1}">`).join('');
    zoomView.hidden = false;
    zoomView.scrollTo((zoomView.scrollWidth - zoomView.clientWidth) / 2, 0);
    $('zoomClose').focus();
  }
  function closeZoom() {
    zoomView.hidden = true;
    $('zoom').focus();
  }
  $('zoom').onclick = openZoom;
  $('zoomClose').onclick = closeZoom;

  document.addEventListener('keydown', (e) => {
    if (!zoomView.hidden) {
      if (e.key === 'Escape') closeZoom();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') next();
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
    else if (e.key === 'Home') goToPage(1, false);
    else if (e.key === 'End') goToPage(N, false);
    else return;
    e.preventDefault();
  });

  // ---------- start ----------

  window.addEventListener('resize', fit);
  fit();
  for (let p = 0; p < N; p++) request(data.xs[p], false);
  const startPage = parseInt((location.hash.match(/page=(\d+)/) || [])[1], 10) || 1;
  goToPage(startPage, true);
  shift = portrait ? 0 : pos === 0 ? -W / 2 : pos >= S ? W / 2 : 0;
  camX = portrait ? (side === 'R' ? W / 2 : -W / 2) : 0;
  setTimeout(() => { loader.classList.add('done'); canvas.classList.add('ready'); }, 6000);
  requestAnimationFrame(frame);

  // for automated checks
  window.__flipbook = {
    next, prev, goToPage,
    state: () => ({ pos, side, portrait, pixelRatio, lowEnd: LOW_END, t: sheets.map((s) => +progress(s).toFixed(3)) }),
    pose: (i, c) => { const sh = sheets[i]; sh.drag = true; sh.p0 = { ...DEFAULT_GRAB }; sh.c = sh.dragTo = constrain(sh, c); },
  };
})();
