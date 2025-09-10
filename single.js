/* 6 線圖 + 三行KPI + Risk-Return 機構表格 + 交易明細 + 月別報告（圖＋明細） */
(function () {
  const $ = s => document.querySelector(s);
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get("nav")) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get("rf"))  || 0.00;
  console.log("[Report] single.js version report-v1");

  // ===== 樣式（一次） =====
  (function injectStyle(){
    if (document.getElementById("rr-style")) return;
    const css = `
      .p-red{color:#ef4444;font-weight:700}
      .p-green{color:#10b981;font-weight:700}
      .rr-good-row td{font-weight:800;color:#111}
      .rr-bad-row  td{font-weight:800;color:#ef4444}
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

  let chart;                  // 主圖
  let lastData = null;        // 保存資料（生成月別報告）

  // ===== 主圖 =====
  function drawChart(ser) {
    if (chart) chart.destroy();
    const { tsArr, total, slipTotal, long, longSlip, short, shortSlip } = ser;
    const labels = tsArr.map((_, i) => i);
    const mkSolid=(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0});
    const mkDash =(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0,borderDash:[6,4]});
    chart = new Chart($("#chart"), {
      type:"line",
      data:{labels,datasets:[
        mkSolid(slipTotal,"#111",3.5), mkDash(total,"#9aa",2),
        mkSolid(longSlip,"#d32f2f",3), mkDash(long,"#ef9a9a",2),
        mkSolid(shortSlip,"#2e7d32",3),mkDash(short,"#a5d6a7",2)
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
    });
  }

  // ===== 三行 KPI（沿用你原邏輯） =====
  function buildKpiLines(statAll, statL, statS) {
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

  // ===== 交易明細（紅/綠） =====
  function renderTable(report) {
    const { fmtTs, fmtMoney, MULT, FEE, TAX } = window.SHARED;
    const tb = $("#tradeTable tbody"); tb.innerHTML = "";
    let cum=0, cumSlip=0;
    const cls = v => v>0 ? "p-red" : (v<0 ? "p-green" : "");
    report.trades.forEach((t,i)=>{
      cum     += t.gain;
      cumSlip += t.gainSlip;
      const tr1=document.createElement("tr");
      tr1.innerHTML=`
        <td rowspan="2">${i+1}</td>
        <td>${fmtTs(t.pos.tsIn)}</td><td>${t.pos.pIn ?? '—'}</td><td>${t.pos.side==='L'?'新買':'新賣'}</td>
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

  // ====== KPI 計算（含滑價；與你穩定版一致，略去註解） ======
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
    const PF=Math.abs(losePnL)? winPnL/Math.abs(losePnL) : 0;
    const avgWin=wins.length? winPnL/wins.length : 0, avgLoss=losses.length? Math.abs(losePnL/losses.length) : 0;
    const payoff=avgLoss? avgWin/avgLoss : 0, winRate=trades.length? wins.length/trades.length : 0;
    const expectancy=trades.length? totalPnL/trades.length : 0;
    let maxWS=0,maxLS=0,curW=0,curL=0;
    for(const t of trades){ if(t.gainSlip>0){ curW++; maxWS=Math.max(maxWS,curW); curL=0; }
      else if(t.gainSlip<0){ curL++; maxLS=Math.max(maxLS,curL); curW=0; } else { curW=0; curL=0; } }
    const byDaySlip=(()=>{ const m=new Map(); for(const t of trades){ const d=keyFromTs(t.tsOut); m.set(d,(m.get(d)||0)+t.gainSlip); } return [...m.values()]; })();
    const maxDailyLoss=Math.abs(Math.min(0,...byDaySlip)), maxDailyGain=Math.max(0,...byDaySlip,0);
    const maxTradeLoss=Math.abs(Math.min(0,...trades.map(t=>t.gainSlip))), maxTradeGain=Math.max(0,...trades.map(t=>t.gainSlip),0);
    const holdMinsArr=trades.map(t=>tsDiffMin(t.pos.tsIn,t.tsOut)).filter(Number.isFinite);
    const avgHoldingMins=holdMinsArr.length? avg(holdMinsArr) : 0;
    const months=Math.max(1, monthsBetween(start,end));
    const tradesPerMonth=trades.length/months;

    // 進階 KPI
    const rollSharpe=rollingSharpe(dailyRet,126,DEFAULT_RF/252), rollSharpeMed=rollSharpe.length? median(rollSharpe) : 0;
    const {avgDD, medDD} = drawdownStats(eq);
    const ulcer=Math.sqrt(mean0(ddPct.map(x=>x*x)));
    const pain = ulcer>0 ? (annRet/ulcer) : 0;
    const burke=pain;
    const recFactor=maxDD? (totalPnL/Math.abs(maxDD)) : 0;
    const {skew, kurt}=momentSkewKurt(dailyRet);

    return { totalPnL,cagr,annRet,winRate,expectancy,
      maxDD,maxTUW:Math.round(maxTUW),recovery:Math.round(rec),
      vol,downside,var95,var99,es95,es99,
      maxDailyLoss,maxDailyGain,maxTradeLoss,maxTradeGain,
      sharpe,sortino,MAR,PF,payoff,avgWin,avgLoss,maxWS,maxLS,avgHoldingMins,tradesPerMonth,
      rollSharpeMed, avgDD,medDD,ulcer,pain,burke,recFactor,skew,kurt };
  }

  // ===== 機構級 Risk-Return（維持你五欄+建議優化+中文評語；篇幅長，這裡直接使用你上版穩定函式） =====
  // 若你需要我再完整貼一次 renderRR6Cats(k) 的實作（full-table-v5），我可以再送一版；
  // 這裡不影響月別報告/列印功能。

  function renderRR6Cats(k){ /*  ←← 這裡放你目前穩定版的表格渲染函式（不變） */ }

  // ===== 月別報告：每月一張圖 + 明細表（在交易明細下面） =====
  function buildMonthlyReport(allTrades) {
    const dailyMap = new Map();
    for (const t of allTrades) {
      const d = keyFromTs(t.tsOut);
      dailyMap.set(d, (dailyMap.get(d)||0) + t.gainSlip);
    }
    const daily = [...dailyMap.entries()]
      .sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([date,pnl])=>({date,pnl}));

    const dailyByMonth  = groupByMonth(daily);
    const tradesByMonth = groupTradesByMonth(allTrades);
    const months = Object.keys(dailyByMonth).sort();   // 由舊到新

    const root = document.getElementById('monthlyRoot');
    if (!root) return;
    root.innerHTML = '';

    months.forEach(m => {
      const roc = toROC(m);
      const mDaily = dailyByMonth[m];
      const mTrades = tradesByMonth[m] || [];

      // 當月累積
      let cum = 0; const labels=[], vals=[];
      mDaily.forEach(d=>{ cum += d.pnl; labels.push(d.date.slice(5)); vals.push(cum); });

      const section = document.createElement('div');
      section.className = 'report-card month-card';
      section.innerHTML = `
        <div class="month-header">${roc}</div>
        <canvas id="mc-${m}" height="160"></canvas>
        <table class="month-table">
          <thead>
            <tr>
              <th>筆數</th><th>進場時間</th><th>進場價</th><th>類型</th>
              <th>點數</th><th>手續費</th><th>期交稅</th>
              <th>獲利</th><th>滑價獲利</th>
            </tr>
          </thead>
          <tbody id="mtb-${m}"></tbody>
        </table>
      `;
      root.appendChild(section);

      const ctx = section.querySelector(`#mc-${m}`);
      new Chart(ctx, {
        type:'line',
        data:{labels, datasets:[{ label:`${roc} 當月累計`, data:vals, stepped:true, borderWidth:1.6, pointRadius:0 }]},
        options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}}
      });

      // 明細表
      const tb = section.querySelector(`#mtb-${m}`);
      const cls = v => v>0 ? "p-red" : (v<0 ? "p-green" : "");
      tb.innerHTML = mTrades.map((t,i)=>`
        <tr>
          <td>${i+1}</td>
          <td>${fmtTs(t.pos.tsIn)}</td>
          <td>${t.pos.pIn ?? '—'}</td>
          <td>${t.pos.side==='L'?'新買':'新賣'}</td>
          <td class="${cls(t.pts)}">${Number.isFinite(t.pts)?t.pts:'—'}</td>
          <td>—</td><td>—</td>
          <td class="${cls(t.gain)}">${fmtMoney(t.gain)}</td>
          <td class="${cls(t.gainSlip)}">${fmtMoney(t.gainSlip)}</td>
        </tr>
      `).join('');
    });
  }

  // ===== 主流程 =====
  async function handleRaw(raw){
    const { parseTXT, buildReport, paramsLabel } = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);        // 你現有的彙總
    if(report.trades.length===0){ alert("沒有成功配對的交易"); return; }

    drawChart({
      tsArr: report.tsArr,
      total: report.total,
      slipTotal: report.slipCum,
      long: report.longCum,
      longSlip: report.longSlipCum,
      short: report.shortCum,
      shortSlip: report.shortSlipCum,
    });

    const [lineAll,lineL,lineS] = buildKpiLines(report.statAll, report.statL, report.statS);
    $("#paramChip").textContent = paramsLabel(parsed.params);
    $("#kpiAll").textContent = lineAll; $("#kpiL").textContent = lineL; $("#kpiS").textContent = lineS;

    // 日損益（含滑價）
    const dailyMap=new Map();
    for(const t of report.trades){ const d=keyFromTs(t.tsOut); dailyMap.set(d,(dailyMap.get(d)||0)+t.gainSlip); }
    const dailySlip=[...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));

    // KPI
    const k = computeRR(dailySlip, report.trades, DEFAULT_NAV, DEFAULT_RF);

    // 機構級表格
    renderRR6Cats(k);

    // 全域明細
    renderTable(report);

    // 月別報告（追加在交易明細之下）
    buildMonthlyReport(report.trades);

    lastData = { trades: report.trades, dailySlip, kpi: k };
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
  $("#btn-build").addEventListener("click", ()=>{
    if(!lastData){ alert("請先載入 TXT 或檔案"); return; }
    buildMonthlyReport(lastData.trades);
    alert("月別報告已生成，您可以點『匯出 PDF』另存為 PDF。");
  });

  // ===== 工具 =====
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
  const mean0=a=>a.length?(a.reduce((x,y)=>x+y,0)/a.length):0;
  function drawdownStats(eq){ const depths=[]; let peak=-Infinity,trough=Infinity; for(const p of eq){ if(p.nav>peak){ if(peak!==-Infinity && trough<peak) depths.push(peak-trough); peak=p.nav; trough=p.nav; } else { trough=Math.min(trough,p.nav); } } if(peak!==-Infinity&&trough<peak) depths.push(peak-trough); return {avgDD:depths.length?avg(depths):0, medDD:depths.length?median(depths):0}; }
  function momentSkewKurt(x){ if(!x.length) return {skew:0,kurt:0}; const m=avg(x), n=x.length; let m2=0,m3=0,m4=0; for(const v of x){ const d=v-m; const d2=d*d; m2+=d2; m3+=d2*d; m4+=d2*d2; } m2/=n; m3/=n; m4/=n; const skew=m2>0?(m3/Math.pow(m2,1.5)):0; const kurt=m2>0?(m4/(m2*m2)):0; return {skew,kurt}; }
  function rollingSharpe(ret, win=126, rfDaily=0){
    const out=[]; for(let i=win;i<=ret.length;i++){ const seg = ret.slice(i-win,i); const m = avg(seg)-rfDaily; const v = stdev(seg); out.push(v>0 ? (m/v)*Math.sqrt(252) : 0); }
    return out;
  }
})();
