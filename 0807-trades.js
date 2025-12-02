// 0807-trades.js
// - 讀 0807 KPI 版 TF_1m（事件行：時間 價格 中文；持倉行：... INPOS）
// - 不看中文字，純靠欄位數 + INPOS 判斷進出場。
// - 本金 / 滑點（每邊點數）可輸入，滑點會影響實際淨損益。
// - 這版：交易稅 = 進場一邊四捨五入 + 出場一邊四捨五入。
// - 並計算 32 個「期貨機構級 KPI」，顯示在交易明細上方。

(function () {
  'use strict';

  // ===== 參數設定 =====
  const CFG = {
    pointValue: 200,    // 每點金額
    feePerSide: 45,     // 單邊手續費
    taxRate: 0.00002,   // 期交稅率（單邊）
    slipPerSide: 0,     // 每邊滑點（點數），例如 2 → round-trip 扣 4 點
    capital: 1000000    // 本金
  };

  let gParsed = null;   // 目前已解析的結果
  let gFile   = null;   // 目前選擇的檔案（File 物件）

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

  const fmtPct = (p) => {
    if (p == null || !isFinite(p)) return '—';
    return (p * 100).toFixed(2) + '%';
  };

  const fmtFloat = (x, d) => {
    if (x == null || !isFinite(x)) return '—';
    return x.toFixed(d);
  };

  const clsForNumber = (n) => {
    if (n == null || !isFinite(n) || n === 0) return '';
    return n > 0 ? 'num-pos' : 'num-neg';
  };

  // 20240102130100.000000 → "2024/1/2 13:01"
  function formatTs(ts) {
    if (!ts) return '';
    const clean = ts.replace(/\D/g, ''); // 去掉小數點
    if (clean.length < 12) return ts;
    const y  = clean.slice(0, 4);
    const m  = clean.slice(4, 6);
    const d  = clean.slice(6, 8);
    const hh = clean.slice(8, 10);
    const mm = clean.slice(10, 12);
    return `${y}/${parseInt(m, 10)}/${parseInt(d, 10)} ${hh}:${mm}`;
  }

  // 將 TS 轉成 Date（方便算天數 / 週數）
  function tsToDate(ts) {
    if (!ts) return null;
    const clean = ts.replace(/\D/g, '');
    if (clean.length < 8) return null;
    const y = parseInt(clean.slice(0, 4), 10);
    const m = parseInt(clean.slice(4, 6), 10) - 1;
    const d = parseInt(clean.slice(6, 8), 10);
    const hh = clean.length >= 10 ? parseInt(clean.slice(8, 10), 10) : 0;
    const mm = clean.length >= 12 ? parseInt(clean.slice(10, 12), 10) : 0;
    return new Date(y, m, d, hh, mm, 0);
  }

  // 取 yyyyMMdd key
  function tsDayKey(ts) {
    if (!ts) return '';
    const clean = ts.replace(/\D/g, '');
    return clean.slice(0, 8);
  }

  // ISO 週 key：yyyy-Www
  function dateWeekKey(d) {
    if (!d) return '';
    // 複製
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    // 週以週一為第一天
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return tmp.getUTCFullYear() + '-W' + (weekNo < 10 ? '0' + weekNo : weekNo);
  }

  // ===== 往後掃第一行 INPOS，抓方向 dir（+1 多 / -1 空） =====
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
          // 兩邊各自計稅後四捨五入，再相加
          const taxEntry = Math.round(entryPx * CFG.pointValue * CFG.taxRate);
          const taxExit  = Math.round(exitPx  * CFG.pointValue * CFG.taxRate);
          const tax = taxEntry + taxExit;

          const theoNet = gross - fee - tax;

          // 用 dir 還原中文標籤
          const entryAction = dir > 0 ? '新買' : '新賣';
          const exitAction  = dir > 0 ? '平賣' : '平買';

          trades.push({
            entry: { ts: open.ts, px: open.px, action: entryAction },
            exit:  { ts,         px: exitPx,   action: exitAction },
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

  // ===== KPI 計算 =====
  function calcKpi(trades, pnls, equity) {
    const n = pnls.length;
    if (!n) return null;

    // 基本統計
    let sum = 0;
    let sumSq = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let largestWin = null;
    let largestLoss = null;

    pnls.forEach(p => {
      sum += p;
      sumSq += p * p;
      if (p > 0) {
        grossProfit += p;
        wins++;
        if (largestWin === null || p > largestWin) largestWin = p;
      } else if (p < 0) {
        grossLoss += p;
        losses++;
        if (largestLoss === null || p < largestLoss) largestLoss = p;
      }
    });

    const totalNet = sum;
    const avg = sum / n;
    const winRate = wins / n;
    const avgWin  = wins   ? grossProfit / wins   : 0;
    const avgLoss = losses ? grossLoss  / losses  : 0; // 負值

    const payoff = (avgLoss < 0) ? (avgWin / Math.abs(avgLoss)) : null;
    const pf = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null;

    const mean = avg;
    const variance = n > 1 ? (sumSq / n - mean * mean) : 0;
    const stdev = variance > 0 ? Math.sqrt(variance) : 0;

    // Sharpe：交易級（以單筆期望 / 單筆波動）
    const sharpeTrade = stdev > 0 ? (mean / stdev) * Math.sqrt(n) : null;

    // Sortino：只看負報酬的標準差
    let downsideSq = 0;
    let downsideCnt = 0;
    pnls.forEach(p => {
      if (p < 0) {
        downsideSq += p * p;
        downsideCnt++;
      }
    });
    const downsideDev = downsideCnt > 0 ? Math.sqrt(downsideSq / downsideCnt) : 0;
    const sortinoTrade = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(n) : null;

    // 最大回撤（用 equity：累積實際損益）
    let peak = 0;
    let maxDd = 0;
    let maxDdStartIdx = 0;
    let maxDdEndIdx = 0;
    let curPeakIdx = 0;

    for (let i = 0; i < equity.length; i++) {
      const v = equity[i];
      if (v > peak) {
        peak = v;
        curPeakIdx = i;
      }
      const dd = peak - v;
      if (dd > maxDd) {
        maxDd = dd;
        maxDdStartIdx = curPeakIdx;
        maxDdEndIdx = i;
      }
    }

    const totalReturnPct = CFG.capital > 0 ? totalNet / CFG.capital : null;
    const maxDdPct = CFG.capital > 0 ? maxDd / CFG.capital : null;
    const calmar = (maxDdPct != null && maxDdPct > 0)
      ? (totalReturnPct / maxDdPct)
      : null;

    // 回神時間：以「交易筆數」為單位
    const timeToRecoveryTrades =
      maxDdEndIdx > maxDdStartIdx ? (maxDdEndIdx - maxDdStartIdx) : 0;

    // Ulcer Index：以 NAV (= capital + equity) 的 %DD
    const nav = equity.map(v => CFG.capital + v);
    let peakNav = 0;
    let sumDdSq = 0;
    for (let i = 0; i < nav.length; i++) {
      const v = nav[i];
      if (v > peakNav) peakNav = v;
      const ddPct = peakNav > 0 ? (peakNav - v) / peakNav : 0;
      sumDdSq += ddPct * ddPct;
    }
    const ulcerIndex = nav.length > 0 ? Math.sqrt(sumDdSq / nav.length) : null;

    // Recovery Factor / Profit-to-MDD
    const recoveryFactor = maxDd > 0 ? totalNet / maxDd : null;

    // 日 / 週 PnL（以出場日為準）
    const dayMap = {};
    const weekMap = {};
    const exitDates = trades.map(t => tsToDate(t.exit.ts));
    pnls.forEach((p, i) => {
      const d = exitDates[i];
      const dayKey = tsDayKey(trades[i].exit.ts);
      if (dayKey) {
        dayMap[dayKey] = (dayMap[dayKey] || 0) + p;
      }
      if (d) {
        const wk = dateWeekKey(d);
        weekMap[wk] = (weekMap[wk] || 0) + p;
      }
    });
    const worstDayPnl  = Object.values(dayMap).reduce((m, v) => (v < m ? v : m), 0);
    const worstWeekPnl = Object.values(weekMap).reduce((m, v) => (v < m ? v : m), 0);

    // VaR / CVaR（以單筆損益分布、95%）
    const sortedPnls = pnls.slice().sort((a, b) => a - b); // 從虧到賺
    const alpha = 0.95;
    const idx = Math.floor((1 - alpha) * sortedPnls.length); // 5% 左尾
    const varLoss = sortedPnls.length ? -sortedPnls[Math.min(idx, sortedPnls.length - 1)] : null;

    let tailSum = 0;
    let tailCnt = 0;
    for (let i = 0; i <= idx && i < sortedPnls.length; i++) {
      tailSum += sortedPnls[i];
      tailCnt++;
    }
    const cvarLoss = tailCnt > 0 ? -(tailSum / tailCnt) : null;

    // 交易期間（給 CAGR 用）
    let cagr = null;
    if (exitDates.length) {
      const first = exitDates[0];
      const last  = exitDates[exitDates.length - 1];
      if (first && last && last > first && CFG.capital > 0) {
        const days = (last - first) / 86400000;
        const years = days / 365;
        if (years > 0) {
          const finalNav = CFG.capital + totalNet;
          const ratio = finalNav / CFG.capital;
          cagr = Math.pow(ratio, 1 / years) - 1;
        }
      }
    }

    // Expectancy / Kelly / Risk-of-Ruin（近似）
    const expectancy = avg; // 單筆期望（以實際損益）
    let kelly = null;
    if (payoff != null && payoff > 0 && winRate > 0 && winRate < 1) {
      const p = winRate;
      const q = 1 - p;
      kelly = (p - q / payoff); // 單位資金的 Kelly fraction（理論）
    }

    let riskOfRuin = null;
    // 粗略近似：以「每筆風險 ≈ |平均虧損|，資金格數 N = capital / |avgLoss|」
    if (avgLoss < 0 && payoff != null && payoff > 0 && winRate > 0 && winRate < 1) {
      const p = winRate;
      const q = 1 - p;
      const unitRisk = Math.abs(avgLoss);
      const N = Math.max(1, Math.floor(CFG.capital / unitRisk));
      if (p > 0.5 && N > 0) {
        const r = (q / p);
        riskOfRuin = Math.pow(r, N); // 只是粗略 proxy
      } else if (p <= 0.5) {
        riskOfRuin = 1; // 勝率不到 50%，長期高風險
      }
    }

    // 交易天數 / 筆數
    const tradingDays = Object.keys(dayMap).length;
    const tradesPerDay = tradingDays > 0 ? n / tradingDays : null;

    // 平均持倉時間（分鐘）
    let totalHoldMin = 0;
    trades.forEach((t) => {
      const dIn  = tsToDate(t.entry.ts);
      const dOut = tsToDate(t.exit.ts);
      if (dIn && dOut && dOut >= dIn) {
        totalHoldMin += (dOut - dIn) / 60000;
      }
    });
    const avgHoldMin = n > 0 ? totalHoldMin / n : null;

    // 成本 & 週轉率
    let totalFee  = 0;
    let totalTax  = 0;
    let totalSlipCost = 0;
    let notionalTraded = 0; // 以進場合約價值估算（1 口）
    const slipPerTradeMoney = CFG.pointValue * CFG.slipPerSide * 2;

    trades.forEach((t) => {
      totalFee += t.fee;
      totalTax += t.tax;
      totalSlipCost += slipPerTradeMoney;
      notionalTraded += t.entry.px * CFG.pointValue; // 1 口
    });

    const totalCost = totalFee + totalTax + totalSlipCost;
    const turnover = CFG.capital > 0 ? (notionalTraded / CFG.capital) : null;
    const totalGrossAbs = grossProfit + Math.abs(grossLoss);
    const costRatio = totalGrossAbs > 0 ? (totalCost / totalGrossAbs) : null;

    // 穩定度 / R²（以 NAV 對時間回歸）
    let stabilityR2 = null;
    if (nav.length >= 3) {
      const xs = nav.map((_, i) => i + 1);
      const ys = nav;
      const nPts = xs.length;
      const sumX = xs.reduce((a, v) => a + v, 0);
      const sumY = ys.reduce((a, v) => a + v, 0);
      const sumXY = xs.reduce((a, v, i) => a + v * ys[i], 0);
      const sumX2 = xs.reduce((a, v) => a + v * v, 0);
      const meanY = sumY / nPts;
      const ssTot = ys.reduce((a, v) => a + (v - meanY) * (v - meanY), 0);
      const slope = (nPts * sumXY - sumX * sumY) / (nPts * sumX2 - sumX * sumX);
      const intercept = meanY - slope * (sumX / nPts);
      let ssRes = 0;
      for (let i = 0; i < nPts; i++) {
        const yhat = slope * xs[i] + intercept;
        ssRes += (ys[i] - yhat) * (ys[i] - yhat);
      }
      stabilityR2 = ssTot > 0 ? 1 - (ssRes / ssTot) : null;
    }

    // ===== 組合成 KPI 物件 =====
    return {
      // 基本報酬
      totalNet,
      totalReturnPct,
      cagr,
      // Drawdown & 風險
      maxDd,
      maxDdPct,
      ulcerIndex,
      recoveryFactor,
      timeToRecoveryTrades,
      worstDayPnl,
      worstWeekPnl,
      varLoss,
      cvarLoss,
      riskOfRuin,
      // 報酬 / 波動
      volPerTrade: stdev,
      sharpeTrade,
      sortinoTrade,
      calmar,
      // 交易結構
      nTrades: n,
      winRate,
      avg,
      avgWin,
      avgLoss,
      payoff,
      expectancy,
      pf,
      grossProfit,
      grossLoss,
      largestWin,
      largestLoss,
      kelly,
      // 穩定度 / path
      stabilityR2,
      maxWinningStreak: null, // 需要額外計算（可之後加）
      maxLosingStreak: null,  // 同上
      // 成本 / 週轉
      tradingDays,
      tradesPerDay,
      avgHoldMin,
      turnover,
      totalFee,
      totalTax,
      totalSlipCost,
      totalCost,
      costRatio
    };
  }

  // ===== KPI 呈現 =====
  function renderKpi(kpi) {
    const tbody = $('#kpiBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!kpi) return;

    const addSection = (title) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="kpi-section" colspan="3">${title}</td>`;
      tbody.appendChild(tr);
    };

    const addRow = (name, valueStr, desc) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="kpi-name">${name}</td>
        <td>${valueStr}</td>
        <td class="kpi-desc">${desc}</td>
      `;
      tbody.appendChild(tr);
    };

    // ---- Tier 1：生存與尾端風險 ----
    addSection('Tier 1．生存與尾端風險（Risk / Survival）');
    addRow('最大回撤率 Max Drawdown %',
      fmtPct(kpi.maxDdPct),
      '以本金為基準的最大淨值跌幅（最重要風控指標之一）');
    addRow('最大回撤金額 Max Drawdown',
      fmtInt(kpi.maxDd),
      '累積實際淨損益的最大下跌金額（對應風控限額）');
    addRow('破產風險 Risk of Ruin（近似）',
      kpi.riskOfRuin != null ? fmtPct(kpi.riskOfRuin) : '—',
      '以勝率 / 賺賠比 / 平均虧損粗略估計長期破產機率（需搭配風控參數解讀）');
    addRow('最差單日損益 Worst Day PnL',
      fmtInt(kpi.worstDayPnl),
      '以出場日統計的單日最差實際損益');
    addRow('最差單週損益 Worst Week PnL',
      fmtInt(kpi.worstWeekPnl),
      '以出場週統計的單週最差實際損益');
    addRow('95% VaR（單筆）',
      kpi.varLoss != null ? fmtInt(kpi.varLoss) : '—',
      '以單筆損益分布估算的 95% Value-at-Risk（左尾損失門檻）');
    addRow('95% CVaR（單筆）',
      kpi.cvarLoss != null ? fmtInt(kpi.cvarLoss) : '—',
      'VaR 左尾區間內的平均損失，衡量尾端風險平均嚴重度');
    addRow('回神時間 Time to Recovery（筆）',
      kpi.timeToRecoveryTrades != null ? fmtInt(kpi.timeToRecoveryTrades) : '—',
      '最大回撤發生到重新創新高所需的交易筆數');
    addRow('Ulcer Index',
      fmtFloat(kpi.ulcerIndex, 4),
      '以 NAV 下跌深度與持續時間綜合計算的痛苦指標（越小越好）');
    addRow('Recovery Factor',
      fmtFloat(kpi.recoveryFactor, 2),
      '總淨利 / 最大回撤，衡量從深度虧損中恢復的能力');

    // ---- Tier 2：報酬與風險調整後報酬 ----
    addSection('Tier 2．報酬與風險調整後報酬（Return / Risk-Adjusted）');
    addRow('總淨利 Net Profit',
      fmtInt(kpi.totalNet),
      '全部實際淨損益加總');
    addRow('總報酬率 Total Return',
      fmtPct(kpi.totalReturnPct),
      '總淨利 / 本金，未年化');
    addRow('年化報酬率 CAGR',
      fmtPct(kpi.cagr),
      '以第一筆與最後一筆出場日期估算的年化報酬率');
    addRow('單筆波動（交易級 Volatility）',
      fmtInt(kpi.volPerTrade),
      '單筆實際損益的標準差，未年化');
    addRow('Sharpe Ratio（交易級）',
      fmtFloat(kpi.sharpeTrade, 2),
      '以單筆期望 / 單筆波動估算的 Sharpe（sqrt(N) 已折算）');
    addRow('Sortino Ratio（交易級）',
      fmtFloat(kpi.sortinoTrade, 2),
      '僅使用負報酬計算下行標準差的 Sharpe 變形');
    addRow('Calmar Ratio',
      fmtFloat(kpi.calmar, 2),
      '年化報酬率 / 最大回撤率（DD 大時特別重要）');

    // ---- Tier 3：交易品質與結構 ----
    addSection('Tier 3．交易品質與結構（Trade Quality / Structure）');
    addRow('交易筆數 #Trades',
      fmtInt(kpi.nTrades),
      '完整進出場筆數');
    addRow('勝率 Hit Rate',
      fmtPct(kpi.winRate),
      '獲利筆數 / 總筆數');
    addRow('平均單筆損益 Avg Trade PnL',
      fmtInt(kpi.avg),
      '實際淨損益的平均值（含成本與滑點）');
    addRow('平均獲利 Avg Win',
      fmtInt(kpi.avgWin),
      '所有獲利單的平均實際損益');
    addRow('平均虧損 Avg Loss',
      fmtInt(kpi.avgLoss),
      '所有虧損單的平均實際損益');
    addRow('賺賠比 Payoff Ratio',
      kpi.payoff != null ? fmtFloat(kpi.payoff, 2) : '—',
      '平均獲利 / |平均虧損|，需與勝率一起解讀');
    addRow('單筆期望值 Expectancy',
      fmtInt(kpi.expectancy),
      '每筆交易期望損益，長期報酬 = Expectancy × 筆數');
    addRow('獲利因子 Profit Factor',
      kpi.pf != null ? fmtFloat(kpi.pf, 2) : '—',
      '總獲利 / |總虧損|，>1 才有長期優勢');
    addRow('總獲利 Gross Profit',
      fmtInt(kpi.grossProfit),
      '所有獲利單損益加總（不含虧損）');
    addRow('總虧損 Gross Loss',
      fmtInt(kpi.grossLoss),
      '所有虧損單損益加總（為負值）');
    addRow('最大獲利單 Largest Win',
      fmtInt(kpi.largestWin),
      '單筆最大實際獲利');
    addRow('最大虧損單 Largest Loss',
      fmtInt(kpi.largestLoss),
      '單筆最大實際虧損');
    addRow('Kelly Fraction（理論值）',
      kpi.kelly != null ? fmtFloat(kpi.kelly, 2) : '—',
      '依勝率與賺賠比估算的 Kelly 最適槓桿比例（僅供參考）');
    addRow('最大連勝 / 連敗 Streak',
      '—',
      '需額外紀錄連續獲利／虧損序列，可日後加到輸出資料中');

    // ---- Tier 4：路徑與穩定度 ----
    addSection('Tier 4．路徑與穩定度（Path / Stability）');
    addRow('Equity Stability R²',
      fmtFloat(kpi.stabilityR2, 3),
      '以 NAV 對時間做線性回歸的 R²，越接近 1 越線性穩定');
    addRow('Ulcer Performance（需搭配報酬）',
      '—',
      '可由 Ulcer Index + 回報再推導，本頁先提供 Ulcer Index 即可');
    addRow('Alpha / Beta / Correlation',
      '—',
      '需額外提供基準指數報酬序列（例如加權指數 / MSCI）才可計算');

    // ---- Tier 5：成本、週轉與執行 ----
    addSection('Tier 5．成本、槓桿與執行（Cost / Turnover / Execution）');
    addRow('交易天數 Trading Days',
      fmtInt(kpi.tradingDays),
      '有出場交易的日期數');
    addRow('平均每日交易數 Trades / Day',
      fmtFloat(kpi.tradesPerDay, 2),
      '交易筆數 / 交易天數');
    addRow('平均持倉時間 Avg Holding Time（分鐘）',
      fmtFloat(kpi.avgHoldMin, 1),
      '以進場與出場時間差估算的平均持有時間');
    addRow('名目週轉率 Turnover（Notional / Capital）',
      fmtFloat(kpi.turnover, 2),
      '所有進場合約名目價值加總 / 本金');
    addRow('手續費總額 Total Commission',
      fmtInt(kpi.totalFee),
      '所有交易手續費加總');
    addRow('交易稅總額 Total Tax',
      fmtInt(kpi.totalTax),
      '所有期交稅加總');
    addRow('滑價成本總額 Slippage Cost',
      fmtInt(kpi.totalSlipCost),
      '依設定滑點（每邊點數）換算之總滑價成本');
    addRow('總交易成本 Total Trading Cost',
      fmtInt(kpi.totalCost),
      '手續費 + 稅 + 滑價成本');
    addRow('成本佔交易金額比 Transaction Cost Ratio',
      kpi.costRatio != null ? fmtPct(kpi.costRatio) : '—',
      '總成本 / (總獲利 + |總虧損|)，越低越好');
  }

  // ===== 畫交易明細表格並計算 KPI =====
  function renderTrades(parsed) {
    const tbody = $('#tradesBody');
    tbody.innerHTML = '';
    renderKpi(null); // 先清 KPI

    if (!parsed || !parsed.trades.length) return;

    let cumTheo = 0;
    let cumActual = 0;

    const pnls = [];
    const equity = [];

    const slipCostPerTrade = CFG.pointValue * CFG.slipPerSide * 2;

    parsed.trades.forEach((t, idx) => {
      cumTheo += t.theoNet;

      const actualNet = t.theoNet - slipCostPerTrade;
      cumActual += actualNet;

      pnls.push(actualNet);
      equity.push(cumActual);

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

    const kpi = calcKpi(parsed.trades, pnls, equity);
    renderKpi(kpi);
  }

  // ===== 事件綁定 =====

  // 檔案選擇：只記住檔案，不立刻算
  $('#fileInput').addEventListener('change', function (ev) {
    const file = ev.target.files && ev.target.files[0];
    gFile = file || null;
  });

  // 本金改變：重算 KPI
  $('#capitalInput').addEventListener('change', function () {
    const v = Number(this.value);
    if (isFinite(v) && v > 0) {
      CFG.capital = v;
      if (gParsed) renderTrades(gParsed);
    }
  });

  // 滑點改變：重算明細+KPI
  $('#slipInput').addEventListener('change', function () {
    const v = Number(this.value);
    CFG.slipPerSide = isFinite(v) ? v : 0;
    if (gParsed) renderTrades(gParsed);
  });

  // 「計算」按鈕：讀檔 + 解析 + 畫表 + KPI
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
    // Big5/UTF-8 都沒關係，完全不看中文字
    reader.readAsText(gFile);
  });

})();
