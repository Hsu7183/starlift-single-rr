//=======================================================================
// ScriptName : 11552XS_XQ_VERIFY_OR71_W280_DAY_IND_FIX_V4
// 說明       : 11552-00 指標版 V4
// 重點       : 與交易版同邏輯順序、同TXT輸出口徑
//=======================================================================

input:
    UseNightSession(false, "0.夜盤測試模式"),
    DayCalcBeginTime(084500, "1.日盤指標累積起點"),
    DayORStartTime(084500, "2.日盤OR起點"),
    DayOREndTime(085900, "3.日盤OR終點"),
    DayBeginTime(091500, "4.日盤交易起點"),
    DayEndTime(123000, "5.日盤交易終點"),
    DayForceExitTime(123300, "6.日盤強制平倉"),
    NightCalcBeginTime(150000, "7.夜盤指標累積起點"),
    NightORStartTime(150000, "8.夜盤OR起點"),
    NightOREndTime(150900, "9.夜盤OR終點"),
    NightBeginTime(151000, "10.夜盤交易起點"),
    NightEndTime(045500, "11.夜盤交易終點"),
    NightForceExitTime(045800, "12.夜盤強制平倉"),
    EMALen(34, "13.EMA長度"),
    ORBreakBuffer(71, "14.OR突破緩衝"),
    MaxORWidth(280, "15.OR最大寬度"),
    MinVWAPDist(53, "16.距離VWAP最小點數"),
    MinEMASlope(4, "17.EMA最小斜率"),
    PullbackBuffer(40, "18.回檔碰EMA緩衝"),
    ReclaimGap(6, "19.Open重新站回EMA距離"),
    MaxEntryGap(99, "20.Open距EMA最大距離"),
    StopLossPoints(89, "21.初始停損點數"),
    ProtectTriggerPts(520, "22.啟動保護浮盈"),
    GivebackPts(240, "23.允許回吐點數"),
    ProtectMinProfitPts(80, "24.最小保底獲利"),
    MaxHoldBars(148, "25.最大持倉K數"),
    CoolDownBars(157, "26.平倉後冷卻K數"),
    UseORFilter(true, "27.啟用OR濾網"),
    UseVWAPFilter(true, "28.啟用VWAP濾網"),
    UseEMASlopeFilter(true, "29.啟用EMA斜率濾網"),
    ShowBiasPlots(true, "30.顯示多空主導Plot");

var:
    CalcBeginTime(0), ORStartTime(0), OREndTime(0),
    BeginTime(0), EndTime(0), ForceExitTime(0),
    sessOnCalc(0), sessOnOR(0), sessOnEntry(0), sessOnManage(0),
    isNewSession(false), warmupBars(0),
    emaV(0), P(0), cumPV(0), cumVol(0), vwap(0),
    orHi(0), orLo(0), orWidth(0),
    orReady(false), orInitialized(false),
    Tvalue(0), cost(0), entryBar(0),
    lastExitBar(-9999), lastMarkBar(-9999),
    longBias(false), shortBias(false),
    longPullbackOK(false), shortPullbackOK(false),
    longSetup(false), shortSetup(false),
    longFilled(false), shortFilled(false),
    myEntryPrice(0),
    peakPrice(0), troughPrice(0),
    tempPeak(0), tempTrough(0),
    maxFavPts(0), initSL(0), trailLine(0), activeStop(0),
    LongExitTrig(false), ShortExitTrig(false), ForceExitTrig(false),
    ExitByHold(false), outPrice(0),
    fpath(""), hdrPrinted(false), outStr(""),
    hh(0), mm(0), timeStr(""), dateTimeStr("");

//====================== 基本檢查 ======================
if barfreq <> "Min" then
    raiseRunTimeError("本腳本僅支援分鐘線");

//====================== TXT 初始化 ======================
if CurrentBar = 1 then begin
    hdrPrinted = false;
    fpath = "C:\\XQ\\data\\" + "[ScriptName]_[Date]_[StartTime].txt";
end;

//====================== 時間參數切換 ======================
if UseNightSession then begin
    CalcBeginTime = NightCalcBeginTime;
    ORStartTime = NightORStartTime;
    OREndTime = NightOREndTime;
    BeginTime = NightBeginTime;
    EndTime = NightEndTime;
    ForceExitTime = NightForceExitTime;
