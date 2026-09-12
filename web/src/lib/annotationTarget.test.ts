import { describe, expect, it } from 'vitest'

import { GLOBAL_TARGET, sessionTarget, targetKey } from '@/lib/annotationTarget'

/*
  **綴りそのものを固定する。**

  この鍵は2箇所（手元の一覧と、書きかけの予約鍵）で使われる。**綴りが割れても
  型では何も落ちない**——どちらも文字列なので、`session:<id>` と `<id>` を取り違えても
  コンパイラは黙る。だからここで綴りを1つに縛る。

  **宛先が増えたときに落ちるのは `tsc` の仕事**（`targetKey` の `assertNever`）で、
  こちらの担当ではない。ここが守るのは「いまある2つの綴りが変わらないこと」だけである。
*/
describe('targetKey', () => {
  it('全体は global', () => {
    expect(targetKey(GLOBAL_TARGET)).toBe('global')
  })

  it('セッションは session: の後ろにIDが付く', () => {
    expect(targetKey(sessionTarget('abc-123'))).toBe('session:abc-123')
  })

  it('別のセッションは別の鍵になる', () => {
    expect(targetKey(sessionTarget('a'))).not.toBe(targetKey(sessionTarget('b')))
  })

  /*
    **全体の鍵が、カードのID と衝突しないこと。**

    書きかけの表は内側の鍵にカードのID（UUID）を使っている。そこへ `global` を
    予約鍵として混ぜるので、**UUID の形に見えないことが前提**になっている。

    UUID は 8-4-4-4-12 の形なので `global` とは重ならないが、**それを言葉で
    確かめるのではなく形で確かめる**——次に鍵の綴りを変える人が、ここで気づく。
  */
  it('全体の鍵は UUID の形をしていない（カードのID と衝突しない）', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect(uuid.test(targetKey(GLOBAL_TARGET))).toBe(false)
  })
})
