// 0807.js — 自動偵測編碼 + 正規化 + 驗證，再注入 single.js
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');

  // 讓訊息能換行，方便看樣本
  if (status) status.style.whiteSpace = 'pre-wrap';

  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (url, opts={}) => fetch(url, { ...opts, cache:'no-store' }) }
  });

  const WANT = /0807/i;
  // 一行交易的嚴格格式（時間戳 + 價格 + 動作）
  const TRADE_RE = /^\d{14}\.000000\s+\d+(?:\.\d{1,6})?\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function set(msg, err=false){
    if (!status) return;
    status.textContent = msg;
    status.style.color = err ? '#c62828' : '#666';
  }

  function publicUrlOf(path){
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || '#';
  }

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
    const u = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }
  function extractLastDateScore(name){
    const m = String(name).match(/\b(20\d{6})\b/g);
    return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0;
  }

  // 文字正規化（去 BOM、換行、全形空白、壓縮多空白）
  function normalizeTxt(raw){
    let s = raw.replace(/^\uFEFF/, '');
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/\u3000/g, ' ');
    const lines = s.split('\n').map(l => l.trim()).filter(Boolean)
                   .map(l => l.replace(/\s+/g, ' '));
    return lines.join('\n');
  }
  // 統計符合交易格式的行數，並抓幾個不符合的樣本
  function countTradeLines(txt){
    const lines = txt.split('\n');
    let ok=0, bad=0, samplesBad=[];
    for (const l of lines){
      if (TRADE_RE.test(l)) ok++;
      else if (/^\d{14}\.000000/.test(l)) { bad++; if (samplesBad.length<3) samplesBad.push(l); }
    }
    return { ok, bad, samplesBad };
  }

  // 智慧解碼：依序嘗試多種編碼，選擇命中交易行最多者
  async function fetchTextSmart(url){
    const res = await fetch(url, { cache:'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();

    const encodings = ['utf-8', 'big5', 'utf-16le', 'utf-16be'];
    let best = { enc: 'utf-8', text: '', ok: -1, samplesBad: [] };

    for (const enc of encodings){
      try{
        const td = new TextDecoder(enc, { fatal:false });
        const raw = td.decode(buf);
        const norm = normalizeTxt(raw);
        const { ok, samplesBad } = countTradeLines(norm);
        if (ok > best.ok) best = { enc, text: norm, ok, samplesBad };
        // 若命中數明顯 >0，就直接採用
        if (ok > 0) return { enc, text: norm, ok, samplesBad };
      }catch(e){ /* ignore */ }
    }
    return best; // 可能 ok 仍為 0，但附上 samples
  }

  async function injectToSingle(filename, txt){
    const input = $('#file');
    if (!input){ set('找不到 #file 輸入框（single.js 尚未載入？）', true); return; }
    const file = new File([txt], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  async function boot(){
    try{
      // 1) ?file=
      const url = new URL(location.href);
      const p = url.searchParams.get('file');
      if (p){
        set(`從 URL 指定載入：${p}`);
        const { enc, text, ok, samplesBad } = await fetchTextSmart(p);
        if (ok === 0){
          set(`偵測到 0 行符合交易格式（解碼=${enc}）。\n請確認動作字詞為「新買/平賣/新賣/平買/強制平倉」。\n範例不匹配行：\n${samplesBad.join('\n')}`, true);
          document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display=''); return;
        }
        set(`已載入並開始分析（解碼=${enc}，交易行=${ok}）`);
        await injectToSingle(p.split('/').pop() || '0807.txt', text);
        return;
      }

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
        const { enc, text, ok, samplesBad } = await fetchTextSmart(pub);
        if (ok === 0){
          set(`偵測到 0 行符合交易格式（解碼=${enc}）。\n請確認動作字詞為「新買/平賣/新賣/平買/強制平倉」。\n範例不匹配行：\n${samplesBad.join('\n')}`, true);
          document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display=''); return;
        }
        set(`已載入並開始分析（解碼=${enc}，交易行=${ok}）`);
        await injectToSingle(best.name, text);
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
