{HEADER}

{INPUTS}

vars:
{VARS}

if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");

{INDICATORS}

longCondition = {LONG_CONDITION};
shortCondition = {SHORT_CONDITION};

plot1(longCondition, "LongSignal");
plot2(shortCondition, "ShortSignal");
