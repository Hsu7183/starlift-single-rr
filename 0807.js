// 0807.js — 自動挑最新 + 智慧解碼 + 逐行正規化/重建 + 差異比對 + 基準 manifest
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
  const MANIFEST_PATH = "manifests/0807.json";      // 記錄「基準檔」
  const STRICT_TRADE = /^\d{14}\.000000\s+\d+\.\d{6}\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;

  // 放寬抽取：容許行前有雜字元、時間戳是否含 .000000、價位 1~6 位小數、尾端雜訊
  const EXTRACT_TRADE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  // === 小工具 ===
  function set(msg, bad=false){ if(status){ status.textContent = msg; status.style.color = bad?'#c62828':'#666'; } }
  function setDiff(msg, bad=false){ if(diffStatus){ diffStatus.textContent = msg; diffStatus.style.color = bad?'#c62828':'#666'; } }
  function pubUrl(path){ const { data } = sb.storage.from(BUCKET).getPublicUrl(path); return data?.publicUrl || '#'; }
  const encList = ['utf-8','big5','utf-16le','utf-16be'];

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

  function normalizeText(raw){
    // 去掉所有 BOM/零寬等不見字元；清掉控制碼（保留 \n）
    let s = raw.replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'');
    s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'');   // 控制碼
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    // 壓縮空白；trim 每行；去空行
    const lines = s.split('\n').map(l => l.replace(/\s+/g,' ').trim()).filter(Boolean);
    return lines.join('\n');
  }

  // 逐行抽取 → 重建為「標準三欄」格式；回傳 {canon, ok, bad, samples}
  function canonicalize(txt){
    const out=[], lines = txt.split('\n');
    let ok=0, bad=0, samples=[];
    for(const l of lines){
      const m = l.match(EXTRACT_TRADE);
      if(m){
        const ts = m[1];
        const px = Number(m[2]);
        const p6 = Number.isFinite(px) ? px.toFixed(6) : m[2];
        const act= m[3];
        const canon = `${ts}.000000 ${p6} ${act}`;
        out.push(canon); ok++;
      }else{
        // 提供幾個不匹配樣本（避免洩漏過長）
        if (/(\d{14})/.test(l) && samples.length<3) samples.push(l);
        bad++;
      }
    }
    return { canon: out.join('\n'), ok, bad, samples };
  }

  async function fetchSmart(url){
    const res = await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    let best = { enc:'utf-8', canon:'', ok:-1, bad:0, samples:[] };
    for (const enc of encList){
      try{
        const td = new TextDecoder(enc, { fatal:false });
        const norm = normalizeText(td.decode(buf));
        const { canon, ok, bad, samples } = canonicalize(norm);
        if (ok > best.ok) best = { enc, canon, ok, bad, samples };
        if (ok > 0) return best;
      }catch(e){}
    }
    return best; // 可能 ok=0，但附樣本
  }

  // 單次覆寫 SHARED.readAsTextAuto，避免 single.js 再猜編碼
  async function feedToSingle(filename, decodedText){
    const input = $('#file'); if(!input){ set('找不到 #file（single.js 未載入）', true); return; }
    if (window.SHARED && typeof window.SHARED.readAsTextAuto === 'function'){
      const orig = window.SHARED.readAsTextAuto;
      window.SHARED.readAsTextAuto = async function(){ window.SHARED.readAsTextAuto = orig; return decodedText; };
    }
    const file = new File([decodedText], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  // ---- 基準 manifest（改用 storage.download，避免 400 噪音）----
  async function readManifest(){
    const { data, error } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
    if (error || !data) return null;
    try{ return JSON.parse(await data.text()); } catch { return null; }
  }
  async function writeManifest(obj){
    const blob = new Blob([JSON.stringify(obj,null,2)], { type:'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(MANIFEST_PATH, blob, { upsert:true, cacheControl:'0', contentType:'application/json' });
    if (error) throw new Error(error.message);
  }

  // ---- 差異（判斷是否純追加；否則列出變動）----
  function computeDelta(baseText, newText){
    const A = baseText.split('\n'), B = newText.split('\n');
    const min = Math.min(A.length, B.length);
    let i=0; while (i<min && A[i]===B[i]) i++;
    const isPrefix = (i===A.length && B.length>=A.length && A.every((v,k)=>v===B[k]));
    const appended = isPrefix ? B.slice(A.length) : (B.length>min ? B.slice(min) : []);
    const changed = [];
    if(!isPrefix){
      for(let j=i; j<min; j++){
        if(A[j]!==B[j]) changed.push({ idx:j+1, old:A[j], neu:B[j] });
        if (changed.length >= 200) break;
      }
    }
    return { isPrefix, prefixLen:i, appended, changed };
  }

  // ---- 主流程 ----
  async function boot(){
    try{
      const url = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      // 1) 決定最新檔
      let latest=null, list=[];
      if (paramFile){
        latest = { name: paramFile.split('/').pop() || '0807.txt', fullPath: paramFile, from:'url' };
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

      // 2) 讀基準（manifest）或次新作為基準
      let base=null;
      const manifest = await readManifest();
      if (manifest?.baseline_path){
        base = list.find(x => x.fullPath===manifest.baseline_path) || { name: manifest.baseline_path.split('/').pop(), fullPath: manifest.baseline_path };
      } else {
        base = list[1] || null;
      }
      elBase && (elBase.textContent = base ? base.name : '（尚無）');

      // 3) 抓最新檔 → 智慧解碼 → 正規化/重建
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0){
        const hint = rNew.samples.length ? `\n不匹配範例：\n${rNew.samples.join('\n')}` : '';
        set(`最新檔沒有合法交易行（解碼=${rNew.enc}）。${hint}`, true);
        return;
      }

      // 4) 若有基準 → 差異比對
      if (base){
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase = await fetchSmart(baseUrl);
        if (rBase.ok === 0){
          set(`基準檔解析不到交易（解碼=${rBase.enc}）。先以最新檔跑分析。`, true);
        } else {
          const d = computeDelta(rBase.canon, rNew.canon);
          if (d.isPrefix && d.appended.length>0){
            setDiff(`✅ 僅追加 ${d.appended.length} 行。`);
            appendBox.style.display='block'; appendBox.textContent = d.appended.join('\n');
            btnCopy.disabled=false; btnCopy.onclick = async()=>{ await navigator.clipboard.writeText(d.appended.join('\n')); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200); };
          } else if (d.isPrefix && d.appended.length===0){
            setDiff('ℹ️ 內容與基準相同。');
          } else {
            setDiff(`⚠️ 非純追加：從第 ${d.prefixLen+1} 行開始差異；下表列出前 ${d.changed.length} 處。`, true);
            changeWrap.style.display='block'; changeTbody.innerHTML='';
            for(const row of d.changed){
              const tr=document.createElement('tr');
              tr.innerHTML = `<td class="mono">${row.idx}</td><td class="mono">${row.old||''}</td><td class="mono">${row.neu||''}</td>`;
              changeTbody.appendChild(tr);
            }
            if (d.appended.length){
              appendBox.style.display='block'; appendBox.textContent = d.appended.join('\n');
              btnCopy.disabled=false; btnCopy.onclick = async()=>{ await navigator.clipboard.writeText(d.appended.join('\n')); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200); };
            }
          }
        }
      } else {
        setDiff('首次建立：目前沒有基準檔。');
        appendBox.style.display='block'; appendBox.textContent = rNew.canon;
        btnCopy.disabled=false; btnCopy.onclick = async()=>{ await navigator.clipboard.writeText(rNew.canon); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200); };
      }

      // 5) 設為基準
      btnBase.disabled=false;
      btnBase.onclick = async ()=>{
        try {
          const payload = { baseline_path: latest.from==='url' ? latest.fullPath : latest.fullPath, updated_at: new Date().toISOString() };
          await writeManifest(payload);
          btnBase.textContent='已設為基準';
          setDiff('✅ 已將最新檔標記為基準（manifests/0807.json）');
        } catch (e) { setDiff('寫入基準失敗：'+(e.message||e), true); }
      };

      // 6) 交給 single.js 繪圖（用我們已重建好的純淨內容）
      set(`已載入最新檔（解碼=${rNew.enc}，有效行=${rNew.ok}），開始分析…`);
      await feedToSingle(latest.name, rNew.canon);
    } catch (err) {
      set('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
