/* 分期報告（台指期） period-v3
   - 期別定義：本月第三週「星期四」起 → 下月第三週「星期三」止（含週三）
   - 總覽圖：柱(期損益)加數值，線(跨期累積) + Max/Min 大點與「數值(期別起迄)」
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
  const fmtDate = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;

  // === 第三週三 / 第三週四 ===
  function thirdWednesday(year, month){ // month: 1~12
    const d = new Date(year, month-1, 1);
    const add = ((3 - d.getDay()) + 7) % 7; // 0=日, 3=三
    const firstWed = 1 + add;
    return new Date(year, month-1, firstWed + 14); // 第三個週三
  }
  const dayMS = 24*3600*1000;
  const thirdThursday = (y,m) => new Date(thirdWednesday(y,m).getTime() + dayMS);

  // === 給 Date，算出「本期起迄」：本月第三週四起 → 下月第三週三止 ===
  function periodRangeFromDate(date){
    const y = date.getFullYear(), m = date.getMonth()+1;
    const curThu = thirdThursday(y,m);
    if (date.getTime() >= curThu.getTime()){
      const nextY = m===12 ? y+1 : y;
      const nextM = m===12 ? 1   : m+1;
      const end   = thirdWednesday(nextY, nextM);
      return {start: curThu, end};
    } else {
      const prevY = m===1  ? y-1 : y;
      const prevM = m===1  ? 12  : m-1;
      const start = thirdThursday(prevY, prevM);
      const end   = thirdWednesday(y, m);
      return {start, end};
    }
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
    const totalPnL=dailySlip.reduce((a,b)=>a+b.pnl,0);
    const cagr=Math.pow((nav+totalPnL)/nav,1/years)-1;
    const MAR=maxDD? cagr/(maxDD/nav):0;
    const wins=trades.filter(t=>t.gainSlip>0), losses=trades.filter(t=>t.gainSlip<0);
    const winPnL=sum(wins.map(t=>t.gainSlip)), losePnL=Math.abs(sum(losses.map(t=>t.gainSlip)));
    const PF=losePnL? winPnL/losePnL : 0;
    const winRate=trades.length? wins.length/trades.length : 0;
    return {count:trades.length, winRate, totalPnL, maxDD, PF, sharpe, sortino, MAR, annRet, vol};
  }

  // ===== 分期（正確週期） =====
  function computeByPeriod(trades){
    const groups = new Map(); // key=endYmd（方便排序） => {start,end,label,trades[]}
    for(const t of trades){
      const d = ymdToDate(String(t.tsOut).slice(0,8));
      const {start,end} = periodRangeFromDate(d);
      const label = `${fmtDate(start)}~${fmtDate(end)}`;
      const key = `${end.getFullYear()}${String(end.getMonth()+1).padStart(2,"0")}${String(end.getDate()).padStart(2,"0")}`;
      if(!groups.has(key)) groups.set(key, {start,end,label,trades:[]});
      groups.get(key).trades.push(t);
    }

    const keys = [...groups.keys()].sort(); // 依到期(週三)時間序
    const rows = [];
    for(const k of keys){
      const g = groups.get(k);
      const arr = g.trades;

      // 期內「日」損益（含滑價）
      const dayMap=new Map();
      for(const t of arr){ const day=String(t.tsOut).slice(0,8); dayMap.set(day,(dayMap.get(day)||0)+t.gainSlip); }
      const daySeries = [...dayMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));
      const cum = daySeries.reduce((a,b)=>a+b.pnl,0);

      const wins=arr.filter(t=>t.gainSlip>0), losses=arr.filter(t=>t.gainSlip<0);
      const winPnL=sum(wins.map(t=>t.gainSlip)), losePnL=Math.abs(sum(losses.map(t=>t.gainSlip)));
      const PF=losePnL? winPnL/losePnL:0;

      const dailyRet=daySeries.map(x=>x.pnl/1_000_000);
      const mean=avg(dailyRet), vol=stdev(dailyRet)*Math.sqrt(252);
      const downside=stdev(dailyRet.filter(x=>x<0))*Math.sqrt(252);
      const annRet=mean*252;
      const sharpe=vol?annRet/vol:0, sortino=downside?annRet/downside:0;
      const maxDD=Math.max(0,...daySeries.map(x=>-x.pnl));
      const first = daySeries[0] ? ymdToDate(daySeries[0].date) : g.start;
      const last  = daySeries.at(-1) ? ymdToDate(daySeries.at(-1).date) : g.end;
      const days  = Math.max(1, Math.round((last-first)/86400000)+1);
      const years = days/365;
      const cagr  = Math.pow((1+cum/1_000_000),(1/Math.max(years,1/365)))-1;
      const MAR   = maxDD? cagr/(maxDD/1_000_000):0;
      const winRate=arr.length? wins.length/arr.length : 0;

      rows.push({
        key:k, periodLabel:g.label, start:g.start, end:g.end,
        count:arr.length, winRate, totalPnL:cum, maxDD, PF, sharpe, sortino, MAR, annRet, vol,
        _daySeries: daySeries, _trades: arr
      });
    }
    return rows;
  }

  // ===== 總覽圖（柱值 + Max/Min 點註記） =====
  function roundRect(ctx,x,y,w,h,r){ const rr=Math.min(r,w/2,h/2); ctx.moveTo(x+rr,y); ctx.arcTo(x+w,y,x+w,y+h,rr); ctx.arcTo(x+w,y+h,x,y+h,rr); ctx.arcTo(x,y+h,x,y,rr); ctx.arcTo(x,y,x+w,y,rr); ctx.closePath(); }
  function drawTopChart(rows){
    if(topChart) topChart.destroy();
    const labels = rows.map(r=>r.periodLabel);
    const bars   = rows.map(r=>r.totalPnL);
    const cum=[]; let acc=0; bars.forEach(v=>{acc+=v; cum.push(acc);});

    const maxIdx = bars.reduce((im,v,i)=> v>(bars[im]??-Infinity)? i:im, 0);
    const minIdx = bars.reduce((im,v,i)=> v<(bars[im]?? Infinity)? i:im, 0);

    const plugin = {
      id:"labels+extrema",
      afterDatasetsDraw(c){
        const {ctx,scales:{x,y}}=c;
        ctx.save(); ctx.font="12px ui-sans-serif,system-ui"; ctx.textBaseline="middle"; ctx.textAlign="center";

        // 柱值（上紅下綠）
        const meta=c.getDatasetMeta(0);
        meta.data.forEach((el,i)=>{
          const v=bars[i]; if(!Number.isFinite(v)) return;
          const {x:bx,y:by}=el.getProps(['x','y'],true);
          const text=comma(Math.round(v));
          const dy = v>=0 ? -12 : +12;
          ctx.fillStyle = v>=0 ? "#ef4444" : "#10b981";
          ctx.fillText(text, bx, by+dy);
        });

        // Max/Min 大點（畫在「累積線」座標）
        function drawPoint(i,color,text,left=true){
          const px=x.getPixelForValue(i), py=y.getPixelForValue(cum[i]);
          ctx.beginPath(); ctx.arc(px,py,6,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
          const pad=6,h=20,w=ctx.measureText(text).width+pad*2, bx=px+(left?+12:-12-w), by=py-h/2;
          ctx.fillStyle="rgba(255,255,255,.96)";
          ctx.beginPath(); roundRect(ctx,bx,by,w,h,6); ctx.fill(); ctx.strokeStyle="#111"; ctx.stroke();
          ctx.fillStyle="#111"; ctx.textAlign="left"; ctx.fillText(text,bx+pad,by+h/2);
        }
        const maxText = `${comma(Math.round(bars[maxIdx]))}(${labels[maxIdx]})`;
        const minText = `${comma(Math.round(bars[minIdx]))}(${labels[minIdx]})`;
        drawPoint(maxIdx,"#ef4444",maxText,true);
        drawPoint(minIdx,"#10b981",minText,false);
        ctx.restore();
      }
    };

    topChart = new Chart($("#chart"),{
      type:"bar",
      data:{labels,datasets:[
        {type:"bar", data:bars, backgroundColor:bars.map(v=>v>=0?"#ef4444":"#10b981")},
        {type:"line",data:cum,  borderColor:"#111", borderWidth:2, pointRadius:3}
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}, layout:{padding:{right:92}} },
      plugins:[plugin]
    });
  }

  // ===== 表格渲染 =====
  const renderTotalTable = (tot)=>{
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
    `; tb.appendChild(tr);
  };

  const renderPeriodTable = (rows)=>{
    const tb=$("#periodTable tbody"); tb.innerHTML="";
    rows.forEach(r=>{
      const tr=document.createElement("tr");
      tr.innerHTML=`
        <td>${r.periodLabel}</td>
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
  };

  // ===== 每期詳表（每日圖 + 交易明細） =====
  function renderPeriodDetails(rows){
    const host=$("#periodDetails"); host.innerHTML="";
    rows.forEach((r,idx)=>{
      const block=document.createElement("div");
      block.className="period-block card";

      const title=document.createElement("div");
      title.className="period-title";
      title.textContent=`期別：${r.periodLabel}（當期淨利：${comma(r.totalPnL)}，筆數：${r.count}，勝率：${fmtPct(r.winRate)}）`;
      block.appendChild(title);

      // 日損益圖
      const chartDiv=document.createElement("div");
      chartDiv.className="miniChart";
      const cv=document.createElement("canvas");
      cv.id=`daily-${idx}`;
      chartDiv.appendChild(cv);
      block.appendChild(chartDiv);

      // 明細表（兩列一筆）
      const tbl=document.createElement("table");
      tbl.innerHTML=`
        <thead>
          <tr>
            <th>#</th><th>日期時間</th><th class="num">成交點位</th><th>類別</th>
            <th class="num">點數</th><th class="num">手續費</th><th class="num">交易稅</th>
            <th class="num">理論淨損益</th><th class="num">累積理論淨損益</th>
            <th class="num">實際淨損益(含滑價)</th><th class="num">累積實際淨損益(含滑價)</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      block.appendChild(tbl);

      host.appendChild(block);

      drawDailyChart(cv, r._daySeries);
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
    const tone = v => v>0 ? "p-red" : (v<0 ? "p-green" : "");
    trades.forEach((t,i)=>{
      const fee = FEE*2;
      const tax = Math.round(t.priceOut*MULT*TAX);
      const newCum     = cum + t.gain;
      const newCumSlip = cumSlip + t.gainSlip;

      const entry=document.createElement("tr");
      entry.innerHTML=`
        <td rowspan="2">${i+1}</td>
        <td>${fmtTs(t.pos.tsIn)}</td>
        <td class="num">${t.pos.pIn}</td>
        <td>${t.pos.side==='L'?'新買':'新賣'}</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
      `;
      const exit=document.createElement("tr");
      exit.innerHTML=`
        <td>${fmtTs(t.tsOut)}</td>
        <td class="num">${t.priceOut}</td>
        <td>${t.pos.side==='L'?'平賣':'平買'}</td>
        <td class="num ${tone(t.pts)}">${t.pts}</td>
        <td class="num">${fee}</td>
        <td class="num">${tax}</td>
        <td class="num ${tone(t.gain)}">${fmtMoney(t.gain)}</td>
        <td class="num ${tone(newCum)}">${fmtMoney(newCum)}</td>
        <td class="num ${tone(t.gainSlip)}">${fmtMoney(t.gainSlip)}</td>
        <td class="num ${tone(newCumSlip)}">${fmtMoney(newCumSlip)}</td>
      `;
      tbody.appendChild(entry); tbody.appendChild(exit);
      cum=newCum; cumSlip=newCumSlip;
    });
  }

  // ===== 主流程 =====
  async function handleRaw(raw){
    const { parseTXT, buildReport, paramsLabel } = window.SHARED;
    const parsed=parseTXT(raw);
    const report=buildReport(parsed.rows);
    if(report.trades.length===0){ alert("沒有交易資料"); return; }

    // 整段日損益（含滑價）
    const allDay=new Map();
    for(const t of report.trades){ const d=String(t.tsOut).slice(0,8); allDay.set(d,(allDay.get(d)||0)+t.gainSlip); }
    const allDaily=[...allDay.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));
    const total=computeOverall(allDaily, report.trades);

    // 分期（第三週四起 → 下月第三週三止）
    const perRows=computeByPeriod(report.trades);

    drawTopChart(perRows);
    renderTotalTable(total);
    renderPeriodTable(perRows);
    renderPeriodDetails(perRows);

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
