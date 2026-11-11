/** 去掉 [n] 引用，连同只包着引用的括号（「已交付（[1]）」→「已交付」）：复制、会话列表摘要用。 */
export const stripCitations = (text: string) => text.replace(/\s*[（(]\s*(?:\[\d+\][\s,，、]*)+[）)]/g, '').replace(/\[\d+\]/g, '')
