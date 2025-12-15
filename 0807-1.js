// 0807-1.js — 時區快選（週對齊週一）；只有 ALL 顯示 KPI；
// 圖表改為「日頻交易日」：補齊無交易日=0，並讓上下圖日期完全對齊。
// 修正：等待 single-trades.js 完成渲染 trades 表後，再重建日頻圖（避免全 0 水平線）
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');

  const rangeBar  = $('#rangeBar');
  const rangeHint = $('#rangeHint');

  const scoreCard  = $('#scoreCard');
  const kpiBadWrap = $('#kpiBadWrap');
  const kpiAllWrap = $('#kpiAllWrap');

  const canvasEquity = $('#equityChart');
  const canvasDaily  = $('#weeklyPnlChart'); // 這張改成「每日損益圖」（仍沿用原 id）

  if (status) status.style.whiteSpace = 'pre-wrap';

  // Supabase 設定
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
      } catch (e) {}
    }

    const td = new TextDecoder('utf-8');
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

  async function feedToSingleTrades(filename, mergedText) {
    const fileInput = $('#fileInput');
    const runBtn    = $('#runBtn');

    const fname = filename || '0807.txt';
    const file  = new File([mergedText], fname, { type: 'text/plain' });

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
      const text = await data.text();
      return JSON.parse(text);
    } catch (e) { return null; }
  }

  async function writeManifest(obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(
      MANIFEST_PATH, blob, { upsert: true, cacheControl: '0', contentType: 'application/json' }
    );
    if (error) throw new Error(error.message);
  }

  // ===== 日期工具（交易日：週一到週五）=====
  function ymdToDate(ymd) {
    const y = +ymd.slice(0,4), m = +ymd.slice(4,6), d = +ymd.slice(6,8);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }
  function dateToYmd(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth()+1).padStart(2,'0');
    const d = String(dt.getDate()).padStart(2,'0');
    return `${y}${m}${d}`;
  }
  function mondayOfWeek(dt) {
    const x = new Date(dt.getTime());
    const day = x.getDay(); // 0=Sun..6=Sat
    const diff = (day === 0) ? 6 : (day - 1);
    x.setDate(x.getDate() - diff);
    return x;
  }
  function addDays(dt, n) { const x = new Date(dt.getTime()); x.setDate(x.getDate()+n); return x; }
  function addMonths(dt, n) {
    const x = new Date(dt.getTime());
    const d = x.getDate();
    x.setMonth(x.getMonth() + n);
    if (x.getDate() !== d) x.setDate(0);
    return x;
  }
  function fmtYmdSlash(ymd) { return `${ymd.slice(0,4)}/${ymd.slice(4,6)}/${ymd.slice(6,8)}`; }
  function isWeekend(dt) { const g = dt.getDay(); return g === 0 || g === 6; }
  function genBizDays(startYmd, endYmd) {
    const out = [];
    if (!startYmd || !endYmd) return out;
    let cur = ymdToDate(startYmd);
    const end = ymdToDate(endYmd);
    while (cur.getTime() <= end.getTime()) {
      if (!isWeekend(cur)) out.push(dateToYmd(cur));
      cur = addDays(cur, 1);
    }
    return out;
  }

  const STATE = {
    fullWithInpos: '',
    startYmd: '',
    endYmd: '',
    lastDateObj: null,
    curStartYmd: '',
    curEndYmd: ''
  };

  function setKpiVisibility(isAll) {
    if (scoreCard)  scoreCard.style.display  = isAll ? '' : 'none';
    if (kpiBadWrap) kpiBadWrap.style.display = isAll ? '' : 'none';
    if (kpiAllWrap) kpiAllWrap.style.display = isAll ? '' : 'none';
  }

  function setActiveRangeBtn(rangeKey) {
    if (!rangeBar) return;
    const btns = rangeBar.querySelectorAll('button[data-range]');
    btns.forEach(b => b.classList.toggle('active', b.getAttribute('data-range') === rangeKey));
  }

  function computeRange(rangeKey) {
    const endYmd = STATE.endYmd;
    const endDt  = STATE.lastDateObj;
    const allStartYmd = STATE.startYmd;

    if (!endYmd || !endDt) return { startYmd: allStartYmd, endYmd };

    if (rangeKey === 'ALL') return { startYmd: allStartYmd, endYmd };

    if (rangeKey === 'W1' || rangeKey === 'W2') {
      const w = (rangeKey === 'W1') ? 1 : 2;
      const monThis = mondayOfWeek(endDt);
      const startDt = addDays(monThis, -7 * (w - 1));
      return { startYmd: dateToYmd(startDt), endYmd };
    }

    const mMap = { M1:-1, M2:-2, M3:-3, M6:-6 };
    if (mMap[rangeKey]) {
      const startDt = addMonths(endDt, mMap[rangeKey]);
      return { startYmd: dateToYmd(startDt), endYmd };
    }

    if (rangeKey === 'Y1') {
      const startDt = addMonths(endDt, -12);
      return { startYmd: dateToYmd(startDt), endYmd };
    }

    return { startYmd: allStartYmd, endYmd };
  }

  function filterTextByYmd(fullTextWithInpos, startYmd, endYmd) {
    const lines = (fullTextWithInpos || '').split('\n');
    if (!lines.length) return fullTextWithInpos;

    const head = lines[0];
    const kept = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const m = line.match(/^(\d{14})/);
      if (!m) continue;
      const ymd = m[1].slice(0,8);
      if (ymd >= startYmd && ymd <= endYmd) kept.push(line);
    }
    return head + '\n' + kept.join('\n');
  }

  // ===== 關鍵修正：等待 trades 表渲染完成 =====
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForTradesReady(timeoutMs = 6000) {
    const t0 = Date.now();
    const tbody = $('#tradesBody');
    if (!tbody) return false;

    // 至少等到下一輪 render
    await sleep(0);

    while (Date.now() - t0 < timeoutMs) {
      const n = tbody.querySelectorAll('tr').length;
      // 有些版本可能先塞一行 placeholder，所以用 >=2 更保險；但你的資料通常很多筆
      if (n >= 1) return true;
      await sleep(50);
    }
    return false;
  }

  // ===== 2) 日頻補 0 圖表：從交易明細表重建兩張圖 =====
  function parseNumberLoose(s) {
    const x = Number(String(s).replace(/[, ]/g,''));
    return Number.isFinite(x) ? x : 0;
  }

  function extractYmdFromDateTimeCell(text) {
    const t = String(text || '');
    let m = t.match(/\b(20\d{2})[\/\-](\d{2})[\/\-](\d{2})\b/);
    if (m) return `${m[1]}${m[2]}${m[3]}`;
    m = t.match(/\b(20\d{6})\b/);
    if (m) return m[1];
    return '';
  }

  function rebuildDailyCharts(startYmd, endYmd) {
    if (!window.Chart || !canvasEquity || !canvasDaily) return;

    const bizDays = genBizDays(startYmd, endYmd);
    if (!bizDays.length) return;

    const cap = parseNumberLoose($('#capitalInput')?.value || '1000000');

    const pnlByDay = new Map();
    const tbody = $('#tradesBody');
    if (tbody) {
      const rows = tbody.querySelectorAll('tr');
      rows.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 11) return;

        const dtText = tds[1]?.textContent || '';
        const ymd = extractYmdFromDateTimeCell(dtText);
        if (!ymd) return;

        const actualPnlText = tds[9]?.textContent || '0';
        const actualPnl = parseNumberLoose(actualPnlText);

        pnlByDay.set(ymd, (pnlByDay.get(ymd) || 0) + actualPnl);
      });
    }

    const dailyPnl = bizDays.map(d => pnlByDay.get(d) || 0);
    const equity   = [];
    let cum = 0;
    for (const p of dailyPnl) {
      cum += p;
      equity.push(cap + cum);
    }

    const labels = bizDays.map(fmtYmdSlash);

    const c1 = window.Chart.getChart(canvasEquity);
    if (c1) c1.destroy();
    const c2 = window.Chart.getChart(canvasDaily);
    if (c2) c2.destroy();

    new window.Chart(canvasEquity.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '資產曲線（含滑價，日頻）',
          data: equity,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.15
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true } },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true } },
          y: { ticks: { callback: (v) => String(v) } }
        }
      }
    });

    new window.Chart(canvasDaily.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '每日淨損益（含滑價，補 0）',
          data: dailyPnl,
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true } },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true } },
          y: { ticks: { callback: (v) => String(v) } }
        }
      }
    });
  }

  async function applyRange(rangeKey) {
    const rk = rangeKey || 'ALL';
    const { startYmd, endYmd } = computeRange(rk);

    STATE.curStartYmd = startYmd;
    STATE.curEndYmd   = endYmd;

    setActiveRangeBtn(rk);
    setKpiVisibility(rk === 'ALL');

    if (rangeHint) {
      rangeHint.textContent =
        `顯示區間：${fmtYmdSlash(startYmd)} ～ ${fmtYmdSlash(endYmd)}（錨：${fmtYmdSlash(STATE.endYmd)}）`;
    }
    if (elPeriod) {
      elPeriod.textContent = `期間（全資料）：${STATE.startYmd || '—'} 開始到 ${STATE.endYmd || '—'} 結束`;
    }

    const fullText = '0807 MERGED\n' + STATE.fullWithInpos;
    const filtered = (rk === 'ALL') ? fullText : filterTextByYmd(fullText, startYmd, endYmd);

    setStatus(`套用時區 ${rk}，重新計算中…`);
    await feedToSingleTrades(`0807_${rk}.txt`, filtered);

    // 等 single-trades.js 把 trades 表渲染完，再重建日頻補0圖
    const ok = await waitForTradesReady(7000);
    if (!ok) {
      setStatus('警告：等待交易明細渲染逾時，日頻圖可能暫時顯示為 0（可再按一次「計算」或切換時區）。', true);
      // 仍嘗試重建一次（至少有軸）
      rebuildDailyCharts(startYmd, endYmd);
      return;
    }

    rebuildDailyCharts(startYmd, endYmd);
    setStatus(`完成：目前顯示 ${fmtYmdSlash(startYmd)} ～ ${fmtYmdSlash(endYmd)}。`);
  }

  function bindRangeUI() {
    if (!rangeBar) return;
    rangeBar.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest('button[data-range]');
      if (!btn) return;
      applyRange(btn.getAttribute('data-range') || 'ALL');
    });
  }

  async function boot() {
    try {
      if (!sb) {
        setStatus('Supabase SDK 未載入或初始化失敗。', true);
        return;
      }

      bindRangeUI();

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
          const sb = lastDateScore(b.name);
          if (sa !== sb) return sb - sa;
          if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
          return (b.size || 0) - (a.size || 0);
        });

        latest = list[0];
      }

      if (!latest) { setStatus('找不到可分析的 0807 檔案。', true); return; }
      if (elLatest) elLatest.textContent = latest.name;

      let base = null;
      if (!paramFile) {
        const manifest = await readManifest();
        if (manifest?.baseline_path) {
          base =
            list.find(x => x.fullPath === manifest.baseline_path) ||
            { name: manifest.baseline_path.split('/').pop() || manifest.baseline_path, fullPath: manifest.baseline_path };
        } else {
          base = list[1] || null;
        }
      }
      if (elBase) elBase.textContent = base ? base.name : '（尚無）';

      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = (latest.from === 'url') ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedCanon = rNew.canon;
      let start8 = '';
      let end8   = '';

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = (base.from === 'url') ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);

        const m = mergeByBaseline(rBase.canon, rNew.canon);
        mergedCanon = m.combined;
        start8 = m.start8;
        end8   = m.end8;
      } else {
        const rows = parseCanon(rNew.canon);
        start8 = rows.length ? rows[0].ts.slice(0, 8) : '';
        end8   = rows.length ? rows[rows.length - 1].ts.slice(0, 8) : '';
      }

      if (btnBase) {
        btnBase.disabled = false;
        btnBase.onclick = async () => {
          try {
            await writeManifest({ baseline_path: latest.fullPath, updated_at: new Date().toISOString() });
            btnBase.textContent = '已設為基準';
          } catch (e) {
            setStatus('寫入基準失敗：' + (e.message || e), true);
          }
        };
      }

      const rowsMerged = parseCanon(mergedCanon);
      const trueStartYmd = rowsMerged.length ? rowsMerged[0].ts.slice(0,8) : (start8 || '');
      const trueEndYmd   = rowsMerged.length ? rowsMerged[rowsMerged.length-1].ts.slice(0,8) : (end8 || '');

      STATE.fullWithInpos = addFakeInpos(mergedCanon);
      STATE.startYmd = trueStartYmd;
      STATE.endYmd   = trueEndYmd;
      STATE.lastDateObj = trueEndYmd ? ymdToDate(trueEndYmd) : null;

      if (elPeriod) elPeriod.textContent = `期間（全資料）：${STATE.startYmd || '—'} 開始到 ${STATE.endYmd || '—'} 結束`;

      setKpiVisibility(true);
      if (rangeHint) {
        rangeHint.textContent =
          `顯示區間：${fmtYmdSlash(STATE.startYmd)} ～ ${fmtYmdSlash(STATE.endYmd)}（錨：${fmtYmdSlash(STATE.endYmd)}）`;
      }

      setStatus('已載入（合併後）資料，開始分析（全）…');
      await feedToSingleTrades(latest.name, '0807 MERGED\n' + STATE.fullWithInpos);

      const ok = await waitForTradesReady(7000);
      rebuildDailyCharts(STATE.startYmd, STATE.endYmd);

      if (!ok) {
        setStatus('分析完成，但交易明細渲染較慢：日頻圖已生成日期軸，若仍為水平線可再按一次「計算」。', true);
      } else {
        setStatus('分析完成。可用「時區快選」切換（非全區間將隱藏 KPI，只顯示圖表+交易明細）。');
      }

    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
