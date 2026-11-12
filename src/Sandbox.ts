import {
  AsyncFunction,
  createExecContext,
  SandboxCapabilityError,
  SandboxExecutionQuotaExceededError,
  sanitizeScopes,
} from './utils';
import type { IExecContext, IOptionParams, IScope } from './utils';
import { createEvalContext } from './eval';
import { ExecReturn } from './executor';
import parse from './parser';
import SandboxExec from './SandboxExec';
export { ParseError } from './parser';
export {
  LocalScope,
  SandboxExecutionTreeError,
  SandboxCapabilityError,
  SandboxAccessError,
  SandboxExecutionQuotaExceededError,
  SandboxError,
  delaySynchronousResult,
} from './utils';

export type * from './utils';
export type * from './parser';
export type * from './executor';
export type * from './eval';

export class Sandbox extends SandboxExec {
  constructor(options?: IOptionParams) {
    super(options, createEvalContext());
  }

  /**
   * Default execution quota (in ticks) applied to audit runs when the caller
   * does not provide one. Keeps hostile or runaway samples from blocking the
   * auditing process indefinitely.
   */
  static readonly DEFAULT_AUDIT_EXECUTION_QUOTA = 1_000_000n;

  static audit<T>(code: string, scopes: IScope[] = [], options: IOptionParams = {}): ExecReturn<T> {
    const globals: Record<string, unknown> = {};
    for (const i of Object.getOwnPropertyNames(globalThis) as [keyof typeof globalThis]) {
      globals[i] = globalThis[i];
    }
    const sandbox = new SandboxExec({
      ...options,
      globals,
      audit: true,
      executionQuota: options.executionQuota ?? Sandbox.DEFAULT_AUDIT_EXECUTION_QUOTA,
    });
    const context = createExecContext(
      sandbox,
      parse(code, true, false, sandbox.context.options.maxParserRecursionDepth),
      createEvalContext(),
    );
    installAuditStubs(context);
    try {
      return sandbox.executeTree(context, scopes);
    } catch (e) {
      const report = sandbox.context.auditReport;
      if (report && e instanceof SandboxExecutionQuotaExceededError) {
        report.quotaExceeded = true;
        return new ExecReturn<T>(report, undefined!, false);
      }
      throw e;
    }
  }

  static parse(code: string) {
    return parse(code, true);
  }

  get Function() {
    const context = createExecContext(
      this,
      {
        tree: [],
        constants: {
          strings: [],
          eager: true,
          literals: [],
          maxDepth: this.context.options.maxParserRecursionDepth,
          regexes: [],
        },
      },
      this.evalContext,
    );
    return context.evals.get(Function)!;
  }

  get AsyncFunction() {
    const context = createExecContext(
      this,
      {
        tree: [],
        constants: {
          strings: [],
          eager: true,
          literals: [],
          maxDepth: this.context.options.maxParserRecursionDepth,
          regexes: [],
        },
      },
      this.evalContext,
    );
    return context.evals.get(AsyncFunction)!;
  }

  get eval() {
    const context = createExecContext(
      this,
      {
        tree: [],
        constants: {
          strings: [],
          eager: true,
          literals: [],
          maxDepth: this.context.options.maxParserRecursionDepth,
          regexes: [],
        },
      },
      this.evalContext,
    );
    return context.evals.get(eval)!;
  }

  compile<T>(
    code: string,
    optimize = false,
  ): (...scopes: IScope[]) => { context: IExecContext; run: () => T } {
    if (this.context.options.nonBlocking)
      throw new SandboxCapabilityError(
        'Non-blocking mode is enabled, use Sandbox.compileAsync() instead.',
      );
    const parsed = parse(code, optimize, false, this.context.options.maxParserRecursionDepth);
    const context = createExecContext(this, parsed, this.evalContext);
    const exec = (...scopes: IScope[]) => {
      sanitizeScopes(scopes, context);
      return { context, run: () => this.executeTree<T>(context, [...scopes]).result };
    };
    return exec;
  }