end
else begin
    CalcBeginTime = DayCalcBeginTime;
    ORStartTime = DayORStartTime;
    OREndTime = DayOREndTime;
    BeginTime = DayBeginTime;
    EndTime = DayEndTime;
    ForceExitTime = DayForceExitTime;
end;

//====================== Session 判斷 ======================
if CalcBeginTime <= ForceExitTime then
    sessOnCalc = IFF((Time >= CalcBeginTime) and (Time <= ForceExitTime), 1, 0)
else
    sessOnCalc = IFF((Time >= CalcBeginTime) or (Time <= ForceExitTime), 1, 0);

if ORStartTime <= OREndTime then
    sessOnOR = IFF((Time >= ORStartTime) and (Time <= OREndTime), 1, 0)
else
    sessOnOR = IFF((Time >= ORStartTime) or (Time <= OREndTime), 1, 0);

if BeginTime <= EndTime then
    sessOnEntry = IFF((Time >= BeginTime) and (Time <= EndTime), 1, 0)
else
    sessOnEntry = IFF((Time >= BeginTime) or (Time <= EndTime), 1, 0);

if BeginTime <= ForceExitTime then
    sessOnManage = IFF((Time >= BeginTime) and (Time <= ForceExitTime), 1, 0)
else
    sessOnManage = IFF((Time >= BeginTime) or (Time <= ForceExitTime), 1, 0);

//====================== 新 Session 偵測 ======================
isNewSession = false;

if CurrentBar = 1 then
    isNewSession = true
else begin
    if UseNightSession then begin
        if (Time >= CalcBeginTime) and (Time[1] < CalcBeginTime) then
            isNewSession = true;
    end
    else begin
        if Date <> Date[1] then
            isNewSession = true;
    end;
end;

//====================== Session 初始化 ======================
if isNewSession then begin
    Tvalue = 0;
    cost = 0;
    entryBar = 0;
    lastExitBar = -9999;
    lastMarkBar = -9999;

    cumPV = 0;
    cumVol = 0;
    vwap = 0;

    orHi = 0;
    orLo = 0;
    orWidth = 0;
    orReady = false;
    orInitialized = false;

    peakPrice = 0;
    troughPrice = 0;
end;

//====================== 指標計算 ======================
if sessOnCalc = 1 then begin
    emaV = XAverage(Close, EMALen);

    P = (High + Low + Close) / 3;
    cumPV = cumPV + P * Volume;
    cumVol = cumVol + Volume;

    if cumVol > 0 then
        vwap = cumPV / cumVol;
end;

//====================== OR 區間計算 ======================
if sessOnOR = 1 then begin
    if orInitialized = false then begin
        orHi = High;
        orLo = Low;
        orInitialized = true;
        orReady = false;
    end
    else begin
        if High > orHi then orHi = High;
        if Low < orLo then orLo = Low;
    end;
end;

if orInitialized then begin
    orWidth = orHi - orLo;

    if ORStartTime <= OREndTime then begin
        if Time > OREndTime then orReady = true;
    end
    else begin
        if (Time > OREndTime) and (Time < ORStartTime) then
            orReady = true;
    end;
end;

warmupBars = MaxList(EMALen + 10, 20);

