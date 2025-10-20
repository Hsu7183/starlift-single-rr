// etf-engine.js — 股票/ETF 計算核心（寬鬆 CSV & canonical；買/賣費用分列；強化動作判定）
(function (root){
  const DAY_MS = 24*60*60*1000;

  function yyyymmdd(ts14){ return ts14 ? ts14.slice(0,8) : ''; }
  function pad6(t){ t=String(t||''); return t.padStart(6,'0'); }
  function parseTs(ts14){
    const Y=+ts14.slice(0,4), M=+ts14.slice(4,6)-1, D=+ts14.slice(6,8),
          h=+ts14.slice(8,10), m=+ts14.slice(10,12), s=+ts14.slice(12,14);
    return new Date(Date.UTC(Y,M,D,h,m,s)).getTime();
  }

  // ---------- 解析 ----------
  const CANON_RE = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const CSV_RE   = /^(\d{8})\s*,\s*(\d{5,6})\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([^,]+)\s*(?:,(.*))?$/i;
  // 第4欄允許任意字（之後用 contains「買 / 賣 / 加碼」判定）

  function classifyAction(zhActRaw){
    const s = (zhActRaw||'').replace(/\s+/g,'');
    if (/賣/.test(s)) return 'sell';
    if (/買|加碼/.test(s)) return 'buy';
    return null; // 不識別的動作
  }

  // 回傳 rows: [{ts, tsMs, day, price, act, qtyUnits?}]
  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    const lines = text.replace(/\r\n?/g,'\n').split('\n');

    for(const raw0 of lines){
      const raw = raw0.trim(); if(!raw) continue;

      // 1) canonical
      let m = raw.match(CANON_RE);
      if(m){
        rows.push({ ts:m[1], tsMs:parseTs(m[1]), day:m[1].slice(0,8), price:+m[2], act:m[3] });
        continue;
      }

      // 2) CSV（先用正則）
      m = raw.match(CSV_RE);
      if(m){
        const d=m[1], t=pad6(m[2]); const ts=d+t;
        const price=+m[3], zhAct=m[4], tail=(m[5]||'');
        const kind = classifyAction(zhAct);
        if(!kind) continue;

        const act = (kind==='sell') ? '平賣' : '新買';
        let qtyUnits;
        if(kind==='sell'){
          const mm = tail.match(/總單位\s*[:=]\s*(\d+)/);
          if(mm) qtyUnits=+mm[1]; // 若抓不到，回測時會用「持有股數」當作出清
        }else{
          const mm = tail.match(/本次單位\s*[:=]\s*(\d+)/);
          qtyUnits = mm ? +mm[1] : 1;
        }
        rows.push({ ts, tsMs:parseTs(ts), day:d, price, act, qtyUnits });
        continue;
      }

      // 3) CSV（split 保底）
      const parts = raw.split(',').map(s=>s.trim());
      if(parts.length>=4 && /^\d{8}$/.test(parts[0]) && /^\d{5,6}$/.test(parts[1]) && !isNaN(+parts[2])){
        const d=parts[0], t=pad6(parts[1]), ts=d+t, price=+parts[2];
        const zhAct=parts[3], rest = parts.slice(4).join(',');
        const kind = classifyAction(zhAct);
        if(!kind) continue;

        const act = (kind==='sell') ? '平賣' : '新買';
        let qtyUnits;
        if(kind==='sell'){
          const mm = rest.match(/總單位\s*[:=]\s*(\d+)/);
          if(mm) qtyUnits=+mm[1];
        }else{
          const mm = rest.match(/本次單位\s*[:=]\s*(\d+)/);
          qtyUnits = mm ? +mm[1] : 1;
        }
        rows.push({ ts, tsMs:parseTs(ts), day:d, price, act, qtyUnits });
      }
    }
    rows.sort((a,b)=> a.ts.localeCompare(b.ts));
    return rows;
  }

  // ---------- 費用/滑價 ----------
  function fees(price, shares, cfg, isSell){
    const gross = price * shares;
    const fee = Math.max(cfg.minFee, gross * cfg.feeRate);
    const tax = isSell ? (gross * cfg.taxRate) : 0;
    return { fee, tax, total: fee + tax };
  }
  function slipPrice(price, side, cfg){
    const adj = (cfg.slippageTick||0) * (cfg.tickSize||0);
    return side==='buy' ? price + adj : price - adj;
  }

  // ---------- 回測 ----------
  function backtest(rows, cfg){
    const initial = cfg.initialCapital ?? 1_000_000;
    const lot = cfg.unitShares ?? 1000; // 每「單位」股數
    let shares = 0, avgCost = 0, cash = initial, realized = 0;

    const tradeRecs=[];
    let openTs=null, openPx=null, buyFeeAcc=0;

    const eqSeries=[], ddSeries=[];
    let peak = initial;

    for(const r of rows){
      const isBuy  = (r.act==='新買' || r.act==='平買');   // 本 CSV 僅會用到 新買 / 平賣
      const isSell = (r.act==='平賣' || r.act==='新賣');
      if(!(isBuy||isSell)) continue;

      const side = isBuy ? 'buy' : 'sell';
      const px = slipPrice(r.price, side, cfg);

      if(isBuy){
        const qty = (r.qtyUnits!=null ? r.qtyUnits : 1) * lot;
        const f = fees(px, qty, cfg, false); // 買進只有手續費
        const cost = px*qty + f.fee;
        cash -= cost;
        avgCost = (shares*avgCost + px*qty) / (shares + qty || 1);
        shares += qty;

        if(openTs==null){ openTs=r.ts; openPx=px; buyFeeAcc=0; }
        buyFeeAcc += f.fee;
      }else{
        // 賣出：若「總單位」缺失 → 預設一次出清
        const qty = (r.qtyUnits!=null ? r.qtyUnits*lot : shares);
        if(qty<=0) continue;

        const f = fees(px, qty, cfg, true); // 賣出：手續費 + 稅
        const proceeds = px*qty - f.fee - f.tax;
        cash += proceeds;

        const pnl = (px - avgCost)*qty - f.fee - f.tax; // 買方手續費已在買時扣
        realized += pnl;
        shares -= qty; if(shares<0) shares=0;

        tradeRecs.push({
          side:'LONG',
          inTs: openTs || r.ts,
          outTs: r.ts,
          inPx: openPx || avgCost,
          outPx: px,
          shares: qty,
          buyFee: Math.round(buyFeeAcc),
          sellFee: Math.round(f.fee),
          sellTax: Math.round(f.tax),
          pnl,
          holdDays: (parseTs(r.ts)-(openTs?parseTs(openTs):parseTs(r.ts)))/DAY_MS
        });

        // 清段
        openTs=null; openPx=null; buyFeeAcc=0;
        if(shares===0) avgCost=0;
      }

      const equity = cash + (shares!==0 ? shares*px : 0);
      if(equity>peak) peak=equity;
      const dd = (equity-peak)/peak;
      eqSeries.push({ t:r.tsMs, v:equity });
      ddSeries.push({ t:r.tsMs, v:dd });
    }

    return {
      initial, eqSeries, ddSeries,
      trades: tradeRecs,
      realized, lastCash: cash, lastShares: shares,
      lastPx: rows.length? rows[rows.length-1].price:0
    };
  }

  // ---------- KPI ----------
  function dailyReturnsFromSeries(eqSeries){
    if(eqSeries.length<2) return [];
    const byDay=new Map();
    for(const p of eqSeries){
      const d = new Date(p.t).toISOString().slice(0,10);
      byDay.set(d, p.v);
    }
    const days=[...byDay.keys()].sort(); const rets=[];
    for(let i=1;i<days.length;i++){
      const prev=byDay.get(days[i-1]), cur=byDay.get(days[i]);
      if(prev>0) rets.push((cur/prev)-1);
    }
    return rets;
  }

  function sum(a){ return a.reduce((s,x)=>s+(+x||0),0); }
  function avg(a){ return a.length? sum(a)/a.length : 0; }
  function std(a){ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(avg(a.map(x=>(x-m)*(x-m)))); }
  function percentile(arr, p){ if(!arr.length) return 0; const a=[...arr].sort((x,y)=>x-y); const i=Math.min(a.length-1,Math.max(0,Math.floor(p*(a.length-1)))); return a[i]; }
  function skewness(a){ if(a.length<3) return 0; const m=avg(a), s=std(a); if(s===0) return 0; const n=a.length; return (n/((n-1)*(n-2))) * sum(a.map(x=>Math.pow((x-m)/s,3))); }
  function kurtosis(a){ if(a.length<4) return 0; const m=avg(a), s=std(a); if(s===0) return 0; const n=a.length; const num=(n*(n+1))/((n-1)*(n-2)*(n-3))*sum(a.map(x=>Math.pow((x-m)/s,4))); const den=(3*(n-1)*(n-1))/((n-2)*(n-3)); return num - den; }

  function statsKPI(bt, cfg){
    const eq = bt.eqSeries.map(x=>x.v);
    const startV = bt.initial;
    const endV = eq.length? eq[eq.length-1] : bt.initial;
    const totalRet = (endV/startV)-1;

    const t0 = bt.eqSeries.length? bt.eqSeries[0].t : Date.now();
    const t1 = bt.eqSeries.length? bt.eqSeries[bt.eqSeries.length-1].t : t0;
    const years = Math.max(1/365, (t1 - t0)/(365*DAY_MS));
    const CAGR = Math.pow(1+totalRet, 1/years) - 1;

    let peak = -Infinity, maxDD = 0;
    for(const v of eq){ if(v>peak) peak=v; const dd=(v-peak)/peak; if(dd<maxDD) maxDD=dd; }

    const dR = dailyReturnsFromSeries(bt.eqSeries);
    const annVol = dR.length>1 ? (std(dR) * Math.sqrt(252)) : 0;
    const rf = cfg.rf ?? 0;
    const avgD = dR.length? avg(dR):0;
    const sharpe = annVol>0 ? ((avgD - rf/252) * 252) / annVol : 0;
    const downside = std(dR.filter(x=>x<0)) * Math.sqrt(252);
    const sortino = downside>0 ? ((avgD - rf/252) * 252) / downside : 0;
    const calmar = maxDD<0 ? (CAGR/Math.abs(maxDD)) : 0;

    const wins = bt.trades.filter(t=>t.pnl>0), losses=bt.trades.filter(t=>t.pnl<0);
    const pf = (sum(wins.map(t=>t.pnl)))/(Math.abs(sum(losses.map(t=>t.pnl)))||1);
    const winRate = bt.trades.length? wins.length/bt.trades.length : 0;
    const expectancy = bt.trades.length? sum(bt.trades.map(t=>t.pnl))/bt.trades.length : 0;
    const avgHoldDays = bt.trades.length? avg(bt.trades.map(t=>t.holdDays)) : 0;

    const ddVals = bt.ddSeries.map(x=>x.v).filter(x=>x<0).map(x=>Math.abs(x));
    const ddAvg = ddVals.length? avg(ddVals):0;
    const ddP95 = percentile(ddVals,0.95);
    const skew = skewness(dR), kurt = kurtosis(dR);

    return {
      startDate: yyyymmdd(new Date(t0).toISOString().replaceAll('-','')),
      endDate:   yyyymmdd(new Date(t1).toISOString().replaceAll('-','')),
      core:{ totalReturn:totalRet, CAGR, annVol, sharpe, sortino, maxDD, calmar, profitFactor:pf, winRate, expectancy, avgHoldDays },
      risk:{ downsideDev:downside, ddAvg, ddP95, skew, kurt }
    };
  }

  root.ETF_ENGINE = { parseCanon, backtest, statsKPI };
})(window);
