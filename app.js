// 海眼儀表板：依時間回放 AIS 航跡、預測位置與警示。資料由 `python -m seaeye dashboard` 產生。

const COLOR = {
  moving: [45, 212, 191], idle: [100, 116, 139], sim: [251, 191, 36], pred: [56, 189, 248],
  deviation: [249, 115, 22], ais_gap: [239, 68, 68], loiter: [168, 85, 247],
  rescue: [255, 64, 160], // 救援船：桃紅色，避開警示用的橘、紅、紫與模擬用的琥珀色
};
const TYPE_LABEL = { deviation: '偏航', ais_gap: '疑似關閉 AIS', loiter: '異常滯留' };
const ACTIVE_S = 3600;       // 警示發出後 1 小時內在地圖上標示
const TRAIL_S = 1800;        // 航跡尾巴長度 30 分鐘
const PRED_FRESH_S = 180;    // 預測發布超過 3 分鐘就不顯示，避免拿舊預測接到現在位置
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const LIGHT_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'; // 投影機用淺色
const CJK_FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
const VERIFY_H = 15; // 「預測 vs. 實際」對照用的時距（分鐘）
const DASH_EXT = deck.PathStyleExtension ? new deck.PathStyleExtension({ dash: true }) : null;
const RESCUE_COLORS = [[244, 63, 94], [168, 85, 247], [234, 179, 8]]; // 三個求救點各一色
const RESCUE_ANIM_S = 8; // 出發動畫的實際秒數：最慢的船剛好在動畫結束時抵達
const WELCOME_KEY = 'seaeye-welcome-seen';
const THEME_KEY = 'seaeye-theme';

// 點選船舶時比較的預測：融合是系統最終輸出，其餘四個預測器是它的組成
const METHOD_STYLE = {
  fused: { label: '融合', name: 'Hedge 融合', color: [56, 189, 248], width: 3 },
  cv: { label: 'CV', name: '常速度 CV', color: [226, 232, 240], width: 1.5 },
  ctr: { label: 'CTR', name: '常轉向率 CTR', color: [163, 230, 53], width: 1.5 },
  nlms: { label: 'NLMS', name: 'NLMS 殘差', color: [244, 114, 182], width: 1.5 },
  imm: { label: 'IMM', name: 'IMM 卡爾曼', color: [251, 146, 60], width: 1.5 },
  lane: { label: 'LANE', name: '航道先驗 LANE', color: [129, 140, 248], width: 1.5 },
};

// 訊號中斷：最後位置留下淡色船影。沒再回報的船影最多留 2 小時，靠近範圍邊緣的（多半駛出範圍）留 20 分鐘
const GHOST_MAX_S = 7200, GHOST_EDGE_S = 1200;
const GHOST_COLOR = { outage: [148, 163, 184], alert: COLOR.ais_gap, edge: [100, 116, 139], short: [148, 163, 184], end: [148, 163, 184] };
const DETAIL_KEY = 'seaeye-detail';
const COMPASS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
const MASK_EXT = deck.MaskExtension ? new deck.MaskExtension() : null;

// 船形圖示（俯視、船頭朝上＝朝北），以 mask 方式上色
const SHIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="96" viewBox="0 0 40 96">' +
  '<path d="M20 2C30 16 34 28 34 40V86Q34 94 26 94H14Q6 94 6 86V40C6 28 10 16 20 2Z" fill="#fff"/></svg>';
const SHIP_ICON = {
  atlas: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SHIP_SVG),
  mapping: { ship: { x: 0, y: 0, width: 40, height: 96, anchorY: 48, mask: true } },
};

// 船型圖案：畫在船身中央（深色圖案，保持正立不跟著船頭轉）。順序也是圖例的順序。
// 每個圖案是 (主色, 細節色) => 48×48 的 SVG 片段：主色畫輪廓，細節色畫貨櫃格線、十字等
const CLASS_GLYPH = {
  rescue: ['救援船', (f, d) => // 醫療箱
    `<path d="M18 15v-4h12v4" fill="none" stroke="${f}" stroke-width="3.5"/><rect x="8" y="15" width="32" height="24" rx="4" fill="${f}"/>` +
    `<rect x="21.5" y="18.5" width="5" height="17" fill="${d}"/><rect x="15.5" y="24.5" width="17" height="5" fill="${d}"/>`],
  government: ['公務／執法船', (f, d) => // 警徽
    `<path d="M24 6l14 5v11c0 10-6 16-14 20-8-4-14-10-14-20V11z" fill="${f}"/>` +
    `<path d="M24 15l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9-4.3-4.1 5.9-.8z" fill="${d}"/>`],
  fishing: ['漁船', (f, d) => // 魚
    `<ellipse cx="20" cy="24" rx="14" ry="9" fill="${f}"/><path d="M31 24l12-10v20z" fill="${f}"/><circle cx="13" cy="22" r="2.4" fill="${d}"/>`],
  cargo: ['貨輪', (f, d) => // 貨櫃
    `<rect x="7" y="10" width="34" height="13" fill="${f}"/><rect x="7" y="25" width="34" height="13" fill="${f}"/>` +
    `<path d="M15.5 10v13M24 10v13M32.5 10v13M15.5 25v13M24 25v13M32.5 25v13" stroke="${d}" stroke-width="2"/>`],
  tanker: ['油輪', (f, d) => // 油桶
    `<rect x="12" y="7" width="24" height="34" rx="4" fill="${f}"/><path d="M12 16h24M12 32h24" stroke="${d}" stroke-width="2.8"/>`],
  passenger: ['客船', (f) => // 很多人
    `<circle cx="12" cy="17" r="4.6" fill="${f}"/><circle cx="36" cy="17" r="4.6" fill="${f}"/><circle cx="24" cy="13" r="5.4" fill="${f}"/>` +
    `<path d="M4 36a8 8 0 0 1 16 0zM28 36a8 8 0 0 1 16 0z" fill="${f}"/><path d="M14 39a10 10.5 0 0 1 20 0z" fill="${f}"/>`],
  tug: ['拖船', (f) => // 鉤子
    `<circle cx="25" cy="9" r="4" fill="none" stroke="${f}" stroke-width="3.2"/>` +
    `<path d="M25 13v16a8.5 8.5 0 1 1-14.5-6" fill="none" stroke="${f}" stroke-width="4.5" stroke-linecap="round"/><path d="M6 25l4-7 5 5.6z" fill="${f}"/>`],
  pilot: ['引水船', (f) => // 水滴
    `<path d="M24 5c0 0-12 14-12 22a12 12 0 0 0 24 0c0-8-12-22-12-22z" fill="${f}"/>`],
  service: ['作業船', (f) => // 扳手
    `<path d="M12 37l14-14" stroke="${f}" stroke-width="6" stroke-linecap="round"/>` +
    `<path d="M31 9a8.5 8.5 0 1 0 8 8l-5.2 2-3.3-3.3z" fill="${f}"/>`],
  pleasure: ['遊艇／帆船', (f) => // 酒杯
    `<path d="M13 7h22c0 11-5 17-11 17s-11-6-11-17z" fill="${f}"/><path d="M24 24v12M16 38h16" stroke="${f}" stroke-width="3.5" stroke-linecap="round"/>`],
  other: ['其他船型', (f) => // 其他：三個點（船身裡放不下兩個字）
    `<circle cx="11" cy="24" r="5" fill="${f}"/><circle cx="24" cy="24" r="5" fill="${f}"/><circle cx="37" cy="24" r="5" fill="${f}"/>`],
  unknown: ['未知船型', (f) =>
    `<text x="24" y="38" text-anchor="middle" font-size="40" font-weight="800" fill="${f}" font-family="sans-serif">?</text>`],
};
const GLYPH_KEYS = Object.keys(CLASS_GLYPH);
const GLYPH_INK = '#0b1220', GLYPH_DETAIL = '#ffffff';

function glyphSvg(key, inner) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${inner}</svg>`);
}

function legendGlyphUrl(key) {
  // 圖例：船身色的圓角方塊裡放圖案，和地圖上「船身裡的圖案」同一個樣子
  const hull = key === 'rescue' ? '#ff40a0' : '#2dd4bf';
  return glyphSvg(key, `<rect width="48" height="48" rx="10" fill="${hull}"/>` +
    `<g transform="translate(6 6) scale(0.75)">${CLASS_GLYPH[key][1](GLYPH_INK, GLYPH_DETAIL)}</g>`);
}

const GLYPH_ICON = {
  atlas: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${48 * GLYPH_KEYS.length}" height="48">` +
    GLYPH_KEYS.map((k, i) => `<g transform="translate(${48 * i},0)">${CLASS_GLYPH[k][1](GLYPH_INK, GLYPH_DETAIL)}</g>`).join('') + '</svg>'),
  mapping: Object.fromEntries(GLYPH_KEYS.map((k, i) => [k, { x: 48 * i, y: 0, width: 48, height: 48 }])),
};
const GLYPH_ZOOM = 10; // 拉近到這一級以上，每艘船身裡都畫圖案；拉遠時船太小，只畫救援船與點選中的船
const GLYPH_SHIP_SCALE = 1.35; // 畫圖案時船身放大一點，圖案才看得清楚

const $ = (id) => document.getElementById(id);
const state = {
  t: 0, playing: false, speed: 60, showPred: true, showIdle: true, showCone: true, showPast: true,
  types: new Set(Object.keys(TYPE_LABEL)), simOnly: false, selected: null, focus: null,
  rescue: null, // 救援示範進行中：{ mode: 'hungarian' | 'greedy', animStart }
  highOnly: true, // 警示列表預設只列高優先（模擬情境一律列出），一般警示收起來
  byRisk: false,  // 警示列表依風險分數排序（預設依時間，最新的在上）
  detail: false,  // 船舶卡片：簡易說明／各預測器與權重
};
let D, map, overlay, t0ms, trips = { all: [], moving: [] }, alerts = [], listKey = '', lastFrame = null;
const vesselCache = new Map(); // MMSI → 完整預測（undefined：未載入、'loading'、null：沒有資料）
let focusKey = '';

// ---------- 主題與瀏覽器儲存 ----------

function isLight() {
  return document.body.classList.contains('light');
}

function ui() {
  // 地圖上文字標籤與幾個淺色元素，在淺色主題要換成深色才看得到
  return isLight()
    ? { key: 'l', labelBg: [255, 255, 255, 235], text: [15, 23, 42], cv: [71, 85, 105], sim: [217, 119, 6] }
    : { key: 'd', labelBg: [11, 18, 32, 220], text: [226, 232, 240], cv: [226, 232, 240], sim: COLOR.sim };
}

function methodColor(m) {
  return m === 'cv' ? ui().cv : METHOD_STYLE[m].color;
}

function storeGet(key) {
  // 無痕視窗或封鎖網站資料時 localStorage 會丟例外，當作沒有存過
  try { return localStorage.getItem(key); } catch { return null; }
}

function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 存不了就算了，只是下次再顯示一次 */ }
}

// ---------- 船舶資料 ----------

function vinfo(m) {
  const v = D.vessels?.[m];
  return { name: v?.[0] || null, cls: v?.[1] || null, len: v?.[2] || null, key: v?.[3] || null, byName: !!v?.[4] };
}

function vesselColor(trip, theme) {
  if (trip.sim) return theme.sim;
  if (trip.rescue) return COLOR.rescue; // 救援船不論航行或待命都用桃紅色
  return trip.mv ? COLOR.moving : COLOR.idle;
}

function shipSize(trip) {
  const base = trip.mv || trip.rescue ? 26 : 16;
  return map.getZoom() >= GLYPH_ZOOM ? base * GLYPH_SHIP_SCALE : base;
}

