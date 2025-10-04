// 0807.js — 自動偵測編碼＋正規化＋驗證 → 單次覆寫 SHARED.readAsTextAuto → 交給 single.js
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus'); if (status) status.style.whiteSpace = 'pre-wrap';

  // === Supabase (與 upload.html 同) ===
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (u, o={}) => fetch(u, { ...o, cache:'no-store' }) }
  });

  const WANT = /0807/i;
  const TRADE_RE = /^\d{14}\.000000\s+\d+\.\d{6}\s+(新買|平賣|新賣|平買|強制平倉)\s*$/; // 嚴格到 6 位小數

  function set(msg, err=false){ if(status){ status.textContent=msg; status.style.color=err?'#c62828':'#666'; } }
  function publicUrlOf(path){ const { data } = sb.storage.from(BUCKET).getPublicUrl(path); return data?.publicUrl || '#'; }
  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{ column:'name', order:'asc' }});
    if (error) throw new Error(error.message);
    return (data||[]).filter(it => !(it.id===null && !it.metadata))
      .map(it => ({ name:it.name, fullPath:p+it.name, updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0, size: it.metadata?.size||0 }));
  }
  async function listCandidates(){
    const u = new URL(location.href); const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }
  function extractLastDateScore(name){ const m=String(name).match(/\b(20\d{6})\b/g); return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0; }

  // --- 正規化 + 檢查 ---
  function normalizeTxt(raw){
    let s = raw.replace(/^\uFEFF/, '');
    s = s.replace(/\r\n?/g, '\n').replace(/\u3000/g, ' ');
    const lines = s.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.replace(/\s+/g, ' '));
    return lines.join('\n');
  }
  function countTradeLines(txt){
    const lines = txt.split('\n'); let ok=0, bad=0, samplesBad=[];
    for (const l of lines){
      if (TRADE_RE.test(l)) ok++;
      else if (/^\d{14}\.000000/.test(l)) { bad++; if (samplesBad.length<3) samplesBad.push(l); }
    }
    return { ok, bad, samplesBad };
  }

  // --- 智慧解碼：UTF-8、Big5、UTF-16LE/BE 中選命中最多的 ---
  async function fetchTextSmart(url){
    const res = await fetch(url, { cache:'no-store' }); if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const encodings = ['utf-8','big5','utf-16le','utf-16be'];
    let best = { enc:'utf-8', text:'', ok:-1, samplesBad:[] };
    for (const enc of encodings){
      try{
        const td = new TextDecoder(enc, { fatal:false });
        const norm = normalizeTxt(td.decode(buf));
        const { ok, samplesBad } = countTradeLines(norm);
        if (ok > best.ok) best = { enc, text:norm, ok, samplesBad };
        if (ok > 0) return { enc, text:norm, ok, samplesBad };
      }catch(e){}
    }
    return best; // 可能 ok 為 0，但帶樣本
  }

  // --- 把「我們已解碼好的文字」餵給 single.js（避免它再猜編碼）---
  async function feedToSingle(filename, decodedText){
    const input = $('#file'); if (!input){ set('找不到 #file（single.js 尚未載入？）', true); return; }

    // 單次覆寫 SHARED.readAsTextAuto：下一次呼叫直接回傳 decodedText，完畢後自動還原
    if (window.SHARED && typeof window.SHARED.readAsTextAuto === 'function'){
      const orig = window.SHARED.readAsTextAuto;
      window.SHARED.readAsTextAuto = async function(){ window.SHARED.readAsTextAuto = orig; return decodedText; };
    }

    // 仍準備一個檔案讓 UI/流程不報錯（名稱會顯示在介面上）
    const blob = new File([decodedText], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer(); dt.items.add(blob);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  async function boot(){
    try{
      const u = new URL(location.href);
      const paramFile = u.searchParams.get('file');

      // 1) 直接指定 ?file=
      if (paramFile){
        set(`從 URL 指定載入：${paramFile}`);
        const { enc, text, ok, samplesBad } = await fetchTextSmart(paramFile);
        if (ok === 0){ set(`偵測到 0 行符合交易格式（解碼=${enc}）。\n請確認動作需為「新買/平賣/新賣/平買/強制平倉」。\n不匹配行示例：\n${samplesBad.join('\n')}`, true); return; }
        set(`已載入並準備分析（解碼=${enc}，交易行=${ok}）`);
        await feedToSingle(paramFile.split('/').pop() || '0807.txt', text);
        return;
      }

      // 2) 從 Supabase 找最新 0807
      set('從 Supabase（reports）讀取清單…');
      const list = await listCandidates();
      const cand = list.filter(f => WANT.test(f.name) || WANT.test(f.fullPath));
      if (cand.length){
        cand.sort((a,b)=>{
          const sa=extractLastDateScore(a.name), sb=extractLastDateScore(b.name);
          if (sa!==sb) return sb-sa;
          if (a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        const best = cand[0];
        const url  = publicUrlOf(best.fullPath);
        set(`載入：${best.fullPath}`);
        const { enc, text, ok, samplesBad } = await fetchTextSmart(url);
        if (ok === 0){ set(`偵測到 0 行符合交易格式（解碼=${enc}）。\n請確認動作需為「新買/平賣/新賣/平買/強制平倉」。\n不匹配行示例：\n${samplesBad.join('\n')}`, true); return; }
        set(`已載入並準備分析（解碼=${enc}，交易行=${ok}）`);
        await feedToSingle(best.name, text);
        return;
      }

      // 3) 沒找到 0807
      set('找不到檔名含「0807」的 TXT。請到資料上傳區上傳，或用 ?file= 直接指定。', true);
    }catch(err){
      set('初始化失敗：' + (err.message || err), true);
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
