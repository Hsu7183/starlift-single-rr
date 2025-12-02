// 0807-trades.js
// 讀取 0807 KPI 版 TF_1m（事件行：時間 價格 中文；持倉行：... INPOS）
// 不看中文字，純靠欄位數 + INPOS 判斷進出場。

(function () {
  'use strict';

  // ===== 參數設定 =====
  const CFG = {
    pointValue: 200,    // 每點金額
    feePerSide: 45,     // 單邊手續費
    taxRate: 0.00002,   // 期交稅率（單邊）
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

  // 往後掃第一行 INPOS，抓方向 dir（+1 多 / -1 空）
  function getDirFromInpos(lines, startIdx) {
    const maxLookAhead = 300;
    const total = lines.length;

    for (let j = startIdx + 1; j < total && j <= startIdx + maxLookAhead; j++) {
      const line = lines[j];
      const ps = line.split(/\s+/);
      if (!ps.length) continue;

      // INPOS：時間 mid low dir entry INPOS
      if (ps.length >= 6 && ps[ps.length - 1] === 'INPOS') {
        const dir = parseInt(ps[3], 10);
        if (dir === 1 || dir === -1) return dir;
      }

      // 遇到下一個事件行，就不再往後找
      if (ps.length === 3 && ps[ps.length - 1] !== 'INPOS') {
        break;
      }
    }
    // 找不到就預設多單（理論上不會發生）
    return 1;
  }

  // ===== 解析 TXT =====
  function parseTxt(text) {
    const allLines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!allLines.length) return { header: null, trades: [] };

    const header = allLines[0];       // BeginTime=...,EndTime=...
    const lines  = allLines.slice(1); // 之後才是資料

    const trades = [];
    let open = null; // { ts, px, dir }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ps = line.split(/\s+/);
      if (ps.length < 2) continue;

      const ts = ps[0];
      const px = parseFloat(ps[1]);
      if (!isFinite(px)) continue;

      // INPOS 行：最後一欄一定是 INPOS
      if (ps[ps.length - 1] === 'INPOS') {
        continue;
      }

      // 事件行：
      //   時間 價格 [中文]  → 3 欄
      //   （目前檔案裡進場/出場都符合這種格式）
      if (ps.length === 3) {
        if (!open) {
          // 進場
          const dir = getDirFromInpos(lines, i);
          open = { ts, px, dir };
        } else {
          // 出場
          const dir = open.dir;
          const entryPx = open.px;
          const exitPx  = px;

          const points = dir > 0
            ? (exitPx - entryPx)
            : (entryPx - exitPx);

          const gross = points * CFG.pointValue;

          const fee = CFG.feePerSide * 2; // 進 + 出
          const taxBase = (entryPx + exitPx) * CFG.pointValue;
          const tax = Math.round(taxBase * CFG.taxRate);

          const theoNet   = gross - fee - tax;
          const slipCost  = CFG.slipPointsRT * CFG.pointValue;
          const actualNet = theoNet - slipCost;

          // 用 dir 還原中文標籤（不依賴原始檔中文字）
          const entryAction = dir > 0 ? '新買' : '新賣';
          const exitAction  = dir > 0 ? '平賣' : '平買';

          trades.push({
            entry: { ts: open.ts, px: open.px, action: entryAction },
            exit:  { ts,         px,         action: exitAction },
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

      // 其他欄位數（例如將來多了東西）先忽略
    }

    return { header, trades };
  }

  // ===== 畫表格 =====
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
    // 不指定編碼，瀏覽器會用 UTF-8 讀 Big5，
    // 中文雖然會壞掉，但我們已經不看中文字了，完全沒差。
    reader.readAsText(file);
  });

})();
