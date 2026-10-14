/**
 * Strict JSON parser (docs/06): unlike JSON.parse it rejects duplicate keys,
 * raw control characters, trailing garbage, BOM and excessive nesting.
 * It never executes anything and loads nothing remote.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

export type ParseResult = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly error: string }

const MAX_DEPTH = 64
const EOF = "<end>"

class JsonError extends Error {}

class Cursor {
  private pos = 0
  constructor(readonly src: string) {}

  peek(): string {
    return this.pos < this.src.length ? this.src[this.pos]! : EOF
  }

  next(): string {
    const ch = this.peek()
    this.pos++
    return ch
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.pos++
      return true
    }
    return false
  }

  get offset(): number {
    return this.pos
  }

  slice(start: number, end: number): string {
    return this.src.slice(start, end)
  }

  atEnd(): boolean {
    return this.pos >= this.src.length
  }

  fail(message: string): never {
    throw new JsonError(`${message} at offset ${this.pos}`)
  }
}

function describe(ch: string): string {
  return ch === EOF ? "end of input" : JSON.stringify(ch)
}

function skipWhitespace(c: Cursor): void {
  // JSON whitespace only: space, tab, LF, CR.
  while (c.peek() === " " || c.peek() === "\t" || c.peek() === "\n" || c.peek() === "\r") c.next()
}

function parseValue(c: Cursor, depth: number): JsonValue {
  if (depth >= MAX_DEPTH) c.fail("nesting too deep")
  skipWhitespace(c)
  const ch = c.peek()
  if (ch === "{") return parseObject(c, depth)
  if (ch === "[") return parseArray(c, depth)
  if (ch === '"') return parseString(c)
  if (ch === "t") return parseLiteral(c, "true", true)
  if (ch === "f") return parseLiteral(c, "false", false)
  if (ch === "n") return parseLiteral(c, "null", null)
  if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber(c)
  c.fail(`unexpected character ${describe(ch)}`)
}

function parseObject(c: Cursor, depth: number): { readonly [key: string]: JsonValue } {
  c.next() // consume '{'
  // Null prototype: untrusted keys like "__proto__"/"constructor" become plain
  // own properties instead of mutating Object.prototype (fixture R29).
  const out: Record<string, JsonValue> = Object.create(null)
  skipWhitespace(c)
  if (c.eat("}")) return out
  for (;;) {
    skipWhitespace(c)
    if (c.peek() !== '"') c.fail("expected object key string")
    const name = parseString(c)
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      c.fail(`duplicate key ${JSON.stringify(name)}`)
    }
    skipWhitespace(c)
    if (!c.eat(":")) c.fail("expected ':' after object key")
    out[name] = parseValue(c, depth + 1)
    skipWhitespace(c)
    if (c.eat(",")) continue
    if (c.eat("}")) return out
    c.fail("expected ',' or '}' in object")
  }
}

function parseArray(c: Cursor, depth: number): JsonValue[] {
  c.next() // consume '['
  const out: JsonValue[] = []
  skipWhitespace(c)
  if (c.eat("]")) return out
  for (;;) {
    out.push(parseValue(c, depth + 1))
    skipWhitespace(c)
    if (c.eat(",")) continue
    if (c.eat("]")) return out
    c.fail("expected ',' or ']' in array")
  }
}

function parseString(c: Cursor): string {
  c.next() // consume '"'
  let out = ""
  for (;;) {
    const ch = c.next()
    if (ch === EOF) c.fail("unterminated string")
    if (ch === '"') return out
    // Raw control characters (U+0000..U+001F) are invalid inside JSON strings.
    const code = ch.charCodeAt(0)
    if (code <= 0x1f) c.fail(`raw control character U+${code.toString(16).padStart(4, "0")} in string`)
    if (ch !== "\\") {
      out += ch
      continue
    }
    const esc = c.next()
    switch (esc) {
      case '"':
        out += '"'
        break
      case "\\":
        out += "\\"
        break
      case "/":
        out += "/"
        break
      case "b":
        out += "\b"
        break
      case "f":
        out += "\f"
        break
      case "n":
        out += "\n"
        break
      case "r":
        out += "\r"
        break
      case "t":
        out += "\t"
        break
      case "u": {
        const hex = c.slice(c.offset, c.offset + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) c.fail("invalid \\u escape")
        for (let i = 0; i < 4; i++) c.next()
        out += String.fromCharCode(Number.parseInt(hex, 16))
        break
      }
      default:
        c.fail(`invalid escape character ${describe(esc)}`)
    }
  }
}

function parseLiteral(c: Cursor, word: string, value: JsonValue): JsonValue {
  for (const expected of word) {
    if (c.next() !== expected) c.fail(`invalid literal, expected "${word}"`)
  }
  return value
}

function parseNumber(c: Cursor): number {
  const start = c.offset
  if (c.peek() === "-") c.next()
  if (c.eat("0")) {
    // single leading zero only; "01" fails below as trailing content
  } else if (c.peek() >= "0" && c.peek() <= "9") {
    while (c.peek() >= "0" && c.peek() <= "9") c.next()
  } else {
    c.fail("digit expected in number")
  }
  if (c.peek() === ".") {
    c.next()
    if (!(c.peek() >= "0" && c.peek() <= "9")) c.fail("digit expected after '.'")
    while (c.peek() >= "0" && c.peek() <= "9") c.next()
  }
  if (c.peek() === "e" || c.peek() === "E") {
    c.next()
    if (c.peek() === "+" || c.peek() === "-") c.next()
    if (!(c.peek() >= "0" && c.peek() <= "9")) c.fail("digit expected in exponent")
    while (c.peek() >= "0" && c.peek() <= "9") c.next()
  }
  const text = c.slice(start, c.offset)
  const num = Number(text)
  if (!Number.isFinite(num)) c.fail("number is not finite")
  return num
}

/**
 * Parse a complete JSON document. Outer whitespace is allowed; anything else
 * outside the single value (BOM, fences, trailing comma/content) is rejected.
 */
export function parseStrictJson(text: string): ParseResult {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return { ok: false, error: "byte order mark is not allowed" }
  }
  const c = new Cursor(text)
  try {
    const value = parseValue(c, 0)
    skipWhitespace(c)
    if (!c.atEnd()) return { ok: false, error: `trailing content at offset ${c.offset}` }
    return { ok: true, value }
  } catch (error) {
    if (error instanceof JsonError) return { ok: false, error: error.message }
    return { ok: false, error: "internal parse error" }
  }
}
