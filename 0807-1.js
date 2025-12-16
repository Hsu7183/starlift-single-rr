// 0807-1.js
// 修正：
// 1) 時區錨點以「最新日期」為準（即使最新日沒交易也要顯示）
// 2) 補齊每日（週一~週五）：沒交易日=0，且上下圖日期完全對齊
// 3) 交易明細：點數/損益/累積損益一律顯示正負顏色（>0紅、<0綠）

(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');

  const scoreCard  = $('#scoreCard');
  const kpiBadCard = $('#kpiBadCard');
  const kpiAllCard = $('#kpiAllCard');

  const rangeChips = $('#rangeChips');

  if (status) status.style.whiteSpace = 'pre-wrap';

  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  function forceSlipDefault2() {
    const slip = $('#slipInput');
    if (!slip) return;
    slip.value = '2';
    slip.dispatchEvent(new Event('input', { bubbles: true }));
    slip.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setKpiVisible(isAll) {
    const hide = !isAll;
    if (scoreCard)  scoreCard.classList.toggle('kpi-hidden', hide);
    if (kpiBadCard) kpiBadCard.classList.toggle('kpi-hidden', hide);
    if (kpiAllCard) kpiAllCard.classList.toggle('kpi-hidden', hide);
  }

  function setActiveChip(key) {
    if (!rangeChips) return;
    rangeChips.querySelectorAll('.range-chip').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.range === key));
    });
  }

  function pubUrl(path) {
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || '#';
  }

  async function listOnce(prefix) {
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, {
      limit : 1000,
      sortBy: { column: 'name', order: 'asc' }
    });
    if (error) throw new Error(error.message);
    return (data || [])
      .filter(it => !(it.id === null && !it.metadata))
      .map(it => ({
        name    : it.name,
        fullPath: p + it.name,
        updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0,
        size    : it.metadata?.size || 0
      }));
  }

  async function listCandidates() {
    const u      = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }

  function lastDateScore(name) {
    const m = String(name).match(/\b(20\d{6})\b/g);
    if (!m || !m.length) return 0;
    return Math.max(...m.map(s => +s || 0));
  }

  function normalizeText(raw) {
    let s = raw
      .replace(/\ufeff/gi, '')
      .replace(/\u200b|\u200c|\u200d/gi, '')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
    s = s.replace(/\r\n?/g, '\n').replace(/\u3000/g, ' ');
    const lines = s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return lines.join('\n');
  }

  function canonicalize(txt) {
    const out = [];
    const lines = (txt || '').split('\n');
    let ok = 0;
    for (const l of lines) {
      const m = l.match(EXTRACT_RE);
      if (m) {
        const ts  = m[1];
        const pxN = Number(m[2]);
        const px6 = Number.isFinite(pxN) ? pxN.toFixed(6) : m[2];
        const act = m[3];
        out.push(`${ts}.000000 ${px6} ${act}`);
        ok++;
      }
    }
    return { canon: out.join('\n'), ok };
  }

  async function fetchSmart(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();

    for (const enc of ['utf-8', 'big5', 'utf-16le', 'utf-16be']) {
      try {
        const td   = new TextDecoder(enc, { fatal: false });
        const norm = normalizeText(td.decode(buf));
        const { canon, ok } = canonicalize(norm);
        if (ok > 0) return { enc, canon, ok };
      } catch {}
    }

    const td   = new TextDecoder('utf-8');
    const norm = normalizeText(td.decode(buf));
    const { canon, ok } = canonicalize(norm);
    return { enc: 'utf-8', canon, ok };
  }

  function parseCanon(text) {
    const rows = [];
    if (!text) return rows;
    for (const line of text.split('\n')) {
      const m = line.match(CANON_RE);
      if (m) rows.push({ ts: m[1], line });
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows;
  }

  function mergeByBaseline(baseText, latestText) {
    const A = parseCanon(baseText);
    const B = parseCanon(latestText);

    const baseMin = A.length ? A[0].ts.slice(0, 8) : (B.length ? B[0].ts.slice(0, 8) : '');
    const baseMax = A.length ? A[A.length - 1].ts : '';

    const added = baseMax ? B.filter(x => x.ts > baseMax).map(x => x.line) : B.map(x => x.line);
    const mergedLines = [...A.map(x => x.line), ...added];

    const endDay = mergedLines.length
      ? mergedLines[mergedLines.length - 1].match(CANON_RE)[1].slice(0, 8)
      : baseMin;

    return { combined: mergedLines.join('\n'), start8: baseMin, end8: endDay };
  }

  function addFakeInpos(text) {
    const lines = (text || '').split('\n').map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const line of lines) {
      const m = line.match(CANON_RE);
      if (!m) continue;

      const ts  = m[1];
      const act = m[3];

      if (act === '新買' || act === '新賣') {
        const dir = (act === '新買') ? 1 : -1;
        out.push(line);
        out.push(`${ts}.000000 0 0 ${dir} 0 INPOS`);
      } else {
        out.push(line);
      }
    }
    return out.join('\n');
  }

  async function feedToSingleTrades(filename, text) {
    const fileInput = $('#fileInput');
    const runBtn    = $('#runBtn');

    const file = new File([text], filename || '0807.txt', { type: 'text/plain' });

    if (window.__singleTrades_setFile) window.__singleTrades_setFile(file);

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (runBtn) runBtn.click();
  }

  async function readManifest() {
    try {
      const { data, error } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
      if (error || !data) return null;
      return JSON.parse(await data.text());
    } catch {
      return null;
    }
  }

  async function writeManifest(obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(
      MANIFEST_PATH,
      blob,
      { upsert: true, cacheControl: '0', contentType: 'application/json' }
    );
    if (error) throw new Error(error.message);
  }

  // ===== 日期工具（UTC）=====
  function ymdToDate(ymd) {
    const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
    return new Date(Date.UTC(y, m - 1, d));
  }
  function dateToYmd(dt) {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  function dowMon1(dt) { const x = dt.getUTCDay(); return x === 0 ? 7 : x; } // Mon=1..Sun=7
  function startOfWeekMonday(endDt) {
    const d = new Date(endDt.getTime());
    const dow = dowMon1(d);
    d.setUTCDate(d.getUTCDate() - (dow - 1));
    return d;
  }
  function addMonthsUTC(dt, deltaMonths) {
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth(), d = dt.getUTCDate();
    const t = new Date(Date.UTC(y, m + deltaMonths, 1));
    const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, lastDay));
    return t;
  }
  function nextMondayIfWeekend(dt) {
    const d = new Date(dt.getTime());
    const dow = dowMon1(d);
    if (dow === 6) d.setUTCDate(d.getUTCDate() + 2); // Sat -> Mon
    if (dow === 7) d.setUTCDate(d.getUTCDate() + 1); // Sun -> Mon
    return d;
  }

  // 依「最新日期 end8Anchor」算區間起點（週：以週一為起點；月/年：自然回推，落週末則推到週一）
  function calcRangeStart(end8Anchor, key) {
    const endDt = ymdToDate(end8Anchor);

    if (key === 'all') return null;

    if (key === 'w1') {
      return startOfWeekMonday(endDt);
    }
    if (key === 'w2') {
      const mon = startOfWeekMonday(endDt);
      mon.setUTCDate(mon.getUTCDate() - 7);
      return mon;
    }

    if (key === 'm1') return nextMondayIfWeekend(addMonthsUTC(endDt, -1));
    if (key === 'm2') return nextMondayIfWeekend(addMonthsUTC(endDt, -2));
    if (key === 'm3') return nextMondayIfWeekend(addMonthsUTC(endDt, -3));
    if (key === 'm6') return nextMondayIfWeekend(addMonthsUTC(endDt, -6));
    if (key === 'y1') return nextMondayIfWeekend(addMonthsUTC(endDt, -12));

    return null;
  }

  // 只篩「交易行」，但回傳的 start8/end8 一律用「完整區間」：end8=end8Anchor（即使該日沒交易）
  function filterCanonByRange(fullCanon, rangeKey, end8Anchor) {
    const rows = parseCanon(fullCanon);
    if (!rows.length) return { text: fullCanon, start8: '', end8: '' };

    const end8 = end8Anchor;
    const startDt = calcRangeStart(end8Anchor, rangeKey);

    if (!startDt) {
      const start8 = rows[0].ts.slice(0, 8);
      return { text: fullCanon, start8, end8 };
    }

    const start8  = dateToYmd(startDt);
    const startTS = start8 + '000000';
    const endTS   = end8   + '235959';

    const picked = rows.filter(r => r.ts >= startTS && r.ts <= endTS).map(r => r.line);
    return { text: picked.join('\n'), start8, end8 };
  }

  // 建立「週一~週五」完整交易日序列（字串 YYYY-MM-DD）
  function buildBizDayLabels(start8, end8) {
    const startDt = ymdToDate(start8);
    const endDt   = ymdToDate(end8);
    const out = [];

    const cur = new Date(startDt.getTime());
    while (cur.getTime() <= endDt.getTime()) {
      const dow = dowMon1(cur);
      if (dow >= 1 && dow <= 5) {
        const ymd = dateToYmd(cur);
        out.push(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`);
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  // 取得 Chart 物件（id or element）
  function getChartByCanvasId(id) {
    try {
      return window.Chart?.getChart?.(id) || window.Chart?.getChart?.($('#' + id));
    } catch {
      return null;
    }
  }

  // 將上圖 equityChart 的 labels/datasets 強制改成完整交易日序列；缺日使用「前值」；若最前面無值則用 0
  function forceEquityChartToBizDays(start8, end8) {
    const ch = getChartByCanvasId('equityChart');
    if (!ch || !ch.data?.datasets?.length) return null;

    const targetLabels = buildBizDayLabels(start8, end8);

    // 解析原 labels -> YYYY-MM-DD
    const srcLabels = (ch.data.labels || []).map(x => String(x));
    function toISO(lab) {
      const s = String(lab).trim();
      const m1 = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
      if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
      const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
      const m3 = s.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
      return m3 ? `${m3[1]}-${m3[2]}-${m3[3]}` : null;
    }

    const idxMap = new Map();
    for (let i = 0; i < srcLabels.length; i++) {
      const iso = toISO(srcLabels[i]);
      if (iso) idxMap.set(iso, i);
    }

    // 重建每一條 dataset
    const newDataAll = ch.data.datasets.map(ds => {
      const src = (ds.data || []).map(v => (v == null ? null : Number(v)));
      const out = [];
      let last = 0;              // 若區間起點前沒有資料，起點用 0
      let hasAny = false;

      for (const iso of targetLabels) {
        if (idxMap.has(iso)) {
          const v = src[idxMap.get(iso)];
          if (Number.isFinite(v)) {
            last = v;
            hasAny = true;
          }
          out.push(last);
        } else {
          // 缺日：如果尚未遇到任何有效值，仍保持 0；遇到後 carry-forward
          out.push(hasAny ? last : 0);
        }
      }
      return out;
    });

    ch.data.labels = targetLabels;
    ch.data.datasets.forEach((ds, i) => { ds.data = newDataAll[i]; });

    try { ch.update('none'); } catch { ch.update(); }
    return { labels: targetLabels, datasets: ch.data.datasets };
  }

  // 用上圖「含滑價總損益」推每日損益（delta），缺日自然變 0；重建下圖
  function rebuildDailyPnlChartFromEquity() {
    const eq = getChartByCanvasId('equityChart');
    if (!eq || !eq.data?.labels?.length || !eq.data?.datasets?.length) return;

    const labels = eq.data.labels.map(x => String(x));

    // 找「含滑價總損益」dataset（找不到就取第 0 條）
    let idx = 0;
    for (let i = 0; i < eq.data.datasets.length; i++) {
      const name = String(eq.data.datasets[i]?.label || '');
      if (name.includes('含滑價') && name.includes('總損益')) { idx = i; break; }
      if (name.includes('含滑價') && name.includes('總')) { idx = i; break; }
      if (name.includes('含滑價總')) { idx = i; break; }
    }

    const series = (eq.data.datasets[idx].data || []).map(v => Number(v) || 0);

    const daily = [];
    for (let i = 0; i < series.length; i++) {
      daily.push(i === 0 ? 0 : (series[i] - series[i - 1]));
    }

    // 你要的顏色：>0紅、<0綠、=0灰
    const bg = daily.map(v => (v > 0 ? '#e60000' : (v < 0 ? '#0a7f00' : '#c0c0c0')));

    // destroy 舊的 weeklyPnlChart
    const old = getChartByCanvasId('weeklyPnlChart');
    if (old) { try { old.destroy(); } catch {} }

    const ctx = $('#weeklyPnlChart')?.getContext?.('2d');
    if (!ctx) return;

    new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '每日損益',
          data: daily,
          backgroundColor: bg,
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true }
        },
        scales: {
          x: {
            type: 'category',
            ticks: { autoSkip: true, maxRotation: 0 }
          },
          y: {
            ticks: { callback: (v) => v }
          }
        }
      }
    });
  }

  // 交易明細上色：點數 + 四個損益欄（理論/累積理論/實際/累積實際）
  function applyTradeTableColors() {
    const tbody = $('#tradesBody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    if (!rows.length) return;

    // 依你表頭固定 index：
    // 4 點數
    // 7 理論淨損益
    // 8 累積理論淨損益
    // 9 實際淨損益
    // 10 累積實際淨損益
    const idxs = [4, 7, 8, 9, 10];

    function parseNum(txt) {
      const s0 = String(txt || '').trim();
      if (!s0 || s0 === '—' || s0 === '-') return null;
      // 去逗號/去空白/保留負號
      const s = s0.replace(/,/g, '').replace(/\s+/g, '');
      // 抓第一個數字（含負號、小數）
      const m = s.match(/-?\d+(?:\.\d+)?/);
      if (!m) return null;
      const v = Number(m[0]);
      return Number.isFinite(v) ? v : null;
    }

    for (const tr of rows) {
      const tds = tr.querySelectorAll('td');
      if (!tds || tds.length < 11) continue;

      for (const i of idxs) {
        const td = tds[i];
        const v = parseNum(td?.textContent);
        if (v == null) continue;

        td.style.fontWeight = '600';
        if (v > 0) td.style.color = '#e60000';
        else if (v < 0) td.style.color = '#0a7f00';
        else td.style.color = ''; // 0 不改
      }
    }
  }

  // 等 single-trades.js 完成繪圖/填表再做後處理（最多等 60 次 * 50ms = 3 秒）
  async function postProcessWait(start8, end8) {
    let tries = 0;
    while (tries < 60) {
      const eq = getChartByCanvasId('equityChart');
      const tb = $('#tradesBody');
      if (eq && eq.data?.datasets?.length && tb) break;
      await new Promise(r => setTimeout(r, 50));
      tries++;
    }

    // 1) 上圖強制補齊交易日（缺日=0/前值持平）
    forceEquityChartToBizDays(start8, end8);

    // 2) 下圖改每日損益，並與上圖對齊
    rebuildDailyPnlChartFromEquity();

    // 3) 交易表上色
    applyTradeTableColors();
  }

  // ===== 主流程 =====
  let __FULL_CANON = '';
  let __LATEST_NAME = '0807.txt';
  let __END8_ANCHOR = ''; // 以 FULL_CANON 最大日期為錨（即使該日沒交易也要顯示）

  async function applyRangeAndRun(rangeKey) {
    if (!__FULL_CANON || !__END8_ANCHOR) return;

    forceSlipDefault2();
    setActiveChip(rangeKey);
    setKpiVisible(rangeKey === 'all');

    const r = filterCanonByRange(__FULL_CANON, rangeKey, __END8_ANCHOR);

    // 期間顯示：用完整 start/end（end=anchor）
    if (elPeriod) elPeriod.textContent = `期間：${r.start8 || '—'} 開始到 ${r.end8 || '—'} 結束`;

    const withInpos = addFakeInpos(r.text);
    const finalText = '0807 MERGED\n' + withInpos;

    setStatus(`套用時區：${rangeKey}，重算中…`);
    await feedToSingleTrades(__LATEST_NAME, finalText);

    // 後處理：補齊日序列 + 下圖每日損益 + 交易表上色
    await postProcessWait(r.start8, r.end8);

    setStatus(`分析完成（時區：${rangeKey}）。`);
  }

  async function boot() {
    try {
      if (!sb) {
        setStatus('Supabase SDK 未載入，請檢查引用順序或網路。', true);
        return;
      }

      forceSlipDefault2();

      const url       = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest = null;
      let list   = [];

      if (paramFile) {
        latest = { name: paramFile.split('/').pop() || '0807.txt', fullPath: paramFile, from: 'url' };
      } else {
        setStatus('從 Supabase（reports）讀取清單…');
        list = (await listCandidates()).filter(f => WANT.test(f.name) || WANT.test(f.fullPath));
        if (!list.length) {
          setStatus('找不到檔名含「0807」的 TXT（可用 ?file= 指定）。', true);
          return;
        }
        list.sort((a, b) => {
          const sa = lastDateScore(a.name);
          const sb2 = lastDateScore(b.name);
          if (sa !== sb2) return sb2 - sa;
          if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
          return (b.size || 0) - (a.size || 0);
        });
        latest = list[0];
      }

      __LATEST_NAME = latest.name;
      if (elLatest) elLatest.textContent = latest.name;

      let base = null;
      if (!paramFile) {
        const manifest = await readManifest();
        if (manifest?.baseline_path) {
          base = list.find(x => x.fullPath === manifest.baseline_path) ||
                 { name: manifest.baseline_path.split('/').pop() || manifest.baseline_path, fullPath: manifest.baseline_path };
        } else {
          base = list[1] || null;
        }
      }
      if (elBase) elBase.textContent = base ? base.name : '（尚無）';

      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedCanon = rNew.canon;

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase = await fetchSmart(baseUrl);
        const m = mergeByBaseline(rBase.canon, rNew.canon);
        mergedCanon = m.combined;
      }

      __FULL_CANON = mergedCanon;

      // 以 FULL_CANON 最大日期當錨（很重要：即使最新日沒交易，也要當區間 end）
      const fullRows = parseCanon(__FULL_CANON);
      __END8_ANCHOR = fullRows.length ? fullRows[fullRows.length - 1].ts.slice(0, 8) : '';

      if (!__END8_ANCHOR) {
        setStatus('合併後資料沒有合法交易行。', true);
        return;
      }

      // baseline button
      if (btnBase) {
        btnBase.disabled = false;
        btnBase.onclick = async () => {
          try {
            const payload = { baseline_path: latest.fullPath, updated_at: new Date().toISOString() };
            await writeManifest(payload);
            btnBase.textContent = '已設為基準';
          } catch (e) {
            setStatus('寫入基準失敗：' + (e.message || e), true);
          }
        };
      }

      if (rangeChips) {
        rangeChips.addEventListener('click', (ev) => {
          const btn = ev.target?.closest?.('.range-chip');
          if (!btn) return;
          const key = btn.dataset.range || 'all';
          applyRangeAndRun(key);
        });
      }

      setActiveChip('all');
      setKpiVisible(true);

      // 先顯示全期間（期間顯示用全段 start8~anchor）
      const start8All = fullRows[0].ts.slice(0, 8);
      if (elPeriod) elPeriod.textContent = `期間：${start8All} 開始到 ${__END8_ANCHOR} 結束`;

      setStatus('已載入（合併後）資料，開始分析…');
      await applyRangeAndRun('all');

    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
