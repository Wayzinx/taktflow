import { parseCliArgs } from './args.js'
import { runLinkCommand } from './link.js'

const usage = '用法：node taktflow-link.mjs --hub URL --space ID --node ID [--project DIR] [--relink]\n在目标项目目录运行；首次连接时按提示输入配对码。'
try {
  const cli = parseCliArgs(['link', ...process.argv.slice(2)])
  if (cli.options.help) console.log(usage)
  else {
    cli.options.project ??= process.cwd()
    process.exitCode = await runLinkCommand(cli)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '连接 Hub 失败')
  process.exitCode = 1
}
