/**
 * サイドバーの切り替えボタン（設計§3。テスト計画フェーズ6）。
 *
 * **印が☰でなくなったことを、ここで押さえる。** 印は見た目なので普段はテストの対象に
 * しないが、これは**戻っても画面が壊れない**——☰ に戻しても押せるし開くので、E2E も
 * 単体も緑のまま通ってしまう。**気づけるのは、字で見張っているときだけ。**
 */

import { render, screen } from "@testing-library/react";
import { FilesToggle } from "@/components/ProjectFiles/FilesToggle";

function 置く(open = false) {
  const pressed: string[] = [];
  const { unmount } = render(
    <FilesToggle open={open} onToggle={() => pressed.push("toggle")} />,
  );
  return {
    pressed,
    unmount,
    button: screen.getByTestId("project-files-toggle"),
  };
}

it("印は文字ではなく図形で描いてある", () => {
  const { button } = 置く();

  // `DESIGN.md` §14.4（正式UIに文字の記号・絵文字を使わない）
  expect(button.querySelector("svg")).not.toBeNull();
  expect(button.textContent).toBe("");
});

it("☰ は、もう出てこない", () => {
  const { button } = 置く();

  // **印だけを名指しで見る。** 「文字が無い」だけだと、別の記号へ替えても通る
  expect(button.innerHTML).not.toContain("☰");
});

it("読み上げ名は「サイドバー」", () => {
  const { button } = 置く();

  expect(button).toHaveAttribute("aria-label", "サイドバー");
  expect(button).toHaveAttribute("title", "サイドバー");
});

it("開いていても閉じていても、印は同じ", () => {
  const { button: 閉, unmount } = 置く(false);
  const 閉じた印 = 閉.innerHTML;
  const 閉じたときの状態 = 閉.getAttribute("aria-expanded");
  // **片付けてから置き直す。** 同じ器へ2回描くと、目印が2つになって掴めなくなる
  unmount();

  const { button: 開 } = 置く(true);

  /*
    **状態は `aria-expanded` が持つ。** 押す前に形が変わると、何を押すことになるのか
    分からなくなる（`FilesToggle.tsx` の JSDoc）
  */
  expect(開.innerHTML).toBe(閉じた印);
  expect(開).toHaveAttribute("aria-expanded", "true");
  expect(閉じたときの状態).toBe("false");
});

/**
 * 1.5倍にした（要件8・細かい修正 設計§2-3・§8-1）。
 *
 * **器だけを大きくすると、絵が中で泳ぐ。** `icon-xl` は器と絵の比を `icon`（32/16）と
 * 揃えてあるので、**両方が同じ倍率で伸びる**。ここを個別の `className` で当て直すと、
 * 次に同じ大きさが要るときにまた書くことになる。
 */
it("器は 48px の段を使う（個別に上書きしていない）", () => {
  const { button } = 置く();

  // `size-12` = 48px。**32px の `size-8` に戻ると落ちる**
  expect(button.className).toContain("size-12");
  expect(button.className).not.toContain("size-8");
});

it("絵も一緒に 1.5倍になる（24px）", () => {
  const { button } = 置く();

  /*
    **線の太さの根拠は、ここで作り直した。** 32px の器に 16px で描いていたころは
    実効 1.3px 前後で「本文の太さと揃う」と言えたが、48px に 24px で描くと実効 2px に
    なる。**器・絵・線がそろって 1.5倍になる**のが要件の言う「1.5倍」である。
  */
  expect(button.className).toContain("[&_svg:not([class*='size-'])]:size-6");
  // 呼ぶ側が大きさを当てていないこと（当てるとボタン側の段が効かなくなる）
  expect(button.querySelector("svg")?.getAttribute("class")).toBeNull();
});
