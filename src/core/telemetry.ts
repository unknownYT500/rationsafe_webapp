// src/core/telemetry.ts
/**
 * OpenTelemetry-Compatible Distributed Tracing Engine (TypeScript)
 *
 * Implements the W3C Trace Context Specification (traceparent: 00-{trace_id}-{span_id}-{trace_flags})
 * for distributed end-to-end tracing across Mobile POS, Edge Nodes, Express Gateways, and Supabase RPCs.
 */

import crypto from 'node:crypto';

export interface TraceContext {
  version: string;     // '00'
  traceId: string;     // 16 bytes = 32 hex chars
  spanId: string;      // 8 bytes = 16 hex chars
  traceFlags: string;  // 1 byte = 2 hex chars ('01' = sampled)
}

export type SpanStatus = 'OK' | 'ERROR' | 'UNSET';

export interface SpanRecord {
  name: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  traceparent: string;
  start_time: string;
  end_time?: string;
  duration_ms: number;
  status: SpanStatus;
  error_message?: string;
  attributes: Record<string, unknown>;
}

function isHex(value: string, length: number): boolean {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);
}

export class Span {
  public readonly name: string;
  public readonly context: TraceContext;
  public readonly parentSpanId?: string;
  public readonly startTime: number;
  public endTime?: number;
  public status: SpanStatus = 'OK';
  public errorMessage?: string;
  public attributes: Record<string, unknown>;

  constructor(name: string, context: TraceContext, parentSpanId?: string, attributes: Record<string, unknown> = {}) {
    this.name = name;
    this.context = context;
    this.parentSpanId = parentSpanId;
    this.startTime = Date.now();
    this.attributes = { ...attributes };
  }

  public setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }

  public end(status: SpanStatus = 'OK', error?: string): void {
    this.endTime = Date.now();
    this.status = status;
    if (error) {
      this.status = 'ERROR';
      this.errorMessage = error;
    }
  }

  public get durationMs(): number {
    const end = this.endTime ?? Date.now();
    return end - this.startTime;
  }

  public toRecord(): SpanRecord {
    return {
      name: this.name,
      trace_id: this.context.traceId,
      span_id: this.context.spanId,
      parent_span_id: this.parentSpanId,
      traceparent: TelemetryEngine.formatTraceparent(this.context),
      start_time: new Date(this.startTime).toISOString(),
      end_time: this.endTime ? new Date(this.endTime).toISOString() : undefined,
      duration_ms: this.durationMs,
      status: this.status,
      error_message: this.errorMessage,
      attributes: this.attributes,
    };
  }
}

export class TelemetryEngine {
  private static spans: Span[] = [];
  private static currentContext: TraceContext | null = null;

  /**
   * Generates a 16-byte (32-character hex) W3C traceId.
   */
  public static generateTraceId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Generates an 8-byte (16-character hex) W3C spanId.
   */
  public static generateSpanId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Formats a TraceContext object into standard W3C traceparent header string:
   * 00-{trace_id}-{span_id}-{trace_flags}
   */
  public static formatTraceparent(ctx: TraceContext): string {
    return `${ctx.version}-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
  }

  /**
   * Parses an incoming W3C traceparent header string.
   */
  public static parseTraceparent(header?: string): TraceContext | null {
    if (typeof header !== 'string') return null;
    const trimmed = header.trim();
    const parts = trimmed.split('-');
    if (parts.length !== 4) return null;
    const [version, traceId, spanId, traceFlags] = parts;
    if (version !== '00') return null;
    if (!isHex(traceId, 32) || traceId === '00000000000000000000000000000000') return null;
    if (!isHex(spanId, 16) || spanId === '0000000000000000') return null;
    if (!isHex(traceFlags, 2)) return null;
    return {
      version,
      traceId,
      spanId,
      traceFlags,
    };
  }

  /**
   * Allocates a new TraceContext (either child of existing or root).
   */
  public static createTraceContext(parent?: TraceContext | string): TraceContext {
    const parentCtx = typeof parent === 'string' ? this.parseTraceparent(parent) : parent;
    if (parentCtx) {
      return {
        version: parentCtx.version,
        traceId: parentCtx.traceId,
        spanId: this.generateSpanId(),
        traceFlags: parentCtx.traceFlags,
      };
    }
    return {
      version: '00',
      traceId: this.generateTraceId(),
      spanId: this.generateSpanId(),
      traceFlags: '01',
    };
  }

  /**
   * Starts a new span, recording it in the distributed tracer buffer.
   */
  public static startSpan(
    name: string,
    options?: {
      parent?: TraceContext | string;
      attributes?: Record<string, unknown>;
    }
  ): Span {
    const parentCtx = options?.parent
      ? typeof options.parent === 'string'
        ? this.parseTraceparent(options.parent)
        : options.parent
      : this.currentContext;

    const ctx = this.createTraceContext(parentCtx ?? undefined);
    const span = new Span(name, ctx, parentCtx?.spanId, options?.attributes);
    this.currentContext = ctx;
    this.spans.push(span);
    return span;
  }

  /**
   * Wraps an async operation in an OpenTelemetry span scope with automated lifecycle and error capturing.
   */
  public static async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: { parent?: TraceContext | string; attributes?: Record<string, unknown> }
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await fn(span);
      span.end('OK');
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      span.end('ERROR', message);
      throw err;
    }
  }

  public static getActiveContext(): TraceContext | null {
    return this.currentContext;
  }

  public static setActiveContext(ctx: TraceContext | null): void {
    this.currentContext = ctx;
  }

  public static getSpans(): SpanRecord[] {
    return this.spans.map((s) => s.toRecord());
  }

  public static clear(): void {
    this.spans = [];
    this.currentContext = null;
  }
}

