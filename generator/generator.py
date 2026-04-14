"""Generate indicator.xs and trading.xs from a strategy JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from rule_checker import run_checks

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = ROOT / "templates"
SCHEMA_PATH = ROOT / "schemas" / "strategy_schema.json"


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _validate(strategy: dict[str, Any], schema_path: Path = SCHEMA_PATH) -> None:
    schema = _load_json(schema_path)
    try:
        import jsonschema  # type: ignore
        jsonschema.validate(strategy, schema)
        return
    except ImportError:
        pass

    required = schema.get("required", [])
    missing = [k for k in required if k not in strategy]
    if missing:
        raise ValueError(f"策略缺少必要欄位: {missing}")


def _build_inputs(inputs: list[dict[str, Any]]) -> str:
    lines = []
    for item in inputs:
        lines.append(f"input: {item['name']}({item['default']});")
    return "\n".join(lines)


def _build_vars(indicators: list[dict[str, str]]) -> str:
    if not indicators:
        return "    longCondition(false),\n    shortCondition(false);"

    indicator_vars = [f"    {it['var']}(0)" for it in indicators]
    indicator_vars.extend(["    longCondition(false)", "    shortCondition(false)"])
    return ",\n".join(indicator_vars) + ";"


def _build_indicator_lines(indicators: list[dict[str, str]]) -> str:
    lines = []
    for it in indicators:
        lines.append(f"{it['var']} = {it['expression']};")
    return "\n".join(lines)


def _render(template: str, strategy: dict[str, Any]) -> str:
    return (
        template.replace("{HEADER}", f"// Auto-generated XS for {strategy['name']}")
        .replace("{INPUTS}", _build_inputs(strategy["inputs"]))
        .replace("{VARS}", _build_vars(strategy["indicators"]))
        .replace("{INDICATORS}", _build_indicator_lines(strategy["indicators"]))
        .replace("{LONG_CONDITION}", strategy["conditions"]["long"])
        .replace("{SHORT_CONDITION}", strategy["conditions"]["short"])
    )


def generate(strategy_path: Path, output_dir: Path) -> tuple[Path, Path]:
    strategy = _load_json(strategy_path)
    _validate(strategy)

    indicator_template = (TEMPLATE_DIR / "indicator_base.xs").read_text(encoding="utf-8")
    trading_template = (TEMPLATE_DIR / "trading_base.xs").read_text(encoding="utf-8")

    indicator_text = _render(indicator_template, strategy)
    trading_text = _render(trading_template, strategy)

    indicator_path = output_dir / "indicator.xs"
    trading_path = output_dir / "trading.xs"

    indicator_path.write_text(indicator_text, encoding="utf-8")
    trading_path.write_text(trading_text, encoding="utf-8")

    exit_code = run_checks([indicator_path, trading_path], indicator_path, trading_path)
    if exit_code != 0:
        raise RuntimeError("生成結果未通過規則檢查，請修正策略輸入。")

    return indicator_path, trading_path


def main() -> int:
    parser = argparse.ArgumentParser(description="XS generator")
    parser.add_argument("--strategy", default=str(ROOT / "examples" / "sample_strategy.json"))
    parser.add_argument("--output-dir", default=str(ROOT))
    args = parser.parse_args()

    indicator, trading = generate(Path(args.strategy), Path(args.output_dir))
    print(f"Generated: {indicator}")
    print(f"Generated: {trading}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
