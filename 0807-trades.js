// 0807-trades.js
// - 讀 0807 KPI 版 TF_1m（事件行：時間 價格 中文；持倉行：... INPOS）
// - 解析交易，計算理論淨損益（不含滑點）與實際淨損益（含滑點）
// - 本金 / 滑點 可調，滑點只影響「實際」兩欄
// - 計算期貨機構級 KPI，並依評等標示顏色＆整理出「建議優化指標」

(function () {
  'use strict';

  // ===== 參數設定 =====
  const CFG = {
    pointValue: 200,    // 每點金額
    feePerSide: 45,     // 單邊手續費
    taxRate: 0.00002,   // 期交稅率（單邊）
    slipPerSide: 0,     // 每邊滑點（點數）
    capital: 1000000    // 本金
  };

  let gParsed = null;
  let gFile   = null;

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

  // 20240102130100.000000 → Date
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

  function formatTs(ts) {
    if (!ts) return '';
    const clean = ts.replace(/\D/g, '');
    if (clean.length < 12) return ts;
    const y  = clean.slice(0, 4);
    const m  = clean.slice(4, 6);
    const d  = clean.slice(6, 8);
    const hh = clean.slice(8, 10);
    const mm = clean.slice(10, 12);
    return `${y}/${parseInt(m, 10)}/${parseInt(d, 10)} ${hh}:${mm}`;
  }

  function tsDayKey(ts) {
    if (!ts) return '';
    const clean = ts.replace(/\D/g, '');
    return clean.slice(0, 8);
  }

  function dateWeekKey(d) {
    if (!d) return '';
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return tmp.getUTCFullYear() + '-W' + (weekNo < 10 ? '0' + weekNo : weekNo);
  }

  // ===== INPOS 判斷方向 =====
  function getDirFromInpos(lines, startIdx) {
    const maxLookAhead = 300;
    const total = lines.length;

    for (let j = startIdx + 1; j < total && j <= startIdx + maxLookAhead; j++) {
      const line = lines[j];
      const ps = line.split(/\s+/);
      if (!ps.length) continue;

      if (ps.length >= 6 && ps[ps.length - 1] === 'INPOS') {
        const dir = parseInt(ps[3], 10);
        if (dir === 1 || dir === -1) return dir;
      }

      if (ps.length === 3 && ps[ps.length - 1] !== 'INPOS') {
        break;
      }
    }
    return 1;
  }

  // ===== 解析 TXT =====
  function parseTxt(text) {
    const allLines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!allLines.length) return { header: null, trades: [] };

    const header = allLines[0];
    const lines  = allLines.slice(1);

    const trades = [];
    let open = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ps = line.split(/\s+/);
      if (ps.length < 2) continue;

      const ts = ps[0];
      const px = parseFloat(ps[1]);
      if (!isFinite(px)) continue;

      if (ps[ps.length - 1] === 'INPOS') {
        continue;
      }

      if (ps.length === 3) {
        if (!open) {
          const dir = getDirFromInpos(lines, i);
          open = { ts, px, dir };
        } else {
          const dir      = open.dir;
          const entryPx  = open.px;
          const exitPx   = px;

          const points = dir > 0
            ? (exitPx - entryPx)
            : (entryPx - exitPx);

          const gross = points * CFG.pointValue;
          const fee   = CFG.feePerSide * 2;
          const taxIn = Math.round(entryPx * CFG.pointValue * CFG.taxRate);
          const taxOut= Math.round(exitPx  * CFG.pointValue * CFG.taxRate);
          const tax   = taxIn + taxOut;

          const theoNet = gross - fee - tax;  // 理論淨損益（不含滑點）

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
    }

    return { header, trades };
  }

  // ===== KPI 評等規則（Strong / Adequate / Improve） =====
  function rateMetric(key, value) {
    if (value == null || !isFinite(value)) return null;

    let label = 'Adequate';
    let css   = 'rating-adequate';
    let ref   = '—';

    switch (key) {
      case 'maxdd_pct':   // 越小越好
        ref = '≦ 20% 強；20–30% 可接受；>30% 需優化';
        if (value <= 0.2)         { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.3)    { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'total_return':
      case 'cagr':
        ref = '≥ 15% 強；5–15% 可接受；<5% 需優化';
        if (value >= 0.15)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.05)   { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'pf':
        ref = '≥ 1.5 強；1.1–1.5 可接受；<1.1 需優化';
        if (value >= 1.5)         { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1.1)    { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'winrate':
        ref = '≥ 55% 強；45–55% 可接受；<45% 需優化';
        if (value >= 0.55)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.45)   { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'sharpe':
        ref = '≥ 1.5 強；0.8–1.5 可接受；<0.8 需優化';
        if (value >= 1.5)         { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.8)    { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'sortino':
        ref = '≥ 2 強；1–2 可接受；<1 需優化';
        if (value >= 2)           { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1)      { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'calmar':
        ref = '≥ 0.5 強；0.2–0.5 可接受；<0.2 需優化';
        if (value >= 0.5)         { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.2)    { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'risk_ruin':
        ref = '≦ 5% 強；5–20% 可接受；>20% 需優化';
        if (value <= 0.05)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.2)    { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'cost_ratio':
        ref = '≦ 20% 強；20–40% 可接受；>40% 需優化';
        if (value <= 0.2)         { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.4)    { label = 'Adequate';}
        else                      { label = 'Improve'; css = 'rating-improve'; }
        break;

      default:
        return null;
    }
    return { label, cssClass: css, ref };
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
    const avg      = sum / n;
    const winRate  = wins / n;
    const avgWin   = wins   ? grossProfit / wins   : 0;
    const avgLoss  = losses ? grossLoss  / losses  : 0;
    const payoff   = (avgLoss < 0) ? (avgWin / Math.abs(avgLoss)) : null;
    const pf       = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null;

    const mean   = avg;
    const varT   = n > 1 ? (sumSq / n - mean * mean) : 0;
    const stdev  = varT > 0 ? Math.sqrt(varT) : 0;

    const sharpeTrade  = stdev > 0 ? (mean / stdev) * Math.sqrt(n) : null;

    // Sortino
    let downsideSq = 0;
    let downsideCnt = 0;
    pnls.forEach(p => {
      if (p < 0) {
        downsideSq += p * p;
        downsideCnt++;
      }
    });
    const downsideDev   = downsideCnt > 0 ? Math.sqrt(downsideSq / downsideCnt) : 0;
    const sortinoTrade  = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(n) : null;

    // 最大回撤
    let peak = 0;
    let maxDd = 0;
    let maxDdStartIdx = 0;
    let maxDdEndIdx   = 0;
    let curPeakIdx    = 0;

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
        maxDdEndIdx   = i;
      }
    }

    const totalReturnPct = CFG.capital > 0 ? totalNet / CFG.capital : null;
    const maxDdPct       = CFG.capital > 0 ? maxDd   / CFG.capital : null;

    // 年化（CAGR）
    const exitDates = trades.map(t => tsToDate(t.exit.ts));
    let cagr = null;
    if (exitDates.length) {
      const first = exitDates[0];
      const last  = exitDates[exitDates.length - 1];
      if (first && last && last > first && CFG.capital > 0) {
        const days  = (last - first) / 86400000;
        const years = days / 365;
        if (years > 0) {
          const finalNav = CFG.capital + totalNet;
          const ratio    = finalNav / CFG.capital;
          cagr = Math.pow(ratio, 1 / years) - 1;
        }
      }
    }

    const calmar = (maxDdPct != null && maxDdPct > 0 && cagr != null)
      ? (cagr / maxDdPct)
      : null;

    // 回神時間（以筆數）
    const timeToRecoveryTrades =
      maxDdEndIdx > maxDdStartIdx ? (maxDdEndIdx - maxDdStartIdx) : 0;

    // Ulcer Index（NAV）
    const nav = equity.map(v => CFG.capital + v);
    let peakNav = 0;
    let sumDdSq = 0;
    for (let i = 0; i < nav.length; i++) {
      const v = nav[i];
      if (v > peakNav) peakNav = v;
      const ddPct = peakNav > 0 ? (peakNav - v) / peakNav : 0;
      sumDdSq += ddPct * ddPct;
    }
    const ulcerIndex = nav.length ? Math.sqrt(sumDdSq / nav.length) : null;
    const recoveryFactor = maxDd > 0 ? totalNet / maxDd : null;

    // 日 / 週損益
    const dayMap = {};
    const weekMap = {};
    pnls.forEach((p, i) => {
      const t  = trades[i];
      const dk = tsDayKey(t.exit.ts);
      if (dk) dayMap[dk] = (dayMap[dk] || 0) + p;
      const d = exitDates[i];
      if (d) {
        const wk = dateWeekKey(d);
        weekMap[wk] = (weekMap[wk] || 0) + p;
      }
    });
    const worstDayPnl  = Object.values(dayMap).reduce((m, v) => (v < m ? v : m), 0);
    const worstWeekPnl = Object.values(weekMap).reduce((m, v) => (v < m ? v : m), 0);

    // VaR / CVaR（95%）
    const sortedPnls = pnls.slice().sort((a, b) => a - b);
    const alpha = 0.95;
    const idx   = Math.floor((1 - alpha) * sortedPnls.length);
    const varLoss = sortedPnls.length
      ? -sortedPnls[Math.min(idx, sortedPnls.length - 1)]
      : null;

    let tailSum = 0;
    let tailCnt = 0;
    for (let i = 0; i <= idx && i < sortedPnls.length; i++) {
      tailSum += sortedPnls[i];
      tailCnt++;
    }
    const cvarLoss = tailCnt > 0 ? -(tailSum / tailCnt) : null;

    // Expectancy / Kelly / Risk of Ruin (近似)
    const expectancy = avg;
    let kelly = null;
    if (payoff != null && payoff > 0 && winRate > 0 && winRate < 1) {
      const p = winRate;
      const q = 1 - p;
      kelly = p - q / payoff;
    }

    let riskOfRuin = null;
    if (avgLoss < 0 && payoff != null && payoff > 0 && winRate > 0 && winRate < 1) {
      const p = winRate;
      const q = 1 - p;
      const unitRisk = Math.abs(avgLoss);
      const N = Math.max(1, Math.floor(CFG.capital / unitRisk));
      if (p > 0.5 && N > 0) {
        const r = q / p;
        riskOfRuin = Math.pow(r, N);
      } else if (p <= 0.5) {
        riskOfRuin = 1;
      }
    }

    // 成本 / 週轉
    let totalFee  = 0;
    let totalTax  = 0;
    let notionalTraded = 0;
    const slipPerTradeMoney = CFG.pointValue * CFG.slipPerSide * 2;
    trades.forEach(t => {
      totalFee  += t.fee;
      totalTax  += t.tax;
      notionalTraded += t.entry.px * CFG.pointValue;
    });
    const totalSlipCost = slipPerTradeMoney * trades.length;
    const totalCost     = totalFee + totalTax + totalSlipCost;
    const totalGrossAbs = grossProfit + Math.abs(grossLoss);
    const turnover      = CFG.capital > 0 ? (notionalTraded / CFG.capital) : null;
    const costRatio     = totalGrossAbs > 0 ? (totalCost / totalGrossAbs) : null;

    // 交易天數 / 筆數 / 持倉時間
    const tradingDays = Object.keys(dayMap).length;
    const tradesPerDay= tradingDays > 0 ? n / tradingDays : null;

    let totalHoldMin = 0;
    trades.forEach(t => {
      const dIn  = tsToDate(t.entry.ts);
      const dOut = tsToDate(t.exit.ts);
      if (dIn && dOut && dOut >= dIn) {
        totalHoldMin += (dOut - dIn) / 60000;
      }
    });
    const avgHoldMin = n > 0 ? totalHoldMin / n : null;

    // 穩定度 R²
    let stabilityR2 = null;
    if (nav.length >= 3) {
      const xs = nav.map((_, i) => i + 1);
      const ys = nav;
      const N  = xs.length;
      const sumX  = xs.reduce((a, v) => a + v, 0);
      const sumY  = ys.reduce((a, v) => a + v, 0);
      const sumXY = xs.reduce((a, v, i) => a + v * ys[i], 0);
      const sumX2 = xs.reduce((a, v) => a + v * v, 0);
      const meanY = sumY / N;
      const ssTot = ys.reduce((a, v) => a + (v - meanY) * (v - meanY), 0);
      const slope = (N * sumXY - sumX * sumY) / (N * sumX2 - sumX * sumX);
      const intercept = meanY - slope * (sumX / N);
      let ssRes = 0;
      for (let i = 0; i < N; i++) {
        const yhat = slope * xs[i] + intercept;
        ssRes += (ys[i] - yhat) * (ys[i] - yhat);
      }
      stabilityR2 = ssTot > 0 ? 1 - (ssRes / ssTot) : null;
    }

    return {
      totalNet,
      totalReturnPct,
      cagr,
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
      volPerTrade: stdev,
      sharpeTrade,
      sortinoTrade,
      calmar,
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
      stabilityR2,
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
    const badBody = $('#kpiBadBody');
    if (!tbody || !badBody) return;
    tbody.innerHTML = '';
    badBody.innerHTML = '';

    if (!kpi) {
      badBody.innerHTML =
        '<tr><td colspan="3" style="color:#777;">尚未載入資料。</td></tr>';
      return;
    }

    const badList = [];

    const addSection = (title) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="kpi-section" colspan="5">${title}</td>`;
      tbody.appendChild(tr);
    };

    const addRow = (key, name, valueStr, numValue, desc) => {
      const rating = key ? rateMetric(key, numValue) : null;
      const ratingLabel = rating ? rating.label : '—';
      const ratingClass = rating ? rating.cssClass : '';
      const refRange    = rating ? rating.ref      : '—';

      if (rating && rating.label === 'Improve') {
        badList.push({ name, valueStr, desc });
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="kpi-name">${name}</td>
        <td>${valueStr}</td>
        <td class="kpi-desc">${desc}</td>
        <td class="${ratingClass}">${ratingLabel}</td>
        <td>${refRange}</td>
      `;
      tbody.appendChild(tr);
    };

    // ---- Tier 1 ----
    addSection('Tier 1．生存與尾端風險（Risk / Survival）');
    addRow('maxdd_pct', '最大回撤率 Max Drawdown %',
      fmtPct(kpi.maxDdPct),
      kpi.maxDdPct,
      '以本金為基準的最大淨值跌幅');
    addRow(null, '最大回撤金額 Max Drawdown',
      fmtInt(kpi.maxDd),
      null,
      '累積實際淨損益的最大跌幅金額');
    addRow('risk_ruin', '破產風險 Risk of Ruin（近似）',
      kpi.riskOfRuin != null ? fmtPct(kpi.riskOfRuin) : '—',
      kpi.riskOfRuin,
      '依勝率 / 賺賠比 / 平均虧損粗估的長期破產機率');
    addRow(null, '最差單日損益 Worst Day PnL',
      fmtInt(kpi.worstDayPnl),
      null,
      '以出場日統計的單日最差實際損益');
    addRow(null, '最差單週損益 Worst Week PnL',
      fmtInt(kpi.worstWeekPnl),
      null,
      '以出場週統計的單週最差實際損益');
    addRow(null, '95% VaR（單筆）',
      kpi.varLoss != null ? fmtInt(kpi.varLoss) : '—',
      null,
      '以單筆損益分布估算的 95% Value-at-Risk 左尾損失門檻');
    addRow(null, '95% CVaR（單筆）',
      kpi.cvarLoss != null ? fmtInt(kpi.cvarLoss) : '—',
      null,
      'VaR 左尾區間平均損失，衡量尾端風險嚴重度');
    addRow(null, '回神時間 Time to Recovery（筆）',
      fmtInt(kpi.timeToRecoveryTrades),
      null,
      '最大回撤發生至重新創新高所需交易筆數');
    addRow(null, 'Ulcer Index',
      fmtFloat(kpi.ulcerIndex, 4),
      null,
      '以 NAV 下跌深度與持續時間綜合計算之痛苦指標');
    addRow(null, 'Recovery Factor',
      fmtFloat(kpi.recoveryFactor, 2),
      null,
      '總淨利 / 最大回撤，衡量從虧損中恢復能力');

    // ---- Tier 2 ----
    addSection('Tier 2．報酬與風險調整後報酬（Return / Risk-Adjusted）');
    addRow(null, '總淨利 Net Profit',
      fmtInt(kpi.totalNet),
      null,
      '全部實際淨損益加總（含成本與滑點）');
    addRow('total_return', '總報酬率 Total Return',
      fmtPct(kpi.totalReturnPct),
      kpi.totalReturnPct,
      '總淨利 / 本金，未年化');
    addRow('cagr', '年化報酬率 CAGR',
      fmtPct(kpi.cagr),
      kpi.cagr,
      '以第一筆與最後一筆出場日期估算年化報酬率');
    addRow(null, '單筆波動（交易級 Volatility）',
      fmtInt(kpi.volPerTrade),
      null,
      '單筆實際損益標準差，未年化');
    addRow('sharpe', 'Sharpe Ratio（交易級）',
      fmtFloat(kpi.sharpeTrade, 2),
      kpi.sharpeTrade,
      '以單筆期望 / 單筆波動估算 Sharpe（sqrt(N) 已折算）');
    addRow('sortino', 'Sortino Ratio（交易級）',
      fmtFloat(kpi.sortinoTrade, 2),
      kpi.sortinoTrade,
      '只用負報酬計算下行風險的 Sharpe 變形');
    addRow('calmar', 'Calmar Ratio',
      fmtFloat(kpi.calmar, 2),
      kpi.calmar,
      '年化報酬率 / 最大回撤率');

    // ---- Tier 3 ----
    addSection('Tier 3．交易品質與結構（Trade Quality / Structure）');
    addRow(null, '交易筆數 #Trades',
      fmtInt(kpi.nTrades),
      null,
      '完整進出場筆數');
    addRow('winrate', '勝率 Hit Rate',
      fmtPct(kpi.winRate),
      kpi.winRate,
      '獲利筆數 / 總筆數');
    addRow(null, '平均單筆損益 Avg Trade PnL',
      fmtInt(kpi.avg),
      null,
      '實際淨損益的平均值');
    addRow(null, '平均獲利 Avg Win',
      fmtInt(kpi.avgWin),
      null,
      '所有獲利單平均實際損益');
    addRow(null, '平均虧損 Avg Loss',
      fmtInt(kpi.avgLoss),
      null,
      '所有虧損單平均實際損益');
    addRow(null, '賺賠比 Payoff Ratio',
      kpi.payoff != null ? fmtFloat(kpi.payoff, 2) : '—',
      null,
      '平均獲利 / |平均虧損|，需與勝率一起看');
    addRow(null, '單筆期望值 Expectancy',
      fmtInt(kpi.expectancy),
      null,
      '每筆交易的期望損益');
    addRow('pf', '獲利因子 Profit Factor',
      kpi.pf != null ? fmtFloat(kpi.pf, 2) : '—',
      kpi.pf,
      '總獲利 / |總虧損|');
    addRow(null, '總獲利 Gross Profit',
      fmtInt(kpi.grossProfit),
      null,
      '所有獲利單損益加總');
    addRow(null, '總虧損 Gross Loss',
      fmtInt(kpi.grossLoss),
      null,
      '所有虧損單損益加總');
    addRow(null, '最大獲利單 Largest Win',
      fmtInt(kpi.largestWin),
      null,
      '單筆最大實際獲利');
    addRow(null, '最大虧損單 Largest Loss',
      fmtInt(kpi.largestLoss),
      null,
      '單筆最大實際虧損');
    addRow(null, 'Kelly Fraction（理論值）',
      kpi.kelly != null ? fmtFloat(kpi.kelly, 2) : '—',
      null,
      '依勝率與賺賠比估算之 Kelly 槓桿（僅供參考）');

    // ---- Tier 4 ----
    addSection('Tier 4．路徑與穩定度（Path / Stability）');
    addRow(null, 'Equity Stability R²',
      fmtFloat(kpi.stabilityR2, 3),
      null,
      '以 NAV 對時間做線性回歸的 R²，越接近 1 越平滑');
    addRow(null, 'Alpha / Beta / Correlation',
      '—',
      null,
      '需額外提供基準指數報酬序列才可計算');

    // ---- Tier 5 ----
    addSection('Tier 5．成本、槓桿與執行（Cost / Turnover / Execution）');
    addRow(null, '交易天數 Trading Days',
      fmtInt(kpi.tradingDays),
      null,
      '有出場交易的日期數');
    addRow(null, '平均每日交易數 Trades / Day',
      fmtFloat(kpi.tradesPerDay, 2),
      null,
      '交易筆數 / 交易天數');
    addRow(null, '平均持倉時間 Avg Holding Time（分鐘）',
      fmtFloat(kpi.avgHoldMin, 1),
      null,
      '進場到出場的平均持有時間');
    addRow(null, '名目週轉率 Turnover（Notional / Capital）',
      fmtFloat(kpi.turnover, 2),
      null,
      '所有進場合約名目價值 / 本金');
    addRow('cost_ratio', '成本佔交易金額比 Transaction Cost Ratio',
      kpi.costRatio != null ? fmtPct(kpi.costRatio) : '—',
      kpi.costRatio,
      '手續費 + 稅 + 滑價成本 / (總獲利+|總虧損|)');
    addRow(null, '手續費總額 Total Commission',
      fmtInt(kpi.totalFee),
      null,
      '所有交易手續費加總');
    addRow(null, '交易稅總額 Total Tax',
      fmtInt(kpi.totalTax),
      null,
      '所有期交稅加總');
    addRow(null, '滑價成本總額 Slippage Cost',
      fmtInt(kpi.totalSlipCost),
      null,
      '依設定滑點換算的總滑價成本');
    addRow(null, '總交易成本 Total Trading Cost',
      fmtInt(kpi.totalCost),
      null,
      '手續費 + 稅 + 滑價總和');

    // ===== 建議優化指標卡片 =====
    if (!badList.length) {
      badBody.innerHTML =
        '<tr><td colspan="3" style="color:#777;">目前沒有需要特別優化的指標。</td></tr>';
    } else {
      badList.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="kpi-name">${item.name}</td>
          <td>${item.valueStr}</td>
          <td class="kpi-desc">${item.desc}</td>
        `;
        badBody.appendChild(tr);
      });
    }
  }

  // ===== 畫交易明細表格（理論 vs 含滑點 並列） =====
  function renderTrades(parsed) {
    const tbody = $('#tradesBody');
    tbody.innerHTML = '';
    renderKpi(null);

    if (!parsed || !parsed.trades.length) return;

    let cumTheo   = 0; // 不含滑點
    let cumActual = 0; // 含滑點

    const pnls   = [];
    const equity = [];

    const slipCostPerTrade = CFG.pointValue * CFG.slipPerSide * 2;

    parsed.trades.forEach((t, idx) => {
      cumTheo   += t.theoNet;                     // 理論累積
      const actualNet = t.theoNet - slipCostPerTrade; // 含滑點
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

      // 出場列：理論 vs 含滑點 並列
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

  // ===== 事件 =====
  $('#fileInput').addEventListener('change', function (ev) {
    const file = ev.target.files && ev.target.files[0];
    gFile = file || null;
  });

  $('#capitalInput').addEventListener('change', function () {
    const v = Number(this.value);
    if (isFinite(v) && v > 0) {
      CFG.capital = v;
      if (gParsed) renderTrades(gParsed);
    }
  });

  $('#slipInput').addEventListener('change', function () {
    const v = Number(this.value);
    CFG.slipPerSide = isFinite(v) ? v : 0;
    if (gParsed) renderTrades(gParsed);
  });

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
    reader.readAsText(gFile);
  });

})();
