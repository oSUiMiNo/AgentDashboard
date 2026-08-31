import { describe, expect, it } from 'vitest'

import { backTargetFor } from './routes'

/**
 * 設計§7「✕（閉じる）」の判定。
 *
 * **いちばん困る壊れ方は「閉じるつもりでアプリの外へ出る」**なので、そこを名指しで
 * 見る（テスト計画フェーズ2）。
 */
describe('✕ を押したときの行き先', () => {
  it('このアプリの中で移ってきたら、1つ戻ると答える', () => {
    // react-router は移ったあとのエントリにランダムな鍵を振る（フェーズ1の実測）
    expect(backTargetFor('5kohd600')).toBe('back')
  })

  it('最初のエントリなら、一覧へ落ちると答える', () => {
    expect(backTargetFor('default')).toBe('home')
  })

  it('いきなり開いた（リロードした）ときに、アプリの外へ出る答えを返さない', () => {
    // **ここが本番の壊れ方。** リロードするとルータは作り直されるので、
    // 移ってきた履歴があっても鍵は `default` に戻る（フェーズ1の実測）
    expect(backTargetFor('default')).not.toBe('back')
  })

  it('判定を「履歴の件数」へ壊すと、外へ出る答えが返る', () => {
    // **これを見ておかないと、件数で書き直されたときに誰も気づけない。**
    //
    // 実測（フェーズ1）：いきなり `/s/:id` を開いた状態でも `history.length` は 2 を返す。
    // 別のサイトを見ていたぶんが数に入るためで、**戻る先が無いのに「戻れる」と答える**
    const 壊れた判定 = (historyLength: number) =>
      historyLength > 1 ? 'back' : 'home'

    const いきなり開いた = { key: 'default', historyLength: 2 }
    expect(backTargetFor(いきなり開いた.key)).toBe('home')
    expect(壊れた判定(いきなり開いた.historyLength)).toBe('back')
  })
})
