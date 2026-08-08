import { describe, it, expect } from 'vitest';
import { LockSolver, type Move } from './LockSolver';

/** N plakalık, her hareketin yalnızca kendi plakasını ittiği matris. */
const identity = (n: number): number[][] =>
  Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

const names = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));

/** Hamle dizisini baştan uygulayıp son durumu döner. */
const replay = (start: number[], moves: Move[], matrix: number[][]): number[] =>
  moves.reduce(
    (state, move) => LockSolver.applyMove(state, move.index, move.dir, matrix),
    [...start]
  );

/** Hamle dizisi boyunca hiçbir ara durum sınır dışına çıkıyor mu? */
const staysValid = (start: number[], moves: Move[], matrix: number[][]): boolean => {
  let state = [...start];
  for (const move of moves) {
    state = LockSolver.applyMove(state, move.index, move.dir, matrix);
    if (!LockSolver.isValid(state)) return false;
  }
  return true;
};

/** Ardışık aynı isimli hamleleri tek grup sayar. */
const groupCount = (moves: Move[]): number => {
  let groups = 0;
  let last: string | null = null;
  for (const move of moves) {
    const name = move.name();
    if (name !== last) groups++;
    last = name;
  }
  return groups;
};

/** Deterministik PRNG — testlerin tekrarlanabilir olması için. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

describe('temel davranış', () => {
  it('zaten çözülmüş kilit için boş çözüm döner', () => {
    const res = LockSolver.solve([0, 0, 0], identity(3), names(3));
    expect(res.success).toBe(true);
    expect(res.moves).toHaveLength(0);
    expect(res.compressed).toHaveLength(0);
  });

  it('bağımsız plakaları tek tek sıfırlar', () => {
    const start = [2, -1, 3];
    const matrix = identity(3);
    const res = LockSolver.solve(start, matrix, names(3));

    expect(res.success).toBe(true);
    // Her plaka |offset| kadar hamle gerektirir, fazlası değil.
    expect(res.moves).toHaveLength(2 + 1 + 3);
    expect(replay(start, res.moves, matrix)).toEqual([0, 0, 0]);
  });

  it('run-length sıkıştırma hamle sayısını korur', () => {
    const res = LockSolver.solve([3, -3, 2], identity(3), names(3));
    const total = res.compressed.reduce((sum, group) => sum + group.count, 0);

    expect(total).toBe(res.moves.length);
    // Sıkıştırılmış listede aynı isim art arda iki kez görünmemeli.
    const nameList = res.compressed.map((g) => g.name);
    expect(new Set(nameList).size).toBe(nameList.length);
  });
});

describe('uç durumlar', () => {
  it('sınır dışı başlangıç durumunu reddeder', () => {
    // LIMIT = 4, yani geçerli aralık -3..3.
    const res = LockSolver.solve([4, 0, 0], identity(3), names(3));
    expect(res.success).toBe(false);
    expect(res.error).toBe('Invalid Start State');
  });

  it('-LIMIT değerini de reddeder', () => {
    const res = LockSolver.solve([0, -4, 0], identity(3), names(3));
    expect(res.success).toBe(false);
    expect(res.error).toBe('Invalid Start State');
  });

  it('sınırdaki geçerli değerleri (±3) kabul eder', () => {
    const start = [3, -3];
    const res = LockSolver.solve(start, identity(2), names(2));
    expect(res.success).toBe(true);
    expect(replay(start, res.moves, identity(2))).toEqual([0, 0]);
  });

  it('hiçbir hareketin etkisi yoksa çözümsüz döner', () => {
    const matrix = [
      [0, 0],
      [0, 0]
    ];
    const res = LockSolver.solve([1, 0], matrix, names(2));
    expect(res.success).toBe(false);
    expect(res.error).toBe('No Solution Found');
  });

  it('erişilemeyen plaka varsa çözümsüz döner', () => {
    // İkinci plakaya hiçbir hareket dokunmuyor ama sıfır değil.
    const matrix = [
      [1, 0],
      [1, 0]
    ];
    const res = LockSolver.solve([0, 2], matrix, names(2));
    expect(res.success).toBe(false);
    expect(res.error).toBe('No Solution Found');
  });

  it('yalnızca sınır ihlali üzerinden geçen yolu seçmez', () => {
    // A hareketi her iki plakayı da iter; tek başına B ile telafi gerekiyor.
    const matrix = [
      [1, 1],
      [0, 1]
    ];
    const start = [-3, 0];
    const res = LockSolver.solve(start, matrix, names(2));

    expect(res.success).toBe(true);
    expect(staysValid(start, res.moves, matrix)).toBe(true);
    expect(replay(start, res.moves, matrix)).toEqual([0, 0]);
  });
});

describe('bağlı plakalar', () => {
  it('ters etkileşimli komşu plakaları çözer', () => {
    const matrix = [
      [1, -1, 0],
      [0, 1, -1],
      [0, 0, 1]
    ];
    const start = [2, -2, 1];
    const res = LockSolver.solve(start, matrix, names(3));

    expect(res.success).toBe(true);
    expect(replay(start, res.moves, matrix)).toEqual([0, 0, 0]);
    expect(staysValid(start, res.moves, matrix)).toBe(true);
  });

  it('gruplama optimizasyonu hamle çokluğunu değiştirmez', () => {
    const matrix = [
      [1, -1, 0],
      [0, 1, -1],
      [0, 0, 1]
    ];
    const start = [3, -3, 2];
    const names3 = names(3);

    const raw = LockSolver.findShortestSolution(start, matrix, names3);
    expect(raw).not.toBeNull();

    const optimized = LockSolver.optimizeGrouping(start, raw!, matrix);

    expect(optimized).toHaveLength(raw!.length);

    const tally = (moves: Move[]) => {
      const map = new Map<string, number>();
      for (const move of moves) map.set(move.key(), (map.get(move.key()) ?? 0) + 1);
      return [...map.entries()].sort();
    };
    expect(tally(optimized)).toEqual(tally(raw!));

    // Aynı çokluk, aynı hedef: yeniden oynatınca yine sıfıra inmeli.
    expect(replay(start, optimized, matrix)).toEqual([0, 0, 0]);
    expect(staysValid(start, optimized, matrix)).toBe(true);

    // Optimizasyonun tek amacı: tür değiştirme sayısını azaltmak.
    expect(groupCount(optimized)).toBeLessThanOrEqual(groupCount(raw!));
  });
});

describe('rastgele kilitler (özellik testi)', () => {
  it('üretilen her çözüm gerçekten kilidi açar ve sınır dışına taşmaz', () => {
    const random = rng(20260808);
    let solved = 0;

    for (let trial = 0; trial < 120; trial++) {
      const n = 2 + Math.floor(random() * 4); // 2..5 plaka
      const matrix = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => {
          if (i === j) return 1;
          const roll = random();
          if (roll < 0.2) return 1;
          if (roll < 0.4) return -1;
          return 0;
        })
      );
      const start = Array.from({ length: n }, () => Math.floor(random() * 7) - 3);

      const res = LockSolver.solve(start, matrix, names(n));
      if (!res.success) continue; // çözümsüz kombinasyonlar meşru

      solved++;
      expect(replay(start, res.moves, matrix)).toEqual(new Array(n).fill(0));
      expect(staysValid(start, res.moves, matrix)).toBe(true);
    }

    // Test anlamlı olsun: denemelerin çoğu gerçekten çözülebilmeli.
    expect(solved).toBeGreaterThan(60);
  });

  it('BFS en kısa çözümü bulur (kaba kuvvetle karşılaştırma)', () => {
    const random = rng(777);

    for (let trial = 0; trial < 15; trial++) {
      const n = 3;
      const matrix = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 1 : random() < 0.3 ? -1 : 0))
      );
      const start = Array.from({ length: n }, () => Math.floor(random() * 5) - 2);

      const bfs = LockSolver.findShortestSolution(start, matrix, names(n));
      const brute = bruteForceDepth(start, matrix, 8);

      if (brute === null) {
        // Kaba kuvvet 8 adımda bulamadıysa BFS ya çözümsüz demeli ya da >8.
        expect(bfs === null || bfs.length > 8).toBe(true);
      } else {
        expect(bfs).not.toBeNull();
        expect(bfs!.length).toBe(brute);
      }
    }
  });
});

describe('performans koruması', () => {
  it('12 plakalık çözümsüz kilitte donmadan geri döner', () => {
    const n = 12;
    // Hiçbir hareket son plakaya dokunmuyor -> çözümsüz, arama uzayı devasa.
    const matrix = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j && j < n - 1 ? 1 : 0))
    );
    const start = new Array(n).fill(0);
    start[n - 1] = 1;

    const began = performance.now();
    const res = LockSolver.solve(start, matrix, names(n));
    const elapsed = performance.now() - began;

    expect(res.success).toBe(false);
    expect(elapsed).toBeLessThan(20_000);
  }, 30_000);
});

/** Iterative deepening ile en kısa çözüm uzunluğu; BFS'i doğrulamak için. */
function bruteForceDepth(start: number[], matrix: number[][], maxDepth: number): number | null {
  const search = (state: number[], depth: number, limit: number): boolean => {
    if (LockSolver.isGoal(state)) return true;
    if (depth === limit) return false;
    for (let move = 0; move < matrix.length; move++) {
      for (const dir of [1, -1]) {
        const next = LockSolver.applyMove(state, move, dir, matrix);
        if (!LockSolver.isValid(next)) continue;
        if (search(next, depth + 1, limit)) return true;
      }
    }
    return false;
  };

  for (let limit = 0; limit <= maxDepth; limit++) {
    if (search([...start], 0, limit)) return limit;
  }
  return null;
}
