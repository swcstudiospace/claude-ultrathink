// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { toActivityNotice } from "./activity-notice.ts";

describe("activity notice path filter", () => {
	test("drops absolute paths after quotes, backticks and brackets, and keeps ordinary slashes", () => {
		const notice = toActivityNotice({
			v: 1,
			kind: "teachable-created",
			title: 'Fix "/srv/private/app.env" loading',
			names: ["see `/root/secrets.txt` and (/etc/hosts)"],
			detail: "and/or ratio 1/2",
		});
		expect(notice).toBeDefined();
		const text = JSON.stringify(notice);
		expect(text).not.toContain("/srv");
		expect(text).not.toContain("/root");
		expect(text).not.toContain("/etc");
		expect(text).toContain("and/or");
		expect(text).toContain("1/2");
	});
});
