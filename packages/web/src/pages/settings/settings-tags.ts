/** 标签输入的切分规则：默认按逗号；命令类字段只按回车，整条保留空格和逗号。 */
export function splitTagDraft(draft: string, split: 'comma' | 'enter'): string[] {
  return split === 'comma' ? draft.split(/[,，]/) : [draft]
}
