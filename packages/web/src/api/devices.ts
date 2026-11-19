export interface SpaceDevice {
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

export interface DeviceLinkRequest {
  nodeId: string
  harness: 'codex'
}

export interface DeviceLink extends DeviceLinkRequest {
  code: string
  expiresAt: string
}
