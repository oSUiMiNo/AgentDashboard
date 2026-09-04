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
import unicodedata
from pathlib import Path

TARGET_SUFFIXES = {".jsonl", ".json", ".txt", ".md", ".cast", ".screen"}

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

# 打っただけのスラッシュコマンド名を拾う綴り。
#
# `collect_skill_names` はツールとして呼んだスキルしか集めない。**コマンドとして
# 打っただけのスキル名は `tool_use` に現れない**ので、そちらは素通りしていた
# （`人が打っていないものを、人の発言として出さない` 設計§7-3）。
COMMAND_NAME_PATTERN = re.compile(r"<command-name>/?([^<>\s]+)</command-name>")

# 他セッションからの連絡だけに付く名乗り。
#
# **これは `type: "user"` に入る。** レコード種別で伏せる方式（[`REDACT_TYPES`]）を
# 当てられない——`user` はプロンプトもツール結果も運ぶので、丸ごと伏せると
# **フィクスチャが門として機能しなくなる**。だから種別ではなく**欄で**落とす。
PEER_ORIGIN_KIND = "peer"

# `origin` の中で落とす欄。**`kind` は残す**（判定の検証に要る）。
#
# `body` は送り主の本文が**まるごと**入る（`message.content` と同じものが二重に載る）。
# `from` は送信元のソケットのパス、`verifiedPeer*` は相手のプロセスの素性である。
PEER_ORIGIN_DROP_KEYS = ("body", "from", "msg_id", "verifiedPeerPid", "verifiedPeerProcStart")

# 送り主のセッション名の置き換え先。
PEER_NAME_PLACEHOLDER = "sample-peer-session"

# 残存検査で必ず落とす綴り。**採取のたびに人が目で見るのではなく、機械を最後の網にする。**
FORBIDDEN_SUBSTRINGS = ("uds:/tmp/cc-socks/",)


# 中身を落とすレコード種別。
#
# どちらも「採取内容と無関係に、その環境の構成情報が書き出される」種別。
# 何が入るか事前に列挙できないので、文字列置換では消せない。
#
# - attachment … 導入済みスキルの一覧・カスタムサブエージェント・接続中のMCPサーバ等
# - system     … `subtype: "stop_hook_summary"` が **利用者のフックのコマンド行**を
#                そのまま持つ（スクリプトのパスと名前を含む）
# - queue-operation … `content` が**利用者が打った指示そのもの**。フックが差し込む
#                文脈やサブエージェントの完了通知も丸ごと入る（実データで確認）。
#                **待ちを画面に出すようになった以上、ここは必ず伏せる**
#                （作業中に送った追加メッセージ 設計§11-3）
REDACT_TYPES = ("attachment", "system", "queue-operation")

# 中身として落とすキー（トップレベルのキー構成は変えない）。
REDACT_KEYS = {
    "attachment": ("attachment",),
    "system": ("hookInfos", "hookErrors", "hookAdditionalContext", "content", "toolUseID"),
    # **欄ごと消さない。** 印の文字列へ差し替えるので、`enqueue` は本文を持ったまま
    # 残り、待ちの行がフィクスチャからも出る——ゴールデンの門が働き続ける
    "queue-operation": ("content",),
}


