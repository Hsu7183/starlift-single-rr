/* 單檔頁面：6 線圖 + 三行KPI + Risk-Return 六大類（5欄對齊＋紅綠顯示＋機構評語＋建議調整） */
(function () {
  const $ = s => document.querySelector(s);
  const DEFAULT_NAV = Number(new URLSearchParams(location.search).get("nav")) || 1_000_000;
  const DEFAULT_RF  = Number(new URLSearchParams(location.search).get("rf"))  || 0.00;

  // 樣式（只注入一次）
  (function injectStyle(){
    if (document.getElementById("rr-style")) return;
    const css = `
      .rr-good{ font-weight:800; color:#111; }
      .rr-bad { font-weight:800; color:#ef4444; }
      .rr-line{ white-space:pre; font:14px/1.8 ui-monospace,Consolas,Menlo,monospace; }
      .p-red  { color:#ef4444; font-weight:700; }
      .p-green{ color:#10b981; font-weight:700; }
    `;
    const style = document.createElement("style");
    style.id = "rr-style"; style.textContent = css;
    document.head.appendChild(style);
  })();

  let chart;

  // ===== 圖表 =====
  function drawChart(ser) {
    if (chart) chart.destroy();
    const { tsArr, total, slipTotal, long, longSlip, short, shortSlip } = ser;
    const labels = tsArr.map((_, i) => i);
    const mkSolid=(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0});
    const mkDash =(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0,borderDash:[6,4]});
    chart = new Chart($("#chart"), {
      type:"line",
      data:{labels,datasets:[
        mkSolid(slipTotal,"#111",3.5),   mkDash(total,"#9aa",2),
        mkSolid(longSlip,"#d32f2f",3),   mkDash(long,"#ef9a9a",2),
        mkSolid(shortSlip,"#2e7d32",3),  mkDash(short,"#a5d6a7",2)
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
    });
  }

  // ===== 三行 KPI（保留原樣） =====
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

  // ===== 交易明細（點數/獲利/累積欄位紅綠顯示） =====
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
        <td>${fmtTs(t.pos.tsIn)}</td><td>${t.pos.pIn}</td><td>${t.pos.side==='L'?'新買':'新賣'}</td>
        <td class="${cls(t.pts)}">—</td><td>—</td><td>—</td>
        <td class="${cls(t.gain)}">—</td><td class="${cls(cum)}">—</td>
        <td class="${cls(t.gainSlip)}">—</td><td class="${cls(cumSlip)}">—</td>`;
      const tr2=document.createElement("tr");
      tr2.innerHTML=`
        <td>${fmtTs(t.tsOut)}</td><td>${t.priceOut}</td><td>${t.pos.side==='L'?'平賣':'平買'}</td>
        <td class="${cls(t.pts)}">${t.pts}</td><td>${FEE*2}</td><td>${Math.round(t.priceOut*MULT*TAX)}</td>
        <td class="${cls(t.gain)}">${fmtMoney(t.gain)}</td><td class="${cls(cum)}">${fmtMoney(cum)}</td>
        <td class="${cls(t.gainSlip)}">${fmtMoney(t.gainSlip)}</td><td class="${cls(cumSlip)}">${fmtMoney(cumSlip)}</td>`;
      tb.appendChild(tr1); tb.appendChild(tr2);
    });
  }

  // ===== Risk-Return 計算（全部以含滑價 gainSlip） =====
  function computeRR(dailySlip,trades,nav=DEFAULT_NAV,rf=DEFAULT_RF){
    // 權益曲線與回撤
    let cum=0; const eq=dailySlip.map(d=>({date:d.date,nav:(cum+=d.pnl,nav+cum)}));
    let peak=-Infinity,maxDD=0,curTUW=0,maxTUW=0,inDraw=false,rec=0,curRec=0;
    for(const p of eq){
      if(p.nav>peak){ peak=p.nav; if(inDraw){ rec=Math.max(rec,curRec); inDraw=false; } curTUW=0; curRec=0; }
      else{ const dd=peak-p.nav; if(dd>maxDD){ maxDD=dd; inDraw=true; curRec=0; } curTUW++; curRec++; maxTUW=Math.max(maxTUW,curTUW); }
    }

    // 報酬序列（以 NAV 作分母）
    const dailyRet=dailySlip.map(d=>d.pnl/nav);
    const mean=avg(dailyRet), vol=stdev(dailyRet)*Math.sqrt(252);
    const downside=stdev(dailyRet.filter(x=>x<(rf/252)))*Math.sqrt(252);

    // 年化與期望值
    const start=dailySlip[0]?.date, end=dailySlip[dailySlip.length-1]?.date;
    const dayCnt=start&&end? daysBetween(start,end) : 252;
    const years=Math.max(dayCnt/365,1/365);
    const totalPnL=dailySlip.reduce((a,b)=>a+b.pnl,0);
    const cagr=Math.pow((nav+totalPnL)/nav,1/years)-1;
    const annRet=mean*252;
    const sharpe = vol>0      ? ((annRet-DEFAULT_RF)/vol)      : 0;
    const sortino= downside>0 ? ((annRet-DEFAULT_RF)/downside) : 0;
    const MAR = maxDD>0 ? (cagr/(maxDD/nav)) : 0;

    // VaR / ES（歷史模擬）
    const q =(arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const i=Math.floor((1-p)*a.length); return a[Math.max(0,Math.min(i,a.length-1))]||0; };
    const ES=(arr,p)=>{ const a=[...arr].sort((x,y)=>x-y); const cut=Math.floor((1-p)*a.length); const sl=a.slice(0,cut); return sl.length? -(sl.reduce((x,y)=>x+y,0)/sl.length)*nav : 0; };
    const var95=Math.abs(q(dailyRet,0.05))*nav, var99=Math.abs(q(dailyRet,0.01))*nav;
    const es95 =Math.abs(ES(dailyRet,0.95)),     es99 =Math.abs(ES(dailyRet,0.99));

    // 交易層
    const wins=trades.filter(t=>t.gainSlip>0), losses=trades.filter(t=>t.gainSlip<0);
    const winPnL=wins.reduce((a,b)=>a+b.gainSlip,0), losePnL=losses.reduce((a,b)=>a+b.gainSlip,0);
    const PF=Math.abs(losePnL)? winPnL/Math.abs(losePnL) : 0;
    const avgWin=wins.length? winPnL/wins.length : 0, avgLoss=losses.length? Math.abs(losePnL/losses.length) : 0;
    const payoff=avgLoss? avgWin/avgLoss : 0, winRate=trades.length? wins.length/trades.length : 0;
    const expectancy=trades.length? totalPnL/trades.length : 0;

    // 連勝/連敗、極值、持倉、頻率
    let maxWS=0,maxLS=0,curW=0,curL=0;
    for(const t of trades){ if(t.gainSlip>0){ curW++; maxWS=Math.max(maxWS,curW); curL=0; }
      else if(t.gainSlip<0){ curL++; maxLS=Math.max(maxLS,curL); curW=0; } else{ curW=0; curL=0; } }
    const byDaySlip=(()=>{ const m=new Map(); for(const t of trades){ const d=keyFromTs(t.tsOut); m.set(d,(m.get(d)||0)+t.gainSlip); } return [...m.values()]; })();
    const maxDailyLoss=Math.abs(Math.min(0,...byDaySlip)), maxDailyGain=Math.max(0,...byDaySlip,0);
    const maxTradeLoss=Math.abs(Math.min(0,...trades.map(t=>t.gainSlip))), maxTradeGain=Math.max(0,...trades.map(t=>t.gainSlip),0);
    const holdMinsArr=trades.map(t=>tsDiffMin(t.pos.tsIn,t.tsOut)).filter(Number.isFinite);
    const avgHoldingMins=holdMinsArr.length? avg(holdMinsArr) : 0;
    const months=Math.max(1, monthsBetween(start,end));
    const tradesPerMonth=trades.length/months;

    // 滾動 Sharpe（6M ≈126d）中位數
    const rollSharpe=rollingSharpe(dailyRet,126,DEFAULT_RF/252), rollSharpeMed=rollSharpe.length? median(rollSharpe) : 0;

    return { totalPnL,cagr,annRet,winRate,expectancy,
      maxDD,maxTUW:Math.round(maxTUW),recovery:Math.round(rec),
      vol,downside,var95,var99,es95,es99,
      maxDailyLoss,maxDailyGain,maxTradeLoss,maxTradeGain,
      sharpe,sortino,MAR,PF,payoff,avgWin,avgLoss,maxWS,maxLS,avgHoldingMins,tradesPerMonth,rollSharpeMed };
  }

  // ===== 〈建議調整指標〉＋ 六大類輸出（5欄對齊＋分級著色） =====
  function renderRR6Cats(k){
    const NAV=DEFAULT_NAV;
    const money =n=>(Number(n)||0).toLocaleString("zh-TW");
    const pmoney=n=>(Number(n)>0?"":"-")+money(Math.abs(Number(n)||0));
    const pct2  =x=>(Number.isFinite(x)?(x*100).toFixed(2):"0.00")+"%";
    const fix2  =x=>Number(x).toFixed(2);
    const gradeWord=x=>x==='good'?'→ Strong':(x==='bad'?'→ Improve':'→ Adequate');

    // 分級器（回傳 [grade, comment, benchmark]）
    const g={
      cagr:v=> v>=0.30?['good','年化極佳','≥30%'] : v>=0.15?['good','年化穩健','≥15%'] : v>=0.05?['ok','尚可','≥5%'] : ['bad','偏低','—'],
      ann :v=> v>=0.25?['good','年化報酬優秀','≥25%'] : v>=0.10?['ok','尚可','≥10%'] : ['bad','偏低','—'],
      exp :v=> v>0?['good','每筆期望為正','>0'] : ['bad','未覆蓋交易成本','>0'],
      hit :(v,po)=> v>=0.45?['good','勝率偏高','≥45%'] : (v<0.30&&po<1.5?['bad','低勝率且盈虧比偏低','—'] : ['ok','需與盈虧比搭配','—']),
      mdd :v=> (Math.abs(v)/NAV)<=0.15?['good','回撤控制良好','≤15%NAV']:(Math.abs(v)/NAV)<=0.25?['ok','可接受','≤25%NAV']:['bad','偏大','—'],
      tuw :v=> v<=60?['good','水下短','≤60天']:v<=120?['ok','可接受','≤120天']:['bad','偏長','—'],
      rec :v=> v<=45?['good','回本快','≤45天']:v<=90?['ok','可接受','≤90天']:['bad','偏慢','—'],
      vol :v=> v<=0.15?['good','波動在常見區間','8%~15%'] : v<=0.25?['ok','略高','≤25%'] : ['bad','偏高，建議降槓桿','—'],
      ddev:v=> v<=0.10?['good','下行控制佳','≤10%'] : v<=0.15?['ok','尚可','≤15%'] : ['bad','偏高','—'],
      var95:v=> (v/NAV)<=0.03?['good','≤3%NAV','≤3%NAV'] : (v/NAV)<=0.05?['ok','3–5%','≤5%NAV'] : ['bad','>5%','—'],
      es95 :v=> (v/NAV)<=0.025?['good','≤2.5%NAV','≤2.5%NAV'] : (v/NAV)<=0.04?['ok','2.5–4%','≤4%NAV'] : ['bad','>4%','—'],
      var99:v=> (v/NAV)<=0.05?['good','≤5%NAV','≤5%NAV'] : (v/NAV)<=0.08?['ok','5–8%','≤8%NAV'] : ['bad','>8%','—'],
      es99 :v=> (v/NAV)<=0.035?['good','≤3.5%NAV','≤3.5%NAV'] : (v/NAV)<=0.06?['ok','3.5–6%','≤6%NAV'] : ['bad','>6%','—'],
      maxDayLoss:v=> (v/NAV)<=0.04?['good','尾部可控','≤4%NAV'] : (v/NAV)<=0.06?['ok','尚可','≤6%NAV'] : ['bad','偏高','—'],
      sharpe:v=> v>=2?['good','>2 佳','≥2'] : v>=1.5?['good','>1.5 穩健','≥1.5'] : v>=1?['ok','>1 可接受','≥1'] : ['bad','需提升','—'],
      sortino:v=> v>=2?['good','>2 佳','≥2'] : v>=1.5?['good','>1.5 穩健','≥1.5'] : v>=1?['ok','>1 可接受','≥1'] : ['bad','需提升','—'],
      mar :v=> v>=2?['good','>2 佳','≥2'] : v>=1.5?['good','>1.5 穩健','≥1.5'] : v>=1?['ok','>1 可接受','≥1'] : ['bad','需提升','—'],
      pf  :v=> v>=2?['good','>2 很好','≥2'] : v>=1.5?['ok','>1.5 尚可','≥1.5'] : ['bad','偏低','—'],
      payoff:v=> v>=2?['good','盈虧比高','≥2'] : v>=1.5?['ok','尚可','≥1.5'] : ['bad','偏低','—'],
      maxLS:v=> v<=8?['good','連敗可承受','≤8'] : v<=12?['ok','需資金/心理控管','≤12'] : ['bad','偏長，建議加 MAE 快停','—'],
      roll:v=> v>=1.5?['good','時間穩定性佳','≥1.5'] : v>=1?['ok','可接受','≥1'] : ['bad','穩健性不足','—'],
    };

    // 行資料：每行 5 欄（title, value, desc, eval, bench, grade）
    const rows = [];
    const pushHeader = (title) => rows.push({ header:true, title });
    const push = (title, val, desc, [grade, comment, bench]) => {
      rows.push({ header:false, cols:[title, val, desc, `機構評語：${gradeWord(grade)}${comment? '，'+comment : ''}`, (bench||'—')], grade });
    };

    // 〈建議調整指標〉（先收集 Improve 條目）
    const badLines = [];

    // 一、報酬（Return）
    pushHeader("〈建議調整指標〉（Improve 彙總）");
    // 真正內容稍後填入（等全部 rows 完成後彙整 badLines 再覆蓋）
    rows.push({ placeholderImprove:true });

    pushHeader("一、報酬（Return）");
    const e1 = k.totalPnL>0?['good','報酬為正','—']:['bad','淨損益為負','—'];
    push("總報酬（Total Return）",  money(k.totalPnL),     "回測累積淨損益（含手續費/稅/滑價）", e1);
    collectBad("總報酬", e1);

    const e2 = g.cagr(k.cagr);      push("CAGR（年化複利）",       pct2(k.cagr),          "以 NAV 為分母，依實際天數年化",        e2); collectBad("CAGR", e2);
    const e3 = g.exp(k.expectancy); push("平均每筆（Expectancy）", money(k.expectancy),    "每筆平均淨損益（含滑價）",            e3); collectBad("平均每筆", e3);
    const e4 = g.ann(k.annRet);     push("年化報酬（Arithmetic）", pct2(k.annRet),         "日均報酬 × 252",                      e4); collectBad("年化報酬", e4);
    const e5 = g.hit(k.winRate,k.payoff); push("勝率（Hit Ratio）", pct2(k.winRate),        "獲利筆數 ÷ 總筆數",                   e5); collectBad("勝率", e5);

    // 二、風險（Risk）
    pushHeader("二、風險（Risk）");
    const r1 = g.mdd(k.maxDD);   push("最大回撤（MaxDD）",      pmoney(-k.maxDD),       "峰值到谷值最大跌幅（以金額）",        r1); collectBad("MaxDD", r1);
    const r2 = g.tuw(k.maxTUW);  push("水下時間（TUW）",        String(k.maxTUW),       "在水下的最長天數",                    r2); collectBad("TUW", r2);
    const r3 = g.rec(k.recovery);push("回本時間（Recovery）",    String(k.recovery),     "自 MDD 末端至再創新高的天數",          r3); collectBad("回本時間", r3);
    const r4 = g.vol(k.vol);     push("波動率（Volatility）",    pct2(k.vol),            "日報酬標準差 × √252",                 r4); collectBad("波動率", r4);
    const r5 = g.ddev(k.downside);push("下行波動（Downside Dev）",pct2(k.downside),       "只計下行（供 Sortino）",              r5); collectBad("下行波動", r5);
    const r6 = g.var95(k.var95); push("VaR 95%",                pmoney(-k.var95),       "單日 95% 置信最大虧損（金額）",        r6); collectBad("VaR95", r6);
    const r7 = g.es95(k.es95);   push("ES 95%（CVaR）",          pmoney(-k.es95),        "落於 VaR95 之後的平均虧損",           r7); collectBad("ES95", r7);
    const r8 = g.var99(k.var99); push("VaR 99%",                pmoney(-k.var99),       "單日 99% 置信最大虧損（金額）",        r8); collectBad("VaR99", r8);
    const r9 = g.es99(k.es99);   push("ES 99%（CVaR）",          pmoney(-k.es99),        "落於 VaR99 之後的平均虧損",           r9); collectBad("ES99", r9);
    const r10= g.maxDayLoss(k.maxDailyLoss); push("單日最大虧損", pmoney(-k.maxDailyLoss),"樣本期間最糟的一天",                   r10);collectBad("單日最大虧損", r10);
    push("單日最大獲利",            money(k.maxDailyGain),       "樣本期間最佳的一天",                 ['ok','—','—']);
    push("單筆最大虧損",            pmoney(-k.maxTradeLoss),     "樣本期間最糟的一筆交易",             ['ok','—','—']);
    push("單筆最大獲利",            money(k.maxTradeGain),       "樣本期間最佳的一筆交易",             ['ok','—','—']);

    // 三、風險調整
    pushHeader("三、風險調整報酬（Risk-Adjusted Return）");
    const a1 = g.sharpe(k.sharpe); push("Sharpe（夏普）", fix2(k.sharpe), "（年化報酬 − rf）／年化波動", a1); collectBad("Sharpe", a1);
    const a2 = g.sortino(k.sortino);push("Sortino（索提諾）", fix2(k.sortino), "只懲罰下行波動", a2); collectBad("Sortino", a2);
    const a3 = g.mar(k.MAR);      push("MAR",           fix2(k.MAR),    "CAGR ÷ |MDD|（CTA 常用）", a3); collectBad("MAR", a3);
    const a4 = g.pf(k.PF);        push("PF（獲利因子）",fix2(k.PF),     "總獲利 ÷ 總虧損（含成本/滑價）", a4); collectBad("PF", a4);

    // 四、交易結構
    pushHeader("四、交易結構與執行品質（Trade-Level & Execution）");
    const t1 = g.payoff(k.payoff); push("盈虧比（Payoff）", fix2(k.payoff), "平均獲利 ÷ 平均虧損", t1); collectBad("Payoff", t1);
    push("平均獲利單",              money(k.avgWin),        "含滑價的平均獲利金額", ['ok','—','≥平均虧損單']);
    push("平均虧損單",              pmoney(-k.avgLoss),     "含滑價的平均虧損金額", ['ok','—','—']);
    push("最大連勝",               String(k.maxWS),         "連續獲利筆數",       ['ok','—','—']);
    const t2 = g.maxLS(k.maxLS);   push("最大連敗",         String(k.maxLS),       "連續虧損筆數",   t2); collectBad("最大連敗", t2);
    push("平均持倉時間",            `${k.avgHoldingMins.toFixed(2)} 分`, "tsIn→tsOut 的平均分鐘數", ['ok','—','—']);
    push("交易頻率",                `${k.tradesPerMonth.toFixed(2)} 筆/月`, "以回測期間月份估算",    ['ok','—','—']);

    // 五、穩健性
    pushHeader("五、穩健性與可複製性（Robustness & Statistical Soundness）");
    const s1 = g.roll(k.rollSharpeMed); push("滾動 Sharpe（6個月中位）", fix2(k.rollSharpeMed), "126 交易日窗的 Sharpe 中位數", s1); collectBad("滾動Sharpe", s1);
    push("樣本外（OOS）", "—", "需提供 OOS 資料後評估", ['ok','—','—']);
    push("參數敏感度", "—", "需做 ±10~20% 擾動測試", ['ok','—','—']);
    push("Regime 分析", "—", "需標註趨勢/震盪、高/低波動區間", ['ok','—','—']);

    // 六、風險用量與容量
    pushHeader("六、風險用量、槓桿與容量（Risk Usage, Leverage & Capacity）");
    push("槓桿（Leverage）", "—", "需名目曝險/權益資料", ['ok','—','—']);
    push("風險貢獻（Risk Contribution）", "—", "需多資產/子策略分解", ['ok','—','—']);
    push("容量/流動性（Capacity）", "—", "需市場量與參與率/衝擊估計", ['ok','—','—']);

    // 生成 〈建議調整指標〉 區塊
    const improveBlock = buildImproveBlock(badLines);
    // 把 placeholderImprove 替換成實際內容
    const phIndex = rows.findIndex(r=>r.placeholderImprove);
    rows.splice(phIndex, 1, ...improveBlock);

    // 5欄對齊
    const dataRows = rows.filter(r=>!r.header);
    const widths=[0,0,0,0,0]; // title, val, desc, eval, bench
    dataRows.forEach(r=>r.cols.forEach((c,i)=>{ widths[i]=Math.max(widths[i], String(c).length); }));
    const pad=(s,w)=>String(s).padEnd(w," ");
    const bar=" ｜ ";
    const html = rows.map(r=>{
      if(r.header) return `<div class="rr-line"><b>${r.title}</b></div>`;
      const txt = `${pad(r.cols[0],widths[0])}${bar}${pad(r.cols[1],widths[1])}${bar}${pad(r.cols[2],widths[2])}${bar}${pad(r.cols[3],widths[3])}${bar}${pad(r.cols[4],widths[4])}`;
      const cls = r.grade==='bad' ? 'rr-line rr-bad' : (r.grade==='good' ? 'rr-line rr-good' : 'rr-line');
      return `<div class="${cls}">${txt}</div>`;
    }).join("\n");

    $("#rrLines").innerHTML = html;

    function collectBad(name, tuple){
      if(tuple && tuple[0]==='bad'){
        badLines.push([name, tuple[1] || '需改善', tuple[2] || '—']);
      }
    }
    function buildImproveBlock(items){
      if(!items.length) return [{header:false, cols:['（目前無紅色指標）','','','',''], grade:'ok'}];
      const lines = items.map(([n,why,bench])=>{
        return {header:false, cols:[`• ${n}`, '', '建議優化', `機構評語：${gradeWord('bad')}，${why}`, bench], grade:'bad'};
      });
      return lines;
    }
  }

  // ===== 主流程 =====
  async function handleRaw(raw){
    const { parseTXT, buildReport, paramsLabel } = window.SHARED;
    const parsed = parseTXT(raw);
    const report = buildReport(parsed.rows);
    if(report.trades.length===0){ alert("沒有成功配對的交易"); return; }

    // 圖與三行 KPI
    drawChart({
      tsArr:report.tsArr, total:report.total, slipTotal:report.slipCum,
      long:report.longCum, longSlip:report.longSlipCum, short:report.shortCum, shortSlip:report.shortSlipCum
    });
    const [lineAll,lineL,lineS]=buildKpiLines(report.statAll,report.statL,report.statS);
    $("#paramChip").textContent=paramsLabel(parsed.params);
    $("#kpiAll").textContent=lineAll; $("#kpiL").textContent=lineL; $("#kpiS").textContent=lineS;

    // 以出場日聚合（含滑價）
    const dailyMap=new Map();
    for(const t of report.trades){ const key=keyFromTs(t.tsOut); dailyMap.set(key,(dailyMap.get(key)||0)+t.gainSlip); }
    const dailySlip=[...dailyMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));

    // 計算與輸出
    const k=computeRR(dailySlip,report.trades,DEFAULT_NAV,DEFAULT_RF);
    renderRR6Cats(k);
    renderTable(report);
  }

  // 綁定事件
  $("#btn-clip").addEventListener("click", async ()=>{
    try{ const txt = await navigator.clipboard.readText(); handleRaw(txt); }
    catch{ alert("無法讀取剪貼簿內容，請改用「選擇檔案」。"); }
  });
  $("#file").addEventListener("change", async e=>{
    const f=e.target.files[0]; if(!f) return;
    try{ const txt=await window.SHARED.readAsTextAuto(f); await handleRaw(txt); }
    catch(err){ alert(err.message||"讀檔失敗"); }
  });

  // ===== 工具 =====
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
})();
