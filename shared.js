/* shared.js ── TXT 解析 + 報表彙整（校正版）
   重點：
   1) 多編碼：UTF-8 / Big5 / UTF-16LE/BE / ANSI
   2) TXT 解析：參數列（數字一行 or 多行 key:value）、交易列允許 .000000 與 1~6 位小數
   3) 動作詞：新買 / 平賣 / 新賣 / 平買 / 強制平倉（含「強制 平倉」「強平」別名）
   4) 計算公式（恢復為你原本正確的）：
      理論淨損益 = 點數 × MULT
      來回手續費 = 2 × FEE
      交易稅 = round(價 × MULT × TAX)（預設 TAX=0）
      實際淨損益(含滑價) = 理論淨損益 − 來回手續費 − 交易稅
*/

(function () {
  const SHARED = window.SHARED || (window.SHARED = {});

  /* ===== 常數（可調整） ===== */
  SHARED.MULT = 200;     // 台指期 1 點 = 200 元
  SHARED.FEE  = 90;      // 單邊手續費（範例：90）
  SHARED.TAX  = 0;       // 期貨預設 0；若為股票可改，例如 0.003

  /* ===== 格式化 ===== */
  SHARED.fmtMoney = function fmtMoney(n) {
    return Math.round(Number(n) || 0).toLocaleString("zh-TW");
  };
  SHARED.pct = function pct(x, d=2) {
    return Number.isFinite(x) ? (x*100).toFixed(d) + "%" : "—";
  };
  SHARED.fmtTs = function fmtTs(ts14) {
    const s=String(ts14||"");
    if (s.length<12) return s;
    const y=s.slice(0,4), m=s.slice(4,6), d=s.slice(6,8), hh=s.slice(8,10), mm=s.slice(10,12);
    return `${y}/${Number(m)}/${Number(d)} ${hh}:${mm}`;
  };

  /* ===== 多編碼自動讀檔 ===== */
  SHARED.readAsTextAuto = async function readAsTextAuto(file){
    const buf = await file.arrayBuffer();
    const tryDecode = enc => { try { return new TextDecoder(enc,{fatal:false}).decode(buf); } catch { return null; } };
    const candidates = ['utf-8','big5','utf-16le','utf-16be','windows-1252'];
    for (const enc of candidates){
      const s = tryDecode(enc);
      if (s && ( /[\u4e00-\u9fff]/.test(s) || /新買|平賣|新賣|平買|強制|強平|FixTP|FixSL/i.test(s) )) {
        return s;
      }
    }
    return new TextDecoder('utf-8').decode(buf);
  };

  /* ===== TXT 解析（通吃 5 風格） ===== */
  SHARED.parseTXT = function parseTXT(raw){
    // 全域正規化
    let s = String(raw)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u3000/g, ' ')
      .replace(/\u200b|\u200c|\u200d/g,'')
      .replace(/強制\s*平倉/g,'強制平倉');  // 允許「強制 平倉」

    const lines = s.split('\n')
      .map(l => l.replace(/\s+/g,' ').trim())
      .filter(Boolean);

    // 交易列（鬆綁）：ts14[.000000]? 價格(1~6位) 動作；含「強平」別名
    const ACT = '(新買|平賣|新賣|平買|強制平倉|強平)';
    const TRADE_RE = new RegExp(`^(\\d{14})(?:\\.\\d{1,6})?\\s+(\\d+(?:\\.\\d{1,6})?)\\s+${ACT}\\s*$`);

    const rows = [];     // { ts, price, act }
    const paramRaw = []; // 原始參數行
    const paramKV  = {}; // key:value 參數

    const eatKV = (line) => {
      const kvPairs = [...line.matchAll(/([A-Za-z0-9_]+)\s*:\s*([^\s]+)\b/g)];
      if (kvPairs.length){
        kvPairs.forEach(([,k,v]) => paramKV[k]=v);
        paramRaw.push(line);
        return true;
      }
      return false;
    };

    let seenFirstTrade = false;
    for (const l of lines){
      const m = l.match(TRADE_RE);
      if (m){
        seenFirstTrade = true;
        const ts = m[1];
        const price = Number(m[2]);
        let act = m[3];
        if (act==='強平') act='強制平倉';  // 別名統一
        rows.push({ ts, price, act });
        continue;
      }
      if (!seenFirstTrade){
        if (eatKV(l)) continue;
        if (/^[-\d.\s]+$/.test(l)) { paramRaw.push(l); continue; } // 一行數字參數
        continue; // 其他表頭略過
      }
      // 交易區段內雜訊忽略
    }

    return { params:{ raw:paramRaw, kv:paramKV }, rows };
  };

  /* ===== 參數 Chip（安全） ===== */
  SHARED.paramsLabel = function paramsLabel(p){
    const kv = p && p.kv ? p.kv : {};
    const raw= p && p.raw? p.raw: [];
    const pick = ["FixTP_L","FixSL_L","RSI_LongTh","RSI_ShortTh","DynTPFactor_L","DynTPFactor_S","DynSlFactor_L","DynSlFactor_S"];
    const chosen=[];
    for (const k of pick) if (kv[k]!=null) chosen.push(`${k}:${kv[k]}`);
    if (chosen.length) return chosen.join('  ');
    if (raw.length) return raw[0].slice(0,120);
    return '—';
  };

  /* ===== 報表彙整（配對 + 曲線；公式校正） ===== */
  SHARED.buildReport = function buildReport(parsedRows){
    const MULT = SHARED.MULT, FEE = SHARED.FEE, TAX = SHARED.TAX;

    const trades = [];
    let pos = null; // { side:'L'|'S', tsIn, pIn }

    const closePos = (tsOut, pOut, reason) => {
      if (!pos) return;
      const side = pos.side;
      // 點數：多=賣價-買價；空=賣價-買價（= pIn - pOut）
      const pts = side==='L' ? (pOut - pos.pIn) : (pos.pIn - pOut);

      // 理論淨損益（不含成本）
      const gain = pts * MULT;

      // 成本（來回手續費 + 稅）
      const feeRT = FEE * 2;
      const tax   = Math.round(pOut * MULT * TAX); // 期貨預設 TAX=0

      // 實際淨損益（含成本/滑價）
      const gainSlip = gain - feeRT - tax;

      trades.push({
        pos:{ side, tsIn:pos.tsIn, pIn:pos.pIn },
        tsOut, priceOut:pOut,
        pts, gain, gainSlip,
        actOut: reason || (side==='L'?'平賣':'平買')
      });
      pos = null;
    };

    for (const r of parsedRows){
      const { ts, price, act } = r;

      if (act==='新買'){
        if (pos && pos.side==='S') closePos(ts, price, '平買'); // 先平空再開多
        if (!pos) pos = { side:'L', tsIn:ts, pIn:price };
      }
      else if (act==='新賣'){
        if (pos && pos.side==='L') closePos(ts, price, '平賣'); // 先平多再開空
        if (!pos) pos = { side:'S', tsIn:ts, pIn:price };
      }
      else if (act==='平賣'){
        if (pos && pos.side==='L') closePos(ts, price, '平賣');
      }
      else if (act==='平買'){
        if (pos && pos.side==='S') closePos(ts, price, '平買');
      }
      else if (act==='強制平倉'){
        if (pos) closePos(ts, price, '強制平倉');
      }
    }
    // 收尾若仍有部位，不計未實現

    /* 累積曲線（與你原本一致） */
    const total=[], slipCum=[], longCum=[], longSlipCum=[], shortCum=[], shortSlipCum=[], tsArr=[];
    let c=0, cs=0, cL=0, cLs=0, cS=0, cSs=0;

    const outDate = (ts14)=>`${String(ts14).slice(0,4)}/${String(ts14).slice(4,6)}/${String(ts14).slice(6,8)}`;

    for (const t of trades){
      c  += t.gain;
      cs += t.gainSlip;
      if (t.pos.side==='L'){ cL+=t.gain; cLs+=t.gainSlip; }
      else                 { cS+=t.gain; cSs+=t.gainSlip; }

      total.push(c); slipCum.push(cs);
      longCum.push(cL); longSlipCum.push(cLs);
      shortCum.push(cS); shortSlipCum.push(cSs);
      tsArr.push(outDate(t.tsOut));
    }

    // KPI（供 single.js 用；與你先前表格語意一致）
    const statsFrom = (arr)=>{
      const count = arr.length;
      const wins  = arr.filter(t=>t.gainSlip>0).length;
      const loses = arr.filter(t=>t.gainSlip<0).length;
      const winRate = count? wins/count : 0;
      const loseRate= count? loses/count: 0;

      // 以出場日聚合（含成本）
      const daily = new Map();
      for (const t of arr){
        const k = String(t.tsOut).slice(0,8);
        daily.set(k, (daily.get(k)||0)+t.gainSlip);
      }
      const vals=[...daily.values()];
      const dayMax=Math.max(0,...vals,0);
      const dayMin=Math.min(0,...vals,0);

      let eq=0, peak=0, maxUp=0, maxDD=0;
      for (const t of arr){
        eq+=t.gainSlip;
        peak=Math.max(peak,eq);
        maxUp=Math.max(maxUp,eq);
        maxDD=Math.max(maxDD, peak-eq);
      }
      const gain=arr.reduce((a,b)=>a+b.gainSlip,0);
      return { count, winRate, loseRate, dayMax, dayMin, up:maxUp, dd:maxDD, gain };
    };

    const statAll=statsFrom(trades);
    const statL  =statsFrom(trades.filter(t=>t.pos.side==='L'));
    const statS  =statsFrom(trades.filter(t=>t.pos.side==='S'));

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
