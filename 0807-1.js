// 0807-1.js — 基準合併 + 自動分析
// 精進：
// 1) 開頁強制 slip=2 並確保「第一次計算就用 slip=2」
// 2) 區間改成按鈕列（主圖 / 週圖 / 交易明細同步篩選）
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');

  const rangeRow   = $('#rangeRow');
  const tradesBody = $('#tradesBody');
  const equityCanvas = $('#equityChart');
  const weeklyCanvas = $('#weeklyPnlChart');

  const slipInput = $('#slipInput');
  const runBtn    = $('#runBtn');

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

  // canonical 3 欄
  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  // =========================
  // 重要：確保首次計算就用 slip=2
  // =========================
  function forceSlip2() {
    if (!slipInput) return;
    slipInput.value = '2';
    slipInput.dispatchEvent(new Event('input', { bubbles: true }));
    slipInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 「補點擊」：避免 click 太早（single-trades.js 尚未綁 handler）
  function safeClickRun(times = 3) {
    if (!runBtn) return;
    const delays = [0, 80, 250, 600];
    for (let i = 0; i < Math.min(times, delays.length); i++) {
      setTimeout(() => {
        forceSlip2();
        runBtn.click();
      }, delays[i]);
    }
  }

  // 頁面一載入先強制一次（避免 single-trades.js 初始化時寫回 0）
  document.addEventListener('DOMContentLoaded', () => {
    forceSlip2();
  });

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

    s = s.replace(/\r\n?/g, '\n')
         .replace(/\u3000/g, ' ');

    const lines = s
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

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
    const lines = (text || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

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
    const fname = filename || '0807.txt';
    const file  = new File([mergedText], fname, { type: 'text/plain' });

    // 關鍵：餵檔前再次確保 slip=2
    forceSlip2();

    if (window.__singleTrades_setFile) {
      window.__singleTrades_setFile(file);
    }

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 關鍵：不要只 click 一次，做延遲補點擊
    safeClickRun(4);
  }

  async function readManifest() {
    try {
      const { data, error } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
      if (error || !data) return null;
      const text = await data.text();
      return JSON.parse(text);
    } catch (e) {
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

  // ======================================================================
  // 區間篩選（Chart.js + 交易明細）
  // ======================================================================
  const SNAP = { ready: false, eq: null, wk: null, trades: null, lastDate: null };

  function ymdToDate(ymd) {
    const y = Number(ymd.slice(0,4));
    const m = Number(ymd.slice(4,6));
    const d = Number(ymd.slice(6,8));
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }
  function ts14ToDate(ts14) {
    if (!ts14 || ts14.length < 8) return null;
    return ymdToDate(ts14.slice(0,8));
  }
  function parseAnyDate(x) {
    if (!x) return null;
    if (x instanceof Date) return x;
    if (typeof x === 'number') {
      const d = new Date(x);
      return isNaN(d.getTime()) ? null : d;
    }
    const s = String(x).trim();

    // 先抓 YYYYMMDD（最穩）
    const m0 = s.match(/\b(20\d{6})\b/);
    if (m0) return ymdToDate(m0[1]);

    // YYYY/MM/DD or YYYY-MM-DD
    const m1 = s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (m1) return new Date(+m1[1], +m1[2]-1, +m1[3]);

    // YYYY/MM or YYYY-MM
    const m2 = s.match(/\b(20\d{2})[\/\-](\d{1,2})\b/);
    if (m2) return new Date(+m2[1], +m2[2]-1, 1);

    return null;
  }

  function isoWeekLabelToDate(label) {
    const s = String(label || '').trim();
    let y = 0, w = 0;
    let m = s.match(/\b(20\d{2})\s*[-\/]?\s*W(\d{1,2})\b/i);
    if (m) { y = +m[1]; w = +m[2]; }
    if (!y || !w) {
      m = s.match(/\b(20\d{2})\s*[-\/]\s*(\d{1,2})\b/);
      if (m) { y = +m[1]; w = +m[2]; }
    }
    if (!y || !w) return null;

    const simple = new Date(y, 0, 1 + (w - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = new Date(simple);
    if (dow <= 4) ISOweekStart.setDate(simple.getDate() - (dow === 0 ? 6 : dow - 1));
    else ISOweekStart.setDate(simple.getDate() + (8 - dow));
    return ISOweekStart;
  }

  function cutoffFromRange(lastDate, code) {
    if (!lastDate || !(lastDate instanceof Date)) return null;
    const d = new Date(lastDate);
    const days = (n) => { const x = new Date(d); x.setDate(x.getDate() - n); return x; };
    switch (code) {
      case '1Y': return days(365);
      case '6M': return days(182);
      case '3M': return days(91);
      case '2M': return days(60);
      case '1M': return days(30);
      case '2W': return days(14);
      case '1W': return days(7);
      case 'ALL':
      default:   return null;
    }
  }

  // ✅ 固定筆數回推（保證一定會切得到，避免「按了沒反應」）
  // 這裡用交易日近似：1W=5日、2W=10日、1M=22日...
  const RANGE_POINTS = {
    '1W': 5,
    '2W': 10,
    '1M': 22,
    '2M': 44,
    '3M': 66,
    '6M': 132,
    '1Y': 260
  };
  const WEEK_POINTS = { // weekly chart fallback
    '1W': 4,
    '2W': 8,
    '1M': 13,
    '2M': 26,
    '3M': 39,
    '6M': 78,
    '1Y': 104
  };

  // ✅ 這裡是關鍵修正：不要因 labels 解析不到就 return false
  function snapshotOnce() {
    if (SNAP.ready) return true;

    const eq = equityCanvas ? Chart.getChart(equityCanvas) : null;
    const wk = weeklyCanvas ? Chart.getChart(weeklyCanvas) : null;
    if (!eq || !eq.data?.labels?.length || !eq.data?.datasets?.length) return false;

    // 先 snapshot 圖表資料（不依賴日期解析）
    SNAP.eq = {
      labels: eq.data.labels.slice(),
      datasets: eq.data.datasets.map(ds => ({ data: Array.isArray(ds.data) ? ds.data.slice() : [] }))
    };

    if (wk && wk.data?.labels?.length && wk.data?.datasets?.length) {
      SNAP.wk = {
        labels: wk.data.labels.slice(),
        datasets: wk.data.datasets.map(ds => ({ data: Array.isArray(ds.data) ? ds.data.slice() : [] }))
      };
    }

    // snapshot 交易明細（同時用最後一筆推 lastDate）
    const tradeRows = Array.from(tradesBody?.querySelectorAll('tr') || []);
    SNAP.trades = {
      rows: tradeRows.map(tr => {
        const tds = tr.querySelectorAll('td');
        const dtText = (tds && tds[1]) ? tds[1].textContent.trim() : '';
        const m = dtText.match(/\b(20\d{12})\b/);
        const ts14 = m ? m[1] : '';
        const d = ts14 ? ts14ToDate(ts14) : parseAnyDate(dtText);
        const ymd = d ? (
          String(d.getFullYear()).padStart(4,'0') +
          String(d.getMonth()+1).padStart(2,'0') +
          String(d.getDate()).padStart(2,'0')
        ) : '';
        return { ymd, html: tr.outerHTML };
      })
    };

    // 先嘗試從 labels 找 lastDate
    let lastDate = null;
    for (let i = SNAP.eq.labels.length - 1; i >= 0; i--) {
      const dt = parseAnyDate(SNAP.eq.labels[i]);
      if (dt) { lastDate = dt; break; }
    }

    // ✅ 若 labels 找不到，就用交易明細最後一筆（最穩）
    if (!lastDate && SNAP.trades.rows.length) {
      for (let i = SNAP.trades.rows.length - 1; i >= 0; i--) {
        const ymd = SNAP.trades.rows[i].ymd;
        if (ymd && ymd.length === 8) {
          lastDate = ymdToDate(ymd);
          break;
        }
      }
    }

    // 再不行就用今天（避免整個篩選失效）
    if (!lastDate) lastDate = new Date();

    SNAP.lastDate = lastDate;
    SNAP.ready = true;
    return true;
  }

  function setActiveRangeBtn(code) {
    if (!rangeRow) return;
    const btns = Array.from(rangeRow.querySelectorAll('.range-btn'));
    btns.forEach(b => b.classList.toggle('active', (b.dataset.range === code)));
  }

  // ✅ 這裡是關鍵修正：日期切不到時，改用固定筆數回推
  function applyFilter(rangeCode) {
    if (!snapshotOnce()) return;

    const eq = equityCanvas ? Chart.getChart(equityCanvas) : null;
    const wk = weeklyCanvas ? Chart.getChart(weeklyCanvas) : null;
    if (!eq) return;

    const cut = cutoffFromRange(SNAP.lastDate, rangeCode);

    // 1) 主圖
    const L = SNAP.eq.labels;
    let keepIdx = [];

    if (!cut) {
      keepIdx = L.map((_, i) => i);
    } else {
      for (let i = 0; i < L.length; i++) {
        const dt = parseAnyDate(L[i]);
        if (dt && dt >= cut) keepIdx.push(i);
      }

      // 如果 labels 不可解析導致 keepIdx 空、或 keepIdx 幾乎等於全段 → 用固定筆數回推
      const fallbackN = RANGE_POINTS[rangeCode] || 0;
      if (keepIdx.length === 0 || keepIdx.length >= L.length - 1) {
        if (fallbackN > 0) {
          const start = Math.max(0, L.length - fallbackN);
          keepIdx = [];
          for (let i = start; i < L.length; i++) keepIdx.push(i);
        } else {
          keepIdx = L.map((_, i) => i);
        }
      }
    }

    eq.data.labels = keepIdx.map(i => L[i]);
    eq.data.datasets.forEach((ds, k) => {
      const orig = SNAP.eq.datasets[k]?.data || [];
      ds.data = keepIdx.map(i => orig[i]);
    });
    eq.update('none');

    // 2) 週圖（同樣：日期切不到就用固定筆數）
    if (wk && SNAP.wk) {
      const WL = SNAP.wk.labels;
      let wKeep = [];

      if (!cut) {
        wKeep = WL.map((_, i) => i);
      } else {
        for (let i = 0; i < WL.length; i++) {
          const dt = isoWeekLabelToDate(WL[i]) || parseAnyDate(WL[i]);
          if (dt && dt >= cut) wKeep.push(i);
        }

        const fallbackW = WEEK_POINTS[rangeCode] || 0;
        if (wKeep.length === 0 || wKeep.length >= WL.length - 1) {
          if (fallbackW > 0) {
            const start = Math.max(0, WL.length - fallbackW);
            wKeep = [];
            for (let i = start; i < WL.length; i++) wKeep.push(i);
          } else {
            wKeep = WL.map((_, i) => i);
          }
        }
      }

      wk.data.labels = wKeep.map(i => WL[i]);
      wk.data.datasets.forEach((ds, k) => {
        const orig = SNAP.wk.datasets[k]?.data || [];
        ds.data = wKeep.map(i => orig[i]);
      });
      wk.update('none');
    }

    // 3) 交易明細（這段你原本就對）
    if (tradesBody && SNAP.trades) {
      const rows = SNAP.trades.rows;
      let html = '';

      if (!cut) {
        html = rows.map(r => r.html).join('');
      } else {
        const cutYMD =
          String(cut.getFullYear()).padStart(4,'0') +
          String(cut.getMonth()+1).padStart(2,'0') +
          String(cut.getDate()).padStart(2,'0');

        const kept = rows.filter(r => !r.ymd || r.ymd >= cutYMD);
        html = kept.map(r => r.html).join('');
      }

      tradesBody.innerHTML = html;

      // 重新編號
      const trs = Array.from(tradesBody.querySelectorAll('tr'));
      trs.forEach((tr, i) => {
        const td0 = tr.querySelector('td');
        if (td0) td0.textContent = String(i + 1);
      });
    }

    setActiveRangeBtn(rangeCode);
  }

  function hookRangeButtons() {
    if (!rangeRow) return;
    rangeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      const code = btn.dataset.range || 'ALL';
      applyFilter(code);
    });
  }

  function waitAndInitFilter() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const ok = snapshotOnce();
      if (ok) {
        clearInterval(timer);
        hookRangeButtons();
        applyFilter('ALL');
      }
      if (tries > 160) clearInterval(timer);
    }, 100);
  }

  // ======================================================================
  // 主流程
  // ======================================================================
  async function boot() {
    try {
      if (!sb) {
        setStatus('Supabase SDK 未載入或初始化失敗。', true);
        return;
      }

      // 再保險一次：開頁就把 slip 固定到 2
      forceSlip2();

      const url       = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest = null;
      let list   = [];

      // 1) 決定最新檔
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

      if (!latest) { setStatus('找不到可分析的 0807 檔案。', true); return; }
      if (elLatest) elLatest.textContent = latest.name;

      // 2) 決定基準檔
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

      // 3) 下載最新檔
      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) { setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true); return; }

      let mergedText = rNew.canon;
      let start8 = '', end8 = '';

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);
        const m = mergeByBaseline(rBase.canon, rNew.canon);
        mergedText = m.combined;
        start8 = m.start8;
        end8   = m.end8;
      } else {
        const rows = parseCanon(rNew.canon);
        start8 = rows.length ? rows[0].ts.slice(0, 8) : '';
        end8   = rows.length ? rows[rows.length - 1].ts.slice(0, 8) : '';
      }

      if (elPeriod) elPeriod.textContent = `期間：${start8 || '—'} 開始到 ${end8 || '—'} 結束`;

      // 4) 設基準按鈕
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

      // 5) 插入假的 INPOS + header，餵 single-trades.js
      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText       = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（可調整本頁「本金／滑點」即時重算 KPI）。');

      // 6) 等圖表/表格完成後，啟用區間按鈕
      waitAndInitFilter();
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  async function listCandidates2() {
    const u      = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }
  // 兼容你原本結尾覆蓋（避免改動過大）
  async function listCandidates() { return listCandidates2(); }

  document.addEventListener('DOMContentLoaded', boot);
})();
