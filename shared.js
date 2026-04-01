/* shared.js ── TXT 解析 + 報表彙整（可吃外部 cfg）
   功能：
   - 多編碼：UTF-8 / Big5 / UTF-16LE/BE / ANSI 自動辨識
   - TXT 解析：參數列（數字一行 or 多行 key:value）、交易列允許 .000000 與 1~6 位小數
   - 動作詞：新買 / 平賣 / 新賣 / 平買 / 強制平倉（允許「強制 平倉」「強平」→ 正規化為 強制平倉）
   - 計算：
       * 點差金額 = pts × pointValue
       * 手續費 = feePerSide × 2（每回合）
       * 期交稅 = round(買價×pointValue×taxRate) + round(賣價×pointValue×taxRate)
       * 理論淨損益 = 點差金額 − 手續費 − 期交稅
       * 實際淨損益(含滑價) = 理論淨損益 − (slipPerSide × 2 × pointValue)

   預設值（與原本邏輯一致）：
   - pointValue = 200
   - feePerSide = 45
   - taxRate = 0.00002
   - slipPerSide = 2
*/

(function () {
  const SHARED = window.SHARED || (window.SHARED = {});

  SHARED.MULT = 200;
  SHARED.FEE  = 45;
  SHARED.TAX  = 0;

  const DEFAULT_CFG = {
    pointValue: 200,
    feePerSide: 45,
    taxRate: 0.00002,
    slipPerSide: 2
  };

  function normalizeCfg(cfg) {
    const src = cfg || {};
    const pointValue = Number.isFinite(Number(src.pointValue)) ? Number(src.pointValue) : DEFAULT_CFG.pointValue;
    const feePerSide = Number.isFinite(Number(src.feePerSide)) ? Number(src.feePerSide) : DEFAULT_CFG.feePerSide;
    const taxRate = Number.isFinite(Number(src.taxRate)) ? Number(src.taxRate) : DEFAULT_CFG.taxRate;
    const slipPerSide = Number.isFinite(Number(src.slipPerSide)) ? Number(src.slipPerSide) : DEFAULT_CFG.slipPerSide;

    return {
      pointValue,
      feePerSide,
      taxRate,
      slipPerSide,
      slipMoney: slipPerSide * 2 * pointValue
    };
  }

  SHARED.getCfg = function (cfg) {
    return normalizeCfg(cfg);
  };

  SHARED.fmtMoney = n => Math.round(Number(n) || 0).toLocaleString("zh-TW");
  SHARED.pct = (x, d = 2) => Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—';
  SHARED.fmtTs = ts14 => {
    const s = String(ts14 || "");
    if (s.length < 12) return s;
    return `${s.slice(0, 4)}/${Number(s.slice(4, 6))}/${Number(s.slice(6, 8))} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
  };

  SHARED.readAsTextAuto = async function (file) {
    const buf = await file.arrayBuffer();
    const tryDecode = enc => {
      try {
        return new TextDecoder(enc, { fatal: false }).decode(buf);
      } catch {
        return null;
      }
    };

    for (const enc of ['utf-8', 'big5', 'utf-16le', 'utf-16be', 'windows-1252']) {
      const s = tryDecode(enc);
      if (s && (/[\u4e00-\u9fff]/.test(s) || /新買|平賣|新賣|平買|強制|強平|FixTP|FixSL/i.test(s))) {
        return s;
      }
    }

    return new TextDecoder('utf-8').decode(buf);
  };

  SHARED.parseTXT = function (raw) {
    let s = String(raw)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u3000/g, ' ')
      .replace(/\u200b|\u200c|\u200d/g, '')
      .replace(/強制\s*平倉/g, '強制平倉');

    const lines = s.split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const ACT = '(新買|平賣|新賣|平買|強制平倉|強平)';
    const TRADE_RE = new RegExp(`^(\\d{14})(?:\\.\\d{1,6})?\\s+(\\d+(?:\\.\\d{1,6})?)\\s+${ACT}\\s*$`);

    const rows = [];
    const paramRaw = [];
    const paramKV = {};

    const eatKV = line => {
      const kv = [...line.matchAll(/([A-Za-z0-9_]+)\s*:\s*([^\s]+)\b/g)];
      if (!kv.length) return false;
      kv.forEach(([, k, v]) => { paramKV[k] = v; });
      paramRaw.push(line);
      return true;
    };

    let seenFirstTrade = false;

    for (const l of lines) {
      const m = l.match(TRADE_RE);
      if (m) {
        seenFirstTrade = true;
        const ts = m[1];
        const price = Number(m[2]);
        let act = m[3];
        if (act === '強平') act = '強制平倉';
        rows.push({ ts, price, act });
        continue;
      }

      if (!seenFirstTrade) {
        if (eatKV(l)) continue;
        if (/^[-\d.\s]+$/.test(l)) {
          paramRaw.push(l);
          continue;
        }
      }
    }

    return {
      params: { raw: paramRaw, kv: paramKV },
      rows
    };
  };

  SHARED.paramsLabel = function (p) {
    const kv = p && p.kv ? p.kv : {};
    const raw = p && p.raw ? p.raw : [];
    const pick = [
      "FixTP_L", "FixSL_L", "RSI_LongTh", "RSI_ShortTh",
      "DynTPFactor_L", "DynTPFactor_S", "DynSlFactor_L", "DynSlFactor_S"
    ];

    const out = [];
    for (const k of pick) {
      if (kv[k] != null) out.push(`${k}:${kv[k]}`);
    }

    if (out.length) return out.join('  ');
    if (raw.length) return raw[0].slice(0, 120);
    return '—';
  };

  function statsFrom(arr) {
    const count = arr.length;
    const wins = arr.filter(t => t.gainSlip > 0).length;
    const loses = arr.filter(t => t.gainSlip < 0).length;
    const winRate = count ? wins / count : 0;
    const loseRate = count ? loses / count : 0;

    const daily = new Map();
    for (const t of arr) {
      const k = String(t.tsOut).slice(0, 8);
      daily.set(k, (daily.get(k) || 0) + t.gainSlip);
    }

    const vals = [...daily.values()];
    const dayMax = Math.max(0, ...vals, 0);
    const dayMin = Math.min(0, ...vals, 0);

    let eq = 0;
    let peak = 0;
    let maxUp = 0;
    let maxDD = 0;

    for (const t of arr) {
      eq += t.gainSlip;
      peak = Math.max(peak, eq);
      maxUp = Math.max(maxUp, eq);
      maxDD = Math.max(maxDD, peak - eq);
    }

    const gain = arr.reduce((a, b) => a + b.gainSlip, 0);

    return { count, winRate, loseRate, dayMax, dayMin, up: maxUp, dd: maxDD, gain };
  }

  SHARED.buildReport = function (rowsIn, cfg) {
    const C = normalizeCfg(cfg);
    const MULT = C.pointValue;

    const trades = [];
    let pos = null;

    const closePos = (tsOut, pOut, actOut) => {
      if (!pos) return;

      const side = pos.side;
      const pts = side === 'L' ? (pOut - pos.pIn) : (pos.pIn - pOut);
      const gross = pts * MULT;
      const feeRT = C.feePerSide * 2;
      const taxBuy = Math.round(pos.pIn * MULT * C.taxRate);
      const taxSell = Math.round(pOut * MULT * C.taxRate);
      const taxRT = taxBuy + taxSell;
      const net = gross - feeRT - taxRT;
      const netSlip = net - C.slipMoney;

      trades.push({
        pos: { side, tsIn: pos.tsIn, pIn: pos.pIn },
        tsIn: pos.tsIn,
        priceIn: pos.pIn,
        tsOut,
        priceOut: pOut,
        pts,
        gross,
        fee: feeRT,
        tax: taxRT,
        slipMoney: C.slipMoney,
        gain: net,
        gainSlip: netSlip,
        pnl: net,
        pnlSlip: netSlip,
        netSlip,
        actOut: actOut || (side === 'L' ? '平賣' : '平買')
      });

      pos = null;
    };

    for (const r of rowsIn || []) {
      const { ts, price, act } = r;

      if (act === '新買') {
        if (pos && pos.side === 'S') closePos(ts, price, '平買');
        if (!pos) pos = { side: 'L', tsIn: ts, pIn: price };
      } else if (act === '新賣') {
        if (pos && pos.side === 'L') closePos(ts, price, '平賣');
        if (!pos) pos = { side: 'S', tsIn: ts, pIn: price };
      } else if (act === '平賣') {
        if (pos && pos.side === 'L') closePos(ts, price, '平賣');
      } else if (act === '平買') {
        if (pos && pos.side === 'S') closePos(ts, price, '平買');
      } else if (act === '強制平倉') {
        if (pos) closePos(ts, price, '強制平倉');
      }
    }

    const total = [];
    const slipCum = [];
    const longCum = [];
    const longSlipCum = [];
    const shortCum = [];
    const shortSlipCum = [];
    const tsArr = [];

    let c = 0;
    let cs = 0;
    let cL = 0;
    let cLs = 0;
    let cS = 0;
    let cSs = 0;

    const dstr = ts14 => `${String(ts14).slice(0, 4)}/${String(ts14).slice(4, 6)}/${String(ts14).slice(6, 8)}`;

    for (const t of trades) {
      c += t.gain;
      cs += t.gainSlip;

      if (t.pos.side === 'L') {
        cL += t.gain;
        cLs += t.gainSlip;
      } else {
        cS += t.gain;
        cSs += t.gainSlip;
      }

      total.push(c);
      slipCum.push(cs);
      longCum.push(cL);
      longSlipCum.push(cLs);
      shortCum.push(cS);
      shortSlipCum.push(cSs);
      tsArr.push(dstr(t.tsOut));
    }

    const statAll = statsFrom(trades);
    const statL = statsFrom(trades.filter(t => t.pos.side === 'L'));
    const statS = statsFrom(trades.filter(t => t.pos.side === 'S'));

    return {
      cfg: C,
      trades,
      tsArr,
      total,
      slipCum,
      longCum,
      longSlipCum,
      shortCum,
      shortSlipCum,
      statAll,
      statL,
      statS
    };
  };
})();
