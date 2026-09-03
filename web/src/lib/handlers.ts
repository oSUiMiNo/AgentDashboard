/**
 * 同じ合図を見る複数のハンドラを、順番を決めて重ねる。
 *
 * React は1つの prop に1つの関数しか置けないが、**押し分け（`usePress`）と掴み
 * （`useGrip`）は同じ `pointerdown` を見る**。片方だけを付けると、もう片方が死ぬ。
 *
 * **順番は呼び元が決める。** この道具は並べるだけで、何も判断しない。
 */
export function 重ねる<E>(
  ...列: (((event: E) => void) | undefined)[]
): (event: E) => void {
  return (event: E) => {
    for (const 手 of 列) {
      手?.(event)
    }
  }
}