function esc(s) {
  // 船名來自資料檔，放進 HTML 前先跳脫
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function vesselName(m) {
  return vinfo(m).name || `MMSI ${m}`;
}

function vesselDesc(m) {
  const v = vinfo(m);
  return [v.cls && (v.byName ? `${v.cls}（依船名判定）` : v.cls), v.len ? `${v.len} 公尺` : null]
    .filter(Boolean).join('・');
}

function distanceM(p, q) {
  const r = Math.PI / 180, R = 6371000;
  const a = Math.sin(((q[1] - p[1]) * r) / 2) ** 2 +
    Math.cos(p[1] * r) * Math.cos(q[1] * r) * Math.sin(((q[0] - p[0]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- 資料查詢 ----------

function lowerBound(arr, x) {
  // 最後一個 <= x 的索引；全部都大於 x 時回傳 -1
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function bearing(p, q) {
  // 兩點間的方位角（度，正北 0、順時針）；兩點重疊時回傳 null
  const dx = (q[0] - p[0]) * Math.cos((p[1] * Math.PI) / 180), dy = q[1] - p[1];
  if (Math.abs(dx) + Math.abs(dy) < 1e-7) return null;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

function positionAt(trip, t) {
  const ts = trip.t;
  if (t < ts[0] || t > ts[ts.length - 1]) return null;
  const i = lowerBound(ts, t);
  const last = i === ts.length - 1;
  const p = trip.p[i], q = last ? p : trip.p[i + 1];
  const a = last ? 0 : (t - ts[i]) / (ts[i + 1] - ts[i]);
  const sog = trip.s[i];
  // 船頭方向：航行中用 COG；低速時 COG 不可靠，改用航跡方向，都沒有就沿用上一次
  const track = last ? (i > 0 ? bearing(trip.p[i - 1], p) : null) : bearing(p, q);
  const heading = (sog ?? 0) >= 1 && trip.c[i] != null ? trip.c[i] : track ?? trip.c[i] ?? trip.lastHeading ?? 0;
  trip.lastHeading = heading;
  return { pos: [p[0] + a * (q[0] - p[0]), p[1] + a * (q[1] - p[1])], sog, heading };
}

function predictionAt(mmsi, t) {
  // 融合預測各時距的位置與 90% 不確定半徑（公尺）
  const pr = D.preds[mmsi];
  if (!pr) return null;
  const i = lowerBound(pr.t, t);
  if (i < 0 || t - pr.t[i] > PRED_FRESH_S) return null;
  const n = D.meta.horizons.length;
  return { pts: pr.p.slice(i * n, i * n + n), r: pr.r.slice(i * n, i * n + n) };
}

function conePolygon(origin, pts, radii) {
  // 從船的位置沿預測點張開的扇形：每個預測點往兩側展開不確定半徑，末端接半圓
  const kx = Math.cos((origin[1] * Math.PI) / 180) * 111320, ky = 110540;
  const toXY = (p) => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * ky];
  const toLL = (q) => [origin[0] + q[0] / kx, origin[1] + q[1] / ky];
  const P = [[0, 0], ...pts.map(toXY)], R = [0, ...radii];
  const left = [], right = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    left.push([P[i][0] + nx * R[i], P[i][1] + ny * R[i]]);
    right.push([P[i][0] - nx * R[i], P[i][1] - ny * R[i]]);
  }
  const end = P[P.length - 1], r = R[R.length - 1], last = left[left.length - 1];
  const a0 = Math.atan2(last[1] - end[1], last[0] - end[0]);
  const cap = [];
  for (let k = 1; k < 12; k++) {
    const ang = a0 - (Math.PI * k) / 12; // 由左側順時針繞過前方到右側
    cap.push([end[0] + r * Math.cos(ang), end[1] + r * Math.sin(ang)]);
  }
  return [...left, ...cap, ...right.reverse()].map(toLL);
}

function verification(trip, t) {
  // 15 分鐘前發布的融合預測，與船在預測目標時刻的實際位置對照（只用已經發生的事）
  const pr = D.preds[trip.m];
  const j = D.meta.horizons.indexOf(VERIFY_H);
  if (!pr || j < 0) return null;
  const n = D.meta.horizons.length, h = VERIFY_H * 60;
  const i = lowerBound(pr.t, t - h);
  if (i < 0 || t - h - pr.t[i] > 120) return null;
  const predicted = pr.p[i * n + j];
  const actual = predicted && positionAt(trip, pr.t[i] + h);
  if (!actual) return null;
  return { predicted, actual: actual.pos, error: distanceM(predicted, actual.pos), issued: pr.t[i] };
}

function pastPredictions(trip, t) {
  // 「之前的預測」：過去 30 分鐘內每一刻，系統在 15 分鐘前預測船會在哪裡，連成一條線。
  // 和實際航跡（尾巴）對照，兩條線分得越開代表預測越不準。只用已經發生的事：預測目標時刻都 ≤ 現在
  // 另外回傳最近一筆預測與船在那一刻的實際位置（gap），兩點連線就是目前的預測誤差
  const pr = D.preds[trip.m], j = D.meta.horizons.indexOf(VERIFY_H);
  if (!pr || j < 0) return { paths: [], gap: null };
  const n = D.meta.horizons.length, h = VERIFY_H * 60, paths = [];
  let cur = [], prev = null, gap = null;
  for (let i = lowerBound(pr.t, t - h); i >= 0 && pr.t[i] + h >= t - TRAIL_S; i--) {
    const p = pr.p[i * n + j];
    if (p && !gap) {
      const actual = positionAt(trip, pr.t[i] + h);
      if (actual) gap = { predicted: p, actual: actual.pos };
    }
    if (!p || (prev !== null && prev - pr.t[i] > 180)) { // 中間斷掉超過 3 分鐘就分成兩段
      if (cur.length > 1) paths.push({ path: cur });
      cur = [];
    }
    if (p) cur.push(p);
    prev = pr.t[i];
  }
  if (cur.length > 1) paths.push({ path: cur });
  return { paths, gap };
}

function coverageText() {
  const v = Object.values(D.meta.coverage90 || {}).map((c) => c * 100);
  if (!v.length) return '—';
  const lo = Math.min(...v).toFixed(1), hi = Math.max(...v).toFixed(1);
  return lo === hi ? `${lo}%` : `${lo}～${hi}%`;
}

function fullPredictionAt(mmsi, t) {
  // 點選船舶用：融合與四個預測器 × 各時距的位置，以及各時距的 Hedge 權重
  const d = vesselCache.get(mmsi);
  if (!d || d === 'loading') return d;
  const i = lowerBound(d.t, t);
  if (i < 0 || t - d.t[i] > PRED_FRESH_S) return null;
  const n = D.meta.horizons.length, methods = D.meta.methods, nw = D.meta.weight_methods.length;
  return {
    idx: i,
    pts: methods.map((m, k) => ({ m, pts: D.meta.horizons.map((_, j) => d.p[(i * methods.length + k) * n + j]) })),
    w: D.meta.horizons.map((_, j) => d.w.slice((i * n + j) * nw, (i * n + j) * nw + nw)),
  };
}

async function loadVessel(mmsi) {
  if (vesselCache.has(mmsi)) return;
  // 主資料裡沒有融合預測的船（一直停泊或低速）也不會有預測檔，不必去抓
  if (!D.preds[String(mmsi)]) { vesselCache.set(mmsi, null); return; }
  vesselCache.set(mmsi, 'loading');
  try {
    const r = await fetch(`${DAY_BASE}vessels/${mmsi}.json`, { cache: 'no-cache' }); // 有更新才重新下載
    vesselCache.set(mmsi, r.ok ? await r.json() : null); // 停泊船沒有預測檔
  } catch {
    vesselCache.set(mmsi, null);
  }
}

function visibleAlerts() {
  return alerts.filter((a) => state.types.has(a.type) && (!state.simOnly || a.sim) &&
    (!state.highOnly || a.sev === 'high' || a.sim));
}

function gapsAt(t) {
  // 此刻正在訊號中斷中的船（最後位置、原因）
  return (D.gaps || []).filter((g) => g.ts < t &&
    t < (g.te ?? g.ts + (g.k === 'edge' ? GHOST_EDGE_S : GHOST_MAX_S)));
}

function gapText(g, t) {
  // 訊號中斷的原因說明；重播時只說「當下已知」的事，恢復時間要等恢復後才顯示
  const min = Math.floor((t - g.ts) / 60);
  const back = g.te != null && t >= g.te ? `，${clock(g.te)} 恢復` : '';
  if (g.k === 'outage')
    return `訊號中斷 ${min} 分鐘：前後 3 分鐘內另有 ${g.n} 艘船一起失聯，研判是岸基接收站斷訊，不是船關閉 AIS${back}`;
  if (g.k === 'alert') return `訊號中斷 ${min} 分鐘：滿 60 分鐘已發出「疑似關閉 AIS」警示${back}`;
  if (g.k === 'edge') return `訊號中斷 ${min} 分鐘：最後位置靠近資料範圍邊緣，多半是駛出範圍`;
  if (g.k === 'short') return `訊號中斷 ${min} 分鐘（未滿 60 分鐘，不發警示）${back}`;
  return `訊號中斷 ${min} 分鐘，之後沒有再收到回報`;
}

// ---------- 文字格式 ----------

function clock(t) {
  const d = new Date(t0ms + t * 1000);
  return d.toISOString().slice(11, 16);
}

function context(a) {
  // 船型與位置：說明為什麼是高優先（外海的漁船、貨輪、油輪）或一般
  const d = a.d;
  if (!d.vessel_class) return '';
  return `${d.vessel_class}・${d.near_port ? '港區／錨地' : '外海'}｜`;
}

function describe(a, t = state.t) {
  // 重播時只顯示「當下已知」的資訊：中斷總長與期間他船回報數，要等訊號恢復才知道
  const d = a.d;
  if (a.type === 'deviation')
    return context(a) + `偏離預期航程 ${Math.round(d.peak_ratio * 100)}%（門檻 ${Math.round(d.threshold_ratio * 100)}%），三種預測器都未預期此航向改變`;
  const outage = d.receiver_outage ? `；同一時間另有 ${d.silent_together} 艘船一起失聯，較可能是接收站斷訊` : '';
  if (a.type === 'ais_gap' && t < a.te)
    return context(a) + `訊號已中斷 ${Math.floor((t - a.ts) / 60)} 分鐘（持續中）${outage}`;
  if (a.type === 'ais_gap' && d.resumed === false)
    return context(a) + `訊號中斷後直到資料結束都沒有再回報（${Math.round(d.gap_min)} 分鐘）${outage}`;
  if (a.type === 'ais_gap')
    return context(a) + `訊號中斷 ${Math.round(d.gap_min)} 分鐘後恢復；中斷期間附近 ${d.neighbor_reports} 筆他船回報` +
      (d.likely_intentional ? '，該處有訊號涵蓋，疑似刻意關閉' : '') + outage;
  if (a.type === 'loiter') return `於「${d.zone}」低速停留 ${Math.round(d.duration_min)} 分鐘`;
  return '';
}

function pendingText(a, t) {
  // 事件已開始、尚未達到判定條件時的倒數說明（錄影時讓觀眾知道系統正在等什麼）
  const elapsed = Math.floor((t - a.ts) / 60), need = Math.round((a.td - a.ts) / 60);
  if (a.type === 'ais_gap') return `訊號中斷 ${elapsed} 分鐘｜滿 ${need} 分鐘判定`;
  if (a.type === 'loiter') return `低速停留 ${elapsed} 分鐘｜滿 ${need} 分鐘判定`;
  return '偏離預測中｜連續 3 筆超過門檻即判定';
}

// ---------- 圖層 ----------

let seaMaskCache = null;
function seaMask() {
  // 一個大外框（資料範圍再往外 3 度），陸地外環當成洞
  if (!seaMaskCache) {
    const [x0, y0, x1, y1] = D.meta.bounds, m = 3;
    const outer = [[x0 - m, y0 - m], [x1 + m, y0 - m], [x1 + m, y1 + m], [x0 - m, y1 + m], [x0 - m, y0 - m]];
    // 重複的洞會讓三角化失敗、整片遮罩失效（舊版匯出的資料可能有重複的小島）
    const seen = new Set();
    const holes = (D.land || []).filter((r) => { const k = JSON.stringify(r); return !seen.has(k) && seen.add(k); });
    seaMaskCache = holes.length ? [{ polygon: [outer, ...holes] }] : [];
  }
  return seaMaskCache;
}

let zoneCache = null;
function zoneData() {
  // 每個外環一筆；標籤放在海域檔指定的位置，沒指定就放頂點的平均位置
  if (!zoneCache)
    zoneCache = (D.zones || []).flatMap((z) => z.rings.map((ring) => {
      const pts = ring.slice(0, -1);
      return { name: z.name, polygon: ring, center: z.label_at ||
        [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] };
    }));
  return zoneCache;
}

function layers() {
  const t = state.t;
  const tripData = state.showIdle ? trips.all : trips.moving;
  const vessels = [];
  for (const trip of tripData) {
    const at = positionAt(trip, t);
    if (at) vessels.push({ trip, ...at });
  }
  updateKpis(vessels);
  const rescueVessels = vessels.filter((v) => v.trip.rescue);
  const glyphOn = map.getZoom() >= GLYPH_ZOOM;
  const badged = glyphOn ? vessels
    : vessels.filter((v) => v.trip.rescue || v.trip.m === state.focus);

  // 點選中的船：畫融合與四個預測器的預測，並更新資訊卡
  const focusVessel = state.focus ? vessels.find((v) => v.trip.m === state.focus) : null;
  const full = focusVessel ? fullPredictionAt(state.focus, t) : null;
  const verify = focusVessel && focusVessel.trip.mv ? verification(focusVessel.trip, t) : null;
  updateFocusCard(focusVessel, full, verify);
  const theme = ui();
  const methodLines = [], methodDots = [], methodLabels = [];
  if (focusVessel && state.detail && full && full !== 'loading') {
    for (const { m, pts } of full.pts) {
      const ok = pts.filter(Boolean);
      if (!ok.length) continue;
      methodLines.push({ m, path: [focusVessel.pos, ...ok] });
      ok.forEach((p, k) => methodDots.push({ m, pos: p, k }));
      methodLabels.push({ m, pos: ok[ok.length - 1] });
    }
  }

  const rescue = rescueLayers();
  // 之前的預測軌跡：航行中的船（點選中的船一定畫），救援示範時收起來
  const pastAll = state.showPast && !state.rescue
    ? vessels.filter((v) => v.trip.mv || v === focusVessel).map((v) => pastPredictions(v.trip, t)) : [];
  const past = pastAll.flatMap((x) => x.paths), pastGaps = pastAll.map((x) => x.gap).filter(Boolean);
  const predLines = [], predDots = [], cones = [];
  // 拉遠時每艘船都畫扇形會糊成一片，只畫點選中的船；拉近到 9.5 級以上才全部畫
  const conesForAll = state.showCone && map.getZoom() >= 9.5;
  for (const v of vessels) {
    // 救援示範時先收起預測，畫面只留航線；整段多半低速的船只在點選時畫
    if ((!v.trip.mv && v !== focusVessel) || state.rescue) continue;
    const pr = (state.showPred || (state.showCone && v === focusVessel)) && predictionAt(v.trip.m, t);
    if (!pr) continue;
    const ok = pr.pts.map((p, k) => p && pr.r[k] != null && { pos: p, k, r: pr.r[k] }).filter(Boolean);
    if (!ok.length) continue;
    if (state.showCone && (conesForAll || v === focusVessel))
      cones.push({ polygon: conePolygon(v.pos, ok.map((d) => d.pos), ok.map((d) => d.r)), focus: v === focusVessel });
    // 點選中的船在詳細模式另外畫各預測器；簡易模式照常只畫融合
    if (!state.showPred || (v === focusVessel && state.detail)) continue;
    predLines.push({ path: [v.pos, ...ok.map((d) => d.pos)], sim: v.trip.sim });
    predDots.push(...ok);
  }

  // 訊號中斷中的船：停泊船隱藏時，只留中斷前在航行的（匯出時已只收航行中的中斷）
  const ghosts = state.rescue ? [] : gapsAt(t);
  const ghostLabels = map.getZoom() >= 9 ? ghosts : ghosts.filter((g) => g.m === state.focus);

  const pulse = (Math.sin(performance.now() / 260) + 1) / 2;
  const active = state.rescue ? [] : visibleAlerts().filter((a) => a.td <= t && t <= a.td + ACTIVE_S);
  const simLabels = active.filter((a) => a.sim);
  const s = state.selected;
  const sel = s && s.td <= t && t <= s.td + ACTIVE_S ? [s] : []; // 和警示圈一樣只標 1 小時
  const pending = s && s.ts <= t && t < s.td ? [s] : [];

  return [
    // 滯留偵測的指定海域（示範用的假設範圍），畫在最底層
    new deck.PolygonLayer({
      id: 'zones', data: zoneData(), getPolygon: (d) => d.polygon,
      getFillColor: [...COLOR.loiter, 28], getLineColor: [...COLOR.loiter, 200], lineWidthMinPixels: 1.5,
    }),
    new deck.TextLayer({
      id: 'zone-labels', data: zoneData(), getPosition: (d) => d.center,
      getText: (d) => `${d.name}
示範用，非真實位置`, getColor: COLOR.loiter, getSize: 12,
      fontFamily: CJK_FONT, fontWeight: 700, characterSet: 'auto', lineHeight: 1.3,
      background: true, getBackgroundColor: theme.labelBg, backgroundPadding: [5, 2],
      updateTriggers: { getBackgroundColor: theme.key },
    }),
    new deck.TripsLayer({
      id: 'trails', data: tripData, currentTime: t, trailLength: TRAIL_S, fadeTrail: true,
      getPath: (d) => d.p, getTimestamps: (d) => d.t,
      getColor: (d) => vesselColor(d, theme),
      widthMinPixels: 2, opacity: 0.75, capRounded: true, jointRounded: true,
      updateTriggers: { getColor: theme.key },
    }),
    new deck.PathLayer({
      id: 'past-predictions', data: past, getPath: (d) => d.path,
      getColor: [...COLOR.pred, 210], widthMinPixels: 2, jointRounded: true, capRounded: true,
      ...(DASH_EXT ? { extensions: [DASH_EXT], getDashArray: [3, 2], dashJustified: true } : {}),
    }),
    new deck.LineLayer({
      id: 'past-gaps', data: pastGaps, getSourcePosition: (d) => d.predicted, getTargetPosition: (d) => d.actual,
      getColor: [...COLOR.pred, 140], getWidth: 1, widthUnits: 'pixels',
    }),
    // 海面遮罩（範圍外框挖掉陸地）：不確定扇形只畫在海上
    new deck.PolygonLayer({
      id: 'sea-mask', data: seaMask(), getPolygon: (d) => d.polygon, operation: 'mask',
    }),
    new deck.PolygonLayer({
      id: 'cones', data: cones, getPolygon: (d) => d.polygon,
      ...(MASK_EXT && D.land?.length ? { extensions: [MASK_EXT], maskId: 'sea-mask' } : {}),
      getFillColor: (d) => [...COLOR.pred, d.focus ? 55 : 30],
      getLineColor: (d) => [...COLOR.pred, d.focus ? 160 : 70], lineWidthMinPixels: 1,
    }),
    new deck.PathLayer({
      id: 'pred-lines', data: predLines, getPath: (d) => d.path,
      getColor: [...COLOR.pred, 150], widthMinPixels: 1.5,
    }),
    new deck.ScatterplotLayer({
      id: 'pred-dots', data: predDots, getPosition: (d) => d.pos,
      getRadius: (d) => 4 - d.k, radiusUnits: 'pixels', getFillColor: [...COLOR.pred, 220],
    }),
    new deck.PathLayer({
      id: 'method-lines', data: methodLines, getPath: (d) => d.path,
      getColor: (d) => [...methodColor(d.m), d.m === 'fused' ? 255 : 200],
      getWidth: (d) => METHOD_STYLE[d.m].width, widthUnits: 'pixels', jointRounded: true,
      updateTriggers: { getColor: theme.key },
    }),
    new deck.ScatterplotLayer({
      id: 'method-dots', data: methodDots, getPosition: (d) => d.pos,
      getRadius: (d) => (d.m === 'fused' ? 5 : 3.5) - d.k * 0.5, radiusUnits: 'pixels',
      getFillColor: (d) => methodColor(d.m), updateTriggers: { getFillColor: theme.key },
    }),
    // 預測 vs. 實際：15 分鐘前的預測點（空心圈）連到船當時的實際位置
    new deck.LineLayer({
      id: 'verify-line', data: verify ? [verify] : [], getSourcePosition: (d) => d.predicted,
      getTargetPosition: (d) => d.actual, getColor: [...theme.text, 220], getWidth: 2, widthUnits: 'pixels',
      updateTriggers: { getColor: theme.key },
    }),
    new deck.ScatterplotLayer({
      id: 'verify-point', data: verify ? [verify] : [], getPosition: (d) => d.predicted,
      getRadius: 7, radiusUnits: 'pixels', stroked: true, filled: false,
      getLineColor: [...theme.text, 240], lineWidthMinPixels: 2, updateTriggers: { getLineColor: theme.key },
    }),
    new deck.TextLayer({
      id: 'verify-label', data: verify ? [verify] : [], getPosition: (d) => d.predicted,
      getText: (d) => `${VERIFY_H} 分鐘前的預測｜誤差 ${Math.round(d.error)} 公尺`,
      getColor: theme.text, getSize: 12, getPixelOffset: [0, 20], fontFamily: CJK_FONT, fontWeight: 600,
      characterSet: 'auto', background: true, getBackgroundColor: theme.labelBg, backgroundPadding: [5, 2],
      updateTriggers: { getText: verify && Math.round(verify.error), getColor: theme.key, getBackgroundColor: theme.key },
    }),
    // 訊號中斷：最後位置的淡色船影（沒有外框，和正常回報的船區分）
    new deck.IconLayer({
      id: 'ghosts', data: ghosts, pickable: true, iconAtlas: SHIP_ICON.atlas, iconMapping: SHIP_ICON.mapping,
      getIcon: () => 'ship', getPosition: (d) => [d.lon, d.lat], getAngle: (d) => -(d.c ?? 0),
      getSize: 24, sizeScale: shipScale(), getColor: (d) => [...GHOST_COLOR[d.k], 120 + 60 * pulse],
      updateTriggers: { getColor: pulse },
    }),
    new deck.TextLayer({
      id: 'ghost-labels', data: ghostLabels, getPosition: (d) => [d.lon, d.lat],
      getText: (d) => `失聯 ${Math.floor((t - d.ts) / 60)} 分` + (d.k === 'outage' ? '・接收站斷訊' : ''),
      getColor: theme.text, getSize: 11, getPixelOffset: [0, 22], fontFamily: CJK_FONT, fontWeight: 600,
      characterSet: 'auto', background: true, getBackgroundColor: theme.labelBg, backgroundPadding: [4, 2],
      updateTriggers: { getText: Math.floor(t / 60), getColor: theme.key, getBackgroundColor: theme.key },
    }),
    // 船身外框：同一個圖示放大一點、塗深色，墊在底下
    new deck.IconLayer({
      id: 'vessel-outline', data: vessels, iconAtlas: SHIP_ICON.atlas, iconMapping: SHIP_ICON.mapping,
      getIcon: () => 'ship', getPosition: (d) => d.pos, getAngle: (d) => -d.heading,
      getSize: (d) => shipSize(d.trip) + 3, sizeScale: shipScale(), getColor: [11, 18, 32, 230],
      updateTriggers: { getSize: glyphOn },
    }),
    // 救援船：船身外加一圈桃紅色外圈與「救援」標籤，拉遠時也找得到
    new deck.ScatterplotLayer({
      id: 'rescue-halo', data: rescueVessels, getPosition: (d) => d.pos,
      getRadius: 15, radiusUnits: 'pixels', stroked: true, filled: true,
      getFillColor: [...COLOR.rescue, 40], getLineColor: [...COLOR.rescue, 230], lineWidthMinPixels: 2,
    }),
    new deck.TextLayer({
      id: 'rescue-labels', data: rescueVessels, getPosition: (d) => d.pos, getText: () => '救援',
      getColor: COLOR.rescue, getSize: 11, getPixelOffset: [-14, -24], fontFamily: CJK_FONT, fontWeight: 700,
      characterSet: 'auto', background: true, getBackgroundColor: theme.labelBg, backgroundPadding: [4, 1],
      updateTriggers: { getBackgroundColor: theme.key },
    }),
    new deck.IconLayer({
      id: 'vessels', data: vessels, pickable: true, iconAtlas: SHIP_ICON.atlas, iconMapping: SHIP_ICON.mapping,
      getIcon: () => 'ship', getPosition: (d) => d.pos, getAngle: (d) => -d.heading,
      getSize: (d) => shipSize(d.trip), sizeScale: shipScale(),
      getColor: (d) => vesselColor(d.trip, theme),
      updateTriggers: { getColor: theme.key, getSize: glyphOn },
    }),
    new deck.IconLayer({
      // 船型圖案疊在船身中央：寬度約等於船身寬，保持正立
      id: 'class-glyphs', data: badged, iconAtlas: GLYPH_ICON.atlas, iconMapping: GLYPH_ICON.mapping,
      getIcon: (d) => d.trip.cls, getPosition: (d) => d.pos, getSize: (d) => shipSize(d.trip) * 0.42,
      sizeScale: shipScale(), updateTriggers: { getSize: glyphOn },
    }),
    new deck.ScatterplotLayer({
      id: 'focus-ring', data: focusVessel ? [focusVessel] : [], getPosition: (d) => d.pos,
      getRadius: 22, radiusUnits: 'pixels', stroked: true, filled: false,
      getLineColor: [...theme.text, 220], lineWidthMinPixels: 2, updateTriggers: { getLineColor: theme.key },
    }),
    // 四條線的終點常常很接近，標籤依方法順序上下錯開，避免疊在一起
    new deck.TextLayer({
      id: 'method-labels', data: methodLabels, getPosition: (d) => d.pos,
      getText: (d) => METHOD_STYLE[d.m].label, getColor: (d) => methodColor(d.m), getSize: 13,
      getTextAnchor: 'start', getAlignmentBaseline: 'center',
      getPixelOffset: (d) => [12, (D.meta.methods.indexOf(d.m) - (D.meta.methods.length - 1) / 2) * 18],
      fontFamily: CJK_FONT, fontWeight: 700, characterSet: 'auto',
      background: true, getBackgroundColor: theme.labelBg, backgroundPadding: [4, 2],
      updateTriggers: { getColor: theme.key, getBackgroundColor: theme.key },
    }),
    new deck.ScatterplotLayer({
      id: 'alert-rings', data: active, pickable: true, getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 14 + 10 * pulse + (d === state.selected ? 8 : 0), radiusUnits: 'pixels',
      stroked: true, filled: true, getFillColor: (d) => [...COLOR[d.type], 40],
      getLineColor: (d) => COLOR[d.type], lineWidthMinPixels: 2.5,
      updateTriggers: { getRadius: [pulse, state.selected] },
    }),
    new deck.ScatterplotLayer({
      id: 'pending-ring', data: pending, getPosition: (d) => [d.lon, d.lat],
      getRadius: 20, radiusUnits: 'pixels', stroked: true, filled: false,
      getLineColor: (d) => [...COLOR[d.type], 140 + 100 * pulse], lineWidthMinPixels: 2,
      updateTriggers: { getLineColor: pulse },
    }),
    new deck.TextLayer({
      id: 'pending-label', data: pending, getPosition: (d) => [d.lon, d.lat],
      getText: (d) => pendingText(d, t), getColor: theme.text, getSize: 14,
      getPixelOffset: [0, 38], fontFamily: CJK_FONT, fontWeight: 600, characterSet: 'auto',
      background: true, getBackgroundColor: theme.labelBg, backgroundPadding: [6, 3],
      updateTriggers: { getText: Math.floor(t / 60), getColor: theme.key, getBackgroundColor: theme.key },
    }),
    new deck.TextLayer({
      id: 'alert-labels', data: [...new Set([...simLabels, ...sel])],
      getPosition: (d) => [d.lon, d.lat],
      getText: (d) => (d.sim ? `模擬情境｜${TYPE_LABEL[d.type]}` : TYPE_LABEL[d.type]),
      getColor: (d) => (d.sim ? theme.sim : COLOR[d.type]), getSize: 15,
      getPixelOffset: [0, -34], fontFamily: CJK_FONT, fontWeight: 700, characterSet: 'auto',
      background: true, getBackgroundColor: theme.labelBg, backgroundPadding: [6, 3],
      updateTriggers: { getColor: theme.key, getBackgroundColor: theme.key },
    }),
    new deck.PathLayer({
      id: 'rescue-routes', data: rescue.routes, getPath: (d) => d.path,
      getColor: (d) => [...d.color, 230], getWidth: 4, widthUnits: 'pixels', jointRounded: true, capRounded: true,
    }),
    new deck.ScatterplotLayer({
      id: 'rescue-responders', data: rescue.responders, getPosition: (d) => d.pos,
      getRadius: 13, radiusUnits: 'pixels', stroked: true, filled: false,
      getLineColor: [...theme.text, 160], lineWidthMinPixels: 1.5, updateTriggers: { getLineColor: theme.key },
    }),
    new deck.ScatterplotLayer({
      id: 'rescue-distress', data: rescue.distress, getPosition: (d) => d.pos,
      getRadius: 10 + 8 * pulse, radiusUnits: 'pixels', stroked: true, getFillColor: (d) => [...d.color, 90],
      getLineColor: (d) => d.color, lineWidthMinPixels: 3, updateTriggers: { getRadius: pulse },
    }),
    new deck.ScatterplotLayer({
      id: 'rescue-dots', data: rescue.dots, getPosition: (d) => d.pos,
      getRadius: 7, radiusUnits: 'pixels', stroked: true, getFillColor: (d) => d.color,
      getLineColor: [255, 255, 255], lineWidthMinPixels: 2,
    }),
    new deck.TextLayer({
      id: 'rescue-labels', data: rescue.labels, getPosition: (d) => d.pos, getText: (d) => d.text,
      getColor: (d) => d.color, getSize: 14, getPixelOffset: (d) => d.offset || [0, 0],
      fontFamily: CJK_FONT, fontWeight: 700, characterSet: 'auto',
      background: true, getBackgroundColor: theme.labelBg, backgroundPadding: [5, 2],
      updateTriggers: { getBackgroundColor: theme.key },
    }),
  ];
}

// ---------- 救援調度示範 ----------

function alongPath(path, frac) {
  // 沿折線走到總長的 frac 處（短距離用平面近似即可）
  const seg = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const k = Math.cos((path[i][1] * Math.PI) / 180);
    const d = Math.hypot((path[i][0] - path[i - 1][0]) * k, path[i][1] - path[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let target = frac * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const a = seg[i] ? Math.min(1, target / seg[i]) : 1;
      return [path[i][0] + a * (path[i + 1][0] - path[i][0]), path[i][1] + a * (path[i + 1][1] - path[i][1])];
    }
    target -= seg[i];
  }
  return path[path.length - 1];
}

// 「也派待命救援船」用另一個展示情境（附近有待命救援船的時間與海域），其餘兩種模式用同一個
function rescueScene(mode) {
  return mode === 'standby' ? D.rescue?.showcase_rescue : D.rescue?.showcase;
}

function rescuePlan(R, mode) {
  return mode === 'standby' ? R.with_rescue.hungarian : R[mode];
}

function rescueResponders(R, mode) {
  return mode === 'standby' ? [...R.responders, ...R.with_rescue.standby] : R.responders;
}

function rescueLayers() {
  const empty = { routes: [], responders: [], distress: [], dots: [], labels: [] };
  const R = state.rescue && rescueScene(state.rescue.mode);
  if (!R) return empty;
  const plan = rescuePlan(R, state.rescue.mode);
  const maxMin = Math.max(...plan.assignments.map((a) => a.minutes));
  const f = Math.min(1, (performance.now() - state.rescue.animStart) / 1000 / RESCUE_ANIM_S);
  const out = { ...empty, responders: rescueResponders(R, state.rescue.mode).map((r) => ({ pos: [r.lon, r.lat] })) };
  for (const a of plan.assignments) {
    const color = RESCUE_COLORS[a.distress % RESCUE_COLORS.length];
    out.routes.push({ path: a.path, color });
    out.dots.push({ pos: alongPath(a.path, Math.min(1, (f * maxMin) / a.minutes)), color }); // 依各自航行時間比例前進
    out.labels.push({ pos: a.path[Math.floor(a.path.length / 2)], text: `${Math.round(a.minutes)} 分`, color });
  }
  // 求救點彼此可能很近：標籤往「遠離所有求救點中心」的方向推開，避免疊在一起
  const cx = R.distress.reduce((s, d) => s + d.lon, 0) / R.distress.length;
  const cy = R.distress.reduce((s, d) => s + d.lat, 0) / R.distress.length;
  R.distress.forEach((d, i) => {
    const color = RESCUE_COLORS[i % RESCUE_COLORS.length];
    const dx = (d.lon - cx) * Math.cos((d.lat * Math.PI) / 180), dy = d.lat - cy, n = Math.hypot(dx, dy);
    const offset = n > 1e-6 ? [(30 * dx) / n, (-30 * dy) / n] : [0, -26]; // 螢幕 y 軸向下
    out.distress.push({ pos: [d.lon, d.lat], color });
    out.labels.push({ pos: [d.lon, d.lat], text: `求救 ${i + 1}`, color, offset });
  });
  return out;
}

function startRescue(mode = 'hungarian', instant = false) {
  const R = rescueScene(mode);
  if (!R) return;
  state.selected = null;
  setFocus(null);
  setPlaying(false);
  setTime(R.t);
  state.rescue = { mode, animStart: performance.now() };
  document.body.classList.add('rescue-on');
  $('rescue-btn').classList.add('on');
  const pts = [...R.distress, ...rescueResponders(R, mode)];
  const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: viewPadding(), duration: instant ? 0 : 1500, maxZoom: 11 }); // 從分享連結開啟時直接定位
  renderRescueCard();
  renderAlertList(true);
  updateUrl();
}

function stopRescue() {
  if (!state.rescue) return;
  state.rescue = null;
  document.body.classList.remove('rescue-on');
  $('rescue-btn').classList.remove('on');
  $('rescue').classList.add('hidden');
  updateUrl();
}

function setRescueMode(mode) {
  if (rescueScene(mode) !== rescueScene(state.rescue.mode)) { startRescue(mode); return; } // 換情境：時間與地圖範圍都要換
  state.rescue.mode = mode;
  state.rescue.animStart = performance.now();
  renderRescueCard();
}

function renderRescueCard() {
  const S = D.rescue.summary, m = state.rescue.mode, R = rescueScene(m);
  const h = R.hungarian, g = R.greedy, cur = rescuePlan(R, m), W = S.with_rescue;
  const less = (a, b) => Math.round((1 - a / b) * 100);
  let html = '<div class="f-head"><span>救援調度示範<span class="badge sim">模擬情境</span></span>' +
    '<button id="r-close" title="結束示範（Esc）">✕</button></div>';
  html += m === 'standby'
    ? `<div class="f-sub">${clock(R.t)}，另一個情境：${R.distress.length} 艘船同時求救（假設情境）；除了附近 ` +
      `${R.responders.length} 艘正在航行的船，再加上 50 公里內 ${R.with_rescue.standby.length} 艘待命的救援船（白圈）。</div>`
    : `<div class="f-sub">${clock(R.t)}，同一海域 ${R.distress.length} 艘船同時求救（假設情境）；` +
      `附近 ${R.responders.length} 艘正在航行的船可以支援（白圈）。</div>`;
  html += '<div class="r-modes">' +
    `<button data-m="hungarian" class="${m === 'hungarian' ? 'on' : ''}">最佳指派（Hungarian）</button>` +
    `<button data-m="greedy" class="${m === 'greedy' ? 'on' : ''}">最近的船先去</button>` +
    (D.rescue.showcase_rescue ? `<button data-m="standby" class="${m === 'standby' ? 'on' : ''}">也派待命救援船</button>` : '') +
    '</div>';
  html += '<table class="f-weights"><tr><th>求救點</th><th>派遣船</th><th>航程</th><th>抵達</th></tr>' +
    cur.assignments.map((a) => {
      const c = RESCUE_COLORS[a.distress % RESCUE_COLORS.length];
      return `<tr><td><i class="rdot" style="background:rgb(${c})"></i>求救 ${a.distress + 1}</td>` +
        `<td>${esc(vesselName(a.responder))}${vinfo(a.responder).key === 'rescue' ? '<span class="badge rescue">救援船</span>' : ''}</td>` +
        `<td>${a.km.toFixed(1)} km</td><td>${Math.round(a.minutes)} 分</td></tr>`;
    }).join('') + '</table>';
  if (m === 'standby') {
    html += '<div class="r-compare">' +
      `<div>總抵達時間：也派救援船 <b>${Math.round(cur.total_min)}</b> 分，只派航行中的船 <b>${Math.round(h.total_min)}</b> 分` +
      `（少 ${less(cur.total_min, h.total_min)}%）</div>` +
      `<div>最晚抵達：<b>${Math.round(cur.max_min)}</b> 分 對 <b>${Math.round(h.max_min)}</b> 分</div></div>`;
    html += `<p class="note">救援船不論當下航速都可出動，出動航速假設為 ${W.speed_kn} 節（實際依船而異）；兩者都用最佳指派。` +
      `全天有 ${W.scenarios} 個情境附近有待命救援船，平均總抵達時間 ${W.total_min_without} → ${W.total_min} 分` +
      `（少 ${W.total_saving_pct}%），${Math.round(W.rescue_assignment_share * 100)}% 的派遣由救援船擔任。</p>`;
  } else {
    html += '<div class="r-compare">' +
      `<div>總抵達時間：最佳指派 <b>${Math.round(h.total_min)}</b> 分，最近的船先去 <b>${Math.round(g.total_min)}</b> 分` +
      `（少 ${less(h.total_min, g.total_min)}%）</div>` +
      `<div>最晚抵達：<b>${Math.round(h.max_min)}</b> 分 對 <b>${Math.round(g.max_min)}</b> 分</div></div>`;
    html += '<p class="note">航線是海陸網格上的最短路徑（Dijkstra，避開陸地與島嶼），航速取各船當下航速（8～20 節）。' +
      `全天 ${S.scenarios} 個模擬情境中，最佳指派平均省 ${S.total_saving_pct}% 總抵達時間，` +
      `${Math.round(S.improved_share * 100)}% 的情境有改善；但有 ${Math.round(S.max_worse_share * 100)}% 的情境，` +
      '最晚抵達的船反而較慢，這是只最佳化總時間的取捨。</p>';
  }
  html += '<div class="r-actions"><button id="r-replay">▶ 重播出發動畫</button></div>';
  const card = $('rescue');
  card.innerHTML = html;
  card.classList.remove('hidden');
  $('r-close').onclick = stopRescue;
  $('r-replay').onclick = () => setRescueMode(state.rescue.mode);
  card.querySelectorAll('.r-modes button').forEach((b) => (b.onclick = () => setRescueMode(b.dataset.m)));
}

// ---------- 介面 ----------

function updateKpis(vessels) {
  const t = state.t;
  const vis = visibleAlerts();
  $('kpi-moving').textContent = vessels.filter((v) => v.trip.mv && (v.sog ?? 0) >= 3).length;
  $('kpi-active').textContent = vis.filter((a) => a.td <= t && t <= a.td + ACTIVE_S).length;
  $('kpi-total').textContent = vis.filter((a) => a.td <= t).length;
}

function shipScale() {
  // 拉近時船畫大一點，拉遠時縮小，避免整片海擠滿圖示
  return Math.min(1.8, Math.max(0.55, (map.getZoom() - 5.5) / 4));
}

function setFocus(mmsi) {
  state.focus = mmsi;
  focusKey = '';
  document.body.classList.toggle('has-focus', !!mmsi);
  if (mmsi) loadVessel(mmsi);
}

function weightChart(d, t) {
  // 15 分鐘時距的各預測器權重，近 2 小時的變化（船一轉彎，CTR 的權重就會升上來）
  const n = D.meta.horizons.length, nw = D.meta.weight_methods.length;
  const j = Math.max(0, D.meta.horizons.indexOf(15));
  const span = 7200, i1 = lowerBound(d.t, t), i0 = Math.max(0, lowerBound(d.t, t - span));
  if (i1 - i0 < 2) return '';
  const W = 300, H = 70;
  const x = (tt) => (((tt - (t - span)) / span) * W).toFixed(1);
  const y = (w) => (H - 4 - w * (H - 8)).toFixed(1);
  const lines = D.meta.weight_methods.map((m, q) => {
    const pts = [];
    for (let i = i0; i <= i1; i++) {
      const w = d.w[(i * n + j) * nw + q];
      if (w != null) pts.push(`${x(d.t[i])},${y(w)}`);
    }
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="rgb(${methodColor(m)})" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  return `<h3>15 分鐘時距的權重變化（近 2 小時）</h3>` +
    `<svg class="wchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<line x1="0" x2="${W}" y1="${y(0.5)}" y2="${y(0.5)}" class="grid"/>${lines}</svg>` +
    `<div class="wchart-axis"><span>${clock(Math.max(0, t - span))}</span><span>50%</span><span>${clock(t)}</span></div>`;
}

function updateFocusCard(v, full, verify) {
  const card = $('focus');
  if (!state.focus) { card.classList.add('hidden'); focusKey = ''; return; }
  const status = full === undefined || full === 'loading' ? 'l' : full ? full.idx : 'n';
  const key = `${state.focus}|${v ? 1 : 0}|${status}|${Math.floor(state.t / 15)}|${ui().key}|${state.detail}`;
  if (key === focusKey) return;
  focusKey = key;
  card.classList.remove('hidden');

  const trip = trips.all.find((d) => d.m === state.focus);
  const desc = vesselDesc(state.focus);
  const gap = v ? null : gapsAt(state.t).find((g) => g.m === state.focus);
  let html = `<div class="f-head"><span>${esc(vesselName(state.focus))}` +
    (trip && trip.sim ? '<span class="badge sim">模擬注入</span>' : '') +
    '</span><button id="f-close" title="關閉（Esc）">✕</button></div>';
  html += `<div class="f-sub">${desc ? esc(desc) + ' · ' : ''}MMSI ${state.focus}</div>`;
  html += `<div class="f-sub">${v ? `航速 ${v.sog ?? '—'} 節 · 航向 ${Math.round(v.heading)}°` : gap ? '此刻沒有回報（訊號中斷中）' : '此刻沒有回報（尚未出現或已離開）'}</div>`;
  if (gap) html += `<div class="f-verify">${esc(gapText(gap, state.t))}</div>`;
  if (verify)
    html += `<div class="f-verify">${VERIFY_H} 分鐘前的預測，與船實際到達位置相差 <b>${Math.round(verify.error)} 公尺</b>（地圖上的空心圈與連線）</div>`;

  if (v && !state.detail) {
    html += plainSummary(v);
    if (full && full !== 'loading')
      html += '<button id="f-detail" class="link-btn f-toggle">看詳細：各預測器與 Hedge 權重 ▸</button>';
  } else if (v && full && full !== 'loading') {
    html += '<button id="f-detail" class="link-btn f-toggle">◂ 回到簡易說明</button>';
    html += '<div class="f-legend">' + D.meta.methods.map((m) =>
      `<span><i style="background:rgb(${methodColor(m)})"></i>${METHOD_STYLE[m].name}</span>`).join('') + '</div>';
    html += '<h3>Hedge 權重（依各預測器最近的誤差即時調整）</h3><table class="f-weights"><tr><th>時距</th>' +
      D.meta.weight_methods.map((m) => `<th style="color:rgb(${methodColor(m)})">${METHOD_STYLE[m].label}</th>`).join('') + '</tr>';
    D.meta.horizons.forEach((h, j) => {
      html += `<tr><td>${h} 分</td>` + full.w[j].map((w, q) => {
        if (w == null) return '<td class="muted">—</td>';
        const c = methodColor(D.meta.weight_methods[q]);
        return `<td><div class="wbar"><i style="width:${w * 100}%;background:rgb(${c})"></i></div>${Math.round(w * 100)}%</td>`;
      }).join('') + '</tr>';
    });
    html += '</table>' + weightChart(vesselCache.get(state.focus), state.t);
    html += `<p class="note">藍色的融合預測＝${nMethods()}個預測器依上表權重加權平均，是系統最終採用的結果。` +
      `淡藍扇形是依這艘船過去誤差估計的 90% 範圍（實測涵蓋率 ${coverageText()}${D.meta.coverage_note ? '，' + D.meta.coverage_note : ''}）。偏航判定則看 CV、CTR、NLMS 三者中最接近實際位置的那一個。</p>`;
  } else if (v) {
    html += `<p class="note">${full === null ? '此刻沒有預測：航速低於 3 節，或剛開始回報、尚未累積足夠資料。' : '載入預測中…'}</p>`;
  }
  card.innerHTML = html;
  $('f-close').onclick = () => { state.selected = null; setFocus(null); updateUrl(); };
  if ($('f-detail')) $('f-detail').onclick = () => { state.detail = !state.detail; storeSet(DETAIL_KEY, state.detail ? '1' : '0'); };
}

function nMethods() {
  return '零一二三四五六七'[D.meta.weight_methods.length] || String(D.meta.weight_methods.length);
}

function plainSummary(v) {
  // 簡易模式：用三句話說明這艘船接下來會在哪、可能差多少、現在有沒有異常
  const rows = [];
  const pr = predictionAt(v.trip.m, state.t);
  const j = D.meta.horizons.indexOf(VERIFY_H);
  const p = pr && j >= 0 ? pr.pts[j] : null;
  if (p) {
    const km = distanceM(v.pos, p) / 1000, dir = COMPASS[Math.round((bearing(v.pos, p) ?? 0) / 45) % 8];
    rows.push(`<b>${VERIFY_H} 分鐘後</b>預計往${dir}約 ${km.toFixed(1)} 公里（藍點）`);
    if (pr.r[j] != null) rows.push(`<b>可能誤差</b>約 ${Math.round(pr.r[j]).toLocaleString('en-US')} 公尺內（90% 的機率落在淡藍扇形裡）`);
  } else if (pr && pr.pts[0]) {
    rows.push(`<b>${VERIFY_H} 分鐘後</b>預測路線會碰到陸地，之後的預測已取消（船勢必轉向或進港）`);
  } else {
    rows.push('<b>預測</b>此刻沒有：航速低於 3 節，或剛開始回報、尚未累積足夠資料');
  }
  const t = state.t;
  const on = alerts.filter((a) => a.m === v.trip.m && a.td <= t && t <= a.td + ACTIVE_S);
  rows.push(on.length
    ? `<b>目前狀態</b><span class="warn">${on.map((a) => `${TYPE_LABEL[a.type]}（${clock(a.td)} 發出${a.sim ? '・模擬情境' : ''}）`).join('、')}</span>`
    : '<b>目前狀態</b>正常航行，沒有警示');
  return `<div class="f-plain">${rows.map((r) => `<div>${r}</div>`).join('')}</div>`;
}

function renderMetrics() {
  const rows = D.metrics.rows;
  const keys = Object.keys(rows[0]).filter((k) => k !== 'FDE'); // FDE 與 30 分鐘欄相同
  const best = Math.min(...rows.map((r) => r.ADE));
  $('metrics').innerHTML =
    '<tr>' + keys.map((k) => `<th>${k}</th>`).join('') + '</tr>' +
    rows.map((r) => `<tr class="${r.ADE === best ? 'best' : ''}">` +
      keys.map((k) => `<td>${typeof r[k] === 'number' ? r[k].toLocaleString('en-US', { maximumFractionDigits: 0 }) : r[k]}</td>`).join('') +
      '</tr>').join('');
  const info = D.metrics.info;
  const cv = rows.find((r) => r['方法'].includes('CV')), fu = rows.find((r) => r.ADE === best);
  const gain = cv && fu ? ((1 - fu.ADE / cv.ADE) * 100).toFixed(1) : null;
  // 預設顯示長條圖（一眼看出融合最短），點「看完整表格」切換
  const maxAde = Math.max(...rows.map((r) => r.ADE));
  // 先用一句白話講結論，再放長條圖
  const last = `${D.meta.horizons[D.meta.horizons.length - 1]} 分鐘`, first = `${D.meta.horizons[0]} 分鐘`;
  const plain = cv && fu && fu[last] != null
    ? `<div class="plain">系統預測船 <b>${last}後</b>的位置，平均差 <b>${(fu[last] / 1000).toFixed(1)} 公里</b>` +
      `（${first}後約 ${Math.round(fu[first]).toLocaleString('en-US')} 公尺）；比「照目前速度直線走」準 <b>${gain}%</b>。</div>`
    : '';
  $('metric-bars').innerHTML = plain + rows.map((r) =>
    `<div class="mbar${r.ADE === best ? ' best' : ''}"><span>${r['方法']}</span>` +
    `<div class="mtrack"><i style="width:${((r.ADE / maxAde) * 100).toFixed(1)}%"></i></div>` +
    `<em>${Math.round(r.ADE).toLocaleString('en-US')}</em></div>`).join('') +
    `<div class="mbar-caption">ADE：5／15／30 分鐘三個時距的平均位移誤差（公尺），越短越好</div>`;
  $('metrics-note').textContent =
    `${info.vessels} 艘船、${info.paired_issue_points.toLocaleString()} 個配對發布點（未注入模擬異常）` +
    (gain ? `；融合模型 ADE 較常速度低 ${gain}%` : '');
  const md = D.meta.multiday;
  if (md) {
    const pc = (x) => (x * 100).toFixed(1);
    const [dk, dn] = md.recall.deviation, [gk, gn] = md.recall.ais_gap;
    $('metrics-note').textContent += `。${md.n_days} 天驗證（${md.days[0].slice(5)}～${md.days[1].slice(5)}，` +
      `${md.issue_points.toLocaleString()} 個發布點）：融合較 CV 低 ${pc(md.gain)}%（95% 區間 ${pc(md.gain_ci[0])}～${pc(md.gain_ci[1])}%），` +
      `${md.days_improved}/${md.n_days} 天都較好；模擬注入召回率 偏航 ${dk}/${dn}、訊號中斷 ${gk}/${gn}`;
  }
}

function renderFilters() {
  const box = $('filters');
  box.innerHTML = '';
  for (const [type, label] of Object.entries(TYPE_LABEL)) {
    if (!alerts.some((a) => a.type === type)) continue;
    const b = document.createElement('button');
    b.className = 'chip' + (state.types.has(type) ? ' on' : '');
    b.style.color = `rgb(${COLOR[type]})`;
    b.textContent = `${label} ${alerts.filter((a) => a.type === type).length}`;
    b.onclick = () => { state.types.has(type) ? state.types.delete(type) : state.types.add(type); refresh(); };
    box.appendChild(b);
  }
  const s = document.createElement('button');
  s.className = 'chip' + (state.simOnly ? ' on' : '');
  s.style.color = 'var(--sim)';
  s.textContent = '只看模擬情境';
  s.onclick = () => { state.simOnly = !state.simOnly; refresh(); };
  box.appendChild(s);
  // 一般警示（港區外的客船、其他船型、接收站斷訊等）預設收起來，需要時再展開
  const nNormal = alerts.filter((a) => a.sev !== 'high' && !a.sim && state.types.has(a.type)).length;
  if (nNormal) {
    const h = document.createElement('button');
    h.className = 'chip' + (state.highOnly ? '' : ' on');
    h.textContent = state.highOnly ? `＋ 顯示一般警示 ${nNormal}` : '－ 收起一般警示';
    h.title = '預設只列高優先與模擬情境；一般警示是港區外的客船、其他船型，或研判為接收站斷訊的訊號中斷';
    h.onclick = () => { state.highOnly = !state.highOnly; refresh(); };
    box.appendChild(h);
  }
  if (alerts.some((a) => a.d?.risk != null)) {
    const r = document.createElement('button');
    r.className = 'chip' + (state.byRisk ? ' on' : '');
    r.textContent = state.byRisk ? '依風險排序' : '依時間排序';
    r.title = '切換排序：依風險分數（高的在上）或依時間（新的在上）';
    r.onclick = () => { state.byRisk = !state.byRisk; refresh(); };
    box.appendChild(r);
  }
}

// ---------- 人工檢視 ----------
// 點選警示後可標記「值得關注／誤報／不確定」（或按 1／2／3），存在這台瀏覽器裡，可匯出 CSV；
// python -m seaeye review 讀 CSV 算出各類警示的精確率
const REVIEW_KEY = 'seaeye-review';
const REVIEW_LABEL = { yes: '值得關注', no: '誤報', unsure: '不確定' };
const REVIEW_MARK = { yes: '✓', no: '✗', unsure: '?' };
let reviews = {};
try { reviews = JSON.parse(storeGet(REVIEW_KEY) || '{}') || {}; } catch { reviews = {}; }

function reviewKey(a) {
  return `${a.type}|${a.m}|${a.td}`;
}

function setReview(a, value) {
  const k = reviewKey(a);
  if (reviews[k] === value) delete reviews[k]; else reviews[k] = value; // 再按一次取消
  storeSet(REVIEW_KEY, JSON.stringify(reviews));
  renderAlertList(true);
  renderReviewBar();
}

function renderReviewBar() {
  const high = alerts.filter((a) => a.sev === 'high' && !a.sim);
  const done = high.filter((a) => reviews[reviewKey(a)]).length;
  const total = Object.keys(reviews).length;
  $('review-bar').innerHTML = `人工檢視：高優先 ${done}／${high.length} 則已標記` +
    (total ? `（共 ${total} 則）<button id="review-export" class="link-btn">匯出 CSV</button>` : '・點選警示後按 1／2／3 標記');
  if (total) $('review-export').onclick = exportReviews;
}

function exportReviews() {
  const rows = [['type', 'mmsi', 'name', 'vessel_class', 'detected_utc', 'severity', 'risk', 'simulated', 'review']];
  for (const a of alerts) {
    const r = reviews[reviewKey(a)];
    if (!r) continue;
    const t = new Date(t0ms + a.td * 1000).toISOString().slice(0, 19) + 'Z';
    rows.push([a.type, a.m, vesselName(a.m), a.d?.vessel_class || '', t, a.sev, a.d?.risk ?? '', a.sim ? 1 : 0, r]);
  }
  // 開頭的 BOM 讓 Excel 正確讀中文
  const csv = '\ufeff' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `seaeye-review-${D.meta.t0.slice(0, 10)}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function riskLevel(score) {
  return score >= 70 ? 'r-hi' : score >= 45 ? 'r-mid' : 'r-lo';
}

function renderAlertList(force) {
  const t = state.t;
  const shown = visibleAlerts().filter((a) => a.td <= t).reverse();
  if (state.byRisk) shown.sort((a, b) => (b.d?.risk ?? 0) - (a.d?.risk ?? 0) || b.td - a.td);
  // 訊號中斷的卡片內容會隨時間變化（持續中 → 已恢復），每分鐘重畫一次
  const key = shown.length + '|' + state.byRisk + '|' + (state.selected ? state.selected.td + state.selected.m : '') +
    '|' + Math.floor(t / 60) * shown.some((a) => a.type === 'ais_gap' && t < a.te + 60);
  if (!force && key === listKey) return;
  const prevCount = Number(listKey.split('|')[0] || 0);
  listKey = key;
  $('alert-count').textContent = `${shown.length} 則`;
  const ol = $('alert-list');
  ol.innerHTML = '';
  shown.forEach((a, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', `rgb(${COLOR[a.type]})`);
    li.classList.add(a.sev === 'high' ? 'high' : 'normal');
    if (a === state.selected) li.classList.add('selected');
    if (!force && i < shown.length - prevCount) li.classList.add('fresh');
    li.innerHTML =
      `<div class="a-head"><span>${TYPE_LABEL[a.type]}` +
      (a.sim ? '<span class="badge sim">模擬情境</span>' : '') +
      (a.sev === 'high' ? '<span class="badge high">高優先</span>' : '<span class="badge normal">一般</span>') +
      `</span><span class="a-time">${a.d?.risk != null ? `<span class="risk ${riskLevel(a.d.risk)}">風險 ${a.d.risk}</span>` : ''}` +
      `${clock(a.td)}</span></div>` +
      `<div class="a-body"><b>${esc(vesselName(a.m))}</b> · ${esc(describe(a))}</div>` +
      (a.d?.risk_reasons?.length ? `<div class="a-risk">風險因素：${esc(a.d.risk_reasons.join('、'))}</div>` : '') +
      (a === state.selected ? '<div class="a-review">' + Object.entries(REVIEW_LABEL).map(([k, label], n) =>
        `<button data-r="${k}" class="${reviews[reviewKey(a)] === k ? 'on' : ''}">${n + 1} ${label}</button>`).join('') + '</div>' : '');
    const mark = reviews[reviewKey(a)];
    if (mark) li.querySelector('.a-head span').insertAdjacentHTML('beforeend', `<span class="badge review ${mark}" title="人工檢視：${REVIEW_LABEL[mark]}">${REVIEW_MARK[mark]}</span>`);
    li.querySelectorAll('.a-review button').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); setReview(a, b.dataset.r); }));
    li.onclick = () => select(a);
    ol.appendChild(li);
  });
}

function renderTicks() {
  // 時間軸上方的警示直方圖：每 30 分鐘一格、依類型堆疊；琥珀色細線是模擬事件
  const dur = D.meta.duration, bin = 1800, nb = Math.ceil(dur / bin), H = 20;
  const types = Object.keys(TYPE_LABEL), vis = visibleAlerts();
  const counts = types.map(() => new Array(nb).fill(0));
  for (const a of vis) counts[types.indexOf(a.type)][Math.min(nb - 1, Math.floor(a.td / bin))] += 1;
  const totals = counts[0].map((_, i) => counts.reduce((s, c) => s + c[i], 0));
  const max = Math.max(1, ...totals);
  let svg = '';
  for (let i = 0; i < nb; i++) {
    let y = H;
    types.forEach((ty, k) => {
      const h = (counts[k][i] / max) * (H - 2);
      if (!h) return;
      y -= h;
      svg += `<rect x="${(i / nb) * 1000 + 1}" y="${y.toFixed(1)}" width="${(1000 / nb - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="rgb(${COLOR[ty]})" opacity="0.85"/>`;
    });
  }
  svg += vis.filter((a) => a.sim).map((a) =>
    `<rect x="${((a.td / dur) * 1000 - 1.5).toFixed(1)}" y="0" width="3" height="${H}" fill="var(--sim)"/>`).join('');
  // 接收站斷訊（多艘船同時失聯）：灰色三角形標在底部
  const outages = outageTimes();
  svg += outages.map((o) => {
    const x = (o.ts / dur) * 1000;
    return `<path d="M${(x - 5).toFixed(1)} ${H}L${(x + 5).toFixed(1)} ${H}L${x.toFixed(1)} ${H - 8}Z" fill="#94a3b8"/>`;
  }).join('');
  $('ticks').innerHTML = `<svg viewBox="0 0 1000 ${H}" preserveAspectRatio="none">${svg}</svg>`;
  $('ticks').title = `警示數量（每 30 分鐘，共 ${vis.length} 則）；琥珀色細線＝模擬情境` +
    (outages.length ? `；灰色三角＝接收站斷訊（${outages.map((o) => `${clock(o.ts)} ${o.n} 艘`).join('、')}）` : '') +
    '。點一下跳到那個時段的第一則警示';
}

function outageTimes() {
  // 同一次接收站斷訊的船（彼此相隔 10 分鐘內）合併成一筆
  const out = [];
  for (const g of (D.gaps || []).filter((g) => g.k === 'outage')) {
    const o = out[out.length - 1];
    if (o && g.ts - o.last <= 600) { o.n += 1; o.last = g.ts; } else out.push({ ts: g.ts, last: g.ts, n: 1 });
  }
  return out;
}

function jumpOnTimeline(e) {
  // 點時間軸上方的直方圖：該 30 分鐘有警示就跳到第一則，沒有就只移動時間
  const r = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * D.meta.duration, bin = 1800;
  const a = visibleAlerts().find((x) => Math.floor(x.td / bin) === Math.floor(t / bin));
  stopTour();
  stopRescue();
  if (a) select(a);
  else setTime(t);
}

function refresh() {
  renderFilters();
  renderTicks();
  renderAlertList(true);
}

function setTime(t) {
  state.t = Math.max(0, Math.min(D.meta.duration, t));
  $('scrub').value = state.t;
  $('clock-time').textContent = clock(state.t) + ' UTC';
}

function setPlaying(on) {
  state.playing = on && state.t < D.meta.duration;
  $('play').textContent = state.playing ? '❚❚' : '▶';
}

function viewPadding() {
  // 右側面板、左上的船舶卡片與上下列會擋住地圖，置中時要扣掉
  // （卡片剛點選時可能還沒顯示、量不到寬度，所以用 CSS 設定的固定寬度 340）
  const wide = window.innerWidth > 900;
  if (!wide) // 手機：上方有標題列與船舶卡片，下方有播放列
    return { top: state.focus || state.rescue ? 300 : 80, bottom: 140, left: 12, right: 12 };
  return {
    top: 90, bottom: 80,
    left: state.focus || state.rescue ? 340 + 32 : 16,
    right: $('panel').offsetWidth + 32,
  };
}

function flyTo(lon, lat, zoom) {
  map.flyTo({ center: [lon, lat], zoom, duration: 1500, padding: viewPadding() });
}

function select(a) {
  // 跳到事件開始前 10 分鐘，讓觀眾看到船原本的航行，再看到異常發生
  stopRescue();
  state.selected = a;
  setFocus(a.m); // 同時點選該船，直接看到各預測如何偏離
  // 滯留要停滿 1 小時才判定，直接跳到判定前 5 分鐘
  setTime(a.type === 'loiter' ? a.td - 300 : a.ts - 600);
  flyTo(a.lon, a.lat, 11.5); // 拉近到能看清四條預測線分岔
  setPlaying(true);
  renderAlertList(true);
  updateUrl();
}

function step(dir) {
  const list = visibleAlerts();
  if (!list.length) return;
  const cur = state.selected ? list.indexOf(state.selected) : -1;
  let i;
  if (cur >= 0) i = (cur + dir + list.length) % list.length;
  else i = dir > 0 ? Math.max(0, list.findIndex((a) => a.td > state.t)) : list.length - 1;
  select(list[i]);
}

// ---------- 搜尋船舶 ----------

let tripMmsi = new Set(); // 有航跡可顯示的船（太短的航段在分析時已剔除）

function searchVessels(q) {
  q = q.trim().toUpperCase();
  if (!q) return [];
  const out = [];
  for (const [m, v] of Object.entries(D.vessels || {})) {
    if (!tripMmsi.has(Number(m))) continue;
    // 也可以用船型找，例如輸入「救援」列出救援船
    if (m.startsWith(q) || (v[0] && v[0].toUpperCase().includes(q)) || (v[1] && v[1].includes(q))) out.push(Number(m));
    if (out.length >= 8) break;
  }
  return out;
}

function renderSearch() {
  const box = $('search-results'), q = $('search').value.trim();
  const hits = searchVessels(q);
  box.innerHTML = hits.map((m) =>
    `<li data-m="${m}"><b>${esc(vesselName(m))}</b><span>${esc(vesselDesc(m) || '船型不明')} · ${m}</span></li>`).join('') ||
    (q ? '<li class="empty">找不到符合的船</li>' : '');
  box.classList.toggle('hidden', !q);
  box.querySelectorAll('li[data-m]').forEach((li) => (li.onclick = () => goVessel(Number(li.dataset.m))));
}

function goVessel(m) {
  // 船此刻有回報就直接飛過去；沒有的話，跳到它第一次出現的時間
  $('search').value = '';
  $('search-results').classList.add('hidden');
  stopTour();
  stopRescue();
  state.selected = null;
  const vt = trips.all.filter((d) => d.m === m);
  if (!vt.length) return;
  let trip = vt.find((d) => d.t[0] <= state.t && state.t <= d.t[d.t.length - 1]);
  if (!trip) { trip = vt[0]; setTime(trip.t[0] + 60); }
  setFocus(m);
  const at = positionAt(trip, state.t);
  if (at) flyTo(at.pos[0], at.pos[1], 11);
  renderAlertList(true);
  updateUrl();
}

// ---------- 網址參數（直接連到某則事件或某艘船） ----------

function simList() {
  // 分享連結的事件編號：注入的模擬事件在前（依判定時間），示範海域的滯留排在後面，
  // 這樣加入示範海域之前分享出去的 ?event=N 仍指向同一則事件
  const sim = alerts.filter((a) => a.sim);
  return [...sim.filter((a) => a.type !== 'loiter'), ...sim.filter((a) => a.type === 'loiter')];
}

function linkParams() {
  const p = new URLSearchParams(), s = state.selected;
  if (DAYS && CURRENT_DAY !== DAYS.default) p.set('day', CURRENT_DAY); // 分享的連結停在同一天
  if (state.rescue) p.set('rescue', '1');
  else if (s && s.sim) p.set('event', simList().indexOf(s) + 1);
  else if (state.focus) { p.set('mmsi', state.focus); p.set('t', clock(state.t)); }
  return p;
}

function updateUrl() {
  const qs = linkParams().toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

async function copyLink() {
  const p = linkParams();
  p.set('t', clock(state.t)); // 分享出去的連結停在同一個時間點，對方看到的就是同一個畫面
  const url = `${location.origin}${location.pathname}?${p}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('已複製連結：' + url);
  } catch {
    window.prompt('複製這個連結：', url);
  }
}

function applyUrl() {
  // 回傳是否有指定事件或船舶（有的話就不顯示歡迎畫面）
  const p = new URLSearchParams(location.search);
  const t = p.get('t');
  const applyTime = () => {
    if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return false;
    const [h, mi] = t.split(':').map(Number);
    setTime(h * 3600 + mi * 60 - ((t0ms / 1000) % 86400));
    return true;
  };
  if (p.get('rescue') && D.rescue?.showcase) { startRescue('hungarian', true); return true; }
  const ev = Number(p.get('event'));
  if (ev && simList()[ev - 1]) {
    state.simOnly = true;
    refresh();
    select(simList()[ev - 1]);
    // 同時給了時間：停在事件的那一刻（分享特定畫面用）
    if (applyTime()) setPlaying(false);
    return true;
  }
  applyTime();
  const m = Number(p.get('mmsi'));
  if (m && tripMmsi.has(m)) { goVessel(m); return true; }
  return !!t;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ---------- 歡迎畫面、主題、手機面板 ----------

function showWelcome(show) {
  $('welcome').classList.toggle('hidden', !show);
}

function closeWelcome(thenTour) {
  storeSet(WELCOME_KEY, '1');
  showWelcome(false);
  if (thenTour) startTour();
}

function setTheme(light, persist = true) {
  document.body.classList.toggle('light', light);
  if (persist) storeSet(THEME_KEY, light ? 'light' : 'dark');
  if (map) map.setStyle(light ? LIGHT_STYLE : MAP_STYLE);
  $('theme').textContent = light ? '☾ 深色' : '☀ 淺色';
  focusKey = '';
}

// ---------- 載入資料（顯示進度） ----------

async function showVersion() {
  // 網站上傳時寫入的 version.json；本機預覽沒有這個檔，改顯示資料匯出時間
  let text = D.meta.exported_at ? `資料匯出：${D.meta.exported_at}（尚未上傳）` : '';
  try {
    const r = await fetch('version.json', { cache: 'no-cache' });
    if (r.ok) text = `本版上傳：${(await r.json()).published_at}`;
  } catch { /* 讀不到就維持匯出時間 */ }
  $('version').textContent = text;
}

async function expectedSize() {
  // 匯出時記下的 data.json 大小（位元組）；讀不到就回傳 0，載入畫面改顯示動畫
  try {
    const r = await fetch(`${DAY_BASE}data-size.json`, { cache: 'no-cache' });
    return r.ok ? Number((await r.json()).bytes) || 0 : 0;
  } catch {
    return 0;
  }
}

async function fetchJsonWithProgress(url, onProgress, expected = 0) {
  // no-cache：每次向伺服器確認，沒更新就用瀏覽器裡的副本，不必重新下載 10 MB
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // 伺服器有壓縮時（GitHub Pages 會），Content-Length 是壓縮後的大小，和讀到的位元組數對不起來，
  // 改用匯出時記下的大小
  const total = (r.headers.get('Content-Encoding') ? 0 : Number(r.headers.get('Content-Length'))) || expected;
  if (!r.body || !r.body.getReader) return r.json();
  const reader = r.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

function showProgress(got, total) {
  const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0;
  $('loading-text').textContent = total ? `載入資料中… ${pct}%` : `載入資料中… ${(got / 1048576).toFixed(1)} MB`;
  $('loading-bar').style.width = total ? `${Math.min(100, (got / total) * 100)}%` : '100%';
  $('loading-bar').classList.toggle('indeterminate', !total);
}

// ---------- 自動導覽（錄影用）：依序播放每則模擬事件，自動調速並打上字幕 ----------

const tour = { on: false, list: [], idx: -1 };

function tourEnd(a) {
  // 偏航：判定後再播 10 分鐘；訊號中斷：等到船恢復訊號、卡片顯示完整資訊後再 5 分鐘
  return a.type === 'ais_gap' ? Math.max(a.td + 600, a.te + 300) : a.td + 600;
}

function startTour() {
  state.simOnly = true;
  state.types = new Set(Object.keys(TYPE_LABEL));
  refresh();
  // 最後一站：救援調度示範（有資料時）
  // 同一海域、同一時段的滯留只停一站（示範海域裡常同時有好幾艘船）
  const stops = visibleAlerts().filter((a, i, all) => a.type !== 'loiter' ||
    !all.slice(0, i).some((b) => b.type === 'loiter' && b.d.zone === a.d.zone && Math.abs(b.td - a.td) < 1800));
  tour.list = [...stops, ...(D.rescue?.showcase ? [{ type: 'rescue' }] : [])];
  tour.idx = -1;
  tour.on = tour.list.length > 0;
  $('tour').classList.toggle('on', tour.on);
  nextTourStop();
}

function stopTour() {
  tour.on = false;
  $('tour').classList.remove('on');
  setCaption('');
}

function nextTourStop() {
  tour.idx += 1;
  if (tour.idx >= tour.list.length) { stopTour(); setPlaying(false); return; }
  const a = tour.list[tour.idx];
  if (a.type === 'rescue') {
    tour.rescueStart = performance.now();
    startRescue('hungarian');
    return;
  }
  state.speed = a.type === 'ais_gap' ? 300 : 60; // 訊號中斷要等滿 60 分鐘，加快播放
  $('speed').value = String(state.speed);
  select(a);
}

function rescueTourCaption(elapsed) {
  // 救援這一站用實際秒數推進：先播最佳指派，再切到「最近的船先去」對照
  const R = D.rescue.showcase, h = R.hungarian, g = R.greedy;
  const head = `延伸功能｜同一海域 ${R.distress.length} 艘船同時求救（假設情境）`;
  if (elapsed < RESCUE_ANIM_S + 2)
    return `${head}：系統以 Hungarian 演算法指派附近船隻支援，並規劃避開陸地的航線，總抵達時間 ${Math.round(h.total_min)} 分鐘`;
  return `${head}：對照「最近的船先去」需要 ${Math.round(g.total_min)} 分鐘；最佳指派少 ${Math.round((1 - h.total_min / g.total_min) * 100)}%`;
}

function tourCaption(a, t) {
  const head = `模擬情境 ${tour.idx + 1}／${tour.list.length}｜${vesselName(a.m)}（${vesselDesc(a.m) || a.d.vessel_class || '船舶'}）`;
  if (t < a.ts) return `${head}：正常航行中。藍線與扇形是系統對 5／15／30 分鐘後位置的預測`;
  if (a.type === 'deviation') {
    if (t < a.td) return `${head}：船突然轉向，實際位置開始偏離所有預測器的預期`;
    return `${head}：判定「偏航」——${describe(a, t)}`;
  }
  if (a.type === 'loiter') {
    if (t < a.td) return `${head}：在「${a.d.zone}」內低速停留（已 ${Math.max(0, Math.floor((t - a.ts) / 60))} 分鐘，滿 60 分鐘判定）。海域是示範用的假設範圍`;
    return `${head}：判定「異常滯留」——船在海纜保護區內停留或下錨，船錨可能拖壞海纜（臺灣近年也發生過海纜疑遭船錨損壞的事件）`;
  }
  if (t < a.td) return `${head}：AIS 訊號消失，系統開始計時（已 ${Math.floor((t - a.ts) / 60)} 分鐘，滿 60 分鐘判定）`;
  if (t < a.te) return `${head}：中斷滿 60 分鐘，發出「疑似關閉 AIS」警示`;
  return `${head}：船恢復訊號——${describe(a, t)}`;
}

function setCaption(text) {
  const el = $('caption');
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('hidden', !text);
  document.body.classList.toggle('touring', !!text);
}

function frame(now) {
  if (lastFrame !== null && state.playing) {
    setTime(state.t + ((now - lastFrame) / 1000) * state.speed);
    if (state.t >= D.meta.duration) setPlaying(false);
  }
  if (tour.on) {
    const a = tour.list[tour.idx];
    if (a.type === 'rescue') {
      const e = (now - tour.rescueStart) / 1000;
      if (e >= RESCUE_ANIM_S + 2 && state.rescue?.mode === 'hungarian') setRescueMode('greedy');
      setCaption(rescueTourCaption(e));
      if (e >= 2 * (RESCUE_ANIM_S + 2)) nextTourStop();
    } else {
      setCaption(tourCaption(a, state.t));
      if (state.t >= tourEnd(a)) nextTourStop();
    }
  }
  lastFrame = now;
  overlay.setProps({ layers: layers() });
  renderAlertList(false);
  requestAnimationFrame(frame);
}

function tooltip({ object, layer }) {
  if (!object) return null;
  if (layer.id === 'vessels') {
    const m = object.trip.m, desc = vesselDesc(m);
    return { text: `${vesselName(m)}\n${desc ? desc + '\n' : ''}航速 ${object.sog ?? '—'} 節` +
      (object.trip.sim ? '\n（模擬注入）' : '') + (object.trip.mv ? '\n點一下比較各預測方法' : '') };
  }
  if (layer.id === 'alert-rings')
    return { text: `${TYPE_LABEL[object.type]}${object.sim ? '（模擬情境）' : ''}\n${vesselName(object.m)}\n${describe(object)}` };
  if (layer.id === 'ghosts')
    return { text: `${vesselName(object.m)}（最後回報位置）\n${gapText(object, state.t)}` };
  return null;
}

function bindControls() {
  $('play').onclick = () => setPlaying(!state.playing);
  $('speed').onchange = (e) => { state.speed = Number(e.target.value); };
  $('scrub').oninput = (e) => setTime(Number(e.target.value));
  $('prev-alert').onclick = () => { stopTour(); step(-1); };
  $('next-alert').onclick = () => { stopTour(); step(1); };
  $('tour').onclick = () => (tour.on ? stopTour() : startTour());
  $('rescue-btn').onclick = () => { stopTour(); state.rescue ? stopRescue() : startRescue(); };
  $('show-pred').onchange = (e) => { state.showPred = e.target.checked; };
  $('show-idle').onchange = (e) => { state.showIdle = e.target.checked; };
  $('show-cone').onchange = (e) => { state.showCone = e.target.checked; };
  $('show-past').onchange = (e) => { state.showPast = e.target.checked; };
  $('search').oninput = renderSearch;
  $('search').onkeydown = (e) => {
    if (e.key === 'Enter') { const hit = searchVessels(e.target.value)[0]; if (hit) goVessel(hit); }
    else if (e.key === 'Escape') { e.target.value = ''; renderSearch(); e.target.blur(); }
  };
  $('share').onclick = copyLink;
  $('theme').onclick = () => setTheme(!isLight());
  $('help').onclick = () => showWelcome(true);
  $('w-tour').onclick = () => closeWelcome(true);
  $('w-explore').onclick = () => closeWelcome(false);
  $('panel-toggle').onclick = () => document.body.classList.toggle('panel-open');
  $('ticks').onclick = jumpOnTimeline;
  $('metrics-toggle').onclick = () => {
    const table = $('metrics-section').classList.toggle('show-table');
    $('metrics-toggle').textContent = table ? '看長條圖' : '看完整表格';
  };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (!$('welcome').classList.contains('hidden')) {
      if (e.code === 'Escape') closeWelcome(false);
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
    else if (e.code === 'ArrowRight') { stopTour(); step(1); }
    else if (e.code === 'ArrowLeft') { stopTour(); step(-1); }
    else if (e.code === 'KeyG') (tour.on ? stopTour() : startTour());
    else if (e.code === 'KeyH') document.body.classList.toggle('clean');
    else if (e.code === 'KeyP') { state.showPred = !state.showPred; $('show-pred').checked = state.showPred; }
    else if (e.code === 'Escape') { stopTour(); stopRescue(); state.selected = null; setFocus(null); updateUrl(); }
    else if (e.code === 'KeyR') (state.rescue ? stopRescue() : startRescue());
    else if (state.selected && ['Digit1', 'Digit2', 'Digit3'].includes(e.code))
      setReview(state.selected, ['yes', 'no', 'unsure'][Number(e.code.slice(-1)) - 1]);
  });
}

// ---------- 日期 ----------
// days.json 列出有哪些日期與各自的資料位置（6/1 在根目錄，其餘在 days/<日期>/）；沒有這個檔就只有一天
let DAYS = null, CURRENT_DAY = null, DAY_BASE = '';

async function loadDayIndex() {
  try {
    const r = await fetch('days.json', { cache: 'no-cache' });
    if (r.ok) DAYS = await r.json();
  } catch { DAYS = null; }
  if (!DAYS?.days?.length) return;
  const want = new URLSearchParams(location.search).get('day');
  const entry = DAYS.days.find((d) => d.date === want) || DAYS.days.find((d) => d.date === DAYS.default) || DAYS.days[0];
  CURRENT_DAY = entry.date;
  DAY_BASE = entry.path;
}

function renderDaySelect() {
  const box = $('clock-date');
  if (!DAYS || DAYS.days.length < 2) { box.textContent = D.meta.t0.slice(0, 10) + ' · UTC'; return; }
  box.innerHTML = '<select id="day-select" title="切換日期（重新載入那一天的資料）">' +
    DAYS.days.map((d) => `<option value="${d.date}"${d.date === CURRENT_DAY ? ' selected' : ''}>${d.date}</option>`).join('') +
    '</select> · UTC';
  $('day-select').onchange = (e) => {
    // 換日期就整頁重新載入：時間、警示、救援情境都跟著換
    const p = new URLSearchParams();
    if (e.target.value !== DAYS.default) p.set('day', e.target.value);
    location.search = p.toString();
  };
}

async function main() {
  // 網址的 ?theme=light／dark 優先（例如決審投影直接開淺色版），其次是上次的選擇
  const themeParam = new URLSearchParams(location.search).get('theme');
  const light = themeParam ? themeParam === 'light' : storeGet(THEME_KEY) === 'light';
  setTheme(light, false);
  try {
    await loadDayIndex();
    D = await fetchJsonWithProgress(`${DAY_BASE}data.json`, showProgress, await expectedSize());
  } catch (err) {
    $('loading-text').textContent = '讀不到 data.json：請先執行 python -m seaeye dashboard，並用 http 伺服器開啟此頁';
    return;
  }
  t0ms = Date.parse(D.meta.t0);
  for (const d of D.trips) {
    d.cls = CLASS_GLYPH[vinfo(d.m).key] ? vinfo(d.m).key : 'unknown';
    d.rescue = d.cls === 'rescue';
  }
  $('legend-classes').innerHTML = GLYPH_KEYS.map((k) =>
    `<span><img src="${legendGlyphUrl(k)}" alt="">${CLASS_GLYPH[k][0]}</span>`).join('');
  trips.all = D.trips;
  // 救援船即使整段低速（港內待命）也一直畫出來
  trips.moving = D.trips.filter((d) => d.mv || d.rescue);
  $('legend-rescue-n').textContent = new Set(D.trips.filter((d) => d.rescue).map((d) => d.m)).size;
  tripMmsi = new Set(D.trips.map((d) => d.m));
  alerts = D.alerts;
  $('scrub').max = D.meta.duration;
  renderDaySelect();
  $('source').textContent = '資料：' + D.meta.source;
  $('w-date').textContent = D.meta.t0.slice(0, 10);
  // 清理後的船舶總數（與構想書一致）；地圖上只畫航跡夠長、能做預測的船
  $('w-vessels').textContent = (Object.keys(D.vessels || {}).length || D.meta.vessels).toLocaleString('en-US');
  $('legend-cov').textContent = coverageText();
  showVersion();
  renderReviewBar();
  state.detail = storeGet(DETAIL_KEY) === '1';
  // 預測器數量依資料而定（有歷史航道圖時多一個 LANE）
  const names = D.meta.weight_methods.map((m) => METHOD_STYLE[m].label).join('、');
  $('legend-methods').textContent = `點選船舶：看簡易說明，或比較融合與${nMethods()}種預測器`;
  $('w-methods').textContent = `${nMethods()}種預測器（${names}）`;
  $('legend-ghost').classList.toggle('hidden', !(D.gaps || []).length);
  $('legend-zone').classList.toggle('hidden', !(D.zones || []).length);

  // deck.gl 9 的 DeckGL 不會自動建立底圖，改由 MapLibre 建地圖、deck.gl 疊在上面
  map = new maplibregl.Map({
    container: 'map', style: light ? LIGHT_STYLE : MAP_STYLE, center: D.meta.center,
    zoom: window.innerWidth > 900 ? 8.2 : 7.4, attributionControl: { compact: true },
  });
  map.setPadding(viewPadding());
  overlay = new deck.MapboxOverlay({
    interleaved: false, getTooltip: tooltip, layers: [],
    onClick: ({ object, layer }) => {
      if (object && layer.id === 'vessels') { stopRescue(); state.selected = null; setFocus(object.trip.m); }
      else if (object && layer.id === 'ghosts') { stopRescue(); state.selected = null; setFocus(object.m); }
      else if (object && layer.id === 'alert-rings') return select(object);
      else if (!object) setFocus(null); // 點空白處取消點選
      updateUrl();
    },
  });
  map.addControl(overlay);

  renderMetrics();
  refresh();
  bindControls();
  setTime(0);
  $('loading').remove();
  // 網址有指定事件或船就直接開；第一次來的人才顯示歡迎畫面
  if (!applyUrl() && !storeGet(WELCOME_KEY)) showWelcome(true);
  requestAnimationFrame(frame);
}

main();
