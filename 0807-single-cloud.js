// 0807-single-cloud.js —— 0807 雲端單檔分析（單檔版）
// - 從 Supabase reports bucket 選一個 0807 TXT
// - 將「時間 價格 動作」格式轉成 canonical 交易紀錄
// - 餵給 single.js 執行完整 KPI + Stress Scenarios

(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const statusEl = $('#autostatus');

  function setStatus(msg, bad){
    if(!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = bad ? '#c62828' : '#666';
  }

  // ===== Supabase 設定 =====
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // ===== 0807 TXT → canonical 行 =====
  //
  // 0807 TXT 原始行例：
  //   20231201093900 17366 新買
  //   20231201131200 17407 強制平倉
  //
  // canonical 需要：
  //   20231201093900.000000 17366.000000 新買
  //
  const EXTRACT_RE = /^(\d{14})\s+(\d+(?:\.\d+)?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function normalizeText(raw){
    let s = raw.replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'');
    s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'');
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    const lines = s.split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean);
    return lines.join('\n');
  }

  function canonicalizeFrom0807(raw){
    const norm = normalizeText(raw);
    const out = [];
    let ok=0, bad=0;

    for(const line of norm.split('\n')){
      // 跳過第一行參數（BeginTime=...）
      if(line.indexOf('BeginTime=')>=0 && line.indexOf('EndTime=')>=0){
        continue;
      }
      const m = line.match(EXTRACT_RE);
      if(!m){ bad++; continue; }
      const ts = m[1];
      const px = Number(m[2]);
      const px6 = Number.isFinite(px) ? px.toFixed(6) : m[2];
      const act = m[3];
      out.push(`${ts}.000000 ${px6} ${act}`);
      ok++;
    }
    return { canon: out.join('\n'), ok, bad };
  }

  async function fetchTextSmart(url){
    const r = await fetch(url, { cache:'no-store' });
    if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const buf = await r.arrayBuffer();

    for(const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{
        const td = new TextDecoder(enc,{fatal:false});
        const { canon, ok } = canonicalizeFrom0807(td.decode(buf));
        if(ok>0) return { canon, ok, enc };
      }catch(e){}
    }
    const td = new TextDecoder('utf-8');
    const { canon, ok } = canonicalizeFrom0807(td.decode(buf));
    return { canon, ok, enc:'utf-8' };
  }

  // ===== 喂給 single.js：patch SHARED.readAsTextAuto + file change =====
  function patchSharedReaders(canonicalText){
    if(!window.SHARED) return;
    // 單次覆寫 readAsTextAuto，讓 single.js 直接拿到我們轉好的 canonical
    if(typeof window.SHARED.readAsTextAuto === 'function'){
      const orig = window.SHARED.readAsTextAuto;
      window.SHARED.readAsTextAuto = async function(){
        // 用完就還原，避免影響其它頁
        window.SHARED.readAsTextAuto = orig;
        return canonicalText;
      };
    }
    // paramsLabel 防護（避免 single.js 對 0807 格式 params 爆掉）
    if(typeof window.SHARED.paramsLabel === 'function'){
      const origPL = window.SHARED.paramsLabel;
      window.SHARED.paramsLabel = function(arg){
        try{
          return origPL(arg);
        }catch(e){
          const arr = Array.isArray(arg?.raw) ? arg.raw : (Array.isArray(arg)?arg:[]);
          return (arr.slice(0,2).join(" ｜ ")) || "—";
        }
      };
    }
  }

  async function feedToSingle(filename, canonicalText){
    const input = $('#file');
    if(!input){
      setStatus('找不到 #file，single.js 可能尚未載入。', true);
      return;
    }
    patchSharedReaders(canonicalText);

    // 建立一個假的 File 給 single.js（內容其實不重要，真正的文字從 readAsTextAuto 來）
    const file = new File([canonicalText], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change',{ bubbles:true }));
  }

  // ===== Supabase UI：列清單 / 預覽 / 匯入 =====
  const prefix  = $('#cloudPrefix');
  const btnList = $('#btnCloudList');
  const pick    = $('#cloudSelect');
  const btnPrev = $('#btnCloudPreview');
  const btnImp  = $('#btnCloudImport');
  const meta    = $('#cloudMeta');
  const prev    = $('#cloudPreview');

  if(btnList) btnList.addEventListener('click', listCloud);
  if(btnPrev) btnPrev.addEventListener('click', previewCloud);
  if(btnImp)  btnImp.addEventListener('click', importCloudToAnalysis);

  async function listCloud(){
    if(!pick) return;
    prev.textContent=''; meta.textContent='';
    pick.innerHTML = '<option value="">載入中…</option>';
    setStatus('從 Supabase 讀取清單中…', false);

    const p = (prefix?.value || '').trim();
    const fixed = p && !p.endsWith('/') ? p + '/' : p;

    const { data, error } = await sb.storage.from(BUCKET).list(fixed,{
      limit:1000,
      sortBy:{ column:'name', order:'asc' }
    });

    if(error){
      pick.innerHTML = `<option value="">讀取失敗：${error.message}</option>`;
      setStatus('讀取清單失敗：' + error.message, true);
      return;
    }
    if(!data || !data.length){
      pick.innerHTML = '<option value="">（無檔案）</option>';
      setStatus('指定路徑下沒有檔案。', true);
      return;
    }

    pick.innerHTML = '';
    data.forEach(it=>{
      if(it.id===null && !it.metadata) return; // 資料夾略過
      const path = (fixed||'') + it.name;
      const sizeKB = it.metadata?.size ? (it.metadata.size/1024).toFixed(1) : '-';
      const opt = document.createElement('option');
      opt.value = path;
      opt.textContent = `${path} (${sizeKB} KB)`;
      pick.appendChild(opt);
    });

    setStatus(`清單載入完成，共 ${pick.options.length} 個檔案。`, false);
  }

  async function getUrl(path){
    try{
      const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
      return data?.publicUrl || '';
    }catch(e){
      return '';
    }
  }

  async function previewCloud(){
    prev.textContent=''; meta.textContent='';
    const path = pick?.value;
    if(!path) return;
    const url = await getUrl(path);
    if(!url){ prev.textContent='取得連結失敗'; setStatus('取得檔案連結失敗。', true); return; }

    setStatus('下載並預覽中…', false);
    try{
      const r = await fetch(url,{cache:'no-store'});
      if(!r.ok){ prev.textContent=`HTTP ${r.status}`; setStatus(`HTTP ${r.status}`, true); return; }
      const txt = await r.text();
      const norm = normalizeText(txt);
      meta.textContent = `來源：${path}`;
      const lines = norm.split(/\r?\n/);
      prev.textContent = lines.slice(0,300).join('\n') + (lines.length>300?`\n...（共 ${lines.length} 行）`:``);
      setStatus('預覽完成。', false);
    }catch(e){
      prev.textContent = '預覽失敗：' + (e.message||e);
      setStatus('預覽失敗：' + (e.message||e), true);
    }
  }

  async function importCloudToAnalysis(){
    const path = pick?.value;
    if(!path) return alert('請先選擇一個檔案');
    const url = await getUrl(path);
    if(!url) return alert('取得檔案連結失敗');

    setStatus('下載並轉換為 canonical 格式…', false);
    try{
      const { canon, ok, enc } = await fetchTextSmart(url);
      if(!ok){
        setStatus(`沒有合法交易行（編碼=${enc}）。`, true);
        return;
      }
      setStatus(`已轉換 ${ok} 行交易（編碼=${enc}），送交單檔分析引擎…`, false);
      await feedToSingle(path.split('/').pop() || '0807.txt', canon);
    }catch(e){
      console.error(e);
      setStatus('下載或轉換失敗：' + (e.message||e), true);
    }
  }

  async function fetchTextSmart(url){
    const r = await fetch(url,{cache:'no-store'});
    if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const buf = await r.arrayBuffer();

    for(const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{
        const td = new TextDecoder(enc,{fatal:false});
        const { canon, ok } = canonicalizeFrom0807(td.decode(buf));
        if(ok>0) return { canon, ok, enc };
      }catch(e){}
    }
    const td = new TextDecoder('utf-8');
    const { canon, ok } = canonicalizeFrom0807(td.decode(buf));
    return { canon, ok, enc:'utf-8' };
  }

})();
