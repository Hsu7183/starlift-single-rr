/* 多檔分析（機構級） multi-v2
   - 匯入多份 TXT（檔案或剪貼簿）
   - 上方：第一檔 6 線圖（含滑價黑線 Max/Min/Last）
   - 下方：彙總表（可排序），含合計列
*/
(function(){
  const $ = s => document.querySelector(s);
  let chart;

  // ---------- 小工具 ----------
  const fmtPct = x => (Number.isFinite(x)? (x*100).toFixed(2) : "0.00")+"%";
  const fmt2   = x => Number(x||0).toFixed(2);
  const comma  = n => (Number(n)||0).toLocaleString("zh-TW");
  const cls    = v => v>0 ? "p-red" : (v<0 ? "p-green" : "");
  const sum    = a => a.reduce((x,y)=>x+y,0);
  const avg    = a => a.length? sum(a)/a.length : 0;
  const stdev  = a => { if(a.length<2) return 0; const m=avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
  const keyFromTs = ts => { const s=String(ts); return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`; };
  const toDate = ts => { const s=String(ts||""); const y=s.slice(0,4),m=s.slice(4,6),d=s.slice(6,8),hh=s.slice(8,10)||"00",mm=s.slice(10,12)||"00",ss=s.slice(12,14)||"00"; return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`); };
  const nowStr = ()=>{ const d=new Date(); const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

  // ---------- Chart ----------
  function roundRect(ctx,x,y,w,h,r){
    const rr=Math.min(r,w/2,h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr,y);
    ctx.arcTo(x+w,y,x+w,y+h,rr);
    ctx.arcTo(x+w,y+h,x,y+h,rr);
    ctx.arcTo(x,y+h,x,y,rr);
    ctx.arcTo(x,y,x+w,y,rr);
    ctx.closePath();
  }

  function drawChartFor(report){
    if(!report) return;
    if (chart) chart.destroy();

    const {tsArr,total,slipCum,longCum,longSlipCum,shortCum,shortSlipCum} = report;
    const labels = tsArr.map((_,i)=>i);
    const mkSolid=(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0});
    const mkDash =(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0,borderDash:[6,4]});

    const arr = slipCum || [];
    const idxLast = Math.max(0, arr.length-1);
    const idxMax  = arr.reduce((imax,v,i)=> v>(arr[imax]??-Infinity)? i:imax, 0);
    const idxMin  = arr.reduce((imin,v,i)=> v<(arr[imin]?? Infinity)? i:imin, 0);
    const points = [
      {i:idxMax,  val:arr[idxMax],  color:"#ef4444", text: comma(Math.round(arr[idxMax]||0))},
      {i:idxMin,  val:arr[idxMin],  color:"#10b981", text: comma(Math.round(arr[idxMin]||0))},
      {i:idxLast, val:arr[idxLast], color:"#111",    text: comma(Math.round(arr[idxLast]||0))},
    ];

    const anno = {
      id:"anno",
      afterDatasetsDraw(c){
        const {ctx,scales:{x,y}}=c; ctx.save();
        ctx.font="12px ui-sans-serif,system-ui"; ctx.textBaseline="middle";
        points.forEach(p=>{
          if(!Number.isFinite(p.val)) return;
          const px=x.getPixelForValue(p.i), py=y.getPixelForValue(p.val);
          ctx.beginPath(); ctx.arc(px,py,6,0,Math.PI*2); ctx.fillStyle=p.color; ctx.fill();
          const pad=6,h=20,w=ctx.measureText(p.text).width+pad*2, bx=px+12, by=py-h/2;
          ctx.fillStyle="rgba(255,255,255,.96)";
          roundRect(ctx,bx,by,w,h,6); ctx.fill(); ctx.strokeStyle="#111"; ctx.stroke();
          ctx.fillStyle="#111"; ctx.fillText(p.text,bx+pad,by+h/2);
        });
        ctx.restore();
      }
    };

    chart = new Chart($("#chart"), {
      type:"line",
      data:{labels,datasets:[
        mkSolid(slipCum,"#111",3.5),       mkDash(total,"#9aa",2),
        mkSolid(longSlipCum,"#d32f2f",3),  mkDash(longCum,"#ef9a9a",2),
        mkSolid(shortSlipCum,"#2e7d32",3), mkDash(shortCum,"#a5d6a7",2)
      ]},
      options:{
        responsive:true,maintainAspectRatio:false,
        layout:{padding:{right:72}},
        plugins:{legend:{display:false}}
      },
      plugins:[anno]
    });
  }

  // ---------- RR（簡版） ----------
  function computeRR(dailySlip,trades,nav=1_000_000,rf=0){
    let cum=0, peak=-Infinity, maxDD=0;
    dailySlip.forEach(d=>{ cum+=d.pnl; const nv=nav+cum; if(nv>peak) peak=nv; else maxDD=Math.max(maxDD,peak-nv); });
    const dailyRet=dailySlip.map(d=>d.pnl/nav);
    const mean=avg(dailyRet), vol=stdev(dailyRet)*Math.sqrt(252);
    const downside=stdev(dailyRet.filter(x=>x<(rf/252)))*Math.sqrt(252);
    const annRet=mean*252;
    const sharpe = vol?((annRet-rf)/vol):0;
    const sortino= downside?((annRet-rf)/downside):0;
    const years=Math.max((dailySlip.length||252)/252,1/365);
    const totalPnL=cum, cagr=Math.pow((nav+totalPnL)/nav,1/years)-1;
    const MAR=maxDD? cagr/(maxDD/nav):0;

    const wins=trades.filter(t=>t.gainSlip>0), losses=trades.filter(t=>t.gainSlip<0);
    const winPnL=sum(wins.map(t=>t.gainSlip)), losePnL=Math.abs(sum(losses.map(t=>t.gainSlip)));
    const PF=losePnL? winPnL/losePnL : 0;

    // trades per month
    const first = trades[0], last = trades[trades.length-1];
    let tpm = 0;
    if(first && last){
      const ms = (toDate(last.tsOut) - toDate(first.pos.tsIn)) / (1000*60*60*24*30.4);
      tpm = ms>0 ? trades.length/ms : trades.length;
    }
    const winRate = trades.length? wins.length/trades.length : 0;

    return {maxDD,totalPnL,PF,sharpe,sortino,MAR,tradesPerMonth:tpm,annRet,vol,winRate,count:trades.length,_winPnL:winPnL,_losePnL:losePnL};
  }

  // ---------- 彙總表 ----------
  function renderTable(rows){
    const tb=$("#sumTable tbody"); tb.innerHTML="";
    rows.forEach(r=>{
      const tr=document.createElement("tr");
      tr.innerHTML=`
        <td>${r.name}</td>
        <td class="num">${r.count}</td>
        <td class="num">${fmtPct(r.winRate)}</td>
        <td class="num ${cls(r.totalPnL)}">${comma(r.totalPnL)}</td>
        <td class="num">-${comma(r.maxDD)}</td>
        <td class="num">${fmt2(r.PF)}</td>
        <td class="num">${fmt2(r.sharpe)}</td>
        <td class="num">${fmt2(r.sortino)}</td>
        <td class="num">${fmt2(r.MAR)}</td>
        <td class="num">${fmt2(r.tradesPerMonth)}</td>
        <td class="num">${fmtPct(r.annRet)}</td>
        <td class="num">${fmtPct(r.vol)}</td>
      `;
      tb.appendChild(tr);
    });

    // 合計列
    const totalPnL = sum(rows.map(r=>r.totalPnL||0));
    const maxDD    = Math.max(0, ...rows.map(r=>r.maxDD||0));
    const PF = (()=>{ const W=sum(rows.map(r=>r._winPnL||0)), L=Math.abs(sum(rows.map(r=>r._losePnL||0))); return L? W/L:0; })();
    const sharpe = rows.length? avg(rows.map(r=>r.sharpe||0)) : 0;
    const sortino= rows.length? avg(rows.map(r=>r.sortino||0)) : 0;
    const MAR    = rows.length? avg(rows.map(r=>r.MAR||0)) : 0;
    const tpm    = rows.length? avg(rows.map(r=>r.tradesPerMonth||0)) : 0;
    const annRet = rows.length? avg(rows.map(r=>r.annRet||0)) : 0;
    const vol    = rows.length? avg(rows.map(r=>r.vol||0)) : 0;
    const winRate= rows.length? avg(rows.map(r=>r.winRate||0)) : 0;
    const count  = sum(rows.map(r=>r.count||0));

    const sr = $("#sumRow").children;
    sr[1].textContent = count;
    sr[2].textContent = fmtPct(winRate);
    sr[3].textContent = comma(totalPnL);
    sr[3].className   = "num "+cls(totalPnL);
    sr[4].textContent = "-"+comma(maxDD);
    sr[5].textContent = fmt2(PF);
    sr[6].textContent = fmt2(sharpe);
    sr[7].textContent = fmt2(sortino);
    sr[8].textContent = fmt2(MAR);
    sr[9].textContent = fmt2(tpm);
    sr[10].textContent= fmtPct(annRet);
    sr[11].textContent= fmtPct(vol);
  }

  // ---------- 多檔處理 ----------
  async function handleTexts(nameTextPairs){
    const {parseTXT, buildReport} = window.SHARED;
    const results=[];

    for(const {name,text} of nameTextPairs){
      const parsed = parseTXT(text);
      const report = buildReport(parsed.rows);

      // 以出場日聚合（含滑價）
      const m=new Map();
      for(const t of report.trades){ const k=keyFromTs(t.tsOut); m.set(k,(m.get(k)||0)+t.gainSlip); }
      const dailySlip=[...m.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,pnl])=>({date,pnl}));

      const k = computeRR(dailySlip, report.trades, 1_000_000, 0);

      results.push({
        name,
        ...k,
        tsArr:report.tsArr,
        total:report.total,
        slipCum:report.slipCum,
        longCum:report.longCum, longSlipCum:report.longSlipCum,
        shortCum:report.shortCum, shortSlipCum:report.shortSlipCum
      });
    }

    if(results[0]){
      drawChartFor(results[0]);
      $("#chartCaption").textContent = `第一檔：${results[0].name}（黑線標注 Max/Min/Last 為含滑價累積）`;
    }

    renderTable(results);
    bindSort(results);
  }

  // ---------- 排序 ----------
  function bindSort(rows){
    const thead = $("#sumTable thead");
    thead.querySelectorAll("th").forEach(th=>{
      th.onclick = ()=>{
        const k = th.getAttribute("data-k"); if(!k) return;
        const asc = th.dataset.asc !== "1";
        rows.sort((a,b)=>{
          if(k==="name"){ return asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name); }
          const x = Number(a[k]??0), y=Number(b[k]??0);
          return asc ? (x-y) : (y-x);
        });
        th.dataset.asc = asc ? "1" : "0";
        renderTable(rows);
      };
    });
  }

  // ---------- 綁定事件 ----------
  $("#btn-clip").addEventListener("click", async ()=>{
    try{
      const clip = await navigator.clipboard.readText();
      // 可貼入多份：以 5 個以上連續破折號為分隔線
      const parts = clip.split(/\n-{5,}\n/);
      const pairs = parts.map((txt,i)=>({name:`CLIP_${i+1}.txt`, text:txt.trim()})).filter(p=>p.text);
      if(!pairs.length){ alert("剪貼簿沒有可用 TXT 內容"); return; }
      $("#fileCount").textContent = String(pairs.length);
      $("#importAt").textContent  = nowStr();
      await handleTexts(pairs);
    }catch(e){
      console.error(e);
      alert("無法讀取剪貼簿內容，請改用「選擇檔案」。");
    }
  });

  $("#files").addEventListener("change", async e=>{
    const {readAsTextAuto} = window.SHARED;
    const files = [...(e.target.files||[])];
    if(!files.length) return;
    const pairs = [];
    for(const f of files){
      const text = await readAsTextAuto(f);
      pairs.push({name:f.name, text});
    }
    $("#fileCount").textContent = String(pairs.length);
    $("#importAt").textContent  = nowStr();
    await handleTexts(pairs);
  });
})();
