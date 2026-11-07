// ux-audit 测试夹具：每一类违规各一处（不参与构建）
export function Bad({ q }: { q: { data?: string[] } }) {
  const list = useAsync((ds) => ds.items(), [])
  return (
    <div>
      <p>加载中</p>
      <p>请修改 takt.config.json 后重启</p>
      {list.data?.map((x) => <span key={x}>{x}</span>)}
      {q.data}
    </div>
  )
}
declare function useAsync<T>(fn: (ds: { items(): Promise<T> }) => Promise<T>, deps: unknown[]): { data?: T }
