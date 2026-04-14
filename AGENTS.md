# AGENTS.md — XScript (XS) 策略產生器專案規範

## 目的
本專案用於自動產生 XScript（XS）指標版與交易版腳本，並確保兩者策略邏輯完全一致。

## 不可違反規則
1. 進場條件禁止使用當根 `Close` / `High` / `Low` / `Volume`。
2. 當根只能使用 `Open`。
3. 所有技術指標（EMA / ATR / RSI / VWAP 等）必須使用 `[1]` 或更早。
4. 指標版與交易版邏輯必須 100% 一致（僅輸出不同）。
5. 必須避免 look-ahead bias。
6. 腳本必須包含：
   ```xs
   if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");
   ```

## SPEC 保護規則
- `SPEC/` 目錄為主規範來源。
- **不得修改 `SPEC/` 任何內容**，除非使用者明確授權。

## 開發要求
- 產生器輸入 JSON 策略描述，輸出 `indicator.xs` 與 `trading.xs`。
- 產生器輸出需通過 `generator/rule_checker.py` 檢查。
- 必須維護 `pytest` 測試。
