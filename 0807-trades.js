// 0807-trades.js
// 讀取 0807 KPI 版 TF_1m，產生交易明細表（雙列一筆交易）

(function () {
  'use strict';

  // ===== 參數設定（之後要改很方便） =====
  const CFG = {
    pointValue: 200,    // 每點金額
    feePerSide: 45,     // 單邊手續費（進 45 + 出 45 = 90）
    taxRate: 0.00002,   // 期交稅率（單邊），這裡會用雙邊合計
    slipPointsRT: 0     // 一 round-trip 的滑價點數（先設 0）
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

  // 從後面的 INPOS 行抓方向（+1 多 / -1 空）
  function getDirFromInpos(lines, startIdx) {
    const limit = Math.min(startIdx + 300, lines.length);
    for (let j = startIdx + 1; j < limit; j++) {
      const ps = lines[j].split(/\s+/);
      if (!ps.length) continue;

      // INPOS 格式：ts mid low dir entry INPOS
      if (ps.length >= 6 && ps[ps.length - 1] === 'INPOS') {
        const dir = parseInt(ps[3], 10);
        if (dir === 1 || dir === -1) return dir;
      }

      // 遇到出場或下一筆事件就停
      if (ps.length === 2) break;

      if (ps.length >= 3 && ps[ps.length - 1] !== 'INPOS') {
        const flag = ps[2];
        // flag 不是 s/sR 就視為出場類型（R、亂碼等等）
        if (flag !== 's' && flag !== 'sR') break;
      }
    }
    // 找不到就當多單（理論上不太會發生）
    return 1;
  }

  // ===== 解析 TXT：0807 KPI 版 TF_1m =====
  function parseTxt(text) {
    const rawLines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!rawLines.length) return { header: null, trades: [] };

    const header = rawLines[0]; // BeginTime=...,EndTime=...

    const lines = rawLines.slice(1); // 之後才是資料行
    const trades = [];

    let open = null; // { ts, px, dir }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ps = line.split(/\s+/);
      if (ps.length < 2) continue;

      const ts = ps[0];
      const px = parseFloat(ps[1]);
      if (!isFinite(px)) continue;

      const hasThird = ps.length >= 3;
      const token3 = hasThird ? ps[2] : null;

      const isInpos = hasThird && ps[ps.length - 1] === 'INPOS';

      // 1) INPOS 行：直接跳過（只是持倉追蹤）
      if (isInpos) continue;

      // 2) 判斷是不是「事件行」
      //   - 兩欄：一定是出場
      //   - 三欄以上：第三欄
      //       * s / sR → 進場
      //       * 其他（R、亂碼）→ 出場
      if (ps.length === 2) {
        // 出場
        if (open) {
          const dir = open.dir;
          const entryPx = open.px;
          const exitPx = px;

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
            entry: {
              ts: open.ts,
              px: open.px,
              action: open.dir > 0 ? '新買' : '新賣'
            },
            exit: {
              ts,
              px,
              action: open.dir > 0 ? '平賣' : '平買'
            },
            dir,
            points,
            fee,
            tax,
            theoNet,
            actualNet
          });

          open = null;
        }
        continue;
      }

      // ps.length >= 3，而且不是 INPOS
      if (token3 === 's' || token3 === 'sR') {
        // 進場
        const dir = getDirFromInpos(lines, i); // 從後面 INPOS 抓 +1/-1
        open = { ts, px, dir };
      } else {
        // 其他非 INPOS（R / 亂碼）：出場
        if (open) {
          const dir = open.dir;
          const entryPx = open.px;
          const exitPx = px;

          const points = dir > 0
            ? (exitPx - entryPx)
            : (entryPx - exitPx);

          const gross = points * CFG.pointValue;

          const fee = CFG.feePerSide * 2;
          const taxBase = (entryPx + exitPx) * CFG.pointValue;
          const tax = Math.round(taxBase * CFG.taxRate);

          const theoNet = gross - fee - tax;
          const slipCost = CFG.slipPointsRT * CFG.pointValue;
          const actualNet = theoNet - slipCost;

          trades.push({
            entry: {
              ts: open.ts,
              px: open.px,
              action: open.dir > 0 ? '新買' : '新賣'
            },
            exit: {
              ts,
              px,
              // 這裡先不區分 R / 強平，一律用平買/平賣
              action: open.dir > 0 ? '平賣' : '平買'
            },
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
      cumTheo += t.theoNet;
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
    reader.readAsText(file); // 這份檔是 UTF-8，直接讀就好
  });

})();
