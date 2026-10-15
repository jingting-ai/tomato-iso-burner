import type { FileSystemType, FormatOptions, PartitionStyle } from '@shared/types'

interface Props {
  value: FormatOptions
  onChange: (v: FormatOptions) => void
  disabled: boolean
  /**
   * 精简模式（「U 盘还原」窗口用）：只留文件系统与卷标。
   * 还原脚本按容量自己决定分区表（≥2TB 用 GPT，其余 MBR），并且一律快速格式化，
   * 所以这两项在这里显示出来只会让人误以为可选。
   */
  simple?: boolean
}

const STYLE_HINT: Record<PartitionStyle, string> = {
  MBR: '兼容老主板 / BIOS',
  GPT: 'UEFI 新主板'
}

const FS_LIST: { value: FileSystemType; hint: string }[] = [
  { value: 'FAT32', hint: '兼容性最好 · 单文件最大 4GB' },
  { value: 'NTFS', hint: 'Windows 专用 · 支持大文件' },
  { value: 'exFAT', hint: '各系统通用 · 支持大文件' }
]

export default function FormatPanel({ value, onChange, disabled, simple = false }: Props) {
  const set = (patch: Partial<FormatOptions>): void => onChange({ ...value, ...patch })
  const maxLabel = value.fileSystem === 'NTFS' ? 32 : 11

  return (
    <div className="fmt-panel">
      {!simple && (
      <div className="form-row">
        <div className="form-label">分区表</div>
        <div className="seg">
          {(['MBR', 'GPT'] as PartitionStyle[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`seg-btn ${value.partitionStyle === s ? 'active' : ''}`}
              disabled={disabled}
              onClick={() => set({ partitionStyle: s })}
            >
              <span className="seg-title">{s}</span>
              <span className="seg-hint">{STYLE_HINT[s]}</span>
            </button>
          ))}
        </div>
      </div>
      )}

      <div className="form-row">
        <div className="form-label">文件系统</div>
        <div className="seg">
          {FS_LIST.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`seg-btn ${value.fileSystem === f.value ? 'active' : ''}`}
              disabled={disabled}
              onClick={() => set({ fileSystem: f.value })}
            >
              <span className="seg-title">{f.value}</span>
              <span className="seg-hint">{f.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="form-row">
        <label className="form-label" htmlFor="vol-label">
          卷标
        </label>
        <input
          id="vol-label"
          className="control"
          value={value.label}
          maxLength={maxLabel}
          placeholder={`可留空（最多 ${maxLabel} 个字符）`}
          disabled={disabled}
          onChange={(e) => set({ label: e.target.value })}
        />
      </div>

      {simple ? (
        <p className="hint">
          还原会重建分区表（容量 ≥ 2 TB 自动用 GPT，其余用 MBR），再把整块盘格式化成上面选择的
          文件系统 —— 完成后在「此电脑」里就是一块能直接用的普通 U 盘，名字就是上面的卷标。
        </p>
      ) : (
      <div className="options">
        <label className="switch">
          <input
            type="checkbox"
            checked={value.quick}
            onChange={(e) => set({ quick: e.target.checked })}
            disabled={disabled}
          />
          <span>快速格式化（不扫描坏扇区，几秒完成）</span>
        </label>
        <p className="hint">
          此模式不写入任何镜像，只把磁盘重建为「单分区 + 指定文件系统」的普通磁盘，
          完成后可立即在「此电脑」里正常读写。取消勾选则执行完整格式化，会逐扇区扫描坏块，
          大容量盘可能耗时很久。
        </p>
      </div>
      )}
    </div>
  )
}
