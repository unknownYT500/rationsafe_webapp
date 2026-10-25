// web/src/core/logger.ts
/**
 * PII-Scrubbed Structured Logger (TypeScript / Node.js)
 * 
 * Provides Winston/Pino-compatible structured JSON logging with automated recursive
 * scrubbing of citizen Aadhaar numbers, phone numbers, beneficiary names, and private keys.
 * Integrated with W3C OpenTelemetry distributed tracing context.
 */

import { TelemetryEngine } from './telemetry.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'AUDIT';

export interface LogEntry {
  timestamp: string;
  service: string;
  level: LogLevel;
  message: string;
  trace_id?: string;
  span_id?: string;
  traceparent?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export class StructuredLogger {
  private serviceName: string;
  private static inMemoryLogs: LogEntry[] = [];
  public static enableConsoleOutput = false; // Silence raw console in automated tests

  constructor(serviceName = 'central_gateway') {
    this.serviceName = serviceName;
  }

  private static aadhaarRegex = /\b(?:\d{4}[ -]?\d{4}[ -]?\d{4})\b/g;
  private static phoneRegex = /\b(?:\+91[\-\s]?)?[6-9]\d{9}\b/g;

  private static sensitiveKeyPatterns = [
    'name',
    'fullname',
    'first_name',
    'last_name',
    'address',
    'income',
    'yearly_income',
    'privatekey',
    'secret',
    'signature',
    'password',
    'pin',
  ];

  /**
   * Recursively sanitizes data structures to eliminate citizen PII and secret leakage.
   */
  public static scrubPii<T>(data: T): T {
    if (data === null || data === undefined) return data;

    if (typeof data === 'string') {
      return this.scrubText(data) as unknown as T;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.scrubPii(item)) as unknown as T;
    }

    if (typeof data === 'object') {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        const lowerKey = key.toLowerCase();

        if (this.sensitiveKeyPatterns.some((pattern) => lowerKey.includes(pattern))) {
          if (lowerKey.includes('private') || lowerKey.includes('secret') || lowerKey.includes('key')) {
            scrubbed[key] = '[REDACTED_SECRET]';
          } else {
            scrubbed[key] = '[REDACTED_PII]';
          }
        } else if (lowerKey.includes('aadhaar')) {
          scrubbed[key] = this.maskAadhaar(String(value ?? ''));
        } else if (lowerKey.includes('phone')) {
          scrubbed[key] = this.maskPhone(String(value ?? ''));
        } else if (lowerKey.includes('card') && typeof value === 'string') {
          scrubbed[key] = value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
        } else {
          scrubbed[key] = this.scrubPii(value);
        }
      }
      return scrubbed as T;
    }

    return data;
  }

  public static scrubText(text: string): string {
    let result = text;
    // Mask Aadhaar numbers
    result = result.replace(this.aadhaarRegex, (match) => {
      const clean = match.replace(/\D/g, '');
      if (clean.length === 12) {
        return `XXXX-XXXX-${clean.slice(-4)}`;
      }
      return match;
    });

    // Mask Indian phone numbers
    result = result.replace(this.phoneRegex, (match) => {
      const clean = match.replace(/\D/g, '');
      if (clean.length >= 10) {
        return `+91-XXXXX-${clean.slice(-4)}`;
      }
      return match;
    });

    return result;
  }

  public static maskAadhaar(aadhaar: string): string {
    const clean = aadhaar.replace(/\D/g, '');
    if (clean.length === 12) {
      return `XXXX-XXXX-${clean.slice(-4)}`;
    }
    return 'XXXX-XXXX-XXXX';
  }

  public static maskPhone(phone: string): string {
    const clean = phone.replace(/\D/g, '');
    if (clean.length >= 10) {
      return `+91-XXXXX-${clean.slice(-4)}`;
    }
    return '+91-XXXXX-XXXX';
  }

  private writeLog(level: LogLevel, message: string, data?: Record<string, unknown>, error?: unknown): LogEntry {
    const activeCtx = TelemetryEngine.getActiveContext();

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      service: this.serviceName,
      level,
      message: StructuredLogger.scrubText(message),
      trace_id: activeCtx?.traceId,
      span_id: activeCtx?.spanId,
      traceparent: activeCtx ? TelemetryEngine.formatTraceparent(activeCtx) : undefined,
      data: data ? StructuredLogger.scrubPii(data) : undefined,
      error: error ? StructuredLogger.scrubText(error instanceof Error ? error.message : String(error)) : undefined,
    };

    StructuredLogger.inMemoryLogs.push(entry);

    if (StructuredLogger.enableConsoleOutput) {
      console.log(JSON.stringify(entry));
    }

    return entry;
  }

  public debug(message: string, data?: Record<string, unknown>): LogEntry {
    return this.writeLog('DEBUG', message, data);
  }

  public info(message: string, data?: Record<string, unknown>): LogEntry {
    return this.writeLog('INFO', message, data);
  }

  public warn(message: string, data?: Record<string, unknown>): LogEntry {
    return this.writeLog('WARN', message, data);
  }

  public error(message: string, error?: unknown, data?: Record<string, unknown>): LogEntry {
    return this.writeLog('ERROR', message, data, error);
  }

  public audit(message: string, data?: Record<string, unknown>): LogEntry {
    return this.writeLog('AUDIT', message, data);
  }

  public static getLogs(): LogEntry[] {
    return [...this.inMemoryLogs];
  }

  public static clear(): void {
    this.inMemoryLogs = [];
  }
}
