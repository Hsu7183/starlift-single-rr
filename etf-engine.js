// etf-engine.js — 純做多ETF核心（超寬鬆 CSV / Canonical；賣出全數出清；費用分列；debug + 完整逐筆成交欄位）
(function (root){
  const DAY_MS = 24*60*60*1000;
  const to6 = t => String(t||'').padStart(6,'0');
  function parseTs(ts14){
    const Y=+ts14.slice(0,4), M=+ts14.slice(4,6)-1, D=+ts14.slice(6,8),
          h=+ts14.slice(8,10), m=+ts14.slice(10,12), s=+ts14.slice(12,14);
    return new Date(Date.UTC(Y,M,D,h,m,s)).getTime();
  }
  const ymd = ms => new Date(ms).toISOString().slice(0,10).replace(/-/g,'');

  // canonical（純做多保留新買/平賣）
  const CANON_RE = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣)\s*$/;

  // ---- 解析：rows + __debug ----
  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    const norm = text.replace(/\ufeff/gi,'').replace(/\r\n?/g,'\n').replace(/\u3000/g,' ').replace(/，/g,',');
    const lines = norm.split('\n');
    const dbg = { total:0, parsed:0, buy:0, sell:0, samples:[], rejects:[] };

    for (let idx=0; idx<lines.length; idx++){
      let line=(lines[idx]||'').trim(); if(!line) continue; dbg.total++;

      // 任意位置的表頭/說明列
      if (/日期\s*[,|\t]\s*時間\s*[,|\t]\s*價格/i.test(line) ||
          /^日期$|^時間$|^價格$|^動作$|^說明$/i.test(line)) continue;

      // canonical
      let m=line.match(CANON_RE);
      if (m){
        const rec={ ts:m[1], tsMs:parseTs(m[1]), day:m[1].slice(0,8), price:+m[2], kind:(m[3]==='平賣'?'sell':'buy'), units:undefined };
        rows.push(rec); dbg.parsed++; dbg[rec.kind]++; if(dbg.samples.length<5) dbg.samples.push({idx,line}); continue;
      }

      // 超寬鬆 CSV（逗號/Tab）
      const parts=line.split(/[\t,]+/).map(s=>s.trim()).filter(Boolean);
      if (parts.length>=4){
        const d=parts[0];
        if (!/^\d{8}$/.test(d)) continue;
        const t=to6(parts[1]), px=parts[2], zh=parts[3];
        if (isNaN(+px)) { dbg.rejects.push({idx,line}); continue; }

        const actTxt=(zh||'').replace(/\s+/g,'');
        let kind=null; if (/賣/.test(actTxt)) kind='sell'; else if (/買|加碼/.test(actTxt)) kind='buy';
        if(!kind){ dbg.rejects.push({idx,line}); continue; }

        let units; const rest=parts.slice(4).join(',');
        if(kind==='buy'){ const mm=rest.match(/本次單位\s*[:=]\s*(\d+)/); units = mm? +mm[1] : 1; }

        const ts=d+to6(t);
        const rec={ ts, tsMs:parseTs(ts), day:d, price:+px, kind, units };
        rows.push(rec); dbg.parsed++; dbg[kind]++; if(dbg.samples.length<5) dbg.samples.push({idx,line}); continue;
      }

      dbg.rejects.push({idx,line});
    }

    rows.sort((a,b)=>a.ts.localeCompare(b.ts));
    rows.__debug=dbg;
    return rows;
  }

  // 費用
  function fees(price, shares, cfg, isSell){
    const gross=price*shares;
    const fee=Math.max(cfg.minFee, gross*cfg.feeRate);
    const tax=isSell ? (gross*cfg.taxRate) : 0;
    return { fee, tax, gross, total:fee+tax };
  }

  // 回測（純做多；賣出＝全數出清）＋ 逐筆成交 execs（含你要的欄位）
  function backtest(rows, cfg){
    const lot=cfg.unitShares ?? 1000, init=cfg.initialCapital ?? 1_000_000;
    let shares=0, avgCost=0, cash=init, realized=0;

    let openTs=null, openPx=null, buyFeeAcc=0;
    const eqSeries=[], ddSeries=[], trades=[], execs=[];
    let peak=init;

    for (const r of rows){
      if (r.kind==='buy'){
        const qty=(r.units ?? 1)*lot;
        const f=fees(r.price, qty, cfg, false);
        const buyAmt = f.gross;                       // 買進金額（不含費用）
        const outlay = f.gross + f.fee;               // 付出成本（含費用）
        cash -= outlay;

        // 新均價（含所有既有股數）
        const newAvg = (shares*avgCost + r.price*qty) / (shares + qty || 1);
        shares += qty; avgCost = newAvg;

        if(openTs==null){ openTs=r.ts; openPx=r.price; buyFeeAcc=0; }
        buyFeeAcc += f.fee;

        execs.push({
          side:'BUY', ts:r.ts, tsMs:r.tsMs, price:r.price,
          avgCost:newAvg, shares:qty,
          buyAmount:buyAmt, sellAmount:0,
          fee:f.fee, tax:0,
          costOut: outlay,               // 付出成本（買才有）
          pnl: 0, retPct: null,          // 買進不計損益
          cashDelta: -outlay, cashAfter: cash, sharesAfter: shares
        });
      }else if (r.kind==='sell'){
        if(shares<=0) continue;
        const qty=shares;                           // 全部出清
        const f=fees(r.price, qty, cfg, true);
        const sellAmt = f.gross;                    // 賣出金額（不含費用/稅）
        const costBasis = avgCost * qty;            // 成本基礎（均價*數量）
        const pnl = sellAmt - f.fee - f.tax - costBasis;
        const retPct = costBasis>0 ? (pnl / costBasis) : 0;

        cash += (sellAmt - f.fee - f.tax);
        realized += pnl;

        trades.push({
          side:'LONG',
          inTs:openTs||r.ts, outTs:r.ts,
          inPx:openPx||avgCost, outPx:r.price,
          shares:qty, buyFee:Math.round(buyFeeAcc),
          sellFee:Math.round(f.fee), sellTax:Math.round(f.tax),
          pnl, holdDays:(parseTs(r.ts)-(openTs?parseTs(openTs):parseTs(r.ts)))/DAY_MS
        });

        execs.push({
          side:'SELL', ts:r.ts, tsMs:r.tsMs, price:r.price,
          avgCost:avgCost, shares:qty,
          buyAmount:0, sellAmount:sellAmt,
          fee:f.fee, tax:f.tax,
          costOut: 0,                   // 賣出不屬於付出成本
          pnl, retPct,
          cashDelta: (sellAmt - f.fee - f.tax),
          cashAfter: cash, sharesAfter: 0
        });

        // 重置
        shares=0; avgCost=0; openTs=null; openPx=null; buyFeeAcc=0;
      }

      const equity=cash + shares*r.price;
      if(equity>peak) peak=equity;
      eqSeries.push({t:r.tsMs, v:equity});
      ddSeries.push({t:r.tsMs, v:(equity-peak)/peak});
    }

    return { initial:init, eqSeries, ddSeries, trades, execs, realized,
             lastCash:cash, lastShares:shares, lastPx: rows.length? rows[rows.length-1].price:0 };
  }

  // KPI（同前）
  const sum=a=>a.reduce((s,x)=>s+(+x||0),0);
  const avg=a=>a.length? sum(a)/a.length : 0;
  const std=a=>{ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(avg(a.map(x=>(x-m)*(x-m)))); };
  const pct=(arr,p)=>{ if(!arr.length) return 0; const a=[...arr].sort((x,y)=>x-y); const i=Math.min(a.length-1,Math.max(0,Math.floor(p*(a.length-1)))); return a[i]; };
  const skew=a=>{ if(a.length<3) return 0; const m=avg(a), s=std(a); if(s===0) return 0; const n=a.length; return (n/((n-1)*(n-2))) * sum(a.map(x=>Math.pow((x-m)/s,3))); };
  const kurt=a=>{ if(a.length<4) return 0; const m=avg(a), s=std(a); if(s===0) return 0; const n=a.length; const num=(n*(n+1))/((n-1)*(n-2)*(n-3))*sum(a.map(x=>Math.pow((x-m)/s,4))); const den=(3*(n-1)*(n-1))/((n-2)*(n-3)); return num - den; };
  function dailyReturns(series){
    if(series.length<2) return [];
    const byDay=new Map(); series.forEach(p=>byDay.set(new Date(p.t).toISOString().slice(0,10), p.v));
    const days=[...byDay.keys()].sort(), rets=[];
    for(let i=1;i<days.length;i++){ const a=byDay.get(days[i-1]), b=byDay.get(days[i]); if(a>0) rets.push(b/a-1); }
    return rets;
  }
  function statsKPI(bt, cfg){
    const eq=bt.eqSeries.map(x=>x.v), v0=bt.initial, v1=eq.length?eq[eq.length-1]:v0;
    const tr=v1/v0-1, t0=bt.eqSeries[0]?.t ?? Date.now(), t1=bt.eqSeries.at(-1)?.t ?? t0;
    const yrs=Math.max(1/365,(t1-t0)/DAY_MS/365);
    const CAGR=Math.pow(1+tr,1/yrs)-1;
    let peak=-Infinity, maxDD=0; for(const v of eq){ if(v>peak) peak=v; const dd=(v-peak)/peak; if(dd<maxDD) maxDD=dd; }
    const dR=dailyReturns(bt.eqSeries); const vol=dR.length>1? std(dR)*Math.sqrt(252):0; const rf=cfg.rf??0; const mean=dR.length?avg(dR):0;
    const sharpe=vol>0? ((mean-rf/252)*252)/vol:0; const downside=std(dR.filter(x=>x<0))*Math.sqrt(252);
    const sortino=downside>0? ((mean-rf/252)*252)/downside:0; const calmar=maxDD<0? (CAGR/Math.abs(maxDD)):0;
    const wins=bt.trades.filter(t=>t.pnl>0), losses=bt.trades.filter(t=>t.pnl<0);
    const pf=(sum(wins.map(t=>t.pnl)))/(Math.abs(sum(losses.map(t=>t.pnl)))||1);
    const wr=bt.trades.length? wins.length/bt.trades.length:0;
    const exp=bt.trades.length? sum(bt.trades.map(t=>t.pnl))/bt.trades.length:0;
    const hold=bt.trades.length? avg(bt.trades.map(t=>t.holdDays)):0;
    const ddVals=bt.ddSeries.map(x=>x.v).filter(x=>x<0).map(x=>Math.abs(x));
    return { startDate: ymd(t0), endDate: ymd(t1),
      core:{ totalReturn:tr, CAGR, annVol:vol, sharpe, sortino, maxDD, calmar, profitFactor:pf, winRate:wr, expectancy:exp, avgHoldDays:hold },
      risk:{ downsideDev:downside, ddAvg:avg(ddVals), ddP95:pct(ddVals,0.95), skew:skew(dR), kurt:kurt(dR) } };
  }

  root.ETF_ENGINE={ parseCanon, backtest, statsKPI };
})(window);
