import type { BinaryImage } from './image'

/**
 * Locates the grid's rules and returns them as curves.
 *
 * Two properties of real photos drive the design:
 *
 * - **Tilt.** A rule off-axis by a few degrees never stays inside one pixel row,
 *   so anything based on horizontal runs or plain row sums misses it. Ink is
 *   therefore accumulated along *slanted* families of lines, and the slant that
 *   concentrates the ink most is the one the page is actually printed at.
 * - **Curvature.** A magazine is bound, so its page bows and the rules are not
 *   even parallel to each other. Rather than forcing them straight, each rule is
 *   found in a narrow central band — where the bow is negligible — and then
 *   *tracked* outwards band by band, so the resulting curve follows the page.
 */

/** Number of bands each rule is tracked across. */
export const BANDS = 9

export interface BandedProfile {
  /** Ink per candidate intercept, normalised by the band's width. */
  coverage: Float64Array
  /** Index 0 of `coverage` corresponds to intercept `-offset`. */
  offset: number
}

/**
 * Coverage profile of the family of parallel lines at `angle`, using only the
 * slice `[from, to)` of the sweep axis, with intercepts measured at the slice
 * centre. For `axis: 'rows'` a line is `y = k + (x − centre)·tan(angle)`.
 *
 * `coverage[k]` is the fraction of the slice whose column carries ink within
 * `tolerance` of line k — not the amount of ink on it. That distinction matters:
 * a single global angle cannot fit every rule on a bowed page, so a real rule
 * often wanders a few pixels off its ideal line. Counting ink would score it as
 * half-covered and lose it; counting *columns near it* keeps it at 1.0.
 *
 * @param tolerance how far off the ideal line ink may sit and still count.
 *   Use 0 when measuring tilt, where sharpness is the signal being maximised.
 */
export function bandedProfile(
  bin: BinaryImage,
  axis: 'rows' | 'cols',
  angle: number,
  from: number,
  to: number,
  tolerance = 0,
): BandedProfile {
  const { width: w, height: h, data } = bin
  const across = axis === 'rows' ? h : w
  const sweepLimit = axis === 'rows' ? w : h
  const slope = Math.tan(angle)
  const centre = (from + to) / 2
  const maxShift = Math.abs(slope) * Math.max(centre - from, to - centre)
  const offset = Math.ceil(maxShift) + tolerance + 2
  const bins = across + 2 * offset
  const counts = new Int32Array(bins)
  // Which column last credited each bin, so one column counts once per bin.
  const stamp = new Int32Array(bins).fill(-1)
  const width = Math.max(1, Math.min(to, sweepLimit) - Math.max(from, 0))

  for (let s = Math.max(from, 0); s < Math.min(to, sweepLimit); s++) {
    const shift = (s - centre) * slope
    for (let a = 0; a < across; a++) {
      const idx = axis === 'rows' ? a * w + s : s * w + a
      if (!data[idx]) continue
      const k = Math.round(a - shift) + offset
      const lo = Math.max(0, k - tolerance)
      const hi = Math.min(bins - 1, k + tolerance)
      for (let kk = lo; kk <= hi; kk++) {
        if (stamp[kk] !== s) {
          stamp[kk] = s
          counts[kk]!++
        }
      }
    }
  }

  const coverage = new Float64Array(bins)
  for (let i = 0; i < bins; i++) coverage[i] = counts[i]! / width
  return { coverage, offset }
}

/** Concentration of a profile: high when ink piles into few lines. */
function concentration(coverage: Float64Array): number {
  let sum = 0
  let sumSq = 0
  for (const v of coverage) {
    sum += v
    sumSq += v * v
  }
  return sum > 0 ? sumSq / sum : 0
}

/**
 * Measures the tilt of one family of rules on the central band, where page bow
 * is smallest. Coarse sweep, then refinement.
 */
