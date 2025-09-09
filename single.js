/* 單檔頁面（6 線圖 + 單行KPI + Risk-Return 六大類：中文｜數值｜說明） */
(function(){
  const $ = s=>document.querySelector(s);

  // 可用網址參數帶入 ?nav=1000000&rf=0.01
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get('nav')) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get('rf'))  || 0.00; // 年化

  const cvs = $('#chart');
  let chart;

  // ====== 6 線圖 ======
  function drawChart(ser){
    if(chart) chart.destroy();
    const {tsArr, total, slipTotal, long, longSlip, short, shortSlip} = ser;
    const labels = tsArr.map((_,i)=>i);
    const mkSolid=(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0});
    const mkDash =(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0,borderDash:[6,4]});
    chart = new Chart(cvs,{
      type:'line',
      data:{labels, datasets:[
        mkSolid(slipTotal,'#111111',3.5),         // 含滑價：黑實
        mkDash(total,'#9e9e9e',2),                // 不含滑價：灰虛
        mkSolid(longSlip,'#d32f2f',3), mkDash(long,'#ef9a9a',2),
        mkSolid(shortSlip,'#2e7d32',3), mkDash(short,'#a5d6a7',2),
      ]},
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{display:false}},
        scales:{x:{grid:{display:false},ticks:{display:false}}}
      }
    });
  }

  // ====== 舊版三行 KPI（保留你的原樣） ======
  function buildKpiLines(statAll, statL, statS){
    const {fmtMoney,pct} = window.SHARED;
    const mk = s => ([
      ['交易數', String(s.count)],
      ['勝率',   pct(s.winRate)],
      ['敗率',   pct(s.loseRate)],
      ['單日最大獲利', fmtMoney(s.dayMax)],
      ['單日最大虧損', fmtMoney(s.dayMin)],
      ['區間最大獲利', fmtMoney(s.up)],
      ['區間最大回撤', fmtMoney(s.dd)],
      ['累積獲利',     fmtMoney(s.gain)],
    ]);
    const rows = [mk(statAll), mk(statL), mk(statS)];
    const maxW = rows[0].map((_,i)=>Math.max(...rows.map(r=>r[i][1].length)));
    const padL = (s,w)=> s.padStart(w,' ');
    const join = (label, cols)=> `${label}： ` + cols.map((c,i)=>`${c[0]} ${padL(c[1],maxW[i])}`).join(' ｜ ');
    return [
      join('全部（含滑價）', rows[0]),
      join('多單（含滑價）', rows[1]),
      join('空單（含滑價）', rows[2]),
    ];
  }

  // ====== 交易明細表 ======
  function renderTable(report){
    const {fmtTs, fmtMoney, MULT, FEE, TAX} = window.SHARED;
    const tb = document.querySelector('#tradeTable tbody');
    tb.innerHTML = '';
    let cum=0, cumSlip=0;
    report.trades.forEach((t,i)=>{
      cum += t.gain;            // 帳面
      cumSlip += t.gainSlip;    // 含滑價
      const tr1 = document.createElement('tr');
      tr1.innerHTML = `
        <td rowspan="2">${i+1}</td>
        <td>${fmtTs(t.pos.tsIn)}</td><td>${t.pos.pIn}</td><td>${t.pos.side==='L'?'新買':'新賣'}</td>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>`;
      const tr2 = document.createElement('tr');
      tr2.innerHTML = `
        <td>${fmtTs(t.tsOut)}</td><td>${t.priceOut}</td><td>${t.pos.side==='L'?'平賣':'平買'}</td>
        <td>${t.pts}</td><td>${FEE*2}</td><td>${Math.round(t.priceOut*MULT*TAX)}</td>
        <td>${fmtMoney(t.gain)}</td><td>${fmtMoney(cum)}</td>
        <td>${fmtMoney(t.gainSlip)}</td><td>${fmtMoney(cumSlip)}</td>`;
      tb.appendChild(tr1); tb.appendChild(tr2);
    });
  }

  // ====== Risk-Return 計算（全部用「含滑價 gainSlip」） ======
  function computeRiskReturnKPI(dailySlip, trades, nav = DEFAULT_NAV, rf = DEFAULT_RF){
    // 權益曲線 & MDD/TUW/Recovery
    let cum = 0;
    const eq = dailySlip.map(d => ({ date:d.date, nav: (cum += d.pnl, nav + cum) }));
    let peak=-Infinity, maxDD=0, curTUW=0, maxTUW=0, inDraw=false, rec=0, curRec=0;
    for (const p of eq){
      if (p.nav > peak){
        peak = p.nav;
        if (inDraw){ rec = Math.max(rec, curRec); inDraw = false; }
        curTUW = 0; curRec = 0;
      } else {
        const dd = peak - p.nav;
        if (dd > maxDD){ maxDD = dd; inDraw = true; curRec = 0; }
        curTUW++; curRec++; maxTUW = Math.max(maxTUW, curTUW);
      }
    }

    // 報酬序列（以 NAV 作分母）
    const dailyRet = dailySlip.map(d => d.pnl / nav);
    const mean = avg(dailyRet);
    const vol  = stdev(dailyRet) * Math.sqrt(252);
    const downside = stdev(dailyRet.filter(x => x < (rf/252))) * Math.sqrt(252);

    // 年化 / 期望值
    const startDate = dailySlip.at(0)?.date, endDate = dailySlip.at(-1)?.date;
    const days = (startDate && endDate) ? Math.max(1, Math.round((new Date(endDate) - new Date(startDate))/86400000) + 1) : 252;
    const years = Math.max(days/365, 1/365);
    const totalPnL = sum(dailySlip.map(d=>d.pnl));
    const cagr = Math.pow((nav + totalPnL)/nav, 1/years) - 1;
    const annRet = mean * 252;
    const sharpe  = vol>0 ? ((annRet - rf)/vol) : 0;
    const sortino = downside>0 ? ((annRet - rf)/downside) : 0;
    const MAR     = maxDD>0 ? (cagr / (maxDD/nav)) : 0;

    // VaR / ES（歷史模擬：金額）
    const q = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const i=Math.max(0,Math.min(a.length-1, Math.floor((1-p)*a.length))); return a[i]||0; };
    const ES = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const cut=Math.floor((1-p)*a.length); const sl=a.slice(0,cut); return sl.length? -(sum(sl)/sl.length)*nav : 0; };
    const var95 = Math.abs(q(dailyRet,0.05))*nav, var99 = Math.abs(q(dailyRet,0.01))*nav;
    const es95  = Math.abs(ES(dailyRet,0.95)), es99 = Math.abs(ES(dailyRet,0.99));

    // 交易層（全部採 gainSlip）
    const wins = trades.filter(t=>t.gainSlip>0), losses = trades.filter(t=>t.gainSlip<0);
    const winPnL = sum(wins.map(t=>t.gainSlip));
    const losePnL= sum(losses.map(t=>t.gainSlip));
    const PF = Math.abs(losePnL)>0 ? (winPnL/Math.abs(losePnL)) : 0;
    const avgWin = wins.length ? winPnL / wins.length : 0;
    const avgLoss= losses.length? Math.abs(losePnL / losses.length) : 0;
    const payoff = avgLoss>0 ? (avgWin/avgLoss) : 0;
    const winRate = trades.length ? (wins.length/trades.length) : 0;
    const expectancy = trades.length ? (totalPnL/trades.length) : 0;

    // 連勝/連敗
    let maxWS=0,maxLS=0, curW=0,curL=0;
    for (const t of trades){
      if (t.gainSlip>0){ curW++; maxWS=Math.max(maxWS,curW); curL=0; }
      else if (t.gainSlip<0){ curL++; maxLS=Math.max(maxLS,curL); curW=0; }
      else { curW=0; curL=0; }
    }

    // 單日/單筆最大虧損（含滑價）
    const byDaySlip = (()=>{ const m=new Map(); for(const t of trades){ const d=ymd(new Date(t.tsOut)); m.set(d,(m.get(d)||0)+t.gainSlip); } return [...m.values()]; })();
    const maxDailyLoss  = Math.abs(Math.min(0, ...byDaySlip));
    const maxDailyGain  = Math.max(0, ...byDaySlip, 0);
    const maxTradeLoss  = Math.abs(Math.min(0, ...trades.map(t=>t.gainSlip)));
    const maxTradeGain  = Math.max(0, ...trades.map(t=>t.gainSlip), 0);

    // 平均持倉時間 / 交易頻率（若 tsIn/tsOut 存在）
    const holdMinsArr = trades.map(t => tsDiffMin(t.pos.tsIn, t.tsOut)).filter(x=>Number.isFinite(x));
    const avgHoldingMins = holdMinsArr.length ? avg(holdMinsArr) : 0;
    const months = Math.max(1, monthsBetween(startDate, endDate));
    const tradesPerMonth = trades.length / months;

    // 滾動 Sharpe（6M = 約 126 交易日）— 取中位數
    const rollSharpe = rollingSharpe(dailyRet, 126, rf/252);
    const rollSharpeMed = rollSharpe.length ? median(rollSharpe) : 0;

    return {
      // 報酬
      totalPnL, cagr, annRet, winRate, expectancy,
      // 風險
      maxDD, maxTUW:Math.round(maxTUW), recovery:Math.round(rec),
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

  // ====== 以「六大類」輸出：中文｜數值｜說明 ======
  function renderRiskReturn6Cats(k){
    const money = n => (Number(n)||0).toLocaleString('zh-TW');
    const pmoney = n => (Number(n)>0? '' : '-') + money(Math.abs(Number(n)||0));
    const pct2 = x => (Number.isFinite(x)? (x*100).toFixed(2) : '0.00') + '%';
    const fix2 = x => Number(x).toFixed(2);

    const lines = [];

    // 1. 報酬（Return）
    lines.push('一、報酬（Return）');
    lines.push(`總報酬（Total Return）｜${money(k.totalPnL)}｜回測累積淨損益（含手續費/稅/滑價）。`);
    lines.push(`CAGR（年化複利）｜${pct2(k.cagr)}｜以 NAV 為分母，按實際天數年化。`);
    lines.push(`平均每筆（Expectancy）｜${money(k.expectancy)}｜每筆平均淨損益（含滑價）。`);
    lines.push(`年化報酬（Arithmetic）｜${pct2(k.annRet)}｜日均報酬 × 252。`);
    lines.push(`勝率（Hit Ratio）｜${pct2(k.winRate)}｜獲利筆數 ÷ 總筆數。`);
    lines.push('');

    // 2. 風險（Risk）
    lines.push('二、風險（Risk）');
    lines.push(`最大回撤（MaxDD）｜${pmoney(-k.maxDD)}｜峰值到谷值最大跌幅（以金額表示）。`);
    lines.push(`水下時間（TUW）｜${k.maxTUW}｜在水下的最長天數。`);
    lines.push(`回本時間（Recovery）｜${k.recovery}｜自 MDD 末端至再創新高的天數。`);
    lines.push(`波動率（Volatility）｜${pct2(k.vol)}｜日報酬標準差 × √252。`);
    lines.push(`下行波動（Downside Dev）｜${pct2(k.downside)}｜只計下行波動（供 Sortino）。`);
    lines.push(`VaR 95%｜${pmoney(-k.var95)}｜單日 95% 置信最大虧損（歷史模擬，金額）。`);
    lines.push(`ES 95%（CVaR）｜${pmoney(-k.es95)}｜落於 VaR95 之後的平均虧損。`);
    lines.push(`VaR 99%｜${pmoney(-k.var99)}｜單日 99% 置信最大虧損。`);
    lines.push(`ES 99%｜${pmoney(-k.es99)}｜落於 VaR99 之後的平均虧損。`);
    lines.push(`單日最大虧損｜${pmoney(-k.maxDailyLoss)}｜樣本期間最糟的一天。`);
    lines.push(`單日最大獲利｜${money(k.maxDailyGain)}｜樣本期間最佳的一天。`);
    lines.push(`單筆最大虧損｜${pmoney(-k.maxTradeLoss)}｜樣本期間最糟的一筆交易。`);
    lines.push(`單筆最大獲利｜${money(k.maxTradeGain)}｜樣本期間最佳的一筆交易。`);
    lines.push('');

    // 3. 風險調整報酬（Risk-Adjusted Return）
    lines.push('三、風險調整報酬（Risk-Adjusted Return）');
    lines.push(`Sharpe（夏普）｜${fix2(k.sharpe)}｜（年化報酬 − rf）／年化波動。`);
    lines.push(`Sortino（索提諾）｜${fix2(k.sortino)}｜只懲罰下行波動的夏普。`);
    lines.push(`MAR｜${fix2(k.MAR)}｜CAGR ÷ |MDD|（CTA 常用）。`);
    lines.push(`PF（獲利因子）｜${fix2(k.PF)}｜總獲利 ÷ 總虧損（含成本/滑價）。`);
    lines.push('');

    // 4. 交易結構與執行品質（Trade-Level & Execution）
    lines.push('四、交易結構與執行品質（Trade-Level & Execution）');
    lines.push(`盈虧比（Payoff）｜${fix2(k.payoff)}｜平均獲利 ÷ 平均虧損。`);
    lines.push(`平均獲利單｜${money(k.avgWin)}｜獲利筆的平均金額（含滑價）。`);
    lines.push(`平均虧損單｜${pmoney(-k.avgLoss)}｜虧損筆的平均金額（含滑價）。`);
    lines.push(`最大連勝（Max Winning Streak）｜${k.maxWS}｜連續獲利筆數。`);
    lines.push(`最大連敗（Max Losing Streak）｜${k.maxLS}｜連續虧損筆數。`);
    lines.push(`平均持倉時間｜${fix2(k.avgHoldingMins)} 分｜(tsIn→tsOut) 的平均分鐘數。`);
    lines.push(`交易頻率｜${fix2(k.tradesPerMonth)} 筆/月｜以回測期間月份數估算。`);
    lines.push('');

    // 5. 穩健性與可複製性（Robustness & Statistical Soundness）
    lines.push('五、穩健性與可複製性（Robustness & Statistical Soundness）');
    lines.push(`滾動 Sharpe（6 個月中位）｜${fix2(k.rollSharpeMed)}｜126 交易日窗的 Sharpe 中位數。`);
    lines.push(`樣本外（OOS）｜—｜需要 OOS/多階段資料後計算。`);
    lines.push(`參數敏感度｜—｜需做 ±10~20% 擾動測試後呈現。`);
    lines.push(`Regime 分析｜—｜需標註趨勢/震盪、高/低波動區間後呈現。`);
    lines.push('');

    // 6. 風險用量、槓桿與容量（Risk Usage, Leverage & Capacity）
    lines.push('六、風險用量、槓桿與容量（Risk Usage, Leverage & Capacity）');
    lines.push(`槓桿（Leverage）｜—｜需帳戶名目曝險/權益資料。`);
    lines.push(`風險貢獻（Risk Contribution）｜—｜需多資產/多子策略分解資料。`);
    lines.push(`容量/流動性（Capacity）｜—｜需市場成交量與下單參與率估計。`);

    $('#rrLines').textContent = lines.join('\n');
  }

  // ====== 主流程 ======
  async function handleRaw(raw){
    const {parseTXT, buildReport, paramsLabel} = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);
    if (report.trades.length===0){ alert('沒有成功配對的交易'); return; }

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
    $('#paramChip').textContent = paramsLabel(parsed.params);
    $('#kpiAll').textContent = lineAll;
    $('#kpiL').textContent   = lineL;
    $('#kpiS').textContent   = lineS;

    // 以「含滑價 gainSlip 的出場日」聚合成日損益
    const dailyMap = new Map();
    for (const t of report.trades){
      const d = ymd(new Date(t.tsOut));
      dailyMap.set(d, (dailyMap.get(d)||0) + t.gainSlip);
    }
    const dailySlip = [...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
                      .map(([date,pnl])=>({date,pnl}));

    // 六大類 KPI
    const k = computeRiskReturnKPI(dailySlip, report.trades, DEFAULT_NAV, DEFAULT_RF);
    renderRiskReturn6Cats(k);

    // 明細
    renderTable(report);
  }

  // 事件
  document.getElementById('btn-clip').addEventListener('click', async ()=>{
    const txt = await navigator.clipboard.readText();
    handleRaw(txt);
  });
  document.getElementById('file').addEventListener('change', async e=>{
    const f = e.target.files[0]; if(!f) return;
    try{ const txt = await window.SHARED.readAsTextAuto(f); await handleRaw(txt); }
    catch(err){ alert(err.message || '讀檔失敗'); }
  });

  // ====== 小工具 ======
  function sum(a){ return a.reduce((x,y)=>x+y,0); }
  function avg(a){ return a.length ? sum(a)/a.length : 0; }
  function stdev(a){ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
  function median(a){ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2? b[m] : (b[m-1]+b[m])/2; }
  function ymd(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }
  function monthsBetween(start, end){ if(!start||!end) return 1;
    const s=new Date(start), e=new Date(end); return Math.max(1,(e.getFullYear()-s.getFullYear())*12 + (e.getMonth()-s.getMonth()) + 1); }
  function tsDiffMin(tsIn, tsOut){ // ts: yyyymmddHHMMSS
    if(!tsIn || !tsOut) return NaN;
    const d1 = new Date(tsIn.slice(0,4), tsIn.slice(4,6)-1, tsIn.slice(6,8), tsIn.slice(8,10), tsIn.slice(10,12), tsIn.slice(12,14)||0);
    const d2 = new Date(tsOut.slice(0,4), tsOut.slice(4,6)-1, tsOut.slice(6,8), tsOut.slice(8,10), tsOut.slice(10,12), tsOut.slice(12,14)||0);
    return Math.max(0, (d2-d1)/60000);
  }
  function rollingSharpe(ret, win=126, rfDaily=0){
    const out=[];
    for(let i=win;i<=ret.length;i++){
      const seg=ret.slice(i-win,i);
      const m=avg(seg)-rfDaily, v=stdev(seg);
      out.push(v>0 ? (m/v)*Math.sqrt(252) : 0);
    }
    return out;
  }
})();
