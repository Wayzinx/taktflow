import { forEachRoleSelector, selectHarness, validateHarnessSelector, type WorkflowDefinition } from '@taktflow/core'
import type { ProjectContext } from './project.js'

export function validateRuntimeWorkflow(context: ProjectContext, workflow: WorkflowDefinition): void {
  const selectors = { config: context.stores.config, profiles: context.profiles, harnesses: context.harnesses }
  forEachRoleSelector(workflow, (role, selector) => {
    validateHarnessSelector(selectHarness(role, selector, selectors), context.stores.config, context.harnesses)
  })
}

export function validateRuntime(context: ProjectContext): void {
  for (const selector of [...Object.values(context.stores.config.roles ?? {}), ...Object.values(context.profiles).map((profile) => profile.harness)]) {
    validateHarnessSelector(selector, context.stores.config, context.harnesses)
  }
  for (const workflow of context.workflows) validateRuntimeWorkflow(context, workflow)
}
