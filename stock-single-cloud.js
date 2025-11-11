// 股票｜雲端單檔分析（完全獨立，不相依 single.js / shared.js）
// - 支援 canonical 與 1031-CSV 兩種輸入
// - 計價口徑：手續費整數進位 + 最低手續費；賣出含交易稅；unitShares（預設 1000）；可設 slip(每股)
// - 產出：週次盈虧圖（浮動長條+累積線）＋ 精簡 KPI ＋ 交易明細表

(function(){
  'use strict';

  // ====== 可從 URL 覆寫的參數 ======
  const url = new URL(location.href);
  const CFG = {
    feeRate:  +(url.searchParams.get('fee')  ?? 0.001425),
    minFee:   +(url.searchParams.get('min')  ?? 20),
    taxRate:  +(url.searchParams.get('tax')  ?? 0.003),
    unit:     +(url.searchParams.get('unit') ?? 1000),
    slip:     +(url.searchParams.get('slip') ?? 0),     // 每股滑價（買加賣各一次）
    capital:  +(url.searchParams.get('cap')  ?? 1_000_000),
  };
  const $ = s=>document.querySelector(s);
  $('#p-fee').textContent  = CFG.feeRate;
  $('#p-min').textContent  = CFG.minFee;
  $('#p-tax').textContent  = CFG.taxRate;
  $('#p-unit').textContent = CFG.unit;
  $('#p-slip').textContent = CFG.slip;

  // ====== Supabase（與你的專案相同） ======
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // ====== UI ======
  const fileInput = $('#file');
  const btnClip   = $('#btn-clip');
  const prefix    = $('#cloudPrefix');
  const btnList   = $('#btnCloudList');
  const pick      = $('#cloudSelect');
  const btnPrev   = $('#btnCloudPreview');
  const btnImp    = $('#btnCloudImport');
  const meta      = $('#cloudMeta');
  const prev      = $('#cloudPreview');
  const cacheTxt  = $('#cloudTxt');

  btnClip.addEventListener('click', async ()=>{
    try{
      const txt = await navigator.clipboard.readText();
      if(!txt) return alert('剪貼簿沒有文字');
      runAll(txt);
    }catch{ alert('無法讀取剪貼簿內容'); }
  });
  fileInput.addEventListener('change', async ()=>{
    const f = fileInput.files?.[0]; if(!f) return;
    const buf = await f.arrayBuffer();
    const txt = decodeBest(buf).txt;
    runAll(txt);
  });
  btnList.addEventListener('click', listCloud);
  btnPrev.addEventListener('click', previewCloud);
  btnImp.addEventListener('click', importCloud);

  async function listCloud(){
    prev.textContent=''; meta.textContent=''; cacheTxt.value='';
    pick.innerHTML = '<option value="">載入中…</option>';
    const p=(prefix.value||'').trim(); const fixed = p && !p.endsWith('/') ? p+'/' : p;
    const { data, error } = await sb.storage.from(BUCKET).list(fixed,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error){ pick.innerHTML = `<option>讀取失敗：${error.message}</option>`; return; }
    if(!data?.length){ pick.innerHTML = '<option>（無檔案）</option>'; return; }
    pick.innerHTML = '';
    for(const it of data){
      if(it.id===null && !it.metadata) continue;
      const path=(fixed||'')+it.name;
      const opt=document.createElement('option');
      opt.value=path; opt.textContent=`${path} (${(it.metadata?.size/1024).toFixed(1)} KB)`;
      pick.appendChild(opt);
    }
  }
  async function getUrl(path){
    try{ const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
         if(data?.signedUrl) return data.signedUrl; }catch{}
    const { data:pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    return pub?.publicUrl || '';
  }
  function decodeBest(ab){
    const encs=['utf-8','big5','gb18030']; let best={txt:'',bad:1e9,enc:''};
    for(const e of encs){
      try{ const t=new TextDecoder(e,{fatal:false}).decode(ab);
           const b=(t.match(/\uFFFD/g)||[]).length;
           if(b<best.bad) best={txt:t,bad:b,enc:e}; }catch{}
    } return best;
  }
  async function previewCloud(){
    prev.textContent=''; meta.textContent=''; cacheTxt.value='';
    const path=pick.value; if(!path) return;
    const url=await getUrl(path); if(!url){ prev.textContent='取得連結失敗'; return; }
    const r=await fetch(url,{cache:'no-store'}); if(!r.ok){ prev.textContent=`HTTP ${r.status}`; return; }
    const ab=await r.arrayBuffer(); const best=decodeBest(ab);
    cacheTxt.value=best.txt; meta.textContent=`來源：${path}（編碼：${best.enc}）`;
    const lines=best.txt.split(/\r?\n/);
    prev.textContent = lines.slice(0,500).join('\n') + (lines.length>500?`\n...（共 ${lines.length} 行）`:``);
  }
  async function importCloud(){
    const path=pick.value; if(!path) return alert('請先選檔');
    const url=await getUrl(path); if(!url) return alert('取得連結失敗');
    const r=await fetch(url,{cache:'no-store'}); if(!r.ok) return alert(`HTTP ${r.status}`);
    const ab=await r.arrayBuffer(); const best=decodeBest(ab);
    runAll(best.txt);
  }

  // ====== 解析：canonical + 1031-CSV ======
  const CANON_RE=/^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const CSV_RE=/^(\d{8}),(\d{5,6}),(\d+(?:\.\d+)?),([^,]+),/;
  const mapAct=(s)=>{
    if(/^賣出$/i.test(s)) return '平賣';
    if(/^(買進|加碼|再加碼|加碼攤平)$/i.test(s)) return '新買';
    if(/^強平$/i.test(s)) return '強制平倉';
    return s.trim();
  };
  const pad6=t=>String(t||'').padStart(6,'0').slice(0,6);

  function normalize(txt){
    return (txt||'')
      .replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'')
      .replace(/\r\n?/g,'\n').split('\n').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  }
  function toCanon(lines){
    const out=[];
    for(const l of lines){
      let m=l.match(CANON_RE);
      if(m){ out.push({ts:m[1], px:+m[2], act:m[3]}); continue; }
      m=l.match(CSV_RE);
      if(m){ const d8=m[1], t6=pad6(m[2]), px=+m[3], act=mapAct(m[4]);
             if(Number.isFinite(px)) out.push({ts:d8+t6, px, act}); }
    }
    out.sort((a,b)=>a.ts.localeCompare(b.ts));
    return out;
  }

  // ====== 股票回測（分段倉位，單位=張；unit 為每張股數） ======
  function ceilInt(n){ return Math.ceil(n); }
  function fee(amount){ return Math.max(CFG.minFee, ceilInt(amount * CFG.feeRate)); }
  function tax(amount){ return ceilInt(amount * CFG.taxRate); }

  function backtest(rows){
    let shares=0, cash=CFG.capital, costCum=0, pnlSum=0;
    const trades=[], weeks=new Map(); // week -> pnl
    const d8 = ts => ts.slice(0,8);
    const weekKey = d=> {
      const dt=new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00`);
      const y=dt.getFullYear(); const oneJan=new Date(y,0,1);
      const week=Math.ceil((((dt - oneJan)/86400000)+oneJan.getDay()+1)/7);
      return `${y}-W${String(week).padStart(2,'0')}`;
    };

    for(const r of rows){
      if(r.act==='新買'){
        const px = r.px + CFG.slip;
        const amt = px * CFG.unit;
        const f = fee(amt);
        if(cash >= amt + f){
          cash -= (amt + f);
          shares += CFG.unit;
          costCum += (amt + f);
          trades.push({ts:r.ts, kind:'BUY', px:px, shares:CFG.unit, fee:f, tax:0, cash, sharesHeld:shares});
        }
      }else if(r.act==='平賣' && shares>0){
        const px = r.px - CFG.slip;
        const canSell = shares; // 一次賣出全部
        const amt = px * canSell;
        const f = fee(amt), t = tax(amt);
        cash += (amt - f - t);
        const avgCostPerShare = costCum / shares; // 含買方費的平均每股成本
        const pnl = (amt - f - t) - avgCostPerShare * shares;
        pnlSum += pnl;
        trades.push({ts:r.ts, kind:'SELL', px:px, shares:canSell, fee:f, tax:t, cash, pnl, pnlCum:pnlSum});
        // 週次累積（以賣出入帳）
        const wk = weekKey(d8(r.ts));
        weeks.set(wk, (weeks.get(wk)||0) + pnl);
        // 歸零
        shares=0; costCum=0;
      }else{
        // 其他行為（新賣/平買/強平）在股票版暫不動作
      }
    }
    return {trades, weeks, endingCash:cash, openShares:shares, pnlSum};
  }

  // ====== KPI：精簡版 ======
  function calcKPI(bt){
    const sells = bt.trades.filter(x=>x.kind==='SELL');
    const n = sells.length;
    const hits = sells.filter(x=>x.pnl>0).length;
    const hitRate = n? hits/n : 0;
    const grossWin = sells.filter(x=>x.pnl>0).reduce((a,b)=>a+b.pnl,0);
    const grossLoss= sells.filter(x=>x.pnl<0).reduce((a,b)=>a+b.pnl,0);
    const pf = (grossLoss<0)? (grossWin/Math.abs(grossLoss)) : (grossWin>0?Infinity:0);
    // MaxDD 以累積損益序列計
    const eq = []; let acc=0; for(const s of sells){ acc += s.pnl; eq.push(acc); }
    let peak=0, mdd=0; for(const v of eq){ peak=Math.max(peak,v); mdd=Math.min(mdd, v-peak); }
    const total = eq.at(-1)||0;
    const retPct = CFG.capital? (total / CFG.capital) : 0;
    return {trades:n, hitRate, pf, mdd, total, retPct};
  }

  // ====== UI Render ======
  let chart;
  function renderChart(weeks){
    const labels=[...weeks.keys()];
    const bars=labels.map(k=>weeks.get(k)||0);
    const cum=[]; let s=0; for(const v of bars){ s+=v; cum.push(s); }
    if(chart) chart.destroy();
    const ctx=$('#chart').getContext('2d');
    chart = new Chart(ctx,{
      type:'bar',
      data:{ labels, datasets:[
        { type:'bar',  label:'每週損益', data:bars },
        { type:'line', label:'累積損益', data:cum, yAxisID:'y1' },
      ]},
      options:{
        responsive:true,
        scales:{ y:{ beginAtZero:true }, y1:{ beginAtZero:true, position:'right' } }
      }
    });
  }
  function renderKPI(k){
    $('#kpi').innerHTML = `
      <table>
        <thead><tr>
          <th>交易數</th><th>勝率</th><th>PF</th><th>最大回撤</th>
          <th>總損益(元)</th><th>總報酬率</th>
        </tr></thead>
        <tbody><tr>
          <td>${k.trades}</td>
          <td>${(k.hitRate*100).toFixed(2)}%</td>
          <td>${Number.isFinite(k.pf)? k.pf.toFixed(2) : '∞'}</td>
          <td>${k.mdd.toFixed(0)}</td>
          <td>${k.total.toFixed(0)}</td>
          <td>${(k.retPct*100).toFixed(2)}%</td>
        </tr></tbody>
      </table>`;
  }
  function renderTrades(t){
    const th = $('#tradeTable thead'), tb=$('#tradeTable tbody');
    th.innerHTML = `<tr><th>時間</th><th>種類</th><th>價格</th><th>股數</th><th>手續費</th><th>交易稅</th><th>現金餘額</th><th>單筆損益</th><th>累積損益</th></tr>`;
    tb.innerHTML = t.map(r=>`<tr>
      <td>${r.ts}</td><td>${r.kind}</td><td>${r.px.toFixed(3)}</td>
      <td>${r.shares}</td><td>${r.fee||0}</td><td>${r.tax||0}</td>
      <td>${Math.round(r.cash)}</td><td>${r.pnl!=null?Math.round(r.pnl):''}</td>
      <td>${r.pnlCum!=null?Math.round(r.pnlCum):''}</td></tr>`).join('');
  }

  // ====== 主流程 ======
  function runAll(rawText){
    const canon = toCanon(normalize(rawText));
    const bt = backtest(canon);
    renderChart(bt.weeks);
    renderKPI(calcKPI(bt));
    renderTrades(bt.trades);
  }
})();