export function estimateTilt(
  bin: BinaryImage,
  axis: 'rows' | 'cols',
  maxDegrees = 12,
): number {
  const sweepExtent = axis === 'rows' ? bin.width : bin.height
  const from = Math.round(sweepExtent * 0.3)
  const to = Math.round(sweepExtent * 0.7)

  let best = 0
  let bestScore = -Infinity
  for (let deg = -maxDegrees; deg <= maxDegrees; deg += 0.5) {
    const score = concentration(
      bandedProfile(bin, axis, (deg * Math.PI) / 180, from, to).coverage,
    )
    if (score > bestScore) {
      bestScore = score
      best = deg
    }
  }
  for (let deg = best - 0.5; deg <= best + 0.5; deg += 0.1) {
    const score = concentration(
      bandedProfile(bin, axis, (deg * Math.PI) / 180, from, to).coverage,
    )
    if (score > bestScore) {
      bestScore = score
      best = deg
    }
  }
  return (best * Math.PI) / 180
}

/**
 * Peaks of a profile: runs above the threshold, each collapsed to its
 * ink-weighted centre. Permissive on purpose — {@link bestArithmeticChain}
 * is what rejects the false positives.
 */
function profilePeaks(profile: BandedProfile, minGap: number): { pos: number; strength: number }[] {
  const { coverage, offset } = profile
  let peak = 0
  for (const v of coverage) if (v > peak) peak = v
  // A printed rule covers nearly the whole band; a line of text, spread over
  // its x-height, never reaches this.
  const threshold = Math.max(0.35, peak * 0.45)

  const found: { pos: number; strength: number }[] = []
  let start = -1
  for (let i = 0; i <= coverage.length; i++) {
    const above = i < coverage.length && coverage[i]! >= threshold
    if (above) {
      if (start < 0) start = i
    } else if (start >= 0) {
      let weight = 0
      let acc = 0
      let strength = 0
      for (let k = start; k < i; k++) {
        weight += coverage[k]!
        acc += coverage[k]! * k
        if (coverage[k]! > strength) strength = coverage[k]!
      }
      found.push({ pos: (weight > 0 ? acc / weight : start) - offset, strength })
      start = -1
    }
  }

  const merged: typeof found = []
  for (const p of found) {
    const last = merged[merged.length - 1]
    if (last && p.pos - last.pos < minGap) {
      last.pos = (last.pos + p.pos) / 2
      last.strength = Math.max(last.strength, p.strength)
    } else merged.push({ ...p })
  }
  return merged
}

export interface Chain {
  lines: number[]
  hits: number
  pitch: number
}

/**
 * Longest evenly spaced family among the candidates.
 *
 * Every pair proposes a starting pitch; the walk then steps by it and snaps to
 * nearby candidates, tolerating two consecutive misses so a couple of faint
 * rules cannot end the chain. Misses are filled in, so the result is complete.
 *
 * This is what discards the page header, the magazine logo and the
 * mystery-word strip: none of them belong to the grid's own rhythm.
 *
 * The pitch is *adaptive*. Holding it fixed looks correct but fails in practice:
 * an initial estimate off by a few percent accumulates phase error until real
 * rules fall outside the snap tolerance, and the chain is then truncated well
 * before the end of the grid. Re-estimating from the gaps actually observed also
 * absorbs the gentle change of spacing that perspective introduces.
 */