//====================== 參數列輸出，只印一次 ======================
if (hdrPrinted = false) and (sessOnEntry = 1) then begin
    outStr = "";
    outStr = outStr + "Script=11552XS_XQ_VERIFY_OR71_W280_DAY_IND_FIX_V4";
    outStr = outStr + ",UseNightSession=" + NumToStr(IFF(UseNightSession, 1, 0), 0);
    outStr = outStr + ",CalcBeginTime=" + NumToStr(CalcBeginTime, 0);
    outStr = outStr + ",ORStartTime=" + NumToStr(ORStartTime, 0);
    outStr = outStr + ",OREndTime=" + NumToStr(OREndTime, 0);
    outStr = outStr + ",BeginTime=" + NumToStr(BeginTime, 0);
    outStr = outStr + ",EndTime=" + NumToStr(EndTime, 0);
    outStr = outStr + ",ForceExitTime=" + NumToStr(ForceExitTime, 0);
    outStr = outStr + ",EMALen=" + NumToStr(EMALen, 0);
    outStr = outStr + ",ORBreakBuffer=" + NumToStr(ORBreakBuffer, 0);
    outStr = outStr + ",MaxORWidth=" + NumToStr(MaxORWidth, 0);
    outStr = outStr + ",MinVWAPDist=" + NumToStr(MinVWAPDist, 0);
    outStr = outStr + ",MinEMASlope=" + NumToStr(MinEMASlope, 0);
    outStr = outStr + ",PullbackBuffer=" + NumToStr(PullbackBuffer, 0);
    outStr = outStr + ",ReclaimGap=" + NumToStr(ReclaimGap, 0);
    outStr = outStr + ",MaxEntryGap=" + NumToStr(MaxEntryGap, 0);
    outStr = outStr + ",StopLossPoints=" + NumToStr(StopLossPoints, 0);
    outStr = outStr + ",ProtectTriggerPts=" + NumToStr(ProtectTriggerPts, 0);
    outStr = outStr + ",GivebackPts=" + NumToStr(GivebackPts, 0);
    outStr = outStr + ",ProtectMinProfitPts=" + NumToStr(ProtectMinProfitPts, 0);
    outStr = outStr + ",MaxHoldBars=" + NumToStr(MaxHoldBars, 0);
    outStr = outStr + ",CoolDownBars=" + NumToStr(CoolDownBars, 0);
    outStr = outStr + ",UseORFilter=" + NumToStr(IFF(UseORFilter, 1, 0), 0);
    outStr = outStr + ",UseVWAPFilter=" + NumToStr(IFF(UseVWAPFilter, 1, 0), 0);
    outStr = outStr + ",UseEMASlopeFilter=" + NumToStr(IFF(UseEMASlopeFilter, 1, 0), 0);
    print(file(fpath), outStr);
    hdrPrinted = true;
end;

//====================== 每根重置訊號 ======================
longSetup = false;
shortSetup = false;
longFilled = false;
shortFilled = false;
myEntryPrice = 0;

longBias = false;
shortBias = false;
longPullbackOK = false;
shortPullbackOK = false;

LongExitTrig = false;
ShortExitTrig = false;
ForceExitTrig = false;
ExitByHold = false;
outPrice = 0;

initSL = 0;
trailLine = 0;
activeStop = 0;
maxFavPts = 0;

//====================== 進場條件先算，但尚不更新狀態 ======================
if (sessOnEntry = 1) and (CurrentBar > warmupBars) then begin

    longBias =
        ((UseORFilter = false) or
         (orReady and (orWidth <= MaxORWidth) and
          (Open > orHi + ORBreakBuffer) and
          (Close[1] > orHi + ORBreakBuffer))) and
        ((UseVWAPFilter = false) or
         ((Open > vwap[1]) and (Close[1] > vwap[1]) and
          (vwap[1] >= vwap[2]) and
          (AbsValue(Open - vwap[1]) >= MinVWAPDist))) and
        ((UseEMASlopeFilter = false) or
         ((emaV[1] > emaV[2]) and (emaV[2] > emaV[3]) and
          ((emaV[1] - emaV[3]) >= MinEMASlope)));

    shortBias =
        ((UseORFilter = false) or
         (orReady and (orWidth <= MaxORWidth) and
          (Open < orLo - ORBreakBuffer) and
          (Close[1] < orLo - ORBreakBuffer))) and
        ((UseVWAPFilter = false) or
         ((Open < vwap[1]) and (Close[1] < vwap[1]) and
          (vwap[1] <= vwap[2]) and
          (AbsValue(Open - vwap[1]) >= MinVWAPDist))) and
        ((UseEMASlopeFilter = false) or
         ((emaV[1] < emaV[2]) and (emaV[2] < emaV[3]) and
          ((emaV[3] - emaV[1]) >= MinEMASlope)));

    longPullbackOK =
        (Low[1] <= emaV[1] + PullbackBuffer) and
        (Close[1] >= emaV[1]);

    shortPullbackOK =
        (High[1] >= emaV[1] - PullbackBuffer) and
        (Close[1] <= emaV[1]);

    longSetup =
        (Tvalue = 0) and
        (lastMarkBar <> CurrentBar) and
        (CurrentBar - lastExitBar > CoolDownBars) and
        longBias and
        longPullbackOK and
        (Open > emaV[1] + ReclaimGap) and
        ((Open - emaV[1]) <= MaxEntryGap);

    shortSetup =
        (Tvalue = 0) and
        (lastMarkBar <> CurrentBar) and
        (CurrentBar - lastExitBar > CoolDownBars) and
        shortBias and
        shortPullbackOK and
        (Open < emaV[1] - ReclaimGap) and
        ((emaV[1] - Open) <= MaxEntryGap);

    if longSetup and shortSetup then begin
        longSetup = false;
        shortSetup = false;
    end;

    if longSetup then begin
        myEntryPrice = Open;
        longFilled = true;
    end;

    if shortSetup then begin
        myEntryPrice = Open;
        shortFilled = true;
    end;
