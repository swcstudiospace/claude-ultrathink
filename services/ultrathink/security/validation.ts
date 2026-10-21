// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Input Validation Framework
 * Provides comprehensive input validation at trust boundaries
 */



export interface ValidationResult<T> {
	valid: boolean;
	value?: T;
	errors: ValidationError[];
}

export interface ValidationError {
	field: string;
	code: string;
	message: string;
	received?: unknown;
}

export interface Validator<T> {
	validate(value: unknown): ValidationResult<T>;
}

/**
 * Base validator class
 */
export abstract class BaseValidator<T> implements Validator<T> {
	abstract validate(value: unknown): ValidationResult<T>;

	protected success(value: T): ValidationResult<T> {
		return { valid: true, value, errors: [] };
	}

	protected failure(field: string, code: string, message: string, received?: unknown): ValidationResult<T> {
		return {
			valid: false,
			errors: [{ field, code, message, received }],
		};
	}

	protected combine(...results: ValidationResult<unknown>[]): ValidationResult<T> {
		const errors = results.flatMap((r) => r.errors);
		if (errors.length > 0) {
			return { valid: false, errors };
		}
		return { valid: true, errors: [] };
	}
}

/**
 * String validator with configurable constraints
 */
export class StringValidator extends BaseValidator<string> {
	constructor(
		private options: {
			minLength?: number;
			maxLength?: number;
			pattern?: RegExp;
			allowedValues?: string[];
			trim?: boolean;
			allowEmpty?: boolean;
		} = {}
	) {
		super();
	}

	validate(value: unknown): ValidationResult<string> {
		if (typeof value !== 'string') {
			return this.failure('string', 'TYPE_MISMATCH', 'Value must be a string', value);
		}

		let str = value;
		if (this.options.trim) {
			str = str.trim();
		}

		if (!this.options.allowEmpty && str.length === 0) {
			return this.failure('string', 'EMPTY_STRING', 'String cannot be empty');
		}

		if (this.options.minLength !== undefined && str.length < this.options.minLength) {
			return this.failure('string', 'TOO_SHORT', `String must be at least ${this.options.minLength} characters`, str);
		}

		if (this.options.maxLength !== undefined && str.length > this.options.maxLength) {
			return this.failure('string', 'TOO_LONG', `String must be at most ${this.options.maxLength} characters`, str);
		}

		if (this.options.pattern && !this.options.pattern.test(str)) {
			return this.failure('string', 'PATTERN_MISMATCH', 'String does not match required pattern', str);
		}

		if (this.options.allowedValues && !this.options.allowedValues.includes(str)) {
			return this.failure('string', 'INVALID_VALUE', `String must be one of: ${this.options.allowedValues.join(', ')}`, str);
		}

		return this.success(str);
	}
}

/**
 * Number validator with constraints
 */
export class NumberValidator extends BaseValidator<number> {
	constructor(
		private options: {
			min?: number;
			max?: number;
			integer?: boolean;
			positive?: boolean;
		} = {}
	) {
		super();
	}

	validate(value: unknown): ValidationResult<number> {
		if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
			return this.failure('number', 'TYPE_MISMATCH', 'Value must be a valid number', value);
		}

		if (this.options.integer && !Number.isInteger(value)) {
			return this.failure('number', 'NOT_INTEGER', 'Value must be an integer', value);
		}

		if (this.options.positive && value <= 0) {
			return this.failure('number', 'NOT_POSITIVE', 'Value must be positive', value);
		}

		if (this.options.min !== undefined && value < this.options.min) {
			return this.failure('number', 'TOO_SMALL', `Value must be at least ${this.options.min}`, value);
		}

		if (this.options.max !== undefined && value > this.options.max) {
			return this.failure('number', 'TOO_LARGE', `Value must be at most ${this.options.max}`, value);
		}

		return this.success(value);
	}
}

/**
 * Boolean validator
 */
export class BooleanValidator extends BaseValidator<boolean> {
	validate(value: unknown): ValidationResult<boolean> {
		if (typeof value !== 'boolean') {
			// Try to coerce common string representations
			if (value === 'true' || value === '1' || value === 1) return this.success(true);
			if (value === 'false' || value === '0' || value === 0) return this.success(false);
			return this.failure('boolean', 'TYPE_MISMATCH', 'Value must be a boolean', value);
		}
		return this.success(value);
	}
}

/**
 * Email validator
 */
export class EmailValidator extends BaseValidator<string> {
	private static EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

