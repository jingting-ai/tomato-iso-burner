/**
 * 刻录工作线程：在独立线程中使用同步 fs 对 Windows 原始设备句柄进行读写。
 *
 * Node.js 的异步 fs 在打开 \\.\PhysicalDriveN 时容易返回 EINVAL（overlapped I/O 与某些
 * 磁盘驱动不兼容），同步 fs.openSync/fs.writeSync 可绕过此问题。
 */
import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import crypto from 'node:crypto'

interface WorkerOptions {
  mode: 'write' | 'verify'
  imagePath: string
  devicePath: string
  chunkSize: number
  sectorSize: number
  deviceSize: number
  totalBytes: number
  sourceSha256?: string
}

interface TickMessage {
  type: 'tick'
  phase: 'write' | 'verify'
  writtenBytes: number
  totalBytes: number
  speed: number
  etaSeconds: number
  percent: number
  force?: boolean
}

function post(msg: unknown): void {
  parentPort?.postMessage(msg)
}

class Meter {
  private lastBytes = 0
  private lastTime = Date.now()
  private ema = 0

  update(bytes: number): number {
    const now = Date.now()
    const dt = (now - this.lastTime) / 1000
    if (dt >= 0.25) {
      const inst = (bytes - this.lastBytes) / dt
      this.ema = this.ema === 0 ? inst : this.ema * 0.55 + inst * 0.45
      this.lastBytes = bytes
      this.lastTime = now
    }
    return this.ema
  }
}

function runWorker(opts: WorkerOptions): void {
  const buf = Buffer.allocUnsafe(opts.chunkSize)
  let cancelled = false

  parentPort?.once('message', (msg) => {
    if (msg === 'cancel') cancelled = true
  })

  function checkCancel(): void {
    if (cancelled) {
      throw Object.assign(new Error('已取消'), { name: 'CancelledError' })
    }
  }

  function writePhase(): { sourceSha256: string; bytesWritten: number } {
    const src = fs.openSync(opts.imagePath, 'r')
    const dst = fs.openSync(opts.devicePath, 'r+')
    const hash = crypto.createHash('sha256')
    const meter = new Meter()
    let written = 0

    try {
      while (written < opts.totalBytes) {
        checkCancel()

        const want = Math.min(opts.chunkSize, opts.totalBytes - written)
        let len = want
        if (want % opts.sectorSize !== 0) {
          const padded = Math.ceil(want / opts.sectorSize) * opts.sectorSize
          if (written + padded <= opts.deviceSize) len = padded
        }
        if (len > want) buf.fill(0, want, len)

        const bytesRead = fs.readSync(src, buf, 0, want, null)
        if (bytesRead <= 0) break

        let off = 0
        while (off < len) {
          checkCancel()
          const bytesWritten = fs.writeSync(dst, buf, off, len - off, written + off)
          if (bytesWritten <= 0) throw new Error('写入被设备拒绝（返回 0 字节）')
          off += bytesWritten
        }

        hash.update(buf.subarray(0, bytesRead))
        written += bytesRead

        const speed = meter.update(written)
        post({
          type: 'tick',
          phase: 'write',
          writtenBytes: written,
          totalBytes: opts.totalBytes,
          speed,
          etaSeconds: speed > 0 ? Math.max(0, Math.round((opts.totalBytes - written) / speed)) : -1,
          percent: opts.totalBytes > 0 ? Math.min(100, (written / opts.totalBytes) * 100) : 0
        } as TickMessage)
      }

      fs.fsyncSync(dst)
      post({
        type: 'tick',
        phase: 'write',
        writtenBytes: written,
        totalBytes: opts.totalBytes,
        speed: 0,
        etaSeconds: 0,
        percent: 100,
        force: true
      } as TickMessage)

      return { sourceSha256: hash.digest('hex'), bytesWritten: written }
    } finally {
      fs.closeSync(dst)
      fs.closeSync(src)
    }
  }

  function verifyPhase(sourceSha256: string, bytes: number): string {
    const handle = fs.openSync(opts.devicePath, 'r')
    const hash = crypto.createHash('sha256')
    const meter = new Meter()
    let read = 0

    try {
      while (read < bytes) {
        checkCancel()

        const want = Math.min(opts.chunkSize, bytes - read)
        let len = want
        if (want % opts.sectorSize !== 0) {
          const padded = Math.ceil(want / opts.sectorSize) * opts.sectorSize
          if (read + padded <= opts.deviceSize) len = padded
        }

        const bytesRead = fs.readSync(handle, buf, 0, len, read)
        if (bytesRead <= 0) break
        hash.update(buf.subarray(0, Math.min(bytesRead, want)))
        read += Math.min(bytesRead, want)

        const speed = meter.update(read)
        post({
          type: 'tick',
          phase: 'verify',
          writtenBytes: read,
          totalBytes: bytes,
          speed,
          etaSeconds: speed > 0 ? Math.max(0, Math.round((bytes - read) / speed)) : -1,
          percent: bytes > 0 ? Math.min(100, (read / bytes) * 100) : 0
        } as TickMessage)
      }

      post({
        type: 'tick',
        phase: 'verify',
        writtenBytes: read,
        totalBytes: bytes,
        speed: 0,
        etaSeconds: 0,
        percent: 100,
        force: true
      } as TickMessage)

      const target = hash.digest('hex')
      if (target !== sourceSha256) {
        throw new Error(`校验失败：目标设备与镜像内容不一致\n镜像 ${sourceSha256}\n设备 ${target}`)
      }
      return target
    } finally {
      fs.closeSync(handle)
    }
  }

  try {
    if (opts.mode === 'write') {
      const { sourceSha256, bytesWritten } = writePhase()
      post({ type: 'done', sourceSha256, bytesWritten })
    } else {
      if (!opts.sourceSha256) throw new Error('verify 模式缺少 sourceSha256')
      const target = verifyPhase(opts.sourceSha256, opts.totalBytes)
      post({ type: 'done', verifySha256: target })
    }
  } catch (e: any) {
    post({ type: 'error', message: e.message || String(e), code: e.code || '' })
  }
}

runWorker(workerData as WorkerOptions)
