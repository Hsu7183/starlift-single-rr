// 0807-single-cloud.js —— 0807 雲端單檔分析（期貨用，一口=200元/點）
// 規則：
//   - 第一行是參數，不計算。
//   - 第二行開始：每兩行一組，一奇一偶做一筆交易：
//       entry = 第 2,4,6,... 行（陣列 index 0,2,4,...）
//       exit  = 第 3,5,7,... 行（陣列 index 1,3,5,...）
//   - 方向：entry.action 含「新賣」當空單，其餘當多單。
(function () {
  'use strict';
  console.log('0807 cloud JS loaded');

  const $ = s => document.querySelector(s);

  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  let chart = null;

  // ===== 解析 0807 TXT =====
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

      const ts = parts[0];
      const price = parseFloat(parts[1]);
      const action = parts[parts.length - 1];   // 最後一欄視為動作

      if (!/^\d{14}$/.test(ts)) continue;
      if (!isFinite(price)) continue;

      events.push({
        ts,
        price,
        action: String(action).trim()
      });
    }

    console.log('events length =', events.length, 'sample =', events.slice(0, 6));

    if (!events.length) {
      throw new Error('找不到任何交易紀錄（第二行起）');
    }
    return { params, events };
  }

  // ===== 事件 → 交易（奇偶配對版） =====
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

    console.log('trades count =', trades.length, 'sample =', trades.slice(0, 6));
    return trades;
  }

  // ===== 計算資產曲線 + KPI（含多空分開） =====
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

    // 多空獨立 KPI
    const longTrades  = trades.filter(t => t.side === 'L');
    const shortTrades = trades.filter(t => t.side === 'S');

    trades.forEach(t => {
      eqPts += t.pnlPts;

      if (t.pnlPts > 0){
        wins++;
        gp += t.pnlPts;
      }else if (t.pnlPts < 0){
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

    // ======= 多 / 空 summary =======
    function summarizeSide(list){
      const n = list.length;
      if (!n) return {
        n:0, win:0, lose:0, winRate:0, lossRate:0,
        netPts:0, maxWin:0, maxLoss:0,
        avgPnL:0, maxDD:0
      };

      let eq = 0, maxEqSide = 0, maxDDSide = 0;
      let win=0, lose=0, gpSide=0, glSide=0;
      let maxWin = -1e9, maxLoss = 1e9;
      let sumPnL = 0;

      list.forEach(t=>{
        eq += t.pnlPts;
        sumPnL += t.pnlPts;
        if(t.pnlPts > 0){
          win++; gpSide += t.pnlPts;
        }else if(t.pnlPts < 0){
          lose++; glSide += t.pnlPts;
        }
        if(eq > maxEqSide) maxEqSide = eq;
        const dd = eq - maxEqSide;
        if(dd < maxDDSide) maxDDSide = dd;
        if(t.pnlPts > maxWin)  maxWin  = t.pnlPts;
        if(t.pnlPts < maxLoss) maxLoss = t.pnlPts;
      });

      return {
        n,
        win,
        lose,
        winRate : n ? win / n : 0,
        lossRate: n ? lose / n : 0,
        netPts  : sumPnL,
        maxWin  : (maxWin  === -1e9 ? 0 : maxWin),
        maxLoss : (maxLoss ===  1e9 ? 0 : maxLoss),
        avgPnL  : sumPnL / n,
        maxDD   : maxDDSide
      };
    }

    const sideAll  = summarizeSide(trades);
    const sideLong = summarizeSide(longTrades);
    const sideShort= summarizeSide(shortTrades);

    return {
      labels,
      totalPts,
      longPts,
      shortPts,
      kpiAll:{
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
      sideAll,
      sideLong,
      sideShort,
      multiplier
    };
  }

  // ===== YYYYMMDDhhmmss → YYYY-MM-DD hh:mm =====
  function formatTs(ts){
    if(!ts || ts.length < 12) return ts || '';
    const y  = ts.slice(0,4);
    const m  = ts.slice(4,6);
    const d  = ts.slice(6,8);
    const hh = ts.slice(8,10);
    const mm = ts.slice(10,12);
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }

  // ===== 6 線資產曲線 =====
  function renderChart(labels, totalPts, longPts, shortPts){
    const ctx = $('#chart').getContext('2d');
    if(chart) chart.destroy();

    chart = new Chart(ctx, {
      type:'line',
      data:{
        labels,
        datasets:[
          // 全部（實線 / 虛線）
          { label:'全部（含滑價）',   data:totalPts, borderWidth:2, fill:false },
          { label:'全部（不含滑價）', data:totalPts, borderWidth:1, borderDash:[4,2], fill:false },
          // 多單
          { label:'多單（含滑價）',   data:longPts,  borderWidth:1, fill:false },
          { label:'多單（不含滑價）', data:longPts,  borderWidth:1, borderDash:[4,2], fill:false },
          // 空單
          { label:'空單（含滑價）',   data:shortPts, borderWidth:1, fill:false },
          { label:'空單（不含滑價）', data:shortPts, borderWidth:1, borderDash:[4,2], fill:false }
        ]
      },
      options:{
        responsive:true,
        interaction:{ mode:'index', intersect:false },
        plugins:{ legend:{ position:'top' } },
        scales:{
          x:{ display:true, ticks:{ maxRotation:0, autoSkip:true } },
          y:{ display:true, title:{ display:true, text:'點數' } }
        }
      }
    });
  }

  // ===== KPI（全部 / 多單 / 空單） =====
  function renderKPI(params, eqStat){
    const chip = $('#paramChip');
    chip.textContent = Object.keys(params).length
      ? Object.entries(params).map(([k,v])=>`${k}=${v}`).join('  ')
      : '—';

    const el = $('#kpiAll');

    const fmtPct = v => (v==null || !isFinite(v)) ? '—' : (v*100).toFixed(2)+'%';
    const fmtPts = v => (v==null) ? '—' : v.toFixed(1);
    const fmtNtd = v => (v==null) ? '—' : Math.round(v).toLocaleString();

    const mult = eqStat.multiplier;
    const all  = eqStat.sideAll;
    const L    = eqStat.sideLong;
    const S    = eqStat.sideShort;

    const totalNtd  = all.netPts  * mult;
    const totalL_N  = L.netPts    * mult;
    const totalS_N  = S.netPts    * mult;
    const maxDD_N   = eqStat.kpiAll.maxDD * mult;
    const maxDD_L_N = L.maxDD * mult;
    const maxDD_S_N = S.maxDD * mult;

    el.innerHTML = `
      <h3 style="margin-bottom:8px;">KPI（含滑價）</h3>
      <table class="kpi-table">
        <thead>
          <tr>
            <th>指標</th>
            <th>全部（含滑價）</th>
            <th>多單（含滑價）</th>
            <th>空單（含滑價）</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>交易數</td>
            <td>${all.n}</td>
            <td>${L.n}</td>
            <td>${S.n}</td>
          </tr>
          <tr>
            <td>勝率</td>
            <td>${fmtPct(all.winRate)}</td>
            <td>${fmtPct(L.winRate)}</td>
            <td>${fmtPct(S.winRate)}</td>
          </tr>
          <tr>
            <td>敗率</td>
            <td>${fmtPct(all.lossRate)}</td>
            <td>${fmtPct(L.lossRate)}</td>
            <td>${fmtPct(S.lossRate)}</td>
          </tr>
          <tr>
            <td>總獲利（點數）</td>
            <td>${fmtPts(all.netPts)}</td>
            <td>${fmtPts(L.netPts)}</td>
            <td>${fmtPts(S.netPts)}</td>
          </tr>
          <tr>
            <td>總獲利（NT$）</td>
            <td>${fmtNtd(totalNtd)}</td>
            <td>${fmtNtd(totalL_N)}</td>
            <td>${fmtNtd(totalS_N)}</td>
          </tr>
          <tr>
            <td>單筆最大獲利（點數）</td>
            <td>${fmtPts(all.maxWin)}</td>
            <td>${fmtPts(L.maxWin)}</td>
            <td>${fmtPts(S.maxWin)}</td>
          </tr>
          <tr>
            <td>單筆最大虧損（點數）</td>
            <td>${fmtPts(all.maxLoss)}</td>
            <td>${fmtPts(L.maxLoss)}</td>
            <td>${fmtPts(S.maxLoss)}</td>
          </tr>
          <tr>
            <td>平均每筆損益（點數）</td>
            <td>${fmtPts(all.avgPnL)}</td>
            <td>${fmtPts(L.avgPnL)}</td>
            <td>${fmtPts(S.avgPnL)}</td>
          </tr>
          <tr>
            <td>最大回落 MaxDD（點數）</td>
            <td>${fmtPts(eqStat.kpiAll.maxDD)}</td>
            <td>${fmtPts(L.maxDD)}</td>
            <td>${fmtPts(S.maxDD)}</td>
          </tr>
          <tr>
            <td>最大回落 MaxDD（NT$）</td>
            <td>${fmtNtd(maxDD_N)}</td>
            <td>${fmtNtd(maxDD_L_N)}</td>
            <td>${fmtNtd(maxDD_S_N)}</td>
          </tr>
          <tr>
            <td>獲利因子 PF</td>
            <td>${eqStat.kpiAll.pf ? eqStat.kpiAll.pf.toFixed(2) : '—'}</td>
            <td>—</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>

      <div style="margin-top:16px;">
        <h3 style="margin-bottom:4px;">建議優化指標</h3>
        <div class="tiny">
          目前依「波動率 / PF / 最大回落」三項簡單給出建議。
          （日後如果你要完全照 0807.html 的 49 KPI 結構，我們再把這一塊升級。）
        </div>
      </div>
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

  // ===== 主流程 =====
  function runAnalysisFromText(text){
    try{
      const parsed = parseTxt(text);
      const trades = buildTrades(parsed.events);
      if(!trades.length){
        alert('TXT 已讀取，但沒有任何配對成功的交易（請確認第二行起是否成對輸出）。');
        return;
      }

      const multiplier = parseFloat($('#multiplier').value) || 200; // 期貨一口 200 元/點
      const eq = computeEquity(trades, multiplier);

      renderChart(eq.labels, eq.totalPts, eq.longPts, eq.shortPts);
      renderKPI(parsed.params, eq);
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

  // ===== Supabase：雲端讀檔（沿用原本功能） =====
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
      if(it.id === null && !it.metadata) return;
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
