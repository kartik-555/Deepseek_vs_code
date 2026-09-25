/**
 * Secret redaction for everything this extension writes down.
 *
 * The extension never asks for, stores, or transmits a model credential: the
 * harness owns that, reading named refs (`DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`,
 * …) from its own credential store or the environment. What the extension *can*
 * do is leak one incidentally — runtime stderr can echo an upstream error body,
 * and a traced protocol frame can carry whatever a tool just read.
 *
 * So every line that reaches the output channel, the runtime log file, or the
 * diagnostics report passes through {@link redactSecrets} first. It is a
 * best-effort net, not a guarantee: a secret in a shape it does not know still
 * gets through, which is why the README also says not to paste keys into a
 * prompt. The patterns cover the credential shapes this harness and its
 * providers actually use.
 */

const REDACTED = '[redacted]'

interface Rule {
  pattern: RegExp
  replace: string
}

const RULES: readonly Rule[] = [
  // Known credential refs assigned a value: `DEEPSEEK_API_KEY=…`, `"GOOGLE_API_KEY": "…"`.
  {
    pattern: /\b([A-Z][A-Z0-9_]*(?:API_KEY|_TOKEN|_SECRET|_PASSWORD|ACCESS_KEY|PRIVATE_KEY))\b(\s*[:=]\s*)("?)([^\s"',}]{6,})\3/g,
    replace: `$1$2$3${REDACTED}$3`,
  },
  // Vendor-prefixed keys: OpenAI-style `sk-…`, Anthropic `sk-ant-…`, Google `AIza…`.
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}/g, replace: `sk-${REDACTED}` },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: `AIza${REDACTED}` },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: `xox-${REDACTED}` },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: `gh_${REDACTED}` },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: `github_pat_${REDACTED}` },
  // Authorization headers and Bearer tokens.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: `$1 ${REDACTED}` },
  { pattern: /("?(?:authorization|api[-_]?key|access[-_]?token|x-api-key)"?\s*[:=]\s*"?)([^"',}\s]{8,})/gi, replace: `$1${REDACTED}` },
  // PEM private key bodies.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----` },
]

/**
 * Replace anything that looks like a credential with `[redacted]`.
 *
 * Idempotent, and never lengthens the result, so it is safe to apply on a write
 * path.
 */
export function redactSecrets(text: string): string {
  let output = text
  for (const rule of RULES) {
    output = output.replace(rule.pattern, rule.replace)
  }
  return output
}

/** True when {@link redactSecrets} would change the text. */
export function containsSecretLikeText(text: string): boolean {
  return redactSecrets(text) !== text
}