	validate(value: unknown): ValidationResult<string> {
		const stringResult = new StringValidator({ maxLength: 254 }).validate(value);
		if (!stringResult.valid) return stringResult;

		if (!EmailValidator.EMAIL_REGEX.test(stringResult.value!)) {
			return this.failure('email', 'INVALID_EMAIL', 'Invalid email format', value);
		}

		return this.success(stringResult.value!);
	}
}

/**
 * URL validator
 */
export class UrlValidator extends BaseValidator<string> {
	constructor(private options: { protocols?: string[]; allowLocalhost?: boolean } = {}) {
		super();
	}

	validate(value: unknown): ValidationResult<string> {
		const stringResult = new StringValidator({ maxLength: 2048 }).validate(value);
		if (!stringResult.valid) return stringResult;

		try {
			const url = new URL(stringResult.value!);
			const protocols = this.options.protocols ?? ['http:', 'https:'];
			if (!protocols.includes(url.protocol)) {
				return this.failure('url', 'INVALID_PROTOCOL', `URL must use one of: ${protocols.join(', ')}`, value);
			}
			if (!this.options.allowLocalhost && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')) {
				return this.failure('url', 'LOCALHOST_NOT_ALLOWED', 'Localhost URLs are not allowed', value);
			}
			return this.success(stringResult.value!);
		} catch {
			return this.failure('url', 'INVALID_URL', 'Invalid URL format', value);
		}
	}
}

/**
 * UUID validator
 */
export class UuidValidator extends BaseValidator<string> {
	private static UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

	validate(value: unknown): ValidationResult<string> {
		const stringResult = new StringValidator({ pattern: UuidValidator.UUID_REGEX }).validate(value);
		if (!stringResult.valid) return stringResult;
		return this.success(stringResult.value!);
	}
}

/**
 * JSON object validator with schema
 */
export class ObjectValidator<T extends Record<string, unknown>> extends BaseValidator<T> {
	constructor(
		private schema: Record<string, Validator<unknown>>,
		private options: { allowExtraKeys?: boolean; strict?: boolean } = {}
	) {
		super();
	}

	validate(value: unknown): ValidationResult<T> {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return this.failure('object', 'TYPE_MISMATCH', 'Value must be an object', value);
		}

		const obj = value as Record<string, unknown>;
		const errors: ValidationError[] = [];
		// Copy so accepted unknown keys pass through; schema keys are replaced with their converted values.
		const out: Record<string, unknown> = { ...obj };

		// Validate required fields
		for (const [key, validator] of Object.entries(this.schema)) {
			const result = validator.validate(obj[key]);
			if (!result.valid) {
				errors.push(...result.errors.map((e) => ({ ...e, field: e.field ? `${e.field}` : key })));
			} else if (result.value !== undefined) {
				out[key] = result.value;
			}
		}

		// Check for extra keys
		if (!this.options.allowExtraKeys) {
			const extraKeys = Object.keys(obj).filter((k) => !Object.prototype.hasOwnProperty.call(this.schema, k));
			if (extraKeys.length > 0 && this.options.strict) {
				for (const key of extraKeys) {
					errors.push({ field: key, code: 'UNEXPECTED_FIELD', message: `Unexpected field: ${key}`, received: obj[key] });
				}
			}
		}

		if (errors.length > 0) {
			return { valid: false, errors };
		}

		return { valid: true, value: out as T, errors: [] };
	}
}

/**
 * Array validator
 */
export class ArrayValidator<T> extends BaseValidator<T[]> {
	constructor(
		private itemValidator: Validator<T>,
		private options: { minLength?: number; maxLength?: number; unique?: boolean } = {}
	) {
		super();
	}

	validate(value: unknown): ValidationResult<T[]> {
		if (!Array.isArray(value)) {
			return this.failure('array', 'TYPE_MISMATCH', 'Value must be an array', value);
		}

		if (this.options.minLength !== undefined && value.length < this.options.minLength) {
			return this.failure('array', 'TOO_SHORT', `Array must have at least ${this.options.minLength} items`, value);
		}

		if (this.options.maxLength !== undefined && value.length > this.options.maxLength) {
			return this.failure('array', 'TOO_LONG', `Array must have at most ${this.options.maxLength} items`, value);
		}

		const errors: ValidationError[] = [];
		const results: T[] = [];

		for (let i = 0; i < value.length; i++) {
			const result = this.itemValidator.validate(value[i]);
			if (!result.valid) {
				errors.push(...result.errors.map((e) => ({ ...e, field: `[${i}]${e.field ? `.${e.field}` : ''}` })));
			} else {
				results.push(result.value!);
			}
		}

		if (this.options.unique) {
			const seen = new Set<string>();
			for (let i = 0; i < results.length; i++) {
				const key = JSON.stringify(results[i]);
				if (seen.has(key)) {
					errors.push({ field: `[${i}]`, code: 'DUPLICATE', message: 'Duplicate array item', received: results[i] });
				}
				seen.add(key);
			}
		}

		if (errors.length > 0) {
			return { valid: false, errors };
		}

		return { valid: true, value: results, errors: [] };
	}
}

