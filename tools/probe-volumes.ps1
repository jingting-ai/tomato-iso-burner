$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Collections.ArrayList

function W($s) { [void]$out.Add($s) }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VolProbe {
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr FindFirstVolume(StringBuilder name, uint len);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool FindNextVolume(IntPtr h, StringBuilder name, uint len);
  [DllImport("kernel32", SetLastError=true)]
  public static extern bool FindVolumeClose(IntPtr h);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool GetVolumePathNamesForVolumeName(string name, char[] buf, uint len, out uint need);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFile(string p, uint acc, uint share, IntPtr sa, uint cd, uint fa, IntPtr t);
  [DllImport("kernel32", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32", SetLastError=true)]
  public static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr ib, uint isz, IntPtr ob, uint osz, out uint ret, IntPtr ov);
  [StructLayout(LayoutKind.Sequential)]
  public struct SDN { public uint DeviceType; public uint DeviceNumber; public uint PartitionNumber; }
  public static string VolLetters(string vol) {
    char[] buf = new char[1024];
    uint need = 0;
    if (!GetVolumePathNamesForVolumeName(vol, buf, 1024, out need)) return "";
    string s = new string(buf);
    int z = s.IndexOf('\0');
    if (z >= 0) s = s.Substring(0, z);
    return s.Replace("\0", " ").Trim();
  }
  public static string DevNum(string path, out uint err) {
    err = 0;
    IntPtr h = CreateFile(path, 0x80000000, 0x00000001|0x00000002, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
    if (h == IntPtr.Zero || h == (IntPtr)(-1)) { err = (uint)Marshal.GetLastWin32Error(); return "OPENFAIL"; }
    int sz = Marshal.SizeOf(typeof(SDN));
    IntPtr p = Marshal.AllocHGlobal(sz);
    uint r = 0;
    bool ok = DeviceIoControl(h, 0x002D1080, IntPtr.Zero, 0, p, (uint)sz, out r, IntPtr.Zero);
    string result;
    if (!ok) { err = (uint)Marshal.GetLastWin32Error(); result = "IOCTLFAIL"; }
    else { SDN s = (SDN)Marshal.PtrToStructure(p, typeof(SDN)); result = s.DeviceNumber + "/" + s.PartitionNumber; }
    Marshal.FreeHGlobal(p);
    CloseHandle(h);
    return result;
  }
}
"@

W "=== FindFirstVolume 枚举（全系统所有卷对象） ==="
$sb = New-Object System.Text.StringBuilder 260
$h = [VolProbe]::FindFirstVolume($sb, 260)
if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) {
  W ("FindFirstVolume FAILED err=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
} else {
  try {
    while ($true) {
      $vol = $sb.ToString()
      $letters = [VolProbe]::VolLetters($vol)
      $u = 0
      $dn = [VolProbe]::DevNum($vol, [ref]$u)
      W ("VOL  " + $vol.PadRight(48) + " letters=[" + $letters + "] dev/part=" + $dn + " err=" + $u)
      $sb.Length = 0
      if (-not [VolProbe]::FindNextVolume($h, $sb, 260)) { break }
    }
  } finally { [void][VolProbe]::FindVolumeClose($h) }
}

W ""
W "=== 盘符探测（A-Z） ==="
foreach ($c in [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
  $p = "\\.\$c`:"
  $u = 0
  $dn = [VolProbe]::DevNum($p, [ref]$u)
  if ($dn -ne "OPENFAIL") { W ("LETTER " + $c + ": dev/part=" + $dn) }
  elseif ($u -ne 2 -and $u -ne 3) { W ("LETTER " + $c + ": openfail err=" + $u) }
}

W ""
W "=== 探测 PhysicalDrive2 ==="
$u2 = 0
W ("PHYS \\.\PhysicalDrive2 dev/part=" + [VolProbe]::DevNum("\\.\PhysicalDrive2", [ref]$u2) + " err=" + $u2)

W ""
W "=== Get-Partition -DiskNumber 2 ==="
foreach ($p in @(Get-Partition -DiskNumber 2)) {
  W ("  part#" + $p.PartitionNumber + " size=" + $p.Size + " type=" + $p.Type + " letter=[" + $p.DriveLetter + "] AP=[" + (($p.AccessPaths) -join ' ; ') + "]")
}

W ""
W "=== AccessPaths (generic) ==="
foreach ($p in @(Get-Partition)) {
  W ("  disk" + $p.DiskNumber + " part" + $p.PartitionNumber + " AP=[" + (($p.AccessPaths) -join ' ; ') + "]")
}

[System.IO.File]::WriteAllText("C:\Users\jingt\AppData\Local\Temp\doro-probe.txt", ($out -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "PROBE DONE"
