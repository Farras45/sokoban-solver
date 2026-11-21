// A push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// How it works, in short. Every level this competition draws is one hallway
// with one to four small rooms off it, and a box pushed out of a room's door
// can never come back, so each room is a problem of its own: the level's
// push-optimal count is the sum of its rooms'. This program cuts the level
// into its rooms, solves each room push-optimally on its own with a
// breadth-first search over pushes, and stitches the room solutions together
// with the player's walks between doors. A room search's state is the boxes'
// squares plus the player's reachable region (named by its lowest square);
// it prunes dead squares (a box there can reach no goal) and frozen 2 x 2
// blocks, neither of which prunes a solvable state, so the first solved
// state the search meets is push-optimal. Everything is budgeted by work,
// never by the clock, so two runs answer byte for byte alike.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The work budgets, in states created: a room's search is cut off at
// STATES_PER_ROOM (the generator keeps a room only when its own push-optimal
// search solves it within 250,000 states, so this never binds on a drawn
// room), the whole-level and greedy fallbacks have their own caps, and
// TOTAL_STATE_BUDGET bounds the whole run across its five instances.
const STATES_PER_ROOM = 250_000;
const STATES_WHOLE_LEVEL = 60_000;
const STATES_GREEDY = 150_000;
const TOTAL_STATE_BUDGET = 3_000_000;

// The four steps: [dx, dy, the walk's letter, the push's letter].
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
] as const;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

interface Budget {
  used: number;
  limit: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  const goalSet = new Uint8Array(w * h);
  for (const g of goals) goalSet[g] = 1;
  return { w, h, wall, goals, goalSet, boxes, player };
}

/**
 * The squares from which a box alone can be pushed onto some goal: pull back
 * from the goals. A square y is live when some live square x = y + d can be
 * reached from it, the player standing at y - d to make the push.
 */
function liveSquares(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const dir of DIRS) {
      const d = dir.dy * w + dir.dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way,
 * marked in `seen` with `stamp`; returns the lowest square reached.
 */
function floodRegion(
  board: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls
 * and boxes with a box off its goal: no push can ever move any of them.
 */
function frozenBlock(board: Board, occupied: Uint8Array, t: number): boolean {
  const { w, wall, goalSet } = board;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a % w === w - 1 || a + w + 1 >= wall.length) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goalSet[a]) ||
      (occupied[b] && !goalSet[b]) ||
      (occupied[c] && !goalSet[c]) ||
      (occupied[d] && !goalSet[d])
    ) {
      return true;
    }
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkPath(board: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length).fill('');
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

const solved = (board: Board, boxes: number[]): boolean => boxes.every((b) => board.goalSet[b]);

/**
 * The push-optimal solution of `board`: {pushes, moves} (moves in LURD, a
 * lower letter a step, an upper one a push), or null when the search gives up
 * (its state cap, or the shared work budget, runs out) or has no solution.
 * Breadth-first over pushes, so the first solved state met is optimal.
 */