/**
 * Validates a request body against a schema
 */
export async function validateRequestBody(
	request: Request,
	schema: Record<string, Validator<unknown>>,
	options: { maxBodySize?: number; allowExtraKeys?: boolean } = {}
): Promise<ValidationResult<Record<string, unknown>>> {
	const maxSize = options.maxBodySize ?? 1024 * 1024; // 1MB default
	const tooLarge: ValidationResult<Record<string, unknown>> = {
		valid: false,
		errors: [{ field: 'body', code: 'BODY_TOO_LARGE', message: 'Request body exceeds maximum size' }],
	};

	// Reject on the declared length before reading anything; the streamed count below is the real guard.
	const declared = request.headers.get('content-length');
	if (declared !== null && Number(declared) > maxSize) return tooLarge;

	let bytes: Uint8Array | null;
	try {
		bytes = await readRequestBytes(request, maxSize);
	} catch {
		return { valid: false, errors: [{ field: 'body', code: 'READ_ERROR', message: 'Failed to read request body' }] };
	}
	if (bytes === null) return tooLarge;

	try {
		const body = JSON.parse(new TextDecoder().decode(bytes));
		// Unknown fields are rejected unless the caller opts out with allowExtraKeys.
		const validator = new ObjectValidator(schema, { allowExtraKeys: options.allowExtraKeys ?? false, strict: true });
		return validator.validate(body);
	} catch {
		return { valid: false, errors: [{ field: 'body', code: 'INVALID_JSON', message: 'Request body must be valid JSON' }] };
	}
}

/**
 * Streams the request body and returns null as soon as it exceeds `maxSize` bytes.
 * The stream is cancelled at that point, so nothing past the limit is buffered.
 */
async function readRequestBytes(request: Request, maxSize: number): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxSize) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Common validators for reuse
 */
export const commonValidators = {
	// Session IDs
	sessionId: new UuidValidator(),

	// API keys
	apiKey: new StringValidator({ minLength: 32, maxLength: 128, pattern: /^[a-zA-Z0-9_-]+$/ }),

	// Passwords
	password: new StringValidator({ minLength: 12, maxLength: 128 }),

	// Usernames
	username: new StringValidator({ minLength: 3, maxLength: 64, pattern: /^[a-zA-Z0-9_-]+$/ }),

	// Slugs
	slug: new StringValidator({ minLength: 1, maxLength: 100, pattern: /^[a-z0-9-]+$/ }),

	// Timestamps
	timestamp: new NumberValidator({ min: 0, integer: true }),

	// Durations in milliseconds
	durationMs: new NumberValidator({ min: 0, max: 86400000, integer: true }), // max 24 hours

	// Port numbers
	port: new NumberValidator({ min: 1, max: 65535, integer: true }),

	// IP addresses (basic validation)
	ipAddress: new StringValidator({ pattern: /^(\d{1,3}\.){3}\d{1,3}$|^([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$/i }),

	// Hostnames
	hostname: new StringValidator({ maxLength: 253, pattern: /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/ }),
};

/**
 * Validates an object against a schema and throws on failure
 */
export function validateOrThrow<T>(value: unknown, validator: Validator<T>): T {
	const result = validator.validate(value);
	if (!result.valid) {
		const messages = result.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
		throw new ValidationException(messages, result.errors);
	}
	return result.value!;
}

export class ValidationException extends Error {
	constructor(
		message: string,
		public readonly errors: ValidationError[]
	) {
		super(message);
		this.name = 'ValidationException';
	}
}

export default {
	BaseValidator,
	StringValidator,
	NumberValidator,
	BooleanValidator,
	EmailValidator,
	UrlValidator,
	UuidValidator,
	ObjectValidator,
	ArrayValidator,
	validateRequestBody,
	commonValidators,
	validateOrThrow,
	ValidationException,
};