// 海眼儀表板：依時間回放 AIS 航跡、預測位置與警示。資料由 `python -m seaeye dashboard` 產生。

const COLOR = {
  moving: [45, 212, 191], idle: [100, 116, 139], sim: [251, 191, 36], pred: [56, 189, 248],
  deviation: [249, 115, 22], ais_gap: [239, 68, 68], loiter: [168, 85, 247],
};
const TYPE_LABEL = { deviation: '偏航', ais_gap: '疑似關閉 AIS', loiter: '異常滯留' };
const ACTIVE_S = 3600;       // 警示發出後 1 小時內在地圖上標示
const TRAIL_S = 1800;        // 航跡尾巴長度 30 分鐘
const PRED_FRESH_S = 180;    // 預測發布超過 3 分鐘就不顯示，避免拿舊預測接到現在位置
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const CJK_FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';

// 點選船舶時比較的四種預測：融合是系統最終輸出，其餘三個是它的組成
const METHOD_STYLE = {
  fused: { label: '融合', name: 'NLMS＋Hedge 融合', color: [56, 189, 248], width: 3 },
  cv: { label: 'CV', name: '常速度 CV', color: [226, 232, 240], width: 1.5 },
  ctr: { label: 'CTR', name: '常轉向率 CTR', color: [163, 230, 53], width: 1.5 },
  nlms: { label: 'NLMS', name: 'NLMS 殘差', color: [244, 114, 182], width: 1.5 },
};

// 船形圖示（俯視、船頭朝上＝朝北），以 mask 方式上色
const SHIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="96" viewBox="0 0 40 96">' +
  '<path d="M20 2C30 16 34 28 34 40V86Q34 94 26 94H14Q6 94 6 86V40C6 28 10 16 20 2Z" fill="#fff"/></svg>';
const SHIP_ICON = {
  atlas: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SHIP_SVG),
  mapping: { ship: { x: 0, y: 0, width: 40, height: 96, anchorY: 48, mask: true } },
};

const $ = (id) => document.getElementById(id);
const state = {
  t: 0, playing: false, speed: 60, showPred: true, showIdle: true,
  types: new Set(Object.keys(TYPE_LABEL)), simOnly: false, selected: null, focus: null,
};
let D, map, overlay, t0ms, trips = { all: [], moving: [] }, alerts = [], listKey = '', lastFrame = null;
const vesselCache = new Map(); // MMSI → 完整預測（undefined：未載入、'loading'、null：沒有資料）
let focusKey = '';

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
  const pr = D.preds[mmsi];
  if (!pr) return null;
  const i = lowerBound(pr.t, t);
  if (i < 0 || t - pr.t[i] > PRED_FRESH_S) return null;
  const n = D.meta.horizons.length;
  return pr.p.slice(i * n, i * n + n);
}

function fullPredictionAt(mmsi, t) {
  // 點選船舶用：四種方法 × 各時距的位置，以及各時距的 Hedge 權重
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
  vesselCache.set(mmsi, 'loading');
  try {
    const r = await fetch(`vessels/${mmsi}.json`, { cache: 'no-store' });
    vesselCache.set(mmsi, r.ok ? await r.json() : null); // 停泊船沒有預測檔
  } catch {
    vesselCache.set(mmsi, null);
  }
}

function visibleAlerts() {
  return alerts.filter((a) => state.types.has(a.type) && (!state.simOnly || a.sim));
}

// ---------- 文字格式 ----------

function clock(t) {
  const d = new Date(t0ms + t * 1000);
  return d.toISOString().slice(11, 16);
}

