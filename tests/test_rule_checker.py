from pathlib import Path

from generator.rule_checker import check_consistency, check_script


def test_detect_current_bar_close_entry(tmp_path: Path) -> None:
    bad = tmp_path / "bad_close.xs"
    bad.write_text(
        'if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");\n'
        "longCondition = Close > 100;\n"
        "shortCondition = Open < 100;\n",
        encoding="utf-8",
    )

    result = check_script(bad)
    assert any("當根 Close" in v for v in result.violations)


def test_detect_missing_lag_index(tmp_path: Path) -> None:
    bad = tmp_path / "bad_lag.xs"
    bad.write_text(
        'if barfreq <> "Min" then raiseRunTimeError("本腳本僅支援分鐘線");\n'
        "emaFast = XAverage(Close, 12);\n"
        "longCondition = Open > emaFast;\n"
        "shortCondition = Open < emaFast;\n",
        encoding="utf-8",
    )

    result = check_script(bad)
    assert any("指標未使用 [1]" in v for v in result.violations)


def test_indicator_and_trading_consistency(tmp_path: Path) -> None:
    indicator = tmp_path / "indicator.xs"
    trading = tmp_path / "trading.xs"

    indicator.write_text(
        "longCondition = Open > emaFast;\nshortCondition = Open < emaFast;\n",
        encoding="utf-8",
    )
    trading.write_text(
        "longCondition = Open > emaFast;\nshortCondition = Open < emaFast;\n",
        encoding="utf-8",
    )

    violations = check_consistency(indicator, trading)
    assert violations == []