export function bestArithmeticChain(
  candidates: number[],
  minPitch: number,
  maxPitch: number,
): Chain {
  let best: Chain = { lines: [], hits: 0, pitch: 0 }
  const tolerance = 0.28
  /** Weight given to a newly observed gap when updating the running pitch. */
  const adaptRate = 0.35

  const snap = (target: number, window: number): number | null => {
    let closest: number | null = null
    let bestDist = window
    for (const c of candidates) {
      const d = Math.abs(c - target)
      if (d <= bestDist) {
        bestDist = d
        closest = c
      }
    }
    return closest
  }

  const walk = (origin: number, startPitch: number, direction: 1 | -1) => {
    const out: number[] = []
    let cursor = origin
    let pitch = startPitch
    let hits = 0
    let misses = 0
    while (misses < 2 && out.length < 64) {
      const target = cursor + direction * pitch
      const found = snap(target, pitch * tolerance)
      if (found !== null && Math.abs(found - cursor) > pitch * 0.5) {
        const gap = Math.abs(found - cursor)
        pitch = pitch * (1 - adaptRate) + gap * adaptRate
        out.push(found)
        cursor = found
        hits++
        misses = 0
      } else {
        out.push(target)
        cursor = target
        misses++
      }
    }
    out.length = Math.max(0, out.length - misses) // drop the guesses that ended it
    return { out, hits, pitch }
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const seedPitch = candidates[j]! - candidates[i]!
      if (seedPitch < minPitch || seedPitch > maxPitch) continue
      const forward = walk(candidates[j]!, seedPitch, 1)
      const backward = walk(candidates[i]!, seedPitch, -1)
      const lines = [
        ...backward.out.reverse(),
        candidates[i]!,
        candidates[j]!,
        ...forward.out,
      ]
      const hits = 2 + forward.hits + backward.hits
      if (hits > best.hits) {
        // Report the mean spacing actually realised, not the seed.
        const span = lines[lines.length - 1]! - lines[0]!
        best = { lines, hits, pitch: lines.length > 1 ? span / (lines.length - 1) : seedPitch }
      }
    }
  }
  return best
}

export interface Boundaries {
  /** `curves[i][b]` is boundary i's position at band b. */
  curves: number[][]
  pitch: number
  /** Rules actually seen, versus interpolated. */
  hits: number
  tilt: number
}

/**
 * Finds one axis's boundaries and tracks each of them across the image.
 *
 * Tracking is sequential: each band predicts from the position found in the
 * previous band, so an accumulating bow is followed exactly, while a band with
 * no visible rule simply inherits the prediction instead of creating a kink.
 */
export function detectBoundaries(
  bin: BinaryImage,
  axis: 'rows' | 'cols',
  minCells = 4,
  maxCells = 40,
): Boundaries {
  const sweepExtent = axis === 'rows' ? bin.width : bin.height
  const acrossExtent = axis === 'rows' ? bin.height : bin.width

  const tilt = estimateTilt(bin, axis)
  const minPitch = Math.max(8, acrossExtent / maxCells)
  const maxPitch = acrossExtent / minCells

  // Seed on the central band, then walk outwards.
  const bandWidth = sweepExtent / BANDS
  const anchor = Math.floor(BANDS / 2)
  const bandRange = (b: number) =>
    [Math.round(b * bandWidth), Math.round((b + 1) * bandWidth)] as const

  // Enough slack to absorb the residual bow inside one band, but well under
  // half a cell so two rules can never merge.
  const tolerance = Math.max(2, Math.round(minPitch * 0.25))

  const profiles: BandedProfile[] = []
  const peaksPerBand: { pos: number; strength: number }[][] = []
  for (let b = 0; b < BANDS; b++) {
    const [from, to] = bandRange(b)
    const profile = bandedProfile(bin, axis, tilt, from, to, tolerance)
    profiles.push(profile)
    peaksPerBand.push(profilePeaks(profile, minPitch * 0.45))
  }

  const anchorPeaks = peaksPerBand[anchor]!.map((p) => p.pos)
  const chain = bestArithmeticChain(anchorPeaks, minPitch, maxPitch)
  if (chain.lines.length < 3) {
    return { curves: [], pitch: chain.pitch, hits: chain.hits, tilt }
  }

  const search = chain.pitch * 0.35
  const curves = chain.lines.map((seed) => {
    const positions = new Array<number>(BANDS).fill(seed)

    const track = (direction: 1 | -1) => {
      let previous = seed
      let drift = 0
      for (let b = anchor + direction; b >= 0 && b < BANDS; b += direction) {
        const predicted = previous + drift
        let bestPos: number | null = null
        let bestDist = search
        for (const peak of peaksPerBand[b]!) {
          const d = Math.abs(peak.pos - predicted)
          if (d < bestDist) {
            bestDist = d
            bestPos = peak.pos
          }
        }
        const resolved = bestPos ?? predicted
        // Carry a fraction of the observed step forward: the bow is smooth, so
        // the next band drifts about as much as this one did.
        drift = bestPos !== null ? (resolved - previous) * 0.7 : drift
        positions[b] = resolved
        previous = resolved
      }
    }
    track(1)
    track(-1)

    // One smoothing pass: a band that inherited its prediction should not show
    // up as a corner.
    return positions.map((value, i) => {
      const prev = positions[i - 1] ?? value
      const next = positions[i + 1] ?? value
      return (prev + 2 * value + next) / 4
    })
  })

  repairLadders(curves, peaksPerBand, chain.pitch)
  return { curves, pitch: chain.pitch, hits: chain.hits, tilt }
}

