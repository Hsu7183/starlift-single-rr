/* shared.js ── TXT 解析 + 報表彙整（TX：手續費單邊45、期交稅雙邊×0.00002、含滑價-800）
   - 多編碼：UTF-8 / Big5 / UTF-16LE/BE / ANSI 自動辨識
   - TXT 解析：參數列（數字一行 or 多行 key:value）、交易列允許 .000000 與 1~6 位小數
   - 動作詞：新買 / 平賣 / 新賣 / 平買 / 強制平倉（允許「強制 平倉」「強平」→ 正規化為 強制平倉）
   - 計算：
       * 點差金額 = pts × MULT(200)
       * 手續費 = 45/邊 × 2 = 90（每回合）
       * 期交稅 = round(買價×200×0.00002) + round(賣價×200×0.00002)
       * 理論淨損益 = 點差金額 − 手續費 − 期交稅
       * 實際淨損益(含滑價) = 理論淨損益 − 800（進出各 -2 點）
*/

(function () {
  const SHARED = window.SHARED || (window.SHARED = {});

  /* ===== 常數 ===== */
  SHARED.MULT = 200;     // 台指期乘數
  SHARED.FEE  = 45;      // 單邊手續費（與期貨商約定；供其他地方需要時參考）
  SHARED.TAX  = 0;       // 保留舊欄位；實際期交稅由 buildReport 依規定計雙邊
  const TX_TAX_RATE = 0.00002;           // 期交稅率（股價類期貨）
  const SLIP_MONEY  = 4 * SHARED.MULT;   // 固定滑價：進/出各 -2 點 → -4 點 = 800

  /* ===== 格式化 ===== */
  SHARED.fmtMoney = n => Math.round(Number(n)||0).toLocaleString("zh-TW");
  SHARED.pct = (x,d=2)=> Number.isFinite(x)? (x*100).toFixed(d)+'%' : '—';
  SHARED.fmtTs = ts14 => {
    const s=String(ts14||"");
    if (s.length<12) return s;
    return `${s.slice(0,4)}/${Number(s.slice(4,6))}/${Number(s.slice(6,8))} ${s.slice(8,10)}:${s.slice(10,12)}`;
  };

  /* ===== 多編碼自動讀檔 ===== */
  SHARED.readAsTextAuto = async function(file){
    const buf = await file.arrayBuffer();
    const tryDecode = enc => { try{ return new TextDecoder(enc,{fatal:false}).decode(buf); }catch{ return null; } };
    for (const enc of ['utf-8','big5','utf-16le','utf-16be','windows-1252']){
      const s = tryDecode(enc);
      if (s && ( /[\u4e00-\u9fff]/.test(s) || /新買|平賣|新賣|平買|強制|強平|FixTP|FixSL/i.test(s) )) return s;
    }
    return new TextDecoder('utf-8').decode(buf);
  };

  /* ===== TXT 解析（通吃 5 風格） ===== */
  SHARED.parseTXT = function(raw){
    let s = String(raw)
      .replace(/^\uFEFF/,'')
      .replace(/\r\n?/g,'\n')
      .replace(/\u3000/g,' ')
      .replace(/\u200b|\u200c|\u200d/g,'')
      .replace(/強制\s*平倉/g,'強制平倉'); // 允許「強制 平倉」

    const lines = s.split('\n')
      .map(l => l.replace(/\s+/g,' ').trim())
      .filter(Boolean);

    // 交易列：ts14[.000000]? 價格(1~6位) 動作；含「強平」別名
    const ACT = '(新買|平賣|新賣|平買|強制平倉|強平)';
    const TRADE_RE = new RegExp(`^(\\d{14})(?:\\.\\d{1,6})?\\s+(\\d+(?:\\.\\d{1,6})?)\\s+${ACT}\\s*$`);

    const rows=[], paramRaw=[], paramKV={};

    const eatKV = line => {
      const kv = [...line.matchAll(/([A-Za-z0-9_]+)\s*:\s*([^\s]+)\b/g)];
      if (!kv.length) return false;
      kv.forEach(([,k,v]) => paramKV[k]=v);
      paramRaw.push(line);
      return true;
    };

    let seenFirstTrade=false;
    for (const l of lines){
      const m = l.match(TRADE_RE);
      if (m){
        seenFirstTrade=true;
        const ts = m[1];
        const price = Number(m[2]);
        let act = m[3]; if (act==='強平') act='強制平倉'; // 正規化
        rows.push({ ts, price, act });
        continue;
      }
      if (!seenFirstTrade){
        if (eatKV(l)) continue;
        if (/^[-\d.\s]+$/.test(l)) { paramRaw.push(l); continue; } // 純數字參數列
        continue;
      }
    }

    return { params:{ raw:paramRaw, kv:paramKV }, rows };
  };

  /* ===== 參數 Chip（安全） ===== */
  SHARED.paramsLabel = function(p){
    const kv=p&&p.kv?p.kv:{}, raw=p&&p.raw?p.raw:[];
    const pick=["FixTP_L","FixSL_L","RSI_LongTh","RSI_ShortTh","DynTPFactor_L","DynTPFactor_S","DynSlFactor_L","DynSlFactor_S"];
    const out=[]; for (const k of pick) if (kv[k]!=null) out.push(`${k}:${kv[k]}`);
    if (out.length) return out.join('  ');
    if (raw.length) return raw[0].slice(0,120);
    return '—';
  };

  /* ===== 報表彙整（配對 + 曲線；按你最新規格） ===== */
  SHARED.buildReport = function(rowsIn){
    const MULT=SHARED.MULT;

    const trades=[]; let pos=null; // { side:'L'|'S', tsIn, pIn }

    const closePos=(tsOut,pOut,actOut)=>{
      if(!pos) return;
      const side=pos.side;

      // 點數：多=賣價-買價；空=買價-賣價
      const pts = side==='L' ? (pOut - pos.pIn) : (pos.pIn - pOut);

      // 點差金額
      const gross = pts * MULT;

      // 手續費（與期貨商約定：單邊45 → 來回90）
      const feeRT = 45 * 2;

      // 期交稅（政府規定、雙邊課）：round(買×200×0.00002) + round(賣×200×0.00002)
      const taxBuy  = Math.round(pos.pIn * MULT * TX_TAX_RATE);
      const taxSell = Math.round(pOut   * MULT * TX_TAX_RATE);
      const taxRT   = taxBuy + taxSell;

      // 理論淨損益（扣手續費＋稅）
      const net = gross - feeRT - taxRT;

      // 實際（含滑價，固定 -800）
      const netSlip = net - SLIP_MONEY;

      trades.push({
        pos:{ side, tsIn:pos.tsIn, pIn:pos.pIn },
        tsOut, priceOut:pOut,
        pts,
        fee: feeRT,        // 供表格顯示
        tax: taxRT,        // 供表格顯示
        gain: net,         // 理論淨損益
        gainSlip: netSlip, // 實際淨損益(含滑價)
        actOut: actOut || (side==='L'?'平賣':'平買')
      });
      pos=null;
    };

    for (const r of rowsIn){
      const { ts, price, act } = r;
      if (act==='新買'){
        if (pos && pos.side==='S') closePos(ts, price, '平買');
        if (!pos) pos={ side:'L', tsIn:ts, pIn:price };
      } else if (act==='新賣'){
        if (pos && pos.side==='L') closePos(ts, price, '平賣');
        if (!pos) pos={ side:'S', tsIn:ts, pIn:price };
      } else if (act==='平賣'){
        if (pos && pos.side==='L') closePos(ts, price, '平賣');
      } else if (act==='平買'){
        if (pos && pos.side==='S') closePos(ts, price, '平買');
      } else if (act==='強制平倉'){
        if (pos) closePos(ts, price, '強制平倉');
      }
    }

    // 累積曲線（與表格累計一致）
    const total=[], slipCum=[], longCum=[], longSlipCum=[], shortCum=[], shortSlipCum=[], tsArr=[];
    let c=0, cs=0, cL=0, cLs=0, cS=0, cSs=0;
    const dstr = ts14 => `${String(ts14).slice(0,4)}/${String(ts14).slice(4,6)}/${String(ts14).slice(6,8)}`;

    for (const t of trades){
      c  += t.gain;
      cs += t.gainSlip;
      if (t.pos.side==='L'){ cL += t.gain; cLs += t.gainSlip; }
      else                 { cS += t.gain; cSs += t.gainSlip; }

      total.push(c);         slipCum.push(cs);
      longCum.push(cL);      longSlipCum.push(cLs);
      shortCum.push(cS);     shortSlipCum.push(cSs);
      tsArr.push(dstr(t.tsOut));
    }

    // KPI（以含滑價序列計）
    const statsFrom = arr=>{
      const count=arr.length, wins=arr.filter(t=>t.gainSlip>0).length, loses=arr.filter(t=>t.gainSlip<0).length;
      const winRate=count? wins/count : 0, loseRate=count? loses/count: 0;
      const daily=new Map();
      for (const t of arr){ const k=String(t.tsOut).slice(0,8); daily.set(k,(daily.get(k)||0)+t.gainSlip); }
      const vals=[...daily.values()], dayMax=Math.max(0,...vals,0), dayMin=Math.min(0,...vals,0);
      let eq=0, peak=0, maxUp=0, maxDD=0;
      for (const t of arr){ eq+=t.gainSlip; peak=Math.max(peak,eq); maxUp=Math.max(maxUp,eq); maxDD=Math.max(maxDD, peak-eq); }
      const gain=arr.reduce((a,b)=>a+b.gainSlip,0);
      return { count, winRate, loseRate, dayMax, dayMin, up:maxUp, dd:maxDD, gain };
    };

    const statAll=statsFrom(trades),
          statL  =statsFrom(trades.filter(t=>t.pos.side==='L')),
          statS  =statsFrom(trades.filter(t=>t.pos.side==='S'));

    return {
      trades,
      tsArr,
      total, slipCum,
      longCum, longSlipCum,
      shortCum, shortSlipCum,
      statAll, statL, statS
    };
  };

})();
