/* 單檔分析（機構級） full-table-v13 ── 注入版（fix: 參數顯示小數）
   與你的原版相同；僅：
   1) 參數列改用 TXT 第一行做顯示，保留 0.1 / 0.02 等小數
   2) 檔尾保留 sessionStorage 注入邏輯
*/
(function () {
  const $ = s => document.querySelector(s);
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get("nav")) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get("rf"))  || 0.00;
  console.log("[RR] single-inject.js based on full-table-v13 + param fix");

  // ---------- 樣式（一次注入） ----------
  (function injectStyle(){
    if (document.getElementById("rr-style")) return;
    const css = `
      .p-red{color:#ef4444;font-weight:700}
      .p-green{color:#10b981;font-weight:700}
      .num{text-align:right}
      .rr-good-row td{font-weight:800;color:#111}
      .rr-bad-row  td{font-weight:800;color:#ef4444}
      .rr-table{width:100%;border-collapse:collapse;background:#fff}
      .rr-table th,.rr-table td{
        padding:6px 8px;border-bottom:1px solid #e5e7eb;
        white-space:nowrap;font:13px/1.65 ui-monospace,Consolas,Menlo,monospace
      }
      .rr-section-header td{background:#f6f7fb;font-weight:800;border-top:1px solid #e5e7eb}
      .rr-subhead td{background:#fafafa;font-weight:700}
      .rr-improve-title td{background:#fff1f2;border-top:2px solid #fecdd3;border-bottom:1px solid #fecdd3;font-weight:800;color:#be123c}
      .rr-improve-head td{background:#ffe4e6;color:#be123c;font-weight:700}
      .rr-improve-row td{background:#fff5f5;color:#b91c1c}
      .kpi-combined .col-all{background:#fff}
      .kpi-combined .col-long{background:#fff1f2}
      .kpi-combined .col-short{background:#ecfdf5}
      #tradeTable thead td{position:sticky;top:0;background:#fff;font-weight:700;z-index:2}
      #tradeTable tbody tr:nth-child(even){background:#fafafa}
      #chartBox{height:540px}
    `;
    const style = document.createElement("style");
    style.id = "rr-style"; style.textContent = css;
    document.head.appendChild(style);
  })();

  let chart;

  // ---------- 小工具 ----------
  const fmtComma = n => (Number(n)||0).toLocaleString("zh-TW");
  const tsToDate = ts => {
    const s = String(ts||"");
    const y = s.slice(0,4), m = s.slice(4,6), d = s.slice(6,8);
    if (y && m && d) return `${y}/${Number(m)}/${Number(d)}`;
    return s;
  };
  const nowStr = ()=> {
    const d=new Date();
    const pad=n=>String(n).padStart(2,"0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  function roundRect(ctx, x, y, w, h, r){
    const rr = Math.min(r, w/2, h/2);
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y,   x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x,   y+h, rr);
    ctx.arcTo(x,   y+h, x,   y,   rr);
    ctx.arcTo(x,   y,   x+w, y,   rr);
    ctx.closePath();
  }

  // 將 123.000000 → 123；1.230000 → 1.23；保留 0.1 / 0.02 等小數，不動分隔符（空白、|、、等）
  function tidyParamLine(line){
    if(!line) return "—";
    return line
      .replace(/(-?\d+\.\d*?[1-9])0+(?=\D|$)/g, "$1")  // 去掉小數尾 0（但保留最後一位非 0）
      .replace(/(-?\d+)\.0+(?=\D|$)/g, "$1")          // .000000 → 整數
      .replace(/\s{2,}/g, " ");                       // 壓縮多空白
  }

  // ---------- 圖表（Max/Min/Last；Last 只顯示數值；右側留白） ----------
  function drawChart(ser) {
    if (chart) chart.destroy();
    const { tsArr, total, slipTotal, long, longSlip, short, shortSlip } = ser;
    const labels = tsArr.map((_, i) => i);

    const mkSolid=(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0});
    const mkDash =(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0,borderDash:[6,4]});

    const arr = slipTotal || [];
    const idxLast = Math.max(0, arr.length-1);
    const idxMax  = arr.reduce((imax, v, i)=> v>(arr[imax]??-Infinity)? i:imax, 0);
    const idxMin  = arr.reduce((imin, v, i)=> v<(arr[imin]?? Infinity)? i:imin, 0);

    const annos = [
      {i:idxMax,  val:arr[idxMax],  color:"#ef4444", label:`${fmtComma(Math.round(arr[idxMax]))}(${tsToDate(tsArr[idxMax])})`},
      {i:idxMin,  val:arr[idxMin],  color:"#10b981", label:`${fmtComma(Math.round(arr[idxMin]))}(${tsToDate(tsArr[idxMin])})`},
      {i:idxLast, val:arr[idxLast], color:"#111",    label:fmtComma(Math.round(arr[idxLast]))}, // 只顯示數值
    ];

    const annoPlugin = {
      id:"rr-anno",
      afterDatasetsDraw(c){
        const {ctx, scales:{x,y}} = c;
        ctx.save(); ctx.font="12px ui-sans-serif,system-ui"; ctx.textBaseline="middle";
        annos.forEach(a=>{
          if (!Number.isFinite(a.val)) return;
          const px = x.getPixelForValue(a.i);
          const py = y.getPixelForValue(a.val);
          ctx.beginPath(); ctx.arc(px,py,6,0,Math.PI*2); ctx.fillStyle=a.color; ctx.fill();
          const text=a.label, pad=6, h=20, w=ctx.measureText(text).width+pad*2;
          const bx=px+12, by=py-h/2;
          ctx.fillStyle="rgba(255,255,255,.96)";
          ctx.beginPath(); roundRect(ctx,bx,by,w,h,6); ctx.fill();
          ctx.strokeStyle="#111"; ctx.stroke();
          ctx.fillStyle="#111"; ctx.fillText(text,bx+pad,by+h/2);
        });
        ctx.restore();
      }
    };

    chart = new Chart($("#chart"), {
      type:"line",
      data:{labels,datasets:[
        mkSolid(slipTotal,"#111",3.5),   mkDash(total,"#9aa",2),
        mkSolid(longSlip,"#d32f2f",3),   mkDash(long,"#ef9a9a",2),
        mkSolid(shortSlip,"#2e7d32",3),  mkDash(short,"#a5d6a7",2)
      ]},
      options:{
        responsive:true, maintainAspectRatio:false,
        layout:{padding:{right:72}},
        scales:{x:{ticks:{padding:18}}},
        plugins:{legend:{display:false}}
      },
      plugins:[annoPlugin]
    });
  }

  // ---------- KPI（合併表：全部/多/空 三欄） ----------
  function renderKpiCombined(statAll, statL, statS) {
    const { fmtMoney, pct } = window.SHARED;
    const mk = s => ({
      "交易數": String(s.count),
      "勝率": pct(s.winRate),
      "敗率": pct(s.loseRate),
      "單日最大獲利": fmtMoney(s.dayMax),
      "單日最大虧損": fmtMoney(s.dayMin),
      "區間最大獲利": fmtMoney(s.up),
      "區間最大回撤": fmtMoney(s.dd),
      "累積獲利": fmtMoney(s.gain),
    });
    const A = mk(statAll), L = mk(statL), S = mk(statS);

    const host = $("#kpiAll"); $("#kpiL").innerHTML=""; $("#kpiS").innerHTML="";
    host.innerHTML = "";

    const tbl = document.createElement("table"); tbl.className="rr-table kpi-combined";
    const tb  = document.createElement("tbody");
    tb.innerHTML = `
      <tr class="rr-section-header"><td colspan="4">KPI（含滑價）</td></tr>
      <tr class="rr-subhead"><td>指標</td><td>全部（含滑價）</td><td>多單（含滑價）</td><td>空單（含滑價）</td></tr>
    `;
    Object.keys(A).forEach(k=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `
        <td>${k}</td>
        <td class="col-all">${A[k]}</td>
        <td class="col-long">${L[k]}</td>
        <td class="col-short">${S[k]}</td>
      `;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); host.appendChild(tbl);
  }

  // ---------- RR 計算（同原版） ----------
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

    const sharpe = vol      ? ((annRet - rf) / vol)      : 0;
    const sortino= downside ? ((annRet - rf) / downside) : 0;

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
    const rollSharpe=rollingSharpe(dailyRet,126,rf/252), rollSharpeMed=rollSharpe.length? median(rollSharpe) : 0;

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
      sharpe,sortino,MAR,PF,payoff,avgWin,avgLoss,maxWS,maxLS,avgHoldingMins,tradesPerMonth,rollSharpeMed,
      avgDD,medDD,ulcer,pain,burke,recFactor,skew,kurt };
  }

  // ---------- RR 表（含建議優化指標） ----------
  function renderRR6Cats(k){
    const NAV=DEFAULT_NAV;
    const money=n=>(Number(n)||0).toLocaleString("zh-TW");
    const pmoney=n=>(Number(n)>0?"":"-")+money(Math.abs(Number(n)||0));
    const pct2=x=>(Number.isFinite(x)?(x*100).toFixed(2):"0.00")+"%";
    const fix2=x=>Number(x).toFixed(2);
    const labelGrade = lvl => lvl==='good'?'Strong（強）':(lvl==='bad'?'Improve（優化）':'Adequate（可接受）');

    const RULES = {
      cagr:v=> v>=0.30?['good','年化極佳','≥30%'] : v>=0.15?['good','年化穩健','≥15%'] : v>=0.05?['ok','尚可','≥5%'] : ['bad','偏低','—'],
      ann :v=> v>=0.25?['good','年化報酬優秀','≥25%'] : v>=0.10?['ok','尚可','≥10%'] : ['bad','偏低','—'],
      exp :v=> v>0?['good','每筆期望為正','>0'] : ['bad','未覆蓋交易成本','>0'],
      hit :(v,po)=> v>=0.45?['good','勝率偏高','≥45%'] : (v<0.30&&po<1.5?['bad','低勝率且盈虧比偏低','—'] : ['ok','需與盈虧比搭配','—']),
      mdd :v=> (Math.abs(v)/NAV)<=0.15?['good','回撤控制良好','≤15%NAV']:(Math.abs(v)/NAV)<=0.25?['ok','可接受','≤25%NAV']:['bad','偏大','—'],
      tuw :v=> v<=60?['good','水下短','≤60天']:v<=120?['ok','可接受','≤120天']:['bad','偏長','—'],
      rec :v=> v<=45?['good','回本快','≤45天']:v<=90?['ok','可接受','≤90天']:['bad','偏慢','—'],
      vol :v=> v<=0.15?['ok','波動在常見區間','8%~15%'] : v<=0.25?['ok','略高','≤25%'] : ['bad','偏高，建議降槓桿','—'],
      ddev:v=> v<=0.10?['good','下行控制佳','≤10%'] : v<=0.15?['ok','≤15%'] : ['bad','偏高','—'],
      var95:v=> (v/NAV)<=0.03?['good','≤3%NAV','≤3%NAV'] : (v/NAV)<=0.05?['ok','3–5%','≤5%NAV'] : ['bad','>5%','—'],
      es95 :v=> (v/NAV)<=0.025?['good','≤2.5%NAV','≤2.5%NAV'] : (v/NAV)<=0.04?['ok','2.5–4%','≤4%NAV'] : ['bad','>4%','—'],
      var99:v=> (v/NAV)<=0.05?['good','≤5%NAV','≤5%NAV'] : (v/NAV)<=0.08?['ok','5–8%','≤8%NAV'] : ['bad','>8%','—'],
      es99 :v=> (v/NAV)<=0.035?['good','≤3.5%NAV','≤3.5%NAV'] : (v/NAV)<=0.06?['ok','3.5–6%','≤6%NAV'] : ['bad','>6%','—'],
      maxDayLoss:v=> (v/NAV)<=0.04?['good','≤4%NAV'] : (v/NAV)<=0.06?['ok','≤6%NAV'] : ['bad','偏高','—'],
      sharpe:v=> v>=2?['good','≥2'] : v>=1.5?['ok','≥1.5'] : v>=1?['ok','≥1'] : ['bad','需提升','—'],
      sortino:v=> v>=2?['good','≥2'] : v>=1.5?['ok','≥1.5'] : v>=1?['ok','≥1'] : ['bad','需提升','—'],
      mar :v=> v>=2?['good','≥2'] : v>=1.5?['ok','≥1.5'] : v>=1?['ok','≥1'] : ['bad','需提升','—'],
      pf  :v=> v>=2?['good','≥2'] : v>=1.5?['ok','≥1.5'] : ['bad','偏低','—'],
      payoff:v=> v>=2?['good','≥2'] : v>=1.5?['ok','≥1.5'] : ['bad','偏低','—'],
      ulcer:v=> v<=0.10?['good','≤10%'] : v<=0.15?['ok','≤15%'] : ['bad','—'],
      avgDD:v=> (v/DEFAULT_NAV)<=0.08?['good','≤8%NAV'] : (v/DEFAULT_NAV)<=0.15?['ok','≤15%NAV'] : ['bad','—'],
      medDD:v=> (v/DEFAULT_NAV)<=0.08?['good','≤8%NAV'] : (v/DEFAULT_NAV)<=0.15?['ok','≤15%NAV'] : ['bad','—'],
      pain:v=> v>=1.5?['good','≥1.5'] : v>=1?['ok','≥1'] : ['bad','—'],
      burke:v=> v>=2?['good','≥2'] : v>=1?['ok','≥1'] : ['bad','—'],
      recF:v=> v>=3?['good','≥3'] : v>=1.5?['ok','≥1.5'] : ['bad','—'],
      skew:v=> v>0?['good','>0'] : v===0?['ok','≈0'] : ['bad','>0'],
      kurt:v=> v<=4?['ok','≤4'] : v<=5?['ok','≤5'] : ['bad','—'],
      roll:v=> v>=1.5?['good','≥1.5'] : v>=1?['ok','≥1'] : ['bad','—'],
      maxLS:v=> v<=8?['ok','≤8'] : v<=12?['ok','≤12'] : ['bad','—'],
    };

    const sections=[]; const improvs=[];
    const pushHeader = (title) => sections.push({title, rows: []});
    const pushRow = (title, value, desc, tuple, tierLabel, sec=sections[sections.length-1]) => {
      const [grade, comment, bench] = tuple;
      const evalText = `${labelGrade(grade)}${comment? '，'+comment : ''}`;
      sec.rows.push({ grade, cells:[`${title}${tierLabel?` <span class="rr-tier">(${tierLabel})</span>`:''}`, value, desc, evalText, bench||'—'] });
      if (grade==='bad') improvs.push([title, value || '—', '建議優化', evalText, bench||'—']);
    };

    // 建議優化
    pushHeader("建議優化指標");

    // 一、報酬
    pushHeader("一、報酬（Return）");
    pushRow("總報酬（Total Return）", money(k.totalPnL), "回測累積淨損益（含手續費/稅/滑價）", k.totalPnL>0?['good','報酬為正','—']:['bad','淨損益為負','—'], "Core");
    pushRow("CAGR（年化複利）",        pct2(k.cagr),     "以 NAV 為分母，依實際天數年化",        ['ok','—','—'], "Core");
    pushRow("平均每筆（Expectancy）",  money(k.expectancy),"每筆平均淨損益（含滑價）",           (k.expectancy>0?['good','>0','>0']:['bad','≤0','>0']), "Core");
    pushRow("年化報酬（Arithmetic）",  pct2(k.annRet),    "日均報酬 × 252",                      ['ok','—','—'], "Core");
    pushRow("勝率（Hit Ratio）",       pct2(k.winRate),   "獲利筆數 ÷ 總筆數",                   (k.winRate>=0.45?['good','≥45%','≥45%']:['ok','—','—']), "Core");

    // 二、風險
    pushHeader("二、風險（Risk）");
    pushRow("最大回撤（MaxDD）",       pmoney(-k.maxDD),  "峰值到谷值最大跌幅（金額）",        ['ok','—','—'], "Core");
    pushRow("水下時間（TUW）",         String(k.maxTUW),  "在水下的最長天數",                    ['ok','—','—'], "Core");
    pushRow("回本時間（Recovery）",     String(k.recovery),"自 MDD 末端至再創新高的天數",          ['ok','—','—'], "Core");
    pushRow("波動率（Volatility）",     pct2(k.vol),       "日報酬標準差 × √252",                 ['ok','—','—'], "Core");
    pushRow("下行波動（Downside Dev）", pct2(k.downside),  "只計下行（供 Sortino）",              ['ok','—','—'], "Core");
    pushRow("VaR 95%",                  pmoney(-k.var95),  "單日 95% 置信最大虧損（金額）",        ['ok','—','—'], "Core");
    pushRow("ES 95%（CVaR）",            pmoney(-k.es95),   "落於 VaR95 之後的平均虧損",           ['ok','—','—'], "Core");
    pushRow("VaR 99%",                  pmoney(-k.var99),  "單日 99% 置信最大虧損（金額）",        ['ok','—','—'], "Core");
    pushRow("ES 99%（CVaR）",            pmoney(-k.es99),   "落於 VaR99 之後的平均虧損",           ['ok','—','—'], "Core");
    pushRow("單日最大虧損",              pmoney(-k.maxDailyLoss), "樣本期間最糟的一天",           ['ok','—','—'], "Core");

    // 三、風險調整
    pushHeader("三、風險調整報酬（Risk-Adjusted Return）");
    pushRow("Sharpe（夏普）",           fix2(k.sharpe),    "（年化報酬 − rf）／年化波動",          ['ok','—','—'], "Core");
    pushRow("Sortino（索提諾）",         fix2(k.sortino),   "只懲罰下行波動",                      ['ok','—','—'], "Core");
    pushRow("MAR",                      fix2(k.MAR),       "CAGR ÷ |MDD|（CTA 常用）",             ['ok','—','—'], "Core");
    pushRow("PF（獲利因子）",            fix2(k.PF),        "總獲利 ÷ 總虧損（含成本/滑價）",       ['ok','—','—'], "Core");
    pushRow("Payoff（盈虧比）",          fix2(k.payoff),    "平均獲利 ÷ 平均虧損",                 ['ok','—','—'], "Imp.");
    pushRow("Pain Ratio",               fix2(k.pain),      "年化報酬 ÷ Ulcer（近似）",             ['ok','—','—'], "Imp.");
    pushRow("Burke Ratio",              fix2(k.burke),     "年化報酬 ÷ 回撤平方和開根（近似）",     ['ok','—','—'], "Imp.");
    pushRow("Recovery Factor",          fix2(k.recFactor), "累積報酬 ÷ |MDD|",                     ['ok','—','—'], "Imp.");

    // 四、交易結構與執行
    pushHeader("四、交易結構與執行品質（Trade-Level & Execution）");
    pushRow("盈虧比（Payoff）",          fix2(k.payoff),    "平均獲利 ÷ 平均虧損",                 ['ok','—','—'], "Core");
    pushRow("平均獲利單",                money(k.avgWin),   "含滑價的平均獲利金額",                 ['ok','—','≥平均虧損單'], "Core");
    pushRow("平均虧損單",                pmoney(-k.avgLoss),"含滑價的平均虧損金額",                 ['ok','—','—'], "Core");
    pushRow("最大連勝",                  String(k.maxWS),   "連續獲利筆數",                         ['ok','—','—'], "Core");
    pushRow("最大連敗",                  String(k.maxLS),   "連續虧損筆數",                         ['ok','—','—'], "Core");
    pushRow("平均持倉時間",              `${k.avgHoldingMins.toFixed(2)} 分`, "tsIn→tsOut 平均分鐘數", ['ok','—','—'], "Core");
    pushRow("交易頻率",                  `${k.tradesPerMonth.toFixed(2)} 筆/月`, "以回測期間月份估算", ['ok','—','—'], "Core");
    pushRow("Slippage（滑價）",           "—",               "滑價影響（委託型態/參與率）",         ['ok','—','—'], "Imp.");
    pushRow("Implementation Shortfall",  "—",               "決策價 vs 成交價差（含費用）",         ['ok','—','—'], "Imp.");
    pushRow("Fill Rate / Queue Loss",    "—",               "成交率 / 排隊損失",                   ['ok','—','—'], "Imp.");
    pushRow("Adverse Selection",         "—",               "成交後短窗報酬為負的比例",             ['ok','—','—'], "Adv.");
    pushRow("時段 Edge 熱力圖",           "—",               "各時段勝率/期望差異",                 ['ok','—','—'], "Adv.");

    // 五、穩健性
    pushHeader("五、穩健性與可複製性（Robustness & Statistical Soundness）");
    pushRow("滾動 Sharpe（6個月中位）",  fix2(k.rollSharpeMed), "126 交易日窗的 Sharpe 中位數", ['ok','—','—'], "Core");
    pushRow("WFA（Walk-Forward）",        "—",               "滾動調參/驗證",                       ['ok','—','—'], "Core");
    pushRow("OOS（樣本外）",              "—",               "樣本外表現",                           ['ok','—','—'], "Core");
    pushRow("參數敏感度（±10~20%）",      "—",               "熱圖檢查過擬合",                       ['ok','—','—'], "Imp.");
    pushRow("Prob./Deflated Sharpe",      "—",               "修正多測偏誤之 Sharpe",                ['ok','—','—'], "Imp.");
    pushRow("Regime 分析",               "—",               "趨勢/震盪 × 高/低波動",                ['ok','—','—'], "Adv.");
    pushRow("Alpha/Concept Decay",       "—",               "邊際優勢衰退速度",                     ['ok','—','—'], "Adv.");

    // 六、風險用量與容量
    pushHeader("六、風險用量、槓桿與容量（Risk Usage, Leverage & Capacity）");
    pushRow("Leverage（槓桿）",           "—",               "名目曝險 / 權益 或 Margin-to-Equity", ['ok','—','—'], "Core");
    pushRow("Gross / Net Exposure",       "—",               "總/淨曝險",                           ['ok','—','—'], "Core");
    pushRow("Risk Contribution（mVaR）",  "—",               "子策略/商品風險貢獻",                  ['ok','—','—'], "Core");
    pushRow("Diversification Ratio",      "—",               "分散度指標",                           ['ok','—','—'], "Imp.");
    pushRow("Concentration (HHI)",        "—",               "集中度指標（權重或風險）",             ['ok','—','—'], "Imp.");
    pushRow("Capacity / Participation",   "—",               "容量/參與率壓測",                       ['ok','—','—'], "Adv.");
    pushRow("Impact per 100口",           "—",               "單位下單的價格衝擊",                   ['ok','—','—'], "Adv.");
    pushRow("Kyle’s λ / Amihud",          "—",               "衝擊係數 / 流動性稀薄度",              ['ok','—','—'], "Adv.");
    pushRow("Stress Scenarios",           "—",               "情境/沖擊測試",                         ['ok','—','—'], "Adv.");

    // 渲染
    const tbody = document.createElement('tbody');

    // 建議優化（粉紅專區）
    tbody.appendChild(sectionRow("建議優化指標", true));
    tbody.appendChild(subHeadRow(true));
    const tr0 = document.createElement('tr');
    tr0.className = 'rr-improve-row';
    tr0.innerHTML = `<td colspan="5">（目前無紅色指標）</td>`;
    tbody.appendChild(tr0);

    const wrap = $("#rrLines");
    wrap.innerHTML = `<table class="rr-table"></table>`;
    wrap.querySelector('table').appendChild(tbody);

    function sectionRow(title, isImprove){
      const tr = document.createElement('tr');
      tr.className = isImprove ? 'rr-improve-title' : 'rr-section-header';
      tr.innerHTML = `<td colspan="5">${title}</td>`;
      return tr;
    }
    function subHeadRow(isImprove){
      const tr = document.createElement('tr');
      tr.className = isImprove ? 'rr-improve-head' : 'rr-subhead';
      tr.innerHTML = isImprove
        ? `<td>指標</td><td>數值</td><td>建議</td><td>機構評語</td><td>參考區間</td>`
        : `<td>指標</td><td>數值</td><td>說明</td><td>機構評語</td><td>參考區間</td>`;
      return tr;
    }
  }

  // ---------- 交易明細（兩列顯示：進場＋出場） ----------
  function renderTable(report) {
    const { fmtTs, fmtMoney, MULT, FEE, TAX } = window.SHARED;
    const table = $("#tradeTable");

    // thead
    let thead = table.querySelector("thead");
    if (!thead){ thead=document.createElement("thead"); table.appendChild(thead); }
    thead.innerHTML = `
      <tr>
        <td>#</td><td>日期時間</td><td class="num">成交點位</td><td>類別</td>
        <td class="num">點數</td><td class="num">手續費</td><td class="num">交易稅</td>
        <td class="num">理論淨損益</td><td class="num">累積理論淨損益</td>
        <td class="num">實際淨損益(含滑價)</td><td class="num">累積實際淨損益(含滑價)</td>
      </tr>`;

    let tb = table.querySelector("tbody");
    if (!tb){ tb=document.createElement("tbody"); table.appendChild(tb); }
    tb.innerHTML = "";

    let cum=0, cumSlip=0;
    const cls = v => v>0 ? "p-red" : (v<0 ? "p-green" : "");

    report.trades.forEach((t,i)=>{
      // 進場列
      const entryRow = document.createElement("tr");
      entryRow.innerHTML = `
        <td rowspan="2">${i+1}</td>
        <td>${fmtTs(t.pos.tsIn)}</td>
        <td class="num">${t.pos.pIn}</td>
        <td>${t.pos.side==='L' ? '新買' : '新賣'}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
      `;

      // 出場列
      const fee = FEE * 2;
      const tax = Math.round(t.priceOut * MULT * TAX);
      const newCum     = cum     + t.gain;
      const newCumSlip = cumSlip + t.gainSlip;

      const exitRow = document.createElement("tr");
      exitRow.innerHTML = `
        <td>${fmtTs(t.tsOut)}</td>
        <td class="num">${t.priceOut}</td>
        <td>${t.pos.side==='L' ? '平賣' : '平買'}</td>
        <td class="num ${cls(t.pts)}">${t.pts}</td>
        <td class="num">${fmtMoney(fee)}</td>
        <td class="num">${fmtMoney(tax)}</td>
        <td class="num ${cls(t.gain)}">${fmtMoney(t.gain)}</td>
        <td class="num ${cls(newCum)}">${fmtMoney(newCum)}</td>
        <td class="num ${cls(t.gainSlip)}">${fmtMoney(t.gainSlip)}</td>
        <td class="num ${cls(newCumSlip)}">${fmtMoney(newCumSlip)}</td>
      `;

      tb.appendChild(entryRow);
      tb.appendChild(exitRow);

      // 更新累積
      cum = newCum;
      cumSlip = newCumSlip;
    });
  }

  // ---------- 主流程 ----------
  async function handleRaw(raw){
    const { parseTXT, buildReport } = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);
    if(report.trades.length===0){ alert("沒有成功配對的交易"); return; }

    drawChart({
      tsArr:report.tsArr, total:report.total, slipTotal:report.slipCum,
      long:report.longCum, longSlip:report.longSlipCum, short:report.shortCum, shortSlip:report.shortSlipCum
    });

    // === 參數列：改用 TXT 第一行，保留小數 ===
    const firstLine = (raw.split(/\r?\n/)[0] || "").trim();   // 直接抓 TXT 第一行
    $("#paramChip").textContent = tidyParamLine(firstLine) + " ｜ 匯入時間：" + nowStr();

    // KPI
    renderKpiCombined(report.statAll, report.statL, report.statS);

    // 以出場日聚合（含滑價）
    const dailyMap=new Map();
    for(const t of report.trades){ const k=keyFromTs(t.tsOut); dailyMap.set(k,(dailyMap.get(k)||0)+t.gainSlip); }
    const dailySlip=[...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));

    const k=computeRR(dailySlip,report.trades,DEFAULT_NAV,DEFAULT_RF);
    renderRR6Cats(k);
    renderTable(report);
  }

  // 綁定（原樣）
  $("#btn-clip").addEventListener("click", async ()=>{
    try{ const txt=await navigator.clipboard.readText(); handleRaw(txt); }
    catch{ alert("無法讀取剪貼簿內容，請改用「選擇檔案」。"); }
  });
  $("#file").addEventListener("change", async e=>{
    const f=e.target.files[0]; if(!f) return;
    try{ const txt=await window.SHARED.readAsTextAuto(f); await handleRaw(txt); }
    catch(err){ alert(err.message||"讀檔失敗"); }
  });

  // ---------- 通用工具 ----------
  function keyFromTs(ts){ const s=String(ts); return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`; }
  function daysBetween(isoA, isoB){ const a=new Date(isoA+"T00:00:00"), b=new Date(isoB+"T00:00:00"); return Math.round((b-a)/86400000)+1; }
  function monthsBetween(isoA, isoB){ if(!isoA||!isoB) return 1; const a=new Date(isoA+"T00:00:00"), b=new Date(isoB+"T00:00:00"); return Math.max(1,(b.getFullYear()-a.getFullYear())*12 + (b.getMonth()-a.getMonth()) + 1); }
  function tsDiffMin(tsIn, tsOut){
    if(!tsIn||!tsOut) return NaN;
    const d1=new Date(`${tsIn.slice(0,4)}-${tsIn.slice(4,6)}-${tsIn.slice(6,8)}T${tsIn.slice(8,10)}:${tsIn.slice(10,12)}:${tsIn.slice(12,14)||"00"}`);
    const d2=new Date(`${tsOut.slice(0,4)}-${tsOut.slice(4,6)}-${tsOut.slice(6,8)}T${tsOut.slice(8,10)}:${tsOut.slice(10,12)}:${tsOut.slice(12,14)||"00"}`);
    return (d2-d1)/60000;
  }
  const sum=a=>a.reduce((x,y)=>x+y,0);
  const avg=a=>a.length?sum(a)/a.length:0;
  const stdev=a=>{ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
  const median=a=>{ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2? b[m] : (b[m-1]+b[m])/2; };
  function rollingSharpe(ret, win=126, rfDaily=0){
    const out=[]; for(let i=win;i<=ret.length;i++){ const seg=ret.slice(i-win,i); const m=avg(seg)-rfDaily; const v=stdev(seg); out.push(v>0?(m/v)*Math.sqrt(252):0); }
    return out;
  }
  function mean0(a){ return a.length? (a.reduce((x,y)=>x+y,0)/a.length) : 0; }
  function drawdownStats(eq){
    const depths=[]; let peak=-Infinity, trough=Infinity;
    for(const p of eq){
      if(p.nav>peak){ if(peak!==-Infinity && trough<peak) depths.push(peak-trough); peak=p.nav; trough=p.nav; }
      else{ trough=Math.min(trough,p.nav); }
    }
    if(peak!==-Infinity && trough<peak) depths.push(peak-trough);
    return { avgDD: depths.length? avg(depths):0, medDD: depths.length? median(depths):0 };
  }
  function momentSkewKurt(x){
    if(!x.length) return {skew:0,kurt:0};
    const m=avg(x), n=x.length; let m2=0,m3=0,m4=0;
    for(const v of x){ const d=v-m; const d2=d*d; m2+=d2; m3+=d2*d; m4+=d2*d2; }
    m2/=n; m3/=n; m4/=n;
    const skew = m2>0 ? (m3/Math.pow(m2,1.5)) : 0;
    const kurt = m2>0 ? (m4/(m2*m2)) : 0;
    return {skew,kurt};
  }

  // ===== 保持：從第6分頁自動注入 =====
  (function(){
    try{
      const raw = sessionStorage.getItem("starlift_single_inject");
      if(raw){
        const obj = JSON.parse(raw);
        if(obj && obj.text){
          sessionStorage.removeItem("starlift_single_inject"); // 避免重複載入
          handleRaw(obj.text);
        }
      }
    }catch(e){ console.error(e); }
  })();
})();
