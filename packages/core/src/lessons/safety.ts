export function safeLessonText(title: string, body: string): boolean {
  const text = `${title}\n${body}`
  return !(/跳过\s*(?:验证|测试|校验)|绕过|无需\s*(?:测试|验证)|bypass|skip[\s_-]+(?:verification|tests?|validation)|(?:修改|更改|禁用|删除)\s*(?:workflow|工作流|门禁)/i.test(text))
}
