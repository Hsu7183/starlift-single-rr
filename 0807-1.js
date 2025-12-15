// 0807-1.js — 時區快選(按鈕) + 只在「全」顯示 KPI + 日線補 0 + 上下圖交易日對齊
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const status     = $('#autostatus');
  const elLatest   = $('#latestName');
  const elBase     = $('#baseName');
  const elPeriod   = $('#periodText');
  const btnBase    = $('#btnSetBaseline');

  const scoreCard  = $('#scoreCard');
  const kpiBadWrap = $('#kpiBadWrap');
  const kpiAllWrap = $('#kpiAllWrap');

  if (status) status.style.whiteSpace = 'pre-wrap';

  // Supabase 設定（與其他頁一致）
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  if (!window.supabase) {
    console.error('Supabase SDK 未載入');
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  // canonical 3 欄行
  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  // ===== runtime caches =====
  let _mergedCanon = '';     // 合併後 canonical（不含 header、不含 fake INPOS）
  let _mergedStart8 = '';
  let _mergedEnd8   = '';
  let _lastTradeDate8 = '';

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

  // ===== 文字正規化 & canonical 行抽取 =====
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

    const added = baseMax
      ? B.filter(x => x.ts > baseMax).map(x => x.line)
      : B.map(x => x.line);

    const mergedLines = [...A.map(x => x.line), ...added];

    const endDay = mergedLines.length
      ? mergedLines[mergedLines.length - 1].match(CANON_RE)[1].slice(0, 8)
      : baseMin;

    return { combined: mergedLines.join('\n'), start8: baseMin, end8: endDay };
  }

  // ===== fake INPOS（給 single-trades.js 判方向用） =====
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

  // ===== manifest =====
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

  // ===== 日期/交易日工具 =====
  function ymd8ToDate(ymd8) {
    const y = +ymd8.slice(0, 4);
    const m = +ymd8.slice(4, 6);
    const d = +ymd8.slice(6, 8);
    return new Date(y, m - 1, d);
  }
  function dateToYmd8(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  function isWeekend(dt) {
    const w = dt.getDay();
    return w === 0 || w === 6;
  }
  function prevTradingDay(dt) {
    const x = new Date(dt.getTime());
    x.setDate(x.getDate() - 1);
    while (isWeekend(x)) x.setDate(x.getDate() - 1);
    return x;
  }
  function tradingDayRangeEndingAt(end8, count) {
    let endD = ymd8ToDate(end8);
    while (isWeekend(endD)) endD = prevTradingDay(endD);

    let startD = new Date(endD.getTime());
    let needed = Math.max(1, count);
    let got = 1;
    while (got < needed) {
      startD = prevTradingDay(startD);
      got++;
    }
    return { start8: dateToYmd8(startD), end8: dateToYmd8(endD) };
  }
  function enumerateTradingDays(start8, end8) {
    const out = [];
    let d = ymd8ToDate(start8);
    const end = ymd8ToDate(end8);
    while (d <= end) {
      if (!isWeekend(d)) out.push(dateToYmd8(d));
      d = new Date(d.getTime());
      d.setDate(d.getDate() + 1);
    }
    return out;
  }
  function rocFmt(ymd8) {
    if (!ymd8 || ymd8.length !== 8) return ymd8 || '';
    const y = +ymd8.slice(0, 4);
    const roc = y - 1911;
    const m = +ymd8.slice(4, 6);
    const d = +ymd8.slice(6, 8);
    return `${roc}/${String(m)}/${String(d)}`;
  }
  function ymd8ToSlash(ymd8) {
    if (!ymd8 || ymd8.length !== 8) return ymd8 || '';
    return `${ymd8.slice(0,4)}/${ymd8.slice(4,6)}/${ymd8.slice(6,8)}`;
  }

  // ===== 時區快選規則（交易日數） =====
  function getRangeByPreset(preset, end8) {
    if (preset === 'all') return { start8: _mergedStart8, end8: _mergedEnd8, showKpi: true };

    const map = {
      w1: 5,
      w2: 10,
      m1: 22,
      m2: 44,
      m3: 66,
      m6: 132,
      y1: 252
    };
    const n = map[preset] || 10;
    const r = tradingDayRangeEndingAt(end8, n);
    return { start8: r.start8, end8: r.end8, showKpi: false };
  }

  // ===== canonical 依日期切片 =====
  function filterCanonByYmdRange(canonText, start8, end8) {
    const rows = parseCanon(canonText);
    const keep = rows.filter(r => {
      const d8 = r.ts.slice(0, 8);
      return d8 >= start8 && d8 <= end8;
    });
    return keep.map(x => x.line).join('\n');
  }

  // ===== feed to single-trades.js =====
  async function feedToSingleTrades(filename, mergedTextWithHeaderAndInpos) {
    const fileInput = $('#fileInput');
    const runBtn    = $('#runBtn');

    const fname = filename || '0807.txt';
    const file  = new File([mergedTextWithHeaderAndInpos], fname, { type: 'text/plain' });

    if (window.__singleTrades_setFile) {
      window.__singleTrades_setFile(file);
    }

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (runBtn) runBtn.click();
  }

  // ===== KPI 顯示切換 =====
  function toggleKpi(show) {
    const on = !!show;
    if (scoreCard)  scoreCard.classList.toggle('hide-kpi', !on);
    if (kpiBadWrap) kpiBadWrap.classList.toggle('hide-kpi', !on);
    if (kpiAllWrap) kpiAllWrap.classList.toggle('hide-kpi', !on);
  }

  // ===== 從 trades table 重建「每日」序列（缺交易日補 0）並重畫兩張圖 =====
  function parseNumber(text) {
    const t = String(text || '').replace(/,/g, '').trim();
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }

  function rebuildDailyCharts(start8, end8) {
    const tbody = $('#tradesBody');
    if (!tbody) return;

    const days = enumerateTradingDays(start8, end8);
    if (!days.length) return;

    const dayPnl = new Map(days.map(d => [d, 0]));

    const rows = Array.from(tbody.querySelectorAll('tr'));
    for (const tr of rows) {
      const tds = tr.querySelectorAll('td');
      if (!tds || tds.length < 11) continue;

      const dtText = (tds[1]?.textContent || '').trim();
      const m = dtText.match(/(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      if (!m) continue;
      const y = m[1];
      const mm = String(m[2]).padStart(2, '0');
      const dd = String(m[3]).padStart(2, '0');
      const d8 = `${y}${mm}${dd}`;
      if (!dayPnl.has(d8)) continue;

      const actual = parseNumber(tds[9]?.textContent);
      const theo   = parseNumber(tds[7]?.textContent);
      const useVal = (tds[9] && tds[9].textContent != null) ? actual : theo;

      dayPnl.set(d8, (dayPnl.get(d8) || 0) + useVal);
    }

    const labels = days.map(d8 => rocFmt(d8));
    const daily  = days.map(d8 => dayPnl.get(d8) || 0);

    let cum = 0;
    const equity = daily.map(v => (cum += v));

    const cEq = $('#equityChart');
    const cPn = $('#weeklyPnlChart'); // 這張改畫「每日損益」，上下同交易日

    try {
      const oldEq = Chart.getChart(cEq);
      if (oldEq) oldEq.destroy();
    } catch (e) {}
    try {
      const oldPn = Chart.getChart(cPn);
      if (oldPn) oldPn.destroy();
    } catch (e) {}

    if (cEq) {
      new Chart(cEq, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: '累積淨損益（每日）',
            data: equity,
            tension: 0.15,
            pointRadius: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { ticks: { maxRotation: 0, autoSkip: true } },
            y: { ticks: { callback: (v) => v } }
          }
        }
      });
    }

    if (cPn) {
      new Chart(cPn, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: '每日淨損益（無交易=0）',
            data: daily
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { ticks: { maxRotation: 0, autoSkip: true } },
            y: { ticks: { callback: (v) => v } }
          }
        }
      });
    }
  }

  // ===== 時區按鈕事件綁定 =====
  function bindRangeButtons() {
    const btns = document.querySelectorAll('.range-btn');
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.range;
        if (!preset) return;

        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        applyRange(preset);
      });
    });
  }

  // ===== 套用時區（重新餵檔、控制 KPI、重畫日線） =====
  async function applyRange(preset) {
    if (!_mergedCanon) return;

    const r = getRangeByPreset(preset, _lastTradeDate8 || _mergedEnd8);
    const start8 = r.start8;
    const end8   = r.end8;

    toggleKpi(r.showKpi);

    if (elPeriod) {
      elPeriod.textContent =
        `期間：${rocFmt(start8) || '—'}（${ymd8ToSlash(start8)}）～ ` +
        `${rocFmt(end8) || '—'}（${ymd8ToSlash(end8)}）`;
    }

    const slicedCanon = filterCanonByYmdRange(_mergedCanon, start8, end8);
    const withInpos = addFakeInpos(slicedCanon);
    const finalText = '0807-1 MERGED\n' + withInpos;

    setStatus(`套用時區：${preset}（${rocFmt(start8)}～${rocFmt(end8)}），重新分析…`);
    await feedToSingleTrades((elLatest?.textContent || '0807.txt'), finalText);

    setTimeout(() => {
      try {
        rebuildDailyCharts(start8, end8);
        setStatus(`分析完成：${rocFmt(start8)}～${rocFmt(end8)}（每日補 0；上下圖交易日對齊）`);
      } catch (e) {
        console.error(e);
        setStatus('圖表重建失敗：' + (e.message || e), true);
      }
    }, 0);
  }

  // ===== 主流程 boot =====
  async function boot() {
    try {
      const url       = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest = null;
      let list   = [];

      // 1) 最新檔
      if (paramFile) {
        latest = {
          name    : paramFile.split('/').pop() || '0807.txt',
          fullPath: paramFile,
          from    : 'url'
        };
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

      if (!latest) {
        setStatus('找不到可分析的 0807 檔案。', true);
        return;
      }
      if (elLatest) elLatest.textContent = latest.name;

      // 2) 基準檔
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

      // 3) 下載 & 合併
      setStatus('下載最新 0807 檔案並解碼中…');

      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
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
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
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

      _mergedCanon     = mergedCanon;
      _mergedStart8    = start8;
      _mergedEnd8      = end8;
      _lastTradeDate8  = end8;

      // 4) 設基準按鈕
      if (btnBase) {
        btnBase.disabled = false;
        btnBase.onclick = async () => {
          try {
            const payload = {
              baseline_path: latest.fullPath,
              updated_at: new Date().toISOString()
            };
            await writeManifest(payload);
            btnBase.textContent = '已設為基準';
          } catch (e) {
            setStatus('寫入基準失敗：' + (e.message || e), true);
          }
        };
      }

      // 5) 綁定時區按鈕
      bindRangeButtons();

      // 6) 預設「全」
      toggleKpi(true);
      setStatus('已載入（合併後）資料，開始分析…');
      await applyRange('all');

    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