/**
 * Residual, in pitches, past which a boundary is not part of its band's ladder.
 *
 * Judged against a curve, not a line, which is what lets it be this tight. A
 * photographed page bows, so within a band the rule positions trace a shallow arc
 * against their index: measured here it departs from its own chord by 10 to 20px
 * at a pitch of 70. Tested against a straight line, that curvature alone eats a
 * 0.3 tolerance and hides every real outlier inside it.
 */
const LADDER_OUTLIER = 0.17

/** How far a repaired boundary may then move to land on a rule, in pitches. */
const REPAIR_SNAP = 0.12

/**
 * Puts back boundaries that have left their band's ladder, in place.
 *
 * Each boundary is tracked on its own, which is right for following a bow but
 * gives every line exactly one piece of evidence per band — its own rule. Where
 * that rule is faint the tracker takes the nearest thing it can see instead,
 * usually a line of definition text, and the drift term then carries the error
 * onward. On fleches-niveau2-p43 the grid's top boundary ended up 44px below the
 * printed rule at the left of the page, slicing the first row of definitions in
 * half: `ACCROISSEMENT DE LA VITESSE` was read as `LA VITESSE`, and
 * `CERCLE LUMINEUX` was cut away from `PETITE CONSTRUCTION` above its own square.
 *
 * A printed grid, though, is regular: within one band its rules lie on a shallow
 * arc against their index — straight but for the page's own bow. So a boundary
 * that disagrees with a robust fit through its own band is not following the
 * page, it is lost — and its neighbours, which are not, say where it should be.
 * Rebuilding the position of that boundary alone leaves everything the tracker
 * got right untouched.
 *
 * Fitting the whole ladder per band instead of tracking at all was tried, and is
 * worse: the outer bands are mostly margin — band 0 ends at x=117 where the grid
 * starts at x=85 — so, fitted freely, they lock onto the page edge and the
 * binding, and the second test photo lost frame agreement across the board
 * (0.83 → 0.77) along with three definition squares.
 */
function repairLadders(
  curves: number[][],
  peaksPerBand: { pos: number; strength: number }[][],
  pitch: number,
): void {
  const count = curves.length
  if (count < 5) return
  const bands = curves[0]!.length

  for (let b = 0; b < bands; b++) {
    const positions = curves.map((curve) => curve[b]!)
    const predicted = robustArc(positions)
    const sound = positions.map((p, i) => Math.abs(p - predicted[i]!) <= pitch * LADDER_OUTLIER)
    if (sound.every(Boolean)) continue

    for (let i = 0; i < count; i++) {
      if (sound[i]) continue
      // Predict from the nearest boundaries that are still on the ladder. A
      // local line beats the band-wide one because the printed spacing tightens
      // gently across a page: extrapolating the grid's top rule from its four
      // nearest sound neighbours lands within 2px of the print, where the
      // band-wide fit is 17px out.
      const near: number[] = []
      for (let d = 1; d < count && near.length < 4; d++) {
        if (i - d >= 0 && sound[i - d]) near.push(i - d)
        if (near.length < 4 && i + d < count && sound[i + d]) near.push(i + d)
      }
      if (near.length < 2) continue
      const meanI = near.reduce((a, v) => a + v, 0) / near.length
      const meanP = near.reduce((a, v) => a + positions[v]!, 0) / near.length
      let num = 0
      let den = 0
      for (const v of near) {
        num += (v - meanI) * (positions[v]! - meanP)
        den += (v - meanI) ** 2
      }
      let placed = den > 0 ? meanP + (num / den) * (i - meanI) : predicted[i]!

      // Then let it land on a rule, if one is visible right there.
      let bestDist = pitch * REPAIR_SNAP
      for (const peak of peaksPerBand[b]!) {
        const d = Math.abs(peak.pos - placed)
        if (d < bestDist) {
          bestDist = d
          placed = peak.pos
        }
      }
      curves[i]![b] = placed
    }
  }
}

