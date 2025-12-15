// 0807-1.js — 支援「時區快選」：近1週/近2週/近1月/…/近1年/全
// 規則：以最新日期為基準往回推；週類型以「週一」對齊；只有「全」顯示 KPI，其它只顯示圖表+交易明細
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');
  const tfRow    = $('#tfRow');
  const tfHint   = $('#tfHint');

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
    let bad = 0;

    for (const l of lines) {
      const m = l.match(EXTRACT_RE);
      if (m) {
        const ts  = m[1];
        const pxN = Number(m[2]);
        const px6 = Number.isFinite(pxN) ? pxN.toFixed(6) : m[2];
        const act = m[3];
        out.push(`${ts}.000000 ${px6} ${act}`);
        ok++;
      } else {
        bad++;
      }
    }
    return { canon: out.join('\n'), ok, bad };
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

    return {
      combined: mergedLines.join('\n'),
      start8  : baseMin,
      end8    : endDay
    };
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
    } catch (e) {
      return null;
    }
  }

  async function writeManifest(obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(
      MANIFEST_PATH, blob,
      { upsert: true, cacheControl: '0', contentType: 'application/json' }
    );
    if (error) throw new Error(error.message);
  }

  // ====== 時區計算（以最新日期為錨） ======
  function ymd8ToDateLocal(ymd8) {
    const y = Number(ymd8.slice(0,4));
    const m = Number(ymd8.slice(4,6));
    const d = Number(ymd8.slice(6,8));
    return new Date(y, m - 1, d, 12, 0, 0, 0); // 用中午避免 DST/跨日問題
  }

  function dateToYmd8(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dd= String(d.getDate()).padStart(2,'0');
    return `${y}${m}${dd}`;
  }

  function mondayOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    const day = x.getDay(); // 0=Sun,1=Mon...
    const diff = (day === 0) ? -6 : (1 - day);
    x.setDate(x.getDate() + diff);
    return x;
  }

  function shiftMonths(d, monthsBack) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    x.setMonth(x.getMonth() - monthsBack);
    return x;
  }

  function shiftYears(d, yearsBack) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    x.setFullYear(x.getFullYear() - yearsBack);
    return x;
  }

  function fmtROC(ymd8) {
    if (!ymd8 || ymd8.length !== 8) return '—';
    const y = Number(ymd8.slice(0,4)) - 1911;
    const m = Number(ymd8.slice(4,6));
    const d = Number(ymd8.slice(6,8));
    return `${y}/${m}/${d}`;
  }

  function setKpiVisible(visible) {
    const nodes = document.querySelectorAll('.kpi-only');
    nodes.forEach(n => n.classList.toggle('hidden', !visible));
  }

  function setActiveTF(tf) {
    if (!tfRow) return;
    tfRow.querySelectorAll('.tf-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tf === tf);
    });
  }

  // ====== 全域狀態（避免每次切時區都重抓 Supabase） ======
  let gLatestName = '0807.txt';
  let gCanonRows  = [];      // 全部 canonical rows（排序後）
  let gStart8All  = '';
  let gEnd8All    = '';

  function filterRowsByRange(start8, end8) {
    if (!gCanonRows.length) return [];
    return gCanonRows.filter(r => {
      const ymd8 = r.ts.slice(0,8);
      return ymd8 >= start8 && ymd8 <= end8;
    });
  }

  async function applyTimeframe(tf) {
    if (!gCanonRows.length) return;

    const end8 = gEnd8All;
    const endD = ymd8ToDateLocal(end8);

    let start8 = gStart8All;
    let label  = '全';

    if (tf === 'w1' || tf === 'w2') {
      const w = (tf === 'w1') ? 1 : 2;
      const mon = mondayOfWeek(endD);
      mon.setDate(mon.getDate() - 7 * (w - 1));
      start8 = dateToYmd8(mon);
      label  = (w === 1) ? '近1週' : '近2週';
    } else if (tf === 'm1' || tf === 'm2' || tf === 'm3' || tf === 'm6') {
      const n = ({ m1:1, m2:2, m3:3, m6:6 })[tf];
      const sD = shiftMonths(endD, n);
      start8 = dateToYmd8(sD);
      label  = `近${n}月`;
    } else if (tf === 'y1') {
      const sD = shiftYears(endD, 1);
      start8 = dateToYmd8(sD);
      label  = '近1年';
    } else {
      tf = 'all';
      start8 = gStart8All;
      label  = '全';
    }

    // 只取有交易行的區間；但期間文字照你規格顯示「起～迄」
    const rows = (tf === 'all') ? gCanonRows : filterRowsByRange(start8, end8);
    const textForSingle = rows.map(r => r.line).join('\n');
    const withInpos = addFakeInpos(textForSingle);
    const finalText = '0807 MERGED\n' + withInpos;

    // KPI 顯示規則：只有 all 顯示
    const showKpi = (tf === 'all');
    setKpiVisible(showKpi);

    setActiveTF(tf);
    if (tfHint) tfHint.textContent = `時區：${label}${showKpi ? '（顯示 KPI）' : '（僅圖表＋明細）'}`;

    if (elPeriod) {
      elPeriod.textContent = `期間：${fmtROC(start8)} ~ ${fmtROC(end8)}（以最新日為基準）`;
    }

    setStatus(`套用時區：${label}，重新分析中…`);
    await feedToSingleTrades(gLatestName, finalText);
    setStatus(`分析完成（時區：${label}）。`);
  }

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
      gLatestName = latest.name;

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

      // 3) 下載 & canonical 合併
      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = (latest.from === 'url') ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedText = rNew.canon;
      let start8 = '';
      let end8   = '';

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = (base.from === 'url') ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);

        const m = mergeByBaseline(rBase.canon, rNew.canon);
        mergedText = m.combined;
        start8     = m.start8;
        end8       = m.end8;
      } else {
        const rows = parseCanon(rNew.canon);
        start8 = rows.length ? rows[0].ts.slice(0, 8) : '';
        end8   = rows.length ? rows[rows.length - 1].ts.slice(0, 8) : '';
      }

      // 保存全域 rows（供快選時區切換）
      gCanonRows = parseCanon(mergedText);     // {ts,line} sorted
      gStart8All = start8 || (gCanonRows[0]?.ts.slice(0,8) || '');
      gEnd8All   = end8   || (gCanonRows[gCanonRows.length-1]?.ts.slice(0,8) || '');

      // 4) 設基準按鈕
      if (btnBase) {
        btnBase.disabled = false;
        btnBase.onclick = async () => {
          try {
            const payload = {
              baseline_path: (latest.from === 'url') ? latest.fullPath : latest.fullPath,
              updated_at: new Date().toISOString()
            };
            await writeManifest(payload);
            btnBase.textContent = '已設為基準';
          } catch (e) {
            setStatus('寫入基準失敗：' + (e.message || e), true);
          }
        };
      }

      // 5) 綁定快選
      if (tfRow) {
        tfRow.addEventListener('click', async (ev) => {
          const btn = ev.target && ev.target.closest && ev.target.closest('.tf-btn');
          if (!btn) return;
          const tf = btn.dataset.tf || 'all';
          await applyTimeframe(tf);
        });
      }

      // 6) 預設：全（顯示 KPI）
      setStatus('已載入（合併後）資料，開始分析…');
      await applyTimeframe('all');

    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
