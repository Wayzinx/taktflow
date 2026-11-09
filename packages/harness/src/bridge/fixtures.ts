// 按本机 CLI 抓包形态手写；提示、工具描述、设备信息均为合成占位。
export const claudeRequest = {
  model: 'test', stream: true, max_tokens: 4096,
  system: [{ type: 'text', text: '系统占位', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: '读取文件' }] }, { role: 'system', content: '中途系统占位' }],
  tools: [{ name: 'Read', description: '工具占位', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
  metadata: { user_id: 'fake-user' }, thinking: { type: 'adaptive' }, context_management: { edits: [] }, output_config: { effort: 'high' },
}
export const codexRequest = {
  model: 'test', stream: true, instructions: '系统占位', input: [
    { type: 'message', id: 'm1', role: 'developer', content: [{ type: 'input_text', text: '开发指令' }] },
    { type: 'message', id: 'm2', role: 'user', content: [{ type: 'input_text', text: '读取文件' }] },
  ], tools: [{ type: 'namespace', name: 'mcp', description: '命名空间', tools: [{ type: 'function', name: 'Read', description: '工具占位', strict: false, parameters: { type: 'object', properties: { path: { type: 'string' } } } }] }, { type: 'web_search', external_web_access: true }],
  tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: 'high' }, store: false, include: ['reasoning.encrypted_content'], prompt_cache_key: 'fake-cache', client_metadata: { client: 'fake' },
}
export const traeRequest = {
  ...codexRequest, tools: [{ type: 'custom', name: 'exec', description: '工具占位', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }],
}
