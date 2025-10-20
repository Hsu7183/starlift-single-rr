// etf-engine.js — 全費口徑（含買方手續費）＋ 累計成本 ＋ 多單位平均報酬率
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

  // 解析 CSV/Canonical 為 rows
  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    const norm=text.replace(/\ufeff/gi,'').replace(/\r\n?/g,'\n').replace(/\u3000/g,' ').replace(/，/g,',');
    const lines=norm.split('\n');
    const dbg={ total:0, parsed:0, buy:0, sell:0, rejects:[] };

    for(const raw of lines){
      const line=(raw||'').trim(); if(!line){continue;} dbg.total++;

      if(/日期\s*[,|\t]\s*時間\s*[,|\t]\s*價格/i.test(line) ||
         /^日期$|^時間$|^價格$|^動作$|^說明$/i.test(line)) continue;

      let m=line.match(CANON_RE);
      if(m){
        rows.push({ ts:m[1], tsMs:parseTs(m[1]), day:m[1].slice(0,8), price:+m[2],
                    kind:(m[3]==='平賣'?'sell':'buy'), units:undefined });
        dbg.parsed++; dbg[m[3]==='平賣'?'sell':'buy']++; continue;
      }

      const parts=line.split(/[\t,]+/).map(s=>s.trim()).filter(Boolean);
      if(parts.length>=4){
        const d=parts[0]; if(!/^\d{8}$/.test(d)) continue;
        const t=to6(parts[1]), px=parts[2], zh=parts[3];
        if(isNaN(+px)){ dbg.rejects.push(line); continue; }
        const actTxt=(zh||'').replace(/\s+/g,'');
        let kind=null; if(/賣/.test(actTxt)) kind='sell'; else if(/買|加碼/.test(actTxt)) kind='buy';
        if(!kind){ dbg.rejects.push(line); continue; }

        let units; const rest=parts.slice(4).join(',');
        if(kind==='buy'){ const mm=rest.match(/本次單位\s*[:=]\s*(\d+)/); units=mm?+mm[1]:1; }

        const ts=d+to6(t);
        rows.push({ ts, tsMs:parseTs(ts), day:d, price:+px, kind, units });
        dbg.parsed++; dbg[kind]++; continue;
      }
      dbg.rejects.push(line);
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
    return { gross, fee, tax, total:fee+tax };
  }

  // 回測（全費口徑）：賣出金額 − (期間買進金額 + 買方費用總和) − (賣方手續費 + 交易稅)
  function backtest(rows, cfg){
    const lot = cfg.unitShares ?? 1000;   // 一單位 = 幾股
    const init = cfg.initialCapital ?? 1_000_000;

    let shares=0, avgCost=0, cash=init;

    // 一段內的「累計成本」= Σ(買進金額 + 買方手續費)
    let cumCostFull=0;
    // 單位數（累計）：Σ(本次單位)
    let unitsInPeriod=0;

    // 全局累計損益（全費口徑）
    let cumPnlAll=0;

    const eqSeries=[], ddSeries=[], trades=[], execs=[];
    let peak=init, openTs=null, openPx=null, buyFeeAcc=0;

    for(const r of rows){
      if(r.kind==='buy'){
        const qty=(r.units ?? 1)*lot;
        const f=fees(r.price, qty, cfg, false);
        const cost = f.gross + f.fee;   // 成本(含買方手續費)

        cash -= cost;
        cumCostFull += cost;
        unitsInPeriod += (r.units ?? 1);

        // 更新均價（不含費用，與券商習慣一致）
        const newAvg = (shares*avgCost + r.price*qty) / (shares + qty || 1);
        shares += qty; avgCost = newAvg;

        if(openTs==null){ openTs=r.ts; openPx=r.price; buyFeeAcc=0; }
        buyFeeAcc += f.fee;

        execs.push({
          side:'BUY', ts:r.ts, tsMs:r.tsMs, price:r.price,
          avgCost:newAvg, shares:qty,
          buyAmount:f.gross, sellAmount:0,
          fee:f.fee, tax:0,
          cost:cost, cumCost:cumCostFull,          // <-- 累計成本（含手續費）
          pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll
        });
      }else{ // SELL：一次出清
        if(shares<=0) continue;
        const qty=shares;
        const f=fees(r.price, qty, cfg, true);

        // 全費損益：賣出金額 − 累計成本 − (賣方手續費+稅)
        const pnlFull = f.gross - cumCostFull - (f.fee + f.tax);

        // 多單位平均報酬率：損益 ÷ (累計成本 / 單位數)
        const retPctUnit = (unitsInPeriod>0 && cumCostFull>0)
          ? (pnlFull / (cumCostFull / unitsInPeriod))
          : null;

        cumPnlAll += pnlFull;
        cash += (f.gross - f.fee - f.tax);

        // round-trip（保留）
        const costBasis = avgCost * qty;
        const pnlStd = (f.gross - f.fee - f.tax) - costBasis;
        const holdDays = (parseTs(r.ts)-(openTs?parseTs(openTs):parseTs(r.ts)))/DAY_MS;
        trades.push({
          side:'LONG', inTs:openTs||r.ts, outTs:r.ts,
          inPx:openPx||avgCost, outPx:r.price,
          shares:qty, buyFee:Math.round(buyFeeAcc),
          sellFee:Math.round(f.fee), sellTax:Math.round(f.tax),
          pnl:pnlStd, holdDays
        });

        execs.push({
          side:'SELL', ts:r.ts, tsMs:r.tsMs, price:r.price,
          avgCost:avgCost, shares:qty,
          buyAmount:0, sellAmount:f.gross,
          fee:f.fee, tax:f.tax,
          cost:0, cumCost:cumCostFull,             // 賣出列也顯示累計成本（結算用）
          pnlFull, retPctUnit, cumPnlFull:cumPnlAll
        });

        // 重置一段
        shares=0; avgCost=0; openTs=null; openPx=null; buyFeeAcc=0;
        cumCostFull=0; unitsInPeriod=0;
      }

      const equity = cash + shares*r.price;
      if(equity>peak) peak=equity;
      eqSeries.push({t:r.tsMs, v:equity});
      ddSeries.push({t:r.tsMs, v:(equity-peak)/peak});
    }

    return { initial:init, eqSeries, ddSeries, trades, execs, lastCash:cash, lastShares:shares };
  }

  // KPI（簡版）
  const sum=a=>a.reduce((s,x)=>s+(+x||0),0);
  const avg=a=>a.length? sum(a)/a.length : 0;
  const std=a=>{ if(a.length<2) return 0; const m=avg(a); return Math.sqrt(avg(a.map(x=>(x-m)*(x-m)))); };
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
    const yrs=Math.max(1/365,(t1-t0)/(365*24*60*60*1000));
    // 其餘簡化
    return { startDate: new Date(t0).toISOString().slice(0,10).replace(/-/g,''),
             endDate:   new Date(t1).toISOString().slice(0,10).replace(/-/g,''),
             core:{ totalReturn:tr, CAGR:0, annVol:0, sharpe:0, sortino:0, maxDD:0, calmar:0, profitFactor:0, winRate:0, expectancy:0, avgHoldDays:0 },
             risk:{ downsideDev:0, ddAvg:0, ddP95:0, skew:0, kurt:0 } };
  }

  root.ETF_ENGINE = { parseCanon, backtest, statsKPI };
})(window);
