#!/usr/bin/env python3
"""ゴールデンフィクスチャから機微情報を取り除く。

使い捨てディレクトリで採取していても、トランスクリプトには実行環境そのものに由来する
情報が必ず残る。フィクスチャはリポジトリ（公開）に入れてテストで使い続けるものなので、
ここで機械的に落としておく。落とす対象は2種類ある。

1. 文字列レベル：ホームディレクトリの絶対パス・ユーザ名・ホスト名
2. レコードレベル：`type: "attachment"` と `type: "system"` のレコードが運ぶ
   **利用者の環境インベントリ**（導入済みスキルの一覧と説明・カスタムサブエージェント・
   接続中のMCPサーバ・フックのコマンド行など）。これは採取内容と無関係に、その環境の
   構成情報がそのまま書き出される

2 は分量も多く、置換では消せない（何が入るか事前に列挙できない）。パーサ側では
どちらも表示対象外のレコード種別として読み飛ばす扱いなので、**中身を落として
レコードの形だけ残す**方式を採る。これでフィクスチャとしての価値（「表示対象外の
レコードが混ざったJSONLを正しく処理できるか」の検証）は保ったまま安全になる。
レコードごと消してはいけない。どちらも親子の鎖に参加しており、消すと後続のレコードが
置き場所を見失う。

置換・除去したうえで「まだ残っていないか」を自分で検査し、残っていたら異常終了する。
目視確認に頼らないのは、採取のたびに人手のチェックが必要になる運用を避けるため。
"""

from __future__ import annotations

import argparse
import getpass
import json
import socket
import sys
from pathlib import Path

TARGET_SUFFIXES = {".jsonl", ".json", ".txt", ".md"}

REDACTION_NOTE = "環境固有の情報を含むため除去（scripts/sanitize-fixtures.py）"

# 置換後のスキル名に付ける接頭辞。
PLACEHOLDER_PREFIX = "sample-skill-"


# 中身を落とすレコード種別。
#
# どちらも「採取内容と無関係に、その環境の構成情報が書き出される」種別。
# 何が入るか事前に列挙できないので、文字列置換では消せない。
#
# - attachment … 導入済みスキルの一覧・カスタムサブエージェント・接続中のMCPサーバ等
# - system     … `subtype: "stop_hook_summary"` が **利用者のフックのコマンド行**を
#                そのまま持つ（スクリプトのパスと名前を含む）
REDACT_TYPES = ("attachment", "system")

# 中身として落とすキー（トップレベルのキー構成は変えない）。
REDACT_KEYS = {
    "attachment": ("attachment",),
    "system": ("hookInfos", "hookErrors", "hookAdditionalContext", "content", "toolUseID"),
}


def redact_attachments(path: Path) -> int:
    """JSONL 中の attachment / system レコードの中身を落とし、形だけ残す。

    トップレベルのキー構成（uuid / parentUuid / timestamp / type 等）は変えないため、
    パーサのスレッディングやスキップ処理の検証には引き続き使える。**どちらの種別も
    親子の鎖に参加する**ので、レコードごと消してはいけない（消すと後続のレコードが
    置き場所を見失う）。
    """
    redacted = 0
    out_lines: list[str] = []
    changed = False

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            out_lines.append(line)
            continue
        try:
            record = json.loads(stripped)
        except json.JSONDecodeError:
            # 壊れた行はフィクスチャとして意味があるのでそのまま残す
            out_lines.append(line)
            continue

        record_type = record.get("type") if isinstance(record, dict) else None
        if record_type in REDACT_TYPES:
            if record_type == "attachment":
                attachment = record.get("attachment")
                inner_type = (
                    attachment.get("type") if isinstance(attachment, dict) else None
                )
                record["attachment"] = {"type": inner_type, "redacted": REDACTION_NOTE}
            else:
                # system は subtype を残す（パーサの分類の検証に要る）
                for key in REDACT_KEYS[record_type]:
                    if key in record:
                        record[key] = REDACTION_NOTE
            out_lines.append(json.dumps(record, ensure_ascii=False))
            redacted += 1
            changed = True
        else:
            out_lines.append(line)

    if changed:
        path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    return redacted


