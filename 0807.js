// 0807.js — 強化版：先正規化與檢查交易列，再注入 single.js
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');

  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (url, opts={}) => fetch(url, { ...opts, cache:'no-store' }) }
  });

  const WANT = /0807/i;
  // 嚴格交易列：時間戳 + 6位小數 + 動作（新買/平賣/新賣/平買/強制平倉），行尾不得再有字
  const TRADE_RE = /^\d{14}\.000000\s+\d+(?:\.\d{1,6})?\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function set(msg, err=false){ if(status){ status.textContent=msg; status.style.color=err?'#c62828':'#666'; } }
  async function fetchText(url){ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.text(); }
  function publicUrlOf(path){ const { data } = sb.storage.from(BUCKET).getPublicUrl(path); return data?.publicUrl || '#'; }

  // 取一層清單（不遞迴）
  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{ column:'name', order:'asc' }});
    if (error) throw new Error(error.message);
    const files=[];
    for (const it of (data||[])){
      const isDir = (it.id===null && !it.metadata);
      if (isDir) continue;
      files.push({
        name: it.name,
        fullPath: p + it.name,
        updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0,
        size: it.metadata?.size || 0
      });
    }
    return files;
  }
  async function listCandidates(){
    const u=new URL(location.href); const prefix=u.searchParams.get('prefix')||''; 
    return listOnce(prefix);
  }
  function extractLastDateScore(name){
    const m = String(name).match(/\b(20\d{6})\b/g);
    return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0;
  }

  // —— 文字正規化（重點）——
  function normalizeTxt(raw){
    let s = raw.replace(/^\uFEFF/, '');          // 去 BOM
    s = s.replace(/\r\n?/g, '\n');               // CRLF → LF
    s = s.replace(/\u3000/g, ' ');               // 全形空白 → 半形
    const lines = s.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => l.replace(/\s+/g, ' '));         // 壓縮多空白
    return lines.join('\n');
  }
  function countTradeLines(txt){
    const lines = txt.split('\n');
    let ok=0, bad=0, samplesBad=[];
    for (const l of lines){
      if (TRADE_RE.test(l)) ok++; else {
        // 抓有時間戳但動作不符的樣本，方便你檢查
        if (/^\d{14}\.000000/.test(l)) { bad++; if (samplesBad.length<3) samplesBad.push(l); }
      }
    }
    return { ok, bad, samplesBad };
  }

  async function injectToSingle(filename, txt){
    const input = $('#file');
    if (!input){ set('找不到 #file 輸入框（single.js 尚未載入？）', true); return; }

    // 先正規化 + 自檢
    const norm = normalizeTxt(txt);
    const { ok, bad, samplesBad } = countTradeLines(norm);
    if (ok === 0){
      let hint = '偵測到 0 行符合交易格式。\n請確認：動作必須是「新買/平賣/新賣/平買/強制平倉」，且時間戳與小數位正確。';
      if (bad>0 && samplesBad.length){ hint += '\n範例不匹配的行：\n' + samplesBad.join('\n'); }
      set(hint, true);
      // 露出手動控制，讓你可以改選其他檔案
      document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display='');
      return;
    }

    const file = new File([norm], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  async function boot(){
    try{
      // 1) URL ?file=
      const url = new URL(location.href); const p = url.searchParams.get('file');
      if (p){ set(`從 URL 指定載入：${p}`); const txt = await fetchText(p); await injectToSingle(p.split('/').pop(), txt); return; }

      // 2) Supabase：挑「檔名含 0807」的最新一筆
      set('從 Supabase（reports）讀取清單…');
      const files = await listCandidates();
      const targets = files.filter(f => WANT.test(f.name) || WANT.test(f.fullPath));
      if (targets.length){
        targets.sort((a,b)=>{
          const sa=extractLastDateScore(a.name), sb=extractLastDateScore(b.name);
          if (sa!==sb) return sb-sa;
          if (a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        const best = targets[0];
        const pub  = publicUrlOf(best.fullPath);
        set(`載入：${best.fullPath}`);
        const txt = await fetchText(pub);
        await injectToSingle(best.name, txt);
        return;
      }

      set('找不到檔名含「0807」的 TXT。請至資料上傳區上傳，或以 ?file= 直接指定。', true);
      document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display='');
    }catch(err){
      set('初始化失敗：' + (err.message || err), true);
      document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display='');
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
