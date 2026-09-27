import { useState, useEffect, useRef } from 'react';
import { Play, ArrowRight, ArrowLeftRight, Circle, ChevronLeft, ChevronRight, Terminal, Clock, Crosshair, Menu, Minus, Square, Timer, AlertTriangle, Power, RotateCcw, Undo2, Search, CheckCircle2 } from 'lucide-react';
import { LockSolver } from './LockSolver';
import './index.css';

type MacroStep = {
  key: string;
  desc: string;
  kind: 'reset' | 'nav' | 'push';
  plate: string;
};

type CompressedMove = { name: string; count: number };

type DisplayGroup =
  | { type: 'reset'; label: string; startIndex: number; endIndex: number }
  | { type: 'nav'; label: string; startIndex: number; endIndex: number }
  | { type: 'push'; plate: string; sign: '+' | '-'; count: number; startIndex: number; endIndex: number };

/**
 * Ham (her tuş için ayrı) macroSteps dizisini panelde göstermeye uygun,
 * kısa gruplu satırlara indirger: ardışık aynı yönlü geçiş adımları tek
 * "A → E geçişi" satırında, ardışık aynı plaka/yön itmeleri "3x A+" gibi tek
 * bir hamle özetinde toplanır. Gerçek tuş gönderimi hâlâ macroSteps üzerinden,
 * tek tek yapılır — bu yalnızca görsel bir özet.
 */
function groupStepsForDisplay(steps: MacroStep[]): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let atPlate = 'A';
  let i = 0;

  while (i < steps.length) {
    const start = i;
    const cur = steps[i];

    if (cur.kind === 'reset') {
      groups.push({ type: 'reset', label: 'Kilit sıfırlanıyor (R)', startIndex: start, endIndex: start });
      i++;
    } else if (cur.kind === 'nav') {
      let j = i;
      while (j < steps.length && steps[j].kind === 'nav' && steps[j].key === cur.key) j++;
      const toPlate = steps[j - 1].plate;
      groups.push({
        type: 'nav',
        label: `${atPlate} → ${toPlate} geçişi (${j - i}x ${cur.key.toUpperCase()})`,
        startIndex: start,
        endIndex: j - 1
      });
      atPlate = toPlate;
      i = j;
    } else {
      let j = i;
      while (j < steps.length && steps[j].kind === 'push' && steps[j].key === cur.key && steps[j].plate === cur.plate) j++;
      groups.push({
        type: 'push',
        plate: cur.plate,
        sign: cur.key === 'd' ? '+' : '-',
        count: j - i,
        startIndex: start,
        endIndex: j - 1
      });
      atPlate = cur.plate;
      i = j;
    }
  }

  return groups;
}

type MacroResult = {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
};

// Oto-gizlen şablon karşılaştırması: daha küçük bir örnekleme alanı, hedef
// köşedeki animasyon/parıltı gibi değişken piksellere yakalanma ihtimalini
// azaltır; daha yüksek eşik de küçük renk sapmalarına (video gürültüsü,
// sıkıştırma artefaktı) tolerans tanır. Eskiden 50px/eşik 15 aşırı duyarlıydı.
const CAPTURE_SIZE = 24;
const MATCH_THRESHOLD = 30;

type PersistedState = {
  numPlates: number;
  startState: number[];
  movesMatrix: number[][];
};

const STORAGE_KEY = 'g1lockpicker.plates.v1';

const buildIdentityMatrix = (n: number): number[][] =>
  Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

/** Uygulama kapanıp açılsa bile son başlangıç konumu/vektörleri hatırlanır. */
function loadPersistedState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.numPlates !== 'number' ||
      !Array.isArray(parsed?.startState) ||
      !Array.isArray(parsed?.movesMatrix)
    ) {
      return null;
    }
    return parsed as PersistedState;
  } catch {
    return null;
  }
}

type PersistedSettings = {
  passiveMode: boolean;
  resetDelay: number;
  sendSpaceAfterSolve: boolean;
  spaceDelay: number;
  macroDelay: number;
  holdTime: number;
};

const SETTINGS_STORAGE_KEY = 'g1lockpicker.settings.v1';

/** Pasif Mod ve tuş gecikme ayarları da kapanış sonrası hatırlanır. */
function loadPersistedSettings(): Partial<PersistedSettings> | null {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<PersistedSettings>;
  } catch {
    return null;
  }
}