def collect_skill_names(root: Path) -> list[str]:
    """トランスクリプトに登場する Skill ツールコールのスキル名を集める。

    利用者が自分で定義したスキルの名前は環境固有の情報にあたる。attachment を落としても、
    実際にスキルを起動した場合はツールコールと本文の両方に名前が残る（フックがセッション
    開始時にスキルを起動する設定になっていると、採取のたびに必ず混入する）。

    スクリプト側に具体的な名前を書くとそれ自体が公開情報になってしまうため、
    ハードコードせず採取物から動的に抽出する。
    """
    names: set[str] = set()

    def is_placeholder(name: str) -> bool:
        """既に置換済みの名前かどうか。

        採取をやり直すと、置換済みのフィクスチャからも名前を拾ってしまう。そのまま
        規則にすると `sample-skill-1 -> sample-skill-1` という自分自身への置換になり、
        残存検査が**永久に真**になって採取が通らなくなる。
        """
        return name.startswith(PLACEHOLDER_PREFIX)

    def walk(value: object) -> None:
        if isinstance(value, dict):
            if value.get("type") == "tool_use" and value.get("name") == "Skill":
                skill = value.get("input", {})
                if isinstance(skill, dict) and isinstance(skill.get("skill"), str):
                    if not is_placeholder(skill["skill"]):
                        names.add(skill["skill"])
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    for path in root.rglob("*.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                walk(json.loads(line))
            except json.JSONDecodeError:
                continue

    return sorted(names)


def build_replacements(extra: list[str]) -> list[tuple[str, str]]:
    """置換規則を組み立てる。長い文字列から先に当てるため、後で長さ順に並べ替える。"""
    home = str(Path.home())
    user = getpass.getuser()
    host = socket.gethostname()

    rules: list[tuple[str, str]] = []
    for pair in extra:
        if "=" not in pair:
            raise SystemExit(f"--extra は old=new の形で指定してください: {pair}")
        old, new = pair.split("=", 1)
        if old:
            rules.append((old, new))

    rules.append((home, "/home/dashboard-user"))
    rules.append((user, "dashboard-user"))
    if host and host not in {"localhost"}:
        rules.append((host, "dashboard-host"))

    # 部分一致で短い規則が先に当たると長い規則が壊れるため、長い順に適用する
    rules.sort(key=lambda rule: len(rule[0]), reverse=True)
    return rules


def sanitize_file(path: Path, rules: list[tuple[str, str]]) -> int:
    original = path.read_text(encoding="utf-8", errors="surrogateescape")
    text = original
    for old, new in rules:
        text = text.replace(old, new)
    if text != original:
        path.write_text(text, encoding="utf-8", errors="surrogateescape")
        return 1
    return 0


def find_leaks(root: Path, rules: list[tuple[str, str]]) -> list[str]:
    """置換後にも残っている機微文字列を洗い出す。"""
    leaks: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in TARGET_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="surrogateescape")
        for old, _ in rules:
            if old and old in text:
                leaks.append(f"{path}: {old!r}")
    return leaks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="フィクスチャのディレクトリ")
    parser.add_argument(
        "--extra",
        action="append",
        default=[],
        metavar="OLD=NEW",
        help="追加の置換規則（採取時の一時ディレクトリなど）。複数指定可",
    )
    args = parser.parse_args()

    root: Path = args.directory
    if not root.is_dir():
        print(f"ディレクトリがありません: {root}", file=sys.stderr)
        return 1

    # まず attachment / system の中身を落とす。ここに環境インベントリが載るため、
    # 文字列置換より先に処理して走査対象から消しておく。
    redacted_total = 0
    for path in sorted(root.rglob("*.jsonl")):
        redacted_total += redact_attachments(path)
    print(f"環境情報を持つレコード（attachment / system）を {redacted_total} 件除去")

    # 採取物から動的に見つけたスキル名も置換対象へ足す
    skill_names = collect_skill_names(root)
    for index, name in enumerate(skill_names, 1):
        args.extra.append(f"{name}={PLACEHOLDER_PREFIX}{index}")

    rules = build_replacements(args.extra)
    print("適用する置換規則:")
    for old, new in rules:
        print(f"  {old!r} -> {new!r}")

    changed = 0
    scanned = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in TARGET_SUFFIXES:
            continue
        scanned += 1
        changed += sanitize_file(path, rules)

    print(f"走査 {scanned} ファイル / 置換 {changed} ファイル")

    leaks = find_leaks(root, rules)
    if leaks:
        print("機微情報が残っています:", file=sys.stderr)
        for leak in leaks:
            print(f"  {leak}", file=sys.stderr)
        return 1

    print("機微情報の残存なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