function describe(a, t = state.t) {
  // 重播時只顯示「當下已知」的資訊：中斷總長與期間他船回報數，要等訊號恢復才知道
  const d = a.d;
  if (a.type === 'deviation')
    return `偏離預期航程 ${Math.round(d.peak_ratio * 100)}%（門檻 ${Math.round(d.threshold_ratio * 100)}%），三種預測器都未預期此航向改變`;
  if (a.type === 'ais_gap' && t < a.te)
    return `訊號已中斷 ${Math.floor((t - a.ts) / 60)} 分鐘（持續中）`;
  if (a.type === 'ais_gap')
    return `訊號中斷 ${Math.round(d.gap_min)} 分鐘後恢復；中斷期間附近 ${d.neighbor_reports} 筆他船回報` +
      (d.likely_intentional ? '，該處有訊號涵蓋，疑似刻意關閉' : '');
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

function layers() {
  const t = state.t;
  const tripData = state.showIdle ? trips.all : trips.moving;
  const vessels = [];
  for (const trip of tripData) {
    const at = positionAt(trip, t);
    if (at) vessels.push({ trip, ...at });
  }
  updateKpis(vessels);

  // 點選中的船：畫四種方法的預測，並更新資訊卡
  const focusVessel = state.focus ? vessels.find((v) => v.trip.m === state.focus) : null;
  const full = focusVessel ? fullPredictionAt(state.focus, t) : null;
  updateFocusCard(focusVessel, full);
  const methodLines = [], methodDots = [], methodLabels = [];
  if (focusVessel && full && full !== 'loading') {
    for (const { m, pts } of full.pts) {
      const ok = pts.filter(Boolean);
      if (!ok.length) continue;
      methodLines.push({ m, path: [focusVessel.pos, ...ok] });
      ok.forEach((p, k) => methodDots.push({ m, pos: p, k }));
      methodLabels.push({ m, pos: ok[ok.length - 1] });
    }
  }

  const predLines = [], predDots = [];
  if (state.showPred) {
    for (const v of vessels) {
      if (!v.trip.mv || v === focusVessel) continue;
      const pts = predictionAt(v.trip.m, t);
      if (!pts) continue;
      const ok = pts.map((p, k) => p && { pos: p, k }).filter(Boolean);
      if (!ok.length) continue;
      predLines.push({ path: [v.pos, ...ok.map((d) => d.pos)], sim: v.trip.sim });
      predDots.push(...ok);
    }
  }

  const pulse = (Math.sin(performance.now() / 260) + 1) / 2;
  const active = visibleAlerts().filter((a) => a.td <= t && t <= a.td + ACTIVE_S);
  const simLabels = active.filter((a) => a.sim);
  const s = state.selected;
  const sel = s && s.td <= t ? [s] : [];
  const pending = s && s.ts <= t && t < s.td ? [s] : [];

  return [
    new deck.TripsLayer({
      id: 'trails', data: tripData, currentTime: t, trailLength: TRAIL_S, fadeTrail: true,
      getPath: (d) => d.p, getTimestamps: (d) => d.t,
      getColor: (d) => (d.sim ? COLOR.sim : d.mv ? COLOR.moving : COLOR.idle),
      widthMinPixels: 2, opacity: 0.75, capRounded: true, jointRounded: true,
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
      getColor: (d) => [...METHOD_STYLE[d.m].color, d.m === 'fused' ? 255 : 200],
      getWidth: (d) => METHOD_STYLE[d.m].width, widthUnits: 'pixels', jointRounded: true,
    }),
    new deck.ScatterplotLayer({
      id: 'method-dots', data: methodDots, getPosition: (d) => d.pos,
      getRadius: (d) => (d.m === 'fused' ? 5 : 3.5) - d.k * 0.5, radiusUnits: 'pixels',
      getFillColor: (d) => METHOD_STYLE[d.m].color,
    }),
    // 船身外框：同一個圖示放大一點、塗深色，墊在底下
    new deck.IconLayer({
      id: 'vessel-outline', data: vessels, iconAtlas: SHIP_ICON.atlas, iconMapping: SHIP_ICON.mapping,
      getIcon: () => 'ship', getPosition: (d) => d.pos, getAngle: (d) => -d.heading,
      getSize: (d) => (d.trip.mv ? 26 : 16) + 3, sizeScale: shipScale(), getColor: [11, 18, 32, 230],
    }),
    new deck.IconLayer({
      id: 'vessels', data: vessels, pickable: true, iconAtlas: SHIP_ICON.atlas, iconMapping: SHIP_ICON.mapping,
      getIcon: () => 'ship', getPosition: (d) => d.pos, getAngle: (d) => -d.heading,
      getSize: (d) => (d.trip.mv ? 26 : 16), sizeScale: shipScale(),
      getColor: (d) => (d.trip.sim ? COLOR.sim : d.trip.mv ? COLOR.moving : COLOR.idle),
    }),
    new deck.ScatterplotLayer({
      id: 'focus-ring', data: focusVessel ? [focusVessel] : [], getPosition: (d) => d.pos,
      getRadius: 22, radiusUnits: 'pixels', stroked: true, filled: false,
      getLineColor: [255, 255, 255, 220], lineWidthMinPixels: 2,
    }),
    // 四條線的終點常常很接近，標籤依方法順序上下錯開，避免疊在一起
    new deck.TextLayer({
      id: 'method-labels', data: methodLabels, getPosition: (d) => d.pos,
      getText: (d) => METHOD_STYLE[d.m].label, getColor: (d) => METHOD_STYLE[d.m].color, getSize: 13,
      getTextAnchor: 'start', getAlignmentBaseline: 'center',
      getPixelOffset: (d) => [12, (D.meta.methods.indexOf(d.m) - 1.5) * 18],
      fontFamily: CJK_FONT, fontWeight: 700, characterSet: 'auto',
      background: true, getBackgroundColor: [11, 18, 32, 200], backgroundPadding: [4, 2],
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
      getText: (d) => pendingText(d, t), getColor: [226, 232, 240], getSize: 14,
      getPixelOffset: [0, 38], fontFamily: CJK_FONT, fontWeight: 600, characterSet: 'auto',
      background: true, getBackgroundColor: [11, 18, 32, 220], backgroundPadding: [6, 3],
      updateTriggers: { getText: Math.floor(t / 60) },
    }),
    new deck.TextLayer({
      id: 'alert-labels', data: [...new Set([...simLabels, ...sel])],
      getPosition: (d) => [d.lon, d.lat],
      getText: (d) => (d.sim ? `模擬情境｜${TYPE_LABEL[d.type]}` : TYPE_LABEL[d.type]),
      getColor: (d) => (d.sim ? COLOR.sim : COLOR[d.type]), getSize: 15,
      getPixelOffset: [0, -34], fontFamily: CJK_FONT, fontWeight: 700, characterSet: 'auto',
      background: true, getBackgroundColor: [11, 18, 32, 220], backgroundPadding: [6, 3],
    }),
  ];
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
  if (mmsi) loadVessel(mmsi);
}

function updateFocusCard(v, full) {
  const card = $('focus');
  if (!state.focus) { card.classList.add('hidden'); focusKey = ''; return; }
  const status = full === undefined || full === 'loading' ? 'l' : full ? full.idx : 'n';
  const key = `${state.focus}|${v ? 1 : 0}|${status}|${Math.floor(state.t / 15)}`;
  if (key === focusKey) return;
  focusKey = key;
  card.classList.remove('hidden');

  const trip = trips.all.find((d) => d.m === state.focus);
  let html = `<div class="f-head"><span>MMSI ${state.focus}` +
    (trip && trip.sim ? '<span class="badge sim">模擬注入</span>' : '') +
    '</span><button id="f-close" title="關閉（Esc）">✕</button></div>';
  html += `<div class="f-sub">${v ? `航速 ${v.sog ?? '—'} 節 · 航向 ${Math.round(v.heading)}°` : '此刻沒有回報（尚未出現或已離開）'}</div>`;

  if (v && full && full !== 'loading') {
    html += '<div class="f-legend">' + D.meta.methods.map((m) =>
      `<span><i style="background:rgb(${METHOD_STYLE[m].color})"></i>${METHOD_STYLE[m].name}</span>`).join('') + '</div>';
    html += '<h3>Hedge 權重（依各預測器最近的誤差即時調整）</h3><table class="f-weights"><tr><th>時距</th>' +
      D.meta.weight_methods.map((m) => `<th style="color:rgb(${METHOD_STYLE[m].color})">${METHOD_STYLE[m].label}</th>`).join('') + '</tr>';
    D.meta.horizons.forEach((h, j) => {
      html += `<tr><td>${h} 分</td>` + full.w[j].map((w, q) => {
        if (w == null) return '<td class="muted">—</td>';
        const c = METHOD_STYLE[D.meta.weight_methods[q]].color;
        return `<td><div class="wbar"><i style="width:${w * 100}%;background:rgb(${c})"></i></div>${Math.round(w * 100)}%</td>`;
      }).join('') + '</tr>';
    });
    html += '</table><p class="note">藍色的融合預測＝三個預測器依上表權重加權平均，是系統最終採用的結果。偏航判定則看三者中最接近實際位置的那一個。</p>';
  } else if (v) {
    html += `<p class="note">${full === null ? '此刻沒有預測：航速低於 3 節，或剛開始回報、尚未累積足夠資料。' : '載入預測中…'}</p>`;
  }
  card.innerHTML = html;
  $('f-close').onclick = () => setFocus(null);
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
  $('metrics-note').textContent =
    `${info.vessels} 艘船、${info.paired_issue_points.toLocaleString()} 個配對發布點（未注入模擬異常）` +
    (gain ? `；融合模型 ADE 較常速度低 ${gain}%` : '');
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
}

function renderAlertList(force) {
  const t = state.t;
  const shown = visibleAlerts().filter((a) => a.td <= t).reverse();
  // 訊號中斷的卡片內容會隨時間變化（持續中 → 已恢復），每分鐘重畫一次
  const key = shown.length + '|' + (state.selected ? state.selected.td + state.selected.m : '') +
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
      `</span><span class="a-time">${clock(a.td)}</span></div>` +
      `<div class="a-body">MMSI ${a.m} · ${describe(a)}</div>`;
    li.onclick = () => select(a);
    ol.appendChild(li);
  });
}