function pushOptimal(board: Board, maxStates: number, budget: Budget): { pushes: number; moves: string } | null {
  const { w, wall, goalSet } = board;
  const size = wall.length;
  const live = liveSquares(board);
  if (board.boxes.some((b) => !live[b])) return null;
  const numericKeys = board.boxes.length <= 5;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numericKeys) return `${low}|${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // Each square's Manhattan distance to its nearest goal: the boxes' total
  // orders a state's pushes, best first. Ordering within one depth never
  // changes what breadth-first finds first, only how soon it finds it.
  const near = new Int32Array(size).fill(1 << 30);
  for (let s = 0; s < size; s++) {
    if (wall[s]) continue;
    for (const g of board.goals) {
      const d = Math.abs((g % w) - (s % w)) + Math.abs(Math.floor(g / w) - Math.floor(s / w));
      if (d < near[s]!) near[s] = d;
    }
  }
  const boxesList: number[][] = [board.boxes.slice()];
  const playerList: number[] = [board.player];
  const parentList: number[] = [-1];
  const fromList: number[] = [-1];
  const toList: number[] = [-1];
  const dirList: number[] = [-1];
  const visited = new Map<number | string, number>();
  for (const b of board.boxes) occupied[b] = 1;
  visited.set(keyOf(board.boxes, floodRegion(board, occupied, board.player, seen, ++stamp, stack)), 0);
  for (const b of board.boxes) occupied[b] = 0;
  let found = solved(board, board.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < boxesList.length; head++) {
    const boxes = boxesList[head]!;
    for (const b of boxes) occupied[b] = 1;
    floodRegion(board, occupied, playerList[head]!, seen, ++stamp, stack);
    const here = stamp;
    const baseH = boxes.reduce((a, b) => a + near[b]!, 0);
    // The candidate pushes, best first: a push that leaves the boxes closer
    // to their goals is tried first, ties by box then direction.
    const candidates: { next: number[]; key: number | string; box: number; target: number; di: number; h: number }[] = [];
    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const dir = DIRS[di]!;
        const d = dir.dy * w + dir.dx;
        const target = box + d;
        const stand = box - d;
        if (stand < 0 || stand >= size || target < 0 || target >= size) continue;
        if (seen[stand] !== here) continue;
        if (wall[target] || occupied[target] || !live[target]) continue;
        occupied[box] = 0;
        occupied[target] = 1;
        const frozen = frozenBlock(board, occupied, target);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = target;
          next.sort((a, b) => a - b);
          const low = floodRegion(board, occupied, box, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[target] = 0;
        occupied[box] = 1;
        if (frozen || visited.has(key)) continue;
        candidates.push({ next: next!, key, box, target, di, h: baseH - near[box]! + near[target]! });
      }
    }
    candidates.sort((a, b) => a.h - b.h || a.box - b.box || a.di - b.di);
    for (const c of candidates) {
      if (found >= 0) break;
      if (budget.used >= budget.limit || boxesList.length >= maxStates) {
        for (const b of boxes) occupied[b] = 0;
        return null;
      }
      budget.used++;
      visited.set(c.key, boxesList.length);
      boxesList.push(c.next);
      playerList.push(c.box);
      parentList.push(head);
      fromList.push(c.box);
      toList.push(c.target);
      dirList.push(c.di);
      if (solved(board, c.next)) {
        found = boxesList.length - 1;
        break;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parentList[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes;
  for (const s of path) {
    const nextBoxes = boxesList[s]!;
    const from = fromList[s]!;
    const to = toList[s]!;
    const dir = DIRS[dirList[s]!]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkPath(board, occupied, player, from - (dir.dy * w + dir.dx));
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function splitRooms(board: Board): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = board;
  const live = liveSquares(board);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const comp = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || comp[s] >= 0) continue;
    const id = rooms.length;
    rooms.push({ boxes: [], goals: [] });
    const stack = [s];
    comp[s] = id;
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const dir of DIRS) {
        const q = p + dir.dy * w + dir.dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && comp[q] < 0) {
          comp[q] = id;
          stack.push(q);
        }
      }
    }
  }
  for (const b of boxes) {
    if (comp[b] < 0) return null;
    rooms[comp[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (comp[g] < 0) return null;
    rooms[comp[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Every ordering of `n` room indices, the identity first, then the rest in lexicographic order. */
function roomOrders(n: number): number[][] {
  const base = Array.from({ length: n }, (_, i) => i);
  const out: number[][] = [base.slice()];
  const permute = (a: number[], k: number): void => {
    if (k === a.length) {
      if (a.some((v, i) => v !== i)) out.push(a.slice());
      return;
    }
    for (let i = k; i < a.length; i++) {
      [a[k], a[i]] = [a[i]!, a[k]!];
      permute(a, k + 1);
      [a[k], a[i]] = [a[i]!, a[k]!];
    }
  };
  permute(base.slice(), 0);
  return out;
}

/** The level solved room by room in one room order: the other rooms' boxes stand as walls (on their goals once done). */
function solveRoomsInOrder(
  board: Board,
  rooms: { boxes: number[]; goals: number[] }[],
  order: number[],
  budget: Budget,
): { pushes: number; moves: string } | null {
  let player = board.player;
  let pushes = 0;
  let moves = '';
  const done = new Set<number>();
  for (const ri of order) {
    const room = rooms[ri]!;
    const wall = board.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const src = done.has(oj) ? rooms[oj]!.goals : rooms[oj]!.boxes;
      for (const b of src) wall[b] = 1;
    }
    const subGoals = room.goals.slice().sort((a, b) => a - b);
    const subGoalSet = new Uint8Array(board.w * board.h);
    for (const g of subGoals) subGoalSet[g] = 1;
    const sub: Board = {
      w: board.w,
      h: board.h,
      wall,
      goals: subGoals,
      goalSet: subGoalSet,
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const r = pushOptimal(sub, STATES_PER_ROOM, budget);
    if (r === null) return null;
    pushes += r.pushes;
    moves += r.moves;
    player = endOf(board.w, player, r.moves);
    done.add(ri);
  }
  return { pushes, moves };
}

/** The level solved room by room, trying room orders until one works. */
function solveByRooms(board: Board, budget: Budget): { pushes: number; moves: string } | null {
  const rooms = splitRooms(board);
  if (rooms === null) return null;
  const orders = roomOrders(rooms.length);
  let tried = 0;
  for (const order of orders) {
    if (tried >= 8 || budget.used > (budget.limit * 3) / 4) break;
    tried++;
    const r = solveRoomsInOrder(board, rooms, order, budget);
    if (r !== null) return r;
  }
  return null;
}

// A small binary heap, smallest first, for the greedy fallback.
class Heap<T> {
  private items: T[] = [];
  private less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.items.length;
  }
  push(v: T): void {
    let i = this.items.length;
    this.items.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.items[i]!, this.items[p]!)) break;
      [this.items[i], this.items[p]] = [this.items[p]!, this.items[i]!];
      i = p;
    }
  }
  pop(): T {
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= this.items.length) break;
        if (c + 1 < this.items.length && this.less(this.items[c + 1]!, this.items[c]!)) c++;
        if (!this.less(this.items[c]!, this.items[i]!)) break;
        [this.items[i], this.items[c]] = [this.items[c]!, this.items[i]!];
        i = c;
      }
    }
    return top;
  }
}

/**
 * A greedy fallback: best-first over push states by the sum of each box's
 * Manhattan distance to its nearest goal (plus its pushes, to break ties
 * towards shorter solutions). It returns the first solved state it meets:
 * a valid answer, not necessarily an optimal one. Deterministic throughout.
 */
function solveGreedy(board: Board, budget: Budget): { pushes: number; moves: string } | null {
  const { w, wall, goalSet } = board;
  const size = wall.length;
  const live = liveSquares(board);
  if (board.boxes.some((b) => !live[b])) return null;
  // Each square's Manhattan distance to its nearest goal.
  const near = new Int32Array(size).fill(1 << 30);
  for (let s = 0; s < size; s++) {
    if (wall[s]) continue;
    for (const g of board.goals) {
      const d = Math.abs((g % w) - (s % w)) + Math.abs(Math.floor(g / w) - Math.floor(s / w));
      if (d < near[s]!) near[s] = d;
    }
  }
  const scoreOf = (boxes: number[]): number => boxes.reduce((a, b) => a + near[b]!, 0);
  const keyOf = (boxes: number[], low: number): string => `${low}|${boxes.join(',')}`;
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const boxesList: number[][] = [board.boxes.slice()];
  const playerList: number[] = [board.player];
  const parentList: number[] = [-1];
  const fromList: number[] = [-1];
  const toList: number[] = [-1];
  const dirList: number[] = [-1];
  const gList: number[] = [0];
  const visited = new Map<string, number>();
  for (const b of board.boxes) occupied[b] = 1;
  visited.set(keyOf(board.boxes, floodRegion(board, occupied, board.player, seen, ++stamp, stack)), 0);
  for (const b of board.boxes) occupied[b] = 0;
  let seq = 0;
  const heap = new Heap<[number, number, number, number]>((a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2]))));
  heap.push([scoreOf(board.boxes), 0, seq++, 0]);
  let found = solved(board, board.boxes) ? 0 : -1;
  while (heap.size > 0 && found < 0) {
    const [, , , s] = heap.pop();
    const boxes = boxesList[s]!;
    for (const b of boxes) occupied[b] = 1;
    floodRegion(board, occupied, playerList[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const dir = DIRS[di]!;
        const d = dir.dy * w + dir.dx;
        const target = box + d;
        const stand = box - d;
        if (stand < 0 || stand >= size || target < 0 || target >= size) continue;
        if (seen[stand] !== here) continue;
        if (wall[target] || occupied[target] || !live[target]) continue;
        occupied[box] = 0;
        occupied[target] = 1;
        const frozen = frozenBlock(board, occupied, target);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = target;
          next.sort((a, b) => a - b);
          const low = floodRegion(board, occupied, box, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[target] = 0;
        occupied[box] = 1;
        if (frozen || visited.has(key)) continue;
        if (budget.used >= budget.limit || boxesList.length >= STATES_GREEDY) {
          for (const b of boxes) occupied[b] = 0;
          return null;
        }
        budget.used++;
        visited.set(key, boxesList.length);
        boxesList.push(next!);
        playerList.push(box);
        parentList.push(s);
        fromList.push(box);
        toList.push(target);
        dirList.push(di);
        gList.push(gList[s]! + 1);
        if (solved(board, next!)) {
          found = boxesList.length - 1;
          break;
        }
        heap.push([scoreOf(next!) + gList[boxesList.length - 1]!, gList[boxesList.length - 1]!, seq++, boxesList.length - 1]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  const path: number[] = [];
  for (let s = found; s > 0; s = parentList[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes;
  for (const s of path) {
    const from = fromList[s]!;
    const dir = DIRS[dirList[s]!]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkPath(board, occupied, player, from - (dir.dy * w + dir.dx));
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = boxesList[s]!;
  }
  return { pushes: path.length, moves };
}

/** The moves for a level: rooms first, then the whole level, then greedy, else an empty answer. */
function solveLevel(text: string, budget: Budget): string {
  const board = parseLevel(text);
  if (solved(board, board.boxes)) return '';
  const byRooms = solveByRooms(board, budget);
  if (byRooms !== null) return byRooms.moves;
  const whole = pushOptimal(board, STATES_WHOLE_LEVEL, budget);
  if (whole !== null) return whole.moves;
  const greedy = solveGreedy(board, budget);
  if (greedy !== null) return greedy.moves;
  return '';
}

const budget: Budget = { used: 0, limit: TOTAL_STATE_BUDGET };
for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
