/**
 * Minimal Jinja2-compatible renderer for the notification email templates.
 *
 * The FastAPI backend renders `backend/templates/email/<locale>/<key>.html`
 * with Jinja2 (autoescape on, `trim_blocks` + `lstrip_blocks`). Express has no
 * Jinja, so this module implements exactly the subset those templates use:
 *
 * - `{{ expr }}` / `{{ expr | default('x') }}` (also `lower`, `upper`, `trim`)
 * - `{% if %}` / `{% elif %}` / `{% else %}` / `{% endif %}` (`and`, `or`, `not`,
 *   `==`, `!=`, `>`, `<`, `>=`, `<=`, `~`)
 * - `{% for x in list %}` … `{% endfor %}`
 * - `{% extends %}` + `{% block %}` / `{% endblock %}` + `{{ super() }}`
 * - `{# comments #}`
 *
 * Semantics mirror Python: undefined is falsy, `""`/`0`/`[]`/`{}` are falsy,
 * `a != b` compares native values. Anything outside the subset raises
 * `TemplateSyntaxError` instead of rendering garbage — a loud failure beats an
 * email that silently drops a block.
 */

export type TemplateContext = Record<string, unknown>;

export class TemplateSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateSyntaxError';
  }
}

/** Undefined variable sentinel (Jinja's `Undefined`). */
export const UNDEFINED: unique symbol = Symbol('undefined');
export type Undefined = typeof UNDEFINED;

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string };

const TWO_CHAR_OPS = ['==', '!=', '>=', '<=', '||', '&&'];
const ONE_CHAR_OPS = ['|', '~', '(', ')', ',', '.', '[', ']', '>', '<', '+', '-'];

