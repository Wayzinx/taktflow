// ux-audit 测试夹具：不应报任何问题
export function Ok() {
  // ux-audit: ok 下拉选项，不单独成区
  const opts = useAsync((ds) => ds.items(), [])
  return (
    <div>
      <input placeholder="加载中" />
      <p>需要在 takt.config.json 里配置模型</p>
      <button type="button">让管家帮我改</button>
      {opts.data?.map((x) => <option key={x}>{x}</option>)}
    </div>
  )
}
declare function useAsync<T>(fn: (ds: { items(): Promise<T> }) => Promise<T>, deps: unknown[]): { data?: T }
