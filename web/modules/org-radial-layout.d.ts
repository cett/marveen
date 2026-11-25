export interface LayoutOptions {
  minChord: number
  borderChord: number
  boxW: number
  boxH: number
  ringGap: number
  growStep: number
  maxGrowSteps: number
  maxRings: number
  crowdedLimit: number
  pad: number
}

export const DEFAULT_LAYOUT_OPTIONS: Readonly<LayoutOptions>

export interface RadialViewInput {
  rootId: string | null
  nodes: { id: string }[]
  edges: { from: string; to: string }[]
}

export interface PlacedNode {
  id: string
  /** 0 = the centre */
  ring: number
  /** degrees, 0 = up, clockwise */
  angle: number
  x: number
  y: number
  isRoot: boolean
  /** not reachable from the centre (a cycle); placed on a trailing ring */
  orphan?: true
  /** descendants folded behind this node because they are deeper than maxRings */
  hiddenCount?: number
}

export interface Spoke { from: string; to: string; x1: number; y1: number; x2: number; y2: number }

export interface RadialLayout {
  centre: string | null
  nodes: PlacedNode[]
  /** false when the grow cap ran out with two label boxes still overlapping (must never be drawn) */
  clean: boolean
  spokes: Spoke[]
  /** radius of ring 1, ring 2, ... */
  radii: number[]
  /** rings with more nodes than crowdedLimit */
  crowdedRings: number[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
}

export function layoutRadial(view: RadialViewInput, options?: Partial<LayoutOptions>): RadialLayout
