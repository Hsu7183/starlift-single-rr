# XS_MASTER_RULES

## 核心目標
建立可同時生成 XS 指標版與交易版的策略系統，兩者邏輯必須完全一致。

## 強制規則
1. 進場條件禁止使用 `Close` / `High` / `Low` / `Volume` 當根。
2. 當根僅可使用 `Open`。
3. 技術指標必須使用 `[1]` 或更早，避免未來函數。
4. 指標版與交易版僅輸出方式不同，不可有邏輯分歧。
5. 必須避免 look-ahead bias。
6. 必須包含分鐘線限制：
   ```xs
   if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");
   ```
