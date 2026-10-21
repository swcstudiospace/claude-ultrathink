// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Security Event Logging
 * Provides structured security event logging for SIEM integration
 */

import { type Logger, createLogger } from "../obs/log.ts";

export enum SecurityEventType {
	AUTH_FAILURE = 'auth_failure',
	AUTH_SUCCESS = 'auth_success',
	VALIDATION_FAILURE = 'validation_failure',
	RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
	SUSPICIOUS_ACTIVITY = 'suspicious_activity',
	UNAUTHORIZED_ACCESS = 'unauthorized_access',
	PRIVILEGE_ESCALATION = 'privilege_escalation',
	DATA_ACCESS = 'data_access',
	CONFIG_CHANGE = 'config_change',
	SECURITY_SCAN = 'security_scan',
}

export interface SecurityEvent {
	type: SecurityEventType;
	/** Structured log event name, such as auth.login_failed. Without it, the log event is security.<type>. */
	name?: string;
	timestamp: number;
	severity: 'low' | 'medium' | 'high' | 'critical';
	source: string;
	userId?: string;
	ip?: string;
	userAgent?: string;
	resource?: string;
	action?: string;
	details: Record<string, unknown>;
	correlationId?: string;
}

export interface SecurityEventLogger {
	log(event: SecurityEvent): void;
	logAuthFailure(details: Partial<SecurityEvent>): void;
	logValidationFailure(details: Partial<SecurityEvent>): void;
	logRateLimitExceeded(details: Partial<SecurityEvent>): void;
	logSuspiciousActivity(details: Partial<SecurityEvent>): void;
}

function generateCorrelationId(): string {
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getCurrentTimestamp(): number {
	return Date.now();
}

const LOG_LEVEL = { low: "info", medium: "warn", high: "warn", critical: "error" } as const;

export class ConsoleSecurityEventLogger implements SecurityEventLogger {
	private severityOrder = { low: 0, medium: 1, high: 2, critical: 3 };
	private minSeverity: 'low' | 'medium' | 'high' | 'critical' = 'low';
	private readonly logger: Logger;

	/** Writes through the app's structured logger, which stamps each line and drops secret-named fields. */
	constructor(logger: Logger = createLogger()) {
		this.logger = logger;
	}

	setMinSeverity(severity: 'low' | 'medium' | 'high' | 'critical'): void {
		this.minSeverity = severity;
	}

	log(event: SecurityEvent): void {
		if (this.severityOrder[event.severity] < this.severityOrder[this.minSeverity]) {
			return;
		}

		const { name, ...fields } = event;
		const entry = {
			...fields,
			timestamp: event.timestamp || getCurrentTimestamp(),
			correlationId: event.correlationId || generateCorrelationId(),
		};
		// The app's structured logger is the event feed: one JSON line per event, level taken from the severity.
		this.logger[LOG_LEVEL[event.severity]](name ?? `security.${event.type}`, entry);
	}

	logAuthFailure(details: Partial<SecurityEvent>): void {
		this.log({
			type: SecurityEventType.AUTH_FAILURE,
			severity: 'medium',
			source: 'auth',
			...details,
			details: { ...details.details, eventType: 'auth_failure' },
		} as SecurityEvent);
	}

	logValidationFailure(details: Partial<SecurityEvent>): void {
		this.log({
			type: SecurityEventType.VALIDATION_FAILURE,
			severity: 'low',
			source: 'validation',
			...details,
			details: { ...details.details, eventType: 'validation_failure' },
		} as SecurityEvent);
	}

	logRateLimitExceeded(details: Partial<SecurityEvent>): void {
		this.log({
			type: SecurityEventType.RATE_LIMIT_EXCEEDED,
			severity: 'medium',
			source: 'rate_limit',
			...details,
			details: { ...details.details, eventType: 'rate_limit_exceeded' },
		} as SecurityEvent);
	}

	logSuspiciousActivity(details: Partial<SecurityEvent>): void {
		this.log({
			type: SecurityEventType.SUSPICIOUS_ACTIVITY,
			severity: 'high',
			source: 'security_monitor',
			...details,
			details: { ...details.details, eventType: 'suspicious_activity' },
		} as SecurityEvent);
	}
}

/**
 * Writes each event through the console logger, then hands it to `onEvent` (phase 68 streaming). A failing `onEvent`
 * never reaches the caller: the request that raised the event continues.
 */
export class StreamingSecurityEventLogger extends ConsoleSecurityEventLogger {
	private readonly onEvent: (event: SecurityEvent) => void;

	constructor(logger: Logger, onEvent: (event: SecurityEvent) => void) {
		super(logger);
		this.onEvent = onEvent;
	}

	override log(event: SecurityEvent): void {
		super.log(event);
		try {
			this.onEvent(event);
		} catch {
			// A stream failure must not change what the request sees.
		}
	}
}

let loggerInstance: SecurityEventLogger = new ConsoleSecurityEventLogger();

export function getSecurityLogger(): SecurityEventLogger {
	return loggerInstance;
}

export function setSecurityLogger(logger: SecurityEventLogger): void {
	loggerInstance = logger;
}

export function createSecurityEvent(
	type: SecurityEventType,
	details: Partial<SecurityEvent> = {}
): SecurityEvent {
	return {
		type,
		timestamp: Date.now(),
		severity: 'medium',
		source: 'application',
		details: {},
		...details,
	} as SecurityEvent;
}

export function logSecurityEvent(event: SecurityEvent): void {
	loggerInstance.log(event);
}

export default {
	SecurityEventType,
	ConsoleSecurityEventLogger,
	getSecurityLogger,
	setSecurityLogger,
	createSecurityEvent,
	logSecurityEvent,
};