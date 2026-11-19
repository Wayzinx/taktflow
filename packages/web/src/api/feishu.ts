export interface FeishuMemberMapping {
  openId: string
  memberId: string
}

export interface FeishuBinding {
  chatId: string
  members: FeishuMemberMapping[]
  revision: string
}

export interface FeishuBindingStatus {
  configured: boolean
  binding: FeishuBinding | null
}

export type FeishuBindingUpdate =
  | { chatId: string; members: FeishuMemberMapping[]; baseRevision: string | null }
  | { chatId: null; baseRevision: string | null }

export interface FeishuSource {
  feishuBinding(): Promise<FeishuBindingStatus>
  setFeishuBinding(update: FeishuBindingUpdate): Promise<FeishuBindingStatus>
}