def redact_peer_origin(record: dict) -> bool:
    """他セッションからの連絡の中身を落とし、形だけ残す。落としたら真を返す。

    **`user` レコードを丸ごと伏せてはいけない。** あの種別はプロンプトもツール結果も
    運ぶので、種別ごと落とすとフィクスチャが門として死ぬ。落とすのは
    **`origin.kind == "peer"` のときの、危ない欄だけ**である。

    落とすもの：
    - `origin` の中の本文・送信元・相手のプロセスの素性（[`PEER_ORIGIN_DROP_KEYS`]）
    - `origin.name`（送り主のセッション名）は固定の代替名へ差し替える
    - **`message.content`**。同じ本文がここにも入っているので、片方だけでは漏れる

    残すもの：`origin.kind`。**判定（誰が入れたか）の検証にはこれだけあれば足りる。**
    """
    origin = record.get("origin")
    if not isinstance(origin, dict) or origin.get("kind") != PEER_ORIGIN_KIND:
        return False

    for key in PEER_ORIGIN_DROP_KEYS:
        if key in origin:
            origin[key] = REDACTION_NOTE
    if "name" in origin:
        origin["name"] = PEER_NAME_PLACEHOLDER

    # 本文は2か所にある。**`origin.body` だけ落としても、こちらから漏れる**
    message = record.get("message")
    if isinstance(message, dict) and "content" in message:
        message["content"] = REDACTION_NOTE
    return True


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
        if record_type == "user" and redact_peer_origin(record):
            out_lines.append(json.dumps(record, ensure_ascii=False))
            redacted += 1
            changed = True
        elif record_type in REDACT_TYPES:
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
            # **打っただけのコマンド名は `tool_use` に現れない。** 木を歩いても拾えない
            # ので、行の字面から直に取る（`message.content` が素の文字列の形もあるため）
            for found in COMMAND_NAME_PATTERN.findall(line):
                if not is_placeholder(found):
                    names.add(found)
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


def is_screen(path: Path) -> bool:
    """画面の写しか。**幅が意味を持つ**ファイルだけを見分ける。"""
    return path.suffix == ".screen" or path.parent.name == "screens"


