# XS_OUTPUT_FORMAT

## 通用格式
1. 宣告輸入參數。
2. 宣告變數。
3. 檢查分鐘線限制：
   ```xs
   if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");
   ```
4. 計算指標（僅允許 `[1]` 或更早）。
5. 定義 `longCondition` / `shortCondition`。
6. 再由版本決定輸出：
   - 指標版：以 `plot` 與訊號標記輸出。
   - 交易版：以 `setPosition` 輸出。

## 版本一致性要求
- 兩版本必須共享同一份邏輯條件。
- 任何條件變更必須同時反映於兩版本。
