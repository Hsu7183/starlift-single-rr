/* 單檔頁面（6 線圖 + 單行KPI + 直式 Risk-Return 數值＋說明） */
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

  // -------- 交易明細 --------
  function renderTable(report){
    const {fmtTs, fmtMoney, MULT, FEE, TAX} = window.SHARED;
    const tb = document.querySelector('#tradeTable tbody');
    tb.innerHTML = '';
    let cum=0, cumSlip=0;
    report.trades.forEach((t,i)=>{
      cum += t.gain; cumSlip += t.gainSlip;
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

  // -------- 計算 Risk-Return（以日損益 / NAV）--------
  function computeRiskReturnKPI(daily, trades, nav = DEFAULT_NAV, rf = DEFAULT_RF){
    // 權益曲線 + MDD/TUW
    let cum = 0;
    const eq = daily.map(d => ({ date:d.date, nav: (cum += d.pnl, nav + cum) }));
    let peak = -Infinity, maxDD = 0, ddStart=null, ddEnd=null, curPeak=null, curTUW=0, maxTUW=0;
    for(const p of eq){
      if(p.nav > peak){ peak = p.nav; curPeak = p.date; curTUW=0; }
      else{ const dd = peak - p.nav; if(dd>maxDD){ maxDD=dd; ddStart=curPeak; ddEnd=p.date; } curTUW++; if(curTUW>maxTUW) maxTUW=curTUW; }
    }

    // 日報酬
    const dailyRet = daily.map(d => d.pnl / nav);
    const mean = avg(dailyRet);
    const vol  = stdev(dailyRet) * Math.sqrt(252);
    const downside = stdev(dailyRet.filter(x => x < (rf/252))) * Math.sqrt(252);

    // 年數取實際日期間距，避免 NaN 或爆衝
    const start = daily.length ? new Date(daily[0].date) : null;
    const end   = daily.length ? new Date(daily[daily.length-1].date) : null;
    const days  = (start && end) ? Math.max(1, Math.round((end - start)/86400000) + 1) : 252;
    const years = Math.max( days/365, 1/365 );

    const totalPnL = daily.reduce((a,b)=>a+b.pnl,0);
    const cagr = Math.pow((nav + totalPnL)/nav, 1/years) - 1;
    const annRet = mean * 252;
    const sharpe  = vol>0 ? ((annRet - rf)/vol) : 0;
    const sortino = downside>0 ? ((annRet - rf)/downside) : 0;
    const MAR     = maxDD>0 ? (cagr / (maxDD/nav)) : 0;

    // VaR / ES（歷史法，金額顯示為正數）
    const q = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const i=Math.max(0,Math.min(a.length-1, Math.floor((1-p)*a.length))); return a[i]; };
    const ES = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const cut=Math.floor((1-p)*a.length); const sl=a.slice(0,cut); return sl.length? -(sl.reduce((x,y)=>x+y,0)/sl.length)*nav : 0; };
    const var95 = Math.abs(q(dailyRet,0.05))*nav;
    const var99 = Math.abs(q(dailyRet,0.01))*nav;
    const es95  = Math.abs(ES(dailyRet,0.95));
    const es99  = Math.abs(ES(dailyRet,0.99));

    // 交易層
    const winTrades = trades.filter(t=>t.gain>0), loseTrades = trades.filter(t=>t.gain<0);
    const winPnL = sum(winTrades.map(t=>t.gain));
    const losePnL= sum(loseTrades.map(t=>t.gain));
    const PF = Math.abs(losePnL)>0 ? (winPnL/Math.abs(losePnL)) : 0;

    const avgWin = winTrades.length ? winPnL / winTrades.length : 0;
    const avgLoss= loseTrades.length? Math.abs(losePnL / loseTrades.length) : 0;
    const payoff = avgLoss>0 ? (avgWin/avgLoss) : 0;
    const winRate = trades.length ? (winTrades.length/trades.length) : 0;
    const expectancy = trades.length ? (totalPnL/trades.length) : 0;

    const maxDailyLoss  = Math.abs(Math.min(0, ...byDay(trades, t=>t.gain)));
    const maxSingleLoss = Math.abs(Math.min(0, ...trades.map(t=>t.gain)));

    return {
      totalPnL, cagr, annRet, winRate, expectancy,
      sharpe, sortino, MAR, PF, payoff,
      maxDD: Math.abs(maxDD), maxTUW,
      var95, es95, var99, es99,
      maxDailyLoss, maxSingleLoss
    };

    function byDay(list, pick){ const m=new Map(); for(const t of list){ const d=ymd(new Date(t.tsOut)); m.set(d,(m.get(d)||0)+pick(t)); } return [...m.values()]; }
  }

  // -------- 把數值填進每一行 --------
  function renderRiskReturn(k){
    const {fmtMoney} = window.SHARED;
    const set = (id, val)=>{ const el = document.getElementById(id); if(el) el.textContent = val; };
    const pct2 = x => (x*100).toFixed(2)+'%';
    const fix2 = x => Number(x).toFixed(2);

    set('rrTotal',   fmtMoney(k.totalPnL));
    set('rrCAGR',    pct2(k.cagr));
    set('rrAnnRet',  pct2(k.annRet));
    set('rrWin',     pct2(k.winRate));
    set('rrExp',     fmtMoney(k.expectancy));
    set('rrSharpe',  fix2(k.sharpe));
    set('rrSortino', fix2(k.sortino));
    set('rrMAR',     fix2(k.MAR));
    set('rrPF',      fix2(k.PF));
    set('rrPayoff',  fix2(k.payoff));

    set('rrMDD',         '-' + fmtMoney(k.maxDD));
    set('rrTUW',         String(k.maxTUW));
    set('rrVaR95',       '-' + fmtMoney(k.var95));
    set('rrES95',        '-' + fmtMoney(k.es95));
    set('rrVaR99',       '-' + fmtMoney(k.var99));
    set('rrES99',        '-' + fmtMoney(k.es99));
    set('rrMaxDayLoss',  '-' + fmtMoney(k.maxDailyLoss));
    set('rrMaxTradeLoss','-' + fmtMoney(k.maxSingleLoss));
  }

  // -------- 主流程 --------
  async function handleRaw(raw){
    const {parseTXT, buildReport, paramsLabel} = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);
    if (report.trades.length===0){
      alert('沒有成功配對的交易'); return;
    }

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

    // (3) 以出場日聚合 → RR 指標 → 渲染
    const dailyMap = new Map();
    for (const t of report.trades){
      const key = ymd(new Date(t.tsOut));
      dailyMap.set(key, (dailyMap.get(key)||0) + t.gain); // 含滑價
    }
    const daily = [...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
                    .map(([date,pnl])=>({date,pnl}));

    const k = computeRiskReturnKPI(daily, report.trades, DEFAULT_NAV, DEFAULT_RF);
    renderRiskReturn(k);

    // (4) 交易明細
    renderTable(report);
  }

  // 事件
  document.getElementById('btn-clip').addEventListener('click', async ()=>{
    const txt = await navigator.clipboard.readText();
    handleRaw(txt);
  });
  document.getElementById('file').addEventListener('change', async e=>{
    const f = e.target.files[0]; if(!f) return;
    try{
      const txt = await window.SHARED.readAsTextAuto(f);
      await handleRaw(txt);
    }catch(err){ alert(err.message || '讀檔失敗'); }
  });

  // 小工具
  function sum(a){return a.reduce((x,y)=>x+y,0)}
  function avg(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
  function stdev(a){ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
  function ymd(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }
})();
