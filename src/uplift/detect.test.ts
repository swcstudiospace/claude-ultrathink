import { describe, expect, test } from "bun:test";
import { ROOT_TAGS, type UpliftState } from "../types.ts";
import { decideUplift, isAlreadyUplifted, isCommandPrompt, isTrivial, stripPrefix } from "./detect.ts";

function state(overrides?: Partial<UpliftState>): UpliftState {
	return { enabled: true, skipOnce: false, skipTrivial: true, ...overrides };
}

describe("stripPrefix", () => {
	test("strips raw: case-insensitively", () => {
		expect(stripPrefix("raw: do this exactly")).toEqual({ text: "do this exactly", force: false, raw: true });
		expect(stripPrefix("RAW:hello")).toEqual({ text: "hello", force: false, raw: true });
	});

	test("strips uplift: case-insensitively and sets force", () => {
		expect(stripPrefix("uplift: build a form")).toEqual({ text: "build a form", force: true, raw: false });
		expect(stripPrefix("Uplift: ok")).toEqual({ text: "ok", force: true, raw: false });
	});

	test("leaves unprefixed text trimmed", () => {
		expect(stripPrefix("  ship it  ")).toEqual({ text: "ship it", force: false, raw: false });
	});
});

describe("isTrivial", () => {
	const trivial = [
		"yes",
		"y",
		"no",
		"n",
		"ok",
		"okay",
		"k",
		"continue",
		"go",
		"go ahead",
		"do it",
		"please",
		"thanks",
		"thank you",
		"sure",
		"yep",
		"nope",
		"lgtm",
		"OK.",
		"lgtm!",
		"go ahead?",
	];
	for (const text of trivial) {
		test(`treats ${JSON.stringify(text)} as trivial`, () => {
			expect(isTrivial(text)).toBe(true);
		});
	}

	test("does not treat real requests as trivial", () => {
		expect(isTrivial("yes please build it")).toBe(false);
		expect(isTrivial("go build the clients list")).toBe(false);
	});
});

describe("isAlreadyUplifted", () => {
	const tags = [...ROOT_TAGS, "uplifted", "ultrathink"];
	for (const tag of tags) {
		test(`detects ${tag} with brackets`, () => {
			expect(isAlreadyUplifted(`<${tag}><ORIGINAL>x</ORIGINAL></${tag}>`)).toBe(true);
		});
		test(`detects ${tag} without brackets`, () => {
			expect(isAlreadyUplifted(tag)).toBe(true);
		});
	}

	test("is case-insensitive", () => {
		expect(isAlreadyUplifted("<build_prompt>x</build_prompt>")).toBe(true);
		expect(isAlreadyUplifted("UPLIFTED")).toBe(true);
	});

	test("does not match tags mid-sentence", () => {
		expect(isAlreadyUplifted("please BUILD_PROMPT this")).toBe(false);
	});

	test("does not treat tag-prefixed prose as already uplifted", () => {
		expect(isAlreadyUplifted("ultrathink implement the clients list")).toBe(false);
		expect(isAlreadyUplifted("BUILD_PROMPT this feature")).toBe(false);
	});

	test("detects a BUILD_PROMPT document", () => {
		expect(isAlreadyUplifted("<BUILD_PROMPT><ORIGINAL>x</ORIGINAL></BUILD_PROMPT>")).toBe(true);
	});

	test("detects bare BUILD_PROMPT", () => {
		expect(isAlreadyUplifted("BUILD_PROMPT")).toBe(true);
	});
});

