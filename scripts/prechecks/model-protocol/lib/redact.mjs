// 落盘脱敏：任何写入产物的文本（错误消息、note 等）都必须过 redactText。
// 只替换、不抛出原文；scan/assertClean 用于发送前检查（拒绝把秘密带出站）。
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const PATTERNS = [
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi },
  { kind: 'authorization-header', re: /Authorization\s*[:=]\s*[^\s,;]+/gi },
  { kind: 'sk-key', re: /\bsk-[A-Za-z0-9_-]{6,}\b/g },
  { kind: 'api-key-assignment', re: /\bapi[_-]?key\b\s*[:=]\s*[^\s,;]+/gi },
]

export function createRedactor({ extraSecrets = [] } = {}) {
  const literals = extraSecrets.filter(s => typeof s === 'string' && s.length > 0)
  return {
    registerSecret(value) {
      if (typeof value === 'string' && value.length > 0) literals.push(value)
    },
    redactValue(value) {
      return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? this.redactText(item) : item))
    },
    redactText(text) {
      if (typeof text !== 'string') return text
      let out = text
      for (const { re } of PATTERNS) out = out.replace(re, '[REDACTED]')
      for (const secret of literals) out = out.split(secret).join('[REDACTED]')
      return out
    },
    scan(text) {
      if (typeof text !== 'string') return []
      const kinds = PATTERNS.filter(({ re }) => text.match(re) !== null).map(p => p.kind)
      for (const secret of literals) if (text.includes(secret)) kinds.push('registered-secret')
      return kinds
    },
    assertClean(text, where) {
      const kinds = this.scan(text)
      if (kinds.length > 0) {
        throw new Error(`拒绝发送：${where ?? 'payload'} 疑似包含秘密（${kinds.join(', ')}）`)
      }
    },
  }
}
