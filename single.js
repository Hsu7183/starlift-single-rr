/* 單檔頁面（6 線圖 + 單行KPI + RR 一行一列：中文｜數值｜說明） */
(function(){
  const $ = s=>document.querySelector(s);

  // 可用網址參數帶入 ?nav=1000000&rf=0.01
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get('nav')) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get('rf'))  || 0.00; // 年化

  const cvs = $('#chart');
  let chart;

  // -------- 6 線圖 --------
  function drawChart(ser){
    if(chart) chart.destroy();
    const {tsArr, total, slipTotal, long, longSlip, short, shortSlip} = ser;
    const labels = tsArr.map((_,i)=>i);
    const mkSolid=(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0});
    const mkDash =(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0,borderDash:[6,4]});
    chart = new Chart(cvs,{
      type:'line',
      data:{labels, datasets:[
        mkSolid(slipTotal,'#111111',3.5),
        mkDash(total,'#9e9e9e',2),
        mkSolid(longSlip,'#d32f2f',3), mkDash(long,'#ef9a9a',2),
        mkSolid(shortSlip,'#2e7d32',3), mkDash(short,'#a5d6a7',2),
      ]},
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{display:false}},
        scales:{x:{grid:{display:false},ticks:{display:false}}, y:{ticks:{callback:v=>v.toLocaleString('zh-TW')}}}
      }
    });
  }

  // -------- 單行 KPI（保留你的原樣） --------
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

  // -------- 交易明細表 --------
  function renderTable(report){
    const {fmtTs, fmtMoney, MULT, FEE, TAX} = window.SHARED;
    const tb = document.querySelector('#tradeTable tbody');
    tb.innerHTML = '';
    let cum=0, cumSlip=0;
    report.trades.forEach((t,i)=>{
      cum += t.gain;        // 不含滑價的「帳面累積」
      cumSlip += t.gainSlip; // 含滑價的「真實累積」
      const tr1 = document.createElement('tr');
      tr1.innerHTML = `
        <td rowspan="2">${i+1}</td>
        <td>${fmtTs(t.pos.tsIn)}</td><td>${t.pos.pIn}</td><td>${t.pos.side==='L'?'新買':'新賣'}</td>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      `;
      const tr2 = document.createElement('tr');
      tr2.innerHTML = `
        <td>${fmtTs(t.tsOut)}</td><td>${t.priceOut}</td><td>${t.pos.side==='L'?'平賣':'平買'}</td>
        <td>${t.pts}</td><td>${FEE*2}</td><td>${Math.round(t.priceOut*MULT*TAX)}</td>
        <td>${fmtMoney(t.gain)}</td><td>${fmtMoney(cum)}</td>
        <td>${fmtMoney(t.gainSlip)}</td><td>${fmtMoney(cumSlip)}</td>
      `;
      tb.appendChild(tr1); tb.appendChild(tr2);
    });
  }

  // -------- Risk-Return（全部用含滑價 gainSlip）--------
  function computeRiskReturnKPI(dailySlip, trades, nav = DEFAULT_NAV, rf = DEFAULT_RF){
    // 權益曲線 + MDD/TUW（以含滑價的日損益計）
    let cum = 0;
    const eq = dailySlip.map(d => ({ date:d.date, nav: (cum += d.pnl, nav + cum) }));
    let peak = -Infinity, maxDD = 0, ddStart=null, ddEnd=null, curPeak=null, curTUW=0, maxTUW=0;
    for(const p of eq){
      if(p.nav > peak){ peak = p.nav; curPeak = p.date; curTUW=0; }
      else{ const dd = peak - p.nav; if(dd>maxDD){ maxDD=dd; ddStart=curPeak; ddEnd=p.date; } curTUW++; if(curTUW>maxTUW) maxTUW=curTUW; }
    }

    // 日報酬（以 NAV 作分母）
    const dailyRet = dailySlip.map(d => d.pnl / nav);
    const mean = avg(dailyRet);
    const vol  = stdev(dailyRet) * Math.sqrt(252);
    const downside = stdev(dailyRet.filter(x => x < (rf/252))) * Math.sqrt(252);

    // 年數用實際日期間距
    const start = dailySlip.length ? new Date(dailySlip[0].date) : null;
    const end   = dailySlip.length ? new Date(dailySlip[dailySlip.length-1].date) : null;
    const days  = (start && end) ? Math.max(1, Math.round((end - start)/86400000) + 1) : 252;
    const years = Math.max(days/365, 1/365);

    const totalPnL = dailySlip.reduce((a,b)=>a+b.pnl,0);
    const cagr = Math.pow((nav + totalPnL)/nav, 1/years) - 1;
    const annRet = mean * 252;
    const sharpe  = vol>0 ? ((annRet - rf)/vol) : 0;
    const sortino = downside>0 ? ((annRet - rf)/downside) : 0;
    const MAR     = maxDD>0 ? (cagr / (maxDD/nav)) : 0;

    // VaR / ES（歷史法，金額）
    const q = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const i=Math.max(0,Math.min(a.length-1, Math.floor((1-p)*a.length))); return a[i]; };
    const ES = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const cut=Math.floor((1-p)*a.length); const sl=a.slice(0,cut); return sl.length? -(sl.reduce((x,y)=>x+y,0)/sl.length)*nav : 0; };
    const var95 = Math.abs(q(dailyRet,0.05))*nav;
    const var99 = Math.abs(q(dailyRet,0.01))*nav;
    const es95  = Math.abs(ES(dailyRet,0.95));
    const es99  = Math.abs(ES(dailyRet,0.99));

    // 交易層（全部採用 gainSlip）
    const wins = trades.filter(t=>t.gainSlip>0);
    const losses = trades.filter(t=>t.gainSlip<0);
    const winPnL = sum(wins.map(t=>t.gainSlip));
    const losePnL= sum(losses.map(t=>t.gainSlip));
    const PF = Math.abs(losePnL)>0 ? (winPnL/Math.abs(losePnL)) : 0;

    const avgWin = wins.length ? winPnL / wins.length : 0;
    const avgLoss= losses.length? Math.abs(losePnL / losses.length) : 0;
    const payoff = avgLoss>0 ? (avgWin/avgLoss) : 0;
    const winRate = trades.length ? (wins.length/trades.length) : 0;
    const expectancy = trades.length ? (totalPnL/trades.length) : 0;

    // 風險邊界（以含滑價計）
    const byDaySlip = (()=>{ const m=new Map(); for(const t of trades){ const d=ymd(new Date(t.tsOut)); m.set(d,(m.get(d)||0)+t.gainSlip); } return [...m.values()]; })();
    const maxDailyLoss  = Math.abs(Math.min(0, ...byDaySlip));
    const maxSingleLoss = Math.abs(Math.min(0, ...trades.map(t=>t.gainSlip)));

    return { totalPnL, cagr, annRet, winRate, expectancy,
             sharpe, sortino, MAR, PF, payoff,
             maxDD: Math.abs(maxDD), maxTUW, var95, es95, var99, es99,
             maxDailyLoss, maxSingleLoss };
  }

  // -------- 輸出：中文｜數值｜說明（以「｜」分隔） --------
  function renderRiskReturnLines(k){
    const money = n => (Number(n)||0).toLocaleString('zh-TW');
    const pmoney = n => (Number(n)>0? '' : '-') + money(Math.abs(Number(n)||0)); // 帶負號
    const pct2 = x => (Number.isFinite(x)? (x*100).toFixed(2) : '0.00') + '%';

    const lines = [
      `總報酬（Total Return）｜${money(k.totalPnL)}｜回測期間累積淨損益（含手續費／期交稅／滑價）。`,
      `CAGR（年化複利）｜${pct2(k.cagr)}｜以 NAV 為分母，按實際天數年化。`,
      `年化報酬（Arithmetic）｜${pct2(k.annRet)}｜日報酬均值 × 252。`,
      `勝率（Hit Ratio）｜${pct2(k.winRate)}｜獲利筆數 ÷ 總筆數。`,
      `平均每筆（Expectancy）｜${money(k.expectancy)}｜每筆平均淨損益（含滑價）。`,
      `夏普（Sharpe）｜${k.sharpe.toFixed(2)}｜（年化報酬 − rf）／年化波動。`,
      `索提諾（Sortino）｜${k.sortino.toFixed(2)}｜只懲罰下行波動的夏普。`,
      `MAR（CAGR/|MDD|）｜${k.MAR.toFixed(2)}｜CTA 常用之風險調整指標。`,
      `獲利因子（PF, Profit Factor）｜${k.PF.toFixed(2)}｜總獲利 ÷ 總虧損（含成本／滑價）。`,
      `盈虧比（Payoff）｜${k.payoff.toFixed(2)}｜平均獲利 ÷ 平均虧損。`,
      `最大回撤（MDD，金額）｜-${money(k.maxDD)}｜權益峰值到谷值的最大跌幅（金額）。`,
      `水下時間（TUW, Time Under Water）｜${k.maxTUW}｜創新高前處於回撤的天數。`,
      `VaR 95%（風險值）｜-${money(k.var95)}｜單日 95% 置信最大虧損（歷史模擬，金額）。`,
      `ES 95%（期望短缺, CVaR）｜-${money(k.es95)}｜落於 VaR95 之後的平均虧損（更嚴格）。`,
      `VaR 99%（風險值）｜-${money(k.var99)}｜單日 99% 置信最大虧損（歷史模擬，金額）。`,
      `ES 99%（期望短缺, CVaR）｜-${money(k.es99)}｜落於 VaR99 之後的平均虧損。`,
      `單日最大虧損｜-${money(k.maxDailyLoss)}｜樣本期間最糟的一天。`,
      `單筆最大虧損｜-${money(k.maxSingleLoss)}｜樣本期間最糟的一筆交易。`,
    ];

    $('#rrLines').textContent = lines.join('\n');
  }

  // -------- 主流程 --------
  async function handleRaw(raw){
    const {parseTXT, buildReport, paramsLabel} = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);
    if (report.trades.length===0){ alert('沒有成功配對的交易'); return; }

    // (1) 圖表
    drawChart({
      tsArr: report.tsArr,
      total: report.total,
      slipTotal: report.slipCum,
      long: report.longCum,
      longSlip: report.longSlipCum,
      short: report.shortCum,
      shortSlip: report.shortSlipCum,
    });

    // (2) KPI（三行）
    const [lineAll, lineL, lineS] = buildKpiLines(report.statAll, report.statL, report.statS);
    $('#paramChip').textContent = paramsLabel(parsed.params);
    $('#kpiAll').textContent = lineAll;
    $('#kpiL').textContent   = lineL;
    $('#kpiS').textContent   = lineS;

    // (3) 以「含滑價 gainSlip 的出場日」聚合成日損益
    const dailyMap = new Map();
    for (const t of report.trades){
      const d = ymd(new Date(t.tsOut));
      dailyMap.set(d, (dailyMap.get(d)||0) + t.gainSlip); // ← 含滑價
    }
    const dailySlip = [...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
                      .map(([date,pnl])=>({date,pnl}));

    // (4) 計算 RR（全用滑價後）並輸出中文一行一列
    const k = computeRiskReturnKPI(dailySlip, report.trades, DEFAULT_NAV, DEFAULT_RF);
    renderRiskReturnLines(k);

    // (5) 交易明細
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

  // 小工具
  function sum(a){return a.reduce((x,y)=>x+y,0)}
  function avg(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
  function stdev(a){ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
  function ymd(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }
})();
