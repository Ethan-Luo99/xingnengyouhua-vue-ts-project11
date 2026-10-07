// 仅用于自测：让 Node ESM 解析项目源码中的无扩展名 / .ts 导入。
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const base = context.parentURL ?? pathToFileURL(process.cwd() + '/').href
    const candidateBase = new URL(specifier, base)
    const path = fileURLToPath(candidateBase)
    const candidates = []
    if (specifier.endsWith('.ts') || specifier.endsWith('.mts')) {
      candidates.push(path)
    } else {
      candidates.push(`${path}.ts`, `${path}.mts`, `${path}/index.ts`)
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
  }
  return nextResolve(specifier, context)
}
