import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessIdentity {
  /** Directory-safe id derived from the Access identity, used to scope a user's org files. */
  id: string;
  /** Original identity claim (service token name, or user email), kept for logging only. */
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
 * Builds a verifier for Cloudflare Access JWTs (the `Cf-Access-Jwt-Assertion` header
 * Access adds to every request it lets through — for both IdP logins and Service Tokens).
 *
 * `teamDomain` is your Zero Trust team domain, e.g. "myteam.cloudflareaccess.com".
 * `aud` is the Access Application's Audience (AUD) tag, from the app's Overview page.
 */
export function createAccessVerifier(
  teamDomain: string,
  aud: string
): (token: string) => Promise<AccessIdentity> {
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));

  return async function verify(token: string): Promise<AccessIdentity> {
    const { payload } = await jwtVerify(token, jwks, {
      audience: aud,
      issuer: `https://${teamDomain}`,
    });

    // Service Tokens carry `common_name` (the token's name in the Zero Trust dashboard);
    // IdP-authenticated users carry `email`. Fall back to `sub` if neither is present.
    const label =
      (typeof payload.common_name === "string" && payload.common_name) ||
      (typeof payload.email === "string" && payload.email) ||
      (typeof payload.sub === "string" && payload.sub) ||
      null;
    if (!label) {
      throw new Error("Access token has no common_name, email, or sub claim to identify the user.");
    }
    return { id: sanitizeUserId(label), label };
  };
}
