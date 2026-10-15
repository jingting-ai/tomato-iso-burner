import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { runWindowsBurn } from './windowsBurn'
import type { WriteOptions } from '@shared/types'

const CHUNK = 1024 * 1024 // 1 MiB
const SECTOR = 512 // Windows 对物理磁盘的 I/O 要求按扇区对齐

export class CancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CancelledError'
  }
}

export interface TickState {
  phase: 'write' | 'verify'
  writtenBytes: number
  totalBytes: number
  speed: number
  etaSeconds: number
  percent: number
}

export interface BurnHooks {
  onTick: (s: TickState) => void
  onLog: (text: string, level: 'info' | 'warn' | 'error' | 'success') => void
  isCancelled: () => boolean
}

export class BurnJob {
  private cancelled = false
  private lastTick = 0
  private activeWorker: Worker | null = null
  private winCache: { sourceSha256: string; verifySha256: string; bytesWritten: number } | null = null

  constructor(private readonly hooks: BurnHooks) {}

  cancel(): void {
    this.cancelled = true
    this.activeWorker?.postMessage('cancel')
  }

  private get stopped(): boolean {
    return this.cancelled || this.hooks.isCancelled()
  }

  private tick(s: TickState, force = false): void {
    const now = Date.now()
    if (!force && now - this.lastTick < 100) return
    this.lastTick = now
    this.hooks.onTick(s)
  }

  private workerPath(): string {
    // electron-vite 会把 worker 打包到 out/main/burnWorker.js
    const bundled = path.join(__dirname, 'burnWorker.js')
    // Worker 必须加载真实磁盘文件。若主进程从 asar 内运行，该文件已被 asarUnpack 到
    // app.asar.unpacked，需要把路径中的 app.asar 替换为 app.asar.unpacked。
    const unpacked = bundled.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
    return fs.existsSync(unpacked) ? unpacked : bundled
  }

  private runWorker(opts: {
    mode: 'write' | 'verify'
    imagePath: string
    devicePath: string
    deviceSize: number
    totalBytes: number
    sourceSha256?: string
  }): Promise<{ sourceSha256?: string; bytesWritten?: number; verifySha256?: string }> {
    return new Promise((resolve, reject) => {
      const workerData = {
        mode: opts.mode,
        imagePath: opts.imagePath,
        devicePath: opts.devicePath,
        chunkSize: CHUNK,
        sectorSize: SECTOR,
        deviceSize: opts.deviceSize,
        totalBytes: opts.totalBytes,
        sourceSha256: opts.sourceSha256
      }

      const workerPath = this.workerPath()
      this.hooks.onLog(`启动刻录工作线程 ${workerPath}`, 'info')

      const worker = new Worker(workerPath, { workerData })
      this.activeWorker = worker

      const cancelCheck = setInterval(() => {
        if (this.stopped) {
          worker.postMessage('cancel')
          clearInterval(cancelCheck)
        }
      }, 200)

      worker.on('message', (msg: any) => {
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'tick') {
          this.tick({
            phase: msg.phase,
            writtenBytes: msg.writtenBytes,
            totalBytes: msg.totalBytes,
            speed: msg.speed,
            etaSeconds: msg.etaSeconds,
            percent: msg.percent
          })
        } else if (msg.type === 'done') {
          clearInterval(cancelCheck)
          this.activeWorker = null
          resolve({
            sourceSha256: msg.sourceSha256,
            bytesWritten: msg.bytesWritten,
            verifySha256: msg.verifySha256
          })
          void worker.terminate().catch(() => undefined)
        } else if (msg.type === 'error') {
          clearInterval(cancelCheck)
          this.activeWorker = null
          reject(Object.assign(new Error(msg.message || '工作线程错误'), { code: msg.code || '' }))
          void worker.terminate().catch(() => undefined)
        }
      })

      worker.on('error', (err) => {
        clearInterval(cancelCheck)
        this.activeWorker = null
        reject(err)
      })

      worker.on('exit', (code) => {
        clearInterval(cancelCheck)
        this.activeWorker = null
        if (code !== 0) {
          reject(new Error(`刻录工作线程异常退出（退出码 ${code}）`))
        }
      })
    })
  }

  /** 写入镜像到目标设备，返回源文件的 SHA256 */
  async write(opts: WriteOptions): Promise<{ sourceSha256: string; bytesWritten: number }> {
    const { imagePath, device } = opts
    const total = (await fsp.stat(imagePath)).size
    const deviceSize = device.size > 0 ? device.size : Number.POSITIVE_INFINITY

    // Windows：交给 PowerShell 原生写盘（一次完成写入 + 可选校验），绕开 Node fs 的坑
    if (process.platform === 'win32') {
      const r = await runWindowsBurn(opts, {
        onLog: (t, l) => this.hooks.onLog(t, l),
        onTick: (s) => this.tick(s),
        isCancelled: () => this.stopped
      })
      this.winCache = r
      return { sourceSha256: r.sourceSha256, bytesWritten: r.bytesWritten }
    }

    const result = await this.runWorker({
      mode: 'write',
      imagePath,
      devicePath: device.devicePath,
      deviceSize,
      totalBytes: total
    })

    if (!result.sourceSha256) {
      throw new Error('刻录工作线程未返回源镜像 SHA256')
    }

    return { sourceSha256: result.sourceSha256, bytesWritten: result.bytesWritten || 0 }
  }

  /** 读回目标设备前 total 字节做校验 */
  async verify(opts: WriteOptions, sourceSha256: string, bytes: number): Promise<string> {
    // Windows：写入阶段已由 runWindowsBurn 一并完成校验，直接取缓存结果
    if (process.platform === 'win32') {
      if (!this.winCache) {
        throw new Error('未找到 Windows 写盘结果，请先执行写入')
      }
      if (opts.validate && this.winCache.verifySha256 && this.winCache.verifySha256 !== sourceSha256) {
        throw new Error('校验失败：目标设备与镜像内容不一致')
      }
      return this.winCache.verifySha256 || this.winCache.sourceSha256
    }

    const deviceSize = opts.device.size > 0 ? opts.device.size : Number.POSITIVE_INFINITY

    const result = await this.runWorker({
      mode: 'verify',
      imagePath: opts.imagePath,
      devicePath: opts.device.devicePath,
      deviceSize,
      totalBytes: bytes,
      sourceSha256
    })

    if (!result.verifySha256) {
      throw new Error('刻录工作线程未返回校验 SHA256')
    }

    return result.verifySha256
  }
}

export async function statImage(imagePath: string): Promise<{ size: number; name: string; ext: string }> {
  const st = await fsp.stat(imagePath)
  const name = imagePath.split(/[\\/]/).pop() || imagePath
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
  return { size: st.size, name, ext }
}
