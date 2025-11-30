// 0807-single-cloud.js
// - Supabase 自動抓最新 0807 TXT + 基準合併
// - 也支援本機「選擇檔案」/「剪貼簿貼上」
// - TXT 新格式：
//   1) 第一行：BeginTime=... EndTime=... ForceExitTime=... FixTP_L=... ... RSI_ShortTh=...
//   2) 之後每行：YYYYMMDDhhmmss 價格 動作
// - 本腳本會把新格式轉成 single.js 原來的舊格式：
//   第一行：84800.000000 131000.000000 131200.000000 250.000000 40.000000 20.000000 2.000000 110.000000 70.000000 7.000000 5.000000 0.250000 0.000000 80.000000 10.000000
//   之後每行：20231201093900.000000 17366.000000 新買
(function () {
  const $ = s => document.querySelector(s);
  const status   = $('#autostatus'); if (status) status.style.whiteSpace = 'pre-wrap';
  const elLatest = $('#latestName'), elBase = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');
  const fileInput= $('#file');
  const btnClip  = $('#btn-clip');

  // Supabase
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (u,o={}) => fetch(u,{...o, cache:'no-store'}) }
  });

  const WANT = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function set(msg, bad=false){
    if(status){
      status.textContent = msg;
      status.style.color = bad ? '#c62828' : '#666';
    }
  }

  function pubUrl(path){
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || '#';
  }

  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, {
      limit:1000,
      sortBy:{ column:'name', order:'asc' }
    });
    if(error) throw new Error(error.message);
    return (data||[]).filter(it => !(it.id===null && !it.metadata))
      .map(it => ({
        name:it.name,
        fullPath:p+it.name,
        updatedAt: it.updated_at? Date.parse(it.updated_at):0,
        size: it.metadata?.size||0
      }));
  }

  async function listCandidates(){
    const u = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }

  function lastDateScore(name){
    const m = String(name).match(/\b(20\d{6})\b/g);
    return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0;
  }

  // ===== 文字前處理 =====
  function normalizeText(raw){
    let s = (raw || '').replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'');
    s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'');   // 控制碼
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    const lines = s.split('\n').map(l=>l.replace(/\s+/g,' ').trim());
    return lines.join('\n');
  }

  // 新版 header（含 =) → 轉成舊格式數字 param line
  function headerToNumeric(line){
    const kv = {};
    line.split(/\s+/).forEach(pair=>{
      const [k,v] = pair.split('=');
      if(k && v!==undefined) kv[k.trim()] = v.trim();
    });
    // 依照舊版順序組成 15 個數字
    const order = [
      'BeginTime','EndTime','ForceExitTime',
      'FixTP_L','FixSL_L','DynTPFactor_L','DynSLFactor_L',
      'FixTP_S','FixSL_S','DynTPFactor_S','DynSLFactor_S',
      'BufferATR','CoolDownBars','RSI_LongTh','RSI_ShortTh'
    ];
    const nums = order.map(k => {
      const v = Number(kv[k]);
      return Number.isFinite(v) ? v : 0;
    });
    return nums.map(x => x.toFixed(6)).join(' ');
  }

  // 舊版（第一行全數字）→ 直接當 param line
  function isNumericParamLine(line){
    return /^(\d+(\.\d+)?\s+){4,}\d+(\.\d+)?$/.test(line.trim());
  }

  // 把整份 TXT 轉成：{ paramLine, canonTrades, ok }
  function preprocess(raw){
    const norm  = normalizeText(raw);
    const lines = norm.split('\n').filter(x=>x.length>0);
    if(!lines.length) return { paramLine:'', canonTrades:'', ok:0 };

    let paramLine = '';
    let bodyLines = [];

    const first = lines[0];

    if(first.indexOf('=') !== -1){
      // 新版 header
      paramLine = headerToNumeric(first);
      bodyLines = lines.slice(1);
    }else if(isNumericParamLine(first)){
      // 舊版 param 行
      paramLine = first;
      bodyLines = lines.slice(1);
    }else{
      // 非預期：全部當 body，paramLine 給空
      paramLine = '';
      bodyLines = lines;
    }

    const { canon, ok } = canonicalize(bodyLines.join('\n'));
    return { paramLine, canonTrades:canon, ok };
  }

  // 身體部分 canonical
  function canonicalize(txt){
    const out=[], lines = txt.split('\n'); let ok=0,bad=0;
    for(const l of lines){
      const line = l.trim();
      if(!line) continue;
      const m = line.match(EXTRACT_RE);
      if(m){
        const ts = m[1];
        const px = Number(m[2]);
        const p6 = Number.isFinite(px) ? px.toFixed(6) : m[2];
        const act= m[3];
        out.push(`${ts}.000000 ${p6} ${act}`);
        ok++;
      }else{
        bad++;
      }
    }
    return { canon: out.join('\n'), ok, bad };
  }

  // Supabase 下載並 preprocess
  async function fetchSmart(url){
    const res = await fetch(url,{cache:'no-store'});
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();

    for (const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{
        const td   = new TextDecoder(enc,{fatal:false});
        const text = td.decode(buf);
        const { paramLine, canonTrades, ok } = preprocess(text);
        if (ok > 0) return { enc, paramLine, canonTrades, ok };
      }catch(e){}
    }
    const td   = new TextDecoder('utf-8');
    const text = td.decode(buf);
    const { paramLine, canonTrades, ok } = preprocess(text);
    return { enc:'utf-8', paramLine, canonTrades, ok };
  }

  // canonical 解析成 rows（for merge 與期間）
  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    for(const line of text.split('\n')){
      const m = line.match(CANON_RE);
      if (m) rows.push({ ts:m[1], line });
    }
    rows.sort((a,b)=> a.ts.localeCompare(b.ts));
    return rows;
  }

  // 合併：combinedCanon = base 全部 + (latest 中 ts > baseMax 的行)
  function mergeByBaseline(baseCanon, latestCanon){
    const A = parseCanon(baseCanon);
    const B = parseCanon(latestCanon);
    const baseMin = A.length ? A[0].ts.slice(0,8) : (B.length? B[0].ts.slice(0,8) : '');
    const baseMax = A.length ? A[A.length-1].ts : '';
    const added   = baseMax ? B.filter(x => x.ts > baseMax).map(x => x.line)
                            : B.map(x => x.line);
    const mergedLines = [...A.map(x => x.line), ...added];
    const endDay = mergedLines.length
      ? mergedLines[mergedLines.length-1].match(CANON_RE)[1].slice(0,8)
      : baseMin;
    return { combined: mergedLines.join('\n'), start8: baseMin, end8: endDay };
  }

  // 把我們要給 single.js 的文字塞回 shared.js（readAsTextAuto）
  function patchSharedReaders(decodedText){
    if (window.SHARED) {
      if (typeof window.SHARED.readAsTextAuto === 'function') {
        const orig = window.SHARED.readAsTextAuto;
        window.SHARED.readAsTextAuto = async function(){
          window.SHARED.readAsTextAuto = orig;
          return decodedText;
        };
      }
      if (typeof window.SHARED.paramsLabel === 'function') {
        const origPL = window.SHARED.paramsLabel;
        window.SHARED.paramsLabel = function(arg){
          let arr = Array.isArray(arg) ? arg : (arg && Array.isArray(arg.raw) ? arg.raw : []);
          try { return origPL(arr); }
          catch { return (arr.slice(0,2).join(" ｜ ")) || "—"; }
        };
      }
    }
  }

  async function feedToSingle(filename, decodedText){
    const input = $('#file');
    if(!input){ set('找不到 #file（single.js 未載入）', true); return; }
    patchSharedReaders(decodedText);
    const file = new File([decodedText], filename || '0807.txt', { type:'text/plain' });
    const dt   = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  // manifest：download（不存在就當 null）
  async function readManifest(){
    try{
      const { data, error } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
      if (error || !data) return null;
      return JSON.parse(await data.text());
    }catch{ return null; }
  }
  async function writeManifest(obj){
    const blob = new Blob([JSON.stringify(obj,null,2)], { type:'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(MANIFEST_PATH, blob, {
      upsert:true,
      cacheControl:'0',
      contentType:'application/json'
    });
    if (error) throw new Error(error.message);
  }

  // ===== 本機 TXT：選檔 or 剪貼簿 → 覆蓋分析 =====
  async function handleLocalText(text, filename){
    const { paramLine, canonTrades, ok } = preprocess(text);
    if (ok === 0){
      set('本機 TXT 沒有合法的「時間 價格 動作」行。', true);
      return;
    }
    const decodedText = (paramLine ? paramLine + '\n' : '') + canonTrades;
    set(`已載入本機檔案 ${filename||''}，共有 ${ok} 筆交易行，開始分析…`);
    await feedToSingle(filename || 'local_0807.txt', decodedText);
  }

  if (fileInput){
    fileInput.addEventListener('change', async (ev)=>{
      const f = ev.target.files && ev.target.files[0];
      if(!f) return;
      try{
        const txt = await f.text();
        await handleLocalText(txt, f.name);
      }catch(e){
        set('讀取本機檔案失敗：' + (e.message||e), true);
      }
    });
  }

  if (btnClip){
    btnClip.addEventListener('click', async ()=>{
      try{
        const txt = await navigator.clipboard.readText();
        if(!txt){ alert('剪貼簿沒有文字'); return; }
        await handleLocalText(txt, 'clipboard.txt');
      }catch(e){
        alert('無法讀取剪貼簿內容，請改用「選擇檔案」。');
      }
    });
  }

  // ===== Supabase 自動流程 =====
  async function boot(){
    try{
      const url = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      // 1) 最新檔
      let latest=null, list=[];
      if (paramFile){
        latest = {
          name: paramFile.split('/').pop() || '0807.txt',
          fullPath: paramFile,
          from:'url'
        };
      } else {
        set('從 Supabase（reports）讀取清單…');
        list = (await listCandidates()).filter(f => WANT.test(f.name) || WANT.test(f.fullPath));
        list.sort((a,b)=>{
          const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if (sa!==sb) return sb-sa;
          if (a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        latest = list[0];
      }
      if(!latest){
        set('找不到檔名含「0807」的 TXT（可用 ?file= 指定），也可以直接選擇本機檔案。', true);
        return;
      }
      elLatest.textContent = latest.name;

      // 2) 基準（manifest，否則用次新）
      let base=null;
      const manifest = await readManifest();
      if (manifest?.baseline_path){
        base = list.find(x => x.fullPath===manifest.baseline_path)
            || { name: manifest.baseline_path.split('/').pop(), fullPath: manifest.baseline_path };
      } else {
        base = list[1] || null;
      }
      elBase.textContent = base ? base.name : '（尚無）';

      // 3) 下載 + preprocess
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0){
        set(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedCanon = rNew.canonTrades;
      let start8 = '', end8 = '';
      if (base){
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);
        const m       = mergeByBaseline(rBase.canonTrades, rNew.canonTrades);
        mergedCanon   = m.combined;
        start8        = m.start8;
        end8          = m.end8;
      } else {
        const rows = parseCanon(rNew.canonTrades);
        start8 = rows.length ? rows[0].ts.slice(0,8) : '';
        end8   = rows.length ? rows[rows.length-1].ts.slice(0,8) : '';
      }

      elPeriod.textContent = `期間：${start8 || '—'} 開始到 ${end8 || '—'} 結束`;

      // 設最新為基準
      btnBase.disabled = false;
      btnBase.onclick = async ()=>{
        try{
          const payload = {
            baseline_path: latest.from==='url' ? latest.fullPath : latest.fullPath,
            updated_at: new Date().toISOString()
          };
          await writeManifest(payload);
          btnBase.textContent = '已設為基準';
        }catch(e){
          set('寫入基準失敗：'+(e.message||e), true);
        }
      };

      const paramLine = rNew.paramLine || '';  // 用最新檔的參數
      const decodedText = (paramLine ? paramLine + '\n' : '') + mergedCanon;

      set('已從 Supabase 載入（合併後）資料，開始分析…（可用本機檔案覆蓋）');
      await feedToSingle(latest.name, decodedText);

    }catch(err){
      set('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
