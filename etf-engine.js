// etf-engine.js — 純做多ETF核心（逐筆成交採用「賣出金額－期間買進金額－賣方費用/稅」口徑 + 累計損益）
(function (root){
  const DAY_MS = 24*60*60*1000;
  const to6 = t => String(t||'').padStart(6,'0');
  function parseTs(ts14){
    const Y=+ts14.slice(0,4), M=+ts14.slice(4,6)-1, D=+ts14.slice(6,8),
          h=+ts14.slice(8,10), m=+ts14.slice(10,12), s=+ts14.slice(12,14);
    return new Date(Date.UTC(Y,M,D,h,m,s)).getTime();
  }
  const ymd = ms => new Date(ms).toISOString().slice(0,10).replace(/-/g,'');

  const CANON_RE = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣)\s*$/;

  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    const norm=text.replace(/\ufeff/gi,'').replace(/\r\n?/g,'\n').replace(/\u3000/g,' ').replace(/，/g,',');
    const lines=norm.split('\n');
    const dbg={ total:0, parsed:0, buy:0, sell:0, samples:[], rejects:[] };

    for(let i=0;i<lines.length;i++){
      let line=(lines[i]||'').trim(); if(!line) continue; dbg.total++;

      if(/日期\s*[,|\t]\s*時間\s*[,|\t]\s*價格/i.test(line) ||
         /^日期$|^時間$|^價格$|^動作$|^說明$/i.test(line)) continue;

      let m=line.match(CANON_RE);
      if(m){
        const rec={ ts:m[1], tsMs:parseTs(m[1]), day:m[1].slice(0,8), price:+m[2], kind:(m[3]==='平賣'?'sell':'buy'), units:undefined };
        rows.push(rec); dbg.parsed++; dbg[rec.kind]++; if(dbg.samples.length<5) dbg.samples.push({i,line}); continue;
      }

      const parts=line.split(/[\t,]+/).map(s=>s.trim()).filter(Boolean);
      if(parts.length>=4){
        const d=parts[0]; if(!/^\d{8}$/.test(d)) continue;
        const t=to6(parts[1]), px=parts[2], zh=parts[3];
        if(isNaN(+px)){ dbg.rejects.push({i,line}); continue; }

        const actTxt=(zh||'').replace(/\s+/g,'');
        let kind=null; if(/賣/.test(actTxt)) kind='sell'; else if(/買|加碼/.test(actTxt)) kind='buy';
        if(!kind){ dbg.rejects.push({i,line}); continue; }

        let units; const rest=parts.slice(4).join(',');
        if(kind==='buy'){ const mm=rest.match(/本次單位\s*[:=]\s*(\d+)/); units=mm?+mm[1]:1; }

        const ts=d+to6(t);
        rows.push({ ts, tsMs:parseTs(ts), day:d, price:+px, kind, units });
        dbg.parsed++; dbg[kind]++; if(dbg.samples.length<5) dbg.samples.push({i,line});
        continue;
      }
      dbg.rejects.push({i,line});
    }
    rows.sort((a,b)=>a.ts.localeCompare(b.ts));
    rows.__debug=dbg;
    return rows;
  }

  function fees(price, shares, cfg, isSell){
    const gross=price*shares;
    const fee=Math.max(cfg.minFee, gross*cfg.feeRate);
    const tax=isSell ? (gross*cfg.taxRate) : 0;
    return { gross, fee, tax, total:fee+tax };
  }

  // 逐筆損益（使用者口徑）：賣出金額 − 期間買進金額 −（賣方手續費+交易稅）
  function backtest(rows, cfg){
    const lot=cfg.unitShares ?? 1000, init=cfg.initialCapital ?? 1_000_000;
    let shares=0, avgCost=0, cash=init;

    // 期間內的「買進金額累積（不含費用）」與 累計損益（使用者口徑）
    let posBuyGross=0, cumPnlUser=0;

    let openTs=null, openPx=null, buyFeeAcc=0;
    const eqSeries=[], ddSeries=[], trades=[], execs=[];
    let peak=init;

    for(const r of rows){
      if(r.kind==='buy'){
        const qty=(r.units ?? 1)*lot;
        const f=fees(r.price, qty, cfg, false);
        cash -= (f.gross + f.fee);
        posBuyGross += f.gross;                                      // 只加買進金額（不含費用）
        const newAvg=(shares*avgCost + r.price*qty)/(shares+qty||1);
        shares+=qty; avgCost=newAvg;

        if(openTs==null){ openTs=r.ts; openPx=r.price; buyFeeAcc=0; }
        buyFeeAcc += f.fee;

        execs.push({
          side:'BUY', ts:r.ts, tsMs:r.tsMs, price:r.price,
          avgCost:newAvg, shares:qty,
          buyAmount:f.gross, sellAmount:0,
          fee:f.fee, tax:0,
          costOut:f.gross + f.fee,
          pnlUser:null, retPct:null, cumPnlUser,
          cashDelta:-(f.gross+f.fee), cashAfter:cash, sharesAfter:shares
        });
      }else{ // SELL（全數出清）
        if(shares<=0) continue;
        const qty=shares;
        const f=fees(r.price, qty, cfg, true);
        cash += (f.gross - f.fee - f.tax);

        // 使用者口徑：賣出金額 - 期間買進金額 - （賣方費用+稅）
        const pnlUser = f.gross - posBuyGross - (f.fee + f.tax);
        const retPct = posBuyGross>0 ? (pnlUser / posBuyGross) : 0;
        cumPnlUser += pnlUser;

        // 標準 round-trip（仍保留）
        const costBasis = avgCost*qty;
        const pnlStd = (f.gross - f.fee - f.tax) - costBasis;
        const holdDays=(parseTs(r.ts)-(openTs?parseTs(openTs):parseTs(r.ts)))/DAY_MS;
        trades.push({
          side:'LONG', inTs:openTs||r.ts, outTs:r.ts, inPx:openPx||avgCost, outPx:r.price,
          shares:qty, buyFee:Math.round(buyFeeAcc), sellFee:Math.round(f.fee), sellTax:Math.round(f.tax),
          pnl:pnlStd, holdDays
        });

        execs.push({
          side:'SELL', ts:r.ts, tsMs:r.tsMs, price:r.price,
          avgCost:avgCost, shares:qty,
          buyAmount:0, sellAmount:f.gross,
          fee:f.fee, tax:f.tax,
          costOut:0,
          pnlUser, retPct, cumPnlUser,
          cashDelta:(f.gross - f.fee - f.tax), cashAfter:cash, sharesAfter:0
        });

        // 重置一段
        shares=0; avgCost=0; openTs=null; openPx=null; buyFeeAcc=0; posBuyGross=0;
      }

      const equity=cash + shares*r.price;
      if(equity>peak) peak=equity;
      eqSeries.push({t:r.tsMs, v:equity});
      ddSeries.push({t:r.tsMs, v:(equity-peak)/peak});
    }

    return { initial:init, eqSeries, ddSeries, trades, execs, lastCash:cash, lastShares:shares };
  }

  // KPI 同前（略寫）
  const sum=a=>a.reduce((s,x)=>s+(+x||0),0);
  const avg=a=>a.length? sum(a)/a.length : 0;
  const std=a=>{ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(avg(a.map(x=>(x-m)*(x-m)))); };
  const pct=(arr,p)=>{ if(!arr.length) return 0; const a=[...arr].sort((x,y)=>x-y); const i=Math.min(a.length-1,Math.max(0,Math.floor(p*(a.length-1)))); return a[i]; };
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
    let peak=-Infinity,maxDD=0; for(const v of eq){ if(v>peak) peak=v; const dd=(v-peak)/peak; if(dd<maxDD) maxDD=dd; }
    const dR=dailyReturns(bt.eqSeries); const vol=dR.length>1? std(dR)*Math.sqrt(252):0; const rf=cfg.rf??0; const mean=dR.length?avg(dR):0;
    const sharpe=vol>0? ((mean-rf/252)*252)/vol:0; const downside=std(dR.filter(x=>x<0))*Math.sqrt(252); const sortino=downside>0? ((mean-rf/252)*252)/downside:0;
    const wins=[], losses=[]; // 圖表用不到，忽略詳細
    return { startDate: ymd(t0), endDate: ymd(t1),
      core:{ totalReturn:tr, CAGR, annVol:vol, sharpe:0, sortino:0, maxDD, calmar: (maxDD<0? ( (Math.pow(1+tr,1/yrs)-1)/Math.abs(maxDD) ):0),
             profitFactor:0, winRate:0, expectancy:0, avgHoldDays:0 },
      risk:{ downsideDev:0, ddAvg:0, ddP95:0, skew:0, kurt:0 } };
  }

  root.ETF_ENGINE={ parseCanon, backtest, statsKPI };
})(window);
