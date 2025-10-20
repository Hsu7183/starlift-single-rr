// etf-engine.js — 純做多ETF核心（CSV/Canonical；賣出一律全數出清；費用分列；帶偵錯資訊）
(function (root){
  const DAY_MS = 24*60*60*1000;

  function pad6(t){ t=String(t||''); return t.padStart(6,'0'); }
  function parseTs(ts14){
    const Y=+ts14.slice(0,4), M=+ts14.slice(4,6)-1, D=+ts14.slice(6,8),
          h=+ts14.slice(8,10), m=+ts14.slice(10,12), s=+ts14.slice(12,14);
    return new Date(Date.UTC(Y,M,D,h,m,s)).getTime();
  }
  function ymd(tsMs){ return new Date(tsMs).toISOString().slice(0,10).replace(/-/g,''); }

  // === 解析 ===
  const CANON_RE = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣)\s*$/;   // 純做多只用 新買/平賣
  const CSV_RE   = /^(\d{8})\s*,\s*(\d{5,6})\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([^,]+)\s*(?:,(.*))?$/i;

  function classify(zh){
    const s=(zh||'').replace(/\s+/g,'');
    if(/賣/.test(s)) return 'sell';
    if(/買|加碼/.test(s)) return 'buy';
    return null;
  }

  // 解析文字為 rows：{ ts, tsMs, day, price, kind, units? }，並附帶 debug 訊息
  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    const lines=text.replace(/\r\n?/g,'\n').split('\n');

    let dbg = { total:0, parsed:0, buy:0, sell:0, samples:[], rejects:[] };

    for(let idx=0; idx<lines.length; idx++){
      const raw0 = lines[idx];
      const line=(raw0||'').trim();
      if(!line){ continue; }
      dbg.total++;

      // canonical（僅新買/平賣）
      let m=line.match(CANON_RE);
      if(m){
        const rec={ ts:m[1], tsMs:parseTs(m[1]), day:m[1].slice(0,8), price:+m[2],
                    kind:(m[3]==='平賣'?'sell':'buy'), units:undefined };
        rows.push(rec);
        dbg.parsed++; dbg[rec.kind]++; if(dbg.samples.length<5) dbg.samples.push({idx, line});
        continue;
      }

      // CSV
      m=line.match(CSV_RE);
      if(m){
        const d=m[1], t=pad6(m[2]), ts=d+t, px=+m[3], zh=m[4], tail=m[5]||'';
        const k=classify(zh);
        if(!k){ dbg.rejects.push({idx, line}); continue; }
        let units;
        if(k==='buy'){
          const mm = tail.match(/本次單位\s*[:=]\s*(\d+)/);
          units = mm ? +mm[1] : 1; // 沒寫就視為1單位
        }
        const rec={ ts, tsMs:parseTs(ts), day:d, price:px, kind:k, units };
        rows.push(rec);
        dbg.parsed++; dbg[k]++; if(dbg.samples.length<5) dbg.samples.push({idx, line});
        continue;
      }

      // CSV split 保底
      const p=line.split(',').map(s=>s.trim());
      if(p.length>=4 && /^\d{8}$/.test(p[0]) && /^\d{5,6}$/.test(p[1]) && !isNaN(+p[2])){
        const d=p[0], t=pad6(p[1]), ts=d+t, px=+p[2], zh=p[3], rest=p.slice(4).join(',');
        const k=classify(zh);
        if(!k){ dbg.rejects.push({idx, line}); continue; }
        let units;
        if(k==='buy'){
          const mm = rest.match(/本次單位\s*[:=]\s*(\d+)/);
          units = mm ? +mm[1] : 1;
        }
        const rec={ ts, tsMs:parseTs(ts), day:d, price:px, kind:k, units };
        rows.push(rec);
        dbg.parsed++; dbg[k]++; if(dbg.samples.length<5) dbg.samples.push({idx, line});
      }else{
        dbg.rejects.push({idx, line});
      }
    }
    rows.sort((a,b)=>a.ts.localeCompare(b.ts));
    // 把 debug 附在函式屬性上，供控制器讀取（避免破壞既有回傳型別）
    rows.__debug = dbg;
    return rows;
  }

  // === 費用（台股ETF）===
  function fees(price, shares, cfg, isSell){
    const gross = price * shares;
    const fee = Math.max(cfg.minFee, gross * cfg.feeRate);
    const tax = isSell ? (gross * cfg.taxRate) : 0;
    return { fee, tax, total: fee + tax };
  }

  // === 回測（純做多；賣出永遠全數出清）===
  function backtest(rows, cfg){
    const lot = cfg.unitShares ?? 1000;
    const init = cfg.initialCapital ?? 1_000_000;
    let shares = 0, avgCost = 0, cash = init, realized = 0;

    let openTs=null, openPx=null, buyFeeAcc=0;
    const eqSeries=[], ddSeries=[], trades=[];
    let peak = init;

    for(const r of rows){
      if(r.kind==='buy'){
        const qty = (r.units ?? 1) * lot;
        const f = fees(r.price, qty, cfg, false);
        const cost = r.price*qty + f.fee;
        cash   -= cost;
        avgCost = (shares*avgCost + r.price*qty) / (shares + qty || 1);
        shares += qty;
        if(openTs==null){ openTs=r.ts; openPx=r.price; buyFeeAcc=0; }
        buyFeeAcc += f.fee;
      }else if(r.kind==='sell'){
        if(shares<=0) continue;
        const qty = shares; // 全部出清
        const f = fees(r.price, qty, cfg, true);
        const proceeds = r.price*qty - f.fee - f.tax;
        cash += proceeds;
        const pnl = (r.price - avgCost)*qty - f.fee - f.tax;
        realized += pnl;
        trades.push({
          side:'LONG',
          inTs: openTs || r.ts,
          outTs: r.ts,
          inPx: openPx || avgCost,
          outPx: r.price,
          shares: qty,
          buyFee: Math.round(buyFeeAcc),
          sellFee: Math.round(f.fee),
          sellTax: Math.round(f.tax),
          pnl,
          holdDays: (parseTs(r.ts)-(openTs?parseTs(openTs):parseTs(r.ts)))/DAY_MS
        });
        shares=0; avgCost=0; openTs=null; openPx=null; buyFeeAcc=0;
      }

      const markEquity = cash + shares * r.price;
      if(markEquity>peak) peak=markEquity;
      const dd = (markEquity-peak)/peak;
      eqSeries.push({ t:r.tsMs, v:markEquity });
      ddSeries.push({ t:r.tsMs, v:dd });
    }

    return {
      initial: init,
      eqSeries, ddSeries, trades,
      realized, lastCash: cash, lastShares: shares,
      lastPx: rows.length ? rows[rows.length-1].price : 0
    };
  }

  // === KPI ===
  function dailyReturns(eqSeries){
    if(eqSeries.length<2) return [];
    const byDay=new Map();
    for(const p of eqSeries){ byDay.set(ymd(p.t), p.v); }
    const days=[...byDay.keys()].sort(), rets=[];
    for(let i=1;i<days.length;i++){
      const a=byDay.get(days[i-1]), b=byDay.get(days[i]);
      if(a>0) rets.push(b/a-1);
    }
    return rets;
  }
  const sum=a=>a.reduce((s,x)=>s+(+x||0),0);
  const avg=a=>a.length? sum(a)/a.length : 0;
  const std=a=>{ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(avg(a.map(x=>(x-m)*(x-m)))); };
  const pct=(arr,p)=>{ if(!arr.length) return 0; const a=[...arr].sort((x,y)=>x-y); const i=Math.min(a.length-1,Math.max(0,Math.floor(p*(a.length-1)))); return a[i]; };
  const skew=a=>{ if(a.length<3) return 0; const m=avg(a), s=std(a); if(s===0) return 0; const n=a.length; return (n/((n-1)*(n-2))) * sum(a.map(x=>Math.pow((x-m)/s,3))); };
  const kurt=a=>{ if(a.length<4) return 0; const m=avg(a), s=std(a); if(s===0) return 0; const n=a.length; const num=(n*(n+1))/((n-1)*(n-2)*(n-3))*sum(a.map(x=>Math.pow((x-m)/s,4))); const den=(3*(n-1)*(n-1))/((n-2)*(n-3)); return num - den; };

  function statsKPI(bt, cfg){
    const eq  = bt.eqSeries.map(x=>x.v);
    const v0  = bt.initial;
    const v1  = eq.length? eq[eq.length-1] : v0;
    const tr  = v1/v0 - 1;

    const t0  = bt.eqSeries.length? bt.eqSeries[0].t : Date.now();
    const t1  = bt.eqSeries.length? bt.eqSeries[bt.eqSeries.length-1].t : t0;
    const yrs = Math.max(1/365, (t1 - t0)/(365*DAY_MS));
    const CAGR = Math.pow(1+tr, 1/yrs) - 1;

    let peak=-Infinity, maxDD=0;
    for(const v of eq){ if(v>peak) peak=v; const dd=(v-peak)/peak; if(dd<maxDD) maxDD=dd; }

    const dR = dailyReturns(bt.eqSeries);
    const vol = dR.length>1 ? std(dR)*Math.sqrt(252) : 0;
    const rf  = cfg.rf ?? 0;
    const mean= dR.length? avg(dR) : 0;
    const sharpe  = vol>0 ? ((mean - rf/252)*252)/vol : 0;
    const downside= std(dR.filter(x=>x<0))*Math.sqrt(252);
    const sortino = downside>0 ? ((mean - rf/252)*252)/downside : 0;
    const calmar  = maxDD<0 ? (CAGR/Math.abs(maxDD)) : 0;

    const wins = bt.trades.filter(t=>t.pnl>0), losses=bt.trades.filter(t=>t.pnl<0);
    const pf   = (sum(wins.map(t=>t.pnl)))/(Math.abs(sum(losses.map(t=>t.pnl)))||1);
    const wr   = bt.trades.length ? wins.length/bt.trades.length : 0;
    const exp  = bt.trades.length ? sum(bt.trades.map(t=>t.pnl))/bt.trades.length : 0;
    const hold = bt.trades.length ? avg(bt.trades.map(t=>t.holdDays)) : 0;

    const ddVals = bt.ddSeries.map(x=>x.v).filter(x=>x<0).map(x=>Math.abs(x));
    return {
      startDate: ymd(t0),
      endDate:   ymd(t1),
      core: { totalReturn:tr, CAGR, annVol:vol, sharpe, sortino, maxDD, calmar,
              profitFactor:pf, winRate:wr, expectancy:exp, avgHoldDays:hold },
      risk: { downsideDev:downside, ddAvg: avg(ddVals), ddP95: pct(ddVals,0.95),
              skew:skew(dR), kurt:kurt(dR) }
    };
  }

  root.ETF_ENGINE = { parseCanon, backtest, statsKPI };
})(window);
