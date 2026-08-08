/**
 * Makro motoru.
 *
 * Gothic 1 (zEngine, 2001) klavyeyi DirectInput üzerinden okur. DirectInput
 * pencere mesaj kuyruğunu (WM_KEYDOWN) değil, ham girdi akışını dinler; bu
 * yüzden `SendKeys::SendWait` gibi mesaj tabanlı yöntemler oyunda çoğunlukla
 * hiç algılanmaz. Burada bunun yerine `SendInput` + KEYEVENTF_SCANCODE
 * kullanılıyor: gönderilen tuşlar sürücü seviyesindeki girdi akışına girer ve
 * DirectInput tarafından normal bir tuş basımı gibi görülür.
 *
 * Ayrıca her tuş için ayrı keydown / bekle / keyup üretiliyor. Eski motorlar
 * girdiyi kare başına bir kez örneklediğinden, süresi ~0ms olan bir basış
 * tamamen kaçırılabilir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Set 1 tarama kodları (scancode). Gothic 1 hareket tuşları hiçbiri
// genişletilmiş (E0) tuş değil.
const SCANCODES = {
  w: { scan: 0x11, ext: false },
  a: { scan: 0x1e, ext: false },
  s: { scan: 0x1f, ext: false },
  d: { scan: 0x20, ext: false },
  r: { scan: 0x13, ext: false }
};

const DEFAULTS = {
  delay: 250,        // tuşlar arası bekleme (ms)
  holdTime: 60,      // tuşun basılı kaldığı süre (ms)
  startupDelay: 400, // odak verildikten sonra ilk tuşa kadar bekleme (ms)
  // Odaklanılacak oyun süreçleri (uzantısız). GothicMod = modlu kurulumlar.
  processNames: ['Gothic', 'GothicMod', 'Gothic2', 'Gothic2Mod']
};

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

// runMacro ve runFocusGuard'ın ikisi de aynı Win32 P/Invoke yüzeyine
// ihtiyaç duyuyor; tek yerden tanımlayıp paylaşıyoruz.
const INTEROP_CS = `
using System;
using System.Runtime.InteropServices;

public static class G1Input
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_SCANCODE = 0x0008;

    public static uint Key(ushort scan, bool extended, bool up)
    {
        INPUT[] buffer = new INPUT[1];
        buffer[0].type = INPUT_KEYBOARD;
        buffer[0].U.ki.wVk = 0;
        buffer[0].U.ki.wScan = scan;
        buffer[0].U.ki.dwFlags = KEYEVENTF_SCANCODE
            | (extended ? KEYEVENTF_EXTENDEDKEY : 0)
            | (up ? KEYEVENTF_KEYUP : 0);
        buffer[0].U.ki.time = 0;
        buffer[0].U.ki.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, buffer, Marshal.SizeOf(typeof(INPUT)));
    }

    // SetForegroundWindow, girdiyi son alan sürecin dışındaki çağrıları
    // yok sayar. ALT'a kısa bir basış bu kısıtı kaldırır (bilinen workaround).
    public static bool Focus(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return false;
        if (GetForegroundWindow() == hWnd) return true;
        Key(0x38, false, false);
        Key(0x38, false, true);
        ShowWindow(hWnd, 9); // SW_RESTORE
        SetForegroundWindow(hWnd);
        System.Threading.Thread.Sleep(150);
        return GetForegroundWindow() == hWnd;
    }
}
`;

// $processNames çağıran betikte zaten tanımlı olmalı.
const findGameWindowPs = (excludePidVar) => `
function Find-GameWindow {
    foreach ($name in $processNames) {
        $proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $${excludePidVar} } |
                Select-Object -First 1
        if ($proc) { return $proc.MainWindowHandle }
    }
    return [IntPtr]::Zero
}
`;

/**
 * Adım listesini PowerShell betiğine çevirir.
 * @param {{key: string}[]} steps
 * @param {object} options
 * @returns {string}
 */