function App() {
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [numPlates, setNumPlates] = useState(() => loadPersistedState()?.numPlates ?? 6);
  const [startState, setStartState] = useState<number[]>(
    () => loadPersistedState()?.startState ?? [0, 0, 0, 0, 0, 0]
  );
  const [movesMatrix, setMovesMatrix] = useState<number[][]>(
    () => loadPersistedState()?.movesMatrix ?? buildIdentityMatrix(6)
  );

  // "Geri Al" için konum/vektör geçmişi (bkz. pushHistory/undo aşağıda).
  const [history, setHistory] = useState<{ startState: number[]; movesMatrix: number[][] }[]>([]);

  // Oyuncunun kilit açarken hangi plakayı bitirdiğini elle işaretleyebilmesi
  // için — çözümü etkilemez, salt görsel bir takip yardımcısı. İki bölüm
  // (konum / vektör) birbirinden bağımsız işaretlenebilsin diye ayrı setler.
  const [completedPositions, setCompletedPositions] = useState<Set<number>>(new Set());
  const [completedVectors, setCompletedVectors] = useState<Set<number>>(new Set());

  const toggleInSet = (setter: React.Dispatch<React.SetStateAction<Set<number>>>, index: number) => {
    setter(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const [isExecuting, setIsExecuting] = useState(false);
  const [macroSteps, setMacroSteps] = useState<MacroStep[]>([]);
  // Kısa özet: "Çözümü Bul" sonrası gösterilen "3x A+ 2x C-" tarzı liste.
  const [solutionSummary, setSolutionSummary] = useState<CompressedMove[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(-1);
  // Uygulanan hamlenin listede sabit bir konumda kalması için: her yeni
  // adımda o an aktif olan grubu kapsayan konteynerin içine kaydırıyoruz
  // (satırların kendisi kaymıyor, konteyner kayıyor — kullanıcı sürekli
  // aynı yere bakabiliyor).
  const activeGroupRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeGroupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [currentStepIndex]);
  // "Kaç hamle var / kaçıncıdayız": R ve geçiş (nav) tuşları hamle sayılmaz,
  // yalnızca gerçek plaka itmeleri (push) "hamle" olarak sayılıyor.
  const totalHamleCount = macroSteps.filter(s => s.kind === 'push').length;
  const completedHamleCount = macroSteps
    .slice(0, Math.max(0, currentStepIndex + 1))
    .filter(s => s.kind === 'push').length;
  const [macroDelay, setMacroDelay] = useState(() => loadPersistedSettings()?.macroDelay ?? 250);
  const [holdTime, setHoldTime] = useState(() => loadPersistedSettings()?.holdTime ?? 60);
  // R (sıfırlama) tuşundan sonra, oyunun kilidi gerçekten sıfırlaması için
  // normal adım aralığının üstüne eklenen ekstra bekleme.
  const [resetDelay, setResetDelay] = useState(() => loadPersistedSettings()?.resetDelay ?? 0);
  // Kilit açıldıktan sonra isteğe bağlı olarak Space gönderilsin mi ve
  // ne kadar beklendikten sonra.
  const [sendSpaceAfterSolve, setSendSpaceAfterSolve] = useState(
    () => loadPersistedSettings()?.sendSpaceAfterSolve ?? false
  );
  const [spaceDelay, setSpaceDelay] = useState(() => loadPersistedSettings()?.spaceDelay ?? 0);
  const [focusStatus, setFocusStatus] = useState<string | null>(null);
  const [macroError, setMacroError] = useState<string | null>(null);
  // null = kutlama yok; 3,2,1,0 -> panel otomatik küçülüyor.
  const [completionCountdown, setCompletionCountdown] = useState<number | null>(null);

  // Auto-Hide State
  const [isTargeting, setIsTargeting] = useState(false);
  const [targetRect, setTargetRect] = useState<{x: number, y: number} | null>(null);
  const [targetTemplate, setTargetTemplate] = useState<Uint8ClampedArray | null>(null);
  const [cursorPos, setCursorPos] = useState({x: 0, y: 0});
  // Kilit ekranı şu an tespit ediliyor mu. Bu, panelin açık/kapalı
  // durumunu DEĞİL, yalnızca sol üst köşe butonunun görünürlüğünü sürer.
  // Panel şablon hiç kurulmadıysa buton her zaman görünür (eski davranış).
  const [isLockScreenDetected, setIsLockScreenDetected] = useState(false);
  // Kullanıcı şablonu silmeden "Auto Mod"u geçici olarak kapatabilsin.
  const [autoHideEnabled, setAutoHideEnabled] = useState(true);
  const isButtonVisible = !targetTemplate || !autoHideEnabled || isLockScreenDetected;

  // Pasif Mod: panel kapalıyken köşe butonu tamamen gizlenir, yalnızca fare
  // tam o 100x100 köşeye gelince tekrar görünür/tıklanabilir olur. Açmanın
  // tek yolları F9 (global kısayol, her zaman çalışır) ya da bu şekilde
  // ortaya çıkan butona tıklamaktır.
  const [passiveMode, setPassiveMode] = useState(() => loadPersistedSettings()?.passiveMode ?? false);
  const [isCornerHovered, setIsCornerHovered] = useState(false);
  // ÖNEMLİ: panel açıkken veya fare köşedeyken buton HER ZAMAN görünür —
  // bunlar Auto Mod'un anlık algılama durumundan (isButtonVisible) bağımsız
  // olmalı. Eskiden `isButtonVisible && (...)` şeklindeydi; Auto Mod
  // kurulu ama o an algılamıyorsa isButtonVisible false oluyordu ve bu,
  // panel açık ya da fare tam köşedeyken bile butonu görünmez kılıp
  // kullanıcıyı F9 dışında hiçbir yolla geri getirilemez bırakıyordu —
  // özellikle Pasif Mod'da "program hiç gözükmüyor" diye bildirilen sorun buydu.
  const isToggleButtonVisible =
    isPanelOpen ||
    isCornerHovered ||
    (!passiveMode && isButtonVisible);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Init WebRTC stream if we are targeting or if we have a template to poll
  useEffect(() => {
    let stream: MediaStream | null = null;
    if (isTargeting || (targetTemplate && autoHideEnabled)) {
      (async () => {
        try {
          const sourceId = await (window as any).electronAPI?.getDesktopSourceId();
          if (!sourceId) return;
          
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId
              }
            } as any
          });
          
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play();
          }
        } catch (err) {
          console.error("Failed to get desktop stream", err);
        }
      })();
    }
    
    return () => {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
      }
    };
  }, [isTargeting, targetTemplate !== null, autoHideEnabled]);

  // Polling loop
  useEffect(() => {
    if (!targetTemplate || !targetRect || !autoHideEnabled || !videoRef.current || !canvasRef.current) return;

    const interval = setInterval(() => {
      const video = videoRef.current!;
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d');
      if (!ctx || video.videoWidth === 0) return;

      canvas.width = CAPTURE_SIZE;
      canvas.height = CAPTURE_SIZE;

      // Calculate video scaling vs screen if necessary.
      // Usually full screen capture matches screen resolution 1:1 on primary display.
      ctx.drawImage(video, targetRect.x, targetRect.y, CAPTURE_SIZE, CAPTURE_SIZE, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
      const currentData = ctx.getImageData(0, 0, CAPTURE_SIZE, CAPTURE_SIZE).data;

      let diff = 0;
      // Compare pixels (RGBA)
      for (let i = 0; i < currentData.length; i += 4) {
        diff += Math.abs(currentData[i] - targetTemplate[i]);     // R
        diff += Math.abs(currentData[i+1] - targetTemplate[i+1]); // G
        diff += Math.abs(currentData[i+2] - targetTemplate[i+2]); // B
      }

      const avgDiff = diff / (CAPTURE_SIZE * CAPTURE_SIZE);
      const isMatch = avgDiff < MATCH_THRESHOLD;

      // Makro çalışırken tespit durumunu değiştirmiyoruz; aksi halde ekran
      // makro sırasında değiştikçe köşe butonu titreyebilir.
      if (!isExecuting) {
        setIsLockScreenDetected(isMatch);
      }
    }, 1000); // Check every 1 second

    return () => clearInterval(interval);
  }, [targetTemplate, targetRect, isExecuting, autoHideEnabled]);

  // Kilit ekranı algılanmayı bırakırsa paneli otomatik kapatır (küçültür).
  // Açmak (büyütmek) her zaman kullanıcının elindedir — burada asla true'ya
  // çekilmez, yalnızca kapatma yönünde otomatik davranış vardır.
  useEffect(() => {
    if (!targetTemplate || !autoHideEnabled) return; // oto-gizlen hiç kurulmadıysa/kapalıysa dokunma
    if (isLockScreenDetected || isExecuting || isTargeting) return;

    setIsPanelOpen(prev => {
      if (!prev) return prev;
      (window as any).electronAPI?.setOverlayInteractive(false);
      return false;
    });
  }, [isLockScreenDetected, targetTemplate, isExecuting, isTargeting, autoHideEnabled]);

  // Sol üst köşe butonunun GERÇEKTE görünür olup olmadığını (Pasif Mod
  // dahil) ana sürece bildir: buton görünür değilken 100x100 hitbox'ı da
  // tıklamayı yakalamamalı, aksi halde oyunun üzerinde görünmez bir "ölü
  // bölge" kalır (bkz. main.cjs poll döngüsü).
  useEffect(() => {
    (window as any).electronAPI?.setButtonVisible(isToggleButtonVisible);
  }, [isToggleButtonVisible]);

  // Pasif Mod'da butonun köşede olup olmadığını ana süreçten öğreniyoruz —
  // buton zaten görünmezken normal React hover eventleri bunu yakalayamaz,
  // çünkü o pikseller click-through modda ve DOM hiç mouse eventi almıyor.
  useEffect(() => {
    const cleanup = (window as any).electronAPI?.onCornerHover((isOver: boolean) => {
      setIsCornerHovered(isOver);
    });
    return () => cleanup && cleanup();
  }, []);

  // focusable:false tek başına yeterli olmadı: Gothic'in DirectInput'u
  // muhtemelen "foreground" iş birliği modunda, yani oyun kendisi ön planda
  // olmadığı sürece fiziksel klavyeyi tamamen görmezden geliyor — overlay'in
  // "aktif" sayılıp sayılmaması bundan bağımsız. Panel açıkken (makro
  // çalışmıyor, hedefleme yapılmıyorken) arka planda sürekli bir bekçi
  // koşturup oyunun ön planını geri kazandırıyoruz; böylece panel açıkken
  // vektör/plaka ayarlarını fareyle değiştirirken WASD oyuna gitmeye devam
  // eder. Makro çalışırken bekçiyi kapatıyoruz (main.cjs zaten yapıyor) —
  // aynı ALT-tap numarasını iki süreç birden kullanınca makronun kendi
  // zamanlaması bozulabilir.
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (isPanelOpen && !isTargeting && !isExecuting) {
      api?.startFocusGuard();
    } else {
      api?.stopFocusGuard();
    }
  }, [isPanelOpen, isTargeting, isExecuting]);

  const handleTargetClick = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Capture CAPTURE_SIZE x CAPTURE_SIZE at cursorPos
    const x = cursorPos.x - CAPTURE_SIZE / 2;
    const y = cursorPos.y - CAPTURE_SIZE / 2;

    canvas.width = CAPTURE_SIZE;
    canvas.height = CAPTURE_SIZE;
    ctx.drawImage(video, x, y, CAPTURE_SIZE, CAPTURE_SIZE, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);

    const data = ctx.getImageData(0, 0, CAPTURE_SIZE, CAPTURE_SIZE).data;
    setTargetTemplate(new Uint8ClampedArray(data));
    setTargetRect({ x, y });
    // Şablon tam olarak şu anki (kilit ekranı) görüntüden alındığı için
    // baştan "algılandı" say — ilk poll turuna kadar buton kaybolmasın.
    setIsLockScreenDetected(true);
    setIsTargeting(false);
    (window as any).electronAPI?.setOverlayInteractive(isPanelOpen);
  };

  useEffect(() => {
    (window as any).electronAPI?.setPanelState(isPanelOpen);
  }, [isPanelOpen]);

  useEffect(() => {
    (window as any).electronAPI?.setTargetingState(isTargeting);
  }, [isTargeting]);

  useEffect(() => {
    const cleanup = (window as any).electronAPI?.onTogglePanel(() => {
      setIsPanelOpen(prev => {
        const next = !prev;
        (window as any).electronAPI?.setOverlayInteractive(next || isTargeting);
        return next;
      });
    });
    return () => cleanup && cleanup();
  }, [isTargeting]);

  const startTargeting = () => {
    setIsPanelOpen(false);
    setIsTargeting(true);
    (window as any).electronAPI?.setOverlayInteractive(true);
  };

  // Plaka sayısı azaltılıp sonra tekrar artırılınca kenardaki (ör. F)
  // konum/vektör verisi unutulmasın diye dizileri KISALTMIYORUZ — sadece
  // gerektiğinde büyütüyoruz. Fazladan "gizli" kuyruk verisi zararsız
  // şekilde saklanır; hesaplama sırasında computeSolutionSteps zaten
  // sadece ilk `numPlates` elemanı kullanıyor.
  useEffect(() => {
    setStartState(prev => {
      if (prev.length >= numPlates) return prev;
      const next = [...prev];
      while (next.length < numPlates) next.push(0);
      return next;
    });

    setMovesMatrix(prev => {
      const size = Math.max(numPlates, prev.length, ...prev.map(row => row.length));
      if (prev.length >= size && prev.every(row => row.length >= size)) return prev;
      const next = [];
      for (let i = 0; i < size; i++) {
        const row = prev[i] ? [...prev[i]] : [];
        while (row.length < size) row.push(0);
        if (!prev[i]) row[i] = 1;
        next.push(row);
      }
      return next;
    });

    // Plaka sayısı değişince eski indekslere ait işaretler ve geçmiş anlamsız kalır.
    setCompletedPositions(new Set());
    setCompletedVectors(new Set());
    setHistory([]);
  }, [numPlates]);

  // Başlangıç konumu ve vektörleri değiştikçe kalıcı hale getir; uygulama
  // kapanıp yeniden açıldığında loadPersistedState() bunu geri okuyor.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ numPlates, startState, movesMatrix }));
    } catch {
      // localStorage kapalı/kotayı aşmış olabilir — sessizce yok say.
    }
  }, [numPlates, startState, movesMatrix]);

  // Pasif Mod ve tüm zaman ayarları da kalıcı — kapanış sonrası hatırlanır.
  useEffect(() => {
    try {
      const settings: PersistedSettings = {
        passiveMode,
        resetDelay,
        sendSpaceAfterSolve,
        spaceDelay,
        macroDelay,
        holdTime
      };
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // localStorage kapalı/kotayı aşmış olabilir — sessizce yok say.
    }
  }, [passiveMode, resetDelay, sendSpaceAfterSolve, spaceDelay, macroDelay, holdTime]);

  // Konum/vektör değiştiğinde önceden bulunmuş çözüm artık geçerli olmayabilir
  // (butonla veya Geri Al/Sıfırla ile — hepsi startState/movesMatrix'i değiştirir).
  useEffect(() => {
    setMacroSteps([]);
    setSolutionSummary([]);
    setCurrentStepIndex(-1);
  }, [startState, movesMatrix]);

  // Konum/vektör butonlarına her tıklamadan önce mevcut durumu kaydeder,
  // "Geri Al" bu yığından son durumu geri çıkarır.
  const pushHistory = () => {
    setHistory(prev => [...prev, { startState, movesMatrix }].slice(-50));
  };

  const undo = () => {
    setHistory(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setStartState(last.startState);
      setMovesMatrix(last.movesMatrix);
      return prev.slice(0, -1);
    });
  };

  const resetPositionsAndVectors = () => {
    pushHistory();
    setStartState(new Array(numPlates).fill(0));
    setMovesMatrix(buildIdentityMatrix(numPlates));
    setCompletedPositions(new Set());
    setCompletedVectors(new Set());
  };

  // onMacroFinished aboneliği tek seferlik (aşağıda) olduğu için Space
  // ayarlarını her render'da güncel tutan bir ref üzerinden okuyoruz —
  // yoksa kapanış (closure) ilk render'daki eski değerlerde takılı kalır.
  const settingsRef = useRef({ sendSpaceAfterSolve, spaceDelay, holdTime });
  useEffect(() => {
    settingsRef.current = { sendSpaceAfterSolve, spaceDelay, holdTime };
  });

  // Makro olayları uygulama ömrü boyunca tek sefer bağlanır; her çalıştırmada
  // yeniden abone olmak (eski kod) iptal/hata durumlarında dinleyici sızdırıyordu.
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) {
      setMacroError('electronAPI bulunamadı — preload yüklenmemiş.');
      return;
    }

    const offStep = api.onMacroStep?.((idx: number) => setCurrentStepIndex(idx));
    const offFocus = api.onMacroFocus?.((status: string) => setFocusStatus(status));
    const offFinished = api.onMacroFinished?.((info: MacroResult = { ok: true }) => {
      setIsExecuting(false);
      if (info && !info.ok) {
        if (info.error) setMacroError(info.cancelled ? null : info.error);
        return;
      }
      // Başarıyla bitti: "Kilit Açıldı" kutlaması + otomatik küçültme geri sayımı.
      setCompletionCountdown(2);

      // İsteğe bağlı: kilit açıldıktan sonra Space gönder. Bu, isExecuting/
      // completionCountdown akışının tamamen dışında, ayrı ve sessiz bir
      // yan-eylem — ana "makro bitti" event zincirine tekrar girmiyor
      // (aksi halde kutlama/geri sayım ikinci kez tetiklenirdi).
      const { sendSpaceAfterSolve: shouldSendSpace, spaceDelay: spaceWait, holdTime: hold } = settingsRef.current;
      if (shouldSendSpace) {
        setTimeout(() => {
          (window as any).electronAPI?.sendKey?.('space', { holdTime: hold });
        }, spaceWait);
      }
    });
    const offAbort = api.onMacroAbort?.(() => {
      setIsExecuting(false);
      setMacroError('Makro durduruldu (Alt+X).');
    });

    return () => {
      offStep?.();
      offFocus?.();
      offFinished?.();
      offAbort?.();
    };
  }, []);

  const handleStop = () => {
    (window as any).electronAPI?.cancelMacro();
    setIsExecuting(false);
  };

  // "Kilit Açıldı" kutlamasından sonra 3-2-1 geri sayıp paneli otomatik küçültür.
  useEffect(() => {
    if (completionCountdown === null) return;

    if (completionCountdown <= 0) {
      setIsPanelOpen(false);
      (window as any).electronAPI?.setOverlayInteractive(false);
      setCompletionCountdown(null);
      setMacroSteps([]);
      setSolutionSummary([]);
      setCurrentStepIndex(-1);
      return;
    }

    const timer = setTimeout(() => setCompletionCountdown(c => (c ?? 1) - 1), 1000);
    return () => clearTimeout(timer);
  }, [completionCountdown]);

  /** Çözümü hesaplayıp hem kısa özete hem tuş adımlarına çevirir; makroyu ÇALIŞTIRMAZ. */
  const computeSolutionSteps = (): { steps: MacroStep[]; compressed: CompressedMove[] } | null => {
    const moveNames = Array.from({length: numPlates}, (_, i) => String.fromCharCode(65 + i));
    // startState/movesMatrix, plaka sayısı azaltılıp artırılınca kenar
    // verisi unutulmasın diye numPlates'ten uzun kalabiliyor (gizli kuyruk) —
    // çözücüye yalnızca şu an aktif olan ilk numPlates eleman gidiyor.
    const activeStart = startState.slice(0, numPlates);
    const activeMatrix = movesMatrix.slice(0, numPlates).map(row => row.slice(0, numPlates));
    const res = LockSolver.solve(activeStart, activeMatrix, moveNames);

    if (!res.success) {
      setMacroError(res.error === 'Invalid Start State'
        ? 'Başlangıç konumları geçersiz (sınır dışı).'
        : 'Çözüm bulunamadı! Lütfen girdiğiniz vektörleri kontrol edin.');
      return null;
    }

    const steps: MacroStep[] = [];
    let currentIndex = 0; // We assume the pick always starts at Plate A (index 0)

    for (const move of res.compressed) {
      const targetIndex = move.name.charCodeAt(0) - 65;
      const directionStr = move.name.charAt(1); // "+" or "-"
      const count = move.count;
      const targetPlateName = String.fromCharCode(65 + targetIndex);

      // Navigate to target plate. Oyunda B plakasına geçiş W ile yapılıyor
      // (yani sonraki/daha derindeki plakaya W, öncekine S) — eskiden ters
      // eşleniyordu.
      if (targetIndex > currentIndex) {
        for (let i = 0; i < targetIndex - currentIndex; i++) {
          const reached = String.fromCharCode(65 + currentIndex + i + 1);
          steps.push({ key: 'w', desc: `${reached} plakasına iniliyor...`, kind: 'nav', plate: reached });
        }
      } else if (targetIndex < currentIndex) {
        for (let i = 0; i < currentIndex - targetIndex; i++) {
          const reached = String.fromCharCode(65 + currentIndex - i - 1);
          steps.push({ key: 's', desc: `${reached} plakasına çıkılıyor...`, kind: 'nav', plate: reached });
        }
      }
      currentIndex = targetIndex;

      // Push plate
      const pushKey = directionStr === '+' ? 'd' : 'a';
      const dirText = directionStr === '+' ? 'sağa' : 'sola';
      for (let i = 0; i < count; i++) {
        steps.push({ key: pushKey, desc: `${targetPlateName} plakası ${dirText} itiliyor...`, kind: 'push', plate: targetPlateName });
      }
    }

    if (steps.length === 0) {
      setMacroError('Kilit zaten çözülmüş durumda — gönderilecek tuş yok.');
      return null;
    }

    // Otomatik çöz her zaman R ile başlar: kilit önceden yarım bırakılmış
    // veya karışmış olabilir, R oyunun kendi reset tuşu (bkz. oyun içi
    // ipucu) — hesapladığımız çözüm her zaman A plakasından, sıfır konumdan
    // başladığını varsayıyor, bu yüzden gerçek durum garanti altına alınıyor.
    steps.unshift({ key: 'r', desc: 'Kilit sıfırlanıyor (R)...', kind: 'reset', plate: '' });

    return { steps, compressed: res.compressed };
  };

  /** "Çözümü Bul": kısa özeti gösterir, oyuna hiçbir tuş göndermez. */
  const handleFindSolution = () => {
    const result = computeSolutionSteps();
    if (!result) return;

    setMacroSteps(result.steps);
    setSolutionSummary(result.compressed);
    setCurrentStepIndex(-1);
    setMacroError(null);
  };

  /** Bulunmuş adımları makro olarak oyuna gönderip yürütmeye başlar. */
  const beginExecution = (steps: MacroStep[]) => {
    setCurrentStepIndex(-1);
    setFocusStatus(null);
    setMacroError(null);
    setIsExecuting(true);

    // Odağı oyuna vermeyi artık ana süreç üstleniyor (bkz. macro.cjs);
    // burada ayrıca beklemeye gerek yok.
    (window as any).electronAPI?.executeMacro(steps, {
      delay: macroDelay,
      holdTime,
      resetDelay
    });
  };

  /**
   * "Otomatik Çöz": önce "Çöz" ile bir çözüm bulunmuş olması gerekmez —
   * her tıklamada çözümü yeniden hesaplayıp hiç beklemeden doğrudan
   * uygulamaya geçer.
   */
  const handleAutoSolve = () => {
    const result = computeSolutionSteps();
    if (!result) return;

    setMacroSteps(result.steps);
    setSolutionSummary(result.compressed);
    beginExecution(result.steps);
  };

  const lockedTitle = 'Çözüm uygulanırken değiştirilemez';

  const staggerDelay = (i: number) => ({
    animationDelay: `calc(var(--tk-stagger) * min(${i}, var(--tk-stagger-max)))`
  });

  const renderPositionButton = (plateIndex: number, displayVal: number) => {
    const isSelected = startState[plateIndex] === displayVal;
    return (
      <button
        key={displayVal}
        onClick={() => {
          if (isSelected) return;
          pushHistory();
          const next = [...startState];
          next[plateIndex] = displayVal;
          setStartState(next);
        }}
        disabled={isExecuting}
        title={isExecuting ? lockedTitle : `${String.fromCharCode(65 + plateIndex)} plakası: ${displayVal}`}
        aria-pressed={isSelected}
        className="g-cell g-cell-square"
      >
        {displayVal > 0 ? `+${displayVal}` : displayVal}
      </button>
    );
  };

  const renderMoveButton = (moveIndex: number, affectedIndex: number) => {
    const row = movesMatrix[moveIndex] || Array(numPlates).fill(0);
    const val = row[affectedIndex] || 0;

    if (moveIndex === affectedIndex) {
      return (
        <div key={affectedIndex} className="g-self flex-1">
          <ArrowRight size={14} aria-hidden="true" />
        </div>
      );
    }

    let icon = <Circle size={6} fill="currentColor" aria-hidden="true" />;
    let label = 'Yok';
    if (val === 1) {
      icon = <ArrowRight size={14} aria-hidden="true" />;
      label = 'Aynı';
    } else if (val === -1) {
      icon = <ArrowLeftRight size={14} aria-hidden="true" />;
      label = 'Ters';
    }

    return (
      <button
        key={affectedIndex}
        disabled={isExecuting}
        title={isExecuting ? lockedTitle : `${String.fromCharCode(65 + moveIndex)} → ${String.fromCharCode(65 + affectedIndex)}: ${label}`}
        aria-label={`${String.fromCharCode(65 + moveIndex)} → ${String.fromCharCode(65 + affectedIndex)}: ${label}`}
        data-val={val}
        onClick={() => {
          pushHistory();
          const next = [...movesMatrix];
          const row = next[moveIndex] ? [...next[moveIndex]] : Array(numPlates).fill(0);
          if (val === 0) row[affectedIndex] = 1;
          else if (val === 1) row[affectedIndex] = -1;
          else row[affectedIndex] = 0;
          next[moveIndex] = row;
          setMovesMatrix(next);
        }}
        className="g-cell flex-1"
      >
        {icon}
      </button>
    );
  };

  const renderSwitch = (checked: boolean, onToggle: () => void, title: string) => (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      title={title}
      aria-label={title}
      className="g-switch"
    >
      <span className="g-switch-thumb" />
    </button>
  );

  const renderSlider = (
    Icon: typeof Clock,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void
  ) => (
    <div className="flex items-center gap-4">
      <Icon size={16} className="text-[var(--tk-renk-1)] shrink-0" aria-hidden="true" />
      <label className="flex-1 flex flex-col gap-1">
        <span className="g-label">{label}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value))}
          data-tk="slider"
          className="g-range"
        />
      </label>
      <div className="w-16 text-right g-value">{value}ms</div>
    </div>
  );

  return (
    <div id="root-container" className="w-screen h-screen overflow-hidden text-[var(--tk-text)]">
      <video ref={videoRef} className="hidden" muted />
      <canvas ref={canvasRef} className="hidden" />

      {isTargeting && (
        <div
          className="fixed inset-0 z-50 cursor-crosshair bg-[color-mix(in_srgb,var(--tk-surface)_10%,transparent)]"
          onMouseMove={(e) => setCursorPos({ x: e.clientX, y: e.clientY })}
          onClick={handleTargetClick}
        >
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="g-panel g-enter text-tk-3 text-[var(--tk-text)]">
              Kilit ekranından ayırt edici bir köşeye tıklayın (örn: zorluk yazısı)
            </div>
          </div>
          <div
            className="absolute border-[length:var(--tk-focus-w)] border-[var(--tk-renk-2)] pointer-events-none"
            style={{
              width: CAPTURE_SIZE,
              height: CAPTURE_SIZE,
              left: cursorPos.x - CAPTURE_SIZE / 2,
              top: cursorPos.y - CAPTURE_SIZE / 2
            }}
          />
        </div>
      )}

      {!isTargeting && isToggleButtonVisible && (
        <div className="absolute top-2 left-2 z-50">
          <button
            onClick={() => {
              setIsPanelOpen(!isPanelOpen);
              (window as any).electronAPI?.setOverlayInteractive(!isPanelOpen || isTargeting);
            }}
            aria-expanded={isPanelOpen}
            aria-label={isPanelOpen ? 'Paneli küçült' : 'Paneli aç'}
            title={isPanelOpen ? 'Paneli küçült' : 'Paneli aç'}
            className="g-corner"
          >
            {isPanelOpen ? <Minus size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
          </button>
        </div>
      )}

      <div
        className="g-panel absolute top-20 left-4 bottom-4 w-[450px] flex flex-col overflow-hidden"
        style={{ transform: isPanelOpen ? 'translateX(0)' : 'translateX(-120%)' }}
      >
        <div className="flex items-center justify-between mb-6 pb-4 g-rule-bottom shrink-0">
          <h2 className="g-h2">Kilit çözücü (F9)</h2>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 g-decor-frame p-1">
              <span className="g-label px-2">Plaka:</span>
              <button
                disabled={isExecuting}
                title={isExecuting ? lockedTitle : 'Plaka sayısını azalt'}
                onClick={() => setNumPlates(Math.max(2, numPlates - 1))}
                aria-label="Plaka sayısını azalt"
                data-tk="icon-button"
                className="g-icon-btn"
              ><ChevronLeft size={16} aria-hidden="true" /></button>
              <div className="g-value w-5 text-center">{numPlates}</div>
              <button
                disabled={isExecuting}
                title={isExecuting ? lockedTitle : 'Plaka sayısını artır'}
                onClick={() => setNumPlates(Math.min(12, numPlates + 1))}
                aria-label="Plaka sayısını artır"
                data-tk="icon-button"
                className="g-icon-btn"
              ><ChevronRight size={16} aria-hidden="true" /></button>
            </div>

            <button
              title="Programdan çık"
              aria-label="Programdan çık"
              onClick={() => (window as any).electronAPI?.quitApp()}
              data-tk="icon-button"
              className="g-icon-btn w-8 h-8"
            >
              <Power size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {(isExecuting || completionCountdown !== null) ? (
          <div className="flex-1 flex flex-col gap-4 g-enter">
            {completionCountdown !== null ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--tk-success)]" role="status">
                <CheckCircle2 size={56} aria-hidden="true" />
                <div className="text-tk-4">Kilit açıldı!</div>
                <div className="g-hint font-mono">
                  Otomatik küçültülüyor… {completionCountdown}
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-2">
                  <Terminal size={20} className="text-[var(--tk-renk-2-text)]" aria-hidden="true" />
                  <h3 className="g-h3">Çözüm uygulanıyor…</h3>
                  <span className="ml-auto tk-hero" role="status" aria-live="polite">
                    {completedHamleCount}/{totalHamleCount}
                  </span>
                </div>

                {(focusStatus === 'none' || focusStatus === 'fail') && (
                  <div className="g-warn g-hint flex items-start gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-1" aria-hidden="true" />
                    <span>
                      {focusStatus === 'none'
                        ? 'Uyarı: Gothic penceresi bulunamadı — tuşlar o an ön planda olan pencereye gidiyor.'
                        : 'Uyarı: oyun penceresine odak verilemedi — tuşlar oyuna ulaşmayabilir.'}
                    </span>
                  </div>
                )}
                <div className="flex-1 g-decor-frame overflow-hidden relative">
                  <div className="absolute inset-0 overflow-auto flex flex-col gap-2 p-4">
                    {groupStepsForDisplay(macroSteps).map((group, idx) => {
                      const isDone = currentStepIndex > group.endIndex;
                      const isCurrent = !isDone && currentStepIndex >= group.startIndex;
                      const setActiveRef = isCurrent ? (el: HTMLDivElement | null) => { activeGroupRef.current = el; } : undefined;
                      const state = isCurrent ? 'current' : isDone ? 'done' : 'pending';

                      if (group.type === 'push') {
                        return (
                          <div
                            key={idx}
                            ref={setActiveRef}
                            data-state={state}
                            className="g-step g-step-push g-enter"
                            style={staggerDelay(idx)}
                          >
                            {isDone && <CheckCircle2 size={18} className="shrink-0" aria-hidden="true" />}
                            {group.count}x {group.plate}{group.sign}
                          </div>
                        );
                      }

                      return (
                        <div
                          key={idx}
                          ref={setActiveRef}
                          data-state={state}
                          className="g-step g-step-nav g-enter"
                          style={staggerDelay(idx)}
                        >
                          <span className="w-3 shrink-0" aria-hidden="true">{isDone ? '✓' : isCurrent ? '›' : '·'}</span>
                          <span>{group.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-auto flex flex-col gap-8 pb-4 pr-2 g-enter">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h3 className="g-h3">1. Başlangıç konumları</h3>
                <div className="flex items-center gap-3">
                  <button
                    disabled={isExecuting || history.length === 0}
                    onClick={undo}
                    title={isExecuting ? lockedTitle : history.length === 0 ? 'Geri alınacak değişiklik yok' : 'Son değişikliği geri al'}
                    className="g-link"
                  >
                    <Undo2 size={14} aria-hidden="true" />
                    Geri al
                  </button>
                  <button
                    disabled={isExecuting}
                    onClick={resetPositionsAndVectors}
                    title={isExecuting ? lockedTitle : 'Konumları ve vektörleri sıfırla'}
                    className="g-link"
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    Sıfırla
                  </button>
                </div>
              </div>

              <div className="flex">
                <div className="flex flex-col mr-3 gap-2">
                  {Array.from({length: numPlates}).map((_, i) => (
                    <button
                      key={i}
                      onClick={() => toggleInSet(setCompletedPositions, i)}
                      title={completedPositions.has(i) ? 'Tamamlandı işaretini kaldır' : 'Bu plakayı tamamlandı işaretle'}
                      data-letter
                      data-done={completedPositions.has(i)}
                      className="g-cell g-cell-square"
                    >
                      {String.fromCharCode(65 + i)}
                    </button>
                  ))}
                </div>
                <div className="flex flex-col gap-2">
                  {Array.from({length: numPlates}).map((_, i) => (
                    <div key={i} className="flex gap-1">
                      {[-3, -2, -1, 0, 1, 2, 3].map(pos => renderPositionButton(i, pos))}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="w-full g-rule"></div>

            <div className="flex flex-col gap-4">
              <h3 className="g-h3">2. Etkileşim yönleri</h3>

              <div className="flex">
                <div className="flex flex-col mr-3 gap-2">
                  <div className="g-label h-6 flex flex-col justify-end pb-1">Hareket</div>
                  {Array.from({length: numPlates}).map((_, i) => (
                    <button
                      key={i}
                      onClick={() => toggleInSet(setCompletedVectors, i)}
                      title={completedVectors.has(i) ? 'Tamamlandı işaretini kaldır' : 'Bu plakayı tamamlandı işaretle'}
                      data-letter
                      data-done={completedVectors.has(i)}
                      className="g-cell g-cell-square"
                    >
                      {String.fromCharCode(65 + i)}
                    </button>
                  ))}
                </div>

                <div className="flex flex-col gap-2 w-76">
                  <div className="flex gap-1 h-6 items-end pb-1">
                    {Array.from({length: numPlates}).map((_, col) => (
                      <div key={col} className="flex-1 text-center g-value">
                        {String.fromCharCode(65 + col)}
                      </div>
                    ))}
                  </div>

                  {Array.from({length: numPlates}).map((_, row) => (
                    <div key={row} className="flex gap-1 w-full">
                      {Array.from({length: numPlates}).map((_, col) => renderMoveButton(row, col))}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-4 items-center justify-center g-label g-decor-frame p-2 mt-2">
                <div className="flex items-center gap-1"><Circle size={6} fill="currentColor" className="text-[var(--tk-border)]" aria-hidden="true" /> Yok</div>
                <div className="flex items-center gap-1"><ArrowRight size={14} className="text-[var(--tk-renk-1)]" aria-hidden="true" /> Aynı</div>
                <div className="flex items-center gap-1"><ArrowLeftRight size={14} className="text-[var(--tk-renk-2-text)]" aria-hidden="true" /> Ters</div>
              </div>

              <div className="flex flex-col gap-4">
                <h3 className="g-h3">3. Makro zamanlaması</h3>
                <div className="flex flex-col gap-4 g-decor-box">
                  {renderSlider(Clock, 'Tuşlar arası bekleme', macroDelay, 50, 1000, 10, setMacroDelay)}
                  {renderSlider(Timer, 'Tuş basılı kalma süresi', holdTime, 20, 250, 5, setHoldTime)}
                  {renderSlider(RotateCcw, 'R sonrası ek bekleme', resetDelay, 0, 3000, 50, setResetDelay)}

                  <p className="g-hint">
                    Tuşlar (W A S D) DirectInput uyumlu tarama kodlarıyla (SendInput) gönderilir.
                    Gothic tuşları atlıyorsa basılı kalma süresini, animasyona yetişemiyorsa
                    bekleme süresini artırın. Otomatik çöz, oyunun R (sıfırlama) tuşuyla
                    başlar; kilit gerçekten sıfırlanana kadar üstteki ek bekleme uygulanır.
                    Acil durdurma: <span className="g-value">Alt+X</span>.
                  </p>

                  <div className="w-full g-rule"></div>

                  <div className="flex items-center justify-between gap-4">
                    <span className="g-label">Kilit açıldıktan sonra Space gönder</span>
                    {renderSwitch(sendSpaceAfterSolve, () => setSendSpaceAfterSolve(v => !v), sendSpaceAfterSolve ? 'Space göndermeyi kapat' : 'Space göndermeyi aç')}
                  </div>

                  {sendSpaceAfterSolve && (
                    <div className="g-enter">
                      {renderSlider(Clock, 'Space öncesi bekleme', spaceDelay, 0, 3000, 50, setSpaceDelay)}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-4">
                <h3 className="g-h3">4. Auto Mod (hedef belirle)</h3>
                <div className="flex items-center justify-between gap-4 g-decor-box">
                  <div className="g-hint">
                    {!targetTemplate
                      ? 'Programın oyunda yer kaplamaması için kilit ekranından bir köşe şablonu belirleyin.'
                      : autoHideEnabled
                        ? 'Hedef şablon aktif. Kilit ekranı harici gizlenilecek.'
                        : 'Hedef şablon kayıtlı ama Auto Mod kapalı — buton her zaman görünür kalır.'}
                  </div>
                  <button
                    disabled={isExecuting}
                    onClick={startTargeting}
                    title={isExecuting ? lockedTitle : 'Kilit ekranında hedef köşe seç'}
                    aria-label="Kilit ekranında hedef köşe seç"
                    data-tk="icon-button"
                    className="g-icon-btn g-icon-btn-accent shrink-0 w-10 h-10"
                  >
                    <Crosshair size={18} aria-hidden="true" />
                  </button>
                </div>

                {targetTemplate && (
                  <div className="flex items-center justify-between gap-4 g-decor-box g-enter">
                    <span className="g-label">Auto Mod'u etkinleştir</span>
                    {renderSwitch(autoHideEnabled, () => setAutoHideEnabled(v => !v), autoHideEnabled ? "Auto Mod'u kapat" : "Auto Mod'u aç")}
                  </div>
                )}

                <div className="flex items-center justify-between gap-4 g-decor-box">
                  <div className="flex flex-col gap-1">
                    <div className="g-label">Pasif Mod</div>
                    <div className="g-hint">
                      Panel kapalıyken köşe butonu tamamen gizlenir; sadece fare o köşeye
                      gelince görünür. Açmak için F9 veya köşeye gelip tıklama.
                    </div>
                  </div>
                  {renderSwitch(passiveMode, () => setPassiveMode(v => !v), passiveMode ? 'Pasif Modu kapat' : 'Pasif Modu aç')}
                </div>
              </div>
            </div>
          </div>
        )}

        {!isExecuting && completionCountdown === null && solutionSummary.length > 0 && (
          <div className="mt-4 g-decor-box border-[var(--tk-border)] flex flex-col gap-3 shrink-0 g-enter">
            <div className="flex flex-wrap gap-2">
              {solutionSummary.map((move, idx) => (
                <span key={idx} className="g-chip g-enter" style={staggerDelay(idx)}>
                  {move.count}x {move.name}
                </span>
              ))}
            </div>
            <div className="g-value text-right">
              Toplam {solutionSummary.reduce((sum, m) => sum + m.count, 0)} hamle
            </div>
          </div>
        )}

        <div className="mt-6 pt-4 g-rule shrink-0 flex flex-col gap-3">
          {macroError && !isExecuting && (
            <div className="g-error g-hint flex items-start gap-2" role="alert">
              <AlertTriangle size={14} className="shrink-0 mt-1" aria-hidden="true" />
              <span className="flex-1">{macroError}</span>
              <button
                onClick={() => setMacroError(null)}
                title="Hatayı kapat"
                aria-label="Hatayı kapat"
                data-tk="icon-button"
                className="g-icon-btn"
              >✕</button>
            </div>
          )}

          {completionCountdown !== null ? null : isExecuting ? (
            <button onClick={handleStop} className="tk-btn tk-btn-danger w-full">
              <Square size={18} fill="currentColor" aria-hidden="true" />
              Durdur (Alt+X)
            </button>
          ) : (
            <div className="flex gap-3">
              <button onClick={handleFindSolution} className="tk-btn tk-btn-ghost w-2/5">
                <Search size={16} aria-hidden="true" />
                Çöz
              </button>
              <button onClick={handleAutoSolve} className="tk-btn tk-btn-primary w-3/5">
                <Play size={18} fill="currentColor" aria-hidden="true" />
                Otomatik çöz
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
