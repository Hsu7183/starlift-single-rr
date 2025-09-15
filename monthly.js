/* 分期報告（台指期） period-v2
   - 以「每月第三個週三為結算日，隔日週四起算下一期」劃分期別
   - 總覽圖：柱(期損益)加數值，線(跨期累積) + Max/Min 大點與數值(日期)
   - 下方每期直接展開：每日損益圖 + 交易明細（進/出兩列）
   - 列印時每期自動分頁
*/
(function(){
  const $ = s => document.querySelector(s);
  let topChart;

  // ===== 小工具 =====
  const fmtPct = x => (Number.isFinite(x)? (x*100).toFixed(2) : "0.00")+"%";
  const fmt2   = x => Number(x||0).toFixed(2);
  const comma  = n => (Number(n)||0).toLocaleString("zh-TW");
  const cls    = v => v>0 ? "p-red" : (v<0 ? "p-green" : "");
  const sum    = a => a.reduce((x,y)=>x+y,0);
  const avg    = a => a.length? sum(a)/a.length : 0;
  const stdev  = a => { if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
  const nowStr = ()=>{ const d=new Date(); const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const ymdToDate = ymd => { const s=String(ymd); return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00`); };
  const tsToDate = ts => { const s=String(ts||""); const y=s.slice(0,4),m=Number(s.slice(4,6)),d=Number(s.slice(6,8)); return `${y}/${m}/${d}`; };

  // 第三週三結算 → 期別（key=結算日YYYY-MM-DD，start=前期結算+1日，end=本期結算日）
  function thirdWednesday(year, month){ const d=new Date(year,month-1,1); const add=((3-d.getDay())+7)%7; const firstWed=1+add; return new Date(year,month-1,firstWed+14); }
  function periodKeyFromDate(date){
    const y=date.getFullYear(), m=date.getMonth()+1;
    let settle = thirdWednesday(y,m);
    if(date.getTime() < settle.getTime()){
      const pm=m===1?12:m-1, py=m===1?y-1:y; settle = thirdWednesday(py,pm);
    }
    const prevM = settle.getMonth()===0?12:settle.getMonth();
    const prevY = settle.getMonth()===0?settle.getFullYear()-1:settle.getFullYear();
    const prevSettle = thirdWednesday(prevY, prevM);
    const start = new Date(prevSettle.getTime()+86400000);
    const end   = settle;
    const key   = `${settle.getFullYear()}-${String(settle.getMonth()+1).padStart(2,"0")}-${String(settle.getDate()).padStart(2,"0")}`;
    return {key,start,end};
  }

  // ===== 整段 KPI =====
  function computeOverall(dailySlip,trades,nav=1_000_000,rf=0){
    let cum=0, peak=-Infinity, maxDD=0;
    for(const d of dailySlip){ cum+=d.pnl; const nv=nav+cum; if(nv>peak) peak=nv; else maxDD=Math.max(maxDD,peak-nv); }
    const dailyRet=dailySlip.map(d=>d.pnl/nav);
    const mean=avg(dailyRet), vol=stdev(dailyRet)*Math.sqrt(252);
    const downside=stdev(dailyRet.filter(x=>x<(rf/252)))*Math.sqrt(252);
    const annRet=mean*252;
    const sharpe = vol?((annRet-rf)/vol):0;
    const sortino= downside?((annRet-rf)/downside) : 0;
    const years=Math.max((dailySlip.length||252)/252,1/365);
    const totalPnL=cum, cagr=Math.pow((nav+totalPnL)/nav,1/years)-1;
    const MAR=maxDD? cagr/(maxDD/nav):0;
    const wins=trades.filter(t=>t.gainSlip>0), losses=trades.filter(t=>t.gainSlip<0);
    const winPnL=sum(wins.map(t=>t.gainSlip)), losePnL=Math.abs(sum(losses.map(t=>t.gainSlip)));
    const PF=losePnL? winPnL/losePnL : 0;
    const winRate=trades.length? wins.length/trades.length : 0;
    return {count:trades.length, winRate, totalPnL, maxDD, PF, sharpe, sortino, MAR, annRet, vol};
  }

  // ===== 分期 KPI =====
  function computeByPeriod(trades){
    const groups=new Map();
    for(const t of trades){
      const d=ymdToDate(String(t.tsOut).slice(0,8));
      const {key}=periodKeyFromDate(d);
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const keys=[...groups.keys()].sort();
    const rows=[];
    for(const k of keys){
      const arr=groups.get(k);
      const dayMap=new Map();
      for(const t of arr){ const d=String(t.tsOut).slice(0,8); dayMap.set(d,(dayMap.get(d)||0)+t.gainSlip); }
      const dayPnL=[...dayMap.values()];
      const cum=sum(dayPnL);
      const wins=arr.filter(t=>t.gainSlip>0), losses=arr.filter(t=>t.gainSlip<0);
      const winPnL=sum(wins.map(t=>t.gainSlip)), losePnL=Math.abs(sum(losses.map(t=>t.gainSlip)));
      const PF=losePnL? winPnL/losePnL:0;
      const dailyRet=dayPnL.map(x=>x/1_000_000);
      const mean=avg(dailyRet), vol=stdev(dailyRet)*Math.sqrt(252);
      const downside=stdev(dailyRet.filter(x=>x<0))*Math.sqrt(252);
      const annRet=mean*252;
      const sharpe=vol?annRet/vol:0, sortino=downside?annRet/downside:0;
      const maxDD=Math.max(0,...dayPnL.map(x=>-x));
      const first=ymdToDate([...dayMap.keys()].sort()[0]||String(arr[0].tsOut).slice(0,8));
      const last =ymdToDate([...dayMap.keys()].sort().slice(-1)[0]||String(arr[arr.length-1].tsOut).slice(0,8));
      const days=Math.max(1,Math.round((last-first)/86400000)+1), years=days/365;
      const cagr=Math.pow((1+cum/1_000_000),(1/Math.max(years,1/365)))-1;
      const MAR=maxDD? cagr/(maxDD/1_000_000):0;
      const winRate=arr.length?wins.length/arr.length:0;
      rows.push({period:k, count:arr.length, winRate, totalPnL:cum, maxDD, PF, sharpe, sortino, MAR, annRet, vol,
        _daySeries:[...dayMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([d,p])=>({date:d,pnl:p})),
        _trades:arr
      });
    }
    return rows;
  }

  // ===== 總覽圖 =====
  function drawTopChart(periodRows){
    if(topChart) topChart.destroy();
    const labels=periodRows.map(r=>r.period);
    const bars  =periodRows.map(r=>r.totalPnL);
    const cum=[];let acc=0;bars.forEach(v=>{acc+=v;cum.push(acc);});
    // 找 Max/Min（以 cum 為基準或以 bar? 你要標註「最大獲利期/最大虧損期」，用每期淨利 bar）
    const maxIdx = bars.reduce((iMax,v,i)=> v>(bars[iMax]??-Infinity)? i:iMax, 0);
    const minIdx = bars.reduce((iMin,v,i)=> v<(bars[iMin]?? Infinity)? i:iMin, 0);

    // 自訂插件：柱上/下顯示數字 + Max/Min 大點與標籤
    const labelPlugin = {
      id:"barLabels",
      afterDatasetsDraw(c){
        const {ctx,scales:{x,y}}=c;
        ctx.save(); ctx.font="12px ui-sans-serif,system-ui"; ctx.textBaseline="middle"; ctx.textAlign="center";
        // 第一個 dataset 為柱 (index 0)
        const meta=c.getDatasetMeta(0);
        meta.data.forEach((barEl,i)=>{
          const v=bars[i]; if(!Number.isFinite(v)) return;
          const {x:bx,y:by}=barEl.getProps(['x','y'],true);
          const text=comma(Math.round(v));
          const dy = v>=0 ? -12 : +12;
          ctx.fillStyle = v>=0 ? "#ef4444" : "#10b981";
          ctx.fillText(text, bx, by+dy);
        });

        // Max/Min 點註
        function drawPoint(i,color,text){
          const px = x.getPixelForValue(i);
          const py = y.getPixelForValue(cum[i]);
          ctx.beginPath(); ctx.arc(px,py,6,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
          const pad=6,h=20,w=ctx.measureText(text).width+pad*2, bx=px+12, by=py-h/2;
          // 泡泡
          ctx.fillStyle="rgba(255,255,255,.96)";
          ctx.beginPath(); roundRect(ctx,bx,by,w,h,6); ctx.fill(); ctx.strokeStyle="#111"; ctx.stroke();
          ctx.fillStyle="#111"; ctx.textAlign="left"; ctx.fillText(text,bx+pad,by+h/2);
        }
        const maxText = `${comma(Math.round(bars[maxIdx]))}(${labels[maxIdx]})`;
        const minText = `${comma(Math.round(bars[minIdx]))}(${labels[minIdx]})`;
        drawPoint(maxIdx,"#ef4444",maxText);
        drawPoint(minIdx,"#10b981",minText);
        ctx.restore();
      }
    };

    topChart = new Chart($("#chart"),{
      type:"bar",
      data:{labels,datasets:[
        {type:"bar", label:"每期淨利", data:bars, backgroundColor:bars.map(v=>v>=0?"#ef4444":"#10b981")},
        {type:"line",label:"跨期累積", data:cum,  borderColor:"#111", borderWidth:2, pointRadius:3}
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}, layout:{padding:{right:72}} },
      plugins:[labelPlugin]
    });
  }
  function roundRect(ctx,x,y,w,h,r){ const rr=Math.min(r,w/2,h/2); ctx.moveTo(x+rr,y); ctx.arcTo(x+w,y,x+w,y+h,rr); ctx.arcTo(x+w,y+h,x,y+h,rr); ctx.arcTo(x,y+h,x,y,rr); ctx.arcTo(x,y,x+w,y,rr); ctx.closePath(); }

  // ===== 表格渲染 =====
  function renderTotalTable(tot){
    const tb=$("#totalTable tbody"); tb.innerHTML="";
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td class="num">${tot.count}</td>
      <td class="num">${fmtPct(tot.winRate)}</td>
      <td class="num ${cls(tot.totalPnL)}">${comma(tot.totalPnL)}</td>
      <td class="num">-${comma(tot.maxDD)}</td>
      <td class="num">${fmt2(tot.PF)}</td>
      <td class="num">${fmt2(tot.sharpe)}</td>
      <td class="num">${fmt2(tot.sortino)}</td>
      <td class="num">${fmt2(tot.MAR)}</td>
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
        <td class="num">${fmt2(r.PF)}</td>
        <td class="num">${fmt2(r.sharpe)}</td>
        <td class="num">${fmt2(r.sortino)}</td>
        <td class="num">${fmt2(r.MAR)}</td>
        <td class="num">${fmtPct(r.annRet)}</td>
        <td class="num">${fmtPct(r.vol)}</td>
      `;
      tb.appendChild(tr);
    });
  }

  // ===== 每期詳情（每日圖 + 交易明細） =====
  function renderPeriodDetails(rows){
    const host=$("#periodDetails"); host.innerHTML="";
    rows.forEach((r,idx)=>{
      const block=document.createElement("div");
      block.className="period-block card";
      // 標題
      const title=document.createElement("div");
      title.className="period-title";
      title.textContent=`期別：${r.period}（當期淨利：${comma(r.totalPnL)}，筆數：${r.count}，勝率：${fmtPct(r.winRate)}）`;
      block.appendChild(title);

      // 日圖
      const chartDiv=document.createElement("div");
      chartDiv.className="miniChart";
      const cv=document.createElement("canvas");
      cv.id=`daily-${idx}`;
      chartDiv.appendChild(cv);
      block.appendChild(chartDiv);

      // 明細表
      const tblWrap=document.createElement("div");
      const tbl=document.createElement("table");
      tbl.id=`table-${idx}`;
      tbl.innerHTML=`
        <thead>
          <tr>
            <th>#</th>
            <th>日期時間</th>
            <th class="num">成交點位</th>
            <th>類別</th>
            <th class="num">點數</th>
            <th class="num">手續費</th>
            <th class="num">交易稅</th>
            <th class="num">理論淨損益</th>
            <th class="num">累積理論淨損益</th>
            <th class="num">實際淨損益(含滑價)</th>
            <th class="num">累積實際淨損益(含滑價)</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      tblWrap.appendChild(tbl);
      block.appendChild(tblWrap);

      host.appendChild(block);

      // 繪製日圖
      drawDailyChart(cv, r._daySeries);

      // 填入交易明細（兩列）
      fillTrades(tbl.querySelector("tbody"), r._trades);
    });
  }

  function drawDailyChart(canvas, daySeries){
    const labels = daySeries.map(d=>`${d.date.slice(0,4)}-${d.date.slice(4,6)}-${d.date.slice(6,8)}`);
    const bars   = daySeries.map(d=>d.pnl);
    const cum=[]; let acc=0; bars.forEach(v=>{acc+=v; cum.push(acc);});
    new Chart(canvas,{
      type:"bar",
      data:{labels,datasets:[
        {type:"bar", data:bars, backgroundColor:bars.map(v=>v>=0?"#ef4444":"#10b981")},
        {type:"line",data:cum, borderColor:"#111", borderWidth:2, pointRadius:0}
      ]},
      options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}}
    });
  }

  function fillTrades(tbody, trades){
    const { fmtTs, fmtMoney, MULT, FEE, TAX } = window.SHARED;
    tbody.innerHTML="";
    let cum=0, cumSlip=0;
    const color = v => v>0 ? "p-red" : (v<0 ? "p-green" : "");
    trades.forEach((t,i)=>{
      const fee = FEE*2;
      const tax = Math.round(t.priceOut*MULT*TAX);
      const newCum     = cum + t.gain;
      const newCumSlip = cumSlip + t.gainSlip;

      const entryRow=document.createElement("tr");
      entryRow.innerHTML=`
        <td rowspan="2">${i+1}</td>
        <td>${fmtTs(t.pos.tsIn)}</td>
        <td class="num">${t.pos.pIn}</td>
        <td>${t.pos.side==='L'?'新買':'新賣'}</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
      `;
      const exitRow=document.createElement("tr");
      exitRow.innerHTML=`
        <td>${fmtTs(t.tsOut)}</td>
        <td class="num">${t.priceOut}</td>
        <td>${t.pos.side==='L'?'平賣':'平買'}</td>
        <td class="num ${color(t.pts)}">${t.pts}</td>
        <td class="num">${fee}</td>
        <td class="num">${tax}</td>
        <td class="num ${color(t.gain)}">${fmtMoney(t.gain)}</td>
        <td class="num ${color(newCum)}">${fmtMoney(newCum)}</td>
        <td class="num ${color(t.gainSlip)}">${fmtMoney(t.gainSlip)}</td>
        <td class="num ${color(newCumSlip)}">${fmtMoney(newCumSlip)}</td>
      `;
      tbody.appendChild(entryRow); tbody.appendChild(exitRow);
      cum = newCum; cumSlip = newCumSlip;
    });
  }

  // ===== 主流程 =====
  async function handleRaw(raw){
    const { parseTXT, buildReport, paramsLabel } = window.SHARED;
    const parsed=parseTXT(raw);
    const report=buildReport(parsed.rows);
    if(report.trades.length===0){ alert("沒有交易資料"); return; }

    // 總表資料
    const allDayMap=new Map();
    for(const t of report.trades){ const k=String(t.tsOut).slice(0,8); allDayMap.set(k,(allDayMap.get(k)||0)+t.gainSlip); }
    const allDaily=[...allDayMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));
    const total = computeOverall(allDaily, report.trades);

    // 分期
    const perRows = computeByPeriod(report.trades);

    // 畫圖、表格
    drawTopChart(perRows);
    renderTotalTable(total);
    renderPeriodTable(perRows);
    renderPeriodDetails(perRows);

    // 頂部 chip
    $("#paramChip").textContent = paramsLabel(parsed.params);
    $("#importAt").textContent  = nowStr();
  }

  // 綁定
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
