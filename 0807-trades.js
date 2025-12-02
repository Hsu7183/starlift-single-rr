// 0807-trades.js
// 讀取 0807 KPI 版 TF_1m（中文：新買/平賣 + INPOS），產生交易明細表

(function () {
  'use strict';

  // ===== 參數設定 =====
  const CFG = {
    pointValue: 200,    // 每點金額
    feePerSide: 45,     // 單邊手續費（進 45 + 出 45 = 90）
    taxRate: 0.00002,   // 期交稅率（單邊），這裡用雙邊合計
    slipPointsRT: 0     // 一 round-trip 滑價點數（先 0）
  };

  // ===== 小工具 =====
  const $ = (s) => document.querySelector(s);

  const fmtInt = (n) => {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  };

  const fmtSignedInt = (n) => {
    if (n == null || !isFinite(n)) return '—';
    const v = Math.round(n);
    return v.toLocaleString('en-US');
  };

  const clsForNumber = (n) => {
    if (n == null || !isFinite(n) || n === 0) return '';
    return n > 0 ? 'num-pos' : 'num-neg';
  };

  // 20240102130100 → "2024/1/2 13:01"
  function formatTs(ts) {
    if (!ts || ts.length < 12) return ts || '';
    const y = ts.slice(0, 4);
    const m = ts.slice(4, 6);
    const d = ts.slice(6, 8);
    const hh = ts.slice(8, 10);
    const mm = ts.slice(10, 12);
    return `${y}/${parseInt(m, 10)}/${parseInt(d, 10)} ${hh}:${mm}`;
  }

  // ===== 解析 TXT：新買/新賣/平買/平賣/強制平倉 + INPOS =====
  function parseTxt(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return { header: null, trades: [] };

    const header = lines[0]; // BeginTime=...,EndTime=...,ForceExitTime=...

    const actionRe = /(新買|新賣|平買|平賣|強制平倉)$/;
    const events = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;

      const last = parts[parts.length - 1];

      // INPOS 行：時間 價格 High Low dir entry INPOS  → 直接略過
      if (last === 'INPOS') continue;

      // 只抓最後一欄是 新買/新賣/平買/平賣/強制平倉 的行
      if (!actionRe.test(last)) continue;

      const ts = parts[0];
      const px = parseFloat(parts[1]);
      if (!isFinite(px)) continue;

      events.push({
        ts,
        px,
        action: last
      });
    }

    // 把事件串成 round-trip
    const trades = [];
    let open = null;

    const isEntry = (a) => (a === '新買' || a === '新賣');
    const isExit  = (a) => (a === '平買' || a === '平賣' || a === '強制平倉');

    for (const ev of events) {
      if (isEntry(ev.action)) {
        // 若前一筆還沒平倉，就直接覆蓋（理論上不會發生）
        open = {
          ts: ev.ts,
          px: ev.px,
          action: ev.action,
          dir: (ev.action === '新買') ? +1 : -1
        };
      } else if (isExit(ev.action) && open) {
        const dir = open.dir;
        const entryPx = open.px;
        const exitPx  = ev.px;

        const points = dir > 0
          ? (exitPx - entryPx)
          : (entryPx - exitPx);

        const gross = points * CFG.pointValue;

        const fee = CFG.feePerSide * 2; // 進 + 出
        const taxBase = (entryPx + exitPx) * CFG.pointValue;
        const tax = Math.round(taxBase * CFG.taxRate);

        const theoNet = gross - fee - tax;
        const slipCost = CFG.slipPointsRT * CFG.pointValue;
        const actualNet = theoNet - slipCost;

        trades.push({
          entry: { ts: open.ts, px: open.px, action: open.action },
          exit:  { ts: ev.ts,   px: ev.px,   action: ev.action },
          dir,
          points,
          fee,
          tax,
          theoNet,
          actualNet
        });

        open = null;
      }
    }

    return { header, trades };
  }

  // ===== 畫交易明細表 =====
  function renderTrades(parsed) {
    const tbody = $('#tradesBody');
    tbody.innerHTML = '';

    let cumTheo = 0;
    let cumActual = 0;

    parsed.trades.forEach((t, idx) => {
      cumTheo   += t.theoNet;
      cumActual += t.actualNet;

      const tr1 = document.createElement('tr');
      const tr2 = document.createElement('tr');

      // 進場列
      tr1.innerHTML = `
        <td rowspan="2">${idx + 1}</td>
        <td>${formatTs(t.entry.ts)}</td>
        <td>${fmtInt(t.entry.px)}</td>
        <td>${t.entry.action}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
      `;

      // 出場列
      tr2.innerHTML = `
        <td>${formatTs(t.exit.ts)}</td>
        <td>${fmtInt(t.exit.px)}</td>
        <td>${t.exit.action}</td>
        <td class="${clsForNumber(t.points)}">${fmtSignedInt(t.points)}</td>
        <td>${fmtInt(t.fee)}</td>
        <td>${fmtInt(t.tax)}</td>
        <td class="${clsForNumber(t.theoNet)}">${fmtInt(t.theoNet)}</td>
        <td class="${clsForNumber(cumTheo)}">${fmtInt(cumTheo)}</td>
        <td class="${clsForNumber(t.actualNet)}">${fmtInt(t.actualNet)}</td>
        <td class="${clsForNumber(cumActual)}">${fmtInt(cumActual)}</td>
      `;
      tbody.appendChild(tr1);
      tbody.appendChild(tr2);
    });
  }

  // ===== 檔案載入事件 =====
  $('#fileInput').addEventListener('change', function (ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      const text = e.target.result || '';
      const parsed = parseTxt(text);
      renderTrades(parsed);
    };
    reader.readAsText(file);  // Big5 也沒關係，中文壞掉沒影響，我們只用數字跟「新買/平賣」關鍵字
  });

})();