function renderTicks() {
  const dur = D.meta.duration;
  $('ticks').innerHTML = visibleAlerts().map((a) =>
    `<i class="${a.sim ? 'sim' : ''}" style="left:${(a.td / dur) * 100}%;background:rgb(${COLOR[a.type]})"></i>`).join('');
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
  return {
    top: 90, bottom: 80,
    left: wide && state.focus ? 340 + 32 : 16,
    right: wide ? $('panel').offsetWidth + 32 : 16,
  };
}

function flyTo(lon, lat, zoom) {
  map.flyTo({ center: [lon, lat], zoom, duration: 1500, padding: viewPadding() });
}

function select(a) {
  // 跳到事件開始前 10 分鐘，讓觀眾看到船原本的航行，再看到異常發生
  state.selected = a;
  setFocus(a.m); // 同時點選該船，直接看到四種預測如何偏離
  setTime(a.ts - 600);
  flyTo(a.lon, a.lat, 11.5); // 拉近到能看清四條預測線分岔
  setPlaying(true);
  renderAlertList(true);
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

function frame(now) {
  if (lastFrame !== null && state.playing) {
    setTime(state.t + ((now - lastFrame) / 1000) * state.speed);
    if (state.t >= D.meta.duration) setPlaying(false);
  }
  lastFrame = now;
  overlay.setProps({ layers: layers() });
  renderAlertList(false);
  requestAnimationFrame(frame);
}

function tooltip({ object, layer }) {
  if (!object) return null;
  if (layer.id === 'vessels')
    return { text: `MMSI ${object.trip.m}\n航速 ${object.sog ?? '—'} 節` + (object.trip.sim ? '\n（模擬注入）' : '') +
      (object.trip.mv ? '\n點一下比較四種預測' : '') };
  if (layer.id === 'alert-rings')
    return { text: `${TYPE_LABEL[object.type]}${object.sim ? '（模擬情境）' : ''}\nMMSI ${object.m}\n${describe(object)}` };
  return null;
}

function bindControls() {
  $('play').onclick = () => setPlaying(!state.playing);
  $('speed').onchange = (e) => { state.speed = Number(e.target.value); };
  $('scrub').oninput = (e) => setTime(Number(e.target.value));
  $('prev-alert').onclick = () => step(-1);
  $('next-alert').onclick = () => step(1);
  $('show-pred').onchange = (e) => { state.showPred = e.target.checked; };
  $('show-idle').onchange = (e) => { state.showIdle = e.target.checked; };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
    else if (e.code === 'ArrowRight') step(1);
    else if (e.code === 'ArrowLeft') step(-1);
    else if (e.code === 'KeyH') document.body.classList.toggle('clean');
    else if (e.code === 'KeyP') { state.showPred = !state.showPred; $('show-pred').checked = state.showPred; }
    else if (e.code === 'Escape') setFocus(null);
  });
}

