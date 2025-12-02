// 0807-trades.js
// 讀取 0807 KPI 版 TF_1m（事件行：時間 價格 中文；持倉行：... INPOS）
// 不看中文字，純靠欄位數 + INPOS 判斷進出場。
// 本金 / 滑點（每邊點數）可輸入，滑點會影響實際淨損益。
// ★ 這版已修正：交易稅 = 進場一邊四捨五入 + 出場一邊四捨五入。

(function () {
  'use strict';

  // ===== 參數設定 =====
  const CFG = {
    pointValue: 200,    // 每點金額
    feePerSide: 45,     // 單邊手續費
    taxRate: 0.00002,   // 期交稅率（單邊）
    slipPerSide: 0,     // 每邊滑點（點數），例如 2 → round-trip 扣 4 點
    capital: 1000000    // 本金（之後算報酬率用）
  };

  let gParsed = null;   // 目前已解析的結果（給調整滑點時重畫）
  let gFile = null;     // 目前選擇的檔案

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

    const header = allLines[0];     // BeginTime=...,EndTime=...
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

      // 事件行：時間 價格 [中文] → 3 欄
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
          // ★ 正確作法：兩邊各自計稅後四捨五入，再相加
          const taxEntry = Math.round(entryPx * CFG.pointValue * CFG.taxRate);
          const taxExit  = Math.round(exitPx  * CFG.pointValue * CFG.taxRate);
          const tax = taxEntry + taxExit;

          const theoNet = gross - fee - tax;

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
            theoNet
          });

          open = null;
        }
      }

      // 其他欄位數先忽略
    }

    return { header, trades };
  }

  // ===== 畫表格 =====
  function renderTrades(parsed) {
    const tbody = $('#tradesBody');
    tbody.innerHTML = '';

    if (!parsed || !parsed.trades.length) return;

    let cumTheo = 0;
    let cumActual = 0;

    const slipCost = CFG.slipPerSide * 2 * CFG.pointValue; // 每筆 round-trip 扣的金額

    parsed.trades.forEach((t, idx) => {
      cumTheo += t.theoNet;

      const actualNet = t.theoNet - slipCost;
      cumActual += actualNet;

      const tr1 = document.createElement('tr');
      const tr2 = document.createElement('tr');

      // 進場列
      tr1.innerHTML = `
        <td rowspan="2">${idx + 1}</td>
        <td>${formatTs(t.entry.ts)}</td>
        <td>${fmtInt(t.entry.px)}</td>
        <td style="text-align:right;">${t.entry.action}</td>
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
        <td style="text-align:right;">${t.exit.action}</td>
        <td class="${clsForNumber(t.points)}">${fmtSignedInt(t.points)}</td>
        <td>${fmtInt(t.fee)}</td>
        <td>${fmtInt(t.tax)}</td>
        <td class="${clsForNumber(t.theoNet)}">${fmtInt(t.theoNet)}</td>
        <td class="${clsForNumber(cumTheo)}">${fmtInt(cumTheo)}</td>
        <td class="${clsForNumber(actualNet)}">${fmtInt(actualNet)}</td>
        <td class="${clsForNumber(cumActual)}">${fmtInt(cumActual)}</td>
      `;

      tbody.appendChild(tr1);
      tbody.appendChild(tr2);
    });
  }

  // ===== 檔案選擇事件：只記住檔案，不解析 =====
  $('#fileInput').addEventListener('change', function (ev) {
    const file = ev.target.files && ev.target.files[0];
    gFile = file || null;
  });

  // ===== 本金 / 滑點輸入事件 =====
  $('#capitalInput').addEventListener('change', function () {
    const v = Number(this.value);
    if (isFinite(v) && v > 0) {
      CFG.capital = v;
      // 目前先不影響表格，之後要算報酬率再用
    }
  });

  $('#slipInput').addEventListener('change', function () {
    const v = Number(this.value);
    CFG.slipPerSide = isFinite(v) ? v : 0;
    if (gParsed) {
      renderTrades(gParsed); // 重新套用滑點重畫
    }
  });

  // ===== 「計算」按鈕：讀檔 + 解析 + 畫表 =====
  $('#runBtn').addEventListener('click', function () {
    if (!gFile) {
      alert('請先選擇 TXT 檔案');
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      const text = e.target.result || '';
      const parsed = parseTxt(text);
      gParsed = parsed;
      renderTrades(parsed);
    };
    // Big5 也沒關係，我們完全不看原始中文字
    reader.readAsText(gFile);
  });

})();
