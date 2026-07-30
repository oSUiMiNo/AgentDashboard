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
import re
import socket
import sys
from pathlib import Path

TARGET_SUFFIXES = {".jsonl", ".json", ".txt", ".md", ".cast"}

# 端末録画（asciicast v2）だけに要る追加の検査。
#
# 録画の中身は**生の端末バイト列**なので、行単位の置換だけでは足りない。同じ文字列が
# チャンクの境目で2つのイベントに割れていると、どちらの側にも完全な形では現れないため、
# 置換もすり抜けるし通常の残存検査にも引っかからない。イベントをつなぎ直してから
# 検査するのはそのため。エスケープシーケンスを落とした版も併せて見るのは、TUI が
# 文字列の途中でカーソルを動かす（折り返し等）場合に備えて。
#
# ただし**これで完全ではない**。防ぎ方の本体は採取側にある——作業ディレクトリを
# `$HOME` の外に置き、`--setting-sources project,local` で利用者の設定を読み込ませない
# （`server/crates/agent-core/tests/pty_record.rs`）。ここは最後の網。
CAST_EVENT_CODES = ("o", "i")

# ANSI のエスケープシーケンス（CSI / OSC / 単発）。落としてから素の文字列も検査する。
ANSI_PATTERN = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")

# 公開してはいけない代表格。**claude の TUI はログイン中のアカウントを画面に出す**ので、
# 録画には必ず混入する（実測。フェーズ0 の採取1回目で検出した）。
EMAIL_PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

# 置き換え先。ドキュメント用に予約されたドメインなので、実在の宛先を指すことがない。
EMAIL_PLACEHOLDER = "redacted@example.invalid"

# 説明用に予約されたドメイン。題材のコードやドキュメントに出てくるものまで潰すと、
# フィクスチャとしての中身が変わってしまうので残す。
EXAMPLE_DOMAINS = ("example.com", "example.org", "example.net", "example.invalid")

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


def account_rules() -> list[tuple[str, str]]:
    """ログイン中のアカウントに由来する文字列の置換規則を、CLI の設定から組み立てる。

    **claude の TUI は起動直後の枠に「Welcome back <表示名>」とアカウントのメール・
    所属を出す**（実測。フェーズ0 の採取で検出した）。表示名は OS のユーザ名とは別物なので、
    ホームパスやユーザ名の規則では捕まらない。

    規則をこのスクリプトに書き並べる方式は採らない——書けばそれ自体が公開情報になる。
    採取した環境の `~/.claude.json` から読み取って、その場で規則にする。
    """
    path = Path.home() / ".claude.json"
    try:
        account = json.loads(path.read_text(encoding="utf-8")).get("oauthAccount")
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(account, dict):
        return []

    placeholders = {
        "displayName": "dashboard-user",
        "emailAddress": EMAIL_PLACEHOLDER,
        "organizationName": "dashboard-org",
        "accountUuid": "00000000-0000-0000-0000-0000000000ac",
        "organizationUuid": "00000000-0000-0000-0000-000000000009",
    }
    rules: list[tuple[str, str]] = []
    for key, placeholder in placeholders.items():
        value = account.get(key)
        if isinstance(value, str) and value:
            rules.append((value, placeholder))
    return rules


def build_replacements(extra: list[str]) -> list[tuple[str, str]]:
    """置換規則を組み立てる。長い文字列から先に当てるため、後で長さ順に並べ替える。"""
    home = str(Path.home())
    user = getpass.getuser()
    host = socket.gethostname()

    rules: list[tuple[str, str]] = list(account_rules())
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


def is_example_address(address: str) -> bool:
    return address.lower().endswith(EXAMPLE_DOMAINS)


def redact_emails(text: str) -> str:
    """メールアドレスらしき文字列を差し替える。

    採取のたびに宛先が変わるので置換規則を書き並べる方式では取りこぼす。**規則ではなく
    形で捕まえる**。スクリプトに実在のアドレスを書かずに済むという意味もある
    （このスクリプト自体が公開物なので、書けば公開したことになる）。
    """
    return EMAIL_PATTERN.sub(
        lambda match: match.group(0)
        if is_example_address(match.group(0))
        else EMAIL_PLACEHOLDER,
        text,
    )


def sanitize_file(path: Path, rules: list[tuple[str, str]]) -> int:
    original = path.read_text(encoding="utf-8", errors="surrogateescape")
    text = original
    for old, new in rules:
        text = text.replace(old, new)
    text = redact_emails(text)
    if text != original:
        path.write_text(text, encoding="utf-8", errors="surrogateescape")
        return 1
    return 0


