import { Button } from '@/components/ui/button'

// フェーズ0の土台確認用の画面。Tailwind v4 と shadcn/ui が実際に効いていることを
// 目視とテストの両方で確かめられる最小構成にしてある。
// 一覧画面（TileGrid / ProjectGroup / SessionTile）はフェーズ2で作る。
function App() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">AgentDashboard</h1>
      <p className="text-muted-foreground text-sm">
        フェーズ0：土台のみ。セッション一覧はフェーズ2で実装します。
      </p>
      <Button>準備OK</Button>
    </main>
  )
}

export default App