/**
 * Where each boundary of a band would sit if the ladder were undisturbed: a
 * quadratic in the boundary's index, fitted so that a few lost boundaries cannot
 * bend it toward themselves.
 *
 * Quadratic rather than linear because the arc is real — a photographed page
 * bows, and the spacing tightens toward the far edge — so a straight fit would
 * charge the page's own shape to the boundaries and leave no room to see an
 * actual mistake. Robustness comes from refitting on the closer half of the
 * points: an outlier by definition sits in the further half, so it stops pulling
 * after the first pass, while the arc is decided by boundaries that agree.
 */
function robustArc(positions: number[]): number[] {
  const n = positions.length
  const index = positions.map((_, i) => i)
  let weights = positions.map(() => 1)

  const fit = () => {
    // Normal equations for a + b·i + c·i², accumulated directly: n is around
    // twenty, so a 3×3 solve is cheaper than any general routine.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0
    let t0 = 0, t1 = 0, t2 = 0
    for (let k = 0; k < n; k++) {
      const w = weights[k]!
      if (w === 0) continue
      const i = index[k]!
      const y = positions[k]!
      const i2 = i * i
      s0 += w
      s1 += w * i
      s2 += w * i2
      s3 += w * i2 * i
      s4 += w * i2 * i2
      t0 += w * y
      t1 += w * i * y
      t2 += w * i2 * y
    }
    const m = [
      [s0, s1, s2, t0],
      [s1, s2, s3, t1],
      [s2, s3, s4, t2],
    ]
    // Gaussian elimination with partial pivoting.
    for (let col = 0; col < 3; col++) {
      let pivot = col
      for (let row = col + 1; row < 3; row++) {
        if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row
      }
      if (Math.abs(m[pivot]![col]!) < 1e-9) return null
      const swap = m[col]!
      m[col] = m[pivot]!
      m[pivot] = swap
      for (let row = 0; row < 3; row++) {
        if (row === col) continue
        const factor = m[row]![col]! / m[col]![col]!
        for (let k = col; k < 4; k++) m[row]![k]! -= factor * m[col]![k]!
      }
    }
    const coefficients = [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!]
    return index.map((i) => coefficients[0]! + coefficients[1]! * i + coefficients[2]! * i * i)
  }

  let curve = fit()
  if (!curve) return positions.slice()
  for (let pass = 0; pass < 2; pass++) {
    const residuals = positions.map((p, k) => Math.abs(p - curve![k]!))
    const cut = residuals.slice().sort((a, b) => a - b)[Math.floor(n / 2)] ?? 0
    weights = residuals.map((r) => (r <= cut ? 1 : 0))
    const next = fit()
    if (!next) break
    curve = next
  }
  return curve
}

/** Samples a boundary curve at an arbitrary position along the sweep axis. */
export function sampleCurve(curve: number[], sweepPos: number, sweepExtent: number): number {
  const t = (sweepPos / sweepExtent) * BANDS - 0.5
  const i = Math.floor(t)
  const frac = Math.min(1, Math.max(0, t - i))
  const a = curve[Math.min(BANDS - 1, Math.max(0, i))]!
  const b = curve[Math.min(BANDS - 1, Math.max(0, i + 1))]!
  return a + (b - a) * frac
}
