/* shared.js - 共用工具（非 module） */
(function(){
  if (window.SHARED) { return; } // 防重複載入

  // MULT=200；滑價：每筆固定 4 點（2點/腳 × 2腳 = 4 點 = 800元）
  const MULT = 200, FEE = 45, TAX = 0.00004, SLIP = 4;

  const ENTRY = ['新買','新賣'], EXIT_L=['平賣','強制平倉'], EXIT_S=['平買','強制平倉'];

  /** 嘗試 Big5 -> UTF-8 讀檔 */
  function readAsTextAuto(file){
    return new Promise((resolve,reject)=>{
      const r1=new FileReader();
      r1.onerror=()=>resolve(null);
      r1.onload = ()=> resolve(r1.result);
      try{ r1.readAsText(file,'big5'); }catch{ resolve(null); }
    }).then(txt=>{
      if (txt && /[\u4E00-\u9FFF]/.test(txt)) return txt;
      return new Promise((ok,no)=>{
        const r2=new FileReader();
        r2.onerror=()=>no(r2.error);
        r2.onload = ()=> ok(r2.result);
        r2.readAsText(file); // utf-8
      });
    });
  }

  /** 只在顯示參數時把小數拿掉（整數字串） */
  function i(n){ return String(Math.trunc(Number(n||0))); }

  /** 解析原始 TXT 為 { params, rows } */
  function parseTXT(raw){
    const lines = raw.replace(/\r/g,'').trim().split('\n').map(s=>s.trim()).filter(Boolean);
    let params = null;
    const firstNums = (lines[0]||'').match(/-?\d+(\.\d+)?/g);
    if (firstNums && firstNums.length>=10){
      params = firstNums.map(Number);
      lines.shift();
    }
    const rows = [];
    for (const s of lines){
      const m = s.match(/^(\d{14})\.?\d*\s+(\d+(?:\.\d+)?)\s+(\S+)/);
      if(!m) continue;
      const [_, ts, p, act] = m;
      if(!['新買','新賣','平買','平賣','強制平倉'].includes(act)) continue;
      rows.push({ts, price:+p, act});
    }
    return { params, rows };
  }

  /** 由 rows 配對計算績效與累積序列（KPI 全採用 gainSlip） */
  function buildReport(rows){
    const q=[], trades=[], tsArr=[];
    const total=[], slipCum=[], longCum=[], longSlipCum=[], shortCum=[], shortSlipCum=[];
    let cum=0, cumSlip=0, cumL=0, cumS=0, cumLSlip=0, cumSSLip=0;

    for (const r of rows){
      const {ts,price,act} = r;
      if (ENTRY.includes(act)){
        q.push({ side: act==='新買'?'L':'S', pIn: price, tsIn: ts });
        continue;
      }
      // 找到可平倉倉位
      const qi = q.findIndex(o => (o.side==='L' && EXIT_L.includes(act)) || (o.side==='S' && EXIT_S.includes(act)));
      if (qi===-1) continue;
      const pos = q.splice(qi,1)[0];

      const pts = pos.side==='L' ? price - pos.pIn : pos.pIn - price;
      const fee = FEE*2, tax = Math.round(price*MULT*TAX);
      const gain = pts*MULT - fee - tax;
      const gainSlip = gain - SLIP*MULT;

      cum += gain; cumSlip += gainSlip;
      if (pos.side==='L') { cumL += gain; cumLSlip += gainSlip; }
      else { cumS += gain; cumSSLip += gainSlip; }

      trades.push({pos, tsOut: ts, priceOut: price, pts, gain, gainSlip});
      tsArr.push(ts);
      total.push(cum);
      slipCum.push(cumSlip);
      longCum.push(cumL);
      longSlipCum.push(cumLSlip);
      shortCum.push(cumS);
      shortSlipCum.push(cumSSLip);
    }

    // === KPI（全用 gainSlip 計）===
    const sum = a=>a.reduce((x,y)=>x+y,0);
    const byDaySlip = list => {
      const m={}; list.forEach(t=>{const d=t.tsOut.slice(0,8); m[d]=(m[d]||0)+t.gainSlip;});
      return Object.values(m);
    };
    const drawUp = s => { let mn=s[0]||0, up=0; s.forEach(v=>{ mn=Math.min(mn,v); up=Math.max(up,v-mn);}); return up; };
    const drawDn = s => { let pk=s[0]||0, dn=0; s.forEach(v=>{ pk=Math.max(pk,v); dn=Math.min(dn,v-pk);}); return dn; };

    const longs = trades.filter(t=>t.pos.side==='L');
    const shorts= trades.filter(t=>t.pos.side==='S');

    const mk = (list) => {
      let acc = 0; const seqSlip = [];
      list.forEach(t => { acc += t.gainSlip; seqSlip.push(acc); });
      const win=list.filter(t=>t.gainSlip>0), loss=list.filter(t=>t.gainSlip<0);
      return {
        count:list.length,
        winRate: list.length ? (win.length/list.length) : 0,
        loseRate: list.length ? (loss.length/list.length) : 0,
        posPts: sum(win.map(t=>t.pts)),
        negPts: sum(loss.map(t=>t.pts)),
        pts: sum(list.map(t=>t.pts)),
        gain: sum(list.map(t=>t.gainSlip)),       // KPI 一律採滑價後
        gainSlip: sum(list.map(t=>t.gainSlip)),
        dayMax: Math.max(0,...byDaySlip(list)),
        dayMin: Math.min(0,...byDaySlip(list)),
        up: drawUp(seqSlip),
        dd: drawDn(seqSlip),
      };
    };

    const statAll = mk(trades);
    const statL   = mk(longs);
    const statS   = mk(shorts);

    return {
      trades, tsArr,
      // 圖表序列（含滑點/不含滑點，長短/總計）
      total, slipCum, longCum, longSlipCum, shortCum, shortSlipCum,
      // KPI
      statAll, statL, statS
    };
  }

  /** 小工具 */
  const fmtMoney = n => (Number(n)||0).toLocaleString('zh-TW');
  const pct = x => (x*100).toFixed(1)+'%';
  const fmtTs = s => `${s.slice(0,4)}/${s.slice(4,6)}/${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}`;

  /** 產生「參數簡約字串」 */
  function paramsLabel(params){
    if(!params) return '（無參數）';
    return params.map(i).join('｜');
  }

  window.SHARED = {
    MULT, FEE, TAX, SLIP, ENTRY, EXIT_L, EXIT_S,
    readAsTextAuto, parseTXT, buildReport,
    fmtMoney, pct, fmtTs, paramsLabel
  };
})();