end;

//====================== 出場條件 ======================
if (sessOnManage = 1) and (CurrentBar > warmupBars) and (lastMarkBar <> CurrentBar) then begin

    if BeginTime <= ForceExitTime then begin
        if (Time >= ForceExitTime) and (Tvalue <> 0) then begin
            ForceExitTrig = true;
            outPrice = Open;
        end;
    end
    else begin
        if (Time >= ForceExitTime) and (Time < BeginTime) and (Tvalue <> 0) then begin
            ForceExitTrig = true;
            outPrice = Open;
        end;
    end;

    if (ForceExitTrig = false) and (Tvalue = 1) and (CurrentBar > entryBar) then begin
        tempPeak = MaxList(peakPrice, High);
        initSL = cost - StopLossPoints;
        maxFavPts = tempPeak - cost;
        activeStop = initSL;

        if maxFavPts >= ProtectTriggerPts then begin
            trailLine = tempPeak - GivebackPts;
            trailLine = MaxList(trailLine, cost + ProtectMinProfitPts);
            activeStop = MaxList(initSL, trailLine);
        end;

        if Open <= activeStop then begin
            LongExitTrig = true;
            outPrice = Open;
        end
        else if Low <= activeStop then begin
            LongExitTrig = true;
            outPrice = activeStop;
        end
        else if CurrentBar - entryBar >= MaxHoldBars then begin
            LongExitTrig = true;
            ExitByHold = true;
            outPrice = Open;
        end;
    end;

    if (ForceExitTrig = false) and (Tvalue = -1) and (CurrentBar > entryBar) then begin
        tempTrough = MinList(troughPrice, Low);
        initSL = cost + StopLossPoints;
        maxFavPts = cost - tempTrough;
        activeStop = initSL;

        if maxFavPts >= ProtectTriggerPts then begin
            trailLine = tempTrough + GivebackPts;
            trailLine = MinList(trailLine, cost - ProtectMinProfitPts);
            activeStop = MinList(initSL, trailLine);
        end;

        if Open >= activeStop then begin
            ShortExitTrig = true;
            outPrice = Open;
        end
        else if High >= activeStop then begin
            ShortExitTrig = true;
            outPrice = activeStop;
        end
        else if CurrentBar - entryBar >= MaxHoldBars then begin
            ShortExitTrig = true;
            ExitByHold = true;
            outPrice = Open;
        end;
    end;
end;

//====================== TXT 先輸出，再更新狀態 ======================
if hdrPrinted then begin
    hh = IntPortion(Time / 10000);
    mm = IntPortion((Time - hh * 10000) / 100);

    timeStr = "";
    if hh < 10 then timeStr = timeStr + "0" + NumToStr(hh, 0)
    else timeStr = timeStr + NumToStr(hh, 0);

    if mm < 10 then timeStr = timeStr + "0" + NumToStr(mm, 0)
    else timeStr = timeStr + NumToStr(mm, 0);

    dateTimeStr = NumToStr(Date, 0) + timeStr;

    if ForceExitTrig then begin
        outStr = dateTimeStr + " " + NumToStr(IntPortion(outPrice), 0) + " 強制平倉";
        print(file(fpath), outStr);
    end
    else if LongExitTrig then begin
        outStr = dateTimeStr + " " + NumToStr(IntPortion(outPrice), 0) + " 平賣";
        print(file(fpath), outStr);
    end
    else if ShortExitTrig then begin
        outStr = dateTimeStr + " " + NumToStr(IntPortion(outPrice), 0) + " 平買";
        print(file(fpath), outStr);
    end
    else if longFilled then begin
        outStr = dateTimeStr + " " + NumToStr(IntPortion(myEntryPrice), 0) + " 新買";
        print(file(fpath), outStr);
    end
    else if shortFilled then begin
        outStr = dateTimeStr + " " + NumToStr(IntPortion(myEntryPrice), 0) + " 新賣";
        print(file(fpath), outStr);
    end;
