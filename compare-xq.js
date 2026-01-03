/* compare-xq.js
   TXT vs XQ 回測對帳（純前端）
   - TXT：策略輸出交易紀錄（含 INPOS 行）
   - XLSX：XQ 回測匯出（交易分析）
*/
(function(){
  const $ = (id)=>document.getElementById(id);
  const state = {
    txtName: null,
    xlsName: null,
    txtText: null,
    xqRows: null,
    lastResult: null,
  };

  const el = {
    txtFile: $("txtFile"),
    xlsFile: $("xlsFile"),
    txtName: $("txtName"),
    xlsName: $("xlsName"),
    tolMin: $("tolMin"),
    tolPx: $("tolPx"),
    tolMinLabel: $("tolMinLabel"),
    tolPxLabel: $("tolPxLabel"),
    btnRun: $("btnRun"),
    btnExport: $("btnExport"),
    status: $("status"),
    quick: $("quick"),
    tbody: $("tbody"),
    drop: $("drop"),
    // KPI
    k_txtTrades: $("k_txtTrades"),
    k_xqTrades: $("k_xqTrades"),
    k_matched: $("k_matched"),
    k_unmatched: $("k_unmatched"),
    k_dEntry: $("k_dEntry"),
    k_dExit: $("k_dExit"),
    k_dPnl: $("k_dPnl"),
    k_dPnlMax: $("k_dPnlMax"),
  };

  function setStatus(html){ el.status.innerHTML = html; }
  function esc(s){ return String(s ?? "").replace(/[&<>"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }

  function pad2(n){ return (n<10?"0":"")+n; }

  // Parse "YYYYMMDDhhmmss" -> Date (local)
  function parseTS14(ts14){
    if(!ts14) return null;
    const s = String(ts14).trim();
    if(!/^\d{14}$/.test(s)) return null;
    const y = +s.slice(0,4), mo = +s.slice(4,6), d = +s.slice(6,8);
    const h = +s.slice(8,10), mi = +s.slice(10,12), se = +s.slice(12,14);
    return new Date(y, mo-1, d, h, mi, se, 0);
  }
  function fmtTS(dt){
    if(!dt) return "";
    return `${dt.getFullYear()}/${pad2(dt.getMonth()+1)}/${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  }
  function minutesKey(dt){
    if(!dt) return null;
    return dt.getFullYear()*100000000 + (dt.getMonth()+1)*1000000 + dt.getDate()*10000 + dt.getHours()*100 + dt.getMinutes();
  }

  function parseTxtTrades(txt){
    const lines = String(txt||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if(!lines.length) return { trades: [], meta:{}, errors:["TXT 檔案內容為空"] };

    const meta = { rawHeader: null };
    const errors = [];

    // 第一列可能是參數列（含 BeginTime=...）
    if(lines[0].includes("BeginTime=") || lines[0].includes("EndTime=") || lines[0].includes("ForceExitTime=")){
      meta.rawHeader = lines[0];
    }

    const actionSet = new Set(["新買","平賣","新賣","平買","強制平倉"]);
    // 只抽出 action lines：格式可能為 "YYYYMMDDhhmmss price action"
    const actions = [];
    for(const line of lines){
      if(line===meta.rawHeader) continue;
      const parts = line.split(/\s+/);
      if(parts.length < 3) continue;
      const act = parts[parts.length-1];
      if(!actionSet.has(act)) continue;
      const ts = parts[0];
      const px = parseFloat(parts[1]);
      const dt = parseTS14(ts);
      if(!dt || !Number.isFinite(px)){
        errors.push("無法解析列: "+line);
        continue;
      }
      actions.push({ ts14:ts, dt, px, act, raw: line });
    }

    // 一進一出配對
    const trades = [];
    let open = null; // {dir, entryDt, entryPx, entryAct}
    let idx = 0;
    for(const a of actions){
      const isEntry = (a.act==="新買" || a.act==="新賣");
      const isExit  = (a.act==="平賣" || a.act==="平買" || a.act==="強制平倉");

      if(isEntry){
        if(open){
          // 前一筆未出場就又進場：先把前一筆標記為異常（不丟掉）
          trades.push({
            id: ++idx,
            dir: open.dir,
            entryDt: open.entryDt,
            entryPx: open.entryPx,
            exitDt: null,
            exitPx: null,
            pnl: null,
            status: "TXT：缺少出場（遇到新進場）",
          });
        }
        open = {
          dir: (a.act==="新買") ? "L" : "S",
          entryDt: a.dt,
          entryPx: a.px,
          entryAct: a.act,
        };
        continue;
      }

      if(isExit){
        if(!open){
          // 出場無對應進場
          trades.push({
            id: ++idx,
            dir: "?",
            entryDt: null,
            entryPx: null,
            exitDt: a.dt,
            exitPx: a.px,
            pnl: null,
            status: "TXT：缺少進場（遇到出場）",
          });
          continue;
        }
        // 決定出場方向合理性：多單應平賣/強制，空單應平買/強制
        const ok =
          (open.dir==="L" && (a.act==="平賣" || a.act==="強制平倉")) ||
          (open.dir==="S" && (a.act==="平買" || a.act==="強制平倉"));

        const pnl = (open.dir==="L") ? (a.px - open.entryPx) : (open.entryPx - a.px);

        trades.push({
          id: ++idx,
          dir: open.dir,
          entryDt: open.entryDt,
          entryPx: open.entryPx,
          exitDt: a.dt,
          exitPx: a.px,
          pnl,
          status: ok ? "OK" : ("TXT：方向不一致（"+open.entryAct+"→"+a.act+"）"),
          exitAct: a.act,
        });
        open = null;
      }
    }

    if(open){
      trades.push({
        id: ++idx,
        dir: open.dir,
        entryDt: open.entryDt,
        entryPx: open.entryPx,
        exitDt: null,
        exitPx: null,
        pnl: null,
        status: "TXT：缺少出場（檔案結尾）",
      });
    }

    // 只保留完整交易用於對帳（entry+exit 都有）
    const complete = trades.filter(t=>t.entryDt && t.exitDt);
    return { trades: complete, meta, errors };
  }

  function parseXqTradesFromWorkbook(wb){
    const sheetName = wb.SheetNames.includes("交易分析") ? "交易分析" : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if(!ws) return { trades:[], sheetName, errors:["找不到工作表: "+sheetName] };

    // 轉為 JSON（第一列為 header）
    const rows = XLSX.utils.sheet_to_json(ws, { defval:"", raw:false });
    // 預期欄位（中文）
    const need = ["進場時間","進場方向","進場價格","出場時間","出場價格","獲利金額"];
    const errors = [];
    for(const k of need){
      if(rows.length && !(k in rows[0])) errors.push(`欄位缺少：${k}（請確認為 XQ 回測匯出之「交易分析」工作表）`);
    }

    const trades = [];
    let id = 0;
    for(const r of rows){
      const entryT = parseXqDateTime(r["進場時間"]);
      const exitT  = parseXqDateTime(r["出場時間"]);
      const dirStr = String(r["進場方向"]||"").trim();
      const entryPx = toNum(r["進場價格"]);
      const exitPx  = toNum(r["出場價格"]);
      const pnl     = toNum(r["獲利金額"]);
      if(!entryT || !exitT || !Number.isFinite(entryPx) || !Number.isFinite(exitPx)) continue;

      const dir = (dirStr==="買進" || dirStr==="買入" || dirStr==="多" || dirStr==="做多") ? "L"
               : (dirStr==="賣出" || dirStr==="賣" || dirStr==="空" || dirStr==="放空" || dirStr==="做空") ? "S"
               : "?";

      trades.push({
        id: ++id,
        dir,
        entryDt: entryT,
        entryPx,
        exitDt: exitT,
        exitPx,
        pnl: Number.isFinite(pnl) ? pnl : ((dir==="L") ? (exitPx-entryPx) : (entryPx-exitPx)),
        raw: r
      });
    }
    return { trades, sheetName, errors };

    function toNum(v){
      if(v===null || v===undefined) return NaN;
      if(typeof v==="number") return v;
      const s = String(v).replace(/,/g,"").trim();
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : NaN;
    }
    function parseXqDateTime(v){
      // 例：2020/02/04 08:54
      const s = String(v||"").trim();
      const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if(!m) return null;
      const y=+m[1], mo=+m[2], d=+m[3], h=+m[4], mi=+m[5], se=+(m[6]||0);
      return new Date(y, mo-1, d, h, mi, se, 0);
    }
  }

  function matchTrades(txtTrades, xqTrades, tolMin, tolPx){
    // 以 TXT 為主：為每筆 TXT 找一筆最接近的 XQ（同方向）
    const xqLeft = xqTrades.map(t=>({ ...t, _used:false }));
    const rows = [];

    function abs(x){ return Math.abs(x); }
    function diffMin(a,b){ return (a.getTime()-b.getTime())/60000; }

    let matched = 0;
    for(const t of txtTrades){
      let best = null;
      for(const x of xqLeft){
        if(x._used) continue;
        if(x.dir !== t.dir) continue;

        const dEntryMin = abs(diffMin(x.entryDt, t.entryDt));
        if(dEntryMin > tolMin) continue;

        const dEntryPx = abs(x.entryPx - t.entryPx);
        if(dEntryPx > tolPx) continue;

        // 評分：先比時間，再比價格
        const score = dEntryMin*100 + dEntryPx;
        if(!best || score < best.score){
          best = { x, score, dEntryMin, dEntryPx };
        }
      }

      if(best){
        best.x._used = true;
        matched++;

        const dEntry = best.x.entryPx - t.entryPx;
        const dExit  = best.x.exitPx - t.exitPx;
        const dPnl   = (best.x.pnl ?? NaN) - (t.pnl ?? NaN);

        rows.push({
          type: "matched",
          dir: t.dir,
          txt: t,
          xq: best.x,
          dEntry,
          dExit,
          dPnl,
          note: `OK（Δt≤${tolMin}m & Δp≤${tolPx}）`
        });
      }else{
        rows.push({ type:"txt_only", dir:t.dir, txt:t, xq:null, dEntry:null, dExit:null, dPnl:null, note:"TXT 無對應 XQ" });
      }
    }

    // 找 XQ 未配對
    for(const x of xqLeft){
      if(!x._used){
        rows.push({ type:"xq_only", dir:x.dir, txt:null, xq:x, dEntry:null, dExit:null, dPnl:null, note:"XQ 無對應 TXT" });
      }
    }

    // 排序：先 matched，再 txt_only，再 xq_only；各自依進場時間
    const rank = (t)=>t.type==="matched"?0:(t.type==="txt_only"?1:2);
    rows.sort((a,b)=>{
      const ra = rank(a), rb = rank(b);
      if(ra!==rb) return ra-rb;
      const ta = (a.txt?.entryDt || a.xq?.entryDt || new Date(0)).getTime();
      const tb = (b.txt?.entryDt || b.xq?.entryDt || new Date(0)).getTime();
      return ta-tb;
    });

    return { rows, matched, xqUnmatched: xqLeft.filter(x=>!x._used).length, txtUnmatched: txtTrades.length - matched };
  }

  function computeStats(result){
    const matchedRows = result.rows.filter(r=>r.type==="matched");
    const n = matchedRows.length;
    const avg = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : NaN;
    const dEntry = matchedRows.map(r=>r.dEntry).filter(Number.isFinite);
    const dExit  = matchedRows.map(r=>r.dExit).filter(Number.isFinite);
    const dPnl   = matchedRows.map(r=>r.dPnl).filter(Number.isFinite);
    const maxAbs = (arr)=> arr.length ? Math.max(...arr.map(x=>Math.abs(x))) : NaN;

    return {
      n,
      avgEntry: avg(dEntry),
      avgExit: avg(dExit),
      avgPnl: avg(dPnl),
      maxAbsPnl: maxAbs(dPnl),
    };
  }

  function render(result, stats){
    el.btnExport.disabled = !result || !result.rows || !result.rows.length;

    el.k_txtTrades.textContent = String(state.lastResult?.txtTrades ?? "—");
    el.k_xqTrades.textContent  = String(state.lastResult?.xqTrades ?? "—");
    el.k_matched.textContent   = String(stats?.n ?? "—");
    el.k_unmatched.textContent = `${state.lastResult?.txtUnmatched ?? "—"} / ${state.lastResult?.xqUnmatched ?? "—"}`;

    const fmt = (x)=> Number.isFinite(x) ? x.toFixed(2) : "—";
    el.k_dEntry.textContent = fmt(stats?.avgEntry);
    el.k_dExit.textContent  = fmt(stats?.avgExit);
    el.k_dPnl.textContent   = fmt(stats?.avgPnl);
    el.k_dPnlMax.textContent= fmt(stats?.maxAbsPnl);

    el.tbody.innerHTML = "";
    if(!result.rows.length){
      el.tbody.innerHTML = `<tr><td colspan="12" class="muted">沒有資料。</td></tr>`;
      return;
    }

    let i=0;
    for(const r of result.rows){
      i++;
      const dirLabel = r.dir==="L" ? "多" : (r.dir==="S" ? "空" : "?");
      const cls = r.type==="matched" ? "ok" : (r.type==="txt_only" ? "warn" : "bad");
      const txtEntry = r.txt ? `${fmtTS(r.txt.entryDt)} @ <span class="mono">${r.txt.entryPx}</span>` : "—";
      const txtExit  = r.txt ? `${fmtTS(r.txt.exitDt)} @ <span class="mono">${r.txt.exitPx}</span>` : "—";
      const xqEntry  = r.xq  ? `${fmtTS(r.xq.entryDt)} @ <span class="mono">${r.xq.entryPx}</span>` : "—";
      const xqExit   = r.xq  ? `${fmtTS(r.xq.exitDt)} @ <span class="mono">${r.xq.exitPx}</span>` : "—";

      const txtPnl = (r.txt && Number.isFinite(r.txt.pnl)) ? r.txt.pnl : null;
      const xqPnl  = (r.xq  && Number.isFinite(r.xq.pnl))  ? r.xq.pnl  : null;

      const dEntry = Number.isFinite(r.dEntry) ? r.dEntry : null;
      const dExit  = Number.isFinite(r.dExit)  ? r.dExit  : null;
      const dPnl   = Number.isFinite(r.dPnl)   ? r.dPnl   : null;

      el.tbody.insertAdjacentHTML("beforeend", `
        <tr>
          <td class="num">${i}</td>
          <td><span class="${cls}">${dirLabel}</span></td>
          <td>${txtEntry}</td>
          <td>${txtExit}</td>
          <td class="num">${txtPnl===null?"—":txtPnl.toFixed(0)}</td>
          <td>${xqEntry}</td>
          <td>${xqExit}</td>
          <td class="num">${xqPnl===null?"—":xqPnl.toFixed(0)}</td>
          <td class="num">${dEntry===null?"—":dEntry.toFixed(2)}</td>
          <td class="num">${dExit===null?"—":dExit.toFixed(2)}</td>
          <td class="num">${dPnl===null?"—":dPnl.toFixed(0)}</td>
          <td class="${cls}">${esc(r.note)}</td>
        </tr>
      `);
    }
  }

  function buildQuickSummary(txtParsed, xqParsed){
    const parts = [];
    if(txtParsed.errors.length) parts.push(`<div class="bad">TXT 警告：${esc(txtParsed.errors[0])}${txtParsed.errors.length>1?`（+${txtParsed.errors.length-1}）`:""}</div>`);
    if(xqParsed.errors.length) parts.push(`<div class="bad">XQ 警告：${esc(xqParsed.errors[0])}${xqParsed.errors.length>1?`（+${xqParsed.errors.length-1}）`:""}</div>`);
    parts.push(`<div>TXT 完整交易：<b>${txtParsed.trades.length}</b>；XQ 交易：<b>${xqParsed.trades.length}</b>；XQ 工作表：<span class="mono">${esc(xqParsed.sheetName)}</span></div>`);

    const range = (trades)=>{
      if(!trades.length) return "—";
      const a = trades.map(t=>t.entryDt.getTime()).sort((x,y)=>x-y);
      const b = trades.map(t=>t.exitDt.getTime()).sort((x,y)=>x-y);
      return `${fmtTS(new Date(a[0]))} → ${fmtTS(new Date(b[b.length-1]))}`;
    };
    parts.push(`<div class="muted">TXT 範圍：${esc(range(txtParsed.trades))}</div>`);
    parts.push(`<div class="muted">XQ 範圍：${esc(range(xqParsed.trades))}</div>`);
    return parts.join("");
  }

  function exportCSV(result){
    if(!result || !result.rows) return;
    const lines = [];
    lines.push([
      "type","dir",
      "txt_entry_time","txt_entry_px","txt_exit_time","txt_exit_px","txt_pnl",
      "xq_entry_time","xq_entry_px","xq_exit_time","xq_exit_px","xq_pnl",
      "d_entry","d_exit","d_pnl","note"
    ].join(","));

    const q = (s)=> `"${String(s??"").replace(/"/g,'""')}"`;

    for(const r of result.rows){
      const dir = r.dir==="L"?"L":(r.dir==="S"?"S":"?");
      const t = r.txt, x = r.xq;
      lines.push([
        r.type, dir,
        t?fmtTS(t.entryDt):"", t?.entryPx ?? "", t?fmtTS(t.exitDt):"", t?.exitPx ?? "", t?.pnl ?? "",
        x?fmtTS(x.entryDt):"", x?.entryPx ?? "", x?fmtTS(x.exitDt):"", x?.exitPx ?? "", x?.pnl ?? "",
        (r.dEntry??""), (r.dExit??""), (r.dPnl??""), q(r.note)
      ].join(","));
    }

    const blob = new Blob([lines.join("\n")], {type:"text/csv;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `recon_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  }

  async function loadTxtFile(file){
    state.txtName = file.name;
    el.txtName.textContent = file.name;
    const txt = await file.text();
    state.txtText = txt;
  }

  async function loadXlsFile(file){
    state.xlsName = file.name;
    el.xlsName.textContent = file.name;
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:"array"});
    const parsed = parseXqTradesFromWorkbook(wb);
    state.xqRows = parsed;
  }

  function readyToRun(){
    return !!state.txtText && !!state.xqRows;
  }

  async function runRecon(){
    if(!readyToRun()){
      setStatus(`<span class="warn">請先匯入 TXT 與 XQ Excel。</span>`);
      return;
    }
    const tolMin = parseInt(el.tolMin.value,10) || 0;
    const tolPx  = parseInt(el.tolPx.value,10) || 0;

    const txtParsed = parseTxtTrades(state.txtText);
    const xqParsed  = state.xqRows;

    el.quick.innerHTML = buildQuickSummary(txtParsed, xqParsed);

    const matched = matchTrades(txtParsed.trades, xqParsed.trades, tolMin, tolPx);
    const stats = computeStats(matched);

    state.lastResult = {
      txtTrades: txtParsed.trades.length,
      xqTrades: xqParsed.trades.length,
      txtUnmatched: matched.txtUnmatched,
      xqUnmatched: matched.xqUnmatched,
      rows: matched.rows
    };

    render(matched, stats);

    const okRate = (stats.n && txtParsed.trades.length) ? (100*stats.n/txtParsed.trades.length) : 0;
    setStatus([
      `<div>完成：TXT <b>${txtParsed.trades.length}</b> 筆，XQ <b>${xqParsed.trades.length}</b> 筆。</div>`,
      `<div>配對 <b class="ok">${stats.n}</b> 筆（${okRate.toFixed(1)}% of TXT），TXT 未配對 <b class="warn">${matched.txtUnmatched}</b>，XQ 未配對 <b class="bad">${matched.xqUnmatched}</b></div>`,
      `<div class="muted">容忍：時間 ±${tolMin} 分，價格 ±${tolPx} 點。工作表：<span class="mono">${esc(xqParsed.sheetName)}</span></div>`
    ].join(""));

    el.btnExport.disabled = false;
  }

  // Events
  el.tolMin.addEventListener("input", ()=>{ el.tolMinLabel.textContent = el.tolMin.value; });
  el.tolPx.addEventListener("input", ()=>{ el.tolPxLabel.textContent = el.tolPx.value; });

  el.txtFile.addEventListener("change", async (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    await loadTxtFile(f);
    setStatus(`已載入 TXT：<span class="mono">${esc(state.txtName)}</span>`);
  });

  el.xlsFile.addEventListener("change", async (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    await loadXlsFile(f);
    setStatus(`已載入 XQ：<span class="mono">${esc(state.xlsName)}</span>（交易分析：${state.xqRows.trades.length} 筆）`);
  });

  el.btnRun.addEventListener("click", runRecon);
  el.btnExport.addEventListener("click", ()=> exportCSV(state.lastResult));

  // Drag & drop
  ["dragenter","dragover"].forEach(ev=>{
    el.drop.addEventListener(ev, (e)=>{ e.preventDefault(); e.stopPropagation(); el.drop.classList.add("drag"); });
  });
  ["dragleave","drop"].forEach(ev=>{
    el.drop.addEventListener(ev, (e)=>{ e.preventDefault(); e.stopPropagation(); el.drop.classList.remove("drag"); });
  });
  el.drop.addEventListener("drop", async (e)=>{
    const files = Array.from(e.dataTransfer.files || []);
    for(const f of files){
      const name = (f.name||"").toLowerCase();
      if(name.endsWith(".xlsx")){
        await loadXlsFile(f);
      }else{
        await loadTxtFile(f);
      }
    }
    setStatus(`已載入：TXT=<span class="mono">${esc(state.txtName||"—")}</span>，XQ=<span class="mono">${esc(state.xlsName||"—")}</span>。`);
  });

  // init
  el.tolMinLabel.textContent = el.tolMin.value;
  el.tolPxLabel.textContent = el.tolPx.value;
})();