describe("decideUplift", () => {
	test("raw: passthroughs stripped text and does not uplift", () => {
		expect(decideUplift({ text: "raw: do this exactly", source: "user" }, state())).toEqual({
			action: "passthrough",
			text: "do this exactly",
		});
	});

	test("uplift: forces even when disabled", () => {
		expect(decideUplift({ text: "uplift: build a form", source: "user" }, state({ enabled: false }))).toEqual({
			action: "uplift",
			text: "build a form",
		});
	});

	test("uplift: forces even when trivial", () => {
		expect(decideUplift({ text: "uplift: ok", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "ok",
		});
	});

	test("skips trivial acknowledgements", () => {
		expect(decideUplift({ text: "lgtm", source: "user" }, state())).toEqual({ action: "skip" });
		expect(decideUplift({ text: "go ahead!", source: "user" }, state())).toEqual({ action: "skip" });
	});

	test("skips slash commands", () => {
		expect(decideUplift({ text: "/help", source: "user" }, state())).toEqual({ action: "skip" });
		expect(decideUplift({ text: "/uplift on", source: "user" }, state())).toEqual({ action: "skip" });
		expect(decideUplift({ text: "/all-in-one:issues list", source: "user" }, state())).toEqual({ action: "skip" });
		expect(isCommandPrompt("/all-in-one:grok status")).toBe(true);
		expect(
			decideUplift(
				{
					text: "<command-name>all-in-one:issues</command-name>\n<command-args>list</command-args>",
					source: "user",
				},
				state(),
			),
		).toEqual({ action: "skip" });
		expect(
			decideUplift(
				{
					text: "<command-message>all-in-one:uplift</command-message>\n<command-name>all-in-one:uplift</command-name>",
					source: "user",
				},
				state(),
			),
		).toEqual({ action: "skip" });
		expect(decideUplift({ text: "<local-command>compact</local-command>", source: "user" }, state())).toEqual({
			action: "skip",
		});
		expect(isCommandPrompt("please run /help later")).toBe(false);
		expect(decideUplift({ text: "please run /help later", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "please run /help later",
		});
	});

	test("skips already-uplifted roots", () => {
		for (const tag of [...ROOT_TAGS, "uplifted", "ultrathink"]) {
			expect(decideUplift({ text: `<${tag}>x</${tag}>`, source: "user" }, state())).toEqual({ action: "skip" });
			expect(decideUplift({ text: tag, source: "user" }, state())).toEqual({ action: "skip" });
		}
	});

	test("skipOnce skips then clears", () => {
		const current = state({ skipOnce: true });
		expect(decideUplift({ text: "build a form", source: "user" }, current)).toEqual({ action: "skip" });
		expect(current.skipOnce).toBe(false);
		expect(decideUplift({ text: "build a form", source: "user" }, current)).toEqual({
			action: "uplift",
			text: "build a form",
		});
	});

	test("disabled skips unless force prefix", () => {
		const current = state({ enabled: false });
		expect(decideUplift({ text: "build a form", source: "user" }, current)).toEqual({ action: "skip" });
		expect(decideUplift({ text: "uplift: build a form", source: "user" }, current)).toEqual({
			action: "uplift",
			text: "build a form",
		});
	});

	test("skips extension source", () => {
		expect(decideUplift({ text: "build a form", source: "extension" }, state())).toEqual({ action: "skip" });
		expect(decideUplift({ text: "uplift: build a form", source: "extension" }, state())).toEqual({ action: "skip" });
	});

	test("skips steer streaming behavior", () => {
		expect(decideUplift({ text: "build a form", source: "user", streamingBehavior: "steer" }, state())).toEqual({
			action: "skip",
		});
	});

	test("skips empty after strip", () => {
		expect(decideUplift({ text: "   ", source: "user" }, state())).toEqual({ action: "skip" });
		expect(decideUplift({ text: "uplift:  ", source: "user" }, state())).toEqual({ action: "skip" });
		expect(decideUplift({ text: "raw:", source: "user" }, state())).toEqual({ action: "skip" });
		expect(decideUplift({ text: "raw:   ", source: "user" }, state())).toEqual({ action: "skip" });
	});

	test("skipTrivial false uplifts trivial text", () => {
		expect(decideUplift({ text: "ok", source: "user" }, state({ skipTrivial: false }))).toEqual({
			action: "uplift",
			text: "ok",
		});
	});

	test("uplifts a normal request", () => {
		expect(decideUplift({ text: "add a clients list page", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "add a clients list page",
		});
	});

	test("uplifts ultrathink prose that is not a tag", () => {
		expect(isAlreadyUplifted("ultrathink implement the clients list")).toBe(false);
		expect(
			decideUplift({ text: "ultrathink implement the clients list", source: "interactive" }, state()),
		).toEqual({
			action: "uplift",
			text: "ultrathink implement the clients list",
		});
	});

	test("skips when session is not idle", () => {
		expect(decideUplift({ text: "also fix the button", source: "interactive", idle: false }, state())).toEqual({
			action: "skip",
		});
	});

	test("uplifts when idle is true or undefined", () => {
		expect(decideUplift({ text: "also fix the button", source: "interactive", idle: true }, state())).toEqual({
			action: "uplift",
			text: "also fix the button",
		});
		expect(decideUplift({ text: "also fix the button", source: "interactive" }, state())).toEqual({
			action: "uplift",
			text: "also fix the button",
		});
	});
});
