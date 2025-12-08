// stock-single-research.js
// 三劍客量化科技 股票策略研究（1031 TXT 單檔分析）
//
// - 讀取 1031 指標版 TXT（DipBuy_1m_1031_IND_T2）
// - 第一行為參數列：日期,時間,價格,動作,說明,_BeginT=..., ...,_FeeRate=...,_IsETF=...,_TaxRateOverride=...
// - 之後每行：
//   日線：20240129,000000,21.38,日線,closeD=21.38,
//   買進：20240131,90500,21.35,買進,層=1,tid=1,...,lotShares=1000,...
//   賣出：20240215,90500,24.71,賣出,tid=1,avgRef=...,累計成本=...,價格差=...,
//                    稅後損益=...,報酬率%=...,累積損益=...,MAE%=...,MFE%=...,holdBars=...,holdMin=...,...
//
// - 單筆淨損益使用「稅後損益」(NTD)
// - 股數使用 tid 對應買進列的 lotShares（最後一個值）
// - KPI 以本金（預設 100 萬）為基準計算
// - 主圖：累積損益（週聚合，X 軸 5 個刻度）
// - 副圖：每週損益長條圖

(function () {
  'use strict';

  // ===== 全域設定 =====
  const CFG = {
    capital: 1000000  // 本金，從 input 調整
  };

  let gParsed = null;
  let gFile   = null;
  let gChart  = null;        // 主資產曲線
  let gWeeklyChart = null;   // 每週損益圖

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

  function tsToDate(ts) {
    if (!ts) return null;
    const clean = String(ts).replace(/\D/g, '');
    if (clean.length < 8) return null;
    const y  = parseInt(clean.slice(0, 4), 10);
    const m  = parseInt(clean.slice(4, 6), 10) - 1;
    const d  = parseInt(clean.slice(6, 8), 10);
    const hh = clean.length >= 10 ? parseInt(clean.slice(8, 10), 10) : 0;
    const mm = clean.length >= 12 ? parseInt(clean.slice(10, 12), 10) : 0;
    return new Date(y, m, d, hh, mm, 0);
  }

  function formatTs(date, time) {
    if (!date) return '';
    const d = String(date);
    const t = String(time || '000000');
    if (d.length !== 8) return date + ' ' + (time || '');
    const y = d.slice(0, 4);
    const m = parseInt(d.slice(4, 6), 10);
    const dd = parseInt(d.slice(6, 8), 10);
    let hh = '00', mm = '00';
    if (t.length >= 4) {
      hh = t.slice(0, 2);
      mm = t.slice(2, 4);
    }
    return `${y}/${m}/${dd} ${hh}:${mm}`;
  }

  function tsDayKey(ts) {
    if (!ts) return '';
    const clean = String(ts).replace(/\D/g, '');
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

  // ===== 解析 1031 TXT =====
  function parseStockTxt(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return { header: null, params: {}, trades: [], daily: {} };

    const headerLine = lines[0];
    const headerCols = headerLine.split(',');

    // 解析參數（從第 6 欄開始）
    const params = {};
    headerCols.slice(5).forEach(tok => {
      const t = tok.trim();
      if (!t) return;
      const parts = t.split('=');
      if (parts.length < 2) return;
      const key = parts[0].replace(/^_/, '').trim();
      const valStr = parts.slice(1).join('=').trim();
      const num = Number(valStr);
      params[key] = isFinite(num) ? num : valStr;
    });

    const dailyClose = {};      // date -> closeD
    const tidInfo   = {};       // tid -> { entryDate, entryTime, entryAvgRef, lastLotShares }
    const trades    = [];
    let cumNet      = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const cols = line.split(',');
      if (cols.length < 5) continue;

      const date = cols[0];
      const time = cols[1];
      const price = Number(cols[2]);
      const action = cols[3];
      const tail = cols.slice(4).map(s => s.trim()).filter(Boolean);

      // 把 key=value 轉成 kv 物件（支援中英文 key）
      const kv = {};
      tail.forEach(tok => {
        if (!tok) return;
        const parts = tok.split('=');
        if (parts.length < 2) return;
        const k = parts[0].trim();
        const v = parts.slice(1).join('=').trim();
        kv[k] = v;
      });

      if (action === '日線') {
        const closeStr = kv['closeD'] || kv['close'] || '';
        const c = Number(closeStr);
        if (isFinite(c)) {
          dailyClose[date] = c;
        }
        continue;
      }

      if (action === '買進') {
        const tid = kv['tid'];
        if (!tid) continue;
        const lotShares = Number(kv['lotShares'] || 0);
        const avgRef = Number(kv['avgRef'] || price);

        if (!tidInfo[tid]) {
          tidInfo[tid] = {
            tid,
            entryDate: date,
            entryTime: time,
            entryAvgRef: avgRef,
            lastLotShares: lotShares
          };
        } else {
          const info = tidInfo[tid];
          info.entryAvgRef = avgRef || info.entryAvgRef;
          if (lotShares) info.lastLotShares = lotShares;
        }
        continue;
      }

      if (action === '賣出') {
        const tid = kv['tid'];
        if (!tid) continue;

        const info = tidInfo[tid] || {
          tid,
          entryDate: date,
          entryTime: time,
          entryAvgRef: Number(kv['avgRef'] || price),
          lastLotShares: 0
        };

        const avgRef = Number(kv['avgRef'] || info.entryAvgRef || price);
        const priceDiff = Number(kv['價格差'] || 0);
        const pnlNet = Number(kv['稅後損益'] || 0);
        const retPct = Number(kv['報酬率%'] || 0) / 100;
        const cumPnlFromFile = Number(kv['累積損益'] || 0);
        const maePct = Number(kv['MAE%'] || 0) / 100;
        const mfePct = Number(kv['MFE%'] || 0) / 100;
        const holdBars = Number(kv['holdBars'] || 0);
        const holdMin = Number(kv['holdMin'] || 0);
        const minPxInHold = Number(kv['minPxInHold'] || 0);
        const maxPxInHold = Number(kv['maxPxInHold'] || 0);

        const shares = info.lastLotShares || 0;
        let gross = null;
        let cost = null;
        if (isFinite(priceDiff) && shares) {
          gross = priceDiff * shares;
          if (isFinite(pnlNet)) cost = gross - pnlNet;
        }

        cumNet += pnlNet;

        trades.push({
          idx: trades.length + 1,
          tid,
          entryDate: info.entryDate,
          entryTime: info.entryTime,
          entryAvgRef: avgRef,
          exitDate: date,
          exitTime: time,
          exitPrice: price,
          shares,
          pnlNet,
          retPct,
          cumNet,
          maePct,
          mfePct,
          holdMin,
          holdBars,
          minPxInHold,
          maxPxInHold,
          gross,
          cost,
          cumPnlFromFile
        });
      }
    }

    return {
      header: headerLine,
      params,
      trades,
      daily: dailyClose
    };
  }

  // ===== KPI 評等規則（沿用 single-trades 的邏輯） =====
  function rateMetric(key, value) {
    if (value == null || !isFinite(value)) return null;

    let label = 'Adequate';
    let css   = 'rating-adequate';
    let ref   = '—';

    switch (key) {
      case 'maxdd_pct':
        ref = '≦ 20% 強；20–30% 可接受；>30% 需優化';
        if (value <= 0.20)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.30)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'total_return':
      case 'cagr':
        ref = '≥ 15% 強；5–15% 可接受；<5% 需優化';
        if (value >= 0.15)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.05)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'pf':
        ref = '≥ 1.5 強；1.1–1.5 可接受；<1.1 需優化';
        if (value >= 1.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1.1)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'winrate':
        ref = '≥ 55% 強；45–55% 可接受；<45% 需優化';
        if (value >= 0.55)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.45)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'sharpe':
        ref = '≥ 1.5 強；0.8–1.5 可接受；<0.8 需優化';
        if (value >= 1.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.8)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'sortino':
        ref = '≥ 2 強；1–2 可接受；<1 需優化';
        if (value >= 2)          { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1)     { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'calmar':
        ref = '≥ 0.5 強；0.2–0.5 可接受；<0.2 需優化';
        if (value >= 0.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.2)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'risk_ruin':
        ref = '≦ 5% 強；5–20% 可接受；>20% 需優化';
        if (value <= 0.05)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.20)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      case 'cost_ratio':
        ref = '≦ 20% 強；20–40% 可接受；>40% 需優化';
        if (value <= 0.20)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.40)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;

      default:
        return null;
    }
    return { label, cssClass: css, ref };
  }

  // ===== 綜合分數卡片 =====
  function renderScore(score) {
    const card = $('#scoreCard');
    if (!card) return;

    if (score == null || !isFinite(score)) {
      card.innerHTML = `
        <div class="score-title">綜合分數</div>
        <div class="score-value">—</div>
        <div class="score-desc">載入檔案後自動計算</div>
      `;
      return;
    }

    const v = score.toFixed(1);
    let cls   = 'adequate';
    let label = 'Adequate';
    if (score >= 85) {
      cls   = 'strong';
      label = 'Strong';
    } else if (score < 70) {
      cls   = 'improve';
      label = 'Improve';
    }

    card.innerHTML = `
      <div class="score-title">綜合分數</div>
      <div class="score-value ${cls}">${v}</div>
      <div class="score-desc">${label}｜以核心 KPI 加權計算</div>
    `;
  }

  // ===== KPI 計算（股票版本：單一淨損益序列） =====
  function calcKpiStock(trades) {
    const n = trades.length;
    if (!n) return null;

    const pnls = trades.map(t => t.pnlNet);
    const exitDates = trades.map(t => tsToDate(t.exitDate + (t.exitTime || '')));

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
    const avgLoss = losses ? grossLoss  / losses  : 0;
    const payoff  = (avgLoss < 0) ? (avgWin / Math.abs(avgLoss)) : null;
    const pf      = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null;

    const mean  = avg;
    const varT  = n > 1 ? (sumSq / n - mean * mean) : 0;
    const stdev = varT > 0 ? Math.sqrt(varT) : 0;

    const sharpeTrade = stdev > 0 ? (mean / stdev) * Math.sqrt(n) : null;

    let downsideSq = 0;
    let downsideCnt = 0;
    pnls.forEach(p => {
      if (p < 0) {
        downsideSq += p * p;
        downsideCnt++;
      }
    });
    const downsideDev  = downsideCnt > 0 ? Math.sqrt(downsideSq / downsideCnt) : 0;
    const sortinoTrade = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(n) : null;

    // 累積損益 equity
    const equity = [];
    let cum = 0;
    pnls.forEach(p => {
      cum += p;
      equity.push(cum);
    });

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

    const timeToRecoveryTrades =
      maxDdEndIdx > maxDdStartIdx ? (maxDdEndIdx - maxDdStartIdx) : 0;

    // Ulcer Index
    const nav = equity.map(v => CFG.capital + v);
    let peakNav = 0;
    let sumDdSq = 0;
    for (let i = 0; i < nav.length; i++) {
      const v = nav[i];
      if (v > peakNav) peakNav = v;
      const ddPct = peakNav > 0 ? (peakNav - v) / peakNav : 0;
      sumDdSq += ddPct * ddPct;
    }
    const ulcerIndex     = nav.length ? Math.sqrt(sumDdSq / nav.length) : null;
    const recoveryFactor = maxDd > 0 ? totalNet / maxDd : null;

    // 日 / 週損益
    const dayMap = {};
    const weekMap = {};
    pnls.forEach((p, i) => {
      const t  = trades[i];
      const dk = tsDayKey(t.exitDate + (t.exitTime || ''));
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

    // Expectancy / Kelly / Risk of Ruin
    const expectancy = avg;
    let kelly = null;
    if (payoff != null && payoff > 0 && winRate > 0 && winRate < 1) {
      const p = winRate;
      const q = 1 - p;
      kelly = p - q / payoff;
    }

    let riskOfRuin = null;
    if (varT <= 0) {
      riskOfRuin = null;
    } else if (avg <= 0) {
      riskOfRuin = 1;
    } else {
      const mu     = avg;
      const sigma2 = varT;
      const exponent = -2 * mu * CFG.capital / sigma2;
      const r = Math.exp(exponent);
      riskOfRuin = Math.min(1, Math.max(0, r));
    }

    // 成本 / 週轉（以 gross 與 cost 欄位近似）
    let totalCost = 0;
    let totalGrossAbs = 0;
    let notionalTraded = 0;

    trades.forEach(t => {
      if (t.cost != null && isFinite(t.cost)) {
        totalCost += Math.max(0, t.cost);
      }
      const grossAbs = (t.gross != null && isFinite(t.gross))
        ? Math.abs(t.gross)
        : Math.abs(t.pnlNet);
      totalGrossAbs += grossAbs;

      // 名目金額，用平均價 * 股數 近似
      if (t.entryAvgRef && t.shares) {
        notionalTraded += t.entryAvgRef * t.shares;
      }
    });

    const turnover  = CFG.capital > 0 ? (notionalTraded / CFG.capital) : null;
    const costRatio = totalGrossAbs > 0 ? (totalCost / totalGrossAbs) : null;

    const tradingDays = Object.keys(dayMap).length;
    const tradesPerDay= tradingDays > 0 ? n / tradingDays : null;

    let totalHoldMin = 0;
    trades.forEach(t => {
      totalHoldMin += t.holdMin || 0;
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
      totalCost,
      costRatio
    };
  }

  // ===== KPI 呈現（單一版本） =====
  function renderKpiStock(kpi) {
    const tbody   = $('#kpiBody');
    const badBody = $('#kpiBadBody');
    if (!tbody || !badBody) return;
    tbody.innerHTML   = '';
    badBody.innerHTML = '';

    renderScore(null);

    if (!kpi) {
      badBody.innerHTML =
        '<tr><td colspan="5" style="color:#777;">尚未載入資料。</td></tr>';
      return;
    }

    const toStr = (fmt, v) => {
      if (v == null || !isFinite(v)) return '—';
      if (fmt === 'pct') {
        if (v < 0) return '—';
        if (v < 0.0001) return '<0.01%';
        return fmtPct(v);
      }
      if (fmt === 'f1')   return fmtFloat(v, 1);
      if (fmt === 'f2')   return fmtFloat(v, 2);
      if (fmt === 'f3')   return fmtFloat(v, 3);
      if (fmt === 'f4')   return fmtFloat(v, 4);
      return fmtInt(v);
    };

    const addSection = (title) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="kpi-section" colspan="5">${title}</td>`;
      tbody.appendChild(tr);
    };

    const badList = [];
    let scoreSum   = 0;
    let scoreCount = 0;

    const addRow = (key, name, fmt, val, desc) => {
      const sVal = toStr(fmt, val);

      const rating = key ? rateMetric(key, val) : null;
      const ratingLabel = rating ? rating.label : '—';
      const ratingClass = rating ? rating.cssClass : '';
      const refRange    = rating ? rating.ref      : '—';

      if (rating && rating.label && rating.label.startsWith('Improve')) {
        badList.push({
          name,
          valueStr: sVal,
          ratingLabel,
          ratingClass,
          refRange
        });
      }

      if (rating) {
        let pts = 0;
        if (rating.label === 'Strong')          pts = 90;
        else if (rating.label === 'Adequate')   pts = 75;
        else if (rating.label.startsWith('Improve')) pts = 60;
        scoreSum   += pts;
        scoreCount += 1;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="kpi-name">${name}</td>
        <td class="num ${ratingClass}">${sVal}</td>
        <td class="kpi-desc">${desc}</td>
        <td class="center ${ratingClass}">${ratingLabel}</td>
        <td class="center">${refRange}</td>
      `;
      tbody.appendChild(tr);
    };

    const a = kpi;

    // Tier 1
    addSection('Tier 1．生存與尾端風險（Risk / Survival）');
    addRow('maxdd_pct', '最大回撤率 Max Drawdown %',
      'pct', a.maxDdPct,
      '以本金為基準的最大淨值跌幅');
    addRow(null, '最大回撤金額 Max Drawdown',
      'int', a.maxDd,
      '累積淨損益的最大下跌金額');
    addRow('risk_ruin', '破產風險 Risk of Ruin（近似）',
      'pct', a.riskOfRuin,
      '以 Brownian 近似估算的長期觸及破產線機率（相對排序用）');
    addRow(null, '最差單日損益 Worst Day PnL',
      'int', a.worstDayPnl,
      '以出場日統計的單日最差實際損益');
    addRow(null, '最差單週損益 Worst Week PnL',
      'int', a.worstWeekPnl,
      '以出場週統計的單週最差實際損益');
    addRow(null, '95% VaR（單筆）',
      'int', a.varLoss,
      '以單筆損益分布估算的 95% Value-at-Risk 左尾損失門檻');
    addRow(null, '95% CVaR（單筆）',
      'int', a.cvarLoss,
      'VaR 左尾區間平均損失，衡量尾端風險嚴重度');
    addRow(null, '回神時間 Time to Recovery（筆）',
      'int', a.timeToRecoveryTrades,
      '最大回撤發生至重新創新高所需交易筆數');
    addRow(null, 'Ulcer Index',
      'f4', a.ulcerIndex,
      '以 NAV 下跌深度與持續時間綜合計算之痛苦指標');
    addRow(null, 'Recovery Factor',
      'f2', a.recoveryFactor,
      '總淨利 / 最大回撤，衡量從虧損中恢復能力');

    // Tier 2
    addSection('Tier 2．報酬與風險調整後報酬（Return / Risk-Adjusted）');
    addRow(null, '總淨利 Net Profit',
      'int', a.totalNet,
      '全部實際淨損益加總');
    addRow('total_return', '總報酬率 Total Return',
      'pct', a.totalReturnPct,
      '總淨利 / 本金，未年化');
    addRow('cagr', '年化報酬率 CAGR',
      'pct', a.cagr,
      '以第一筆與最後一筆出場日期估算年化報酬率');
    addRow(null, '單筆波動（交易級 Volatility）',
      'int', a.volPerTrade,
      '單筆實際損益標準差，未年化');
    addRow('sharpe', 'Sharpe Ratio（交易級）',
      'f2', a.sharpeTrade,
      '以單筆期望 / 單筆波動估算 Sharpe');
    addRow('sortino', 'Sortino Ratio（交易級）',
      'f2', a.sortinoTrade,
      '只用負報酬計算下行風險的 Sharpe 變形');
    addRow('calmar', 'Calmar Ratio',
      'f2', a.calmar,
      '年化報酬率 / 最大回撤率');

    // Tier 3
    addSection('Tier 3．交易品質與結構（Trade Quality / Structure）');
    addRow(null, '交易筆數 #Trades',
      'int', a.nTrades,
      '完整進出場筆數');
    addRow('winrate', '勝率 Hit Rate',
      'pct', a.winRate,
      '獲利筆數 / 總筆數');
    addRow(null, '平均單筆損益 Avg Trade PnL',
      'int', a.avg,
      '實際淨損益平均值');
    addRow(null, '平均獲利 Avg Win',
      'int', a.avgWin,
      '所有獲利單平均損益');
    addRow(null, '平均虧損 Avg Loss',
      'int', a.avgLoss,
      '所有虧損單平均損益');
    addRow(null, '賺賠比 Payoff Ratio',
      'f2', a.payoff,
      '平均獲利 / |平均虧損|，需與勝率一起看');
    addRow(null, '單筆期望值 Expectancy',
      'int', a.expectancy,
      '每筆交易期望損益');
    addRow('pf', '獲利因子 Profit Factor',
      'f2', a.pf,
      '總獲利 / |總虧損|');
    addRow(null, '總獲利 Gross Profit',
      'int', a.grossProfit,
      '所有獲利單損益加總');
    addRow(null, '總虧損 Gross Loss',
      'int', a.grossLoss,
      '所有虧損單損益加總');
    addRow(null, '最大獲利單 Largest Win',
      'int', a.largestWin,
      '單筆最大實際獲利');
    addRow(null, '最大虧損單 Largest Loss',
      'int', a.largestLoss,
      '單筆最大實際虧損');
    addRow(null, 'Kelly Fraction（理論值）',
      'f2', a.kelly,
      '依勝率與賺賠比估算之 Kelly 槓桿（僅供參考）');

    // Tier 4
    addSection('Tier 4．路徑與穩定度（Path / Stability）');
    addRow(null, 'Equity Stability R²',
      'f3', a.stabilityR2,
      '以 NAV 對時間做線性回歸的 R²，越接近 1 越平滑');

    // Tier 5
    addSection('Tier 5．成本、槓桿與執行（Cost / Turnover / Execution）');
    addRow(null, '交易天數 Trading Days',
      'int', a.tradingDays,
      '有出場交易的日期數');
    addRow(null, '平均每日交易數 Trades / Day',
      'f2', a.tradesPerDay,
      '交易筆數 / 交易天數');
    addRow(null, '平均持倉時間 Avg Holding Time（分鐘）',
      'f1', a.avgHoldMin,
      '進場到出場的平均持有時間');
    addRow(null, '名目週轉率 Turnover（Notional / Capital）',
      'f2', a.turnover,
      '所有進場名目金額 / 本金');
    addRow('cost_ratio', '成本佔交易金額比 Transaction Cost Ratio',
      'pct', a.costRatio,
      '近似：(手續費+稅) / (總交易金額)');
    addRow(null, '總交易成本 Total Trading Cost',
      'int', a.totalCost,
      '以 (價格差 * 股數 - 稅後損益) 估計之成本總額');

    // 建議優化指標卡片
    if (!badList.length) {
      badBody.innerHTML =
        '<tr><td colspan="5" style="color:#777;">目前沒有需要特別優化的指標。</td></tr>';
    } else {
      badBody.innerHTML = '';
      badList.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="kpi-name">${item.name}</td>
          <td class="num center ${item.ratingClass}">${item.valueStr}</td>
          <td class="center">建議優化</td>
          <td class="center ${item.ratingClass}">${item.ratingLabel}</td>
          <td class="center">${item.refRange}</td>
        `;
        badBody.appendChild(tr);
      });
    }

    const score = scoreCount > 0 ? (scoreSum / scoreCount) : null;
    renderScore(score);
  }

  // ===== 每週聚合工具（主圖用） =====
  function aggregateWeekly(dates, vals) {
    const outDates = [];
    const outVals  = [];
    let prevKey = null;
    let lastDate = null;
    let lastVal  = 0;

    for (let i = 0; i < vals.length; i++) {
      const d = dates[i];
      if (!d) continue;
      const key = dateWeekKey(d);
      if (prevKey !== null && key !== prevKey) {
        outDates.push(lastDate);
        outVals.push(lastVal);
      }
      prevKey = key;
      lastDate = d;
      lastVal  = vals[i];
    }
    if (lastDate != null) {
      outDates.push(lastDate);
      outVals.push(lastVal);
    }
    if (outDates.length > 0) {
      outDates.unshift(outDates[0]);
      outVals.unshift(0);
    }
    return { dates: outDates, vals: outVals };
  }

  // ===== 主資產曲線（週聚合） =====
  function renderEquityChart(exitDates, equitySeries) {
    const canvas = $('#equityChart');
    if (!canvas || !window.Chart) return;
    const ctx = canvas.getContext('2d');

    const agg = aggregateWeekly(exitDates, equitySeries);
    const weekDates = agg.dates;
    const vals      = agg.vals;
    const labels    = vals.map((_, i) => i + 1);

    // 最高 / 最低點
    let maxVal = -Infinity, minVal = Infinity;
    let maxIdx = null,      minIdx = null;
    for (let i = 1; i < vals.length; i++) {
      const v = vals[i];
      if (v > maxVal) { maxVal = v; maxIdx = i; }
      if (v < minVal) { minVal = v; minIdx = i; }
    }
    const maxMarker = vals.map((_, i) => (i === maxIdx ? vals[i] : null));
    const minMarker = vals.map((_, i) => (i === minIdx ? vals[i] : null));

    if (gChart) {
      gChart.destroy();
      gChart = null;
    }

    const tickIndexToLabel = {};
    if (weekDates.length > 0 && labels.length === weekDates.length) {
      const last = weekDates.length - 1;
      const ratios = [0, 0.25, 0.5, 0.75, 1];
      ratios.forEach(r => {
        const idx = Math.round(last * r);
        const d   = weekDates[idx];
        if (!d) return;
        const y = d.getFullYear();
        const m = d.getMonth() + 1;
        tickIndexToLabel[idx] = `${y}/${m}`;
      });
    }

    gChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '累積損益（稅後）',
            data: vals,
            borderColor: 'rgba(0,0,0,1)',
            backgroundColor: 'rgba(0,0,0,0)',
            borderWidth: 2,
            tension: 0,
            pointRadius: 0
          },
          {
            label: '期間最高點',
            data: maxMarker,
            borderColor: 'rgba(220,0,0,0)',
            backgroundColor: 'rgba(220,0,0,1)',
            pointRadius: 4,
            pointHoverRadius: 5,
            showLine: false
          },
          {
            label: '期間最低點',
            data: minMarker,
            borderColor: 'rgba(0,150,0,0)',
            backgroundColor: 'rgba(0,150,0,1)',
            pointRadius: 4,
            pointHoverRadius: 5,
            showLine: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: true,
            position: 'top'
          },
          tooltip: {
            callbacks: {
              title: function (items) {
                const idx = items[0].dataIndex;
                const d   = weekDates[idx];
                if (!d) return '';
                const y = d.getFullYear();
                const m = (d.getMonth() + 1).toString().padStart(2, '0');
                const day = d.getDate().toString().padStart(2, '0');
                return `${y}/${m}/${day}`;
              },
              label: function (ctx) {
                const v = ctx.parsed.y;
                return `${ctx.dataset.label}: ${fmtInt(v)}`;
              }
            }
          }
        },
        scales: {
          x: {
            display: true,
            title: { display: true, text: '日期' },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              callback: function (value, index) {
                return tickIndexToLabel[index] || '';
              }
            }
          },
          y: {
            display: true,
            title: { display: true, text: '累積損益（NT$）' }
          }
        }
      }
    });
  }

  // ===== 每週損益圖 =====
  function renderWeeklyPnlChart(weekDates, weekPnls) {
    const canvas = $('#weeklyPnlChart');
    if (!canvas || !window.Chart) return;
    const ctx = canvas.getContext('2d');

    if (gWeeklyChart) {
      gWeeklyChart.destroy();
      gWeeklyChart = null;
    }
    if (!weekDates.length) return;

    const labels = weekDates.map((d, i) => i + 1);
    const tickIndexToLabel = {};
    const last = weekDates.length - 1;
    const ratios = [0, 0.25, 0.5, 0.75, 1];
    ratios.forEach(r => {
      const idx = Math.round(last * r);
      const d   = weekDates[idx];
      if (!d) return;
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      tickIndexToLabel[idx] = `${y}/${m}`;
    });

    const pos = weekPnls.map(v => (v > 0 ? v : null));
    const neg = weekPnls.map(v => (v < 0 ? v : null));

    gWeeklyChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '每週獲利（>0）',
            data: pos,
            borderColor: 'rgba(220,0,0,1)',
            backgroundColor: 'rgba(220,0,0,0.8)',
            borderWidth: 1,
            barPercentage: 0.7,
            categoryPercentage: 0.9
          },
          {
            label: '每週虧損（<0）',
            data: neg,
            borderColor: 'rgba(0,150,0,1)',
            backgroundColor: 'rgba(0,150,0,0.8)',
            borderWidth: 1,
            barPercentage: 0.7,
            categoryPercentage: 0.9
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: true,
            position: 'top'
          },
          tooltip: {
            callbacks: {
              title: function (items) {
                const idx = items[0].dataIndex;
                const d   = weekDates[idx];
                if (!d) return '';
                const y = d.getFullYear();
                const m = (d.getMonth() + 1).toString().padStart(2, '0');
                const day = d.getDate().toString().padStart(2, '0');
                return `${y}/${m}/${day}`;
              },
              label: function (ctx) {
                const v = ctx.parsed.y;
                return `${ctx.dataset.label}: ${fmtInt(v)}`;
              }
            }
          }
        },
        scales: {
          x: {
            display: true,
            title: { display: true, text: '週期' },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              callback: function (value, index) {
                return tickIndexToLabel[index] || '';
              }
            }
          },
          y: {
            display: true,
            title: { display: true, text: '每週損益（NT$）' }
          }
        }
      }
    });
  }

  // ===== 交易明細 + 圖表 + KPI =====
  function renderTrades(parsed) {
    const tbody = $('#tradesBody');
    tbody.innerHTML = '';

    const paramLine = $('#paramLine');
    if (paramLine) {
      paramLine.textContent = parsed && parsed.header ? parsed.header : '';
    }

    if (!parsed || !parsed.trades.length) {
      renderKpiStock(null);
      renderEquityChart([], []);
      renderWeeklyPnlChart([], []);
      return;
    }

    const trades = parsed.trades.slice(); // 已經排序依照 TXT 順序

    // 填交易表格
    trades.forEach(t => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${t.idx}</td>
        <td>${t.tid}</td>
        <td>${formatTs(t.entryDate, t.entryTime)}</td>
        <td>${fmtFloat(t.entryAvgRef, 3)}</td>
        <td>${formatTs(t.exitDate, t.exitTime)}</td>
        <td>${fmtFloat(t.exitPrice, 3)}</td>
        <td>${fmtInt(t.shares)}</td>
        <td class="${clsForNumber(t.pnlNet)}">${fmtSignedInt(t.pnlNet)}</td>
        <td class="${clsForNumber(t.retPct)}">${fmtPct(t.retPct)}</td>
        <td class="${clsForNumber(t.cumNet)}">${fmtSignedInt(t.cumNet)}</td>
        <td class="${clsForNumber(t.maePct)}">${fmtPct(t.maePct)}</td>
        <td class="${clsForNumber(t.mfePct)}">${fmtPct(t.mfePct)}</td>
        <td>${fmtFloat(t.holdMin, 1)}</td>
      `;
      tbody.appendChild(tr);
    });

    // KPI
    const kpi = calcKpiStock(trades);
    renderKpiStock(kpi);

    // 主圖：累積損益
    const exitDates = trades.map(t => tsToDate(t.exitDate + (t.exitTime || '')));
    const equitySeries = trades.map(t => t.cumNet);
    renderEquityChart(exitDates, equitySeries);

    // 副圖：每週損益
    const weekMap = {};
    trades.forEach(t => {
      const d = tsToDate(t.exitDate + (t.exitTime || ''));
      if (!d) return;
      const key = dateWeekKey(d);
      if (!weekMap[key]) {
        weekMap[key] = { sum: 0, date: d };
      } else if (d > weekMap[key].date) {
        weekMap[key].date = d;
      }
      weekMap[key].sum += t.pnlNet;
    });
    const weekKeys = Object.keys(weekMap).sort();
    const weekDatesArr = [];
    const weekPnlsArr  = [];
    weekKeys.forEach(k => {
      weekDatesArr.push(weekMap[k].date);
      weekPnlsArr.push(weekMap[k].sum);
    });
    renderWeeklyPnlChart(weekDatesArr, weekPnlsArr);
  }

  // ===== 事件綁定 =====
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

  $('#runBtn').addEventListener('click', function () {
    if (!gFile) {
      alert('請先選擇 1031 TXT 檔案');
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      const text = e.target.result || '';
      const parsed = parseStockTxt(text);
      gParsed = parsed;
      renderTrades(parsed);
    };
    reader.readAsText(gFile);
  });

})();
