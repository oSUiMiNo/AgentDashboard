/**
 * **union に値を足したとき、見直すべき `switch` を `tsc` に指させる。**
 *
 * # なぜ要るのか
 *
 * この PJT は「**約束を、機械が落とす台帳にする**」規律を持っている
 * （`cli_surface.toml` ／ `swallowed.toml` ／ `dependencies.rs`）。ところが
 * TypeScript の `switch` に `default` があると、**union が増えても何も落ちない**——
 * 新しい値は黙って既定の枝へ流れる。
 *
 * 実際に踏んだ：`MachineShape` に1つ足したとき、**見直すべき `switch` が3箇所**
 * あったのに**コンパイラも既存テストも1本も落ちなかった**（コンテキストの残量
 * フェーズ6）。テストで守ることはできるが、**それは「いま足した値」しか守らない**——
 * 次に足す人は同じ穴を踏む。
 *
 * # 使い方と、なぜ `void` を返すのか
 *
 * ```ts
 * const shape = machineShapeOf(text)
 * switch (shape) {
 *   case 'history':
 *     return text
 *   default:
 *     assertNever(shape)  // ← union が増えると、ここで `tsc` が落ちる
 *     return text         // ← 実行時の倒れ方は、そのまま残る
 * }
 * ```
 *
 * **`never` を返さず `void` を返すのが要点である。** `never` にすると後続が
 * 到達不能になり、**既定の枝に置いてある「倒れ方」を書けなくなる**。この PJT の
 * 倒れ方は設計そのもの——「**読めなければ、元の字をそのまま返す。外したときに
 * 中身が消えるほうが、生のタグが出るより悪い**」（`machineMessage.ts`）——なので、
 * **型検査を足すために倒れ方を捨てるのは逆である。**
 *
 * # 効かない場所
 *
 * **入口が `string` の判定には効かない。** 例えば `machineShapeOf` は本文の字を見て
 * 型を決めるので、**分岐を足し忘れても型の上では何も起きない**。あちらは
 * 「消すと落ちるテスト」で守るしかない。
 */
export function assertNever(_value: never): void {}
