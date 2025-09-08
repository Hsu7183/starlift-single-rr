/* 單檔頁面（6 線版 + 單行KPI對齊 + Risk-Return 面板） */
(function(){
  const $ = s=>document.querySelector(s);

  // ====== 可調參數（也可改用 ?nav=1200000&rf=0.01 帶入） ======
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get('nav')) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get('rf'))  || 0.00; // 年化

  const cvs = $('#chart');
  let chart;

  // ---------- 圖表（6線） ----------
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

  // ---------- KPI 三行（單行對齊） ----------
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

  // ---------- 交易明細表 ----------
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

  // ---------- Risk-Return：計算 ----------
  function computeRiskReturnKPI(daily, trades, nav = DEFAULT_NAV, rf = DEFAULT_RF){
    // 權益曲線（以 NAV 為基礎）
    let cum = 0;
    const eq = daily.map(d => ({ date:d.date, nav: (cum += d.pnl, nav + cum) }));

    // 最大回撤 & 水下時間
    let peak = -Infinity, maxDD = 0, ddStart=null, ddEnd=null, curPeak=null, curTUW=0, maxTUW=0;
    for(const p of eq){
      if(p.nav > peak){ peak = p.nav; curPeak = p.date; curTUW=0; }
      else{ const dd = peak - p.nav; if(dd>maxDD){ maxDD=dd; ddStart=curPeak; ddEnd=p.date; } curTUW++; if(curTUW>maxTUW) maxTUW=curTUW; }
    }

    // 日報酬（資本回報）
    const dailyRet = daily.map(d => d.pnl / nav);
    const mean = avg(dailyRet);
    const vol  = stdev(dailyRet) * Math.sqrt(252);
    const downside = stdev(dailyRet.filter(x => x < (rf/252))) * Math.sqrt(252);

    const totalPnL = daily.reduce((a,b)=>a+b.pnl,0);
    const years = daily.length ? Math.max(daily.length/252, 1/365) : 1/365;
    const CAGR = Math.pow((nav+totalPnL)/nav, 1/years) - 1;

    const sharpe  = vol>0 ? ((mean*252 - rf)/vol) : 0;
    const sortino = downside>0 ? ((mean*252 - rf)/downside) : 0;
    const MAR     = maxDD>0 ? (CAGR / (maxDD/nav)) : 0;

    // VaR/ES（歷史模擬法，金額）
    const q = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const i=Math.max(0,Math.min(a.length-1, Math.floor((1-p)*a.length))); return a[i]; };
    const ES = (arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const cut=Math.floor((1-p)*a.length); const sl=a.slice(0,cut); return sl.length? -(sl.reduce((x,y)=>x+y,0)/sl.length)*nav : 0; };
    const VaR95 = -q(dailyRet,0.95)*nav, VaR99 = -q(dailyRet,0.99)*nav;
    const ES95  = ES(dailyRet,0.95),   ES99  = ES(dailyRet,0.99);

    // PF / Payoff（交易層）
    const winPnL = trades.filter(t=>t.gain>0).reduce((a,b)=>a+b.gain,0);
    const losePnL= trades.filter(t=>t.gain<0).reduce((a,b)=>a+b.gain,0);
    const PF = Math.abs(losePnL) > 0 ? (winPnL / Math.abs(losePnL)) : 0;

    const wins = trades.filter(t=>t.gain>0);
    const losses = trades.filter(t=>t.gain<0);
    const avgWin = wins.length ? wins.reduce((a,b)=>a+b.gain,0) / wins.length : 0;
    const avgLoss= losses.length? Math.abs(losses.reduce((a,b)=>a+b.gain,0) / losses.length) : 0;
    const payoff = avgLoss>0 ? (avgWin/avgLoss) : 0;

    return { CAGR, sharpe, sortino, MAR, maxDD, maxTUW, VaR95, ES95, VaR99, ES99, PF, payoff, ddStart, ddEnd };
  }

  // ---------- Risk-Return：渲染 ----------
  function renderRiskReturn(k){
    const {fmtMoney} = window.SHARED;
    const set = (id, val)=>{ const el = document.getElementById(id); if(el) el.textContent = val; };
    const pct = x => (x*100).toFixed(2) + '%';

    set('rrCAGR',   pct(k.CAGR));
    set('rrSharpe', k.sharpe.toFixed(2));
    set('rrSortino',k.sortino.toFixed(2));
    set('rrMAR',    k.MAR.toFixed(2));
    set('rrPF',     k.PF.toFixed(2));
    set('rrPayoff', k.payoff.toFixed(2));
    set('rrMDD',    '-' + fmtMoney(k.maxDD));
    set('rrTUW',    String(k.maxTUW));
    set('rrVaR95',  '-' + fmtMoney(k.VaR95));
    set('rrES95',   '-' + fmtMoney(k.ES95));
    set('rrVaR99',  '-' + fmtMoney(k.VaR99));
    set('rrES99',   '-' + fmtMoney(k.ES99));

    // 若想顯示回撤區間，可在 rrPanel 加 data 屬性，之後用 CSS 呈現：
    // const rrPanel = document.getElementById('rrPanel');
    // if (rrPanel) rrPanel.setAttribute('data-dd-range', `${k.ddStart||'—'} → ${k.ddEnd||'—'}`);
  }

  // ---------- 主流程 ----------
  async function handleRaw(raw){
    const {parseTXT, buildReport, paramsLabel} = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);
    if (report.trades.length===0){
      alert('沒有成功配對的交易'); return;
    }

    // (1) 圖表（6 線）
    drawChart({
      tsArr: report.tsArr,
      total: report.total,
      slipTotal: report.slipCum,
      long: report.longCum,
      longSlip: report.longSlipCum,
      short: report.shortCum,
      shortSlip: report.shortSlipCum,
    });

    // (2) KPI 三行
    const [lineAll, lineL, lineS] = buildKpiLines(report.statAll, report.statL, report.statS);
    $('#paramChip').textContent = paramsLabel(parsed.params);
    $('#kpiAll').textContent = lineAll;
    $('#kpiL').textContent   = lineL;
    $('#kpiS').textContent   = lineS;

    // (3) Risk-Return 面板
    // 以「出場時間」所屬日期彙總為「日損益」
    const dailyMap = new Map();
    for (const t of report.trades){
      const d = new Date(t.tsOut);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      const key = `${yyyy}-${mm}-${dd}`;
      dailyMap.set(key, (dailyMap.get(key)||0) + t.gain); // 用含滑價的 gain；若要不含滑價可改 t.gain - t.gainSlip
    }
    const daily = [...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
                    .map(([date,pnl])=>({date,pnl}));

    const k = computeRiskReturnKPI(daily, report.trades, DEFAULT_NAV, DEFAULT_RF);
    renderRiskReturn(k);

    // (4) 交易明細
    renderTable(report);
  }

  // 事件：貼上剪貼簿
  document.getElementById('btn-clip').addEventListener('click', async ()=>{
    const txt = await navigator.clipboard.readText();
    handleRaw(txt);
  });

  // 事件：載入檔案
  document.getElementById('file').addEventListener('change', async e=>{
    const f = e.target.files[0]; if(!f) return;
    try{
      const txt = await window.SHARED.readAsTextAuto(f);
      await handleRaw(txt);
    }catch(err){
      alert(err.message || '讀檔失敗');
    }
  });

  // ---- 小工具 ----
  function avg(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
  function stdev(a){ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
})();
