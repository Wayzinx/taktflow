import type { KnowledgeSource } from '@taktflow/core'

export function createCodeGraphSource(): KnowledgeSource {
  return {
    id: 'codegraph', kind: 'codegraph', intents: ['impact'],
    describe: () => 'M1 实现：接入外部 CodeGraph 服务或本地代码索引，查询符号调用链、依赖和影响面；当前返回空结果。',
    query: async () => [],
  }
}

export function createDatabaseSource(): KnowledgeSource {
  return {
    id: 'database', kind: 'database', intents: ['schema'],
    describe: () => 'M1 实现：配置数据库只读连接，从元数据目录查询表结构、字段注释及业务口径；当前返回空结果。',
    query: async () => [],
  }
}

export function createApiRegistrySource(): KnowledgeSource {
  return {
    id: 'api-registry', kind: 'api-registry', intents: ['fact'],
    describe: () => 'M1 实现：接入 OpenAPI 或接口平台注册信息，并连接实时接口查询配置取值，记录取证时间；当前返回空结果。',
    query: async () => [],
  }
}