function buildMacroScript(steps, options = {}) {
  const delay = clamp(options.delay, 0, 5000, DEFAULTS.delay);
  const holdTime = clamp(options.holdTime, 10, 1000, DEFAULTS.holdTime);
  const startupDelay = clamp(options.startupDelay, 0, 5000, DEFAULTS.startupDelay);
  const excludePid = Number.isInteger(options.excludePid) ? options.excludePid : 0;
  const processNames = Array.isArray(options.processNames) && options.processNames.length
    ? options.processNames
    : DEFAULTS.processNames;
  // Odak bekçisinin en son gözlemlediği "oyun" penceresi (bkz.
  // buildFocusGuardScript). Süreç adı listesi eşleşmese bile hâlâ geçerli
  // bir pencereyse önce bu deneniyor — isim tahminine göre çok daha güvenilir.
  const knownHwnd = typeof options.knownHwnd === 'string' && /^0x[0-9a-fA-F]+$/.test(options.knownHwnd)
    ? options.knownHwnd
    : '0x0';

  const resolved = steps.map((step) => {
    const logical = String(step.key || '').toLowerCase();
    const code = SCANCODES[logical];
    if (!code) {
      throw new Error(`Bilinmeyen tuş: ${step.key}`);
    }
    return code;
  });

  const scanList = resolved.map((c) => `0x${c.scan.toString(16).toUpperCase()}`).join(',');
  const extList = resolved.map((c) => (c.ext ? '$true' : '$false')).join(',');
  const nameList = processNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');

  // C# bloğu tek tırnaklı here-string içinde: PowerShell içeriği yorumlamasın.
  return `$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'${INTEROP_CS}'@

function Write-Marker([string] $text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

$excludePid = ${excludePid}
$processNames = @(${nameList})
${findGameWindowPs('excludePid')}
$target = [IntPtr]${knownHwnd}
if ($target -eq [IntPtr]::Zero -or -not [G1Input]::IsWindow($target)) {
    $target = Find-GameWindow
}
if ($target -ne [IntPtr]::Zero) {
    if ([G1Input]::Focus($target)) { Write-Marker 'FOCUS:ok' } else { Write-Marker 'FOCUS:fail' }
} else {
    # Oyun süreci bulunamadı: mevcut ön plan penceresine gönderilecek.
    Write-Marker 'FOCUS:none'
}

Start-Sleep -Milliseconds ${startupDelay}

$scans = @(${scanList})
$exts = @(${extList})

try {
    for ($i = 0; $i -lt $scans.Count; $i++) {
        Write-Marker ('STEP:' + $i)
        [void][G1Input]::Key([uint16]$scans[$i], [bool]$exts[$i], $false)
        Start-Sleep -Milliseconds ${holdTime}
        [void][G1Input]::Key([uint16]$scans[$i], [bool]$exts[$i], $true)
        Start-Sleep -Milliseconds ${delay}
    }
    Write-Marker 'DONE'
} finally {
    # Süreç yarıda kesilirse tuşun basılı kalmaması için hepsini bırak.
    foreach ($pair in @(@(0x11,$false), @(0x1E,$false), @(0x1F,$false), @(0x20,$false), @(0x13,$false))) {
        [void][G1Input]::Key([uint16]$pair[0], [bool]$pair[1], $true)
    }
}
`;
}

/**
 * Panel açıkken sürekli çalışan, oyunun ön plan (foreground) durumunu geri
 * kazandıran bir bekçi betiği üretir.
 *
 * Neden gerekli: `focusable: false` overlay penceresinin OS'a "aktif" olarak
 * bildirilmesini engeller, ama oyunun klavye girdisi muhtemelen "foreground"
 * iş birliği modunda çalışıyor — yani oyun kendisi ön planda olmadığı her an
 * klavyeyi TAMAMEN görmezden geliyor, overlay'in "aktif" olup olmaması
 * bundan bağımsız. Panel üzerinde bir tıklama anlık olarak ön planı
 * değiştirmiş olsa bile, bu bekçi kısa aralıklarla kontrol edip oyunu
 * tekrar ön plana taşıyor.
 *
 * Hedefi NASIL BULUYOR: süreç adı listesine (`DEFAULTS.processNames`)
 * güvenmek kırılgan — oyunun farklı sürümleri/remake'leri tamamen farklı
 * bir .exe adıyla çalışabilir ve o zaman bekçi sessizce hiçbir şey yapmaz.
 * Bunun yerine ana strateji isim-bağımsız: overlay'in kendi HWND'si
 * (`ourHwnd`, main.cjs'ten `getNativeWindowHandle()` ile geçiriliyor) dışında
 * ön planda son görülen pencere neyse onu hatırlar (`$lastGood`) ve ön plan
 * bize kaydığında ona geri döner — hangi oyun/uygulama olduğuna bakmaksızın
 * çalışır. İsim listesi yalnızca `$lastGood` henüz hiç ayarlanmamışsa
 * (bekçi panel ilk açıldığında henüz hiçbir foreground-değişikliği
 * görmediyse) ikincil bir yedek olarak kullanılıyor.
 *
 * En son bilinen hedefi `LASTFG:<hwnd>` satırlarıyla stdout'a yazar; bu,
 * main.cjs'in makro çalıştırılırken (bekçi o an durdurulmuş olsa da) aynı
 * pencereyi hedefleyebilmesi için saklanıyor.
 *
 * @param {object} options
 * @returns {string}
 */
