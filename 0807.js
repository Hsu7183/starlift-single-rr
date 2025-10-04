// 0807.js — 0807 專用自動分析：智慧解碼 + 正規化/重建 +「時間戳對齊」差異比對 + 基準 manifest
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus'); if (status) status.style.whiteSpace = 'pre-wrap';
  const diffStatus = $('#diffStatus');
  const elLatest = $('#latestName'), elBase = $('#baseName');
  const btnCopy = $('#btnCopyNew'), btnBase = $('#btnSetBaseline');
  const appendBox = $('#appendBox');
  const changeWrap = $('#changeTableWrap'), changeTbody = $('#changeTable');

  // === Supabase（與 upload.html 相同） ===
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (u, o={}) => fetch(u, { ...o, cache:'no-store' }) }
  });

  // === 偏好/常數 ===
  const WANT = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";       // 記錄「基準檔」位置
  // 嚴格 canonical 行：YYYYMMDDhhmmss.000000 <六位小數> <動作>
  const STRICT_CANON = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  // 放寬抽取：容許 .000000 缺漏、價位 1~6 位、行首行尾雜字
  const EXTRACT_TRADE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function set(msg, bad=false){ if(status){ status.textContent=msg; status.style.color = bad?'#c62828':'#666'; } }
  function setDiff(msg, bad=false){ if(diffStatus){ diffStatus.textContent=msg; diffStatus.style.color = bad?'#c62828':'#666'; } }
  function pubUrl(path){ const { data } = sb.storage.from(BUCKET).getPublicUrl(path); return data?.publicUrl || '#'; }

  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{ column:'name', order:'asc' }});
    if(error) throw new Error(error.message);
    return (data||[]).filter(it => !(it.id===null && !it.metadata))
      .map(it => ({ name:it.name, fullPath:p+it.name, updatedAt: it.updated_at? Date.parse(it.updated_at):0, size: it.metadata?.size||0 }));
  }
  async function listCandidates(){
    const u = new URL(location.href); const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }
  function lastDateScore(name){ const m=String(name).match(/\b(20\d{6})\b/g); return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0; }

  // ========== 解碼 / 正規化 / 重建 ==========
  function normalizeText(raw){
    // 去 BOM、零寬字、控制碼；統一換行、空白
    let s = raw.replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'');
    s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'');   // 控制碼（保留 \n）
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    const lines = s.split('\n').map(l => l.replace(/\s+/g,' ').trim()).filter(Boolean);
    return lines.join('\n');
  }
  // 抽取 → canonical 行
  function canonicalize(txt){
    const out=[], lines = txt.split('\n');
    let ok=0, bad=0, samples=[];
    for(const l of lines){
      const m = l.match(EXTRACT_TRADE);
      if(m){
        const ts = m[1];
        const px = Number(m[2]); const p6 = Number.isFinite(px) ? px.toFixed(6) : m[2];
        const act= m[3];
        const canon = `${ts}.000000 ${p6} ${act}`;
        out.push(canon); ok++;
      }else{
        if (/(\d{14})/.test(l) && samples.length<3) samples.push(l);
        bad++;
      }
    }
    return { canon: out.join('\n'), ok, bad, samples };
  }
  async function fetchSmart(url){
    const res = await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const encs = ['utf-8','big5','utf-16le','utf-16be'];
    let best={enc:'utf-8', canon:'', ok:-1, bad:0, samples:[]};
    for (const enc of encs){
      try{
        const td = new TextDecoder(enc, { fatal:false });
        const norm = normalizeText(td.decode(buf));
        const { canon, ok, bad, samples } = canonicalize(norm);
        if (ok > best.ok) best={enc, canon, ok, bad, samples};
        if (ok > 0) return best;
      }catch(e){}
    }
    return best;
  }

  // ========== 以「時間戳」對齊的差異比對 ==========
  const CANON_RE = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  function parseCanonArray(text){
    const arr=[]; if(!text) return arr;
    for(const line of text.split('\n')){
      const m = line.match(CANON_RE);
      if(!m) continue;
      arr.push({ ts:m[1], price:m[2], act:m[3], line });
    }
    // 時間排序（字串排序即可）
    arr.sort((a,b)=> a.ts.localeCompare(b.ts));
    return arr;
  }
  function computeDeltaTimeAligned(baseText, newText){
    const A = parseCanonArray(baseText);
    const B = parseCanonArray(newText);
    const mapA = new Map(A.map(x=>[x.ts,x]));
    const mapB = new Map(B.map(x=>[x.ts,x]));
    const allTs = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).sort((a,b)=>a.localeCompare(b));

    const changed=[], added=[], removed=[];
    for(const ts of allTs){
      const a = mapA.get(ts), b = mapB.get(ts);
      if(a && b){
        if(a.line !== b.line) changed.push({ ts, old:a.line, neu:b.line });
      }else if(!a && b){
        added.push(b.line);
      }else if(a && !b){
        removed.push(a.line);
      }
    }

    const maxTsA = A.length ? A[A.length-1].ts : '';
    const pureAppend = (changed.length===0 && removed.length===0 &&
                        added.every(ln => (ln.match(CANON_RE)?.[1]||'') > maxTsA));

    return { pureAppend, added, changed, removed };
  }

  // ========== 單次包裝 SHARED 以避免 params.map 錯誤 ==========
  function patchSharedReaders(decodedText){
    if (window.SHARED) {
      // readAsTextAuto：下一次直接回傳我們已解碼/正規化好的字串
      if (typeof window.SHARED.readAsTextAuto === 'function') {
        const orig = window.SHARED.readAsTextAuto;
        window.SHARED.readAsTextAuto = async function(){
          window.SHARED.readAsTextAuto = orig;
          return decodedText;
        };
      }
      // paramsLabel：保證拿到 Array，避免 params.map 不是函式
      if (typeof window.SHARED.paramsLabel === 'function') {
        const origPL = window.SHARED.paramsLabel;
        window.SHARED.paramsLabel = function(arg){
          let arr = Array.isArray(arg) ? arg : (arg && Array.isArray(arg.raw) ? arg.raw : []);
          try { return origPL(arr); }
          catch { return (arr.slice(0,2).join(' ｜ ')) || '—'; }
        };
      }
    }
  }

  // ========== manifest：用 download，避免 400 噪音 ==========
  async function readManifest(){
    const { data, error } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
    if (error || !data) return null;
    try { return JSON.parse(await data.text()); } catch { return null; }
  }
  async function writeManifest(obj){
    const blob = new Blob([JSON.stringify(obj,null,2)], { type:'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(MANIFEST_PATH, blob, { upsert:true, cacheControl:'0', contentType:'application/json' });
    if (error) throw new Error(error.message);
  }

  // ========== 將文字交給 single.js ==========
  async function feedToSingle(filename, decodedText){
    const input = $('#file'); if(!input){ set('找不到 #file（single.js 未載入）', true); return; }
    patchSharedReaders(decodedText);                 // << 重要：避免二次猜編碼 & params.map 錯誤
    const file = new File([decodedText], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  // ========== 主流程 ==========
  async function boot(){
    try{
      const url = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      // 1) 決定「最新」檔
      let latest=null, list=[];
      if (paramFile){
        latest = { name:paramFile.split('/').pop()||'0807.txt', fullPath:paramFile, from:'url' };
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
      if(!latest){ set('找不到檔名含「0807」的 TXT（可用 ?file= 指定）。', true); return; }
      elLatest && (elLatest.textContent = latest.name);

      // 2) 取得「基準」：manifest 指定；否則用次新
      let base=null;
      const manifest = await readManifest();
      if (manifest?.baseline_path){
        base = list.find(x => x.fullPath===manifest.baseline_path) || { name: manifest.baseline_path.split('/').pop(), fullPath: manifest.baseline_path };
      } else {
        base = list[1] || null;
      }
      elBase && (elBase.textContent = base ? base.name : '（尚無）');

      // 3) 最新檔 → 智慧解碼 → 正規化/重建
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0){
        const hint = rNew.samples.length ? `\n不匹配範例：\n${rNew.samples.join('\n')}` : '';
        set(`最新檔沒有合法交易行（解碼=${rNew.enc}）。${hint}`, true);
        return;
      }

      // 4) 差異比對（時間戳對齊）
      if (base){
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase = await fetchSmart(baseUrl);
        if (rBase.ok === 0){
          set(`基準檔解析不到交易（解碼=${rBase.enc}）。先以最新檔跑分析。`, true);
        } else {
          const d = computeDeltaTimeAligned(rBase.canon, rNew.canon);

          // 純追加
          if (d.pureAppend && d.added.length>0){
            setDiff(`✅ 僅追加 ${d.added.length} 行（時間對齊）。`);
            appendBox.style.display='block'; appendBox.textContent = d.added.join('\n');
            btnCopy.disabled=false;
            btnCopy.onclick = async()=>{ await navigator.clipboard.writeText(d.added.join('\n')); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200); };
          } 
          // 有變更
          else {
            const msg = [
              d.changed.length ? `變更：${d.changed.length}` : null,
              d.added.length   ? `新增：${d.added.length}`   : null,
              d.removed.length ? `刪除：${d.removed.length}` : null
            ].filter(Boolean).join('、');
            setDiff(`⚠️ 發現內容差異（時間對齊）：${msg || '—'}`, true);

            // 變更明細（按 ts 排序）
            changeWrap.style.display='block'; changeTbody.innerHTML='';
            d.changed.forEach(row=>{
              const tr = document.createElement('tr');
              tr.innerHTML = `<td class="mono">${row.ts}</td><td class="mono">${row.old}</td><td class="mono">${row.neu}</td>`;
              changeTbody.appendChild(tr);
            });

            if (d.added.length){
              appendBox.style.display='block'; appendBox.textContent = d.added.join('\n');
              btnCopy.disabled=false;
              btnCopy.onclick = async()=>{ await navigator.clipboard.writeText(d.added.join('\n')); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200); };
            }
          }
        }
      } else {
        setDiff('首次建立：目前沒有基準檔。');
        appendBox.style.display='block'; appendBox.textContent = rNew.canon;
        btnCopy.disabled=false;
        btnCopy.onclick = async()=>{ await navigator.clipboard.writeText(rNew.canon); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200); };
      }

      // 5) 設最新檔為基準
      btnBase.disabled=false;
      btnBase.onclick = async ()=>{
        try{
          const payload = { baseline_path: latest.from==='url' ? latest.fullPath : latest.fullPath, updated_at: new Date().toISOString() };
          await writeManifest(payload);
          btnBase.textContent='已設為基準';
          setDiff('✅ 已將最新檔標記為基準（manifests/0807.json）');
        }catch(e){ setDiff('寫入基準失敗：'+(e.message||e), true); }
      };

      // 6) 交給 single.js 繪圖（用我們已重建好的 canonical 內容）
      set(`已載入最新檔（解碼=${rNew.enc}，有效行=${rNew.ok}），開始分析…`);
      await feedToSingle(latest.name, rNew.canon);
    } catch (err) {
      set('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
