(function(){
  const MAP_W = 100, MAP_H = 100, TILE_PX = 24;
  const GRASS = 0, WATER = 1;
  const WATER_COLOR = '#1E90FF';
  const WATER_LEVEL = 0.45;
  const MAX_WATER_PCT = 0.25;
  const MIN_WATER_PCT = 0.15;

  const canvas = document.getElementById('mapCanvas');
  if (!canvas) { console.error('Canvas not found'); return; }
  const ctx = canvas.getContext('2d');
  let screenW = 0, screenH = 0;

  const camera = { x: (MAP_W * TILE_PX) / 2, y: (MAP_H * TILE_PX) / 2, zoom: 1.0 };
  const pressedKeys = new Set();
  let isDragging = false;
  let dragStartMouse = { x:0, y:0 };
  let dragStartCam = { x:0, y:0 };

  const map = new Uint8Array(MAP_W * MAP_H);
  const height = new Float32Array(MAP_W * MAP_H);

  // Seeded random for reproducible maps
  function createRNG(seed) {
    let s = seed >>> 0;
    return function() {
      s = Math.imul(s, 1664525) + 1013904223 >>> 0;
      return s / 4294967296;
    };
  }
  let rng = createRNG(Date.now());

  // Value noise with smooth interpolation
  function hash2(x, y, seed) {
    const h = (x * 374761393 + y * 668265263) ^ seed;
    return ((h ^ (h >>> 13)) * 1274126177 >>> 0) / 4294967296;
  }
  function smoothNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed);
    const b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed);
    const d = hash2(ix + 1, iy + 1, seed);
    return a + (b - a) * ux + (c - a) * uy + (d - b - c + a) * ux * uy;
  }
  function fractalNoise(x, y, octaves, lacunarity, persistence, seed) {
    let val = 0, amp = 1, freq = 1, maxVal = 0;
    for (let i = 0; i < octaves; i++) {
      val += smoothNoise(x * freq, y * freq, seed + i * 1000) * amp;
      maxVal += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return val / maxVal;
  }

  // Determine which edge gets the coastline (stored for validation)
  let coastlineEdge = '';

  function generateTerrain() {
    const seed = (Date.now() >>> 0);
    rng = createRNG(seed);

    // 1) Pick random edge for coastline
    const edges = ['top', 'bottom', 'left', 'right'];
    coastlineEdge = edges[Math.floor(rng() * edges.length)];

    // 2) Generate base terrain with multiple noise layers
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const idx = x + y * MAP_W;
        
        // Large-scale continent shape (very low frequency)
        const continent = fractalNoise(x / 45, y / 45, 3, 2.2, 0.5, seed);
        
        // Medium detail
        const detail = fractalNoise(x / 15, y / 15, 4, 2.0, 0.5, seed + 1);
        
        // Fine detail (small variations)
        const fine = fractalNoise(x / 6, y / 6, 3, 2.0, 0.4, seed + 2);
        
        // Combine: 60% continent, 30% detail, 10% fine
        let h = 0.6 * continent + 0.3 * detail + 0.1 * fine;
        
        // 3) Apply edge gradient to ensure coastline touches ONE edge
        // Gradient strength: strong near the edge, fades toward center
        const gradientStrength = 0.55;
        const edgeFadeDist = MAP_W * 0.5; // How far the gradient effect reaches
        
        switch (coastlineEdge) {
          case 'top':
            const topGrad = 1 - (y / edgeFadeDist);
            h -= topGrad * gradientStrength;
            break;
          case 'bottom':
            const bottomGrad = 1 - ((MAP_H - 1 - y) / edgeFadeDist);
            h -= bottomGrad * gradientStrength;
            break;
          case 'left':
            const leftGrad = 1 - (x / edgeFadeDist);
            h -= leftGrad * gradientStrength;
            break;
          case 'right':
            const rightGrad = 1 - ((MAP_W - 1 - x) / edgeFadeDist);
            h -= rightGrad * gradientStrength;
            break;
        }
        
        height[idx] = Math.max(0, Math.min(1, h));
      }
    }

    // 4) Apply domain warping for natural coastlines (no straight lines)
    const warpedHeight = new Float32Array(MAP_W * MAP_H);
    const warpScale = 0.025;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const idx = x + y * MAP_W;
        const warpX = fractalNoise(x * warpScale + 100, y * warpScale, 2, 2.0, 0.5, seed + 500) * 8;
        const warpY = fractalNoise(x * warpScale, y * warpScale + 100, 2, 2.0, 0.5, seed + 501) * 8;
        
        // Sample nearby height values and average
        const sx = Math.max(0, Math.min(MAP_W - 1, Math.floor(x + warpX)));
        const sy = Math.max(0, Math.min(MAP_H - 1, Math.floor(y + warpY)));
        warpedHeight[idx] = height[sx + sy * MAP_W];
      }
    }
    
    // Copy warped heights back
    for (let i = 0; i < height.length; i++) {
      height[i] = warpedHeight[i];
    }

    // 5) Enforce water percentage constraints via uniform height adjustment
    const totalTiles = MAP_W * MAP_H;
    const countWater = () => {
      let count = 0;
      for (let i = 0; i < totalTiles; i++) {
        map[i] = height[i] < WATER_LEVEL ? WATER : GRASS;
        if (map[i] === WATER) count++;
      }
      return count;
    };

    let waterTiles = countWater();
    let waterPct = waterTiles / totalTiles;

    // If water exceeds 25%, raise all heights uniformly until under limit
    if (waterPct > MAX_WATER_PCT) {
      const adjustStep = 0.02;
      let iterations = 0;
      while (waterPct > MAX_WATER_PCT && iterations < 50) {
        for (let i = 0; i < totalTiles; i++) {
          height[i] = Math.min(1, height[i] + adjustStep);
        }
        waterTiles = countWater();
        waterPct = waterTiles / totalTiles;
        iterations++;
      }
    }

    // If water is below 15%, add a gentle depression near chosen edge to create more water
    if (waterPct < MIN_WATER_PCT) {
      const edgeBoost = 0.12;
      for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
          const idx = x + y * MAP_W;
          let boost = 0;
          switch (coastlineEdge) {
            case 'top':
              boost = (1 - y / (MAP_H * 0.5)) * edgeBoost;
              break;
            case 'bottom':
              boost = (1 - (MAP_H - 1 - y) / (MAP_H * 0.5)) * edgeBoost;
              break;
            case 'left':
              boost = (1 - x / (MAP_W * 0.5)) * edgeBoost;
              break;
            case 'right':
              boost = (1 - (MAP_W - 1 - x) / (MAP_W * 0.5)) * edgeBoost;
              break;
          }
          height[idx] = Math.max(0, height[idx] - boost);
        }
      }
      waterTiles = countWater();
      waterPct = waterTiles / totalTiles;
    }

    waterPct = Math.round((waterTiles / totalTiles) * 100);
    console.log(`Terrain generated: ${waterPct}% water, coastline on ${coastlineEdge} edge`);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    screenW = canvas.clientWidth;
    screenH = canvas.clientHeight;
    canvas.width = Math.floor(screenW * dpr);
    canvas.height = Math.floor(screenH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function worldToScreen(wx, wy) {
    const sx = (wx - camera.x) * camera.zoom + screenW / 2;
    const sy = (wy - camera.y) * camera.zoom + screenH / 2;
    return { x: sx, y: sy };
  }

  function render() {
    const dt = 0.016;
    const SPEED = 480;
    if (pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp')) camera.y -= (SPEED * dt) / camera.zoom;
    if (pressedKeys.has('KeyS') || pressedKeys.has('ArrowDown')) camera.y += (SPEED * dt) / camera.zoom;
    if (pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft')) camera.x -= (SPEED * dt) / camera.zoom;
    if (pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight')) camera.x += (SPEED * dt) / camera.zoom;

    ctx.clearRect(0, 0, screenW, screenH);
    const worldLeft = camera.x - (screenW / 2) / camera.zoom;
    const worldTop = camera.y - (screenH / 2) / camera.zoom;
    const worldRight = worldLeft + screenW / camera.zoom;
    const worldBottom = worldTop + screenH / camera.zoom;
    const TILE = TILE_PX;
    const startGX = Math.max(0, Math.floor(worldLeft / TILE));
    const startGY = Math.max(0, Math.floor(worldTop / TILE));
    const endGX = Math.min(MAP_W, Math.ceil(worldRight / TILE));
    const endGY = Math.min(MAP_H, Math.ceil(worldBottom / TILE));

    for (let gy = startGY; gy < endGY; gy++) {
      for (let gx = startGX; gx < endGX; gx++) {
        const idx = gx + gy * MAP_W;
        const wx = gx * TILE;
        const wy = gy * TILE;
        const pos = worldToScreen(wx, wy);
        const size = TILE * camera.zoom;
        ctx.fillStyle = (map[idx] === WATER) ? WATER_COLOR : '#7CFC00';
        ctx.fillRect(pos.x, pos.y, size, size);
      }
    }
    requestAnimationFrame(render);
  }

  function init() {
    console.log('Canvas found');
    resize();
    generateTerrain();
    console.log('Heightmap generated');

    window.addEventListener('keydown', (e) => pressedKeys.add(e.code));
    window.addEventListener('keyup', (e) => pressedKeys.delete(e.code));

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        isDragging = true;
        dragStartMouse = { x: e.clientX, y: e.clientY };
        dragStartCam = { x: camera.x, y: camera.y };
      }
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartMouse.x;
      const dy = e.clientY - dragStartMouse.y;
      camera.x = dragStartCam.x - dx / camera.zoom;
      camera.y = dragStartCam.y - dy / camera.zoom;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const zoomOld = camera.zoom;
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      let zoomNew = zoomOld * zoomFactor;
      if (zoomNew < 0.25) zoomNew = 0.25;
      if (zoomNew > 4.0) zoomNew = 4.0;
      const wx = camera.x + (mx - screenW / 2) / zoomOld;
      const wy = camera.y + (my - screenH / 2) / zoomOld;
      camera.x = wx - (mx - screenW / 2) / zoomNew;
      camera.y = wy - (my - screenH / 2) / zoomNew;
      camera.zoom = zoomNew;
    }, { passive: false });

    requestAnimationFrame(render);
    console.log('Render loop started');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