  compileAsync<T>(
    code: string,
    optimize = false,
  ): (...scopes: IScope[]) => { context: IExecContext; run: () => Promise<T> } {
    const parsed = parse(code, optimize, false, this.context.options.maxParserRecursionDepth);
    const context = createExecContext(this, parsed, this.evalContext);
    const exec = (...scopes: IScope[]) => {
      sanitizeScopes(scopes, context);
      return {
        context,
        run: () => this.executeTreeAsync<T>(context, [...scopes]).then((ret) => ret.result),
      };
    };
    return exec;
  }

  compileExpression<T>(
    code: string,
    optimize = false,
  ): (...scopes: IScope[]) => { context: IExecContext; run: () => T } {
    const parsed = parse(code, optimize, true, this.context.options.maxParserRecursionDepth);
    const context = createExecContext(this, parsed, this.evalContext);
    const exec = (...scopes: IScope[]) => {
      sanitizeScopes(scopes, context);
      return { context, run: () => this.executeTree<T>(context, [...scopes]).result };
    };
    return exec;
  }

  compileExpressionAsync<T>(
    code: string,
    optimize = false,
  ): (...scopes: IScope[]) => { context: IExecContext; run: () => Promise<T> } {
    const parsed = parse(code, optimize, true, this.context.options.maxParserRecursionDepth);
    const context = createExecContext(this, parsed, this.evalContext);
    const exec = (...scopes: IScope[]) => {
      return {
        context,
        run: () => this.executeTreeAsync<T>(context, [...scopes]).then((ret) => ret.result),
      };
    };
    return exec;
  }
}

export default Sandbox;

const AUDIT_CONSOLE_METHODS = ['debug', 'error', 'info', 'log', 'table', 'warn'] as const;

/**
 * Replaces the host `console` and timer functions exposed to audited code with
 * inert recording stubs. Audited samples must not produce host side effects
 * (console output, scheduled timers) before the audit report is generated, so
 * every call is captured into the audit report instead of reaching the host.
 */
function installAuditStubs(context: IExecContext): void {
  const ctx = context.ctx;

  const auditConsole: Record<string, unknown> = {};
  for (const method of AUDIT_CONSOLE_METHODS) {
    auditConsole[method] = (...args: unknown[]) => {
      ctx.auditReport?.consoleCalls.push({ method, args });
    };
  }

  let timerHandleCounter = 0;
  const schedule =
    (type: 'setTimeout' | 'setInterval') =>
    (_handler: unknown, timeout?: number, ..._args: unknown[]): number => {
      const handle = ++timerHandleCounter;
      ctx.auditReport?.timerCalls.push({ type, handle, timeout });
      return handle;
    };
  const cancel = (type: 'clearTimeout' | 'clearInterval') => (handle?: number): void => {
    ctx.auditReport?.timerCalls.push({ type, handle });
  };

  const auditSetTimeout = schedule('setTimeout');
  const auditSetInterval = schedule('setInterval');
  const auditClearTimeout = cancel('clearTimeout');
  const auditClearInterval = cancel('clearInterval');

  ctx.sandboxGlobal.console = auditConsole;
  ctx.sandboxGlobal.setTimeout = auditSetTimeout;
  ctx.sandboxGlobal.setInterval = auditSetInterval;
  ctx.sandboxGlobal.clearTimeout = auditClearTimeout;
  ctx.sandboxGlobal.clearInterval = auditClearInterval;

  context.evals.set(setTimeout, auditSetTimeout);
  context.evals.set(setInterval, auditSetInterval);
  context.evals.set(clearTimeout, auditClearTimeout);
  context.evals.set(clearInterval, auditClearInterval);

  ctx.globalsWhitelist.add(auditConsole);
  ctx.globalsWhitelist.add(auditSetTimeout);
  ctx.globalsWhitelist.add(auditSetInterval);
  ctx.globalsWhitelist.add(auditClearTimeout);
  ctx.globalsWhitelist.add(auditClearInterval);
}
