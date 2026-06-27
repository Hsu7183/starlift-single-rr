"""Rule checker for XS strategy scripts."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

TECH_INDICATORS = ("XAverage", "EMA", "ATR", "RSI", "VWAP", "Average")
FORBIDDEN_CURRENT_BAR_FIELDS = ("Close", "High", "Low", "Volume")
BAR_GUARD = 'if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");'


@dataclass
class CheckResult:
    filename: str
    violations: list[str]

    @property
    def passed(self) -> bool:
        return not self.violations


def _normalize(expr: str) -> str:
    return re.sub(r"\s+", " ", expr.strip())


def check_no_current_bar_entry(script: str) -> list[str]:
    violations: list[str] = []
    entry_lines = []
    for ln in script.splitlines():
        low = ln.lower()
        if "longcondition" in low or "shortcondition" in low or "setposition" in low:
            entry_lines.append(ln)

    for line in entry_lines:
        for field in FORBIDDEN_CURRENT_BAR_FIELDS:
            pattern = rf"\b{field}\b(?!\s*\[)"
            if re.search(pattern, line, flags=re.IGNORECASE):
                violations.append(f"進場條件使用當根 {field}: {line.strip()}")
    return violations


def check_indicators_have_lag(script: str) -> list[str]:
    violations: list[str] = []
    for line in script.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        for fn in TECH_INDICATORS:
            if re.search(rf"\b{fn}\s*\(", stripped):
                if "[1]" not in stripped and "[2]" not in stripped and "[3]" not in stripped:
                    violations.append(f"指標未使用 [1] 或更早: {stripped}")
    return violations


def check_no_same_bar_reversal(script: str) -> list[str]:
    violations: list[str] = []
    normalized = [_normalize(ln) for ln in script.splitlines() if ln.strip()]
    has_long_set = any("setPosition(1)" in ln for ln in normalized)
    has_short_set = any("setPosition(-1)" in ln for ln in normalized)
    if has_long_set and has_short_set:
        for ln in normalized:
            if "setPosition(1)" in ln and "marketposition <= 0" not in ln:
                violations.append("多單 setPosition 缺少 marketposition <= 0 保護")
            if "setPosition(-1)" in ln and "marketposition >= 0" not in ln:
                violations.append("空單 setPosition 缺少 marketposition >= 0 保護")
    return violations


def check_output_format(script: str) -> list[str]:
    violations: list[str] = []
    if BAR_GUARD not in script:
        violations.append("缺少分鐘線限制防護")
    if "longCondition =" not in script or "shortCondition =" not in script:
        violations.append("缺少 longCondition/shortCondition 定義")
    return violations


def check_script(path: Path) -> CheckResult:
    script = path.read_text(encoding="utf-8")
    violations = []
    violations.extend(check_no_current_bar_entry(script))
    violations.extend(check_indicators_have_lag(script))
    violations.extend(check_no_same_bar_reversal(script))
    violations.extend(check_output_format(script))
    return CheckResult(filename=str(path), violations=violations)


def check_consistency(indicator_path: Path, trading_path: Path) -> list[str]:
    indicator = indicator_path.read_text(encoding="utf-8")
    trading = trading_path.read_text(encoding="utf-8")

    def extract_conditions(text: str) -> tuple[str, str]:
        long_match = re.search(r"longCondition\s*=\s*(.+?);", text)
        short_match = re.search(r"shortCondition\s*=\s*(.+?);", text)
        return (
            _normalize(long_match.group(1)) if long_match else "",
            _normalize(short_match.group(1)) if short_match else "",
        )

    i_long, i_short = extract_conditions(indicator)
    t_long, t_short = extract_conditions(trading)
    violations = []
    if i_long != t_long:
        violations.append("indicator/trading longCondition 不一致")
    if i_short != t_short:
        violations.append("indicator/trading shortCondition 不一致")
    return violations


def run_checks(files: Iterable[Path], indicator_path: Path | None = None, trading_path: Path | None = None) -> int:
    exit_code = 0
    for file_path in files:
        result = check_script(file_path)
        if result.passed:
            print(f"[PASS] {result.filename}")
        else:
            exit_code = 1
            print(f"[FAIL] {result.filename}")
            for v in result.violations:
                print(f"  - {v}")

    if indicator_path and trading_path:
        consistency_violations = check_consistency(indicator_path, trading_path)
        if consistency_violations:
            exit_code = 1
            print("[FAIL] indicator/trading consistency")
            for v in consistency_violations:
                print(f"  - {v}")
        else:
            print("[PASS] indicator/trading consistency")
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description="XS rule checker")
    parser.add_argument("files", nargs="*", help="XS files to check")
    parser.add_argument("--indicator", help="Indicator XS file path")
    parser.add_argument("--trading", help="Trading XS file path")
    args = parser.parse_args()

    files = [Path(p) for p in args.files]
    indicator_path = Path(args.indicator) if args.indicator else None
    trading_path = Path(args.trading) if args.trading else None

    return run_checks(files, indicator_path, trading_path)


if __name__ == "__main__":
    raise SystemExit(main())
