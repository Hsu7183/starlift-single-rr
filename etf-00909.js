// etf-00909.js — 控制器（全費口徑 + 累計成本 + 單位平均報酬率 + 最佳化交易明細 1-1-2）
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m, b = false) => { if (status) { status.textContent = m; status.style.color = b ? '#c62828' : '#666'; } };

  // ===== 基本設定 =====
  const CFG = {
    symbol: '00909', bucket: 'reports', want: /00909/i,
    manifestPath: 'manifests/etf-00909.json',
    feeRate: 0.001425, taxRate: 0.001, minFee: 20,
    tickSize: 0.01, slippageTick: 0, unitShares: 1000, rf: 0.00, initialCapital: 1_000_000
  };

  // ===== 最佳化交易明細參數（固定 1-1-2）=====
  const OPT = {
    capital: 1_000_000,          // 本金
    unitShares: CFG.unitShares,  // 每單位股數
    // 僅三次: 1, 1, 2；若段內只有 1 或 2 筆買，就取 [1] 或 [1,1]
    baseSeq: [1, 1, 2]
  };

  // 參數小卡
  $('#feeRateChip').textContent = (CFG.feeRate * 100).toFixed(4) + '%';
  $('#taxRateChip').textContent = (CFG.taxRate * 100).toFixed(3) + '%';
  $('#minFeeChip').textContent = CFG.minFee.toString();
  $('#unitChip').textContent = CFG.unitShares.toString();
  $('#slipChip').textContent = CFG.slippageTick.toString();
  $('#rfChip').textContent = (CFG.rf * 100).toFixed(2) + '%';

  // ===== Supabase =====
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });
  const pubUrl = (path) => { const { data } = sb.storage.from(CFG.bucket).getPublicUrl(path); return data?.publicUrl || '#'; };

  // list / manifest
  async function listOnce(prefix) {
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(CFG.bucket).list(p, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(error.message);
    return (data || []).map(it => ({ name: it.name, fullPath: p + it.name, updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0, size: it.metadata?.size || 0 }));
  }
  async function listCandidates() { const u = new URL(location.href); const prefix = u.searchParams.get('prefix') || ''; return listOnce(prefix); }
  const lastDateScore = (name) => { const m = String(name).match(/\b(20\d{6})\b/g); return m && m.length ? Math.max(...m.map(s => +s || 0)) : 0; };
  async function readManifest() { try { const { data } = await sb.storage.from(CFG.bucket).download(CFG.manifestPath); if (!data) return null; return JSON.parse(await data.text()); } catch { return null; } }
  async function writeManifest(obj) { const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }); await sb.storage.from(CFG.bucket).upload(CFG.manifestPath, blob, { upsert: true, cacheControl: '0', contentType: 'application/json' }); }

  // 多編碼打分選優
  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-store' }); if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const trials = ['big5', 'utf-8', 'utf-16le', 'utf-16be', 'windows-1252'];
    let best = { score: -1, txt: '' };
    for (const enc of trials) {
      let txt = ''; try { txt = new TextDecoder(enc, { fatal: false }).decode(buf).replace(/\ufeff/gi, ''); } catch { continue; }
      const head = txt.slice(0, 1000), bad = (head.match(/\uFFFD/g) || []).length, kw = (/日期|時間|動作|買進|賣出|加碼/.test(head) ? 1 : 0);
      const lines = (txt.match(/^\d{8}[,\t]\d{5,6}[,\t]\d+(?:\.\d+)?[,\t].+$/gm) || []).length;
      const score = kw * 1000 + lines * 10 - bad;
      if (score > best.score) best = { score, txt };
    }
    return best.txt || new TextDecoder('utf-8').decode(buf);
  }

  // ===== 渲染：KPI略（保留 round-trip 表）=====
  function renderTradesTable(trades) {
    const thead = $('#tradeTable thead'), tbody = $('#tradeTable tbody');
    thead.innerHTML = `
      <tr>
        <th>方向</th><th>進場時間</th><th>進場價</th>
        <th>出場時間</th><th>出場價</th><th>股數</th>
        <th>買方手續費</th><th>賣方手續費</th><th>賣方交易稅</th>
        <th>損益</th><th>持有天數</th>
      </tr>`;
    tbody.innerHTML = '';
    for (const t of trades) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${t.side}</td>
        <td>${t.inTs}</td>
        <td>${t.inPx.toFixed(2)}</td>
        <td>${t.outTs}</td>
        <td>${t.outPx.toFixed(2)}</td>
        <td>${t.shares.toLocaleString()}</td>
        <td>${t.buyFee.toLocaleString()}</td>
        <td>${t.sellFee.toLocaleString()}</td>
        <td>${t.sellTax.toLocaleString()}</td>
        <td>${Math.round(t.pnl).toLocaleString()}</td>
        <td>${t.holdDays.toFixed(2)}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ===== 共用工具 =====
  const fmtPct = v => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(2) + '%';
  const pnlSpan = v => { const cls = v > 0 ? 'pnl-pos' : (v < 0 ? 'pnl-neg' : ''); return `<span class="${cls}">${Math.round(v || 0).toLocaleString()}</span>`; };
  const tsPretty = ts14 => `${ts14.slice(0, 4)}/${ts14.slice(4, 6)}/${ts14.slice(6, 8)} ${ts14.slice(8, 10)}:${ts14.slice(10, 12)}`;

  // ====== 生成「交易明細」表 ======
  function renderExecsTable(execs) {
    const thead = $('#execTable thead'), tbody = $('#execTable tbody');
    thead.innerHTML = `
      <tr>
        <th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>
        <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
        <th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th>
      </tr>`;
    tbody.innerHTML = '';
    for (const e of execs) {
      const tr = document.createElement('tr'); tr.className = (e.side === 'BUY' ? 'buy-row' : 'sell-row');
      tr.innerHTML = `
        <td>${e.side === 'BUY' ? '買進' : '賣出'}</td>
        <td>${tsPretty(e.ts)}</td>
        <td>${e.price.toFixed(2)}</td>
        <td>${e.avgCost != null ? e.avgCost.toFixed(2) : '—'}</td>
        <td>${e.shares.toLocaleString()}</td>
        <td>${Math.round(e.buyAmount || 0).toLocaleString()}</td>
        <td>${Math.round(e.sellAmount || 0).toLocaleString()}</td>
        <td>${Math.round(e.fee || 0).toLocaleString()}</td>
        <td>${Math.round(e.tax || 0).toLocaleString()}</td>
        <td>${Math.round(e.cost || 0).toLocaleString()}</td>
        <td>${Math.round(e.cumCost || 0).toLocaleString()}</td>
        <td>${e.pnlFull == null ? '—' : pnlSpan(e.pnlFull)}</td>
        <td>${fmtPct(e.retPctUnit)}</td>
        <td>${e.cumPnlFull == null ? '—' : pnlSpan(e.cumPnlFull)}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ===== 生成「最佳化交易明細」表（本金 100 萬；比例固定 1-1-2；每段最多 3 筆買）=====
  function renderOptTable(optExecs) {
    const thead = $('#optTable thead'), tbody = $('#optTable tbody');
    thead.innerHTML = `
      <tr>
        <th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>
        <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
        <th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th>
      </tr>`;
    tbody.innerHTML = '';
    for (const e of optExecs) {
      const tr = document.createElement('tr'); tr.className = (e.side === 'BUY' ? 'buy-row' : 'sell-row');
      tr.innerHTML = `
        <td>${e.side === 'BUY' ? '買進' : '賣出'}</td>
        <td>${tsPretty(e.ts)}</td>
        <td>${e.price.toFixed(2)}</td>
        <td>${e.avgCost != null ? e.avgCost.toFixed(2) : '—'}</td>
        <td>${e.shares.toLocaleString()}</td>
        <td>${Math.round(e.buyAmount || 0).toLocaleString()}</td>
        <td>${Math.round(e.sellAmount || 0).toLocaleString()}</td>
        <td>${Math.round(e.fee || 0).toLocaleString()}</td>
        <td>${Math.round(e.tax || 0).toLocaleString()}</td>
        <td>${Math.round(e.cost || 0).toLocaleString()}</td>
        <td>${Math.round(e.cumCost || 0).toLocaleString()}</td>
        <td>${e.pnlFull == null ? '—' : pnlSpan(e.pnlFull)}</td>
        <td>${fmtPct(e.retPctUnit)}</td>
        <td>${e.cumPnlFull == null ? '—' : pnlSpan(e.cumPnlFull)}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ===== 依本金計算「最佳化」每段下單數量（固定 1-1-2）=====
  function fees(price, shares, isSell) {
    const gross = price * shares;
    const fee = Math.max(CFG.minFee, gross * CFG.feeRate);
    const tax = isSell ? (gross * CFG.taxRate) : 0;
    return { gross, fee, tax };
  }
  function buyCost(price, lots) {
    const shares = lots * OPT.unitShares;
    const f = fees(price, shares, false);
    return f.gross + f.fee;
  }
  function sellSettle(price, shares) {
    const f = fees(price, shares, true);
    return { amount: f.gross, fee: f.fee, tax: f.tax };
  }

  // 將 engine 的 execs（原始）分段 → 每段 [BUY..., SELL]
  function splitSegments(execs) {
    const segs = []; let cur = [];
    for (const e of execs) {
      cur.push(e);
      if (e.side === 'SELL') { segs.push(cur); cur = []; }
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  function buildOptimizedExecs(execs) {
    const segments = splitSegments(execs);
    const out = [];
    let cumPnlAll = 0;

    for (const seg of segments) {
      const buys = seg.filter(x => x.side === 'BUY');
      const sell = seg.find(x => x.side === 'SELL');
      if (!buys.length || !sell) continue;

      // 只取前三筆 BUY，比例依序 [1], [1,1], [1,1,2]
      const n = Math.min(3, buys.length);
      const ratio = OPT.baseSeq.slice(0, n);

      // 以實際各買價計算成本，找最大整數 k 使 Σ cost(k*ratio_i) <= capital
      // 先求上界：粗估用最便宜價
      const cheapest = Math.min(...buys.slice(0, n).map(b => b.price));
      let hi = Math.max(1, Math.floor(OPT.capital / (buyCost(cheapest, ratio.reduce((a, b) => a + b, 0)))));
      while (hi > 0 && totalCost(hi) > OPT.capital) hi--; // 回退到可行
      // 確保至少 1，如果連 1 都買不了則跳過（本段不下單）
      if (hi <= 0) continue;
      const k = hi;

      // 依 k*ratio 生成最佳化買入
      let sharesHeld = 0, avgCost = 0, cumCost = 0;  // 累計成本（含買方手續費）
      const unitCount = ratio.reduce((a, b) => a + b, 0) * k;

      for (let i = 0; i < n; i++) {
        const b = buys[i];
        const lots = k * ratio[i];
        const shares = lots * OPT.unitShares;
        const f = fees(b.price, shares, false);
        const cost = f.gross + f.fee;

        // 更新均價（不含費用）
        const newAvg = (sharesHeld * avgCost + b.price * shares) / (sharesHeld + shares || 1);
        sharesHeld += shares; avgCost = newAvg; cumCost += cost;

        out.push({
          side: 'BUY', ts: b.ts, tsMs: b.tsMs, price: b.price,
          avgCost: newAvg, shares,
          buyAmount: f.gross, sellAmount: 0,
          fee: f.fee, tax: 0,
          cost, cumCost,
          pnlFull: null, retPctUnit: null, cumPnlFull: cumPnlAll
        });
      }

      // 賣出：一次賣出 sharesHeld
      if (sharesHeld > 0) {
        const s = sell;
        const st = sellSettle(s.price, sharesHeld);
        const pnlFull = st.amount - cumCost - (st.fee + st.tax);
        const retPctUnit = (unitCount > 0 && cumCost > 0) ? (pnlFull / (cumCost / unitCount)) : null;
        cumPnlAll += pnlFull;

        out.push({
          side: 'SELL', ts: s.ts, tsMs: s.tsMs, price: s.price,
          avgCost, shares: sharesHeld,
          buyAmount: 0, sellAmount: st.amount,
          fee: st.fee, tax: st.tax,
          cost: 0, cumCost,
          pnlFull, retPctUnit, cumPnlFull: cumPnlAll
        });
      }

      // 工具：計算某 k 的總買入成本（含買方手續費）
      function totalCost(kTest) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += buyCost(buys[i].price, kTest * ratio[i]);
        return sum;
      }
    }
    return out;
  }

  // ===== 主流程：下載→解析→分析→渲染 =====
  async function boot() {
    try {
      const u = new URL(location.href); const paramFile = u.searchParams.get('file');

      // 最新 + 基準
      let latest = null, list = [];
      if (paramFile) { latest = { name: paramFile.split('/').pop() || '00909.txt', fullPath: paramFile, from: 'url' }; }
      else {
        set('從 Supabase（reports）讀取清單…');
        list = (await listCandidates()).filter(f => CFG.want.test(f.name) || CFG.want.test(f.fullPath));
        list.sort((a, b) => { const sa = lastDateScore(a.name), sb = lastDateScore(b.name);
          if (sa !== sb) return sb - sa; if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt; return (b.size || 0) - (a.size || 0); });
        latest = list[0];
      }
      if (!latest) { set('找不到檔名含「00909」的 TXT（可用 ?file= 指定）。', true); return; }
      $('#latestName').textContent = latest.name;

      let base = null; const manifest = await readManifest();
      if (manifest?.baseline_path) {
        base = list.find(x => x.fullPath === manifest.baseline_path) || { name: manifest.baseline_path.split('/').pop(), fullPath: manifest.baseline_path };
      } else { base = list[1] || null; }
      $('#baseName').textContent = base ? base.name : '（尚無）';

      // 下載/解析/合併
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const txtNew = await fetchText(latestUrl);
      const rowsNew = window.ETF_ENGINE.parseCanon(txtNew);
      if (rowsNew.length === 0) { set('最新檔沒有可解析的交易行。', true); return; }

      let rowsMerged = rowsNew, start8 = '', end8 = '';
      if (base) {
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rowsBase = window.ETF_ENGINE.parseCanon(await fetchText(baseUrl));
        const m = mergeRowsByBaseline(rowsBase, rowsNew);
        rowsMerged = m.merged; start8 = m.start8; end8 = m.end8;
      } else { start8 = rowsNew[0].day; end8 = rowsNew.at(-1).day; }
      $('#periodText').textContent = `期間：${start8 || '—'} 開始到 ${end8 || '—'} 結束`;

      // 設基準
      const btn = $('#btnSetBaseline'); btn.disabled = false; btn.onclick = async () => {
        try { await writeManifest({ baseline_path: latest.from === 'url' ? latest.fullPath : latest.fullPath, updated_at: new Date().toISOString() }); btn.textContent = '已設為基準'; }
        catch (e) { set('寫入基準失敗：' + (e.message || e), true); }
      };

      // 分析（由 engine 輸出「交易明細 execs」）
      set('已載入（合併後）資料，開始分析…');
      const bt = window.ETF_ENGINE.backtest(rowsMerged, CFG);

      // 交易明細（原）
      renderExecsTable(bt.execs);

      // 最佳化交易明細（依 1-1-2 比例與本金 100 萬計算）
      const optExecs = buildOptimizedExecs(bt.execs);
      renderOptTable(optExecs);

      set('完成。');
    } catch (err) {
      set('初始化失敗：' + (err && err.message ? err.message : String(err)), true);
      console.error('[00909 ERROR]', err);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
