export interface ComputerDetails {
  displayName: string
  platform: 'mac' | 'linux'
}

export interface SpaceDevice extends Partial<ComputerDetails> {
  nodeId: string
  harness: string
  source: 'env' | 'link'
  status: 'pending' | 'offline' | 'online'
  lastSeenAt?: string
  jobId?: string
  expiresAt?: string
}

export interface SpaceDevices {
  spaceId: string
  devices: SpaceDevice[]
}

export type DeviceLinkRequest = (ComputerDetails & { harness?: 'codex' }) | { nodeId: string; harness: 'codex' }

export interface DeviceLink extends Partial<ComputerDetails> {
  nodeId: string
  harness: 'codex'
  code: string
  expiresAt: string
}
