import { execFile } from 'node:child_process'
import path from 'node:path'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(cmd: string, args: string[], timeoutMs = 120000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer'
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0,
          stdout: decode(stdout),
          stderr: decode(stderr)
        })
      }
    )
  })
}

/**
 * 优先使用 UTF-8 解码，失败时退回系统本地编码（中文 Windows 的 GBK）。
 */
function decode(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf
  if (!buf || buf.length === 0) return ''
  try {
    const text = buf.toString('utf8')
    // 出现替换字符说明不是 UTF-8，尝试 GBK
    if (text.includes('\uFFFD')) {
      try {
        const gbk = new TextDecoder('gbk').decode(buf)
        if (!gbk.includes('\uFFFD')) return gbk
      } catch {
        /* ignore */
      }
    }
    return text
  } catch {
    return buf.toString('utf8')
  }
}

export function powershellPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 执行 PowerShell 脚本。脚本内部把结果以 Base64(UTF-8) 输出，规避控制台编码问题。
 */
export async function runPowerShell(script: string, timeoutMs = 120000): Promise<RunResult> {
  const wrapped =
    '$ErrorActionPreference = "Stop"\n' +
    '$OutputEncoding = [System.Text.Encoding]::UTF8\n' +
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
    '$isoforgeOut = & {\n' +
    script +
    '\n}\n' +
    '$isoforgeJson = $isoforgeOut | ConvertTo-Json -Compress -Depth 12\n' +
    '[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($isoforgeJson)))\n'

  const r = await run(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
    timeoutMs
  )
  if (r.stdout.trim()) {
    try {
      r.stdout = Buffer.from(r.stdout.trim(), 'base64').toString('utf8')
    } catch {
      /* 保留原文，交由调用方处理 */
    }
  }
  return r
}
