export type Move = {
    index: number;
    dir: number;
    name: () => string;
    key: () => string;
};

export type DPResult = {
    groups: number;
    order: number[];
};

export class LockSolver {
    static readonly LIMIT = 4;
    static readonly REVERSE_DISPLAY_SIGN = true;
    static readonly OPTIMIZE_GROUPS = true;

    /**
     * Arama bütçeleri. Durum uzayı plaka sayısıyla üstel büyür (12 plaka için
     * 7^12 ≈ 1.4e10); sınır olmadan BFS arayüzü kilitler ve belleği tüketir.
     * Bütçe aşılırsa çözüm "bulunamadı" olarak döner — donmaktansa bu iyidir.
     */
    static readonly MAX_BFS_STATES = 2_000_000;
    static readonly MAX_DP_NODES = 200_000;

    static getMoveName(index: number, dir: number, moveNames: string[]): string {
        let sign = '';
        if (LockSolver.REVERSE_DISPLAY_SIGN) {
            sign = dir === 1 ? "-" : "+";
        } else {
            sign = dir === 1 ? "+" : "-";
        }
        return moveNames[index] + sign;
    }

    static createMove(index: number, dir: number, moveNames: string[]): Move {
        return {
            index,
            dir,
            name: () => LockSolver.getMoveName(index, dir, moveNames),
            key: () => `${index}:${dir}`
        };
    }

    static isValid(state: number[]): boolean {
        for (const x of state) {
            if (x <= -LockSolver.LIMIT || x >= LockSolver.LIMIT) {
                return false;
            }
        }
        return true;
    }

    static isGoal(state: number[]): boolean {
        for (const x of state) {
            if (x !== 0) {
                return false;
            }
        }
        return true;
    }

    static stateKey(state: number[]): string {
        return state.join(',');
    }

    static applyMove(current: number[], move: number, dir: number, movesMatrix: number[][]): number[] {
        const next = [...current];
        for (let i = 0; i < next.length; i++) {
            next[i] += movesMatrix[move][i] * dir;
        }
        return next;
    }

    static findShortestSolution(start: number[], movesMatrix: number[][], moveNames: string[]): Move[] | null {
        const queue: { values: number[], parent: any, moveIndex: number, dir: number }[] = [];
        const visited = new Set<string>();

        queue.push({ values: [...start], parent: null, moveIndex: -1, dir: 0 });
        visited.add(LockSolver.stateKey(start));

        // Array.shift() bağlantılı listede O(n)'dir; büyük kuyruklarda BFS'i
        // tek başına ikinci dereceden yavaşlatır. Bunun yerine okuma imleci.
        let head = 0;

        while (head < queue.length) {
            const current = queue[head++];

            if (LockSolver.isGoal(current.values)) {
                return LockSolver.extractMoves(current, moveNames);
            }

            if (visited.size > LockSolver.MAX_BFS_STATES) {
                return null;
            }

            for (let move = 0; move < movesMatrix.length; move++) {
                for (const dir of [1, -1]) {
                    const next = LockSolver.applyMove(current.values, move, dir, movesMatrix);

                    if (!LockSolver.isValid(next)) {
                        continue;
                    }

                    const key = LockSolver.stateKey(next);
                    if (visited.has(key)) {
                        continue;
                    }
                    visited.add(key);

                    queue.push({
                        values: next,
                        parent: current,
                        moveIndex: move,
                        dir: dir
                    });
                }
            }
        }
        return null;
    }

    static extractMoves(goalState: any, moveNames: string[]): Move[] {
        const moves: Move[] = [];
        let current = goalState;

        while (current.parent !== null) {
            moves.push(LockSolver.createMove(current.moveIndex, current.dir, moveNames));
            current = current.parent;
        }

        return moves.reverse();
    }

    static optimizeGrouping(start: number[], original: Move[], movesMatrix: number[][]): Move[] {
        const uniqueMap = new Map<string, Move>();
        for (const move of original) {
            if (!uniqueMap.has(move.key())) {
                uniqueMap.set(move.key(), move);
            }
        }

        const types = Array.from(uniqueMap.values());
        const typeIndex = new Map<string, number>();

        for (let i = 0; i < types.length; i++) {
            typeIndex.set(types[i].key(), i);
        }

        const counts = new Array(types.length).fill(0);
        for (const move of original) {
            const index = typeIndex.get(move.key())!;
            counts[index]++;
        }

        const memo = new Map<string, DPResult>();

        const best = LockSolver.searchBest([...start], counts, types, -1, memo, movesMatrix, { nodes: 0 });

        // Bütçe tükenirse veya sıralama bulunamazsa BFS'in ürettiği sıra
        // zaten geçerli bir çözümdür; sadece grup sayısı optimal olmaz.
        if (!best) return original;

        const result: Move[] = [];
        for (const type of best.order) {
            result.push(types[type]);
        }

        return result;
    }

    static searchBest(
        current: number[],
        remaining: number[],
        types: Move[],
        lastType: number,
        memo: Map<string, DPResult>,
        movesMatrix: number[][],
        budget: { nodes: number } = { nodes: 0 }
    ): DPResult | null {
        let total = 0;
        for (const x of remaining) total += x;

        if (total === 0) {
            return { groups: 0, order: [] };
        }

        if (++budget.nodes > LockSolver.MAX_DP_NODES) {
            return null;
        }

        const key = current.join(',') + '|' + remaining.join(',') + '|' + lastType;

        if (memo.has(key)) {
            return memo.get(key)!;
        }

        let best: DPResult | null = null;
        const candidates: number[] = [];

        if (lastType >= 0 && remaining[lastType] > 0) {
            candidates.push(lastType);
        }

        for (let i = 0; i < types.length; i++) {
            if (remaining[i] <= 0) continue;
            if (i === lastType) continue;
            candidates.push(i);
        }

        for (const type of candidates) {
            const move = types[type];
            const next = LockSolver.applyMove(current, move.index, move.dir, movesMatrix);

            if (!LockSolver.isValid(next)) continue;

            remaining[type]--;
            const rest = LockSolver.searchBest(next, remaining, types, type, memo, movesMatrix, budget);
            remaining[type]++;

            if (!rest) continue;

            const addedGroup = (type === lastType) ? 0 : 1;
            const totalGroups = rest.groups + addedGroup;

            if (best === null || totalGroups < best.groups) {
                const order = [type, ...rest.order];
                best = {
                    groups: totalGroups,
                    order: order
                };
            }
        }

        memo.set(key, best!);
        return best;
    }

    static solve(start: number[], movesMatrix: number[][], moveNames: string[]): {
        success: boolean;
        moves: Move[];
        compressed: { name: string, count: number }[];
        error?: string;
    } {
        if (!LockSolver.isValid(start)) {
            return { success: false, moves: [], compressed: [], error: "Invalid Start State" };
        }

        const shortest = LockSolver.findShortestSolution(start, movesMatrix, moveNames);
        if (!shortest) {
            return { success: false, moves: [], compressed: [], error: "No Solution Found" };
        }

        let result = shortest;
        if (LockSolver.OPTIMIZE_GROUPS) {
            result = LockSolver.optimizeGrouping(start, shortest, movesMatrix);
        }

        const compressed: { name: string, count: number }[] = [];
        let i = 0;
        while (i < result.length) {
            const name = result[i].name();
            let count = 1;
            while (i + count < result.length && result[i + count].name() === name) {
                count++;
            }
            compressed.push({ name, count });
            i += count;
        }

        return {
            success: true,
            moves: result,
            compressed: compressed
        };
    }
}
