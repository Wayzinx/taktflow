export function extractTraceIds(text: string): string[] {
  return [...new Set(text.match(/\b(?:REQ-\d+|AC-\d+(?:-\d+)?|TC-[A-Z0-9-]+)\b/g) ?? [])]
}
