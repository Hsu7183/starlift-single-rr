// Auto-generated XS for EMA_RSI_Momentum

input: fastLen(12);
input: slowLen(26);
input: rsiLen(14);

vars:
    emaFast(0),
    emaSlow(0),
    rsiVal(0),
    longCondition(false),
    shortCondition(false);

if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");

emaFast = XAverage(Close[1], fastLen);
emaSlow = XAverage(Close[1], slowLen);
rsiVal = RSI(Close[1], rsiLen);

longCondition = Open > emaFast and emaFast > emaSlow and rsiVal > 55;
shortCondition = Open < emaFast and emaFast < emaSlow and rsiVal < 45;

plot1(longCondition, "LongSignal");
plot2(shortCondition, "ShortSignal");
