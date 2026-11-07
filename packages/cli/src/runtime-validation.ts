import { forEachRoleSelector, selectHarness, validateHarnessSelector, type WorkflowDefinition } from '@taktflow/core'
import type { ProjectContext } from './project.js'

export function validateRuntimeWorkflow(context: ProjectContext, workflow: WorkflowDefinition): void {
  const selectors = { config: context.stores.config, profiles: context.profiles, harnesses: context.harnesses }
  forEachRoleSelector(workflow, (role, selector) => {
    validateHarnessSelector(selectHarness(role, selector, selectors), context.stores.config, context.harnesses)
  })
}

export function validateRuntime(context: ProjectContext, warn?: (message: string) => void): void {
  if (warn) {
    for (const [role, profile] of Object.entries(context.profiles)) {
      try { validateHarnessSelector(profile.harness, context.stores.config, context.harnesses) }
      catch (error) {
        delete context.profiles[role]
        warn(`跳过角色 ${role}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const workflow of context.workflows) {
      try { validateRuntimeWorkflow(context, workflow) }
      catch (error) { warn(`流程 ${workflow.id} 暂不可运行：${error instanceof Error ? error.message : String(error)}`) }
    }
    return
  }
  for (const selector of [...Object.values(context.stores.config.roles ?? {}), ...Object.values(context.profiles).map((profile) => profile.harness)]) {
    validateHarnessSelector(selector, context.stores.config, context.harnesses)
  }
  for (const workflow of context.workflows) validateRuntimeWorkflow(context, workflow)
}
