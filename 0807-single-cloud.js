// 0807-single-cloud.js —— 0807 雲端單檔分析（交易明細版）
//
// TXT 格式：
//   line1: BeginTime=84800 EndTime=131000 ForceExitTime=131200 ...
//   line2+: YYYYMMDDhhmmss 價格 動作
//
// 規則：
//   - 第一行只做參數顯示，不計算。
//   - line2 開始，每兩行一組：events[0]/[1] → 第1筆交易，events[2]/[3] → 第2筆…
//   - 方向：entry.action 含「新賣」 = 空單，其餘視為多單。
//   - 交易明細欄位：#、方向、進場/出場時間、價位、出場動作、損益（點 / 元）。
//
(function () {
  'use strict';
  console.log('0807-single-cloud JS loaded');

  // ===== DOM helper =====
  const $ = s => document.querySelector(s);

  // ===== Supabase 設定（沿用原專案） =====
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // ===== Formatter =====
  function formatTs(ts){
    if(!ts || ts.length < 12) return ts || '';
    const y  = ts.slice(0,4);
    const m  = ts.slice(4,6);
    const d  = ts.slice(6,8);
    const hh = ts.slice(8,10);
    const mm = ts.slice(10,12);
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }

  function fmtNtd(v){
    return (v==null) ? '—' : Math.round(v).toLocaleString();
  }

  // ===================== 解析 TXT =====================
  function parseTxt(text){
    const raw = text.replace(/\r/g, '');
    const lines = raw.split('\n')
      .map(s => s.trim())
      .filter(s => s !== '');

    if (!lines.length) throw new Error('TXT 沒有內容');

    // 第一行：參數
    const params = {};
    const paramLine = lines[0];
    if (paramLine.indexOf('=') >= 0) {
      paramLine.split(/\s+/).forEach(tok => {
        if (!tok) return;
        const eqPos = tok.indexOf('=');
        if (eqPos <= 0) return;
        const k = tok.slice(0, eqPos);
        const v = tok.slice(eqPos + 1);
        if (k && v !== '') params[k] = v;
      });
    }

    // 第二行開始：交易紀錄
    const events = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length < 3) continue;

      const ts     = parts[0];
      const price  = parseFloat(parts[1]);
      const action = parts[parts.length - 1];   // 最後一欄視為動作

      if (!/^\d{14}$/.test(ts)) continue;
      if (!isFinite(price)) continue;

      events.push({
        ts,
        price,
        action: String(action).trim()
      });
    }

    if (!events.length) {
      throw new Error('找不到任何交易紀錄（第二行起）');
    }

    return { params, events };
  }

  // ===================== 事件 → 交易（兩行一組） =====================
  function buildTrades(events){
    const trades = [];
    const n = events.length;
    const pairCount = Math.floor(n / 2);

    for (let i = 0; i < pairCount; i++) {
      const entry = events[2*i];
      const exit  = events[2*i + 1];

      const actEntry = entry.action || '';
      // entry.action 含「新賣」 = 空單，其餘視為多單
      const side = actEntry.indexOf('新賣') >= 0 ? 'S' : 'L';

      const pnlPts = (side === 'L')
        ? (exit.price - entry.price)
        : (entry.price - exit.price);

      trades.push({
        side,                   // 'L' or 'S'
        entryTs   : entry.ts,
        entryPrice: entry.price,
        exitTs    : exit.ts,
        exitPrice : exit.price,
        exitAction: exit.action,
        pnlPts
      });
    }

    return trades;
  }

  // ===================== 顯示參數 chip =====================
  function renderParams(params){
    const chip = $('#paramChip');
    if (!chip) return;
    chip.textContent = Object.keys(params).length
      ? Object.entries(params).map(([k,v])=>`${k}=${v}`).join('  ')
      : '—';
  }

  // ===================== 交易明細表 =====================
  function renderTrades(trades, multiplier){
    const thead = $('#tradeTable thead');
    const tbody = $('#tradeTable tbody');
    if (!thead || !tbody) return;

    thead.innerHTML = `
      <tr>
        <th>#</th>
        <th>方向</th>
        <th>進場時間</th>
        <th>進場價</th>
        <th>出場時間</th>
        <th>出場價</th>
        <th>出場動作</th>
        <th>損益（點）</th>
        <th>損益（NT$）</th>
      </tr>
    `;

    tbody.innerHTML = trades.map((t, idx)=>{
      const pnlNtd = t.pnlPts * multiplier;
      const cls = t.pnlPts > 0 ? 'pnl-win' : (t.pnlPts < 0 ? 'pnl-lose' : '');
      return `
        <tr class="${cls}">
          <td>${idx+1}</td>
          <td>${t.side === 'L' ? '多單' : '空單'}</td>
          <td>${formatTs(t.entryTs)}</td>
          <td>${t.entryPrice}</td>
          <td>${formatTs(t.exitTs)}</td>
          <td>${t.exitAction}</td>
          <td>${t.pnlPts.toFixed(1)}</td>
          <td>${fmtNtd(pnlNtd)}</td>
        </tr>
      `;
    }).join('');
  }

  // ===================== 主流程 =====================
  function runAnalysisFromText(text){
    try{
      const parsed = parseTxt(text);
      const trades = buildTrades(parsed.events);
      if(!trades.length){
        alert('TXT 已讀取，但沒有任何配對成功的交易（請確認第二行起是否成對輸出）。');
        return;
      }

      const multInput = $('#multiplier');
      const mult = multInput ? (parseFloat(multInput.value) || 200) : 200;

      renderParams(parsed.params);
      renderTrades(trades, mult);
    }catch(e){
      console.error(e);
      alert('解析或產生交易明細時發生錯誤：' + e.message);
    }
  }

  // ===================== 綁定 #file（本機 / Supabase 共用） =====================
  const fileInput = $('#file');
  if(fileInput){
    fileInput.addEventListener('change', e=>{
      const f = e.target.files && e.target.files[0];
      if(!f) return;
      const fr = new FileReader();
      fr.onload = ev => {
        const txt = ev.target.result;
        runAnalysisFromText(txt);
      };
      fr.readAsText(f, 'utf-8');
    });
  } else {
    console.warn('#file not found：無法綁定 0807 交易明細解析');
  }

  const btnClip = $('#btn-clip');
  if(btnClip){
    btnClip.addEventListener('click', async ()=>{
      try{
        const txt = await navigator.clipboard.readText();
        if(!txt) return alert('剪貼簿沒有文字');
        runAnalysisFromText(txt);
      }catch(e){
        alert('無法讀取剪貼簿內容，請改用「選擇檔案」。');
      }
    });
  }

  // ===================== Supabase 雲端：列清單 / 預覽 / 匯入 =====================
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

    const p = (prefix?.value || '').trim();
    const fixed = p && !p.endsWith('/') ? p + '/' : p;

    const { data, error } = await sb.storage.from(BUCKET).list(fixed,{
      limit:1000,
      sortBy:{column:'name',order:'asc'}
    });

    if(error){
      pick.innerHTML = `<option>讀取失敗：${error.message}</option>`;
      return;
    }
    if(!data || !data.length){
      pick.innerHTML = '<option>（無檔案）</option>';
      return;
    }

    pick.innerHTML = '';
    data.forEach(it=>{
      // 跳過資料夾
      if(it.id===null && !it.metadata) return;
      const path=(fixed||'')+it.name;
      const opt=document.createElement('option');
      const sizeKB = it.metadata?.size ? (it.metadata.size/1024).toFixed(1) : '-';
      opt.value=path; opt.textContent=`${path} (${sizeKB} KB)`;
      pick.appendChild(opt);
    });
  }

  async function getUrl(path){
    try{
      const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      if(data?.signedUrl) return data.signedUrl;
    }catch(e){}
    const { data:pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    return pub?.publicUrl || '';
  }

  function decodeBest(ab){
    const encs=['utf-8','big5','gb18030']; let best={txt:'',bad:1e9,enc:''};
    for(const e of encs){
      try{
        const t=new TextDecoder(e,{fatal:false}).decode(ab);
        const b=(t.match(/\uFFFD/g)||[]).length;
        if(b<best.bad) best={txt:t,bad:b,enc:e};
      }catch{}
    }
    return best;
  }

  async function previewCloud(){
    prev.textContent=''; meta.textContent='';
    const path = pick?.value;
    if(!path) return;
    const url = await getUrl(path);
    if(!url){ prev.textContent='取得連結失敗'; return; }

    const r = await fetch(url,{cache:'no-store'});
    if(!r.ok){ prev.textContent=`HTTP ${r.status}`; return; }

    const ab   = await r.arrayBuffer();
    const best = decodeBest(ab);

    meta.textContent=`來源：${path}（編碼：${best.enc}）`;
    const lines = best.txt.split(/\r?\n/);
    prev.textContent = lines.slice(0,500).join('\n') +
      (lines.length>500 ? `\n...（共 ${lines.length} 行）` : ``);
  }

  async function importCloudToAnalysis(){
    const path = pick?.value;
    if(!path) return alert('請先選檔');
    const url = await getUrl(path);
    if(!url) return alert('取得連結失敗');

    const r = await fetch(url,{cache:'no-store'});
    if(!r.ok) return alert(`HTTP ${r.status}`);

    const txt = await r.text();
    runAnalysisFromText(txt);
  }

})();
