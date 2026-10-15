/**
 * U 盘急救修复（Windows 原生调用 assets/repair.ps1）。
 *
 * 为什么单独走一个脚本、而不复用「非可引导格式化」那条路：
 *   刻录失败后的 U 盘常常**连 Get-Disk 都列不出来**（未知容量 / RAW / 无盘符 /
 *   「没有媒体」），而程序里的磁盘列表正是靠 Get-Disk 出来的 —— 盘都列不出来，
 *   UI 上就选不到它。修复脚本直接扫描 \\.\PhysicalDrive0..15，
 *   即使磁盘管理器里完全看不到，也能把它找出来，再用 DeviceIoControl
 *   清只读属性、刷新磁盘几何（修「0 字节 / 未初始化」）、把盘头写零抹掉
 *   ISO9660 / UDF / 损坏 GPT 的残留签名，最后才交给 diskpart 重建分区表并格式化。
 *
 * 与 burn.ps1 同一套协议：结果通过 -LogFile 的 JSONL 文件回传，
 * 避免 PowerShell stdout 在中文环境下的编码问题（exec.ts 里踩过）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { powershellPath } from './exec'
import type { RepairDiskInfo } from '@shared/types'

/** repair.ps1 -List 报上来的一块物理盘（结构定义在 shared/types.ts，渲染层也要用） */
export type RepairDisk = RepairDiskInfo

export interface RepairHooks {
  onLog: (text: string, level: 'info' | 'warn' | 'error' | 'success') => void
  /** 深度扫描用不上进度回报，标成可选 */
  onTick?: (percent: number) => void
}

export interface RepairOutcome {
  ok: boolean
  /** 修复后拿到的盘符（逗号分隔）；为空说明没拿到盘符 */
  letters: string
  fs: string
}

function logDir(): string {
  const base = process.env.LOCALAPPDATA || os.tmpdir()
  const dir = path.join(base, 'TomatoIsoBurner', 'logs')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return os.tmpdir()
  }
  return dir
}

function resolveRepairScript(): string {
  const candidates = [
    path.join(process.resourcesPath || '', 'repair.ps1'),
    path.join(__dirname, '..', '..', 'assets', 'repair.ps1'),
    path.join(__dirname, '..', 'assets', 'repair.ps1'),
    path.resolve(process.cwd(), 'assets', 'repair.ps1')
  ]
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  throw new Error('找不到 repair.ps1 修复脚本，请确认安装完整')
}

/** 解析一行 JSONL（返回 null 表示这行不用管） */
function parseLine(line: string): Record<string, unknown> | null {
  const clean = line.replace(/^\uFEFF/, '').trim()
  if (!clean) return null
  try {
    const o = JSON.parse(clean) as Record<string, unknown>
    return o && typeof o === 'object' ? o : null
  } catch {
    // 非 JSON 行忽略（安全冗余）
    return null
  }
}

/**
 * 列出本机所有物理磁盘（含系统认不出的「隐身盘」）。
 *
 * 用于「深度扫描」：把 Get-Disk 列不出、但确实存在的盘补进界面列表，
 * 这样刻录失败后变成「未知容量 / 无盘符」的 U 盘也能被选中修复。
 */
export async function listRepairDisks(hooks?: RepairHooks): Promise<RepairDisk[]> {
  const script = resolveRepairScript()
  const logFile = path.join(logDir(), `repair-list-${process.pid}-${Date.now()}.jsonl`)
  try {
    fs.unlinkSync(logFile)
  } catch {
    /* 首次运行或文件不存在 */
  }

  await new Promise<void>((resolve) => {
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
       '-List', '-LogFile', logFile],
      { windowsHide: true }
    )
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })

  const disks: RepairDisk[] = []
  let errText = ''
  try {
    if (fs.existsSync(logFile)) {
      for (const ln of fs.readFileSync(logFile, 'utf8').split('\n')) {
        const o = parseLine(ln)
        if (!o) continue
        if (o['type'] === 'disk') {
          disks.push({
            number: Number(o['number']) || 0,
            name: String(o['name'] || ''),
            bus: String(o['bus'] || ''),
            size: Number(o['size']) || 0,
            letters: String(o['letters'] || ''),
            visible: o['visible'] !== false,
            readable: o['readable'] !== false,
            err: Number(o['err']) || 0,
            bad: o['bad'] === true
          })
        } else if (o['type'] === 'error') {
          errText = String(o['message'] || '')
        }
      }
    }
  } catch {
    /* 日志读不动就当没扫到 */
  } finally {
    try {
      fs.unlinkSync(logFile)
    } catch {
      /* ignore */
    }
  }

  if (disks.length === 0 && errText) {
    hooks?.onLog(errText, 'error')
  }
  return disks
}