end;

//====================== 狀態更新：先出場，後進場 ======================
if lastMarkBar <> CurrentBar then begin
    if ForceExitTrig or LongExitTrig or ShortExitTrig then begin
        Tvalue = 0;
        cost = 0;
        entryBar = 0;
        peakPrice = 0;
        troughPrice = 0;
        lastExitBar = CurrentBar;
        lastMarkBar = CurrentBar;
    end;
end;

if (sessOnEntry = 1) and (CurrentBar > warmupBars) and (lastMarkBar <> CurrentBar) then begin
    if (Tvalue = 0) and (CurrentBar - lastExitBar > CoolDownBars) then begin
        if longFilled then begin
            Tvalue = 1;
            cost = myEntryPrice;
            entryBar = CurrentBar;
            peakPrice = cost;
            troughPrice = cost;
            lastMarkBar = CurrentBar;
        end
        else if shortFilled then begin
            Tvalue = -1;
            cost = myEntryPrice;
            entryBar = CurrentBar;
            peakPrice = cost;
            troughPrice = cost;
            lastMarkBar = CurrentBar;
        end;
    end;
end;

//====================== 持倉高低點正式更新 ======================
if (Tvalue = 1) and (CurrentBar > entryBar) then begin
    if High > peakPrice then peakPrice = High;
end;

if (Tvalue = -1) and (CurrentBar > entryBar) then begin
    if Low < troughPrice then troughPrice = Low;
end;

//====================== Plot ======================
if longFilled then Plot1(myEntryPrice, "新買") else Plot1(0, "新買");
if shortFilled then Plot2(myEntryPrice, "新賣") else Plot2(0, "新賣");
if LongExitTrig then Plot3(outPrice, "平賣") else Plot3(0, "平賣");
if ShortExitTrig then Plot4(outPrice, "平買") else Plot4(0, "平買");
if ForceExitTrig then Plot5(outPrice, "強制平倉") else Plot5(0, "強制平倉");

Plot6(emaV[1], "EMA定錨");
Plot11(vwap[1], "VWAP定錨");

if orReady then begin
    Plot13(orHi, "ORH");
    Plot14(orLo, "ORL");
end
else begin
    Plot13(0, "ORH");
    Plot14(0, "ORL");
end;

if ShowBiasPlots and longBias then Plot15(Open, "多方主導") else Plot15(0, "多方主導");
if ShowBiasPlots and shortBias then Plot16(Open, "空方主導") else Plot16(0, "空方主導");

if (Tvalue = 1) and (CurrentBar > entryBar) then begin
    Plot7(cost - StopLossPoints, "多初停");
    tempPeak = MaxList(peakPrice, High);
    if tempPeak - cost >= ProtectTriggerPts then begin
        trailLine = MaxList(tempPeak - GivebackPts, cost + ProtectMinProfitPts);
        Plot8(trailLine, "多回吐停利");
    end
    else Plot8(0, "多回吐停利");
end
else begin
    Plot7(0, "多初停");
    Plot8(0, "多回吐停利");
end;

if (Tvalue = -1) and (CurrentBar > entryBar) then begin
    Plot9(cost + StopLossPoints, "空初停");
    tempTrough = MinList(troughPrice, Low);
    if cost - tempTrough >= ProtectTriggerPts then begin
        trailLine = MinList(tempTrough + GivebackPts, cost - ProtectMinProfitPts);
        Plot10(trailLine, "空回吐停利");
    end
    else Plot10(0, "空回吐停利");
end
else begin
    Plot9(0, "空初停");
    Plot10(0, "空回吐停利");
end;
