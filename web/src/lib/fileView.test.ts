import { formatLimit, optionText, warningsFor, type FileViewWarning } from './fileView'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
/** Rust の `WARN_FROM_BYTES`。**試験の中の写し**（製品コードは写さず、サーバの値を受け取る） */
const WARN_FROM = 5 * MIB

/**
 * 警告の規則（テスト計画フェーズ6「TS 側の見本の表が Rust と同じ」）。
 *
 * **Rust 側（`server/crates/server-core/src/file_view.rs` の `警告の規則の見本の表`）と同じ9行。**
 * `warnFrom` は Rust の `FileViewPolicy::warn_from` と同じ導き方（サーバかクラウドのときだけ
 * 5 MiB、どちらでもなければ null）で行ごとに組む。
 */
describe('warningsFor', () => {
  const table: [number, number, boolean, boolean, FileViewWarning[], string][] = [
    [5 * MIB, 3 * MIB, true, false, ['server'], 'サーバ'],
    [5 * MIB, 3 * MIB, true, true, ['server', 'cloud'], 'サーバとクラウド'],
    [5 * MIB, 3 * MIB, false, true, ['cloud'], 'クラウドだけ'],
    [5 * MIB, 3 * MIB, false, false, [], 'どちらでもない'],
    [3 * MIB, MIB, true, true, [], '5 MiB 未満は出さない'],
    [10 * MIB, 20 * MIB, true, true, [], '下げるときは出さない'],
    [5 * MIB, 5 * MIB, true, true, [], '同じ値＝上げていない'],
    [20 * GIB, 3 * MIB, true, true, ['server', 'cloud'], 'いちばん大きい値'],
    [5 * GIB, 3 * MIB, false, false, [], 'ローカル・クラウド無し'],
  ]
  it.each(table)(
    '%d を %d から（サーバ=%s・クラウド=%s）→ %j（%s）',
    (value, current, viaServer, metered, expected) => {
      const warnFrom = viaServer || metered ? WARN_FROM : null
      expect(warningsFor(value, current, warnFrom, viaServer, metered)).toEqual(expected)
    },
  )
})

describe('formatLimit', () => {
  it.each([
    [3_145_728, '3 MB'],
    [33_554_432, '32 MB'],
    [8_388_608, '8 MB'],
    [5_368_709_120, '5 GB'],
    [5_062_904, '4.8 MB'],
    [2_560, '3 KB'],
    [0, '0 B'],
  ])('%d バイトは %s（「.0」だけを落とす）', (bytes, want) => {
    expect(formatLimit(bytes)).toBe(want)
  })
})

describe('optionText', () => {
  it('既定の選択肢にだけ「・既定」が付き、バイト数は3桁区切り', () => {
    const three = { bytes: 3 * MIB, label: '3 MB' }
    expect(optionText(three, 3 * MIB)).toBe('3 MB（3,145,728 バイト）・既定')
    expect(optionText(three, 5 * GIB)).toBe('3 MB（3,145,728 バイト）')
    expect(optionText({ bytes: 20 * GIB, label: '20 GB' }, 3 * MIB)).toBe(
      '20 GB（21,474,836,480 バイト）',
    )
  })
})
