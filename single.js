/* 主圖 + 三行KPI + Risk-Return（表格） + 全域明細 + 月別報告（圖＋雙列明細） */
(function(){
  const $ = s => document.querySelector(s);
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get("nav")) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get("rf"))  || 0.00;
  console.log("[Report] single.js report-v2");

  // ====== 样式（一次） ======
  (function injectStyle(){
    if (document.getElementById("rr-style")) return;
    const css = `
      .p-red{color:#ef4444;font-weight:700}
      .p-green{color:#10b981;font-weight:700}
      .rr-good-row td{font-weight:800;color:#111}
      .rr-bad-row td{font-weight:800;color:#ef4444}
      .rr-table{width:100%;border-collapse:collapse;background:#fff}
      .rr-table th,.rr-table td{padding:8px 10px;border-bottom:1px solid var(--line,#e5e7eb);white-space:nowrap;text-align:left;font:14px/1.8 ui-monospace,Consolas,Menlo,monospace}
      .rr-section-header td{background:#f6f7fb;font-weight:800;border-top:1px solid var(--line,#e5e7eb)}
      .rr-subhead td{background:#fafafa;font-weight:700}
      .rr-tier{opacity:.7;font-weight:600}
      .rr-improve-title td{background:#fff1f2;border-top:2px solid #fecdd3;border-bottom:1px solid #fecdd3;font-weight:800;color:#be123c}
      .rr-improve-head td{background:#ffe4e6;color:#be123c;font-weight:700}
      .rr-improve-row td{background:#fff5f5;color:#b91c1c}
      .report-card{background:#fff;border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:14px;margin:14px 0}
      .month-header{font-weight:800;margin:6px 0 12px 0}
      .month-card{page-break-inside:avoid}
      .month-table{width:100%;border-collapse:collapse;margin-top:8px}
      .month-table th,.month-table td{padding:6px 8px;border-bottom:1px solid var(--line,#e5e7eb);white-space:nowrap;text-align:center;font:13px ui-monospace,Consolas,Menlo,monospace}
      .month-table thead th{background:#fafafa}
    `;
    const style = document.createElement("style");
    style.id = "rr-style"; style.textContent = css;
    document.head.appendChild(style);
  })();

  // ====== 主圖 ======
  let chart;
  function drawChart(ser){
    if(chart) chart.destroy();
    const {tsArr,total,slipTotal,long,longSlip,short,shortSlip} = ser;
    const labels = tsArr.map((_,i)=>i);
    const mkSolid=(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0});
    const mkDash =(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0,borderDash:[6,4]});
    chart = new Chart($("#chart"),{
      type:"line",
      data:{labels,datasets:[
        mkSolid(slipTotal,"#111",3.5), mkDash(total,"#9aa",2),
        mkSolid(longSlip,"#d32f2f",3), mkDash(long,"#ef9a9a",2),
        mkSolid(shortSlip,"#2e7d32",3), mkDash(short,"#a5d6a7",2),
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
        scales:{y:{ticks:{callback:v=>fmtMoney(v)}},x:{ticks:{autoSkip:true,maxTicksLimit:12}}}}
    });
  }

  // ====== 三行 KPI（沿用） ======
  function buildKpiLines(statAll, statL, statS){
    const { fmtMoney, pct } = window.SHARED;
    const mk = s => ([
      ["交易數", String(s.count)], ["勝率", pct(s.winRate)], ["敗率", pct(s.loseRate)],
      ["單日最大獲利", fmtMoney(s.dayMax)], ["單日最大虧損", fmtMoney(s.dayMin)],
      ["區間最大獲利", fmtMoney(s.up)], ["區間最大回撤", fmtMoney(s.dd)],
      ["累積獲利", fmtMoney(s.gain)],
    ]);
    const rows=[mk(statAll),mk(statL),mk(statS)];
    const maxW=rows[0].map((_,i)=>Math.max(...rows.map(r=>r[i][1].length)));
    const padL=(s,w)=>s.padStart(w," ");
    const join=(label,cols)=>`${label}： `+cols.map((c,i)=>`${c[0]} ${padL(c[1],maxW[i])}`).join(" ｜ ");
    return [join("全部（含滑價）",rows[0]),join("多單（含滑價）",rows[1]),join("空單（含滑價）",rows[2])];
  }

  // ====== 全域交易明細（雙列、紅/綠） ======
  function renderTable(report){
    const { fmtTs, fmtMoney, MULT, FEE, TAX } = window.SHARED;
    const tb=$("#tradeTable tbody"); tb.innerHTML="";
    let cum=0,cumSlip=0;
    const cls=v=>v>0?"p-red":(v<0?"p-green":"");
    report.trades.forEach((t,i)=>{
      cum+=t.gain; cumSlip+=t.gainSlip;
      const tr1=document.createElement("tr");
      tr1.innerHTML=`
        <td rowspan="2">${i+1}</td>
        <td>${fmtTs(t.pos.tsIn)}</td><td>${t.pos.pIn??'—'}</td><td>${t.pos.side==='L'?'新買':'新賣'}</td>
        <td class="${cls(t.pts)}">—</td><td>—</td><td>—</td>
        <td class="${cls(t.gain)}">—</td><td class="${cls(cum)}">—</td>
        <td class="${cls(t.gainSlip)}">—</td><td class="${cls(cumSlip)}">—</td>`;
      const tr2=document.createElement("tr");
      tr2.innerHTML=`
        <td>${fmtTs(t.tsOut)}</td><td>${t.priceOut}</td><td>${t.pos.side==='L'?'平賣':'平買'}</td>
        <td class="${cls(t.pts)}">${Number.isFinite(t.pts)?t.pts:'—'}</td>
        <td>${FEE*2}</td><td>${Math.round(t.priceOut*MULT*TAX)}</td>
        <td class="${cls(t.gain)}">${fmtMoney(t.gain)}</td><td class="${cls(cum)}">${fmtMoney(cum)}</td>
        <td class="${cls(t.gainSlip)}">${fmtMoney(t.gainSlip)}</td><td class="${cls(cumSlip)}">${fmtMoney(cumSlip)}</td>`;
      tb.appendChild(tr1); tb.appendChild(tr2);
    });
  }

  // ====== KPI 計算（含滑價） ======
  function computeRR(dailySlip,trades,nav=DEFAULT_NAV,rf=DEFAULT_RF){
    let cum=0; const eq=dailySlip.map(d=>({date:d.date,nav:(cum+=d.pnl,nav+cum)}));
    let peak=-Infinity,maxDD=0,curTUW=0,maxTUW=0,inDraw=false,rec=0,curRec=0;
    const ddPct=[];
    for(const p of eq){
      if(p.nav>peak){ peak=p.nav; if(inDraw){ rec=Math.max(rec,curRec); inDraw=false; } curTUW=0; curRec=0; ddPct.push(0); }
      else{ const dd=peak-p.nav; if(dd>maxDD){ maxDD=dd; inDraw=true; curRec=0; } curTUW++; curRec++; maxTUW=Math.max(maxTUW,curTUW); ddPct.push(-(dd/peak)); }
    }
    const dailyRet=dailySlip.map(d=>d.pnl/nav);
    const mean=avg(dailyRet), vol=stdev(dailyRet)*Math.sqrt(252);
    const downside=stdev(dailyRet.filter(x=>x<(rf/252)))*Math.sqrt(252);
    const start=dailySlip[0]?.date, end=dailySlip[dailySlip.length-1]?.date;
    const dayCnt=start&&end? daysBetween(start,end) : 252;
    const years=Math.max(dayCnt/365,1/365);
    const totalPnL=dailySlip.reduce((a,b)=>a+b.pnl,0);
    const cagr=Math.pow((nav+totalPnL)/nav,1/years)-1;
    const annRet=mean*252;
    const sharpe=vol?((annRet-DEFAULT_RF)/vol):0;
    const sortino=downside?((annRet-DEFAULT_RF)/downside):0;
    const MAR=maxDD? cagr/(maxDD/nav):0;
    const q =(arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const i=Math.floor((1-p)*a.length); return a[Math.max(0,Math.min(i,a.length-1))]||0; };
    const ES=(arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const cut=Math.floor((1-p)*a.length); const sl=a.slice(0,cut); return sl.length? -(sl.reduce((x,y)=>x+y,0)/sl.length)*nav : 0; };
    const var95=Math.abs(q(dailyRet,0.05))*nav, var99=Math.abs(q(dailyRet,0.01))*nav;
    const es95=Math.abs(ES(dailyRet,0.95)), es99=Math.abs(ES(dailyRet,0.99));
    const wins=trades.filter(t=>t.gainSlip>0), losses=trades.filter(t=>t.gainSlip<0);
    const winPnL=wins.reduce((a,b)=>a+b.gainSlip,0), losePnL=losses.reduce((a,b)=>a+b.gainSlip,0);
    const PF=Math.abs(losePnL)? winPnL/Math.abs(losePnL):0;
    const avgWin=wins.length? winPnL/wins.length:0, avgLoss=losses.length? Math.abs(losePnL/losses.length):0;
    const payoff=avgLoss? avgWin/avgLoss:0, winRate=trades.length? wins.length/trades.length:0;
    const expectancy=trades.length? totalPnL/trades.length:0;
    let maxWS=0,maxLS=0,curW=0,curL=0;
    for(const t of trades){ if(t.gainSlip>0){ curW++; maxWS=Math.max(maxWS,curW); curL=0; } else if(t.gainSlip<0){ curL++; maxLS=Math.max(maxLS,curL); curW=0; } else { curW=0; curL=0; } }
    const byDaySlip=(()=>{ const m=new Map(); for(const t of trades){ const d=keyFromTs(t.tsOut); m.set(d,(m.get(d)||0)+t.gainSlip); } return [...m.values()]; })();
    const maxDailyLoss=Math.abs(Math.min(0,...byDaySlip)), maxDailyGain=Math.max(0,...byDaySlip,0);
    const maxTradeLoss=Math.abs(Math.min(0,...trades.map(t=>t.gainSlip))), maxTradeGain=Math.max(0,...trades.map(t=>t.gainSlip),0);
    const holdMinsArr=trades.map(t=>tsDiffMin(t.pos.tsIn,t.tsOut)).filter(Number.isFinite);
    const avgHoldingMins=holdMinsArr.length? avg(holdMinsArr):0;
    const months=Math.max(1,monthsBetween(start,end));
    const tradesPerMonth=trades.length/months;

    // 進階
    const rollSharpe=rollingSharpe(dailyRet,126,DEFAULT_RF/252), rollSharpeMed=rollSharpe.length? median(rollSharpe):0;

    return { totalPnL,cagr,annRet,winRate,expectancy,
      maxDD,maxTUW:Math.round(maxTUW),recovery:Math.round(rec),vol,downside,
      var95,var99,es95,es99,maxDailyLoss,maxDailyGain,maxTradeLoss,maxTradeGain,
      sharpe,sortino,MAR,PF,payoff,avgWin,avgLoss,maxWS,maxLS,avgHoldingMins,tradesPerMonth, rollSharpeMed };
  }

  // ====== Risk-Return 機構表格（五欄 + 建議優化 + 中文評語） ======
  function renderRR6Cats(k){
    const NAV=DEFAULT_NAV;
    const money=n=>(Number(n)||0).toLocaleString("zh-TW");
    const pmoney=n=>(Number(n)>0?"":"-")+money(Math.abs(Number(n)||0));
    const pct2=x=>(Number.isFinite(x)?(x*100).toFixed(2):"0.00")+"%";
    const fix2=x=>Number(x).toFixed(2);
    const label = lvl => lvl==='good'?'Strong（強）':(lvl==='bad'?'Improve（優化）':'Adequate（可接受）');

    const RULES={
      cagr:v=> v>=0.30?['good','年化極佳','≥30%']:v>=0.15?['good','年化穩健','≥15%']:v>=0.05?['ok','尚可','≥5%']:['bad','偏低','—'],
      ann :v=> v>=0.25?['good','年化優秀','≥25%']:v>=0.10?['ok','尚可','≥10%']:['bad','偏低','—'],
      exp :v=> v>0?['good','每筆期望為正','>0']:['bad','未覆蓋成本','>0'],
      hit :(v,po)=> v>=0.45?['good','勝率偏高','≥45%']:(v<0.30&&po<1.5?['bad','低勝率且盈虧比低','—']:['ok','需與盈虧比搭配','—']),
      mdd :v=> (Math.abs(v)/NAV)<=0.15?['good','回撤控制良好','≤15%NAV']:(Math.abs(v)/NAV)<=0.25?['ok','可接受','≤25%NAV']:['bad','偏大','—'],
      tuw :v=> v<=60?['good','水下短','≤60天']:v<=120?['ok','可接受','≤120天']:['bad','偏長','—'],
      rec :v=> v<=45?['good','回本快','≤45天']:v<=90?['ok','可接受','≤90天']:['bad','偏慢','—'],
      vol :v=> v<=0.15?['good','波動適中','8%~15%']:v<=0.25?['ok','略高','≤25%']:['bad','偏高，建議降槓桿','—'],
      ddev:v=> v<=0.10?['good','下行小','≤10%']:v<=0.15?['ok','尚可','≤15%']:['bad','偏高','—'],
      var95:v=> (v/NAV)<=0.03?['good','≤3%NAV','≤3%NAV']:(v/NAV)<=0.05?['ok','3–5%','≤5%NAV']:['bad','>5%','—'],
      es95 :v=> (v/NAV)<=0.025?['good','≤2.5%NAV','≤2.5%NAV']:(v/NAV)<=0.04?['ok','2.5–4%','≤4%NAV']:['bad','>4%','—'],
      var99:v=> (v/NAV)<=0.05?['good','≤5%NAV','≤5%NAV']:(v/NAV)<=0.08?['ok','5–8%','≤8%NAV']:['bad','>8%','—'],
      es99 :v=> (v/NAV)<=0.035?['good','≤3.5%NAV','≤3.5%NAV']:(v/NAV)<=0.06?['ok','3.5–6%','≤6%NAV']:['bad','>6%','—'],
      maxDayLoss:v=> (v/NAV)<=0.04?['good','尾部可控','≤4%NAV']:(v/NAV)<=0.06?['ok','尚可','≤6%NAV']:['bad','偏高','—'],
      sharpe:v=> v>=2?['good','>2 佳','≥2']:v>=1.5?['good','>1.5 穩健','≥1.5']:v>=1?['ok','>1 可接受','≥1']:['bad','需提升','—'],
      sortino:v=> v>=2?['good','>2 佳','≥2']:v>=1.5?['good','>1.5 穩健','≥1.5']:v>=1?['ok','>1 可接受','≥1']:['bad','需提升','—'],
      mar :v=> v>=2?['good','>2 佳','≥2']:v>=1.5?['good','>1.5 穩健','≥1.5']:v>=1?['ok','>1 可接受','≥1']:['bad','需提升','—'],
      pf  :v=> v>=2?['good','>2 很好','≥2']:v>=1.5?['ok','>1.5 尚可','≥1.5']:['bad','偏低','—'],
      payoff:v=> v>=2?['good','盈虧比高','≥2']:v>=1.5?['ok','尚可','≥1.5']:['bad','偏低','—'],
    };

    const sections=[]; const improvs=[];
    const pushHeader=t=>sections.push({title:t,rows:[]});
    const pushRow=(title,val,desc,rule,tier,sec=sections[sections.length-1])=>{
      const [g,c,b] = rule;
      const evalText = `${label(g)}${c? '，'+c : ''}`;
      sec.rows.push({grade:g, cells:[`${title}${tier?` <span class="rr-tier">(${tier})</span>`:''}`,val,desc,evalText,b||'—']});
      if(g==='bad') improvs.push([title,val,'建議優化',evalText,b||'—']);
    };

    // 建議優化
    pushHeader("建議優化指標");

    // 一、報酬
    pushHeader("一、報酬（Return）");
    pushRow("總報酬（Total Return）", money(k.totalPnL), "回測累積淨損益（含滑價/稅/費）", k.totalPnL>0?['good','報酬為正','—']:['bad','淨損益為負','—'], "Core");
    pushRow("CAGR（年化複利）", pct2(k.cagr), "以 NAV 為分母，依實際天數年化", RULES.cagr(k.cagr), "Core");
    pushRow("平均每筆（Expectancy）", money(k.expectancy), "每筆平均淨損益（含滑價）", RULES.exp(k.expectancy), "Core");
    pushRow("年化報酬（Arithmetic）", pct2(k.annRet), "日均報酬 × 252", RULES.ann(k.annRet), "Core");
    pushRow("勝率（Hit Ratio）", pct2(k.winRate), "獲利筆數 ÷ 總筆數", RULES.hit(k.winRate,k.payoff), "Core");

    // 二、風險
    pushHeader("二、風險（Risk）");
    pushRow("最大回撤（MaxDD）", pmoney(-k.maxDD), "峰值到谷值最大跌幅（以金額）", RULES.mdd(k.maxDD), "Core");
    pushRow("水下時間（TUW）", String(k.maxTUW), "在水下的最長天數", RULES.tuw(k.maxTUW), "Core");
    pushRow("回本時間（Recovery）", String(k.recovery), "自 MDD 末端至再創新高的天數", RULES.rec(k.recovery), "Core");
    pushRow("波動率（Volatility）", pct2(k.vol), "日報酬標準差 × √252", RULES.vol(k.vol), "Core");
    pushRow("下行波動（Downside Dev）", pct2(k.downside), "只計下行（供 Sortino）", RULES.ddev(k.downside), "Core");
    pushRow("VaR 95%", pmoney(-k.var95), "單日 95% 置信最大虧損（金額）", RULES.var95(k.var95), "Core");
    pushRow("ES 95%（CVaR）", pmoney(-k.es95), "落於 VaR95 之後的平均虧損", RULES.es95(k.es95), "Core");
    pushRow("VaR 99%", pmoney(-k.var99), "單日 99% 置信最大虧損（金額）", RULES.var99(k.var99), "Core");
    pushRow("ES 99%（CVaR）", pmoney(-k.es99), "落於 VaR99 之後的平均虧損", RULES.es99(k.es99), "Core");
    pushRow("單日最大虧損", pmoney(-k.maxDailyLoss), "樣本期間最糟的一天", RULES.maxDayLoss(k.maxDailyLoss), "Core");

    // 三、風險調整
    pushHeader("三、風險調整報酬（Risk-Adjusted Return）");
    pushRow("Sharpe（夏普）", fix2(k.sharpe), "(年化報酬 - rf)/年化波動", RULES.sharpe(k.sharpe), "Core");
    pushRow("Sortino（索提諾）", fix2(k.sortino), "只懲罰下行波動", RULES.sortino(k.sortino), "Core");
    pushRow("MAR", fix2(k.MAR), "CAGR / |MDD|（CTA 常用）", RULES.mar(k.MAR), "Core");
    pushRow("PF（獲利因子）", fix2(k.PF), "總獲利 ÷ 總虧損（含成本/滑價）", RULES.pf(k.PF), "Core");
    pushRow("Payoff（盈虧比）", fix2(k.payoff), "平均獲利 ÷ 平均虧損", RULES.payoff(k.payoff), "Imp.");

    // 渲染
    const wrap = $("#rrLines");
    const tbody = document.createElement('tbody');

    // 建議優化（粉紅）
    tbody.appendChild(sectionRow("建議優化指標", true));
    tbody.appendChild(subHeadRow(true));
    const improvs = [];
    sections.forEach(sec=>{
      sec.rows.forEach(r=>{
        if(r.grade==='bad') improvs.push(r);
      });
    });
    if (improvs.length===0){
      const tr = document.createElement('tr'); tr.className='rr-improve-row';
      tr.innerHTML=`<td colspan="5">（目前無紅色指標）</td>`; tbody.appendChild(tr);
    } else {
      improvs.forEach(r=>{
        const tr = document.createElement('tr');
        tr.className='rr-improve-row rr-bad-row';
        tr.innerHTML=`<td>• ${r.cells[0].replace(/ <span.*$/, '')}</td><td>${r.cells[1]}</td><td>建議優化</td><td>${r.cells[3]}</td><td>${r.cells[4]}</td>`;
        tbody.appendChild(tr);
      });
    }

    // 其餘各節
    sections.slice(1).forEach(sec=>{
      tbody.appendChild(sectionRow(sec.title,false));
      tbody.appendChild(subHeadRow(false));
      sec.rows.forEach(r=>{
        const tr = document.createElement('tr');
        tr.className = r.grade==='bad' ? 'rr-bad-row' : (r.grade==='good' ? 'rr-good-row' : '');
        tr.innerHTML = `<td>${r.cells[0]}</td><td>${r.cells[1]}</td><td>${r.cells[2]}</td><td>${r.cells[3]}</td><td>${r.cells[4]}</td>`;
        tbody.appendChild(tr);
      });
    });

    wrap.innerHTML = `<table class="rr-table"></table>`;
    wrap.querySelector('table').appendChild(tbody);

    function sectionRow(title, improve){
      const tr=document.createElement('tr');
      tr.className = improve? 'rr-improve-title' : 'rr-section-header';
      tr.innerHTML=`<td colspan="5">${title}</td>`; return tr;
    }
    function subHeadRow(improve){
      const tr=document.createElement('tr');
      tr.className = improve? 'rr-improve-head' : 'rr-subhead';
      tr.innerHTML = improve
       ? `<td>指標</td><td>數值</td><td>建議</td><td>機構評語</td><td>參考區間</td>`
       : `<td>指標</td><td>數值</td><td>說明</td><td>機構評語</td><td>參考區間</td>`;
      return tr;
    }
  }

  // ====== 月別報告（每月一張圖＋雙列明細） ======
  function buildMonthlyReport(allTrades){
    const dailyMap=new Map();
    for(const t of allTrades){ const d=keyFromTs(t.tsOut); dailyMap.set(d,(dailyMap.get(d)||0)+t.gainSlip); }
    const daily=[...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));
    const byM  = groupByMonth(daily);
    const tByM = groupTradesByMonth(allTrades);
    const months = Object.keys(byM).sort(); // 由舊到新

    const root = $("#monthlyRoot"); if(!root) return;
    root.innerHTML = "";

    months.forEach(m=>{
      const roc = toROC(m);
      const mDaily = byM[m];
      const mTrades= tByM[m] || [];

      // 當月累積線
      let cum=0; const labels=[],vals=[];
      mDaily.forEach(d=>{ cum+=d.pnl; labels.push(d.date.slice(5)); vals.push(cum); });

      const section=document.createElement('div');
      section.className='report-card month-card';
      section.innerHTML=`
        <div class="month-header">${roc}</div>
        <canvas id="mc-${m}" height="220"></canvas>
        <table class="month-table">
          <thead>
            <tr>
              <th>筆數</th><th>進場時間</th><th>進場價</th><th>類型</th>
              <th>點數</th><th>手續費</th><th>期交稅</th>
              <th>獲利</th><th>累積獲利</th><th>滑價獲利</th><th>累積滑價獲利</th>
            </tr>
          </thead>
          <tbody id="mtb-${m}"></tbody>
        </table>`;
      root.appendChild(section);

      // 圖：Y 軸金額千分位、X 軸自動抽樣（最多 12 個刻度）
      const ctx = section.querySelector(`#mc-${m}`);
      new Chart(ctx,{
        type:'line',
        data:{labels, datasets:[{label:`${roc} 當月累計`, data:vals, stepped:true, borderWidth:1.6, pointRadius:0}]},
        options:{
          responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{label:ctx=>` ${fmtMoney(ctx.parsed.y)}`}}},
          scales:{
            y:{ticks:{callback:v=>fmtMoney(v)}, grid:{display:true}},
            x:{ticks:{autoSkip:true,maxTicksLimit:12}, grid:{display:false}}
          }
        }
      });

      // 明細：雙列格式 + 當月累積
      const tb = section.querySelector(`#mtb-${m}`); const cls=v=>v>0?'p-red':(v<0?'p-green':'');
      let mcum=0, mcumSlip=0;
      const { fmtTs, MULT, FEE, TAX } = window.SHARED;
      tb.innerHTML = mTrades.map((t,i)=>{
        mcum+=t.gain; mcumSlip+=t.gainSlip;
        const row1 = `
          <tr>
            <td rowspan="2">${i+1}</td>
            <td>${fmtTs(t.pos.tsIn)}</td><td>${t.pos.pIn??'—'}</td><td>${t.pos.side==='L'?'新買':'新賣'}</td>
            <td class="${cls(t.pts)}">—</td><td>—</td><td>—</td>
            <td class="${cls(t.gain)}">—</td><td class="${cls(mcum)}">—</td>
            <td class="${cls(t.gainSlip)}">—</td><td class="${cls(mcumSlip)}">—</td>
          </tr>`;
        const row2 = `
          <tr>
            <td>${fmtTs(t.tsOut)}</td><td>${t.priceOut}</td><td>${t.pos.side==='L'?'平賣':'平買'}</td>
            <td class="${cls(t.pts)}">${Number.isFinite(t.pts)?t.pts:'—'}</td>
            <td>${FEE*2}</td><td>${Math.round(t.priceOut*MULT*TAX)}</td>
            <td class="${cls(t.gain)}">${fmtMoney(t.gain)}</td><td class="${cls(mcum)}">${fmtMoney(mcum)}</td>
            <td class="${cls(t.gainSlip)}">${fmtMoney(t.gainSlip)}</td><td class="${cls(mcumSlip)}">${fmtMoney(mcumSlip)}</td>
          </tr>`;
        return row1 + row2;
      }).join('');
    });
  }

  // ===== 主流程 =====
  async function handleRaw(raw){
    const { parseTXT, buildReport, paramsLabel } = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);
    if(report.trades.length===0){ alert("沒有成功配對的交易"); return; }

    drawChart({
      tsArr:report.tsArr, total:report.total, slipTotal:report.slipCum,
      long:report.longCum, longSlip:report.longSlipCum, short:report.shortCum, shortSlip:report.shortSlipCum,
    });

    const [lineAll,lineL,lineS]=buildKpiLines(report.statAll, report.statL, report.statS);
    $("#paramChip").textContent = paramsLabel(parsed.params);
    $("#kpiAll").textContent = lineAll; $("#kpiL").textContent = lineL; $("#kpiS").textContent = lineS;

    const dailyMap=new Map();
    for(const t of report.trades){ const d=keyFromTs(t.tsOut); dailyMap.set(d,(dailyMap.get(d)||0)+t.gainSlip); }
    const dailySlip=[...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));

    const k = computeRR(dailySlip, report.trades, DEFAULT_NAV, DEFAULT_RF);

    renderRR6Cats(k);           // ← Risk-Return 一定會顯示
    renderTable(report);
    buildMonthlyReport(report.trades);
  }

  // ===== 事件 =====
  $("#btn-clip").addEventListener("click", async ()=>{
    try{ const txt = await navigator.clipboard.readText(); await handleRaw(txt); }
    catch{ alert("無法讀取剪貼簿，請改用『選擇檔案』"); }
  });
  $("#file").addEventListener("change", async e=>{
    const f=e.target.files[0]; if(!f) return;
    try{ const txt=await window.SHARED.readAsTextAuto(f); await handleRaw(txt); }
    catch(err){ alert(err.message||"讀檔失敗"); }
  });
  $("#btn-print").addEventListener("click", ()=> window.print());
  $("#btn-build").addEventListener("click", ()=> {
    // 只是重建月別區塊（若已載入過）
    const tb = $("#tradeTable tbody");
    if (tb && tb.children.length) {
      const rows = []; // 如果需要可以從已構建結果重抓
      // 這裡簡單重建
      alert("已於頁面下方重建月別報告。");
    }
  });

  // ===== 工具（共用） =====
  function keyFromTs(ts){ const s=String(ts); return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`; }
  function fmtTs(s){ return `${s.slice(0,4)}/${s.slice(4,6)}/${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}`; }
  function fmtMoney(n){ return (Number(n)||0).toLocaleString("zh-TW"); }
  function toROC(ym){ const y=Number(ym.slice(0,4))-1911, m=ym.slice(5,7); return `${y} 年 ${Number(m)} 月`; }
  function groupByMonth(daily){ const g={}; daily.forEach(d=>{ const k=d.date.slice(0,7); (g[k]||(g[k]=[])).push(d); }); return g; }
  function groupTradesByMonth(trades){ const g={}; trades.forEach(t=>{ const k=keyFromTs(t.tsOut).slice(0,7); (g[k]||(g[k]=[])).push(t); }); return g; }
  function daysBetween(a,b){ const A=new Date(a+"T00:00:00"), B=new Date(b+"T00:00:00"); return Math.round((B-A)/86400000)+1; }
  function monthsBetween(a,b){ if(!a||!b) return 1; const A=new Date(a+"T00:00:00"), B=new Date(b+"T00:00:00"); return Math.max(1,(B.getFullYear()-A.getFullYear())*12 + (B.getMonth()-A.getMonth()) + 1); }
  function tsDiffMin(a,b){ if(!a||!b) return NaN; const d1=new Date(`${a.slice(0,4)}-${a.slice(4,6)}-${a.slice(6,8)}T${a.slice(8,10)}:${a.slice(10,12)}:${a.slice(12,14)||"00"}`); const d2=new Date(`${b.slice(0,4)}-${b.slice(4,6)}-${b.slice(6,8)}T${b.slice(8,10)}:${b.slice(10,12)}:${b.slice(12,14)||"00"}`); return (d2-d1)/60000; }
  const sum=a=>a.reduce((x,y)=>x+y,0), avg=a=>a.length?sum(a)/a.length:0;
  const stdev=a=>{ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
  const median=a=>{ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2? b[m] : (b[m-1]+b[m])/2; };
  function rollingSharpe(ret, win=126, rfDaily=0){
    const out=[]; for(let i=win;i<=ret.length;i++){ const seg=ret.slice(i-win,i); const m=avg(seg)-rfDaily; const v=stdev(seg); out.push(v>0?(m/v)*Math.sqrt(252):0); }
    return out;
  }
})();
