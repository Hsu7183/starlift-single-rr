/* 檔案：multi-adv.js  ｜ 多檔分析（進階版） adv-v1
   變更：
   - 新增「參數」欄（抓 TXT 第一行；過長自動截斷，完整內容放在 title）
   - 在檔名前加「開在單檔分析」按鈕：把 {name,text} 存到 sessionStorage 後，開新頁 single-inject.html?from=multi-adv
   - 參數欄位數字格式化：把 123.000000 → 123；1.230000 → 1.23
*/
(function(){
  const $ = s => document.querySelector(s);
  let chart, rows = [], currentIdx = -1;

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
  const tsToDate = ts => { const s=String(ts||""); const y=s.slice(0,4), m=Number(s.slice(4,6)), d=Number(s.slice(6,8)); if(y&&m&&d) return `${y}/${m}/${d}`; return s; };
  const safeHead = (text) => (text||"").split(/\r?\n/)[0]?.trim() || "";

  // 將 123.000000 → 123；1.230000 → 1.23；保留必要小數
  function slimNums(s){
    if(!s) return "";
    let t = s
      // 去尾 0，但保留非 0 的小數位
      .replace(/(-?\d+\.\d*?[1-9])0+\b/g, "$1")
      // 小數全為 0 時去掉小數點與 0
      .replace(/(-?\d+)\.0+\b/g, "$1");
    // 壓縮多個空白
    return t.replace(/\s{2,}/g, " ");
  }

  // 檔名縮短：抓 YYYYMMDD_HHMMSS → 顯示 MMDD_HHMMSS
  function shortName(name){
    const base = name.split(/[\\/]/).pop().replace(/\.[^.]+$/,'');
    const m = base.match(/(\d{8})_(\d{6})/);
    if(!m) return base;
    const mmdd = m[1].slice(4,8);
    return `${mmdd}_${m[2]}`;
  }

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

  function drawChartFor(rec){
    if(!rec) return;
    if(chart) chart.destroy();

    const {tsArr,total,slipCum,longCum,longSlipCum,shortCum,shortSlipCum} = rec;
    const labels = tsArr.map((_,i)=>i);
    const mkSolid=(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0});
    const mkDash =(data,col,w)=>({data,stepped:true,borderColor:col,borderWidth:w,pointRadius:0,borderDash:[6,4]});

    const arr = slipCum || [];
    const idxLast = Math.max(0, arr.length-1);
    const idxMax  = arr.reduce((imax,v,i)=> v>(arr[imax]??-Infinity)? i:imax, 0);
    const idxMin  = arr.reduce((imin,v,i)=> v<(arr[imin]?? Infinity)? i:imin, 0);

    const maxText  = `${comma(Math.round(arr[idxMax]||0))}(${tsToDate(tsArr[idxMax])})`;
    const minText  = `${comma(Math.round(arr[idxMin]||0))}(${tsToDate(tsArr[idxMin])})`;
    const lastText = `${comma(Math.round(arr[idxLast]||0))}`;

    const points = [
      {i:idxMax,  val:arr[idxMax],  color:"#ef4444", text:maxText},
      {i:idxMin,  val:arr[idxMin],  color:"#10b981", text:minText},
      {i:idxLast, val:arr[idxLast], color:"#111",    text:lastText},
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
      options:{responsive:true,maintainAspectRatio:false,layout:{padding:{right:72}},plugins:{legend:{display:false}}},
      plugins:[anno]
    });

    $("#chartCaption").textContent = `目前：${rec.shortName}（黑線 Max/Min 顯示日期，Last 僅顯示數值；皆為含滑價累積）`;
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

    let tpm = 0;
    const first = trades[0], last = trades[trades.length-1];
    if(first && last){
      const ms = (toDate(last.tsOut) - toDate(first.pos.tsIn)) / (1000*60*60*24*30.4);
      tpm = ms>0 ? trades.length/ms : trades.length;
    }
    const winRate = trades.length? wins.length/trades.length : 0;
    return {maxDD,totalPnL,PF,sharpe,sortino,MAR,tradesPerMonth:tpm,annRet,vol,winRate,count:trades.length};
  }

  // ---------- 渲染表格（含「參數」和「開在單檔分析」） ----------
  function renderTable(){
    const tb=$("#sumTable tbody"); tb.innerHTML="";
    rows.forEach((r,idx)=>{
      const tr=document.createElement("tr");
      if(idx===currentIdx) tr.classList.add("active-row");
      tr.dataset.idx = String(idx);

      const btn = `<button class="btn-link" data-open="${idx}" title="在單檔分析（機構級）開啟">開在單檔分析</button>`;

      tr.innerHTML=`
        <td>${btn}</td>
        <td>${r.shortName}</td>
        <td class="param-cell" title="${r.paramsFull||''}">${r.params}</td>
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
      // 點整列 → 切換圖
      tr.addEventListener("click", (ev)=>{
        if(ev.target && ev.target.getAttribute("data-open")!=null) return; // 按鈕另處理
        selectRow(idx);
      });
      // 按鈕 → 開新頁
      tr.querySelector("[data-open]").addEventListener("click", ()=>{
        openInSingle(r);
      });

      tb.appendChild(tr);
    });
  }

  function selectRow(idx){
    currentIdx = idx;
    renderTable();               // 更新高亮
    drawChartFor(rows[idx]);     // 切換圖表
  }

  function bindSort(){
    $("#sumTable thead").querySelectorAll("th").forEach(th=>{
      th.onclick = ()=>{
        const k = th.getAttribute("data-k"); if(!k || k==="_open") return;
        const asc = th.dataset.asc !== "1";
        rows.sort((a,b)=>{
          if(k==="shortName" || k==="params"){
            return asc ? String(a[k]||"").localeCompare(String(b[k]||"")) 
                       : String(b[k]||"").localeCompare(String(a[k]||""));
          }
          const x = Number(a[k]??0), y=Number(b[k]??0);
          return asc ? (x-y) : (y-x);
        });
        th.dataset.asc = asc ? "1" : "0";
        if(currentIdx>=0){
          const curId = rows[currentIdx]?.__id;
          const newIdx = rows.findIndex(r=>r.__id===curId);
          currentIdx = newIdx>=0 ? newIdx : -1;
        }
        renderTable();
      };
    });
  }

  // 開在單檔分析（機構級）：將 name/text 暫存到 sessionStorage 後新開頁
  function openInSingle(rec){
    try{
      const key = "starlift_single_inject";
      sessionStorage.setItem(key, JSON.stringify({ name: rec.name, text: rec.rawText || "" }));
      // 為了不動既有 single.html，先開到全新的 single-inject.html
      window.open(`single-inject.html?from=multi-adv#${encodeURIComponent(rec.shortName)}`, "_blank");
    }catch(e){
      console.error(e);
      alert("無法暫存到 sessionStorage，請檢查瀏覽器設定。");
    }
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

      // 參數：取第一行並去掉多餘 0
      const p0 = safeHead(text);
      const pTidy = slimNums(p0);
      const pShow = pTidy.length>120 ? pTidy.slice(0,120)+"…" : pTidy;

      results.push({
        __id: Math.random().toString(36).slice(2),
        name, rawText: text,
        shortName: shortName(name),
        params: pShow,
        paramsFull: pTidy,
        ...k,
        tsArr:report.tsArr,
        total:report.total,
        slipCum:report.slipCum,
        longCum:report.longCum, longSlipCum:report.longSlipCum,
        shortCum:report.shortCum, shortSlipCum:report.shortSlipCum
      });
    }

    rows = results;
    bindSort();
    if(rows[0]) selectRow(0);

    $("#fileCount").textContent = String(rows.length);
    $("#importAt").textContent  = nowStr();
  }

  // ---------- 綁定事件 ----------
  $("#btn-clip").addEventListener("click", async ()=>{
    try{
      const clip = await navigator.clipboard.readText();
      // 允許一次貼多份：以 5 個以上連續「-」為分隔線
      const parts = clip.split(/\n-{5,}\n/);
      const pairs = parts.map((txt,i)=>({name:`CLIP_${i+1}.txt`, text:txt.trim()})).filter(p=>p.text);
      if(!pairs.length){ alert("剪貼簿沒有可用 TXT 內容"); return; }
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
    await handleTexts(pairs);
  });
})();