def display_width(text: str) -> int:
    """端末での表示幅。全角（East Asian Wide / Fullwidth）は2桁。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def fit_width(text: str, width: int) -> str:
    """表示幅を `width` ちょうどに合わせる。

    # 溢れたぶんは、末尾ではなく**内側の空白**から詰める

    画面の写しは**枠で囲まれている**（`│ … │ … │`）。素直に末尾を切ると、
    **右の枠線と、その手前の本文ごと落ちる**——実物で確かめた。

    ```
    │   Welcome back dashboard-user!   │ Run /init to … for Cla… │
                                                              ↑ ここを切ってしまう
    ```

    落としてよいのは**余白だけ**なので、いちばん長い空白の連なりを縮める。
    縮めきれないときだけ、最後の手段として末尾を切る（全角を半分に割らないよう
    1文字ずつ積む）。
    """
    current = display_width(text)
    if current == width:
        return text
    if current < width:
        return text + " " * (width - current)

    over = current - width
    # まず「余白らしい余白」（2つ以上の連なり）から詰める。1つは残す——語がくっつくと
    # 画面の意味が変わる
    for _ in range(over):
        runs = [m for m in re.finditer(r" {2,}", text) if (m.end() - m.start()) >= 2]
        if not runs:
            break
        longest = max(runs, key=lambda m: m.end() - m.start())
        text = text[: longest.end() - 1] + text[longest.end() :]
        over -= 1
    # それでも溢れるなら、**いちばん右の単独の空白**を詰める。枠線（`│`）を切るより
    # 空白1つを詰めるほうが、画面としての意味を保てる
    while over > 0:
        index = text.rfind(" ", 0, len(text) - 1)
        if index < 0:
            break
        text = text[:index] + text[index + 1 :]
        over -= 1
    if over <= 0:
        return text

    out: list[str] = []
    used = 0
    for ch in text:
        step = display_width(ch)
        if used + step > width:
            break
        out.append(ch)
        used += step
    return "".join(out) + " " * (width - used)


def sanitize_screen(path: Path, rules: list[tuple[str, str]]) -> int:
    """画面の写しは、**行の幅を保ったまま**直す。

    利用者名を長い置換先へ替えると行が伸びる。実際 `welcome.txt` は
    **45桁で採ったのに55桁**あった（広いほうも 120 → 130）。

    **幅を固定するために置いたフィクスチャの、幅が嘘になっている**のが問題で、
    折り返しに関わる後退（`joinWrapped` / `visibleLines`）をここでは捕まえられない。

    行ごとに元の幅を控え、置換のあとで切るか空白で埋めて元へ戻す。
    """
    original = path.read_text(encoding="utf-8", errors="surrogateescape")
    lines = original.split("\n")
    fixed: list[str] = []
    for line in lines:
        width = display_width(line)
        text = line
        for old, new in rules:
            text = text.replace(old, new)
        text = redact_emails(text)
        # **空の行は空のまま。** 幅0へ埋めても何も起きないが、意図を明示しておく
        fixed.append(fit_width(text, width) if width else text)
    text = "\n".join(fixed)
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
        # 綴りが決まっているものは、種別によらず落とす（端末録画にも入りうる）
        for forbidden in FORBIDDEN_SUBSTRINGS:
            if forbidden in text:
                leaks.append(f"{path}: 伏せ損ねた綴り {forbidden!r}")
    return leaks


def find_origin_leaks(root: Path) -> list[str]:
    """他セッションからの連絡が伏せ切れていないかを、機械で見る最後の網。

    採取は使い捨てのディレクトリで行うので連絡が来る確率は低いが、**来たら丸ごと
    公開される**。人が目で見て気づく形にしておかない（`人が打っていないものを、
    人の発言として出さない` 設計§7-3）。
    """
    leaks: list[str] = []
    for path in sorted(root.rglob("*.jsonl")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if not stripped:
                continue
            for forbidden in FORBIDDEN_SUBSTRINGS:
                if forbidden in stripped:
                    leaks.append(f"{path}:{number}: 伏せ損ねた綴り {forbidden!r}")
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict) or record.get("type") != "user":
                continue
            origin = record.get("origin")
            if not isinstance(origin, dict):
                continue
            for key in PEER_ORIGIN_DROP_KEYS:
                value = origin.get(key)
                if value is not None and value != REDACTION_NOTE:
                    leaks.append(f"{path}:{number}: origin.{key} が残っています")
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
    """端末録画を「つなぎ直した状態」と「エスケープを落とした状態」で検査する。

    画面のゴールデン（`.screen`）も同じ検査に掛ける。中身は録画から作った**描画済みの
    画面**で、エスケープシーケンスが文字列の途中に挟まる点は録画と同じだからである。
    通常の残存検査（[`find_leaks`]）は素のまま見るので、そちらだけでは
    「カーソル移動で分断された名前」を見落とす。
    """
    leaks: list[str] = []
    for path in sorted(root.rglob("*.cast")) + sorted(root.rglob("*.screen")):
        joined = (
            assemble_cast(path)
            if path.suffix == ".cast"
            else path.read_text(encoding="utf-8", errors="surrogateescape")
        )
        plain = ANSI_PATTERN.sub("", joined)
        for view, text in (("連結", joined), ("エスケープ除去後", plain)):
            for old, new in rules:
                if old and old in text:
                    leaks.append(f"{path}（{view}）: {describe(old, new, secrets)}")
            for found in sorted(set(EMAIL_PATTERN.findall(text))):
                if not is_example_address(found):
                    leaks.append(f"{path}（{view}）: メールアドレスらしき文字列 {found!r}")
            for forbidden in FORBIDDEN_SUBSTRINGS:
                if forbidden in text:
                    leaks.append(f"{path}（{view}）: 伏せ損ねた綴り {forbidden!r}")
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
    print(f"環境情報を持つレコード（attachment / system / 他セッションの連絡）を {redacted_total} 件除去")

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
        elif is_screen(path):
            changed += sanitize_screen(path, rules)
        else:
            changed += sanitize_file(path, rules)

    print(f"走査 {scanned} ファイル / 置換 {changed} ファイル")

    leaks = (
        find_leaks(root, rules, secrets)
        + find_cast_leaks(root, rules, secrets)
        + find_origin_leaks(root)
    )
    if leaks:
        print("機微情報が残っています:", file=sys.stderr)
        for leak in leaks:
            print(f"  {leak}", file=sys.stderr)
        return 1

    print("機微情報の残存なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
