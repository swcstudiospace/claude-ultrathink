// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	validateOrThrow,
	StringValidator,
	NumberValidator,
	BooleanValidator,
	EmailValidator,
	UrlValidator,
	UuidValidator,
	ObjectValidator,
	ArrayValidator,
	commonValidators,
	ValidationException,
} from "./validation.ts";

describe("Validation", () => {
	describe("StringValidator", () => {
		test("validates string", () => {
			const validator = new StringValidator();
			expect(validator.validate("hello").valid).toBe(true);
			expect(validator.validate(123).valid).toBe(false);
		});

		test("validates min/max length", () => {
			const validator = new StringValidator({ minLength: 3, maxLength: 10 });
			expect(validator.validate("hello").valid).toBe(true);
			expect(validator.validate("hi").valid).toBe(false);
			expect(validator.validate("this is too long").valid).toBe(false);
		});

		test("validates pattern", () => {
			const validator = new StringValidator({ pattern: /^[a-z]+$/ });
			expect(validator.validate("hello").valid).toBe(true);
			expect(validator.validate("Hello123").valid).toBe(false);
		});

		test("validates allowed values", () => {
			const validator = new StringValidator({ allowedValues: ["a", "b", "c"] });
			expect(validator.validate("a").valid).toBe(true);
			expect(validator.validate("d").valid).toBe(false);
		});

		test("trims when enabled", () => {
			const validator = new StringValidator({ trim: true, minLength: 3 });
			expect(validator.validate("  hello  ").valid).toBe(true);
			expect(validator.validate("  hi  ").valid).toBe(false);
		});

		test("allows empty when configured", () => {
			const validator = new StringValidator({ allowEmpty: true });
			expect(validator.validate("").valid).toBe(true);
		});
	});

	describe("NumberValidator", () => {
		test("validates number", () => {
			const validator = new NumberValidator();
			expect(validator.validate(42).valid).toBe(true);
			expect(validator.validate("42").valid).toBe(false);
			expect(validator.validate(NaN).valid).toBe(false);
			expect(validator.validate(Infinity).valid).toBe(false);
		});

		test("validates integer", () => {
			const validator = new NumberValidator({ integer: true });
			expect(validator.validate(42).valid).toBe(true);
			expect(validator.validate(42.5).valid).toBe(false);
		});

		test("validates positive", () => {
			const validator = new NumberValidator({ positive: true });
			expect(validator.validate(42).valid).toBe(true);
			expect(validator.validate(-1).valid).toBe(false);
			expect(validator.validate(0).valid).toBe(false);
		});

		test("validates min/max", () => {
			const validator = new NumberValidator({ min: 10, max: 100 });
			expect(validator.validate(50).valid).toBe(true);
			expect(validator.validate(5).valid).toBe(false);
			expect(validator.validate(150).valid).toBe(false);
		});
	});

	describe("BooleanValidator", () => {
		test("validates boolean", () => {
			const validator = new BooleanValidator();
			expect(validator.validate(true).valid).toBe(true);
			expect(validator.validate(false).valid).toBe(true);
			expect(validator.validate("true").valid).toBe(true);
			expect(validator.validate("false").valid).toBe(true);
			expect(validator.validate(1).valid).toBe(true);
			expect(validator.validate(0).valid).toBe(true);
			expect(validator.validate("yes").valid).toBe(false);
		});
	});

	describe("EmailValidator", () => {
		test("validates email", () => {
			const validator = new EmailValidator();
			expect(validator.validate("test@example.com").valid).toBe(true);
			expect(validator.validate("not-an-email").valid).toBe(false);
		});
	});

	describe("UrlValidator", () => {
		test("validates URL", () => {
			const validator = new UrlValidator();
			expect(validator.validate("https://example.com").valid).toBe(true);
			expect(validator.validate("not-a-url").valid).toBe(false);
		});

		test("rejects localhost by default", () => {
			const validator = new UrlValidator();
			expect(validator.validate("http://localhost:3000").valid).toBe(false);
		});
	});

	describe("UuidValidator", () => {
		test("validates UUID", () => {
			const validator = new UuidValidator();
			expect(validator.validate("550e8400-e29b-41d4-a716-446655440000").valid).toBe(true);
			expect(validator.validate("not-a-uuid").valid).toBe(false);
		});
	});

	describe("ObjectValidator", () => {
		test("validates object with schema", () => {
			const validator = new ObjectValidator({
				name: new StringValidator({ minLength: 1 }),
				age: new NumberValidator({ min: 0 }),
			});
			expect(validator.validate({ name: "John", age: 30 }).valid).toBe(true);
			expect(validator.validate({ name: "", age: 30 }).valid).toBe(false);
		});
	});

	describe("ArrayValidator", () => {
		test("validates array", () => {
			const validator = new ArrayValidator(new StringValidator({ minLength: 1 }));
			expect(validator.validate(["a", "b"]).valid).toBe(true);
			expect(validator.validate("not-array").valid).toBe(false);
		});

		test("validates min/max length", () => {
			const validator = new ArrayValidator(new StringValidator({ minLength: 1 }), { minLength: 2, maxLength: 5 });
			expect(validator.validate(["a", "b"]).valid).toBe(true);
			expect(validator.validate(["a"]).valid).toBe(false);
			expect(validator.validate(["a", "b", "c", "d", "e", "f"]).valid).toBe(false);
		});

		test("validates unique", () => {
			const validator = new ArrayValidator(new StringValidator(), { unique: true });
			expect(validator.validate(["a", "b"]).valid).toBe(true);
			expect(validator.validate(["a", "a"]).valid).toBe(false);
		});
	});

	describe("commonValidators", () => {
		test("has sessionId validator", () => {
			expect(commonValidators.sessionId.validate("550e8400-e29b-41d4-a716-446655440000").valid).toBe(true);
		});

		test("has apiKey validator", () => {
			const key = "a".repeat(32);
			expect(commonValidators.apiKey.validate(key).valid).toBe(true);
			expect(commonValidators.apiKey.validate("ab").valid).toBe(false);
		});

		test("has password validator", () => {
			expect(commonValidators.password.validate("securepassword123").valid).toBe(true);
			expect(commonValidators.password.validate("short").valid).toBe(false);
		});

		test("has username validator", () => {
			expect(commonValidators.username.validate("john_doe").valid).toBe(true);
			expect(commonValidators.username.validate("john doe").valid).toBe(false);
		});

		test("has slug validator", () => {
			expect(commonValidators.slug.validate("my-slug").valid).toBe(true);
			expect(commonValidators.slug.validate("My Slug").valid).toBe(false);
		});
	});

	describe("validateOrThrow", () => {
		test("returns value on valid", () => {
			const validator = new StringValidator({ minLength: 1 });
			expect(validateOrThrow("hello", validator)).toBe("hello");
		});

		test("throws ValidationException on invalid", () => {
			const validator = new StringValidator({ minLength: 5 });
			expect(() => validateOrThrow("hi", validator)).toThrow();
			try {
				validateOrThrow("hi", validator);
			} catch (e: unknown) {
				expect(e).toBeInstanceOf(ValidationException);
				if (e instanceof ValidationException) {
					expect(e.name).toBe("ValidationException");
				}
			}
		});
	});
});
