import {
  FRAME_HEADER_LENGTH,
  KIND_PTY_INPUT,
  KIND_PTY_OUTPUT,
  KIND_PTY_SNAPSHOT,
  bytesToUuid,
  decodeFrame,
  encodeFrame,
  uuidToBytes,
} from './frame'

const CARD_ID = '11111111-2222-3333-4444-555555555555'

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer
}

describe('UUID とバイト列の変換', () => {
  it('往復しても同じ値になる', () => {
    expect(bytesToUuid(uuidToBytes(CARD_ID))).toBe(CARD_ID)
  })

  it('16バイトの並びは UUID の見た目どおりになる', () => {
    // Rust 側は uuid::as_bytes() をそのまま書き込む。並びが違うと宛先を取り違える
    expect(Array.from(uuidToBytes(CARD_ID).slice(0, 4))).toEqual([
      0x11, 0x11, 0x11, 0x11,
    ])
    expect(Array.from(uuidToBytes(CARD_ID).slice(12, 16))).toEqual([
      0x55, 0x55, 0x55, 0x55,
    ])
  })

  it('UUID でない文字列は受け付けない', () => {
    expect(() => uuidToBytes('not-a-uuid')).toThrow()
  })

  it('16バイト以外は受け付けない', () => {
    expect(() => bytesToUuid(new Uint8Array(8))).toThrow()
  })
})

describe('バイナリフレーム', () => {
  it('組み立てたフレームを分解すると元に戻る', () => {
    const payload = new TextEncoder().encode('[32mhello[0m')
    const frame = encodeFrame(KIND_PTY_OUTPUT, CARD_ID, payload)

    expect(frame.length).toBe(FRAME_HEADER_LENGTH + payload.length)

    const decoded = decodeFrame(toBuffer(frame))
    expect(decoded.kind).toBe(KIND_PTY_OUTPUT)
    expect(decoded.cardId).toBe(CARD_ID)
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload))
  })

  it('ヘッダは 1 バイトの種別と 16 バイトのカードIDでできている', () => {
    // Rust 側の crates/protocol/src/frame.rs と同じ並びであることの確認
    const frame = encodeFrame(KIND_PTY_INPUT, CARD_ID, new Uint8Array([0x61]))
    expect(frame[0]).toBe(0x02)
    expect(Array.from(frame.slice(1, 17))).toEqual(Array.from(uuidToBytes(CARD_ID)))
    expect(frame[17]).toBe(0x61)
  })

  it('payload が空でも成立する', () => {
    const frame = encodeFrame(KIND_PTY_SNAPSHOT, CARD_ID, new Uint8Array())
    expect(frame.length).toBe(FRAME_HEADER_LENGTH)

    const decoded = decodeFrame(toBuffer(frame))
    expect(decoded.kind).toBe(KIND_PTY_SNAPSHOT)
    expect(decoded.payload.length).toBe(0)
  })

  it('payload にヘッダと紛らわしいバイトが入っていても壊れない', () => {
    const payload = new Uint8Array(64).fill(KIND_PTY_SNAPSHOT)
    const decoded = decodeFrame(
      toBuffer(encodeFrame(KIND_PTY_OUTPUT, CARD_ID, payload)),
    )
    expect(decoded.kind).toBe(KIND_PTY_OUTPUT)
    expect(decoded.payload.length).toBe(64)
  })

  it('ヘッダに足りない長さは拒否する', () => {
    for (let length = 0; length < FRAME_HEADER_LENGTH; length += 1) {
      expect(() => decodeFrame(toBuffer(new Uint8Array(length)))).toThrow(
        /短すぎます/,
      )
    }
    // ちょうどヘッダ長なら成立する（境界）
    const header = encodeFrame(KIND_PTY_OUTPUT, CARD_ID, new Uint8Array())
    expect(() => decodeFrame(toBuffer(header))).not.toThrow()
  })

  it('未知の種別は拒否する', () => {
    const frame = encodeFrame(KIND_PTY_OUTPUT, CARD_ID, new Uint8Array([1]))
    frame[0] = 0x7f
    expect(() => decodeFrame(toBuffer(frame))).toThrow(/未知のフレーム種別/)
  })

  it('分解した payload は元のバッファを参照するだけでコピーしない', () => {
    // 高頻度の出力でも余計な確保が起きないことが前提の実装になっている
    const frame = encodeFrame(KIND_PTY_OUTPUT, CARD_ID, new Uint8Array([1, 2, 3]))
    const buffer = toBuffer(frame)
    const decoded = decodeFrame(buffer)
    expect(decoded.payload.buffer).toBe(buffer)
  })
})
