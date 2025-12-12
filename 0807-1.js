// 0807-1.js — 完整版（按鈕先綁定；ALL 保持 single-trades.js KPI；區間只切圖/日損益/明細）
//
// 行為：
// - 全區間（ALL）：完全不動 single-trades.js 的 KPI/圖/明細（保持原樣）
// - 非全區間：以「最後交易日(全區間最大交易日)」為錨，計算 startYmd，然後
//   1) 交易明細只顯示區間內每筆交易，並把累積欄位從區間起點歸0重算
//   2) 主圖與下方（日損益圖）改成日級 labels（YYYY/MM/DD），並用區間日序列重畫
//   3) 主圖的總/多/空（含滑價/理論）都從 0 開始；最高/最低 marker 不處理（清空避免錯畫）
//
// 關鍵修正：
// - Range 按鈕在 DOMContentLoaded 就綁定，不再等待 snapshot 成功才綁，因此不會「沒反應」
// - 點按後若資料未就緒，applyRange 會自動重試

(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  // -----------------------------
  // DOM
  // -----------------------------
  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const btnBase  = $('#btnSetBaseline');

  const rangeRow     = $('#rangeRow');
  const tradesBody   = $('#tradesBody');
  const equityCanvas = $('#equityChart');
  const dailyCanvas  = $('#weeklyPnlChart'); // 你頁面這張其實是日損益圖

  const slipInput = $('#slipInput');
  const runBtn    = $('#runBtn');

  if (status) status.style.whiteSpace = 'pre-wrap';
  const setStatus = (msg, bad=false) => {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  };

  // -----------------------------
  // slip=2：開頁即算
  // -----------------------------
  function forceSlip2(){
    if(!slipInput) return;
    slipInput.value='2';
    slipInput.dispatchEvent(new Event('input',{bubbles:true}));
    slipInput.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function safeClickRun(times=4){
    if(!runBtn) return;
    const delays=[0,80,250,600];
    for(let i=0;i<Math.min(times,delays.length);i++){
      setTimeout(()=>{ forceSlip2(); runBtn.click(); }, delays[i]);
    }
  }

  // -----------------------------
  // Supabase + merge（對齊 0807.js）
  // -----------------------------
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";
  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  const pubUrl = (path)=> sb.storage.from(BUCKET).getPublicUrl(path)?.data?.publicUrl || '#';

  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error) throw new Error(error.message);
    return (data||[])
      .filter(it => !(it.id === null && !it.metadata))
      .map(it => ({ name:it.name, fullPath:p+it.name, updatedAt: it.updated_at?Date.parse(it.updated_at):0, size: it.metadata?.size||0 }));
  }
  async function listCandidates(){
    const u=new URL(location.href);
    const prefix=u.searchParams.get('prefix')||'';
    return listOnce(prefix);
  }
  function lastDateScore(name){
    const m=String(name).match(/\b(20\d{6})\b/g);
    if(!m||!m.length) return 0;
    return Math.max(...m.map(s=>+s||0));
  }

  async function readManifest(){
    try{
      const {data,error}=await sb.storage.from(BUCKET).download(MANIFEST_PATH);
      if(error||!data) return null;
      return JSON.parse(await data.text());
    }catch{ return null; }
  }
  async function writeManifest(obj){
    const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});
    const {error}=await sb.storage.from(BUCKET).upload(MANIFEST_PATH, blob, {upsert:true,cacheControl:'0',contentType:'application/json'});
    if(error) throw new Error(error.message);
  }

  function normalizeText(raw){
    let s = raw
      .replace(/\ufeff/gi,'')
      .replace(/\u200b|\u200c|\u200d/gi,'')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'');
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    return s.split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
  }
  function canonicalize(txt){
    const out=[]; let ok=0;
    for(const l of (txt||'').split('\n')){
      const m=l.match(EXTRACT_RE);
      if(m){
        const ts=m[1];
        const pxN=Number(m[2]);
        const px6=Number.isFinite(pxN)?pxN.toFixed(6):m[2];
        const act=m[3];
        out.push(`${ts}.000000 ${px6} ${act}`);
        ok++;
      }
    }
    return {canon:out.join('\n'), ok};
  }
  async function fetchSmart(url){
    const res=await fetch(url,{cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer();
    for(const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{
        const td=new TextDecoder(enc,{fatal:false});
        const norm=normalizeText(td.decode(buf));
        const {canon,ok}=canonicalize(norm);
        if(ok>0) return {enc,canon,ok};
      }catch{}
    }
    const td=new TextDecoder('utf-8');
    const norm=normalizeText(td.decode(buf));
    const {canon,ok}=canonicalize(norm);
    return {enc:'utf-8',canon,ok};
  }

  function parseCanon(text){
    const rows=[];
    for(const line of (text||'').split('\n')){
      const m=line.match(CANON_RE);
      if(m) rows.push({ts:m[1], line});
    }
    rows.sort((a,b)=>a.ts.localeCompare(b.ts));
    return rows;
  }
  function mergeByBaseline(baseText, latestText){
    const A=parseCanon(baseText);
    const B=parseCanon(latestText);
    const baseMax=A.length?A[A.length-1].ts:'';
    const added=baseMax?B.filter(x=>x.ts>baseMax).map(x=>x.line):B.map(x=>x.line);
    return [...A.map(x=>x.line), ...added].join('\n');
  }
  function addFakeInpos(text){
    const out=[];
    const lines=(text||'').split('\n').map(s=>s.trim()).filter(Boolean);
    for(const line of lines){
      const m=line.match(CANON_RE);
      if(!m) continue;
      const ts=m[1], act=m[3];
      if(act==='新買' || act==='新賣'){
        const dir=(act==='新買')?1:-1;
        out.push(line);
        out.push(`${ts}.000000 0 0 ${dir} 0 INPOS`);
      } else out.push(line);
    }
    return out.join('\n');
  }

  async function feedToSingleTrades(filename, mergedText){
    const fileInput=$('#fileInput');
    const fname=filename||'0807.txt';
    const file=new File([mergedText], fname, {type:'text/plain'});
    forceSlip2();
    if(window.__singleTrades_setFile) window.__singleTrades_setFile(file);
    if(fileInput){
      const dt=new DataTransfer();
      dt.items.add(file);
      fileInput.files=dt.files;
      fileInput.dispatchEvent(new Event('change',{bubbles:true}));
    }
    safeClickRun(4);
  }

  // -----------------------------
  // Date & number helpers
  // -----------------------------
  const pad2 = (n)=>String(n).padStart(2,'0');
  const ymdToDate = (ymd)=>{
    if(!ymd||ymd.length!==8) return null;
    const y=+ymd.slice(0,4), m=+ymd.slice(4,6), d=+ymd.slice(6,8);
    return new Date(y,m-1,d);
  };
  const dateToYmd = (d)=>`${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}`;
  const mondayOfWeek = (d)=>{
    const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());
    const day=x.getDay();
    const delta=(day===0)?-6:(1-day);
    x.setDate(x.getDate()+delta);
    return x;
  };

  function parseYmdFromText(text){
    const s=String(text||'').trim();
    let m=s.match(/\b(20\d{12})\b/);
    if(m) return m[1].slice(0,8);
    m=s.match(/\b(20\d{6})\b/);
    if(m) return m[1];
    m=s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if(m) return `${m[1]}${pad2(m[2])}${pad2(m[3])}`;
    return '';
  }

  function parseNum(text){
    const s=String(text||'').trim();
    if(!s||s==='—'||s==='-') return NaN;
    const v=Number(s.replace(/,/g,''));
    return Number.isFinite(v)?v:NaN;
  }
  const formatNum = (n)=>{
    if(!Number.isFinite(n)) return '—';
    const sign=n<0?'-':'';
    const x=Math.abs(Math.round(n));
    return sign + x.toLocaleString('en-US');
  };

  // -----------------------------
  // Chart helpers
  // -----------------------------
  function getChart(canvas){
    if(!canvas||!window.Chart) return null;
    try { return window.Chart.getChart(canvas) || null; } catch { return null; }
  }

  // -----------------------------
  // Snapshot (restore ALL)
  // -----------------------------
  const SNAP = {
    ready:false,
    endYmd:null,
    tradesHTML:null,
    eq:{labels:null,data:null},
    dy:{labels:null,data:null},
    // ALL KPI 不動，所以不必 snapshot KPI
  };

  function snapshotOnce(){
    if(SNAP.ready) return true;
    const eq=getChart(equityCanvas);
    const dy=getChart(dailyCanvas);
    if(!eq||!dy||!tradesBody) return false;
    if(!eq.data?.labels?.length || !eq.data?.datasets?.length) return false;
    if(!dy.data?.labels?.length || !dy.data?.datasets?.length) return false;

    SNAP.eq.labels = eq.data.labels.slice();
    SNAP.eq.data = eq.data.datasets.map(ds=>Array.isArray(ds.data)?ds.data.slice():[]);
    SNAP.dy.labels = dy.data.labels.slice();
    SNAP.dy.data = dy.data.datasets.map(ds=>Array.isArray(ds.data)?ds.data.slice():[]);
    SNAP.tradesHTML = tradesBody.innerHTML;

    // endYmd = max ymd in trades table
    const trs = Array.from(tradesBody.querySelectorAll('tr'));
    const yset = new Set();
    for(const tr of trs){
      const ymd = parseYmdFromText(tr.textContent);
      if(ymd) yset.add(ymd);
    }
    const list = Array.from(yset).sort();
    if(!list.length) return false;
    SNAP.endYmd = list[list.length-1];

    SNAP.ready = true;
    return true;
  }

  // -----------------------------
  // Range start rule (anchor = endYmd)
  // -----------------------------
  function rangeStartYmd(endYmd, code){
    if(code==='ALL') return '';
    const endDate=ymdToDate(endYmd);
    if(!endDate) return '';
    if(code==='1W') return dateToYmd(mondayOfWeek(endDate));
    if(code==='2W'){ const m=mondayOfWeek(endDate); m.setDate(m.getDate()-7); return dateToYmd(m); }
    const daysMap={ '1M':30,'2M':60,'3M':91,'6M':182,'1Y':365 };
    const n=daysMap[code]||0;
    if(!n) return '';
    const s=new Date(endDate.getFullYear(),endDate.getMonth(),endDate.getDate());
    s.setDate(s.getDate()-n);
    return dateToYmd(s);
  }

  function setActiveRangeBtn(code){
    if(!rangeRow) return;
    const btns=Array.from(rangeRow.querySelectorAll('.range-btn'));
    btns.forEach(b=>b.classList.toggle('active', (b.dataset.range===code)));
  }

  // -----------------------------
  // Build daily series from trades table (range)
  // -----------------------------
  function buildDailySeriesFromTrades(startYmd, endYmd){
    const table = tradesBody?.closest('table');
    if(!table) return null;

    const ths = Array.from(table.querySelectorAll('thead th')).map(th=>(th.textContent||'').trim());
    const idxDateTime = ths.findIndex(t=>t.includes('日期時間'));
    const idxType     = ths.findIndex(t=>t.includes('類別'));
    const idxTheo     = ths.findIndex(t=>t.includes('理論淨損益'));
    const idxReal     = ths.findIndex(t=>t.includes('實際淨損益'));
    const idxCumTheo  = ths.findIndex(t=>t.includes('累積理論淨損益'));
    const idxCumReal  = ths.findIndex(t=>t.includes('累積實際淨損益'));

    const rows = Array.from(tradesBody.querySelectorAll('tr'));
    const dayMap = new Map();

    const keptRows = [];

    for(const tr of rows){
      const tds = Array.from(tr.querySelectorAll('td'));
      if(!tds.length) continue;

      const dtText = (idxDateTime>=0 && tds[idxDateTime]) ? tds[idxDateTime].textContent : tr.textContent;
      const ymd = parseYmdFromText(dtText);
      if(!ymd) continue;
      if(ymd < startYmd || ymd > endYmd) continue;

      keptRows.push(tr);

      if(!dayMap.has(ymd)){
        dayMap.set(ymd,{ theo:0, real:0, longTheo:0, longReal:0, shortTheo:0, shortReal:0 });
      }
      const agg = dayMap.get(ymd);

      const typ = (idxType>=0 && tds[idxType]) ? (tds[idxType].textContent||'').trim() : '';
      const theo = (idxTheo>=0 && tds[idxTheo]) ? parseNum(tds[idxTheo].textContent) : NaN;
      const real = (idxReal>=0 && tds[idxReal]) ? parseNum(tds[idxReal].textContent) : NaN;

      if(Number.isFinite(theo)) agg.theo += theo;
      if(Number.isFinite(real)) agg.real += real;

      if(typ.includes('平賣')){
        if(Number.isFinite(theo)) agg.longTheo += theo;
        if(Number.isFinite(real)) agg.longReal += real;
      } else if(typ.includes('平買')){
        if(Number.isFinite(theo)) agg.shortTheo += theo;
        if(Number.isFinite(real)) agg.shortReal += real;
      }
    }

    const days = Array.from(dayMap.keys()).sort();
    if(!days.length) return null;

    // daily
    const dailyTheo=[], dailyReal=[];
    const dailyLongTheo=[], dailyLongReal=[], dailyShortTheo=[], dailyShortReal=[];
    // cum from 0
    let cumTheo=0, cumReal=0, cumLongTheo=0, cumLongReal=0, cumShortTheo=0, cumShortReal=0;
    const cumTheoArr=[], cumRealArr=[], cumLongTheoArr=[], cumLongRealArr=[], cumShortTheoArr=[], cumShortRealArr=[];

    for(const d of days){
      const a = dayMap.get(d);
      dailyTheo.push(a.theo);
      dailyReal.push(a.real);

      dailyLongTheo.push(a.longTheo);
      dailyLongReal.push(a.longReal);
      dailyShortTheo.push(a.shortTheo);
      dailyShortReal.push(a.shortReal);

      cumTheo += a.theo;
      cumReal += a.real;
      cumLongTheo += a.longTheo;
      cumLongReal += a.longReal;
      cumShortTheo += a.shortTheo;
      cumShortReal += a.shortReal;

      cumTheoArr.push(cumTheo);
      cumRealArr.push(cumReal);
      cumLongTheoArr.push(cumLongTheo);
      cumLongRealArr.push(cumLongReal);
      cumShortTheoArr.push(cumShortTheo);
      cumShortRealArr.push(cumShortReal);
    }

    return {
      days,
      keptRows,
      idxCumTheo, idxCumReal, idxTheo, idxReal,
      dailyTheo, dailyReal,
      dailyLongTheo, dailyLongReal, dailyShortTheo, dailyShortReal,
      cumTheoArr, cumRealArr,
      cumLongTheoArr, cumLongRealArr, cumShortTheoArr, cumShortRealArr
    };
  }

  // -----------------------------
  // Apply range
  // -----------------------------
  function applyRange(code){
    if(!snapshotOnce()){
      setStatus(`收到點擊：${code}（資料未就緒，重試中…）`);
      setTimeout(()=>applyRange(code), 200);
      return;
    }

    const eq=getChart(equityCanvas);
    const dy=getChart(dailyCanvas);
    if(!eq||!dy) return;

    // restore ALL baseline first
    eq.data.labels = SNAP.eq.labels.slice();
    eq.data.datasets.forEach((ds,k)=> ds.data = (SNAP.eq.data[k]||[]).slice());
    eq.update('none');

    dy.data.labels = SNAP.dy.labels.slice();
    dy.data.datasets.forEach((ds,k)=> ds.data = (SNAP.dy.data[k]||[]).slice());
    dy.update('none');

    tradesBody.innerHTML = SNAP.tradesHTML;

    const endYmd = SNAP.endYmd;
    const startYmd = rangeStartYmd(endYmd, code);

    if(code==='ALL' || !startYmd){
      setActiveRangeBtn('ALL');
      setStatus(`全區間：~ ${endYmd}（僅全區間計算 KPI）`);
      return;
    }

    // Non-ALL: rebuild charts from daily series and filter trades; do NOT touch KPI tables
    const series = buildDailySeriesFromTrades(startYmd, endYmd);
    if(!series){
      setStatus(`區間內無交易損益資料：${startYmd}~${endYmd}`, true);
      setActiveRangeBtn(code);
      return;
    }

    // 交易明細：只顯示區間內每筆交易（依你需求），且累積從0重算
    tradesBody.innerHTML = series.keptRows.map(tr=>tr.outerHTML).join('');

    // 重算累積（區間起點歸0）
    if(series.idxCumTheo>=0 && series.idxCumReal>=0 && series.idxTheo>=0 && series.idxReal>=0){
      let cumTheo=0, cumReal=0;
      const rows = Array.from(tradesBody.querySelectorAll('tr'));
      for(const tr of rows){
        const tds = Array.from(tr.querySelectorAll('td'));
        const theo = parseNum(tds[series.idxTheo]?.textContent);
        const real = parseNum(tds[series.idxReal]?.textContent);
        if(Number.isFinite(theo)) cumTheo += theo;
        if(Number.isFinite(real)) cumReal += real;
        if(tds[series.idxCumTheo]) tds[series.idxCumTheo].textContent = formatNum(cumTheo);
        if(tds[series.idxCumReal]) tds[series.idxCumReal].textContent = formatNum(cumReal);
      }
      tradesBody.innerHTML = rows.map(tr=>tr.outerHTML).join('');
    }

    // 圖表 labels：日級 YYYY/MM/DD（你要 2025/12/8~2025/12/10 這種）
    const dayLabels = series.days.map(ymd => `${ymd.slice(0,4)}/${+ymd.slice(4,6)}/${+ymd.slice(6,8)}`.replace(/\/(\d)\b/g,'/$1')); 
    // 上面為了顯示不補0（如 2025/12/8），若你要 2025/12/08 可以改回補0

    // 主圖：用日級累積序列（已從0起算）
    eq.data.labels = dayLabels;

    eq.data.datasets.forEach(ds=>{
      const lab = String(ds.label||'');
      if(lab.includes('含滑價') && lab.includes('總損益')) ds.data = series.cumRealArr.slice();
      else if(lab.includes('理論') && lab.includes('總損益')) ds.data = series.cumTheoArr.slice();
      else if(lab.includes('多頭') && lab.includes('含滑價')) ds.data = series.cumLongRealArr.slice();
      else if(lab.includes('多頭') && lab.includes('理論')) ds.data = series.cumLongTheoArr.slice();
      else if(lab.includes('空頭') && lab.includes('含滑價')) ds.data = series.cumShortRealArr.slice();
      else if(lab.includes('空頭') && lab.includes('理論')) ds.data = series.cumShortTheoArr.slice();
      else if(lab.includes('期間最高') || lab.includes('期間最低')) ds.data = []; // 避免錯畫
      else ds.data = []; // 其他線不顯示，避免對不上
    });

    eq.update('none');

    // 下方日損益圖：以「實際日損益」拆成正/負兩個 dataset（保留你原本圖例語意）
    dy.data.labels = dayLabels;
    dy.data.datasets.forEach(ds=>{
      const lab = String(ds.label||'');
      if(lab.includes('獲利')) ds.data = series.dailyReal.map(v => v > 0 ? v : 0);
      else if(lab.includes('虧損')) ds.data = series.dailyReal.map(v => v < 0 ? v : 0);
      else ds.data = new Array(dayLabels.length).fill(0);
    });
    dy.update('none');

    setActiveRangeBtn(code);
    setStatus(`區間：${code}（${startYmd}~${endYmd}）｜區間僅顯示圖表/日損益/明細`);
  }

  // -----------------------------
  // Bind buttons immediately (fix "no response")
  // -----------------------------
  function hookRangeButtons(){
    if(!rangeRow) return;
    if(rangeRow.__bound) return;
    rangeRow.__bound = true;

    rangeRow.addEventListener('click', (e)=>{
      const btn = e.target.closest('.range-btn');
      if(!btn) return;
      const code = btn.dataset.range || 'ALL';
      setStatus(`收到點擊：${code}（若資料未就緒會自動重試）`);
      applyRange(code);
    }, true);
  }

  function waitAndInit(){
    let tries=0;
    const timer=setInterval(()=>{
      tries++;
      if(snapshotOnce()){
        clearInterval(timer);
        applyRange('ALL');
      }
      if(tries>360) clearInterval(timer);
    }, 140);
  }

  // -----------------------------
  // Boot: merge + feed to single-trades.js
  // -----------------------------
  async function boot(){
    try{
      if(!sb){
        setStatus('Supabase SDK 未載入或初始化失敗。', true);
        return;
      }

      const url=new URL(location.href);
      const paramFile=url.searchParams.get('file');

      let latest=null;
      let list=[];

      if(paramFile){
        latest={ name:paramFile.split('/').pop()||'0807.txt', fullPath:paramFile, from:'url' };
      } else {
        setStatus('從 Supabase（reports）讀取清單…');
        list=(await listCandidates()).filter(f=>WANT.test(f.name)||WANT.test(f.fullPath));
        if(!list.length){
          setStatus('找不到檔名含「0807」的 TXT（可用 ?file= 指定）。', true);
          return;
        }
        list.sort((a,b)=>{
          const sa=lastDateScore(a.name), sb2=lastDateScore(b.name);
          if(sa!==sb2) return sb2-sa;
          if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        latest=list[0];
      }

      if(!latest){
        setStatus('找不到可分析的 0807 檔案。', true);
        return;
      }
      if(elLatest) elLatest.textContent=latest.name;

      // baseline
      let base=null;
      if(!paramFile){
        const manifest=await readManifest();
        if(manifest?.baseline_path){
          base = list.find(x=>x.fullPath===manifest.baseline_path) ||
                 { name: manifest.baseline_path.split('/').pop()||manifest.baseline_path, fullPath: manifest.baseline_path };
        } else {
          base = list[1] || null;
        }
      }
      if(elBase) elBase.textContent=base?base.name:'（尚無）';

      // download latest
      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if(rNew.ok===0){
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedText = rNew.canon;

      if(base){
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase = await fetchSmart(baseUrl);
        mergedText = mergeByBaseline(rBase.canon, rNew.canon);
      }

      // baseline button
      if(btnBase){
        btnBase.disabled=false;
        btnBase.onclick = async ()=>{
          try{
            await writeManifest({ baseline_path: latest.fullPath, updated_at: new Date().toISOString() });
            btnBase.textContent='已設為基準';
          }catch(e){
            setStatus('寫入基準失敗：'+(e.message||e), true);
          }
        };
      }

      // feed single-trades.js (ALL computes KPI)
      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（全區間含 KPI；區間只顯示圖表/日損益/明細）。');

      waitAndInit();
    }catch(err){
      console.error(err);
      setStatus('初始化失敗：'+(err.message||err), true);
    }
  }

  // 先綁按鈕（最重要：避免「按了沒反應」）
  document.addEventListener('DOMContentLoaded', ()=>{
    forceSlip2();
    hookRangeButtons();
    boot();
  });

})();
