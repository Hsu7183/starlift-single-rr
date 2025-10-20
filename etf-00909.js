// etf-00909.js — 控制器
(function(){
  const $ = s => document.querySelector(s);
  const status = $('#autostatus'); function set(msg,bad=false){ if(status){ status.textContent=msg; status.style.color=bad?'#c62828':'#666'; } }
  const elLatest=$('#latestName'), elBase=$('#baseName'), elPeriod=$('#periodText'), btnBase=$('#btnSetBaseline');

  const CFG = {
    symbol:'00909',
    bucket:'reports',
    want:/00909/i,
    manifestPath:'manifests/etf-00909.json',
    feeRate:0.001425, taxRate:0.001, minFee:20,
    tickSize:0.01, slippageTick:0,
    unitShares:1000,
    rf:0.00, initialCapital:1_000_000
  };

  // UI chips
  $('#feeRateChip').textContent=(CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip').textContent=(CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip').textContent=CFG.minFee.toString();
  $('#unitChip').textContent=CFG.unitShares.toString();
  $('#slipChip').textContent=CFG.slippageTick.toString();
  $('#rfChip').textContent=(CFG.rf*100).toFixed(2)+'%';

  // Supabase
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  function pubUrl(path){ const { data } = sb.storage.from(CFG.bucket).getPublicUrl(path); return data?.publicUrl||'#'; }
  async function listOnce(prefix){
    const p=(prefix && !prefix.endsWith('/'))?(prefix+'/'): (prefix||'');
    const { data, error } = await sb.storage.from(CFG.bucket).list(p,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error) throw new Error(error.message);
    return (data||[]).map(it=>({ name:it.name, fullPath:p+it.name, updatedAt:it.updated_at?Date.parse(it.updated_at):0, size:it.metadata?.size||0 }));
  }
  async function listCandidates(){ const u=new URL(location.href); const prefix=u.searchParams.get('prefix')||''; return listOnce(prefix); }
  function lastDateScore(name){ const m=String(name).match(/\b(20\d{6})\b/g); return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0; }

  async function readManifest(){
    try{
      const { data, error } = await sb.storage.from(CFG.bucket).download(CFG.manifestPath);
      if(error || !data) return null;
      return JSON.parse(await data.text());
    }catch{ return null; }
  }
  async function writeManifest(obj){
    const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});
    const { error }=await sb.storage.from(CFG.bucket).upload(CFG.manifestPath,blob,{upsert:true,cacheControl:'0',contentType:'application/json'});
    if(error) throw new Error(error.message);
  }

  async function fetchText(url){
    const res=await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer();
    for(const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{ const s=new TextDecoder(enc,{fatal:false}).decode(buf); return s.replace(/\ufeff/gi,''); }catch(e){}
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  function mergeRowsByBaseline(baseRows, newRows){
    const A=[...baseRows].sort((x,y)=>x.ts.localeCompare(y.ts));
    const B=[...newRows].sort((x,y)=>x.ts.localeCompare(y.ts));
    const start8 = A.length? A[0].day : (B.length? B[0].day : '');
    const baseMax = A.length? A[A.length-1].ts : '';
    const added = baseMax ? B.filter(x=>x.ts>baseMax) : B;
    const merged = [...A, ...added];
    const end8 = merged.length? merged[merged.length-1].day : start8;
    return { merged, start8, end8 };
  }

  function renderKPIs(kpi){
    const core = [
      ['累積報酬',  (kpi.core.totalReturn*100).toFixed(2)+'%'],
      ['年化報酬(CAGR)', (kpi.core.CAGR*100).toFixed(2)+'%'],
      ['年化波動', (kpi.core.annVol*100).toFixed(2)+'%'],
      ['夏普(Sharpe)', kpi.core.sharpe.toFixed(2)],
      ['索提諾(Sortino)', kpi.core.sortino.toFixed(2)],
      ['最大回撤', (kpi.core.maxDD*100).toFixed(2)+'%'],
      ['Calmar', kpi.core.calmar.toFixed(2)],
      ['Profit Factor', kpi.core.profitFactor.toFixed(2)],
      ['勝率', (kpi.core.winRate*100).toFixed(2)+'%'],
      ['期望值(每筆元)', Math.round(kpi.core.expectancy).toLocaleString()],
      ['平均持有天數', kpi.core.avgHoldDays.toFixed(2)],
      ['區間', `${kpi.startDate} ~ ${kpi.endDate}`]
    ];
    const adv = [
      ['下行波動(年化)', (kpi.risk.downsideDev*100).toFixed(2)+'%'],
      ['回撤平均', (kpi.risk.ddAvg*100).toFixed(2)+'%'],
      ['回撤95分位', (kpi.risk.ddP95*100).toFixed(2)+'%'],
      ['偏態(Skew)', kpi.risk.skew.toFixed(2)],
      ['峰度(Kurtosis)', kpi.risk.kurt.toFixed(2)]
    ];
    const coreBox=$('#kpiCore'); coreBox.innerHTML='';
    core.forEach(([l,v])=>{ const d=document.createElement('div'); d.className='kpi'; d.innerHTML=`<span class="muted">${l}</span><b>${v}</b>`; coreBox.appendChild(d); });
    const advBox=$('#kpiAdv'); advBox.innerHTML='';
    adv.forEach(([l,v])=>{ const d=document.createElement('div'); d.className='kpi'; d.innerHTML=`<span class="muted">${l}</span><b>${v}</b>`; advBox.appendChild(d); });
  }

  function renderTradesTable(trades){
    const thead = $('#tradeTable thead'); const tbody = $('#tradeTable tbody');
    thead.innerHTML = `
      <tr>
        <th>方向</th><th>進場時間</th><th>進場價</th>
        <th>出場時間</th><th>出場價</th><th>股數</th>
        <th>買方手續費</th><th>賣方手續費</th><th>賣方交易稅</th>
        <th>損益</th><th>持有天數</th>
      </tr>`;
    tbody.innerHTML='';
    for(const t of trades){
      const tr=document.createElement('tr');
      tr.innerHTML = `
        <td>${t.side}</td>
        <td>${t.inTs}</td>
        <td>${t.inPx.toFixed(2)}</td>
        <td>${t.outTs}</td>
        <td>${t.outPx.toFixed(2)}</td>
        <td>${t.shares.toLocaleString()}</td>
        <td>${t.buyFee.toLocaleString()}</td>
        <td>${t.sellFee.toLocaleString()}</td>
        <td>${t.sellTax.toLocaleString()}</td>
        <td>${Math.round(t.pnl).toLocaleString()}</td>
        <td>${t.holdDays.toFixed(2)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function boot(){
    try{
      const url = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest=null, list=[];
      if(paramFile){
        latest = { name:paramFile.split('/').pop()||'00909.txt', fullPath:paramFile, from:'url' };
      }else{
        set('從 Supabase（reports）讀取清單…');
        list = (await listCandidates()).filter(f => CFG.want.test(f.name) || CFG.want.test(f.fullPath));
        list.sort((a,b)=>{
          const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if (sa!==sb) return sb-sa;
          if (a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        latest = list[0];
      }
      if(!latest){ set('找不到檔名含「00909」的 TXT（可用 ?file= 指定）。', true); return; }
      elLatest.textContent = latest.name;

      // 基準
      let base=null;
      const manifest = await readManifest();
      if (manifest?.baseline_path){
        base = list.find(x => x.fullPath===manifest.baseline_path) || { name: manifest.baseline_path.split('/').pop(), fullPath: manifest.baseline_path };
      } else {
        base = list[1] || null;
      }
      elBase.textContent = base ? base.name : '（尚無）';

      // 下載與解析
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const txtNew = await fetchText(latestUrl);
      const rowsNew = ETF_ENGINE.parseCanon(txtNew);
      if(rowsNew.length===0){ set('最新檔沒有可解析的交易行（請確認「賣出」字樣被正確寫入）。', true); return; }

      let rowsMerged = rowsNew, start8='', end8='';
      if(base){
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const txtBase = await fetchText(baseUrl);
        const rowsBase = ETF_ENGINE.parseCanon(txtBase);
        const m = mergeRowsByBaseline(rowsBase, rowsNew);
        rowsMerged = m.merged; start8=m.start8; end8=m.end8;
      }else{
        start8 = rowsNew[0].day; end8 = rowsNew[rowsNew.length-1].day;
      }
      elPeriod.textContent = `期間：${start8||'—'} 開始到 ${end8||'—'} 結束`;

      // 設為基準
      btnBase.disabled=false;
      btnBase.onclick = async ()=>{
        try{
          const payload = { baseline_path: latest.from==='url' ? latest.fullPath : latest.fullPath, updated_at: new Date().toISOString() };
          await writeManifest(payload);
          btnBase.textContent='已設為基準';
        }catch(e){ set('寫入基準失敗：'+(e.message||e), true); }
      };

      // 分析
      set('已載入（合併後）資料，開始分析…');
      const bt = ETF_ENGINE.backtest(rowsMerged, CFG);
      const kpi = ETF_ENGINE.statsKPI(bt, CFG);

      // 圖表 / KPI / 明細
      ETF_CHART.renderEquity($('#eqChart'), bt.eqSeries);
      ETF_CHART.renderDrawdown($('#ddChart'), bt.ddSeries);
      renderKPIs(kpi);
      renderTradesTable(bt.trades);

      set('完成。');
    }catch(err){
      set('初始化失敗：'+(err.message||err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
