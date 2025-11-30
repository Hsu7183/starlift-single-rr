// 0807-single-cloud.js —— 0807 雲端單檔分析（第一行參數，第二行起才計算）
(function () {
  'use strict';
  console.log('0807 cloud JS loaded');

  // ===== 小工具 =====
  const $ = s => document.querySelector(s);

  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  let chart = null;

  // ===== 解析 0807 TXT =====
  // 格式：
  // line1: BeginTime=84800 EndTime=131000 ForceExitTime=131200 ...
  // line2+: YYYYMMDDhhmmss 價格 動作(新買/平賣/新賣/平買/強制平倉)
  function parseTxt(text){
    // 統一換行、去掉空行
    const lines = text
      .replace(/\r/g,'')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s !== '');
    if (!lines.length) {
      throw new Error('TXT 沒有內容');
    }

    // --- 第一行：參數（不計算） ---
    const params = {};
    const paramLine = lines[0];
    paramLine.split(/\s+/).forEach(tok => {
      if (!tok) return;
      const eqPos = tok.indexOf('=');
      if (eqPos <= 0) return;
      const k = tok.slice(0, eqPos);
      const v = tok.slice(eqPos + 1);
      if (k && v !== '') params[k] = v;
    });

    // --- 第二行起：交易紀錄 ---
    const events = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(/\s+/).filter(Boolean);
      // 至少要：時間 價格 動作
      if (parts.length < 3) continue;
      const ts     = parts[0];
      const price  = parseFloat(parts[1]);
      const action = parts[2];
      if (!ts || !/^\d{14}$/.test(ts)) continue;
      if (!isFinite(price)) continue;
      events.push({ ts, price, action });
    }

    if (!events.length) {
      throw new Error('找不到任何交易紀錄（第二行起）');
    }

    return { params, events };
  }

  // ===== 事件 → 交易（多空 + 強制平倉） =====
  function buildTrades(events){
    const trades = [];
    let pos = 0;      // 0=無, +1=多, -1=空
    let entry = null; // {ts, price, side}

    events.forEach(ev => {
      const { ts, price, action } = ev;

      if (action === '新買') {
        if (pos !== 0) return;
        pos   = +1;
        entry = { ts, price, side:'L' };
      } else if (action === '新賣') {
        if (pos !== 0) return;
        pos   = -1;
        entry = { ts, price, side:'S' };
      } else if (action === '平賣' || action === '平買' || action === '強制平倉') {
        if (pos === 0 || !entry) return;

        const side   = entry.side;
        const pnlPts = (side === 'L')
          ? (price - entry.price)
          : (entry.price - price);

        trades.push({
          side,                   // 'L' or 'S'
          entryTs   : entry.ts,
          entryPrice: entry.price,
          exitTs    : ts,
          exitPrice : price,
          exitAction: action,
          pnlPts
        });

        pos   = 0;
        entry = null;
      }
    });

    return trades;
  }

  // ===== 計算資產曲線 + KPI =====
  function computeEquity(trades, multiplier){
    let eqPts = 0;
    let maxEq = 0;
    let maxDD = 0;

    const labels   = [];
    const totalPts = [];
    const longPts  = [];
    const shortPts = [];

    let longAcc  = 0;
    let shortAcc = 0;

    let wins=0, losses=0, gp=0, gl=0;

    trades.forEach(t => {
      eqPts += t.pnlPts;

      if (t.pnlPts > 0){
        wins++;
        gp += t.pnlPts;
      } else if (t.pnlPts < 0){
        losses++;
        gl += t.pnlPts;
      }

      if (eqPts > maxEq) maxEq = eqPts;
      const dd = eqPts - maxEq;
      if (dd < maxDD) maxDD = dd;

      if (t.side === 'L') longAcc  += t.pnlPts;
      if (t.side === 'S') shortAcc += t.pnlPts;

      labels.push(formatTs(t.exitTs));
      totalPts.push(eqPts);
      longPts.push(longAcc);
      shortPts.push(shortAcc);
    });

    const totalTrades = trades.length;
    const winRate     = totalTrades ? wins / totalTrades : 0;
    const netPts      = eqPts;
    const pf          = gl < 0 ? (gp / Math.abs(gl)) : null;

    return {
      labels,
      totalPts,
      longPts,
      shortPts,
      kpi:{
        totalTrades,
        wins,
        losses,
        winRate,
        netPts,
        gp,
        gl,
        maxDD,
        pf
      },
      multiplier
    };
  }

  // ===== YYYYMMDDhhmmss → YYYY-MM-DD hh:mm =====
  function formatTs(ts){
    if (!ts || ts.length < 12) return ts || '';
    const y  = ts.slice(0,4);
    const m  = ts.slice(4,6);
    const d  = ts.slice(6,8);
    const hh = ts.slice(8,10);
    const mm = ts.slice(10,12);
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }

  // ===== 畫 Chart.js 折線圖 =====
  function renderChart(labels, totalPts, longPts, shortPts){
    const ctx = $('#chart').getContext('2d');
    if (chart) chart.destroy();

    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '總績效（點數）',
            data: totalPts,
            borderWidth: 2,
            fill: false
          },
          {
            label: '多單累積（點數）',
            data: longPts,
            borderWidth: 1,
            borderDash: [4,2],
            fill: false
          },
          {
            label: '空單累積（點數）',
            data: shortPts,
            borderWidth: 1,
            borderDash: [2,2],
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode:'index', intersect:false },
        plugins: {
          legend:{ position:'top' }
        },
        scales: {
          x: { display:true, ticks:{ maxRotation:0, autoSkip:true } },
          y: { display:true, title:{ display:true, text:'點數' } }
        }
      }
    });
  }

  // ===== KPI 表 =====
  function renderKPI(params, kpi, multiplier){
    const chip = $('#paramChip');
    chip.textContent = Object.keys(params).length
      ? Object.entries(params).map(([k,v])=>`${k}=${v}`).join('  ')
      : '—';

    const el = $('#kpiAll');

    const fmtPct = v => (v==null || !isFinite(v)) ? '—' : (v*100).toFixed(2) + '%';
    const fmtPts = v => (v==null) ? '—' : v.toFixed(1);
    const fmtNtd = v => (v==null) ? '—' : Math.round(v).toLocaleString();

    const netNtd   = kpi.netPts * multiplier;
    const maxDDNtd = kpi.maxDD * multiplier;

    el.innerHTML = `
      <h3>0807 策略 KPI</h3>
      <table class="kpi-table">
        <tbody>
          <tr>
            <th>總交易次數</th><td>${kpi.totalTrades}</td>
            <th>勝率</th><td>${fmtPct(kpi.winRate)}</td>
          </tr>
          <tr>
            <th>總獲利（點數）</th><td>${fmtPts(kpi.netPts)}</td>
            <th>總獲利（NT$，1口 × ${multiplier}）</th><td>${fmtNtd(netNtd)}</td>
          </tr>
          <tr>
            <th>最大回落 MaxDD（點數）</th><td>${fmtPts(kpi.maxDD)}</td>
            <th>最大回落 MaxDD（NT$）</th><td>${fmtNtd(maxDDNtd)}</td>
          </tr>
          <tr>
            <th>累積獲利點數（GP）</th><td>${fmtPts(kpi.gp)}</td>
            <th>累積虧損點數（GL）</th><td>${fmtPts(kpi.gl)}</td>
          </tr>
          <tr>
            <th>獲利因子 PF</th><td>${kpi.pf ? kpi.pf.toFixed(2) : '—'}</td>
            <th></th><td></td>
          </tr>
        </tbody>
      </table>
    `;
  }

  // ===== 交易明細表 =====
  function renderTrades(trades, multiplier){
    const thead = $('#tradeTable thead');
    const tbody = $('#tradeTable tbody');

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
          <td>${Math.round(pnlNtd).toLocaleString()}</td>
        </tr>
      `;
    }).join('');
  }

  // ===== 主流程：由文字跑完整分析 =====
  function runAnalysisFromText(text){
    try{
      const parsed = parseTxt(text);
      const trades = buildTrades(parsed.events);
      if(!trades.length){
        alert('沒有解析到任何完整交易（新買/新賣 + 平倉/強制平倉）');
        return;
      }

      const multiplier = parseFloat($('#multiplier').value) || 200;
      const eq = computeEquity(trades, multiplier);

      renderChart(eq.labels, eq.totalPts, eq.longPts, eq.shortPts);
      renderKPI(parsed.params, eq.kpi, multiplier);
      renderTrades(trades, multiplier);
    }catch(e){
      console.error(e);
      alert('解析或繪圖時發生錯誤：' + e.message);
    }
  }

  // ===== 本機檔案 / 剪貼簿 =====
  const fileInput = $('#file');
  console.log('fileInput =', fileInput);

  if(fileInput){
    fileInput.addEventListener('change', e=>{
      const f = e.target.files && e.target.files[0];
      console.log('file change', f);
      if(!f) return;
      const fr = new FileReader();
      fr.onload = ev => {
        const txt = ev.target.result;
        runAnalysisFromText(txt);
      };
      fr.readAsText(f, 'utf-8');
    });
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

  // ===== Supabase：雲端讀檔 =====
  const prefix   = $('#cloudPrefix');
  const btnList  = $('#btnCloudList');
  const pick     = $('#cloudSelect');
  const btnPrev  = $('#btnCloudPreview');
  const btnImp   = $('#btnCloudImport');
  const meta     = $('#cloudMeta');
  const prev     = $('#cloudPreview');

  if(btnList) btnList.addEventListener('click', listCloud);
  if(btnPrev) btnPrev.addEventListener('click', previewCloud);
  if(btnImp)  btnImp.addEventListener('click', importCloudToAnalysis);

  async function listCloud(){
    prev.textContent = '';
    meta.textContent = '';
    pick.innerHTML   = '<option value="">載入中…</option>';

    const p     = (prefix?.value || '').trim();
    const fixed = p && !p.endsWith('/') ? p + '/' : p;

    const { data, error } = await sb.storage.from(BUCKET).list(fixed,{
      limit:1000,
      sortBy:{ column:'name', order:'asc' }
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
      if(it.id === null && !it.metadata) return; // 資料夾
      const path   = (fixed || '') + it.name;
      const sizeKB = it.metadata?.size ? (it.metadata.size/1024).toFixed(1) : '-';
      const opt    = document.createElement('option');
      opt.value    = path;
      opt.textContent = `${path} (${sizeKB} KB)`;
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

  // ArrayBuffer → 自動偵測編碼（utf-8 / big5 / gb18030）
  function decodeBest(ab){
    const encs = ['utf-8','big5','gb18030'];
    let best   = { txt:'', bad:1e9, enc:'' };
    for(const e of encs){
      try{
        const t = new TextDecoder(e,{fatal:false}).decode(ab);
        const b = (t.match(/\uFFFD/g)||[]).length;
        if(b < best.bad) best = { txt:t, bad:b, enc:e };
      }catch(_){}
    }
    return best;
  }

  async function previewCloud(){
    prev.textContent = '';
    meta.textContent = '';
    const path = pick.value;
    if(!path) return;

    const url = await getUrl(path);
    if(!url){
      prev.textContent = '取得連結失敗';
      return;
    }

    const r = await fetch(url,{cache:'no-store'});
    if(!r.ok){
      prev.textContent = `HTTP ${r.status}`;
      return;
    }

    const ab   = await r.arrayBuffer();
    const best = decodeBest(ab);

    meta.textContent = `來源：${path}（編碼：${best.enc}）`;
    const lines      = best.txt.split('\n');
    prev.textContent = lines.slice(0,500).join('\n') +
      (lines.length>500 ? `\n...（共 ${lines.length} 行）` : '');
  }

  async function importCloudToAnalysis(){
    const path = pick.value;
    if(!path) return alert('請先選檔');

    const url = await getUrl(path);
    if(!url) return alert('取得連結失敗');

    const r = await fetch(url,{cache:'no-store'});
    if(!r.ok) return alert(`HTTP ${r.status}`);

    const txt = await r.text();
    runAnalysisFromText(txt);
  }

})();