function buildFocusGuardScript(options = {}) {
  const excludePid = Number.isInteger(options.excludePid) ? options.excludePid : 0;
  const intervalMs = clamp(options.intervalMs, 50, 2000, 150);
  const processNames = Array.isArray(options.processNames) && options.processNames.length
    ? options.processNames
    : DEFAULTS.processNames;
  const nameList = processNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const ourHwnd = typeof options.ourHwnd === 'string' && /^0x[0-9a-fA-F]+$/.test(options.ourHwnd)
    ? options.ourHwnd
    : '0x0';

  return `$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'${INTEROP_CS}'@

function Write-Marker([string] $text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

$excludePid = ${excludePid}
$processNames = @(${nameList})
${findGameWindowPs('excludePid')}
$ourHwnd = [IntPtr]${ourHwnd}
$lastGood = [IntPtr]::Zero

while ($true) {
    $fg = [G1Input]::GetForegroundWindow()

    if ($fg -ne [IntPtr]::Zero -and $fg -ne $ourHwnd) {
        # Overlay dışında bir şey ön planda: bu muhtemelen oyun. Hatırla.
        if ($fg -ne $lastGood) {
            $lastGood = $fg
            Write-Marker ('LASTFG:' + $lastGood.ToInt64())
        }
    } elseif ($fg -eq $ourHwnd) {
        # Ön plan bize kaydı; geri ver. Henüz gözlemlenmiş bir hedef yoksa
        # (bekçi az önce başladıysa) isim tabanlı aramaya düş.
        $target = $lastGood
        if ($target -eq [IntPtr]::Zero -or -not [G1Input]::IsWindow($target)) {
            $target = Find-GameWindow
        }
        if ($target -ne [IntPtr]::Zero) {
            [void][G1Input]::Focus($target)
        }
    }

    Start-Sleep -Milliseconds ${intervalMs}
}
`;
}

/**
 * Bekçi betiğini kalıcı bir arka plan sürecinde çalıştırır. Her tık için
 * ayrı bir PowerShell başlatmak yerine tek süreç sürekli döner; panel
 * kapanınca (veya makro/hedefleme başlayınca) `stopFocusGuard` ile
 * durdurulur.
 *
 * @param {object} options
 * @param {{onLastForeground?: (hwndHex: string) => void}} handlers
 * @returns {import('child_process').ChildProcess}
 */
function runFocusGuard(options = {}, handlers = {}) {
  const script = buildFocusGuardScript(options);
  const scriptPath = path.join(os.tmpdir(), `g1-lockpick-focusguard-${process.pid}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf8');

  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath
  ], { windowsHide: true });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('LASTFG:')) {
        const value = BigInt(trimmed.slice(7));
        handlers.onLastForeground?.('0x' + value.toString(16));
      }
    }
  });

  const cleanup = () => fs.promises.unlink(scriptPath).catch(() => {});
  child.on('close', cleanup);
  child.on('error', cleanup);

  return child;
}

/**
 * Betiği geçici bir .ps1 dosyasına yazıp çalıştırır.
 * `-Command` yerine `-File` kullanılıyor; uzun betiklerde tırnak/kaçış
 * sorunlarını tamamen ortadan kaldırıyor.
 *
 * @returns {{child: import('child_process').ChildProcess, scriptPath: string}}
 */
function runMacro(steps, options, handlers = {}) {
  const script = buildMacroScript(steps, options);
  const scriptPath = path.join(os.tmpdir(), `g1-lockpick-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf8');

  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath
  ], { windowsHide: true });

  // stdout parça parça gelir; satır sınırlarını kendimiz takip ediyoruz.
  // (Eski kod bir parçadaki yalnızca ilk STEP eşleşmesini okuyup geri
  // kalanları düşürdüğü için ilerleme çubuğu adım atlıyordu.)
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('STEP:')) {
        const index = parseInt(trimmed.slice(5), 10);
        if (Number.isInteger(index)) handlers.onStep?.(index);
      } else if (trimmed.startsWith('FOCUS:')) {
        handlers.onFocus?.(trimmed.slice(6));
      }
    }
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const cleanup = () => {
    fs.promises.unlink(scriptPath).catch(() => {});
  };

  child.on('error', (err) => {
    cleanup();
    handlers.onFinished?.({ ok: false, error: err.message });
  });

  child.on('close', (code) => {
    cleanup();
    handlers.onFinished?.({
      ok: code === 0,
      code,
      error: code === 0 ? undefined : stderr.trim() || `PowerShell çıkış kodu ${code}`
    });
  });

  return { child, scriptPath };
}

/** Yarıda kesilen makrodan sonra basılı kalmış olabilecek tuşları bırakır. */
function releaseAllKeys() {
  const releases = Object.values(SCANCODES)
    .map((c) => `[void][G1Release]::Key([uint16]0x${c.scan.toString(16).toUpperCase()}, ${c.ext ? '$true' : '$false'})`)
    .join('; ');

  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class G1Release
{
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    public static uint Key(ushort scan, bool extended)
    {
        INPUT[] b = new INPUT[1];
        b[0].type = 1;
        b[0].U.ki.wScan = scan;
        b[0].U.ki.dwFlags = 0x0008 | 0x0002 | (extended ? (uint)0x0001 : 0);
        return SendInput(1, b, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@
${releases}
`;

  const scriptPath = path.join(os.tmpdir(), `g1-lockpick-release-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
  ], { windowsHide: true });
  child.on('close', () => fs.promises.unlink(scriptPath).catch(() => {}));
  child.on('error', () => fs.promises.unlink(scriptPath).catch(() => {}));
}

module.exports = { buildMacroScript, runMacro, releaseAllKeys, buildFocusGuardScript, runFocusGuard, SCANCODES, DEFAULTS };