/**
 * 执行修复。全程通过 JSONL 日志回报，解析规则与 windowsBurn.ts 一致：
 * ⚠️ 只消费「以换行结尾」的完整行 —— 最后一行很可能只写了一半，
 *    直接解析会失败并被永久跳过，界面上就看不到真正的错误原因。
 */
export async function runRepair(
  opts: {
    diskNumber: number
    fileSystem: string
    /** 卷标：还原完在「此电脑」里显示的名字（默认「番茄U盘」） */
    label: string
    /** 写进 U 盘根目录的番茄图标（配合 autorun.inf，让 U 盘带上自家 logo） */
    iconFile?: string
    zeroMB?: number
  },
  hooks: RepairHooks
): Promise<RepairOutcome> {
  const script = resolveRepairScript()
  const logFile = path.join(logDir(), 'repair-latest.jsonl')
  try {
    fs.unlinkSync(logFile)
  } catch {
    /* ignore */
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-DiskNumber',
    String(opts.diskNumber),
    '-FileSystem',
    opts.fileSystem.toLowerCase(),
    // 卷标经 Set-Volume 设置（支持中文）；diskpart 的 format 里不放中文 ——
    // 它的脚本文件只吃 ASCII，中文会变成问号
    '-Label',
    opts.label || '番茄U盘',
    '-IconFile',
    opts.iconFile || '',
    '-ZeroMB',
    String(opts.zeroMB ?? 32),
    '-LogFile',
    logFile,
    '-Force'
  ]

  return await new Promise<RepairOutcome>((resolve, reject) => {
    const child = spawn(powershellPath(), args, { windowsHide: true })
    let consumed = 0
    let errorMsg = ''
    let outcome: RepairOutcome | null = null

    const handleLine = (line: string): void => {
      const o = parseLine(line)
      if (!o) return
      const t = String(o['type'] || '')
      if (t === 'progress') {
        hooks.onTick?.(Number(o['percent']) || 0)
      } else if (t === 'info') {
        hooks.onLog(String(o['message'] || ''), 'info')
      } else if (t === 'warn') {
        hooks.onLog(String(o['message'] || ''), 'warn')
      } else if (t === 'error') {
        errorMsg = String(o['message'] || '未知错误')
        hooks.onLog(errorMsg, 'error')
      } else if (t === 'done') {
        outcome = {
          ok: o['ok'] !== false,
          letters: String(o['letters'] || ''),
          fs: String(o['fs'] || opts.fileSystem)
        }
      }
    }

    const consumeLog = (): void => {
      let text: string
      try {
        if (!fs.existsSync(logFile)) return
        text = fs.readFileSync(logFile, 'utf8')
      } catch {
        return
      }
      if (text.length < consumed) consumed = 0
      const chunk = text.slice(consumed)
      if (!chunk) return
      const lastNl = chunk.lastIndexOf('\n')
      if (lastNl < 0) return
      const usable = chunk.slice(0, lastNl + 1)
      consumed += usable.length
      for (const ln of usable.split('\n')) handleLine(ln)
    }

    const poll = setInterval(consumeLog, 150)

    child.on('error', (err) => {
      clearInterval(poll)
      reject(new Error(`无法启动修复进程：${err.message}`))
    })

    child.on('close', () => {
      clearInterval(poll)
      consumeLog()
      // 进程已退出，日志必然是完整行；再补一次以防末尾没有换行
      try {
        if (fs.existsSync(logFile)) {
          const text = fs.readFileSync(logFile, 'utf8')
          if (text.length > consumed) {
            for (const ln of text.slice(consumed).split('\n')) handleLine(ln)
          }
        }
      } catch {
        /* ignore */
      }
      if (outcome) resolve(outcome)
      else {
        reject(new Error(`${errorMsg || '修复进程异常结束，未返回结果'}\n\n完整日志：${logFile}`))
      }
    })
  })
}
