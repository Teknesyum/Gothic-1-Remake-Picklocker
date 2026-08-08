import { useState, useEffect, useRef } from 'react';
import { Play, ArrowRight, ArrowLeftRight, Circle, ChevronLeft, ChevronRight, Terminal, Clock, Crosshair, Menu, Minus, Square, Timer, AlertTriangle, Power, RotateCcw, Undo2, Search, CheckCircle2 } from 'lucide-react';
import { LockSolver } from './LockSolver';

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
  const [macroDelay, setMacroDelay] = useState(250);
  const [holdTime, setHoldTime] = useState(60);
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
  const [passiveMode, setPassiveMode] = useState(false);
  const [isCornerHovered, setIsCornerHovered] = useState(false);
  const isToggleButtonVisible = isButtonVisible && (!passiveMode || isPanelOpen || isCornerHovered);

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

  useEffect(() => {
    setStartState(prev => {
      const next = [...prev];
      while(next.length < numPlates) next.push(0);
      return next.slice(0, numPlates);
    });

    setMovesMatrix(prev => {
      const next = [];
      for (let i = 0; i < numPlates; i++) {
        const row = prev[i] ? [...prev[i]] : Array(numPlates).fill(0);
        while(row.length < numPlates) row.push(0);
        if (!prev[i]) row[i] = 1;
        next.push(row.slice(0, numPlates));
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
    const res = LockSolver.solve(startState, movesMatrix, moveNames);

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
      holdTime
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
        className={`w-10 h-10 rounded flex items-center justify-center font-mono text-xs transition-all duration-200 cursor-pointer ${
          isSelected 
            ? 'bg-[var(--color-neon-blue)]/20 border border-[var(--color-neon-blue)]/50 text-[var(--color-neon-blue)] shadow-[0_0_8px_var(--color-neon-blue)_inset]' 
            : 'bg-black/40 border border-transparent text-gray-500 hover:border-gray-600'
        } ${isExecuting ? 'opacity-50 cursor-not-allowed' : ''}`}
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
        <div key={affectedIndex} className="flex-1 h-10 rounded flex items-center justify-center border transition-all duration-200 bg-[var(--color-neon-blue)]/10 border-[var(--color-neon-blue)]/30 shadow-[0_0_5px_var(--color-neon-blue)_inset]">
          <ArrowRight size={14} className="text-[var(--color-neon-blue)]" />
        </div>
      );
    }

    let icon = <Circle size={6} className="fill-gray-700 text-gray-700" />;
    let style = "bg-black/20 border-transparent text-gray-700 hover:border-gray-600 cursor-pointer";
    
    if (val === 1) {
      icon = <ArrowRight size={14} className="text-[var(--color-neon-blue)]" />;
      style = "bg-[var(--color-neon-blue)]/10 border-[var(--color-neon-blue)]/30 shadow-[0_0_5px_var(--color-neon-blue)_inset] cursor-pointer";
    } else if (val === -1) {
      icon = <ArrowLeftRight size={14} className="text-[var(--color-neon-pink)]" />;
      style = "bg-[var(--color-neon-pink)]/10 border-[var(--color-neon-pink)]/30 shadow-[0_0_5px_var(--color-neon-pink)_inset] cursor-pointer";
    }

    return (
      <button 
        key={affectedIndex}
        disabled={isExecuting}
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
        className={`flex-1 h-10 rounded flex items-center justify-center border transition-all duration-200 ${style} ${isExecuting ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {icon}
      </button>
    );
  };

  return (
    <div id="root-container" className="w-screen h-screen bg-transparent overflow-hidden font-sans text-gray-300">
      
      {/* Hidden Media Elements */}
      <video ref={videoRef} className="hidden" muted />
      <canvas ref={canvasRef} className="hidden" />

      {/* Targeting Overlay */}
      {isTargeting && (
        <div 
          className="fixed inset-0 z-50 cursor-crosshair bg-black/10"
          onMouseMove={(e) => setCursorPos({ x: e.clientX, y: e.clientY })}
          onClick={handleTargetClick}
        >
           <div className="absolute inset-0 flex items-center justify-center text-[var(--color-neon-pink)] drop-shadow-[0_0_5px_var(--color-neon-pink)] font-bold text-xl pointer-events-none animate-pulse">
              Kilit ekranından ayırt edici bir köşeye tıklayın (Örn: Zorluk yazısı)
           </div>
           <div
             className="absolute border-2 border-[var(--color-neon-pink)] shadow-[0_0_15px_var(--color-neon-pink)] pointer-events-none"
             style={{
               width: CAPTURE_SIZE,
               height: CAPTURE_SIZE,
               left: cursorPos.x - CAPTURE_SIZE / 2,
               top: cursorPos.y - CAPTURE_SIZE / 2
             }}
           />
        </div>
      )}

      {/* Toggle Button: targeting sırasında her zaman gizli; Auto Mod
          kurulduysa yalnızca kilit ekranı algılandığında görünür; Pasif
          Mod açıksa panel kapalıyken de fare köşeye gelmedikçe gizli
          kalır. Panelin açık/kapalı durumunu değiştirmez, sadece bu
          butonu gösterir/gizler. */}
      {!isTargeting && isToggleButtonVisible && (
        <div className="absolute top-2 left-2 z-50">
          <button 
            onClick={() => {
              setIsPanelOpen(!isPanelOpen);
              (window as any).electronAPI?.setOverlayInteractive(!isPanelOpen || isTargeting);
            }}
            className={`p-3 rounded-xl border transition-all duration-300 shadow-2xl backdrop-blur-md flex items-center justify-center ${
              isPanelOpen
                ? 'bg-[var(--color-neon-blue)] border-[var(--color-neon-blue)] text-black hover:bg-[var(--color-neon-blue)]/80 hover:scale-110 shadow-[0_0_20px_var(--color-neon-blue)]'
                : 'bg-[#08090a]/95 border-gray-700 text-gray-400 hover:bg-gray-800'
            }`}
          >
            {isPanelOpen ? <Minus size={24} /> : <Menu size={24} />}
          </button>
        </div>
      )}

      {/* Slide-out Control Panel */}
      <div
        className="absolute top-20 left-4 bottom-4 w-[450px] bg-[#08090a]/95 backdrop-blur-xl border border-[var(--color-neon-blue)]/20 rounded-2xl p-6 shadow-[0_0_40px_rgba(0,0,0,0.8)] flex flex-col transition-transform duration-500 overflow-hidden"
        // Tailwind'in ayrık `translate-x-*` sınıfları (Tailwind v4'te modern
        // CSS `translate` özelliğini kullanıyor) bu Electron/Chromium
        // yapısında güvenilmez davranış gösterdi: sınıf `translate-x-0`
        // olarak doğru uygulansa bile hesaplanan stil eski değerde
        // ("-120%") takılı kalabiliyordu, panel görsel olarak kapalı
        // konumda sıkışıp içerik üst üste biniyordu. Klasik ve her yerde
        // güvenilir olan `transform: translateX()` ile satır içi stil
        // kullanmak bu belirsizliği tamamen ortadan kaldırıyor.
        style={{ transform: isPanelOpen ? 'translateX(0)' : 'translateX(-120%)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-800 shrink-0">
          <h2 className="text-[var(--color-neon-blue)] font-bold tracking-widest text-lg drop-shadow-[0_0_5px_var(--color-neon-blue)]">
            KİLİT ÇÖZÜCÜ (F9)
          </h2>
          
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-black/40 rounded-lg p-1 border border-gray-800">
              <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest px-2">Plaka:</span>
              <button
                disabled={isExecuting}
                onClick={() => setNumPlates(Math.max(2, numPlates - 1))}
                className="w-6 h-6 rounded flex items-center justify-center hover:bg-gray-800 transition-colors disabled:opacity-50"
              ><ChevronLeft size={16}/></button>
              <div className="font-mono text-sm font-bold w-4 text-center text-[var(--color-neon-pink)] drop-shadow-[0_0_5px_var(--color-neon-pink)]">{numPlates}</div>
              <button
                disabled={isExecuting}
                onClick={() => setNumPlates(Math.min(12, numPlates + 1))}
                className="w-6 h-6 rounded flex items-center justify-center hover:bg-gray-800 transition-colors disabled:opacity-50"
              ><ChevronRight size={16} /></button>
            </div>

            <button
              title="Programdan çık"
              onClick={() => (window as any).electronAPI?.quitApp()}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-[var(--color-neon-pink)] hover:bg-[var(--color-neon-pink)]/10 border border-transparent hover:border-[var(--color-neon-pink)]/30 transition-all"
            >
              <Power size={16} />
            </button>
          </div>
        </div>

        {/* Console / Execution View */}
        {(isExecuting || completionCountdown !== null) ? (
          <div className="flex-1 flex flex-col gap-4 animate-in fade-in duration-300">
            {completionCountdown !== null ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-emerald-400">
                <CheckCircle2 size={56} className="drop-shadow-[0_0_10px_rgba(52,211,153,0.6)]" />
                <div className="text-2xl font-bold tracking-widest drop-shadow-[0_0_8px_rgba(52,211,153,0.5)]">
                  KİLİT AÇILDI!
                </div>
                <div className="text-sm text-gray-400 font-mono">
                  Otomatik küçültülüyor... {completionCountdown}
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 text-[var(--color-neon-pink)] mb-2">
                  <Terminal size={20} className="animate-pulse" />
                  <h3 className="font-mono font-bold tracking-widest uppercase drop-shadow-[0_0_5px_var(--color-neon-pink)]">
                    Çözüm Uygulanıyor...
                  </h3>
                  <span className="ml-auto font-mono text-lg font-black text-[var(--color-neon-blue)] drop-shadow-[0_0_8px_var(--color-neon-blue)]">
                    {completedHamleCount}/{totalHamleCount}
                  </span>
                </div>

                {(focusStatus === 'none' || focusStatus === 'fail') && (
                  <div className="flex items-start gap-2 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                    <AlertTriangle size={14} className="shrink-0 mt-px" />
                    <span>
                      {focusStatus === 'none'
                        ? 'Gothic penceresi bulunamadı — tuşlar o an ön planda olan pencereye gidiyor.'
                        : 'Oyun penceresine odak verilemedi — tuşlar oyuna ulaşmayabilir.'}
                    </span>
                  </div>
                )}
                <div className="flex-1 bg-black/50 border border-gray-800 rounded-xl p-4 overflow-hidden relative">
                  <div className="absolute inset-0 overflow-auto flex flex-col gap-2 p-4 custom-scrollbar">
                    {groupStepsForDisplay(macroSteps).map((group, idx) => {
                      const isDone = currentStepIndex > group.endIndex;
                      const isCurrent = !isDone && currentStepIndex >= group.startIndex;
                      const setActiveRef = isCurrent ? (el: HTMLDivElement | null) => { activeGroupRef.current = el; } : undefined;

                      if (group.type === 'push') {
                        // Asıl "hamle": büyük, neon, göze çarpan rozet.
                        const statusClass = isCurrent
                          ? 'text-[var(--color-neon-blue)] border-[var(--color-neon-blue)] shadow-[0_0_16px_rgba(0,243,255,0.5)] scale-105'
                          : isDone
                            ? 'text-emerald-400/70 border-emerald-400/30'
                            : 'text-gray-500 border-gray-700';
                        return (
                          <div
                            key={idx}
                            ref={setActiveRef}
                            className={`flex items-center gap-2 font-mono font-black text-2xl px-3 py-1.5 rounded-lg border bg-black/40 transition-all duration-300 ${statusClass}`}
                          >
                            {isDone && <CheckCircle2 size={18} className="shrink-0" />}
                            {group.count}x {group.plate}{group.sign}
                          </div>
                        );
                      }

                      // reset / nav: destekleyici bilgi, küçük ve soluk kalsın.
                      const mutedClass = isCurrent
                        ? 'text-[var(--color-neon-pink)]'
                        : isDone
                          ? 'text-gray-600'
                          : 'text-gray-700';
                      return (
                        <div key={idx} ref={setActiveRef} className={`flex items-center gap-2 font-mono text-[10px] pl-1 transition-colors duration-300 ${mutedClass}`}>
                          <span className="w-3 shrink-0">{isDone ? '✓' : isCurrent ? '›' : '·'}</span>
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
          /* Normal Scrollable Content */
          <div className="flex-1 overflow-auto flex flex-col gap-8 pb-4 pr-2 custom-scrollbar">
            {/* Section 1: Initial States */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold tracking-widest text-gray-400 uppercase">
                  1. Başlangıç Konumları
                </h3>
                <div className="flex items-center gap-3">
                  <button
                    disabled={isExecuting || history.length === 0}
                    onClick={undo}
                    title="Son değişikliği geri al"
                    className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-[var(--color-neon-blue)] uppercase tracking-widest transition-colors disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <Undo2 size={12} />
                    Geri Al
                  </button>
                  <button
                    disabled={isExecuting}
                    onClick={resetPositionsAndVectors}
                    title="Konumları ve vektörleri sıfırla"
                    className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-[var(--color-neon-blue)] uppercase tracking-widest transition-colors disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <RotateCcw size={12} />
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
                      className={`w-10 h-10 rounded flex items-center justify-center text-xs font-mono font-bold transition-all cursor-pointer ${
                        completedPositions.has(i)
                          ? 'text-emerald-400 ring-2 ring-inset ring-emerald-400/70 shadow-[0_0_8px_rgba(52,211,153,0.5)]'
                          : 'text-[var(--color-neon-blue)] hover:ring-1 hover:ring-inset hover:ring-[var(--color-neon-blue)]/40'
                      }`}
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

            <div className="w-full h-px bg-gray-800/50"></div>

            {/* Section 2: Vectors */}
            <div className="flex flex-col gap-4">
              <h3 className="text-sm font-bold tracking-widest text-gray-400 uppercase">
                2. Etkileşim Yönleri
              </h3>
              
              <div className="flex">
                <div className="flex flex-col mr-3 gap-2">
                  <div className="text-[9px] text-gray-500 uppercase tracking-widest h-6 flex flex-col justify-end pb-1">
                    Hareket
                  </div>
                  {Array.from({length: numPlates}).map((_, i) => (
                    <button
                      key={i}
                      onClick={() => toggleInSet(setCompletedVectors, i)}
                      title={completedVectors.has(i) ? 'Tamamlandı işaretini kaldır' : 'Bu plakayı tamamlandı işaretle'}
                      className={`w-10 h-10 rounded flex items-center justify-center text-xs font-bold transition-all cursor-pointer ${
                        completedVectors.has(i)
                          ? 'text-emerald-400 ring-2 ring-inset ring-emerald-400/70 shadow-[0_0_8px_rgba(52,211,153,0.5)]'
                          : 'text-[var(--color-neon-blue)] hover:ring-1 hover:ring-inset hover:ring-[var(--color-neon-blue)]/40'
                      }`}
                    >
                      {String.fromCharCode(65 + i)}
                    </button>
                  ))}
                </div>

                {/* Sabit genişlik (304px = 1. Bölüm'deki 7 sütunluk -3..+3
                    ızgarasıyla aynı: 7*40px + 6*4px boşluk), hücreler
                    flex-1 ile bu genişliği plaka sayısına göre eşit paylaşır
                    — aksi halde plaka sayısı 7'den azken sağda boş alan kalıyordu. */}
                <div className="flex flex-col gap-2 w-[304px]">
                  <div className="flex gap-1 h-6 items-end pb-1">
                    {Array.from({length: numPlates}).map((_, col) => (
                      <div key={col} className="flex-1 text-center text-xs font-mono text-[var(--color-neon-pink)]">
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
              
              {/* Legend */}
              <div className="flex gap-4 items-center justify-center text-[10px] text-gray-500 mt-2 bg-black/20 p-2 rounded">
                <div className="flex items-center gap-1"><Circle size={6} className="fill-gray-600" /> Yok</div>
                <div className="flex items-center gap-1"><ArrowRight size={10} className="text-[var(--color-neon-blue)]" /> Aynı</div>
                <div className="flex items-center gap-1"><ArrowLeftRight size={10} className="text-[var(--color-neon-pink)]" /> Ters</div>
              </div>
              {/* Section 3: Macro Settings */}
              <div className="flex flex-col gap-4">
                <h3 className="text-sm font-bold tracking-widest text-gray-400 uppercase">
                  3. Makro Zamanlaması
                </h3>
                <div className="flex flex-col gap-4 bg-black/20 p-4 rounded-xl border border-gray-800/50">
                   <div className="flex items-center gap-4">
                     <Clock size={16} className="text-[var(--color-neon-blue)] shrink-0" />
                     <div className="flex-1 flex flex-col gap-1">
                       <span className="text-[9px] text-gray-500 uppercase tracking-widest">Tuşlar arası bekleme</span>
                       <input
                         type="range"
                         min="50"
                         max="1000"
                         step="10"
                         value={macroDelay}
                         onChange={(e) => setMacroDelay(parseInt(e.target.value))}
                         className="w-full accent-[var(--color-neon-blue)] h-1 bg-gray-700 rounded-full appearance-none outline-none"
                       />
                     </div>
                     <div className="w-16 text-right font-mono text-sm text-[var(--color-neon-pink)] drop-shadow-[0_0_3px_var(--color-neon-pink)]">
                       {macroDelay}ms
                     </div>
                   </div>

                   <div className="flex items-center gap-4">
                     <Timer size={16} className="text-[var(--color-neon-blue)] shrink-0" />
                     <div className="flex-1 flex flex-col gap-1">
                       <span className="text-[9px] text-gray-500 uppercase tracking-widest">Tuş basılı kalma süresi</span>
                       <input
                         type="range"
                         min="20"
                         max="250"
                         step="5"
                         value={holdTime}
                         onChange={(e) => setHoldTime(parseInt(e.target.value))}
                         className="w-full accent-[var(--color-neon-blue)] h-1 bg-gray-700 rounded-full appearance-none outline-none"
                       />
                     </div>
                     <div className="w-16 text-right font-mono text-sm text-[var(--color-neon-pink)] drop-shadow-[0_0_3px_var(--color-neon-pink)]">
                       {holdTime}ms
                     </div>
                   </div>

                   <p className="text-[10px] text-gray-600 leading-relaxed">
                     Tuşlar (W A S D) DirectInput uyumlu tarama kodlarıyla (SendInput) gönderilir.
                     Gothic tuşları atlıyorsa basılı kalma süresini, animasyona yetişemiyorsa
                     bekleme süresini artırın. Acil durdurma: <span className="text-gray-400 font-mono">Alt+X</span>.
                   </p>
                </div>
              </div>
              {/* Section 4: Auto Mod */}
              <div className="flex flex-col gap-4">
                <h3 className="text-sm font-bold tracking-widest text-gray-400 uppercase">
                  4. Auto Mod (Hedef Belirle)
                </h3>
                <div className="flex items-center justify-between bg-black/20 p-4 rounded-xl border border-gray-800/50">
                   <div className="text-xs text-gray-500">
                     {!targetTemplate
                       ? 'Programın oyunda yer kaplamaması için kilit ekranından bir köşe şablonu belirleyin.'
                       : autoHideEnabled
                         ? 'Hedef şablon aktif. Kilit ekranı harici gizlenilecek.'
                         : 'Hedef şablon kayıtlı ama Auto Mod kapalı — buton her zaman görünür kalır.'}
                   </div>
                   <button
                     disabled={isExecuting}
                     onClick={startTargeting}
                     className="shrink-0 w-10 h-10 flex items-center justify-center bg-[var(--color-neon-pink)]/10 hover:bg-[var(--color-neon-pink)]/20 border border-[var(--color-neon-pink)]/30 text-[var(--color-neon-pink)] rounded-lg transition-all"
                   >
                     <Crosshair size={18} />
                   </button>
                </div>

                {targetTemplate && (
                  <div className="flex items-center justify-between bg-black/20 p-4 rounded-xl border border-gray-800/50">
                    <span className="text-xs text-gray-500">Auto Mod'u Etkinleştir</span>
                    <button
                      onClick={() => setAutoHideEnabled(v => !v)}
                      title={autoHideEnabled ? "Auto Mod'u kapat" : "Auto Mod'u aç"}
                      className={`shrink-0 w-12 h-7 rounded-full relative transition-colors border ${
                        autoHideEnabled
                          ? 'bg-[var(--color-neon-blue)]/30 border-[var(--color-neon-blue)]/60'
                          : 'bg-black/40 border-gray-700'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform ${
                          autoHideEnabled ? 'translate-x-5 bg-[var(--color-neon-blue)]' : 'translate-x-0 bg-gray-500'
                        }`}
                      />
                    </button>
                  </div>
                )}

                <div className="flex items-center justify-between bg-black/20 p-4 rounded-xl border border-gray-800/50">
                  <div className="text-xs text-gray-500">
                    <div>Pasif Mod</div>
                    <div className="text-[10px] text-gray-600 mt-0.5">
                      Panel kapalıyken köşe butonu tamamen gizlenir; sadece fare o köşeye
                      gelince görünür. Açmak için F9 veya köşeye gelip tıklama.
                    </div>
                  </div>
                  <button
                    onClick={() => setPassiveMode(v => !v)}
                    title={passiveMode ? 'Pasif Modu kapat' : 'Pasif Modu aç'}
                    className={`shrink-0 w-12 h-7 rounded-full relative transition-colors border ${
                      passiveMode
                        ? 'bg-[var(--color-neon-purple)]/30 border-[var(--color-neon-purple)]/60'
                        : 'bg-black/40 border-gray-700'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform ${
                        passiveMode ? 'translate-x-5 bg-[var(--color-neon-purple)]' : 'translate-x-0 bg-gray-500'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Solution Preview — Çözümü Bul ile hesaplanan kısa özet ("3x A+"
            gibi), oyuna henüz hiçbir tuş gönderilmeden burada listelenir.
            Kullanıcı isterse Otomatik Çöz'e basmadan bunu kendisi uygulayabilir. */}
        {!isExecuting && completionCountdown === null && solutionSummary.length > 0 && (
          <div className="mt-4 bg-black/40 border border-[var(--color-neon-blue)]/30 rounded-xl p-4 flex flex-col gap-3 shrink-0">
            <div className="flex flex-wrap gap-2 font-mono">
              {solutionSummary.map((move, idx) => (
                <span
                  key={idx}
                  className="bg-black/50 border border-[var(--color-neon-blue)]/50 px-3 py-1.5 rounded-lg text-xl font-black text-[var(--color-neon-blue)] shadow-[0_0_10px_rgba(0,243,255,0.25)]"
                >
                  {move.count}x {move.name}
                </span>
              ))}
            </div>
            <div className="text-sm font-bold text-[var(--color-neon-pink)] uppercase tracking-widest text-right drop-shadow-[0_0_5px_var(--color-neon-pink)]">
              Toplam {solutionSummary.reduce((sum, m) => sum + m.count, 0)} hamle
            </div>
          </div>
        )}

        {/* Action Button */}
        <div className="mt-6 pt-4 border-t border-gray-800 shrink-0 flex flex-col gap-3">
          {macroError && !isExecuting && (
            <div className="flex items-start gap-2 text-[11px] text-[var(--color-neon-pink)] bg-[var(--color-neon-pink)]/10 border border-[var(--color-neon-pink)]/30 rounded-lg p-3">
              <AlertTriangle size={14} className="shrink-0 mt-px" />
              <span className="flex-1">{macroError}</span>
              <button onClick={() => setMacroError(null)} className="text-gray-500 hover:text-gray-300">✕</button>
            </div>
          )}

          {completionCountdown !== null ? null : isExecuting ? (
            <button
              onClick={handleStop}
              className="w-full bg-[var(--color-neon-pink)] hover:bg-[var(--color-neon-pink)]/80 text-black font-bold tracking-widest py-4 rounded-xl flex items-center justify-center gap-3 transition-all hover:scale-[1.02] shadow-[0_0_20px_rgba(255,0,128,0.3)]"
            >
              <Square size={18} className="fill-black" />
              DURDUR (ALT+X)
            </button>
          ) : (
            // İki buton her zaman yan yana: "Çöz" sadece önizler, "Otomatik
            // Çöz" önce çözüm bulunmuş olsun beklemez — kendi hesaplayıp
            // hemen uygular.
            <div className="flex gap-3">
              <button
                onClick={handleFindSolution}
                className="w-2/5 bg-[var(--color-neon-purple)]/10 hover:bg-[var(--color-neon-purple)]/20 border border-[var(--color-neon-purple)]/50 text-[var(--color-neon-purple)] font-bold tracking-widest py-4 rounded-xl flex items-center justify-center gap-2 transition-all hover:scale-[1.02]"
              >
                <Search size={16} />
                ÇÖZ
              </button>
              <button
                onClick={handleAutoSolve}
                className="w-3/5 bg-[var(--color-neon-blue)] hover:bg-[var(--color-neon-blue)]/80 text-black font-bold tracking-widest py-4 rounded-xl flex items-center justify-center gap-2 transition-all hover:scale-[1.02] shadow-[0_0_20px_rgba(0,243,255,0.3)]"
              >
                <Play size={18} className="fill-black" />
                OTOMATİK ÇÖZ
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