def sanitize_cast(path: Path, rules: list[tuple[str, str]]) -> int:
    """端末録画は「イベントの中身」を直す。ファイルの文字列を直接いじってはいけない。

    録画の1行は `[時刻, 種別, データ]` の JSON で、データの中の制御文字は `\\u001b` の形で
    書かれている。ファイルの文字列に正規表現を当てると、**エスケープシーケンスの一部を
    アドレスの一部と読み違えて壊す**（`ESC[30G` の直後にアドレスが続くと `30G...` から
    一致してしまい、置換でカーソル移動の指定ごと消える。実測で踏んだ）。

    デコードしてから直し、書き戻すときに JSON へ戻す。置換はエスケープシーケンスの
    外側だけに当てる。
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines:
        return 0

    changed = False
    out: list[str] = []
    for index, line in enumerate(lines):
        if index == 0 or not line.strip():
            out.append(apply_rules(line, rules))
            changed = changed or out[-1] != line
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            out.append(line)
            continue
        if not (isinstance(event, list) and len(event) == 3 and isinstance(event[2], str)):
            out.append(line)
            continue

        cleaned = redact_outside_escapes(apply_rules(event[2], rules))
        if cleaned != event[2]:
            changed = True
        event[2] = cleaned
        out.append(json.dumps(event, ensure_ascii=False))

    if changed:
        path.write_text("\n".join(out) + "\n", encoding="utf-8")
        return 1
    return 0


def apply_rules(text: str, rules: list[tuple[str, str]]) -> str:
    for old, new in rules:
        text = text.replace(old, new)
    return text


def redact_outside_escapes(text: str) -> str:
    """エスケープシーケンスを避けて、素の文字列部分だけを差し替える。"""
    pieces = re.split(f"({ANSI_PATTERN.pattern})", text)
    # re.split は「区切り以外, 区切り, 区切り以外, ...」の順で返す。偶数番だけが素の文字列
    return "".join(
        piece if index % 2 else redact_emails(piece) for index, piece in enumerate(pieces)
    )


def describe(old: str, new: str, secrets: set[str]) -> str:
    """残存を報告するときの見せ方。アカウント由来の値は伏せて、置換先で示す。"""
    if old in secrets:
        return f"{new!r} になるはずの文字列（{len(old)} 文字）"
    return repr(old)


def find_leaks(root: Path, rules: list[tuple[str, str]], secrets: set[str]) -> list[str]:
    """置換後にも残っている機微文字列を洗い出す。"""
    leaks: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in TARGET_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="surrogateescape")
        for old, new in rules:
            if old and old in text:
                leaks.append(f"{path}: {describe(old, new, secrets)}")
        for found in sorted(set(EMAIL_PATTERN.findall(text))):
            if not is_example_address(found):
                leaks.append(f"{path}: メールアドレスらしき文字列 {found!r}")
    return leaks


def assemble_cast(path: Path) -> str:
    """asciicast のイベントをつなぎ直して、1本の端末バイト列に戻す。"""
    stream: list[str] = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
        line = line.strip()
        # 1行目はヘッダ。イベントではない
        if not line or index == 0:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, list) and len(event) == 3 and event[1] in CAST_EVENT_CODES:
            stream.append(str(event[2]))
    return "".join(stream)


def find_cast_leaks(root: Path, rules: list[tuple[str, str]], secrets: set[str]) -> list[str]:
    """端末録画を「つなぎ直した状態」と「エスケープを落とした状態」で検査する。"""
    leaks: list[str] = []
    for path in sorted(root.rglob("*.cast")):
        joined = assemble_cast(path)
        plain = ANSI_PATTERN.sub("", joined)
        for view, text in (("連結", joined), ("エスケープ除去後", plain)):
            for old, new in rules:
                if old and old in text:
                    leaks.append(f"{path}（{view}）: {describe(old, new, secrets)}")
            for found in sorted(set(EMAIL_PATTERN.findall(text))):
                if not is_example_address(found):
                    leaks.append(f"{path}（{view}）: メールアドレスらしき文字列 {found!r}")
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
    # アカウント由来の値そのものは画面へ出さない。ログを貼るだけで漏れてしまうため
    secrets = {old for old, _ in account_rules()}
    print("適用する置換規則:")
    for old, new in rules:
        shown = "（アカウント由来・伏せる）" if old in secrets else repr(old)
        print(f"  {shown} -> {new!r}")

    changed = 0
    scanned = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in TARGET_SUFFIXES:
            continue
        scanned += 1
        # 端末録画だけは中身の構造を見て直す（ファイルの文字列を直接いじると壊れる）
        if path.suffix == ".cast":
            changed += sanitize_cast(path, rules)
        else:
            changed += sanitize_file(path, rules)

    print(f"走査 {scanned} ファイル / 置換 {changed} ファイル")

    leaks = find_leaks(root, rules, secrets) + find_cast_leaks(root, rules, secrets)
    if leaks:
        print("機微情報が残っています:", file=sys.stderr)
        for leak in leaks:
            print(f"  {leak}", file=sys.stderr)
        return 1

    print("機微情報の残存なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