async function main() {
  try {
    D = await (await fetch('data.json', { cache: 'no-store' })).json();
  } catch (err) {
    $('loading').textContent = '讀不到 data.json：請先執行 python -m seaeye dashboard，並用 http 伺服器開啟此頁';
    return;
  }
  t0ms = Date.parse(D.meta.t0);
  trips.all = D.trips;
  trips.moving = D.trips.filter((d) => d.mv);
  alerts = D.alerts;
  $('scrub').max = D.meta.duration;
  $('clock-date').textContent = D.meta.t0.slice(0, 10) + ' · UTC';
  $('source').textContent = '資料：' + D.meta.source;

  // deck.gl 9 的 DeckGL 不會自動建立底圖，改由 MapLibre 建地圖、deck.gl 疊在上面
  map = new maplibregl.Map({
    container: 'map', style: MAP_STYLE, center: D.meta.center, zoom: 8.2,
    attributionControl: { compact: true },
  });
  map.setPadding(viewPadding());
  overlay = new deck.MapboxOverlay({
    interleaved: false, getTooltip: tooltip, layers: [],
    onClick: ({ object, layer }) => {
      if (object && layer.id === 'vessels') setFocus(object.trip.m);
      else if (object && layer.id === 'alert-rings') select(object);
      else if (!object) setFocus(null); // 點空白處取消點選
    },
  });
  map.addControl(overlay);

  renderMetrics();
  refresh();
  bindControls();
  setTime(0);
  $('loading').remove();
  requestAnimationFrame(frame);
}

main();
