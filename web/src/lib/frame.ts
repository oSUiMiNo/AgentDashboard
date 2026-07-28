/**
 * PTY のバイト列を運ぶバイナリフレーム（設計§4）。
 *
 * レイアウトは `[1B kind][16B card_id][payload]`。Rust 側の
 * `crates/protocol/src/frame.rs` と同じ形を組み立て・分解する。
 *
 * JSON に包んで base64 にしないのは、4/3 に膨らむうえエンコードとデコードで CPU を
 * 食うため。ヘッダを固定長にしているので、先頭 17 バイトを見るだけで宛先が分かり、
 * payload はコピーせずそのまま端末へ渡せる。
 */

import type { CardId } from './protocol'

/** S→C：PTY の出力。受け取った端末はそのまま書き足す。 */
export const KIND_PTY_OUTPUT = 0x01
/** C→S：PTY への入力（端末のキー入力）。 */
export const KIND_PTY_INPUT = 0x02
/** S→C：PTY のスナップショット。受け取った端末は画面をリセットしてから書く。 */
export const KIND_PTY_SNAPSHOT = 0x03

/** kind バイト + card_id の固定長ヘッダの長さ。 */
export const FRAME_HEADER_LENGTH = 17

export interface DecodedFrame {
  kind: number
  cardId: CardId
  payload: Uint8Array<ArrayBuffer>
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** UUID の文字列を 16 バイトへ変換する。 */
export function uuidToBytes(uuid: string): Uint8Array<ArrayBuffer> {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`UUID の形式ではありません: ${uuid}`)
  }
  const hex = uuid.replace(/-/g, '')
  const bytes = new Uint8Array(16)
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** 16 バイトを UUID の文字列へ変換する。 */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error(`UUID は 16 バイト必要です: ${bytes.length} バイト`)
  }
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/** フレームを組み立てる。 */
export function encodeFrame(
  kind: number,
  cardId: CardId,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(FRAME_HEADER_LENGTH + payload.length)
  frame[0] = kind
  frame.set(uuidToBytes(cardId), 1)
  frame.set(payload, FRAME_HEADER_LENGTH)
  return frame
}

/**
 * フレームを分解する。
 *
 * payload は受信したバッファを参照するだけ（`subarray`）でコピーしない。xterm.js へは
 * そのまま渡せるため、高頻度の出力でも余計な確保が起きない。
 */
export function decodeFrame(buffer: ArrayBuffer): DecodedFrame {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < FRAME_HEADER_LENGTH) {
    throw new Error(
      `フレームが短すぎます（${bytes.length} バイト。ヘッダに ${FRAME_HEADER_LENGTH} バイト必要）`,
    )
  }
  const kind = bytes[0]
  if (
    kind !== KIND_PTY_OUTPUT &&
    kind !== KIND_PTY_INPUT &&
    kind !== KIND_PTY_SNAPSHOT
  ) {
    throw new Error(`未知のフレーム種別です: 0x${kind.toString(16).padStart(2, '0')}`)
  }
  return {
    kind,
    cardId: bytesToUuid(bytes.subarray(1, FRAME_HEADER_LENGTH)),
    payload: bytes.subarray(FRAME_HEADER_LENGTH),
  }
}
