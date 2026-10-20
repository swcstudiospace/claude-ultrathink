// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Output Encoding Utilities
 * Provides contextual output encoding to prevent XSS and injection attacks
 */

/**
 * HTML entity encoding
 * Encodes characters that have special meaning in HTML
 */
export function encodeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\//g, "&#x2F;");
}

/**
 * HTML attribute encoding
 * Encodes characters for safe inclusion in HTML attribute values
 */
export function encodeHtmlAttribute(input: string): string {
  return encodeHtml(input).replace(/`/g, '&#x60;');
}

/**
 * JavaScript string encoding
 * Encodes for safe inclusion in JavaScript string literals
 */
export function encodeJavaScript(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\x08/g, '\\b')
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/=/g, '\\u003D')
    .replace(/-/g, '\\u002D')
    .replace(/;/g, '\\u003B');
}

/**
 * JSON encoding for safe inclusion in JSON contexts
 */
export function encodeJson(input: unknown): string {
  return JSON.stringify(input);
}

/**
 * URL encoding for query parameters and URL paths
 */
export function encodeUrl(input: string): string {
  return encodeURIComponent(input);
}

/**
 * URL encoding for form data (spaces as +)
 */
export function encodeFormUrl(input: string): string {
  return encodeURIComponent(input).replace(/%20/g, '+');
}

/**
 * CSS encoding for safe inclusion in CSS contexts
 */
export function encodeCss(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, (char) => {
    const code = char.charCodeAt(0);
    return '\\' + code.toString(16).padStart(4, '0') + ' ';
  });
}

/**
 * SQL identifier quoting (for table/column names)
 * Note: Prefer parameterized queries over identifier quoting
 */
export function quoteSqlIdentifier(input: string): string {
  // Only allow alphanumeric and underscore
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input)) {
    throw new Error(`Invalid SQL identifier: ${input}`);
  }
  return `"${input}"`;
}

/**
 * Shell argument escaping (for command execution)
 * Use with extreme caution - prefer child_process.spawn with array args
 */
export function escapeShellArg(input: string): string {
  // Single quote the entire argument and escape any single quotes inside
  return "'" + input.replace(/'/g, "'\\''") + "'";
}

/**
 * LDAP DN escaping
 */
export function escapeLdapDn(input: string): string {
  return input
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\x00/g, '\\00');
}

/**
 * LDAP filter escaping
 */
export function escapeLdapFilter(input: string): string {
  return input
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\x00/g, '\\00');
}

/**
 * XPath expression escaping
 */
export function escapeXPath(input: string): string {
  // If string contains no quotes, wrap in single quotes
  if (!input.includes("'") && !input.includes('"')) {
    return "'" + input + "'";
  }

  // If contains only single quotes, wrap in double quotes
  if (input.includes("'") && !input.includes('"')) {
    return '"' + input + '"';
  }

  // If contains only double quotes, wrap in single quotes
  if (!input.includes("'") && input.includes('"')) {
    return "'" + input + "'";
  }

  // Contains both quotes - need to use concat()
  // Split into segments: text segments and quote characters
  const parts: string[] = [];
  let current = '';
  for (const char of input) {
    if (char === "'" || char === '"') {
      if (current) parts.push(current);
      parts.push(char);
      current = '';
     } else {
      current += char;
    }
  }
  if (current) parts.push(current);

  // Build concat expression: alternate quote types for each part
  // Quote characters get wrapped in the opposite quote type
  // Text segments alternate quote types
  let useSingleQuote = true;
  const concatParts = parts.map((part) => {
    if (part === "'") {
      return '"\'"';
    }
    if (part === '"') {
      return "'\"'";
    }
    // Text segment - alternate quote type
    const result = useSingleQuote ? "'" + part + "'" : '"' + part + '"';
    useSingleQuote = !useSingleQuote;
    return result;
  });

  return "concat(" + concatParts.join(", ") + ")";
}

/**
 * CSV field encoding
 */
export function encodeCsvField(input: string): string {
  if (/[",\n\r]/.test(input)) {
    return '"' + input.replace(/"/g, '""') + '"';
  }
  return input;
}

/**
 * CSV row encoding
 */
export function encodeCsvRow(fields: string[]): string {
  return fields.map(encodeCsvField).join(',');
}

/**
 * Removes null bytes and other dangerous characters
 */
export function sanitizeInput(input: string): string {
  return input
    .replace(/\x00/g, '') // Remove null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Remove control chars except \t\n\r
}

/**
 * Strips HTML tags from input (for plain text contexts)
 */
export function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/**
 * Limits string length and adds ellipsis
 */
export function truncateString(input: string, maxLength: number, ellipsis = '...'): string {
  if (input.length <= maxLength) return input;
  if (maxLength <= ellipsis.length) return ellipsis.slice(0, maxLength);
  return input.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Ensures string is safe for logging (no newlines, control chars)
 */
export function safeForLogging(input: string): string {
  return sanitizeInput(input)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Context-aware encoding based on output context
 */
export enum OutputContext {
  HTML = 'html',
  HTML_ATTRIBUTE = 'html-attribute',
  HTML_COMMENT = 'html-comment',
  JAVASCRIPT = 'javascript',
  JAVASCRIPT_TEMPLATE = 'javascript-template',
  JSON = 'json',
  URL = 'url',
  FORM_URL = 'form-url',
  CSS = 'css',
  CSS_STRING = 'css-string',
  SQL_IDENTIFIER = 'sql-identifier',
  SHELL = 'shell',
  LDAP_DN = 'ldap-dn',
  LDAP_FILTER = 'ldap-filter',
  XPATH = 'xpath',
  CSV = 'csv',
  LOG = 'log',
}

/**
 * Encodes input for the specified output context
 */
export function encodeForContext(input: string, context: OutputContext): string {
  switch (context) {
    case OutputContext.HTML:
      return encodeHtml(input);
    case OutputContext.HTML_ATTRIBUTE:
      return encodeHtmlAttribute(input);
    case OutputContext.HTML_COMMENT:
      return input.replace(/--/g, "&#45;&#45;").replace(/>/g, "&gt;");
    case OutputContext.JAVASCRIPT:
      return encodeJavaScript(input);
    case OutputContext.JAVASCRIPT_TEMPLATE:
      return input.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    case OutputContext.JSON:
      return encodeJson(input);
    case OutputContext.URL:
      return encodeUrl(input);
    case OutputContext.FORM_URL:
      return encodeFormUrl(input);
    case OutputContext.CSS:
      return encodeCss(input);
    case OutputContext.CSS_STRING:
      return encodeJavaScript(input); // CSS strings use similar escaping
    case OutputContext.SQL_IDENTIFIER:
      return quoteSqlIdentifier(input);
    case OutputContext.SHELL:
      return escapeShellArg(input);
    case OutputContext.LDAP_DN:
      return escapeLdapDn(input);
    case OutputContext.LDAP_FILTER:
      return escapeLdapFilter(input);
    case OutputContext.XPATH:
      return escapeXPath(input);
    case OutputContext.CSV:
      return encodeCsvField(input);
    case OutputContext.LOG:
      return safeForLogging(input);
    default:
      return encodeHtml(input); // Default to HTML encoding
  }
}

/**
 * Encodes all string values in an object for the given context
 */
export function encodeObjectForContext<T extends Record<string, unknown>>(
  obj: T,
  context: OutputContext
): T {
  const result = {} as T;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      (result as Record<string, unknown>)[key] = encodeForContext(value, context);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      (result as Record<string, unknown>)[key] = encodeObjectForContext(value as Record<string, unknown>, context);
    } else if (Array.isArray(value)) {
      (result as Record<string, unknown>)[key] = value.map((v) =>
        typeof v === 'string' ? encodeForContext(v, context) : v
      );
    } else {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export default {
  encodeHtml,
  encodeHtmlAttribute,
  encodeJavaScript,
  encodeJson,
  encodeUrl,
  encodeFormUrl,
  encodeCss,
  quoteSqlIdentifier,
  escapeShellArg,
  escapeLdapDn,
  escapeLdapFilter,
  escapeXPath,
  encodeCsvField,
  encodeCsvRow,
  sanitizeInput,
  stripHtmlTags,
  truncateString,
  safeForLogging,
  OutputContext,
  encodeForContext,
  encodeObjectForContext,
};