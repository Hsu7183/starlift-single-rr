// 1001.js — 以「次新檔」為基準合併後，直接餵給 single-trades.js（自動計算）
// 分析資料 = 基準全段 + 最新檔的新增；畫面只顯示期間＋KPI＋資產曲線
// ★對齊 0807 基準：滑點預設=2 且首次載入即用2計算；不使用 manifest；基準固定次新檔(唯讀)
// ★修正(1)：最新檔若包含「比基準更早的歷史段」，會補在最前面（避免 2020~2023 被截掉）
// ★修正(2)：輸出前做「配對清洗」，確保 canonical 行永遠是 開倉→平倉 成對，避免 single-trades.js 後段位移
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');

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

  const WANT = /1001/i;

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
        name     : it.name,
        fullPath : p + it.name,
        updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0,
        size     : it.metadata?.size || 0
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
      .replace(/\ufeff/gi, '')                  // BOM
      .replace(/\u200b|\u200c|\u200d/gi, '')    // 零寬字元
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');// 控制碼

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
      if (m) rows.push({ ts: m[1], line, act: m[3] });
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows;
  }

  // ===== 合併（補頭段 + 補尾段）=====
  // combined = (latest 補在基準前面的更早段) + base 全部 + (latest 補在基準後面的新增尾段)
  function mergeByBaseline(baseText, latestText) {
    const A = parseCanon(baseText);    // base
    const B = parseCanon(latestText);  // latest

    const baseMinTs = A.length ? A[0].ts : (B.length ? B[0].ts : '');
    const baseMaxTs = A.length ? A[A.length - 1].ts : '';

    const head = (baseMinTs)
      ? B.filter(x => x.ts < baseMinTs).map(x => x.line)
      : [];

    const tail = (baseMaxTs)
      ? B.filter(x => x.ts > baseMaxTs).map(x => x.line)
      : B.map(x => x.line);

    const mergedLines = [...head, ...A.map(x => x.line), ...tail];

    const start8 = mergedLines.length
      ? mergedLines[0].match(CANON_RE)[1].slice(0, 8)
      : '';

    const end8 = mergedLines.length
      ? mergedLines[mergedLines.length - 1].match(CANON_RE)[1].slice(0, 8)
      : start8;

    return {
      combined: mergedLines.join('\n'),
      start8,
      end8
    };
  }

  // ===== 配對清洗：確保 canonical 行為「開倉→平倉」成對，避免後段位移 =====
  function sanitizeCanonPaired(canonText) {
    const rows = parseCanon(canonText);
    if (!rows.length) return { canon: '', start8: '', end8: '' };

    const isEntry = (a) => (a === '新買' || a === '新賣');
    const isExit  = (a) => (a === '平賣' || a === '平買' || a === '強制平倉');

    const out = [];
    let hasOpen = false;

    for (const r of rows) {
      const act = r.act;

      if (!hasOpen) {
        // 沒有 open：只接受開倉，丟掉孤兒平倉
        if (isEntry(act)) {
          out.push(r.line);
          hasOpen = true;
        }
        continue;
      }

      // 有 open：只接受平倉，若又遇到開倉則丟掉（避免連續開倉造成位移）
      if (isExit(act)) {
        out.push(r.line);
        hasOpen = false;
      } else if (isEntry(act)) {
        // drop
      }
    }

    // 若最後還有 open 沒平倉，直接丟掉最後那筆開倉，確保輸出為偶數成對
    if (out.length % 2 === 1) out.pop();

    const start8 = out.length ? out[0].match(CANON_RE)[1].slice(0, 8) : '';
    const end8   = out.length ? out[out.length - 1].match(CANON_RE)[1].slice(0, 8) : start8;

    return { canon: out.join('\n'), start8, end8 };
  }

  // ===== 把合併後內容餵給 single-trades.js =====
  async function feedToSingleTrades(filename, mergedText) {
    const fileInput = $('#fileInput');
    const runBtn    = $('#runBtn');

    // 對齊 0807：確保第一次自動計算就用滑點=2
    const slipInput = $('#slipInput');
    if (slipInput) {
      slipInput.value = '2';
      slipInput.dispatchEvent(new Event('input',  { bubbles: true }));
      slipInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const fname = filename || '1001.txt';
    const file  = new File([mergedText], fname, { type: 'text/plain' });

    if (window.__singleTrades_setFile) {
      window.__singleTrades_setFile(file);
    }

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 延後一個 tick，避免 race condition（先用舊 slip 計算）
    if (runBtn) {
      setTimeout(() => runBtn.click(), 0);
    }
  }

  // ===== 主流程 =====
  async function boot() {
    try {
      const url       = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest = null;
      let list   = [];

      // 1) 決定最新檔
      if (paramFile) {
        latest = {
          name    : paramFile.split('/').pop() || '1001.txt',
          fullPath: paramFile,
          from    : 'url'
        };
      } else {
        setStatus('從 Supabase（reports）讀取 1001 清單…');
        list = (await listCandidates()).filter(f =>
          WANT.test(f.name) || WANT.test(f.fullPath)
        );

        if (!list.length) {
          setStatus('找不到檔名含「1001」的 TXT（可用 ?file= 指定）。', true);
          return;
        }

        // 排序：檔名最大日期 > updatedAt > size
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
        setStatus('找不到可分析的 1001 檔案。', true);
        return;
      }
      if (elLatest) elLatest.textContent = latest.name;

      // 2) 基準檔：固定用「次新檔」（不讀 manifest，完全乾淨）
      let base = null;
      if (!paramFile) {
        base = list[1] || null;
      }

      if (elBase) elBase.textContent = base ? base.name : '（尚無）';

      // 3) 下載最新檔 & 基準檔，做 canonical 化與合併
      setStatus('下載最新 1001 檔案並解碼中…');

      const latestUrl = latest.from === 'url'
        ? latest.fullPath
        : pubUrl(latest.fullPath);

      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedText = rNew.canon;
      let start8 = '';
      let end8   = '';

      if (base) {
        setStatus('下載 1001 基準檔並進行合併…');
        const baseUrl = base.from === 'url'
          ? base.fullPath
          : pubUrl(base.fullPath);
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

      // 4) 配對清洗（避免後段位移）
      const cleaned = sanitizeCanonPaired(mergedText);
      mergedText = cleaned.canon;
      start8 = cleaned.start8 || start8;
      end8   = cleaned.end8   || end8;

      if (elPeriod) {
        elPeriod.textContent = `期間：${start8 || '—'} 開始到 ${end8 || '—'} 結束`;
      }

      // 5) 「設此為基準」：此頁固定唯讀（不寫入，避免任何額外紅字）
      if (btnBase) {
        btnBase.disabled = true;
        btnBase.textContent = '唯讀模式';
        btnBase.title = '此頁不寫入基準（不使用 manifest），基準固定為次新檔。';
        btnBase.onclick = null;
      }

      // 6) 加 header + canonical 3 欄餵給 single-trades.js
      const finalText = '1001 MERGED\n' + mergedText;

      setStatus('已載入（合併後）1001 資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（可調整本頁「本金／滑點」即時重算 KPI）。');
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
