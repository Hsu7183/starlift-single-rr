/* shared.js  ── 通用工具 & TXT 解析 & 報表彙整
   - 多編碼：UTF-8 / Big5 / UTF-16LE / UTF-16BE / ANSI
   - 參數：支援第一行大量數字、或多行 key:value；以 params.raw / params.kv 兩種保留
   - 交易：支援 14 碼時間戳 + 可選 .000000；價位 1~6 位小數；動作含「新買 / 平賣 / 新賣 / 平買 / 強制平倉 / 強平」
   - 報表：配對多/空交易、計算點數與損益（理論 / 含成本滑價）、產生長/空/合計盈虧曲線
   - KPI 工具：fmtMoney / pct / fmtTs 與常數 MULT / FEE / TAX
*/

(function () {
  const SHARED = window.SHARED || (window.SHARED = {});

  /* =========================
   *  常數（可依需求調整）
   * ========================= */
  // MULT：乘數（台指期為 200 元/點）
  // FEE ：單邊手續費（表格會在出場列以 round-trip 2*FEE 顯示）
  // TAX ：交易稅係數（若不計稅就設 0）
  SHARED.MULT = 200;
  SHARED.FEE  = 90;
  SHARED.TAX  = 0;

  /* =========================
   *  格式化工具
   * ========================= */
  SHARED.fmtMoney = function fmtMoney(n) {
    const v = Number(n) || 0;
    // 數值很大時以四捨五入到個位
    return Math.round(v).toLocaleString("zh-TW");
  };

  SHARED.pct = function pct(x, digits = 2) {
    if (!Number.isFinite(x)) return "—";
    return (x * 100).toFixed(digits) + "%";
  };

  SHARED.fmtTs = function fmtTs(ts14) {
    const s = String(ts14 || "");
    if (s.length < 12) return s;
    const y = s.slice(0, 4), m = s.slice(4, 6), d = s.slice(6, 8);
    const hh = s.slice(8, 10), mm = s.slice(10, 12);
    return `${y}/${Number(m)}/${Number(d)} ${hh}:${mm}`;
  };

  /* =========================
   *  多編碼自動讀檔
   * ========================= */
  SHARED.readAsTextAuto = async function readAsTextAuto(file) {
    const buf = await file.arrayBuffer();

    const tryDecode = (enc) => {
      try { return new TextDecoder(enc, { fatal: false }).decode(buf); }
      catch { return null; }
    };

    // 依常見度嘗試；Big5/UTF-16/ANSI 都納入
    const candidates = ["utf-8", "big5", "utf-16le", "utf-16be", "windows-1252"];
    for (const enc of candidates) {
      const s = tryDecode(enc);
      if (s && (
        /[\u4e00-\u9fff]/.test(s) ||               // 有中文
        /新買|平賣|新賣|平買|強制|強平|FixTP|FixSL/i.test(s) // 或包含關鍵詞
      )) {
        return s;
      }
    }
    // 兜底：UTF-8
    return new TextDecoder("utf-8").decode(buf);
  };

  /* =========================
   *  TXT 解析（通吃 5 種風格）
   * ========================= */
  SHARED.parseTXT = function parseTXT(raw) {
    // 全域正規化
    let s = String(raw)
      .replace(/^\uFEFF/, "")          // 去 BOM
      .replace(/\r\n?/g, "\n")         // 統一換行
      .replace(/\u3000/g, " ")         // 全形空白
      .replace(/\u200b|\u200c|\u200d/g, "") // 零寬
      .replace(/強制\s*平倉/g, "強制平倉"); // 允許「強制 平倉」

    // 行級清理：壓縮空白、去空行
    const lines = s.split("\n")
      .map(l => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    // 交易行（鬆綁）：ts14[.000000]? 價格(1~6位) 動作；含「強平」別名
    const ACT = "(新買|平賣|新賣|平買|強制平倉|強平)";
    const TRADE_RE = new RegExp(`^(\\d{14})(?:\\.\\d{1,6})?\\s+(\\d+(?:\\.\\d{1,6})?)\\s+${ACT}\\s*$`);

    const rows = [];      // { ts, price, act }
    const paramRaw = [];  // 原始參數行（顯示用）
    const paramKV  = {};  // key:value 參數對

    // key:value 擷取器（同一行可多對）
    const eatKV = (line) => {
      const kvPairs = [...line.matchAll(/([A-Za-z0-9_]+)\s*:\s*([^\s]+)\b/g)];
      if (kvPairs.length) {
        kvPairs.forEach(([, k, v]) => { paramKV[k] = v; });
        paramRaw.push(line);
        return true;
      }
      return false;
    };

    // 第一筆交易出現前的所有非交易行，視為參數/表頭
    let seenFirstTrade = false;
    for (const l of lines) {
      const m = l.match(TRADE_RE);
      if (m) {
        seenFirstTrade = true;
        const ts = m[1];
        const price = Number(m[2]);
        let act = m[3];
        if (act === "強平") act = "強制平倉"; // 別名正規化
        rows.push({ ts, price, act });
        continue;
      }

      if (!seenFirstTrade) {
        // 先吃 key:value；不然滿是數字的一行也當參數列
        if (eatKV(l)) continue;
        if (/^[-\d.\s]+$/.test(l)) { paramRaw.push(l); continue; }
        continue; // 其他如「日期 價格 動作」表頭略過
      }
      // 交易區段內的雜訊行忽略
    }

    return {
      params: { raw: paramRaw, kv: paramKV },
      rows   : rows
    };
  };

  /* =========================
   *  參數 Chip 文字（安全）
   * ========================= */
  SHARED.paramsLabel = function paramsLabel(paramObj) {
    // 盡量從 kv 抽幾個常見鍵；沒有就回 raw 第一行；再沒有就 "—"
    const kv = paramObj && paramObj.kv ? paramObj.kv : {};
    const raw = paramObj && paramObj.raw ? paramObj.raw : [];

    const pickOrder = ["FixTP_L", "FixSL_L", "RSI_LongTh", "RSI_ShortTh",
                       "DynSlFactor_L", "DynSlFactor_S", "DynTPFactor_L", "DynTPFactor_S"];
    const picked = [];
    for (const k of pickOrder) if (kv[k] != null) picked.push(`${k}:${kv[k]}`);
    if (picked.length) return picked.join("  ");

    if (raw.length) return raw[0].slice(0, 120);
    return "—";
  };

  /* =========================
   *  報表彙整（配對交易 + 曲線）
   * ========================= */
  SHARED.buildReport = function buildReport(parsedRows) {
    const MULT = SHARED.MULT, FEE = SHARED.FEE, TAX = SHARED.TAX;

    // 交易配對
    const trades = [];
    let pos = null; // { side:'L'|'S', tsIn, pIn }

    const closePos = (tsOut, pOut, reasonAct) => {
      if (!pos) return;
      const side = pos.side;
      const pts = side === "L" ? (pOut - pos.pIn) : (pos.pIn - pOut);
      const gainTheoretical = pts * MULT;
      const tax = Math.round(pOut * MULT * TAX);
      const gainSlip = gainTheoretical - (FEE * 2) - tax; // 含成本（滑價可再自行擴充）

      trades.push({
        pos: { side, tsIn: pos.tsIn, pIn: pos.pIn },
        tsOut,
        priceOut: pOut,
        pts,
        gain: gainTheoretical,
        gainSlip,
        actOut: reasonAct || (side === "L" ? "平賣" : "平買")
      });
      pos = null;
    };

    for (const r of parsedRows) {
      const { ts, price, act } = r;

      if (act === "新買") {
        // 若原已是空單，先平倉再轉多（保險處理）
        if (pos && pos.side === "S") closePos(ts, price, "平買");
        if (!pos) pos = { side: "L", tsIn: ts, pIn: price };
      }
      else if (act === "新賣") {
        if (pos && pos.side === "L") closePos(ts, price, "平賣");
        if (!pos) pos = { side: "S", tsIn: ts, pIn: price };
      }
      else if (act === "平賣") {
        if (pos && pos.side === "L") closePos(ts, price, "平賣");
      }
      else if (act === "平買") {
        if (pos && pos.side === "S") closePos(ts, price, "平買");
      }
      else if (act === "強制平倉") {
        if (pos) closePos(ts, price, "強制平倉");
      }
    }
    // 檔案結尾若仍有部位，忽略（不做未實現計算）

    // 產生盈虧曲線（理論 / 含成本）& 長/空分項
    const total = [];
    const slipCum = [];
    const longCum = [];
    const longSlipCum = [];
    const shortCum = [];
    const shortSlipCum = [];
    const tsArr = [];

    let cum = 0, cumSlip = 0, cumL = 0, cumLS = 0, cumS = 0, cumSS = 0;

    const outDate = (ts14) => {
      const s = String(ts14 || "");
      return `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;
    };

    for (const t of trades) {
      cum += t.gain;
      cumSlip += t.gainSlip;

      if (t.pos.side === "L") {
        cumL += t.gain;
        cumLS += t.gainSlip;
      } else {
        cumS += t.gain;
        cumSS += t.gainSlip;
      }
      total.push(cum);
      slipCum.push(cumSlip);
      longCum.push(cumL);
      longSlipCum.push(cumLS);
      shortCum.push(cumS);
      shortSlipCum.push(cumSS);
      tsArr.push(outDate(t.tsOut));
    }

    // KPI（若 single.js 需要時會直接取用；不保證與你舊版完全一致，但結構對齊）
    const statsFrom = (arr) => {
      const count = arr.length;
      const wins = arr.filter(t => t.gainSlip > 0).length;
      const loses = arr.filter(t => t.gainSlip < 0).length;
      const winRate = count ? wins / count : 0;
      const loseRate = count ? loses / count : 0;

      // 以出場日聚合（含滑價）
      const daily = new Map();
      for (const t of arr) {
        const k = String(t.tsOut).slice(0, 8);
        daily.set(k, (daily.get(k) || 0) + t.gainSlip);
      }
      const dailyVals = [...daily.values()];
      const dayMax = Math.max(0, ...dailyVals, 0);
      const dayMin = Math.min(0, ...dailyVals, 0);

      // 區間最大上行 / 最大回撤（以含滑價累積）
      let eq = 0, peak = 0, maxUp = 0, maxDD = 0;
      for (const t of arr) {
        eq += t.gainSlip;
        peak = Math.max(peak, eq);
        maxUp = Math.max(maxUp, eq);
        maxDD = Math.max(maxDD, peak - eq);
      }
      const gain = arr.reduce((a, b) => a + b.gainSlip, 0);

      return { count, winRate, loseRate, dayMax, dayMin, up: maxUp, dd: maxDD, gain };
    };

    const statAll = statsFrom(trades);
    const statL   = statsFrom(trades.filter(t => t.pos.side === "L"));
    const statS   = statsFrom(trades.filter(t => t.pos.side === "S"));

    return {
      trades,        // [{ pos:{side,tsIn,pIn}, tsOut, priceOut, pts, gain, gainSlip, actOut }, ...]
      tsArr,         // 出場日期字串（YYYY/MM/DD）
      total,         // 理論累積淨損益（未扣成本）
      slipCum,       // 含成本/滑價累積淨損益
      longCum, longSlipCum,
      shortCum, shortSlipCum,
      statAll, statL, statS
    };
  };

})();
