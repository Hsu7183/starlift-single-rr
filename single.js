/* 單檔頁面（6 線圖 + 三行KPI + Risk-Return 六大類：中文｜數值｜說明＋機構參考，不含第七段） */
(function () {
  const $ = s => document.querySelector(s);

  // 允許網址帶參數 ?nav=1000000&rf=0.01
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get("nav")) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get("rf"))  || 0.00; // 年化

  let chart;

  // =============== 圖表 ===============
  function drawChart(ser) {
    if (chart) chart.destroy();
    const { tsArr, total, slipTotal, long, longSlip, short, shortSlip } = ser;
    const labels = tsArr.map((_, i) => i);
    const mkSolid = (data, col, w) => ({ data, stepped: true, borderColor: col, borderWidth: w, pointRadius: 0 });
    const mkDash  = (data, col, w) => ({ data, stepped: true, borderColor: col, borderWidth: w, pointRadius: 0, borderDash: [6,4] });

    chart = new Chart($("#chart"), {
      type: "line",
      data: { labels, datasets: [
        mkSolid(slipTotal, "#111111", 3.5),
        mkDash (total,     "#9e9e9e", 2),
        mkSolid(longSlip,  "#d32f2f", 3),
        mkDash (long,      "#ef9a9a", 2),
        mkSolid(shortSlip, "#2e7d32", 3),
        mkDash (short,     "#a5d6a7", 2),
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins:{legend:{display:false}}, scales:{x:{grid:{display:false},ticks:{display:false}}}}
    });
  }

  // =============== 舊版三行 KPI（保留） ===============
  function buildKpiLines(statAll, statL, statS) {
    const { fmtMoney, pct } = window.SHARED;
    const mk = s => ([
      ["交易數", String(s.count)], ["勝率", pct(s.winRate)], ["敗率", pct(s.loseRate)],
      ["單日最大獲利", fmtMoney(s.dayMax)], ["單日最大虧損", fmtMoney(s.dayMin)],
      ["區間最大獲利", fmtMoney(s.up)], ["區間最大回撤", fmtMoney(s.dd)],
      ["累積獲利", fmtMoney(s.gain)],
    ]);
    const rows = [mk(statAll), mk(statL), mk(statS)];
    const maxW = rows[0].map((_, i) => Math.max(...rows.map(r => r[i][1].length)));
    const padL = (s, w) => s.padStart(w, " ");
    const join = (label, cols) => `${label}： ` + cols.map((c, i) => `${c[0]} ${padL(c[1], maxW[i])}`).join(" ｜ ");
    return [ join("全部（含滑價）", rows[0]), join("多單（含滑價）", rows[1]), join("空單（含滑價）", rows[2]) ];
  }

  // =============== 明細表 ===============
  function renderTable(report) {
    const { fmtTs, fmtMoney, MULT, FEE, TAX } = window.SHARED;
    const tb = document.querySelector("#tradeTable tbody");
    tb.innerHTML = "";
    let cum = 0, cumSlip = 0;
    report.trades.forEach((t, i) => {
      cum     += t.gain;
      cumSlip += t.gainSlip;
      const tr1 = document.createElement("tr");
      tr1.innerHTML = `
        <td rowspan="2">${i+1}</td>
        <td>${fmtTs(t.pos.tsIn)}</td><td>${t.pos.pIn}</td><td>${t.pos.side==='L'?'新買':'新賣'}</td>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>`;
      const tr2 = document.createElement("tr");
      tr2.innerHTML = `
        <td>${fmtTs(t.tsOut)}</td><td>${t.priceOut}</td><td>${t.pos.side==='L'?'平賣':'平買'}</td>
        <td>${t.pts}</td><td>${FEE*2}</td><td>${Math.round(t.priceOut*MULT*TAX)}</td>
        <td>${fmtMoney(t.gain)}</td><td>${fmtMoney(cum)}</td>
        <td>${fmtMoney(t.gainSlip)}</td><td>${fmtMoney(cumSlip)}</td>`;
      tb.appendChild(tr1); tb.appendChild(tr2);
    });
  }

  // =============== RR 計算（全部用『含滑價 gainSlip』） ===============
  function computeRR(dailySlip, trades, nav = DEFAULT_NAV, rf = DEFAULT_RF) {
    // 權益曲線 & MDD/TUW/Recovery
    let cum = 0;
    const eq = dailySlip.map(d => ({ date: d.date, nav: (cum += d.pnl, nav + cum) }));
    let peak = -Infinity, maxDD = 0, curTUW = 0, maxTUW = 0, inDraw = false, rec = 0, curRec = 0;
    for (const p of eq) {
      if (p.nav > peak) {
        peak = p.nav;
        if (inDraw) { rec = Math.max(rec, curRec); inDraw = false; }
        curTUW = 0; curRec = 0;
      } else {
        const dd = peak - p.nav;
        if (dd > maxDD) { maxDD = dd; inDraw = true; curRec = 0; }
        curTUW++; curRec++; maxTUW = Math.max(maxTUW, curTUW);
      }
    }

    // 報酬序列（以 NAV 作分母）
    const dailyRet = dailySlip.map(d => d.pnl / nav);
    const mean     = avg(dailyRet);
    const vol      = stdev(dailyRet) * Math.sqrt(252);
    const downside = stdev(dailyRet.filter(x => x < (rf/252))) * Math.sqrt(252);

    // 年化與期望值
    const startDate = dailySlip.length ? dailySlip[0].date : null;
    theEndDate  = dailySlip.length ? dailySlip[dailySlip.length-1].date : null;
    const dayCnt    = (startDate && theEndDate) ? Math.max(1, daysBetween(startDate, theEndDate)) : 252;
    const years     = Math.max(dayCnt/365, 1/365);

    const totalPnL  = sum(dailySlip.map(d => d.pnl));
    const cagr      = Math.pow((nav + totalPnL)/nav, 1/years) - 1;
    const annRet    = mean * 252;
    const sharpe    = vol>0      ? ((annRet - rf)/vol)      : 0;
    const sortino   = downside>0 ? ((annRet - rf)/downside) : 0;
    const MAR       = maxDD>0    ? (cagr / (maxDD/nav))     : 0;

    // VaR / ES（歷史模擬）
    const q  = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const i=Math.floor((1-p)*a.length); return a[Math.max(0,Math.min(i,a.length-1))]||0; };
    const ES = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const cut=Math.floor((1-p)*a.length); const sl=a.slice(0,cut); return sl.length? -(sum(sl)/sl.length)*nav : 0; };
    const var95 = Math.abs(q(dailyRet,0.05))*nav, var99 = Math.abs(q(dailyRet,0.01))*nav;
    const es95  = Math.abs(ES(dailyRet,0.95)),    es99  = Math.abs(ES(dailyRet,0.99));

    // 交易層（含滑價）
    const wins    = trades.filter(t => t.gainSlip > 0);
    const losses  = trades.filter(t => t.gainSlip < 0);
    const winPnL  = sum(wins.map(t => t.gainSlip));
    const losePnL = sum(losses.map(t => t.gainSlip));
    const PF      = Math.abs(losePnL) > 0 ? (winPnL / Math.abs(losePnL)) : 0;
    const avgWin  = wins.length ? (winPnL / wins.length) : 0;
    const avgLoss = losses.length ? Math.abs(losePnL / losses.length) : 0;
    const payoff  = avgLoss>0 ? (avgWin/avgLoss) : 0;
    const winRate = trades.length ? (wins.length / trades.length) : 0;
    const expectancy = trades.length ? (totalPnL / trades.length) : 0;

    // 連勝/連敗、單日/單筆極值、持倉/頻率
    let maxWS=0,maxLS=0, curW=0,curL=0;
    for (const t of trades) {
      if (t.gainSlip>0) { curW++; maxWS=Math.max(maxWS,curW); curL=0; }
      else if (t.gainSlip<0) { curL++; maxLS=Math.max(maxLS,curL); curW=0; }
      else { curW=0; curL=0; }
    }
    const byDaySlip = (()=>{ const m=new Map(); for(const t of trades){ const d=keyFromTs(t.tsOut); m.set(d,(m.get(d)||0)+t.gainSlip); } return [...m.values()]; })();
    const maxDailyLoss  = Math.abs(Math.min(0, ...byDaySlip));
    const maxDailyGain  = Math.max(0, ...byDaySlip, 0);
    const maxTradeLoss  = Math.abs(Math.min(0, ...trades.map(t=>t.gainSlip)));
    const maxTradeGain  = Math.max(0, ...trades.map(t=>t.gainSlip), 0);

    const holdMinsArr    = trades.map(t => tsDiffMin(t.pos.tsIn, t.tsOut)).filter(Number.isFinite);
    const avgHoldingMins = holdMinsArr.length ? avg(holdMinsArr) : 0;
    const months         = Math.max(1, monthsBetween(startDate, theEndDate));
    const tradesPerMonth = trades.length / months;

    // 滾動 Sharpe（6M ≈ 126 交易日）中位數
    const rollSharpe     = rollingSharpe(dailyRet, 126, DEFAULT_RF/252);
    const rollSharpeMed  = rollSharpe.length ? median(rollSharpe) : 0;

    return {
      // 報酬
      totalPnL, cagr, annRet, winRate, expectancy,
      // 風險
      maxDD, maxTUW: Math.round(maxTUW), recovery: Math.round(rec),
      vol, downside, var95, var99, es95, es99,
      maxDailyLoss, maxDailyGain, maxTradeLoss, maxTradeGain,
      // 風險調整
      sharpe, sortino, MAR, PF,
      // 交易結構
      payoff, avgWin, avgLoss, maxWS, maxLS, avgHoldingMins, tradesPerMonth,
      // 穩健性
      rollSharpeMed
    };
  }

  // =============== 六大類輸出：中文｜數值｜說明（尾端附「機構參考」） ===============
  function renderRR6Cats(k){
    const money  = n => (Number(n)||0).toLocaleString("zh-TW");
    const pmoney = n => (Number(n)>0? "" : "-") + money(Math.abs(Number(n)||0));
    const pct2   = x => (Number.isFinite(x)? (x*100).toFixed(2) : "0.00") + "%";
    const fix2   = x => Number(x).toFixed(2);

    // 機構門檻（已合併到每行，不會再獨立成第七段）
    const BM = {
      sharpe : "機構參考：>1 可接受｜>1.5 穩健｜>2 佳",
      sortino: "機構參考：通常高於 Sharpe；>1.5 穩健｜>2 佳",
      mar    : "機構參考：>1 佳｜>2 很佳（CTA）",
      pf     : "機構參考：>1.5 穩健｜>2 很好",
      win    : "機構參考：無硬性門檻，需與盈虧比搭配",
      varEs  : "機構參考：依風控額度與日損熄火規則設定",
      vol    : "機構參考：依基金目標年化波動（常見 8%~15%）",
      exp    : "機構參考：>0 並能覆蓋交易成本/滑價",
    };

    const L = [];

    // 1 報酬
    L.push("一、報酬（Return）");
    L.push(`總報酬（Total Return）｜${money(k.totalPnL)}｜回測累積淨損益（含手續費/稅/滑價）。`);
    L.push(`CAGR（年化複利）｜${pct2(k.cagr)}｜以 NAV 為分母，依實際天數年化。`);
    L.push(`平均每筆（Expectancy）｜${money(k.expectancy)}｜每筆平均淨損益（含滑價）。｜${BM.exp}`);
    L.push(`年化報酬（Arithmetic）｜${pct2(k.annRet)}｜日均報酬 × 252。`);
    L.push(`勝率（Hit Ratio）｜${pct2(k.winRate)}｜獲利筆數 ÷ 總筆數。｜${BM.win}`);
    L.push("");

    // 2 風險
    L.push("二、風險（Risk）");
    L.push(`最大回撤（MaxDD）｜${pmoney(-k.maxDD)}｜峰值到谷值最大跌幅（以金額）。`);
    L.push(`水下時間（TUW）｜${k.maxTUW}｜在水下的最長天數。`);
    L.push(`回本時間（Recovery）｜${k.recovery}｜自 MDD 末端至再創新高的天數。`);
    L.push(`波動率（Volatility）｜${pct2(k.vol)}｜日報酬標準差 × √252。｜${BM.vol}`);
    L.push(`下行波動（Downside Dev）｜${pct2(k.downside)}｜只計下行（供 Sortino）。`);
    L.push(`VaR 95%｜${pmoney(-k.var95)}｜單日 95% 置信最大虧損（歷史模擬，金額）。｜${BM.varEs}`);
    L.push(`ES 95%（CVaR）｜${pmoney(-k.es95)}｜落於 VaR95 之後的平均虧損。｜${BM.varEs}`);
    L.push(`VaR 99%｜${pmoney(-k.var99)}｜單日 99% 置信最大虧損。｜${BM.varEs}`);
    L.push(`ES 99%｜${pmoney(-k.es99)}｜落於 VaR99 之後的平均虧損。｜${BM.varEs}`);
    L.push(`單日最大虧損｜${pmoney(-k.maxDailyLoss)}｜樣本期間最糟的一天。`);
    L.push(`單日最大獲利｜${money(k.maxDailyGain)}｜樣本期間最佳的一天。`);
    L.push(`單筆最大虧損｜${pmoney(-k.maxTradeLoss)}｜樣本期間最糟的一筆交易。`);
    L.push(`單筆最大獲利｜${money(k.maxTradeGain)}｜樣本期間最佳的一筆交易。`);
    L.push("");

    // 3 風險調整
    L.push("三、風險調整報酬（Risk-Adjusted Return）");
    L.push(`Sharpe（夏普）｜${fix2(k.sharpe)}｜（年化報酬 − rf）／年化波動。｜${BM.sharpe}`);
    L.push(`Sortino（索提諾）｜${fix2(k.sortino)}｜只懲罰下行波動。｜${BM.sortino}`);
    L.push(`MAR｜${fix2(k.MAR)}｜CAGR ÷ |MDD|（CTA 常用）。｜${BM.mar}`);
    L.push(`PF（獲利因子）｜${fix2(k.PF)}｜總獲利 ÷ 總虧損（含成本/滑價）。｜${BM.pf}`);
    L.push("");

    // 4 交易結構與執行品質
    L.push("四、交易結構與執行品質（Trade-Level & Execution）");
    L.push(`盈虧比（Payoff）｜${fix2(k.payoff)}｜平均獲利 ÷ 平均虧損。`);
    L.push(`平均獲利單｜${money(k.avgWin)}｜含滑價的平均獲利金額。`);
    L.push(`平均虧損單｜${pmoney(-k.avgLoss)}｜含滑價的平均虧損金額。`);
    L.push(`最大連勝｜${k.maxWS}｜連續獲利筆數。`);
    L.push(`最大連敗｜${k.maxLS}｜連續虧損筆數。`);
    L.push(`平均持倉時間｜${fix2(k.avgHoldingMins)} 分｜tsIn→tsOut 的平均分鐘數。`);
    L.push(`交易頻率｜${fix2(k.tradesPerMonth)} 筆/月｜以回測期間月份估算。`);
    L.push("");

    // 5 穩健性
    L.push("五、穩健性與可複製性（Robustness & Statistical Soundness）");
    L.push(`滾動 Sharpe（6個月中位）｜${fix2(k.rollSharpeMed)}｜126 交易日窗的 Sharpe 中位數。｜${BM.sharpe}`);
    L.push(`樣本外（OOS）｜—｜需提供 OOS 資料後評估。`);
    L.push(`參數敏感度｜—｜需做 ±10~20% 擾動測試。`);
    L.push(`Regime 分析｜—｜需標註趨勢/震盪、高/低波動區間。`);
    L.push("");

    // 6 風險用量與容量
    L.push("六、風險用量、槓桿與容量（Risk Usage, Leverage & Capacity）");
    L.push(`槓桿（Leverage）｜—｜需名目曝險/權益資料。`);
    L.push(`風險貢獻（Risk Contribution）｜—｜需多資產/子策略分解。`);
    L.push(`容量/流動性（Capacity）｜—｜需市場量與參與率/衝擊估計。`);

    $("#rrLines").textContent = L.join("\n");
  }

  // =============== 主流程 ===============
  async function handleRaw(raw) {
    const { parseTXT, buildReport, paramsLabel } = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);
    if (report.trades.length === 0) { alert("沒有成功配對的交易"); return; }

    // 圖
    drawChart({
      tsArr: report.tsArr,
      total: report.total,
      slipTotal: report.slipCum,
      long: report.longCum,
      longSlip: report.longSlipCum,
      short: report.shortCum,
      shortSlip: report.shortSlipCum,
    });

    // 舊版三行 KPI
    const [lineAll, lineL, lineS] = buildKpiLines(report.statAll, report.statL, report.statS);
    $("#paramChip").textContent = paramsLabel(parsed.params);
    $("#kpiAll").textContent = lineAll;
    $("#kpiL").textContent  = lineL;
    $("#kpiS").textContent  = lineS;

    // 以『含滑價 gainSlip 的出場日』聚合成日損益（字串切片，不用 Date 解析）
    const dailyMap = new Map();
    for (const t of report.trades) {
      const key = keyFromTs(t.tsOut);             // "YYYY-MM-DD"
      dailyMap.set(key, (dailyMap.get(key)||0) + t.gainSlip);
    }
    const dailySlip = [...dailyMap.entries()]
      .sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([date,pnl]) => ({ date, pnl }));

    // 六大類 KPI
    const k = computeRR(dailySlip, report.trades, DEFAULT_NAV, DEFAULT_RF);
    renderRR6Cats(k);

    // 明細
    renderTable(report);
  }

  // 事件
  document.getElementById("btn-clip").addEventListener("click", async () => {
    const txt = await navigator.clipboard.readText();
    handleRaw(txt);
  });
  document.getElementById("file").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const txt = await window.SHARED.readAsTextAuto(f); await handleRaw(txt); }
    catch (err) { alert(err.message || "讀檔失敗"); }
  });

  // ===== 工具 =====
  function keyFromTs(ts){           // ts: "YYYYMMDD..." → "YYYY-MM-DD"
    const s = String(ts);
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }
  function daysBetween(isoA, isoB){
    const a = new Date(isoA + "T00:00:00");
    const b = new Date(isoB + "T00:00:00");
    return Math.round((b - a)/86400000) + 1;
  }
  function monthsBetween(isoA, isoB){
    if(!isoA || !isoB) return 1;
    const a = new Date(isoA + "T00:00:00");
    const b = new Date(isoB + "T00:00:00");
    return Math.max(1,(b.getFullYear()-a.getFullYear())*12 + (b.getMonth()-a.getMonth()) + 1);
  }
  function tsDiffMin(tsIn, tsOut){
    if(!tsIn||!tsOut) return NaN;
    const d1 = new Date(`${tsIn.slice(0,4)}-${tsIn.slice(4,6)}-${tsIn.slice(6,8)}T${tsIn.slice(8,10)}:${tsIn.slice(10,12)}:${tsIn.slice(12,14)||"00"}`);
    const d2 = new Date(`${tsOut.slice(0,4)}-${tsOut.slice(4,6)}-${tsOut.slice(6,8)}T${tsOut.slice(8,10)}:${tsOut.slice(10,12)}:${tsOut.slice(12,14)||"00"}`);
    return Math.max(0, (d2-d1)/60000);
  }
  function sum(a){ return a.reduce((x,y)=>x+y,0); }
  function avg(a){ return a.length ? sum(a)/a.length : 0; }
  function stdev(a){ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
  function median(a){ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2? b[m] : (b[m-1]+b[m])/2; }
  function rollingSharpe(ret, win=126, rfDaily=0){
    const out=[];
    for(let i=win;i<=ret.length;i++){
      const seg = ret.slice(i-win,i);
      const m   = avg(seg) - rfDaily;
      const v   = stdev(seg);
      out.push(v>0 ? (m/v)*Math.sqrt(252) : 0);
    }
    return out;
  }
})();
