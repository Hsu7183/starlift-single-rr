/* 主圖（含月份分隔線） + 三行KPI + Risk-Return 機構表格（完整六大類） + 全域明細（雙列） + 月別報告（每月一圖＋雙列明細） + PDF */
(function(){
  const $ = s => document.querySelector(s);
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get("nav")) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get("rf"))  || 0.00;
  console.log("[Report] single.js report-v5");

  // ========= 一些通用工具 =========
  const sum=a=>a.reduce((x,y)=>x+y,0);
  const avg=a=>a.length? sum(a)/a.length : 0;
  const stdev=a=>{ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)*(v-m),0)/(a.length-1)); };
  const median=a=>{ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2? b[m] : (b[m-1]+b[m])/2; };
  const mean0=a=>a.length? sum(a)/a.length : 0;

  function keyFromTs(ts){ const s=String(ts); return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`; }
  function fmtTs(s){ return `${s.slice(0,4)}/${s.slice(4,6)}/${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}`; }
  function fmtMoney(n){ return (Number(n)||0).toLocaleString("zh-TW"); }
  function toROC(ym){ const y=Number(ym.slice(0,4))-1911, m=ym.slice(5,7); return `${y} 年 ${Number(m)} 月`; }
  function groupByMonth(daily){ const g={}; daily.forEach(d=>{ const k=d.date.slice(0,7); (g[k]||(g[k]=[])).push(d); }); return g; }
  function groupTradesByMonth(trades){ const g={}; trades.forEach(t=>{ const k=keyFromTs(t.tsOut).slice(0,7); (g[k]||(g[k]=[])).push(t); }); return g; }
  function daysBetween(a,b){ const A=new Date(a+"T00:00:00"), B=new Date(b+"T00:00:00"); return Math.round((B-A)/86400000)+1; }
  function monthsBetween(a,b){ if(!a||!b) return 1; const A=new Date(a+"T00:00:00"), B=new Date(b+"T00:00:00"); return Math.max(1,(B.getFullYear()-A.getFullYear())*12 + (B.getMonth()-A.getMonth()) + 1); }

  // 缺少時補上（避免 not defined）
  function rollingSharpe(ret, win=126, rfDaily=0){
    const out=[]; for(let i=win;i<=ret.length;i++){ const seg=ret.slice(i-win,i); const m=avg(seg)-rfDaily; const v=stdev(seg); out.push(v>0? (m/v)*Math.sqrt(252) : 0); }
    return out;
  }

  // ========= 主圖（含月份分隔線） =========
  let chart;
  function drawChart(ser, labelsByDate, monthTicks){
    if(chart) chart.destroy();
    const {tsArr,total,slipTotal,long,longSlip,short,shortSlip} = ser;

    chart = new Chart($("#chart"),{
      type:"line",
      data:{labels:labelsByDate,datasets:[
        {data:slipTotal,stepped:true,borderColor:"#111",borderWidth:3,pointRadius:0,label:"含滑價"},
        {data:total,stepped:true,borderColor:"#999",borderWidth:2,pointRadius:0,borderDash:[6,4],label:"未含滑價"},
        {data:longSlip,stepped:true,borderColor:"#d32",borderWidth:2.5,pointRadius:0,label:"多(滑)"},
        {data:long,stepped:true,borderColor:"#f99",borderWidth:1.5,pointRadius:0,borderDash:[6,4],label:"多"},
        {data:shortSlip,stepped:true,borderColor:"#2a3",borderWidth:2.5,pointRadius:0,label:"空(滑)"},
        {data:short,stepped:true,borderColor:"#9d9",borderWidth:1.5,pointRadius:0,borderDash:[6,4],label:"空"},
      ]},
      options:{
        responsive:true,maintainAspectRatio:false,
        plugins:{legend:{labels:{color:"#333",font:{size:12,weight:"bold"}}}},
        scales:{
          y:{ticks:{color:"#222",font:{size:12,weight:"bold"},callback:v=>fmtMoney(v)}},
          x:{ticks:{color:"#222",font:{size:11},autoSkip:true,maxRotation:0,callback:(v,i)=>monthTicks[i]||""},
             grid:{display:true,drawTicks:false,
               color:(ctx)=>{ // 每月第一天畫較深的分隔線
                 const idx = ctx.index;
                 return monthTicks[idx] ? "#d1d5db" : "#f3f4f6";
               }}}
        }
      }
    });
  }

  // ========= 三行 KPI（沿用） =========
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

  // ========= 全域交易明細（雙列、紅/綠） =========
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

  // ========= KPI 計算（含滑價） =========
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

    // 進階（供面板使用）
    const rollSharpe=rollingSharpe(dailyRet,126,DEFAULT_RF/252), rollSharpeMed=rollSharpe.length? median(rollSharpe):0;

    return { totalPnL,cagr,annRet,winRate,expectancy,
      maxDD,maxTUW:Math.round(maxTUW),recovery:Math.round(rec),vol,downside,
      var95,var99,es95,es99,maxDailyLoss,maxDailyGain,maxTradeLoss,maxTradeGain,
      sharpe,sortino,MAR,PF,payoff,avgWin,avgLoss,maxWS,maxLS,avgHoldingMins,tradesPerMonth, rollSharpeMed };
  }

  // ========= Risk-Return 機構表格（完整六大類） =========
  function renderRR(k){
    const wrap=$("#rrLines");
    const money=n=>fmtMoney(n);
    const pct=v=>(Number.isFinite(v)?(v*1).toFixed(2):"0.00")+"%";
    const row=(a,b,c,d,e)=>`<tr><td>${a}</td><td>${b}</td><td>${c}</td><td>${d}</td><td>${e}</td></tr>`;
    const sec=t=>`<tr class="rr-section-header"><td colspan="5">${t}</td></tr>`;
    const head=`<tr class="rr-subhead"><td>指標</td><td>數值</td><td>說明</td><td>機構評語</td><td>參考區間</td></tr>`;
    let html="<table class='rr-table'>";

    html+=sec("建議優化指標");
    html+=`<tr class="rr-improve-head"><td>指標</td><td>數值</td><td>建議</td><td>機構評語</td><td>參考區間</td></tr>`;
    const improv = [];
    if(k.vol>0.25) improv.push(row("波動率（Volatility）",pct(k.vol),"建議優化","Improve（優化），偏高，建議降槓桿","—"));
    if(k.PF<1.5)    improv.push(row("PF（獲利因子）",k.PF.toFixed(2),"建議優化","Improve（優化），偏低","—"));
    html+= improv.length? improv.join("") : `<tr class="rr-improve-row"><td colspan="5">（目前無紅色指標）</td></tr>`;

    html+=sec("一、報酬（Return）")+head;
    html+=row("總報酬（Total Return）",money(k.totalPnL),"回測累積淨損益（含滑價/稅/費）","Strong（強），報酬為正","—");
    html+=row("CAGR（年化複利）",pct(k.cagr),"以 NAV 為分母，依實際天數年化","Strong（強），年化穩健","≥15%");
    html+=row("平均每筆（Expectancy）",money(k.expectancy),"每筆平均淨損益（含滑價）","Strong（強），每筆期望為正",">0");
    html+=row("年化報酬（Arithmetic）",pct(k.annRet),"日均報酬 × 252","Strong（強），年化優秀","≥25%");
    html+=row("勝率（Hit Ratio）",(k.winRate).toFixed(2)+"%","獲利筆數 ÷ 總筆數","Adequate（可接受），需與盈虧比搭配","—");

    html+=sec("二、風險（Risk）")+head;
    html+=row("最大回撤（MaxDD）","-"+money(k.maxDD),"峰值到谷值最大跌幅（以金額）","Strong（強），回撤控制良好","≤15%NAV");
    html+=row("水下時間（TUW）",k.maxTUW,"在水下的最長天數","Adequate（可接受），可接受","≤120天");
    html+=row("回本時間（Recovery）",k.recovery,"自 MDD 末端至再創新高的天數","Strong（強），回本快","≤45天");
    html+=row("波動率（Volatility）",pct(k.vol),"日報酬標準差 × √252","Improve（優化），偏高，建議降槓桿","—");
    html+=row("下行波動（Downside Dev）",pct(k.downside),"只計下行（供 Sortino）","Strong（強），下行小","≤10%");
    html+=row("VaR 95%","-"+money(k.var95),"單日 95% 置信最大虧損（金額）","Adequate（可接受），3–5%","≤5%NAV");
    html+=row("ES 95%（CVaR）","-"+money(k.es95),"落於 VaR95 之後的平均虧損","Strong（強），≤2.5%NAV","≤2.5%NAV");
    html+=row("VaR 99%","-"+money(k.var99),"單日 99% 置信最大虧損（金額）","Adequate（可接受），5–8%","≤8%NAV");
    html+=row("ES 99%（CVaR）","-"+money(k.es99),"落於 VaR99 之後的平均虧損","Strong（強），≤3.5%NAV","≤3.5%NAV");
    html+=row("單日最大虧損","-"+money(k.maxDailyLoss),"樣本期間最糟的一天","Strong（強），尾部可控","≤4%NAV");

    html+=sec("三、風險調整報酬（Risk-Adjusted Return）")+head;
    html+=row("Sharpe（夏普）",k.sharpe.toFixed(2),"(年化報酬 − rf)／年化波動","Strong（強），>1.5 穩健","≥1.5");
    html+=row("Sortino（索提諾）",k.sortino.toFixed(2),"只懲罰下行波動","Strong（強），>2 佳","≥2");
    html+=row("MAR",k.MAR.toFixed(2),"CAGR ÷ |MDD|（CTA 常用）","Strong（強），>2 佳","≥2");
    html+=row("PF（獲利因子）",k.PF.toFixed(2),"總獲利 ÷ 總虧損（含成本/滑價）",""+(k.PF<1.5?"Improve（優化），偏低":"Adequate（可接受）"),"≥1.5");
    html+=row("Payoff（盈虧比）",k.payoff.toFixed(2),"平均獲利 ÷ 平均虧損","Strong（強），盈虧比高","≥2");

    html+=sec("四、交易結構與執行品質（Trade-Level & Execution）")+head;
    html+=row("平均獲利單",money(k.avgWin),"含滑價的平均獲利金額","Adequate（可接受）","≥平均虧損單");
    html+=row("平均虧損單","-"+money(k.avgLoss),"含滑價的平均虧損金額","Adequate（可接受）","—");
    html+=row("最大連勝",k.maxWS,"連續獲利筆數","Adequate（可接受）","—");
    html+=row("最大連敗",k.maxLS,"連續虧損筆數","Adequate（可接受），需資金/心理控管","≤12");
    html+=row("平均持倉時間",k.avgHoldingMins.toFixed(2)+" 分","tsIn→tsOut 的平均分鐘數","Adequate（可接受）","—");
    html+=row("交易頻率",k.tradesPerMonth.toFixed(2)+" 筆/月","以回測期間月份估算","Adequate（可接受）","—");

    html+=sec("五、穩健性與可複製性（Robustness & Statistical）")+head;
    html+=row("滾動 Sharpe（6個月中位）",k.rollSharpeMed.toFixed(2),"126 交易日窗的 Sharpe 中位數","Strong（強），時間穩定性佳","≥1.5");

    html+="</table>";
    wrap.innerHTML = html;
  }

  // ========= 月別報告（每月一圖＋雙列明細；Y 軸千分位、X 軸自動抽樣） =========
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

      // 當月累積
      let cum=0; const labels=[],vals=[];
      mDaily.forEach(d=>{ cum+=d.pnl; labels.push(d.date.slice(5)); vals.push(cum); });

      const section=document.createElement('div');
      section.className='report-card month-card';
      section.innerHTML=`
        <div class="month-header">${roc}</div>
        <canvas id="mc-${m}" height="240"></canvas>
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

      const ctx = section.querySelector(`#mc-${m}`);
      new Chart(ctx,{
        type:'line',
        data:{labels, datasets:[{label:`${roc} 當月累計`, data:vals, stepped:true, borderWidth:2, pointRadius:0}]},
        options:{
          responsive:true, maintainAspectRatio:false,
          plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>` ${fmtMoney(c.parsed.y)}`}}},
          scales:{
            y:{ticks:{callback:v=>fmtMoney(v),color:"#111",font:{size:12,weight:"bold"}}},
            x:{ticks:{autoSkip:true,maxTicksLimit:12,color:"#111",font:{size:11}}, grid:{display:false}}
          }
        }
      });

      // 明細（雙列；含當月累積）
      const tb=section.querySelector(`#mtb-${m}`); const cls=v=>v>0?'p-red':(v<0?'p-green':'');
      let mcum=0, mcumSlip=0; const { fmtTs, MULT, FEE, TAX } = window.SHARED;
      tb.innerHTML = mTrades.map((t,i)=>{
        mcum+=t.gain; mcumSlip+=t.gainSlip;
        return `
          <tr>
            <td rowspan="2">${i+1}</td>
            <td>${fmtTs(t.pos.tsIn)}</td><td>${t.pos.pIn??'—'}</td><td>${t.pos.side==='L'?'新買':'新賣'}</td>
            <td class="${cls(t.pts)}">—</td><td>—</td><td>—</td>
            <td class="${cls(t.gain)}">—</td><td class="${cls(mcum)}">—</td>
            <td class="${cls(t.gainSlip)}">—</td><td class="${cls(mcumSlip)}">—</td>
          </tr>
          <tr>
            <td>${fmtTs(t.tsOut)}</td><td>${t.priceOut}</td><td>${t.pos.side==='L'?'平賣':'平買'}</td>
            <td class="${cls(t.pts)}">${Number.isFinite(t.pts)?t.pts:'—'}</td>
            <td>${FEE*2}</td><td>${Math.round(t.priceOut*MULT*TAX)}</td>
            <td class="${cls(t.gain)}">${fmtMoney(t.gain)}</td><td class="${cls(mcum)}">${fmtMoney(mcum)}</td>
            <td class="${cls(t.gainSlip)}">${fmtMoney(t.gainSlip)}</td><td class="${cls(mcumSlip)}">${fmtMoney(mcumSlip)}</td>
          </tr>`;
      }).join('');
    });
  }

  // ========= 主流程 =========
  async function handleRaw(raw){
    const parsed=window.SHARED.parseTXT(raw);
    const report=window.SHARED.buildReport(parsed.rows);
    if(report.trades.length===0){ alert("沒有交易"); return; }

    // 生成主圖用軸標：依日期找出「每月第一天」的 label 與 grid
    // 你的 tsArr 是每筆交易對應的索引，我們用交易序列長度標示，並建立 monthTicks
    const labelsByDate = report.tsArr.map((_,i)=>i);
    const monthTicks = report.tsArr.map(()=> ""); // 先空
    // 以交易的出場日期為準，標出每月第一天位置（近似）
    (function markMonthTicks(){
      const days = report.tsArr.map((_,i)=>i); // 索引即 x
      const outDates = []; // 以 trades 的 tsOut 為序
      report.trades.forEach(t=>{ outDates.push(keyFromTs(t.tsOut)); });
      // 建出「日 → 最早 x」索引
      const firstAt = new Map();
      outDates.forEach((d,idx)=>{ if(!firstAt.has(d)) firstAt.set(d, idx); });
      const months = [...firstAt.keys()].map(d=>d.slice(0,7));
      const seen = new Set();
      months.forEach((m,i)=>{
        if(seen.has(m)) return; seen.add(m);
        // 找當月第一天
        const day = [...firstAt.keys()].find(d=>d.startsWith(m));
        if(!day) return;
        const x = firstAt.get(day);
        monthTicks[x] = m.replace(/^\d{4}-/,""); // 只顯示 MM
      });
    })();

    drawChart({
      tsArr:report.tsArr,total:report.total,slipTotal:report.slipCum,
      long:report.longCum,longSlip:report.longSlipCum,short:report.shortCum,shortSlip:report.shortSlipCum
    }, labelsByDate, monthTicks);

    // Risk-Return
    const dailyMap=new Map();
    for(const t of report.trades){ const d=keyFromTs(t.tsOut); dailyMap.set(d,(dailyMap.get(d)||0)+t.gainSlip); }
    const dailySlip=[...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));
    const k=computeRR(dailySlip, report.trades, DEFAULT_NAV, DEFAULT_RF);
    renderRR(k);

    // 全域明細
    renderTable(report);

    // 月別報告
    buildMonthlyReport(report.trades);
  }

  // ========= 事件 =========
  $("#btn-clip").addEventListener("click",async()=>{ try{ const txt=await navigator.clipboard.readText(); await handleRaw(txt); }catch{ alert("無法讀取剪貼簿，請改用『選擇檔案』"); }});
  $("#file").addEventListener("change",async e=>{ const f=e.target.files[0]; if(!f) return; try{ const txt=await window.SHARED.readAsTextAuto(f); await handleRaw(txt); }catch(err){ alert(err.message||"讀檔失敗"); }});
  $("#btn-print").addEventListener("click",()=>window.print());
  $("#btn-build").addEventListener("click",()=>{ const tb=$("#tradeTable tbody"); if(!tb||!tb.children.length){ alert("請先載入 TXT 或檔案"); return; } alert("月別報告已生成（位於交易明細下方）。"); });

})();