function tokenizeExpression(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) {
          const next = source[index + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      if (source[index] !== quote) throw new TemplateSyntaxError('Unterminated string literal');
      index += 1;
      tokens.push({ kind: 'str', value });
      continue;
    }
    if (/[0-9]/.test(char)) {
      const match = /^\d+(?:\.\d+)?/.exec(source.slice(index));
      if (!match) throw new TemplateSyntaxError(`Bad number near ${source.slice(index)}`);
      tokens.push({ kind: 'num', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
      if (!match) throw new TemplateSyntaxError(`Bad identifier near ${source.slice(index)}`);
      tokens.push({ kind: 'name', value: match[0] });
      index += match[0].length;
      continue;
    }
    const two = TWO_CHAR_OPS.find((candidate) => source.startsWith(candidate, index));
    const operator = two ?? ONE_CHAR_OPS.find((candidate) => source.startsWith(candidate, index));
    if (!operator) throw new TemplateSyntaxError(`Unsupported character '${char}' in expression`);
    tokens.push({ kind: 'op', value: operator });
    index += operator.length;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

interface LiteralNode {
  type: 'literal';
  value: unknown;
}

interface NameNode {
  type: 'name';
  name: string;
}

interface AttributeNode {
  type: 'attribute';
  target: Expr;
  key: string;
}

interface IndexNode {
  type: 'index';
  target: Expr;
  key: Expr;
}

interface UnaryNode {
  type: 'not';
  operand: Expr;
}

interface BinaryNode {
  type: 'binary';
  operator: string;
  left: Expr;
  right: Expr;
}

interface FilterNode {
  type: 'filter';
  name: string;
  operand: Expr;
  args: Expr[];
}

interface CallNode {
  type: 'call';
  name: string;
}

/** Appel de méthode sur une valeur : `dt.strftime('%d/%m/%Y')`. */
interface MethodNode {
  type: 'method';
  target: Expr;
  name: string;
  args: Expr[];
}

/** Tranche Python : `name[11:16]`, `name[:5]`, `name[3:]`. */
interface SliceNode {
  type: 'slice';
  target: Expr;
  start: Expr | null;
  stop: Expr | null;
}

/** `a if cond else b` (Jinja conditional expression). */
interface ConditionalNode {
  type: 'conditional';
  test: Expr;
  then: Expr;
  otherwise: Expr;
}

/** `expr is [not] test` — seuls `defined` / `undefined` / `none` / `string`… */
interface TestNode {
  type: 'test';
  name: string;
  negated: boolean;
  operand: Expr;
}

export type Expr =
  | LiteralNode
  | NameNode
  | AttributeNode
  | IndexNode
  | UnaryNode
  | BinaryNode
  | FilterNode
  | CallNode
  | MethodNode
  | SliceNode
  | ConditionalNode
  | TestNode;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class ExpressionParser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parseAll(): Expr {
    const expression = this.parseOr();
    if (this.position < this.tokens.length) {
      throw new TemplateSyntaxError('Unexpected trailing tokens in expression');
    }
    return expression;
  }

  parseConditionalAll(): Expr {
    const expression = this.parseConditional();
    if (this.position < this.tokens.length) {
      throw new TemplateSyntaxError('Unexpected trailing tokens in expression');
    }
    return expression;
  }

  /**
   * Expression conditionnelle Jinja : `a if cond else b`, et sa forme
   * sans `else` (`a if cond` → indéfini quand la condition est fausse).
   */
  private parseConditional(): Expr {
    const then = this.parseOr();
    if (!this.acceptName('if')) return then;
    const test = this.parseOr();
    const otherwise: Expr = this.acceptName('else')
      ? this.parseConditional()
      : { type: 'name', name: '__undefined__' };
    return { type: 'conditional', test, then, otherwise };
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token {
    const token = this.tokens[this.position];
    if (!token) throw new TemplateSyntaxError('Unexpected end of expression');
    this.position += 1;
    return token;
  }

  private acceptOp(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'op' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private acceptName(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'name' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private expectOp(value: string): void {
    if (!this.acceptOp(value)) throw new TemplateSyntaxError(`Expected '${value}'`);
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (true) {
      if (this.acceptName('or') || this.acceptOp('||')) {
        left = { type: 'binary', operator: 'or', left, right: this.parseAnd() };
        continue;
      }
      // `x is defined`, `x is not none`, `x not in y`
      const token = this.peek();
      if (token && token.kind === 'name' && token.value === 'is') {
        this.position += 1;
        const negated = this.acceptName('not');
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new TemplateSyntaxError('Expected a test name');
        left = { type: 'test', name: nameToken.value, negated, operand: left };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.acceptName('and') || this.acceptOp('&&')) {
      left = { type: 'binary', operator: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.acceptName('not')) return { type: 'not', operand: this.parseNot() };
    const left = this.parseComparison();
    const token = this.peek();
    if (token && token.kind === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(token.value)) {
      this.position += 1;
      const right = this.parseComparison();
      return { type: 'binary', operator: token.value, left, right };
    }
    if (token && token.kind === 'name' && token.value === 'in') {
      this.position += 1;
      return { type: 'binary', operator: 'in', left, right: this.parseComparison() };
    }
    if (
      token &&
      token.kind === 'name' &&
      token.value === 'not' &&
      this.tokens[this.position + 1]?.kind === 'name' &&
      this.tokens[this.position + 1]?.value === 'in'
    ) {
      this.position += 2;
      return { type: 'binary', operator: 'notin', left, right: this.parseComparison() };
    }
    return left;
  }

  /** Comparisons bind looser than `~` in Jinja; kept simple here. */
  private parseComparison(): Expr {
    return this.parseFiltered();
  }

  private parseFiltered(): Expr {
    let operand = this.parseConcat();
    while (this.acceptOp('|')) {
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new TemplateSyntaxError('Expected a filter name');
      const args: Expr[] = [];
      if (this.acceptOp('(')) {
        while (!this.acceptOp(')')) {
          args.push(this.parseOr());
          if (this.acceptOp(')')) break;
          this.expectOp(',');
        }
      }
      operand = { type: 'filter', name: nameToken.value, operand, args };
    }
    return operand;
  }

  private parseConcat(): Expr {
    let left = this.parseAdditive();
    while (this.acceptOp('~')) {
      left = { type: 'binary', operator: '~', left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parsePostfix();
    for (;;) {
      if (this.acceptOp('+')) {
        left = { type: 'binary', operator: '+', left, right: this.parsePostfix() };
        continue;
      }
      if (this.acceptOp('-')) {
        left = { type: 'binary', operator: '-', left, right: this.parsePostfix() };
        continue;
      }
      break;
    }
    return left;
  }

  private parsePostfix(): Expr {
    let target = this.parsePrimary();
    for (;;) {
      if (this.acceptOp('.')) {
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new TemplateSyntaxError('Expected an attribute name');
        target = { type: 'attribute', target, key: nameToken.value };
        continue;
      }
      if (this.acceptOp('(') && target.type === 'attribute') {
        const args: Expr[] = [];
        while (!this.acceptOp(')')) {
          args.push(this.parseOr());
          if (this.acceptOp(')')) break;
          this.expectOp(',');
        }
        target = { type: 'method', target: target.target, name: target.key, args };
        continue;
      }
      if (this.acceptOp('[')) {
        // Tranche Python `[a:b]` (strftime / sous-chaîne de dates).
        let start: Expr | null = null;
        if (!this.acceptOp(':')) {
          start = this.parseOr();
          if (!this.acceptOp(':')) {
            this.expectOp(']');
            target = { type: 'index', target, key: start };
            continue;
          }
        }
        let stop: Expr | null = null;
        if (!this.acceptOp(']')) {
          stop = this.parseOr();
          this.expectOp(']');
        }
        target = { type: 'slice', target, start, stop };
        continue;
      }
      break;
    }
    return target;
  }

  private parsePrimary(): Expr {
    const token = this.next();
    if (token.kind === 'str' || token.kind === 'num') {
      return { type: 'literal', value: token.value };
    }
    if (token.kind === 'name') {
      if (token.value === 'true' || token.value === 'True') return { type: 'literal', value: true };
      if (token.value === 'false' || token.value === 'False') return { type: 'literal', value: false };
      if (token.value === 'none' || token.value === 'None') return { type: 'literal', value: null };
      if (this.acceptOp('(')) {
        if (token.value !== 'super') {
          throw new TemplateSyntaxError(`Unsupported call: ${token.value}()`);
        }
        this.expectOp(')');
        return { type: 'call', name: 'super' };
      }
      return { type: 'name', name: token.value };
    }
    if (token.kind === 'op' && token.value === '(') {
      const inner = this.parseOr();
      this.expectOp(')');
      return inner;
    }
    throw new TemplateSyntaxError(`Unexpected token in expression: ${JSON.stringify(token)}`);
  }
}

function parseExpression(source: string): Expr {
  return new ExpressionParser(tokenizeExpression(source)).parseAll();
}

/** Expression complète avec `a if cond else b` (niveau racine). */
function parseConditionalExpression(source: string): Expr {
  const parser = new ExpressionParser(tokenizeExpression(source));
  const expression = parser.parseConditionalAll();
  return expression;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvalScope {
  context: TemplateContext;
  superContent?: () => string;
}

export function lookupMember(target: unknown, key: unknown): unknown {
  if (target === UNDEFINED || target === null || target === undefined) return UNDEFINED;
  if (target instanceof Map) {
    const value = target.get(String(key));
    return value === undefined ? UNDEFINED : value;
  }
  if (Array.isArray(target)) {
    if (key === 'length') return target.length;
    const index = Number(key);
    const value = Number.isInteger(index) ? target[index] : undefined;
    return value === undefined ? UNDEFINED : value;
  }
  if (typeof target === 'object') {
    const value = (target as Record<string, unknown>)[String(key)];
    return value === undefined ? UNDEFINED : value;
  }
  return UNDEFINED;
}

/** Jinja truthiness: undefined/null/false/''/0/[]/{} are falsy. */
export function truthy(value: unknown): boolean {
  if (value === UNDEFINED || value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    if (value instanceof Date) return true;
    return Object.keys(value as object).length > 0;
  }
  return Boolean(value);
}

/** Python `str()` for the value shapes this module carries. */
export function toText(value: unknown): string {
  if (value === UNDEFINED || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const a = toText(left);
  const b = toText(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function iterableValue(value: unknown): Iterable<unknown> {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split('');
  if (value instanceof Map) return value.values();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record);
  }
  return [];
}

/**
 * Méthodes Python que les templates utilisent (`datetime.strftime`). Le
 * format strftime est traduit en équivalent JS ; inconnu → erreur explicite.
 */
function callMethod(target: unknown, name: string, args: unknown[]): unknown {
  if (name === 'strftime') {
    const format = toText(args[0] ?? '');
    const date = target instanceof Date ? target : null;
    if (!date) return UNDEFINED;
    const pad = (value: number) => String(value).padStart(2, '0');
    return format
      .replace(/%d/g, pad(date.getUTCDate()))
      .replace(/%m/g, pad(date.getUTCMonth() + 1))
      .replace(/%Y/g, String(date.getUTCFullYear()))
      .replace(/%H/g, pad(date.getUTCHours()))
      .replace(/%M/g, pad(date.getUTCMinutes()))
      .replace(/%S/g, pad(date.getUTCSeconds()));
  }
  if (name === 'lower' && typeof target === 'string') return target.toLowerCase();
  if (name === 'upper' && typeof target === 'string') return target.toUpperCase();
  if (name === 'strip' && typeof target === 'string') return target.trim();
  if (name === 'title' && typeof target === 'string') {
    return target.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  }
  if (name === 'replace' && typeof target === 'string') {
    return target.split(toText(args[0] ?? '')).join(toText(args[1] ?? ''));
  }
  throw new TemplateSyntaxError(`Unsupported method call: .${name}()`);
}

function testValue(name: string, value: unknown): boolean {
  switch (name) {
    case 'defined':
      return value !== UNDEFINED;
    case 'undefined':
      return value === UNDEFINED;
    case 'none':
    case 'null':
      return value === null || value === UNDEFINED;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'iterable':
      return Array.isArray(value) || typeof value === 'string' || (value !== null && typeof value === 'object');
    case 'mapping':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    default:
      throw new TemplateSyntaxError(`Unsupported test: '${name}'`);
  }
}

function applyFilter(name: string, value: unknown, args: unknown[]): unknown {
  switch (name) {
    case 'default':
    case 'd': {
      const fallback = args.length > 0 ? args[0] : '';
      // Jinja: la deuxième position est `boolean` — vraie → toute valeur
      // *fausse* (pas seulement indéfinie) est remplacée.
      const replaceFalsy = truthy(args[1]);
      if (value === UNDEFINED || value === null) return fallback;
      return replaceFalsy && !truthy(value) ? fallback : value;
    }
    case 'lower':
      return toText(value).toLowerCase();
    case 'upper':
      return toText(value).toUpperCase();
    case 'trim':
      return toText(value).trim();
    case 'length':
    case 'count':
      if (Array.isArray(value) || typeof value === 'string') return value.length;
      return typeof value === 'object' && value !== null ? Object.keys(value).length : 0;
    case 'capitalize': {
      const text = toText(value);
      return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    }
    case 'title':
      return toText(value).replace(/\S+/g, (word) =>
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      );
    case 'join':
      return [...iterableValue(value)].map((item) => toText(item)).join(toText(args[0] ?? ''));
    case 'string':
      return toText(value);
    case 'int': {
      const parsed = Number.parseInt(toText(value), 10);
      return Number.isNaN(parsed) ? (args[0] as number | undefined) ?? 0 : parsed;
    }
    case 'float': {
      const parsed = Number(toText(value));
      return Number.isNaN(parsed) ? (args[0] as number | undefined) ?? 0 : parsed;
    }
    case 'replace':
      return toText(value).split(toText(args[0] ?? '')).join(toText(args[1] ?? ''));
    case 'safe':
      return value;
    case 'first': {
      const items = [...iterableValue(value)];
      return items.length > 0 ? items[0] : UNDEFINED;
    }
    case 'last': {
      const items = [...iterableValue(value)];
      return items.length > 0 ? items[items.length - 1] : UNDEFINED;
    }
    default:
      throw new TemplateSyntaxError(`Unsupported filter: '${name}'`);
  }
}

export function evaluate(expression: Expr, scope: EvalScope): unknown {
  switch (expression.type) {
    case 'literal':
      return expression.value;
    case 'name': {
      const value = scope.context[expression.name];
      return value === undefined ? UNDEFINED : value;
    }
    case 'attribute':
      return lookupMember(evaluate(expression.target, scope), expression.key);
    case 'index':
      return lookupMember(evaluate(expression.target, scope), evaluate(expression.key, scope));
    case 'not':
      return !truthy(evaluate(expression.operand, scope));
    case 'filter':
      return applyFilter(
        expression.name,
        evaluate(expression.operand, scope),
        expression.args.map((arg) => evaluate(arg, scope)),
      );
    case 'call':
      // `super()` — resolved by the block renderer.
      return { __super__: scope.superContent ? scope.superContent() : '' };
    case 'method':
      return callMethod(
        evaluate(expression.target, scope),
        expression.name,
        expression.args.map((arg) => evaluate(arg, scope)),
      );
    case 'slice': {
      const value = evaluate(expression.target, scope);
      const items = typeof value === 'string' ? value : null;
      const start = expression.start ? Number(evaluate(expression.start, scope)) : undefined;
      const stop = expression.stop ? Number(evaluate(expression.stop, scope)) : undefined;
      if (items !== null) return items.slice(start, stop);
      if (Array.isArray(value)) return value.slice(start, stop);
      return UNDEFINED;
    }
    case 'binary': {
      switch (expression.operator) {
        case 'or': {
          const left = evaluate(expression.left, scope);
          return truthy(left) ? left : evaluate(expression.right, scope);
        }
        case 'and': {
          const left = evaluate(expression.left, scope);
          return truthy(left) ? evaluate(expression.right, scope) : left;
        }
        case '~':
          return `${toText(evaluate(expression.left, scope))}${toText(evaluate(expression.right, scope))}`;
        case '+': {
          const left = evaluate(expression.left, scope);
          const right = evaluate(expression.right, scope);
          if (typeof left === 'number' && typeof right === 'number') return left + right;
          return `${toText(left)}${toText(right)}`;
        }
        case '-': {
          const left = evaluate(expression.left, scope);
          const right = evaluate(expression.right, scope);
          return typeof left === 'number' && typeof right === 'number' ? left - right : Number.NaN;
        }
        case '==': {
          const left = evaluate(expression.left, scope);
          const right = evaluate(expression.right, scope);
          return (left === UNDEFINED ? undefined : left) === (right === UNDEFINED ? undefined : right);
        }
        case '!=': {
          const left = evaluate(expression.left, scope);
          const right = evaluate(expression.right, scope);
          return (left === UNDEFINED ? undefined : left) !== (right === UNDEFINED ? undefined : right);
        }
        case '>':
          return compare(evaluate(expression.left, scope), evaluate(expression.right, scope)) > 0;
        case '<':
          return compare(evaluate(expression.left, scope), evaluate(expression.right, scope)) < 0;
        case '>=':
          return compare(evaluate(expression.left, scope), evaluate(expression.right, scope)) >= 0;
        case '<=':
          return compare(evaluate(expression.left, scope), evaluate(expression.right, scope)) <= 0;
        case 'in': {
          const needle = evaluate(expression.left, scope);
          const haystack = evaluate(expression.right, scope);
          if (typeof haystack === 'string') return haystack.includes(toText(needle));
          return [...iterableValue(haystack)].includes(needle);
        }
        case 'notin': {
          const needle = evaluate(expression.left, scope);
          const haystack = evaluate(expression.right, scope);
          if (typeof haystack === 'string') return !haystack.includes(toText(needle));
          return ![...iterableValue(haystack)].includes(needle);
        }
        default:
          throw new TemplateSyntaxError(`Unsupported operator '${expression.operator}'`);
      }
    }
    case 'conditional':
      return truthy(evaluate(expression.test, scope))
        ? evaluate(expression.then, scope)
        : evaluate(expression.otherwise, scope);
    case 'test': {
      const result = testValue(expression.name, evaluate(expression.operand, scope));
      return expression.negated ? !result : result;
    }
    default:
      throw new TemplateSyntaxError('Unknown expression node');
  }
}

// ---------------------------------------------------------------------------
// Template parsing (tags → tree)
// ---------------------------------------------------------------------------

type TemplateNode =
  | { type: 'text'; value: string }
  | { type: 'output'; expression: Expr }
  | { type: 'if'; branches: Array<{ condition: Expr | null; body: TemplateNode[] }> }
  | { type: 'for'; iterator: string; iterable: Expr; body: TemplateNode[] }
  | { type: 'block'; name: string; body: TemplateNode[] };

interface TemplateAst {
  extendsName: string | null;
  body: TemplateNode[];
}

type LexToken =
  | { type: 'tag'; content: string }
  | { type: 'text'; value: string }
  | { type: 'output'; content: string };

/**
 * Jinja `trim_blocks` + `lstrip_blocks` preprocessing for one source string:
 * a block indented on its own line loses the indent, and the newline right
 * after the closing `%}` is dropped.
 */
export function preprocessBlocks(source: string): string {
  return source
    .replace(/^[ \t]+(?=\{%[-+]?)/gm, '')
    .replace(/(\{%[-+]?[\s\S]*?[-+]?%\})(?:\r?\n)/g, '$1');
}

function lex(source: string): LexToken[] {
  const tokens: LexToken[] = [];
  const pattern = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#[\s\S]*?#\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: source.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) tokens.push({ type: 'output', content: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: 'tag', content: match[2] });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < source.length) tokens.push({ type: 'text', value: source.slice(lastIndex) });
  return tokens;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTemplate(source: string): TemplateAst {
  const tokens = lex(preprocessBlocks(source));
  let index = 0;
  let extendsName: string | null = null;

  const parseBody = (stopTags: string[]): { body: TemplateNode[]; stop: string | null } => {
    const body: TemplateNode[] = [];
    while (index < tokens.length) {
      const token = tokens[index]!;
      index += 1;
      if (token.type === 'text') {
        body.push({ type: 'text', value: token.value });
        continue;
      }
      if (token.type === 'output') {
        body.push({ type: 'output', expression: parseConditionalExpression(token.content) });
        continue;
      }
      const content = token.content.trim();
      const keyword = content.split(/\s+/)[0] ?? '';
      if (stopTags.includes(keyword)) return { body, stop: content };
      switch (keyword) {
        case 'extends':
          extendsName = unquote(content.slice('extends'.length));
          break;
        case 'block': {
          const name = content.slice('block'.length).trim();
          const inner = parseBody(['endblock']);
          if (!inner.stop) throw new TemplateSyntaxError(`Unclosed block '${name}'`);
          body.push({ type: 'block', name, body: inner.body });
          break;
        }
        case 'if': {
          const branches: Array<{ condition: Expr | null; body: TemplateNode[] }> = [];
          let condition: Expr | null = parseConditionalExpression(content.slice('if'.length));
          for (;;) {
            const inner = parseBody(['elif', 'else', 'endif']);
            branches.push({ condition, body: inner.body });
            if (!inner.stop) throw new TemplateSyntaxError('Unclosed {% if %}');
            const stopKeyword = inner.stop.split(/\s+/)[0];
            if (stopKeyword === 'elif') {
              condition = parseConditionalExpression(inner.stop.slice('elif'.length));
              continue;
            }
            if (stopKeyword === 'else') {
              condition = null;
              continue;
            }
            break;
          }
          body.push({ type: 'if', branches });
          break;
        }
        case 'for': {
          const match = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/.exec(content);
          if (!match) throw new TemplateSyntaxError(`Unsupported for tag: ${content}`);
          const inner = parseBody(['endfor']);
          if (!inner.stop) throw new TemplateSyntaxError('Unclosed {% for %}');
          body.push({
            type: 'for',
            iterator: match[1]!,
            iterable: parseExpression(match[2]!),
            body: inner.body,
          });
          break;
        }
        default:
          throw new TemplateSyntaxError(`Unsupported template tag: {% ${keyword} %}`);
      }
    }
    return { body, stop: null };
  };

  const { body } = parseBody([]);
  return { extendsName, body };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type BlockResolver = (name: string) => string;

function renderNodes(
  nodes: TemplateNode[],
  scope: EvalScope,
  escape: boolean,
  resolveBlock: BlockResolver,
): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.value;
        break;
      case 'output': {
        const value = evaluate(node.expression, scope);
        if (value !== null && typeof value === 'object' && '__super__' in (value as object)) {
          const raw = (value as { __super__: string }).__super__;
          out += escape ? escapeHtml(raw) : raw;
          break;
        }
        const text = toText(value);
        out += escape ? escapeHtml(text) : text;
        break;
      }
      case 'if': {
        for (const branch of node.branches) {
          if (branch.condition === null || truthy(evaluate(branch.condition, scope))) {
            out += renderNodes(branch.body, scope, escape, resolveBlock);
            break;
          }
        }
        break;
      }
      case 'for': {
        const iterable = evaluate(node.iterable, scope);
        const items = Array.isArray(iterable)
          ? iterable
          : iterable instanceof Map
            ? [...iterable.values()]
            : iterable instanceof Set
              ? [...iterable]
              : [];
        for (const item of items) {
          out += renderNodes(
            node.body,
            { ...scope, context: { ...scope.context, [node.iterator]: item } },
            escape,
            resolveBlock,
          );
        }
        break;
      }
      case 'block':
        out += resolveBlock(node.name);
        break;
      default:
        throw new TemplateSyntaxError('Unknown template node');
    }
  }
  return out;
}

function collectBlocks(body: TemplateNode[], into: Map<string, TemplateNode[]>): Map<string, TemplateNode[]> {
  for (const node of body) {
    if (node.type === 'block') {
      if (!into.has(node.name)) into.set(node.name, node.body);
      collectBlocks(node.body, into);
    } else if (node.type === 'if') {
      for (const branch of node.branches) collectBlocks(branch.body, into);
    } else if (node.type === 'for') {
      collectBlocks(node.body, into);
    }
  }
  return into;
}

export interface RenderOptions {
  /** `select_autoescape(["html", "xml"])` equivalent; default true. */
  escape?: boolean;
}

export type TemplateLoader = (name: string) => string | null;

/**
 * Render a template source. `{% extends %}` resolves through `loader`
 * (e.g. `base.html`). Mirrors `jinja2.Environment(trim_blocks=True,
 * lstrip_blocks=True, autoescape=select_autoescape(...))`.
 */
export function renderTemplate(
  source: string,
  context: TemplateContext,
  loader: TemplateLoader,
  options: RenderOptions = {},
): string {
  const escape = options.escape ?? true;
  const ast = parseTemplate(source);
  if (!ast.extendsName) {
    return renderNodes(ast.body, { context }, escape, () => '');
  }

  // Resolve the inheritance chain child → … → base, collecting blocks in
  // order of precedence (the innermost child wins).
  const chain: TemplateNode[][] = [ast.body];
  let parentName: string | null = ast.extendsName;
  let baseAst: TemplateAst = ast;
  const seen = new Set<string>();
  while (parentName) {
    if (seen.has(parentName)) throw new TemplateSyntaxError(`Circular extends: ${parentName}`);
    seen.add(parentName);
    const parentSource = loader(parentName);
    if (parentSource === null) throw new TemplateSyntaxError(`Parent template not found: ${parentName}`);
    const parentAst: TemplateAst = parseTemplate(parentSource);
    chain.push(parentAst.body);
    baseAst = parentAst;
    parentName = parentAst.extendsName;
  }

  const overrides: Array<Map<string, TemplateNode[]>> = chain.map((body) => collectBlocks(body, new Map()));
  const rendered = new Map<string, string>();

  const renderBlockAt = (level: number, name: string): string => {
    const cacheKey = `${level}:${name}`;
    const cached = rendered.get(cacheKey);
    if (cached !== undefined) return cached;
    const own = overrides[level]?.get(name);
    if (own) {
      const superContent = () => renderBlockAt(level + 1, name);
      const value = renderNodes(own, { context, superContent }, escape, (nested) =>
        renderBlockAt(level, nested),
      );
      rendered.set(cacheKey, value);
      return value;
    }
    if (level + 1 < overrides.length) return renderBlockAt(level + 1, name);
    rendered.set(cacheKey, '');
    return '';
  };

  return renderNodes(baseAst.body, { context }, escape, (name) => renderBlockAt(0, name));
}
