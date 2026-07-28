import { render, screen } from '@testing-library/react'
import App from './App'

// テスト基盤（Vitest + Testing Library + jsdom）が実際に動くことの確認。
// フェーズ0の時点では画面の中身より「テストが書けて走る状態になっていること」が目的。
describe('App', () => {
  it('土台の画面が描画され shadcn/ui のボタンが出る', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'AgentDashboard' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '準備OK' })).toBeInTheDocument()
  })
})
