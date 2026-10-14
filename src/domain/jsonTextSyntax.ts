const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
const UPPER_E = 0x45;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;
const LOWER_E = 0x65;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

const ARRAY = 0;
const OBJECT = 1;

const isDigit = (code: number): boolean => code >= ZERO && code <= NINE;

const isHexDigit = (code: number): boolean =>
  isDigit(code) ||
  (code >= 0x41 && code <= 0x46) ||
  (code >= 0x61 && code <= 0x66);

/**
 * Whether `JSON.parse` accepts `text`, decided by one iterative scan without
 * throwing. Callers that classify many untrusted payloads use it to avoid the
 * per-payload cost of constructing and catching a SyntaxError.
 */
export const isJsonText = (text: string): boolean => {
  const length = text.length;
  let index = 0;
  const containers: number[] = [];

  const skipWhitespace = (): void => {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (
        code !== SPACE &&
        code !== TAB &&
        code !== LINE_FEED &&
        code !== CARRIAGE_RETURN
      )
        return;
      index += 1;
    }
  };

  const scanString = (): boolean => {
    // The opening quote has been checked by the caller.
    index += 1;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === QUOTE) {
        index += 1;
        return true;
      }
      if (code < SPACE) return false;
      if (code !== BACKSLASH) {
        index += 1;
        continue;
      }
      const escaped = text.charCodeAt(index + 1);
      if (escaped === 0x75) {
        for (let offset = 2; offset < 6; offset += 1)
          if (!isHexDigit(text.charCodeAt(index + offset))) return false;
        index += 6;
        continue;
      }
      if (
        escaped !== QUOTE &&
        escaped !== BACKSLASH &&
        escaped !== SLASH &&
        escaped !== 0x62 &&
        escaped !== 0x66 &&
        escaped !== 0x6e &&
        escaped !== 0x72 &&
        escaped !== 0x74
      )
        return false;
      index += 2;
    }
    return false;
  };

  const scanDigits = (): boolean => {
    const start = index;
    while (index < length && isDigit(text.charCodeAt(index))) index += 1;
    return index > start;
  };

  const scanNumber = (): boolean => {
    if (text.charCodeAt(index) === MINUS) index += 1;
    if (text.charCodeAt(index) === ZERO) index += 1;
    else if (!scanDigits()) return false;
    if (text.charCodeAt(index) === DOT) {
      index += 1;
      if (!scanDigits()) return false;
    }
    const exponent = text.charCodeAt(index);
    if (exponent === LOWER_E || exponent === UPPER_E) {
      index += 1;
      const sign = text.charCodeAt(index);
      if (sign === PLUS || sign === MINUS) index += 1;
      if (!scanDigits()) return false;
    }
    return true;
  };

  const scanLiteral = (literal: string): boolean => {
    if (!text.startsWith(literal, index)) return false;
    index += literal.length;
    return true;
  };

  /** Scan an object key and its colon, leaving `index` at the member value. */
  const scanMemberName = (): boolean => {
    if (text.charCodeAt(index) !== QUOTE || !scanString()) return false;
    skipWhitespace();
    if (text.charCodeAt(index) !== COLON) return false;
    index += 1;
    skipWhitespace();
    return true;
  };

  skipWhitespace();
  for (;;) {
    // A value is expected at `index`.
    const code = text.charCodeAt(index);
    if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      index += 1;
      skipWhitespace();
      const close = code === OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET;
      if (text.charCodeAt(index) === close) index += 1;
      else {
        containers.push(code === OPEN_BRACE ? OBJECT : ARRAY);
        if (code === OPEN_BRACE && !scanMemberName()) return false;
        continue;
      }
    } else if (code === QUOTE) {
      if (!scanString()) return false;
    } else if (code === MINUS || isDigit(code)) {
      if (!scanNumber()) return false;
    } else if (
      !scanLiteral("true") &&
      !scanLiteral("false") &&
      !scanLiteral("null")
    )
      return false;
    // The value is complete; close finished containers or expect a sibling.
    for (;;) {
      skipWhitespace();
      const container = containers.at(-1);
      if (container === undefined) return index === length;
      const next = text.charCodeAt(index);
      if (next === COMMA) {
        index += 1;
        skipWhitespace();
        if (container === OBJECT && !scanMemberName()) return false;
        break;
      }
      if (next !== (container === OBJECT ? CLOSE_BRACE : CLOSE_BRACKET))
        return false;
      index += 1;
      containers.pop();
    }
  }
};
