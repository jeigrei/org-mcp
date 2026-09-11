import { promises as fs } from "node:fs";

/** Thrown when an authenticated identity has no entry in a configured identity map. */
export class IdentityError extends Error {}

export interface ResolvedIdentity {
  /** Directory-safe id used to scope this user's org files. */
  id: string;
  /** The raw Access claim this was resolved from, kept for logging. */
  label: string;
}

/**
 * Turns an arbitrary identity string (a service token name, an email address, ...) into
 * something safe to use as a directory name: lowercase, ASCII word chars, dots, hyphens.
 */
export function sanitizeUserId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!cleaned) {
    throw new Error(`Could not derive a safe user id from identity "${raw}".`);
  }
  return cleaned.slice(0, 128);
}

/**
 * Maps the identity claims Cloudflare Access produces onto canonical user ids.
 *
 * The same person reaches org-mcp under different claims depending on how they connected:
 * a Service Token yields its `common_name` ("grayson"), while an interactive OAuth login
 * yields an `email` ("grayson@example.com"). Without a map those sanitize to two different
 * directories, silently splitting one person's data in half. The map is explicit rather than
 * inferred — stripping an email's domain would collapse alice@gmail.com and alice@work.com,
 * two different people, into one directory.
 */
export class IdentityResolver {
  private constructor(private readonly map: Map<string, string> | null) {}

  /** Loads a map from a JSON file of {"raw claim": "user id"}. With no path, mapping is off. */
  static async load(filePath?: string): Promise<IdentityResolver> {
    if (!filePath) return new IdentityResolver(null);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      throw new Error(`Could not read identity map "${filePath}": ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Identity map "${filePath}" is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Identity map "${filePath}" must be a JSON object of {"claim": "user-id"}.`);
    }

    const map = new Map<string, string>();
    for (const [claim, userId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof userId !== "string") {
        throw new Error(`Identity map entry "${claim}" must map to a string user id.`);
      }
      map.set(claim.trim().toLowerCase(), sanitizeUserId(userId));
    }
    return new IdentityResolver(map);
  }

  /** True when unmapped identities are rejected rather than given their own directory. */
  get isStrict(): boolean {
    return this.map !== null;
  }

  /** Canonical user ids the map can produce, deduplicated. */
  get userIds(): string[] {
    return this.map ? [...new Set(this.map.values())].sort() : [];
  }

  get size(): number {
    return this.map?.size ?? 0;
  }

  /** Resolves an Access claim to a user id, throwing IdentityError if it isn't mapped. */
  resolve(label: string): string {
    if (!this.map) return sanitizeUserId(label);
    const mapped = this.map.get(label.trim().toLowerCase());
    if (!mapped) {
      throw new IdentityError(
        `Identity "${label}" is not in the identity map. Add it to the map file and restart org-mcp.`
      );
    }
    return mapped;
  }
}
