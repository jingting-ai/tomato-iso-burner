import { useEffect, useState } from 'react'
import type { ImageFamily, ImageProbeInfo } from '@shared/types'
import type { ImageStatResult } from '@shared/api'
import { formatBytes } from '../lib'

interface Props {
  imagePath: string | null
  info?: ImageStatResult['info']
  /** 镜像内容识别结果 */
  probe?: ImageProbeInfo | null
  /** 是否正在识别 */
  probing?: boolean
  onPick: () => void
  disabled: boolean
}

const IMAGE_HINT: Record<string, string> = {
  '.iso': 'ISO 9660 光盘镜像',
  '.img': '原始磁盘镜像',
  '.bin': '原始二进制镜像',
  '.raw': '原始磁盘镜像',
  '.dmg': 'Apple 磁盘镜像',
  '.vhd': '虚拟磁盘',
  '.vhdx': '虚拟磁盘'
}

const FAMILY_LABEL: Record<ImageFamily, string> = {
  linux: 'Linux',
  windows: 'Windows',
  dos: 'DOS',
  bsd: 'BSD',
  macos: 'macOS',
  hypervisor: '虚拟化平台',
  unknown: '未识别'
}

/**
 * 识别过程中轮播的步骤文案。与主进程 iso/probe.ts 里 probeImage() 的实际流程对应
 * （打开镜像解析文件系统 → 读根目录 / 探引导记录 → 逐条规则查特征文件 → 匹配版本库），
 * 只是让等待过程有个「正在做什么」的交代 —— 不报百分比（真的拿不到进度）。
 */
const SCAN_STEPS = [
  '打开镜像，解析文件系统…',
  '读取根目录与引导记录…',
  '查找系统映像与特征文件…',
  '匹配系统版本库…'
]

/** 识别中的小动画：一盘正在被读取的「光盘」 + 不定量进度条 + 轮播的步骤文案。 */
function ProbeScanning() {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setStep((s) => (s + 1) % SCAN_STEPS.length), 1300)
    return () => window.clearInterval(t)
  }, [])

  return (
    <div className="probe-body probe-scan" role="status" aria-live="polite">
      <div className="scan-disc" aria-hidden="true">
        <svg viewBox="0 0 44 44">
          <circle cx="22" cy="22" r="20.5" className="disc-rim" />
          <circle cx="22" cy="22" r="16.5" className="disc-face" />
          <circle cx="22" cy="22" r="12.5" className="disc-ring" />
          <circle cx="22" cy="22" r="5.5" className="disc-hole" />
          <path d="M22 1.5 A20.5 20.5 0 0 1 43 22" className="disc-arc" />
        </svg>
      </div>

      <div className="scan-main">
        <div className="scan-title">正在读取镜像内的系统信息</div>
        <div className="scan-track">
          <i />
        </div>
        <div className="scan-step">{SCAN_STEPS[step]}</div>
      </div>
    </div>
  )
}

/** 识别结果。外壳（文件行 + 边框）由外层 .image-card 提供，这里只输出下半部分。 */
function ProbeBody({ probe }: { probe: ImageProbeInfo }) {
  const conf = probe.confidence >= 0.85 ? 'high' : probe.confidence >= 0.6 ? 'mid' : 'low'

  return (
    <div className="probe-body">
      <div className="probe-head">
        <span className="probe-family">{FAMILY_LABEL[probe.family]}</span>
        <span className="probe-name" title={probe.osName}>
          {probe.osName}
        </span>
        <span className={`probe-flag ${probe.bootable ? 'ok' : 'warn'}`}>
          {probe.bootable ? '可引导' : '不含引导'}
        </span>
      </div>

      <div className="probe-tags">
        {probe.version && <span className="probe-tag strong">版本 {probe.version}</span>}
        {probe.arch && <span className="probe-tag">{probe.arch}</span>}
        {probe.bootModes.map((m) => (
          <span className="probe-tag" key={m}>
            {m}
          </span>
        ))}
        <span className="probe-tag soft">{probe.container}</span>
      </div>

      {probe.details.length > 0 && (
        <dl className="probe-details">
          {probe.details.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd title={d.value}>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className={`probe-src conf-${conf}`}>
        识别依据：{probe.evidence}
        {probe.confidence > 0 && ` · 置信度 ${Math.round(probe.confidence * 100)}%`}
      </div>

      {probe.hint && <div className="probe-note">{probe.hint}</div>}

      {!probe.bootable && (
        <div className="probe-note">
          该镜像未检测到引导信息，写入 U 盘后可能无法直接启动。
        </div>
      )}
    </div>
  )
}

/**
 * 镜像选择 + 内容识别。两者**合并在同一张卡片里**：
 * 上半是「选中的文件」，下半是「这个镜像里是什么系统」——
 * 读的时候下半就是识别动画，读完原地换成结果，不再另起一个框。
 * 外壳（步骤卡片）仍由 App 提供，这里只输出内容。
 */
export default function ImageStep({ imagePath, info, probe, probing, onPick, disabled }: Props) {
  if (!imagePath || !info) {
    return (
      <div className="bare-block">
        <button className="dropzone" onClick={onPick} disabled={disabled}>
          <div className="dz-icon">＋</div>
          <div className="dz-title">点击选择镜像文件</div>
          <div className="dz-sub">
            支持 ISO / IMG / DMG / VHD 等原始镜像 · .gz / .xz 压缩包请先解压
          </div>
        </button>
      </div>
    )
  }

  // 边框左侧那道彩色竖条跟着识别出的系统家族走：读到结果时整张卡的左缘一起变色
  const fam = probe?.family ?? 'none'

  return (
    <div className="bare-block">
      <div className={`image-card fam-${fam}${probing ? ' is-probing' : ''}`}>
        <div className="image-head">
          <div className="file-icon">{info.ext.replace('.', '').toUpperCase() || 'IMG'}</div>
          <div className="file-meta">
            <div className="file-name" title={imagePath}>
              {info.name}
            </div>
            <div className="file-sub">
              {formatBytes(info.size)} · {IMAGE_HINT[info.ext] ?? '磁盘镜像'}
            </div>
            <div className="file-path">{imagePath}</div>
          </div>
          <button className="btn ghost" onClick={onPick} disabled={disabled}>
            更换
          </button>
        </div>

        {probing ? (
          <ProbeScanning />
        ) : probe ? (
          <ProbeBody probe={probe} />
        ) : (
          <div className="probe-body">
            <div className="probe-fail">
              没能读出镜像里的系统信息（不影响写入，可直接按下面的写入方式继续）。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
