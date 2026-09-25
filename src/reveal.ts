/**
 * Cosmetic progressive reveal for committed answers.
 *
 * The SDK wire has no token deltas: a message arrives once its step commits.
 * `dshVscode.animateChunks` therefore animates a finished answer rather than
 * streaming it, by walking the text out in slices. The slice plan is pure so it
 * can be checked without a runtime or a timer.
 */

/** Below this length an answer is shown whole; animating a line is only noise. */
export const REVEAL_MIN_LENGTH = 120

/** Bounds on the number of steps, so short and long answers both feel right. */
export const REVEAL_MIN_STEPS = 6
export const REVEAL_MAX_STEPS = 48

/** Roughly one step per this many characters. */
const CHARS_PER_STEP = 32

/**
 * Slice plan for one answer: the visible prefixes in order, ending with the
 * complete text. Returns an empty plan when the text is too short to animate.
 */
export function revealSlices(
  text: string,
  options: { minLength?: number; maxSteps?: number; charsPerStep?: number } = {},
): string[] {
  const minLength = options.minLength ?? REVEAL_MIN_LENGTH
  const maxSteps = options.maxSteps ?? REVEAL_MAX_STEPS
  const charsPerStep = options.charsPerStep ?? CHARS_PER_STEP
  if (text.length <= minLength || charsPerStep <= 0 || maxSteps < 2) return []
  const steps = Math.min(maxSteps, Math.max(REVEAL_MIN_STEPS, Math.round(text.length / charsPerStep)))
  const slices: string[] = []
  for (let step = 1; step < steps; step += 1) {
    slices.push(text.slice(0, Math.ceil((text.length * step) / steps)))
  }
  slices.push(text)
  return slices
}
