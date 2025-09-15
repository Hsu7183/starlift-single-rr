/* 分期報告（台指期） period-v1
   - 以「每月第三個週三為結算日，隔日週四起算下一期」劃分期別
   - (1) 控制列、(2) 中間圖表：每期淨利 + 跨期累積
   - (3) 下方表格：總表 KPI（整段） + 分期對比
*/
(function(){
  const $ = s => document.querySelector(s);
  let chart;

  // ===== 小工具 =====
  const fmtPct=x=>(Number.isFinite(x)?(x*100).toFixed(2):"0.00")+"%";
  const comma=n=>(Number(n)||0).toLocaleString("zh-TW");
  const cls=v=>v>0?"p-red":(v<0?"p-green":"");
  const sum=a=>a.reduce((x,y)=>x+y,0);
  const avg=a=>a.length?sum(a)/a.length:0;
  const stdev=a=>{ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
  const nowStr=()=>{ const d=new Date(); const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

  // 日期字串 YYYYMMDD 轉 Date（本地時區）
  function ymdToDate(ymd){
    const s=String(ymd); return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00`);
  }
  // 給定年/月，回傳當月第三個週三（結算日）
  function thirdWednesday(year, month){ // month: 1~12
    const d=new Date(year, month-1, 1);
    // 找第一個週三
    const add=((3 - d.getDay()) + 7) % 7; // 0=日,3=三
    const firstWed = 1 + add;
    const thirdWed = firstWed + 14;
    return new Date(year, month-1, thirdWed);
  }
  // 找「tsOut 所在期別的結算日」（該月第三個週三），並回傳期別 key 與期別起訖（起：前一期結算+1天；迄：本期結算日）
  function periodKeyFromDate(date){ // Date
    const y=date.getFullYear(), m=date.getMonth()+1;
    const settle = thirdWednesday(y,m); // 本月結算（三）
    // 若當前日期 > settle（含當天結算後也算本期，因交易到結算日止），則本期=當月；否則本期=上月
    let periodSettle = settle;
    if(date.getTime() < settle.getTime()){ // 還沒到結算，屬於上期
      // 上一月
      const pm = m===1?12:m-1, py = m===1? y-1 : y;
      periodSettle = thirdWednesday(py, pm);
    }
    // 找上期結算日
    const prevM = periodSettle.getMonth()===0?12:periodSettle.getMonth();
    const prevY = periodSettle.getMonth()===0?periodSettle.getFullYear()-1:periodSettle.getFullYear();
    const prevSettle = thirdWednesday(prevY, prevM);
    // 起訖（日）
    const start = new Date(prevSettle.getTime() + 24*3600*1000); // 上期結算隔天
    const end   = periodSettle;                                   // 本期結算日（含當天）
    const key   = `${periodSettle.getFullYear()}-${String(periodSettle.getMonth()+1).padStart(2,"0")}-${String(periodSettle.getDate()).padStart(2,"0")}`;
    return {key, start, end};
  }
  // 取 YYYY-MM 格式
  function ymd(date){ return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }

  // ===== 計算整段 KPI（總表） =====
  function computeOverall(dailySlip, trades, nav=1_000_000, rf=0){
    let cum=0, peak=-Infinity, maxDD=0;
    for(const d of dailySlip){ cum+=d.pnl; const nv=nav+cum; if(nv>peak) peak=nv; else maxDD=Math.max(maxDD,peak-nv); }
    const dailyRet=dailySlip.map(d=>d.pnl/nav);
    const mean=avg(dailyRet), vol=stdev(dailyRet)*Math.sqrt(252);
    const downside=stdev(dailyRet.filter(x=>x<(rf/252)))*Math.sqrt(252);
    const annRet=mean*252;
    const sharpe = vol?((annRet-rf)/vol):0;
    const sortino= downside?((annRet-rf)/downside):0;
    // 粗略年數
    const years=Math.max((dailySlip.length||252)/252,1/365);
    const totalPnL=cum, cagr=Math.pow((nav+totalPnL)/nav,1/years)-1;
    const MAR=maxDD? cagr/(maxDD/nav):0;
    const wins=trades.filter(t=>t.gainSlip>0), losses=trades.filter(t=>t.gainSlip<0);
    const winPnL=sum(wins.map(t=>t.gainSlip)), losePnL=Math.abs(sum(losses.map(t=>t.gainSlip)));
    const PF=losePnL? winPnL/losePnL : 0;
    const winRate = trades.length? wins.length/trades.length : 0;
    return {count:trades.length, winRate, totalPnL, maxDD, PF, sharpe, sortino, MAR, annRet, vol};
  }

  // ===== 計算分期 =====
  function computeByPeriod(trades){
    // 依期別分組（用 tsOut）
    const groups = new Map(); // key=到期結算日(YYYY-MM-DD)
    for(const t of trades){
      const d = ymdToDate(String(t.tsOut).slice(0,8));
      const {key} = periodKeyFromDate(d);
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    // 每期：用出場「日」聚合為日損益，再算 KPI
    const out=[];
    const sortedKeys = [...groups.keys()].sort(); // 時序
    for(const k of sortedKeys){
      const arr = groups.get(k);
      // 日損益（含滑價）
      const dayMap=new Map();
      for(const t of arr){
        const d=String(t.tsOut).slice(0,8);
        dayMap.set(d,(dayMap.get(d)||0)+t.gainSlip);
      }
      const dayPnL=[...dayMap.values()];
      const cum=sum(dayPnL);
      const wins=arr.filter(t=>t.gainSlip>0), losses=arr.filter(t=>t.gainSlip<0);
      const winPnL=sum(wins.map(t=>t.gainSlip)), losePnL=Math.abs(sum(losses.map(t=>t.gainSlip)));
      const PF=losePnL? winPnL/losePnL:0;
      const dailyRet=dayPnL.map(x=>x/1_000_000);
      const mean=avg(dailyRet), vol=stdev(dailyRet)*Math.sqrt(252);
      const downside=stdev(dailyRet.filter(x=>x<0))*Math.sqrt(252);
      const annRet=mean*252;
      const sharpe=vol?annRet/vol:0;
      const sortino=downside?annRet/downside:0;
      const maxDD=Math.max(0,...(dayPnL.map(x=>-x)));
      // 期長度（天）→ 粗略換算年數再取 CAGR / MAR（期內）
      const firstDay = ymdToDate([...dayMap.keys()].sort()[0]||String(arr[0].tsOut).slice(0,8));
      const lastDay  = ymdToDate([...dayMap.keys()].sort().slice(-1)[0]||String(arr[arr.length-1].tsOut).slice(0,8));
      const days = Math.max(1, Math.round((lastDay-firstDay)/86400000)+1);
      const years = days/365;
      const cagr = Math.pow((1+cum/1_000_000),(1/Math.max(years,1/365))) - 1;
      const MAR = maxDD? cagr/(maxDD/1_000_000) : 0;
      const winRate = arr.length? wins.length/arr.length : 0;
      out.push({period:k, count:arr.length, winRate, totalPnL:cum, maxDD, PF, sharpe, sortino, MAR, annRet, vol});
    }
    return out;
  }

  // ===== 繪圖 =====
  function drawChart(periodRows){
    if(chart) chart.destroy();
    const labels = periodRows.map(r=>r.period);
    const bar    = periodRows.map(r=>r.totalPnL);
    const cum=[]; let acc=0; periodRows.forEach(r=>{acc+=r.totalPnL; cum.push(acc);});

    chart=new Chart($("#chart"),{
      type:"bar",
      data:{labels,datasets:[
        {type:"bar",label:"當期淨利",data:bar,backgroundColor:bar.map(v=>v>=0?"#ef4444":"#10b981")},
        {type:"line",label:"跨期累積",data:cum,borderColor:"#111",borderWidth:2,pointRadius:2}
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
    });
  }

  // ===== 表格渲染 =====
  function renderTotalTable(tot){
    const tb=$("#totalTable tbody"); tb.innerHTML="";
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td class="num">${tot.count}</td>
      <td class="num">${fmtPct(tot.winRate)}</td>
      <td class="num ${cls(tot.totalPnL)}">${comma(tot.totalPnL)}</td>
      <td class="num">-${comma(tot.maxDD)}</td>
      <td class="num">${(tot.PF||0).toFixed(2)}</td>
      <td class="num">${(tot.sharpe||0).toFixed(2)}</td>
      <td class="num">${(tot.sortino||0).toFixed(2)}</td>
      <td class="num">${(tot.MAR||0).toFixed(2)}</td>
      <td class="num">${fmtPct(tot.annRet)}</td>
      <td class="num">${fmtPct(tot.vol)}</td>
    `;
    tb.appendChild(tr);
  }
  function renderPeriodTable(rows){
    const tb=$("#periodTable tbody"); tb.innerHTML="";
    rows.forEach(r=>{
      const tr=document.createElement("tr");
      tr.innerHTML=`
        <td>${r.period}</td>
        <td class="num">${r.count}</td>
        <td class="num">${fmtPct(r.winRate)}</td>
        <td class="num ${cls(r.totalPnL)}">${comma(r.totalPnL)}</td>
        <td class="num">-${comma(r.maxDD)}</td>
        <td class="num">${(r.PF||0).toFixed(2)}</td>
        <td class="num">${(r.sharpe||0).toFixed(2)}</td>
        <td class="num">${(r.sortino||0).toFixed(2)}</td>
        <td class="num">${(r.MAR||0).toFixed(2)}</td>
        <td class="num">${fmtPct(r.annRet)}</td>
        <td class="num">${fmtPct(r.vol)}</td>
      `;
      tb.appendChild(tr);
    });
  }

  // ===== 主流程 =====
  async function handleRaw(raw){
    const { parseTXT, buildReport, paramsLabel } = window.SHARED;
    const parsed=parseTXT(raw);
    const report=buildReport(parsed.rows);
    if(report.trades.length===0){ alert("沒有交易資料"); return; }

    // 總表（整段）
    // 以日聚合（含滑價）
    const allDayMap=new Map();
    for(const t of report.trades){ const k=String(t.tsOut).slice(0,8); allDayMap.set(k,(allDayMap.get(k)||0)+t.gainSlip); }
    const allDaily=[...allDayMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));
    const total = computeOverall(allDaily, report.trades);

    // 分期
    const perRows = computeByPeriod(report.trades);

    drawChart(perRows);
    renderTotalTable(total);
    renderPeriodTable(perRows);

    $("#paramChip").textContent = paramsLabel(parsed.params);
    $("#importAt").textContent = nowStr();
  }

  // ===== 綁定 =====
  $("#btn-clip").addEventListener("click", async ()=>{
    try{ const txt=await navigator.clipboard.readText(); await handleRaw(txt); }
    catch{ alert("無法讀取剪貼簿內容，請改用「選擇檔案」。"); }
  });
  $("#file").addEventListener("change", async e=>{
    const f=e.target.files[0]; if(!f) return;
    try{ const txt=await window.SHARED.readAsTextAuto(f); await handleRaw(txt); }
    catch(err){ alert(err.message||"讀檔失敗"); }
  });
})();
