/** Pure helpers shared by UI layer (framework-agnostic, easy to unit test). */

/** Format a semantic version + build tag into a display string. */
export function formatVersion(version: string, build?: string): string {
  const cleanVersion = version.startsWith('v') ? version : `v${version}`;
  return build ? `${cleanVersion} (${build})` : cleanVersion;
}

/** Compose a CSS class list, ignoring falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
