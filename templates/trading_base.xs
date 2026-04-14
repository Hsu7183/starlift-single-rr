{HEADER}

{INPUTS}

vars:
{VARS}

if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");

{INDICATORS}

longCondition = {LONG_CONDITION};
shortCondition = {SHORT_CONDITION};

if longCondition and marketposition <= 0 then setPosition(1);
if shortCondition and marketposition >= 0 then setPosition(-1);
