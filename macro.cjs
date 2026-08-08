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

// Set 1 tarama kodları (scancode). `ext` = genişletilmiş tuş (E0 öneki).
const SCANCODES = {
  w: { scan: 0x11, ext: false },
  a: { scan: 0x1e, ext: false },
  s: { scan: 0x1f, ext: false },
  d: { scan: 0x20, ext: false },
  up: { scan: 0x48, ext: true },
  left: { scan: 0x4b, ext: true },
  right: { scan: 0x4d, ext: true },
  down: { scan: 0x50, ext: true }
};

// App.tsx mantıksal olarak w/s/a/d üretir; şema seçimi bunları eşler.
const SCHEMES = {
  wasd: { w: 'w', s: 's', a: 'a', d: 'd' },
  arrows: { w: 'up', s: 'down', a: 'left', d: 'right' }
};

const DEFAULTS = {
  delay: 250,        // tuşlar arası bekleme (ms)
  holdTime: 60,      // tuşun basılı kaldığı süre (ms)
  startupDelay: 400, // odak verildikten sonra ilk tuşa kadar bekleme (ms)
  keyScheme: 'wasd',
  // Odaklanılacak oyun süreçleri (uzantısız). GothicMod = modlu kurulumlar.
  processNames: ['Gothic', 'GothicMod', 'Gothic2', 'Gothic2Mod']
};

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

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
  const scheme = SCHEMES[options.keyScheme] || SCHEMES[DEFAULTS.keyScheme];
  const excludePid = Number.isInteger(options.excludePid) ? options.excludePid : 0;
  const processNames = Array.isArray(options.processNames) && options.processNames.length
    ? options.processNames
    : DEFAULTS.processNames;

  const resolved = steps.map((step) => {
    const logical = String(step.key || '').toLowerCase();
    const mapped = scheme[logical] || logical;
    const code = SCANCODES[mapped];
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

Add-Type -TypeDefinition @'
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
'@

function Write-Marker([string] $text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

$excludePid = ${excludePid}
$processNames = @(${nameList})

function Find-GameWindow {
    foreach ($name in $processNames) {
        $proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $excludePid } |
                Select-Object -First 1
        if ($proc) { return $proc.MainWindowHandle }
    }
    return [IntPtr]::Zero
}

$target = Find-GameWindow
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
    foreach ($pair in @(@(0x11,$false), @(0x1E,$false), @(0x1F,$false), @(0x20,$false), @(0x48,$true), @(0x4B,$true), @(0x4D,$true), @(0x50,$true))) {
        [void][G1Input]::Key([uint16]$pair[0], [bool]$pair[1], $true)
    }
}
`;
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

module.exports = { buildMacroScript, runMacro, releaseAllKeys, SCANCODES, SCHEMES, DEFAULTS };
