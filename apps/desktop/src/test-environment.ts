/** Test and development environment variables count only in an unpackaged build, never in an installed app. */
export function readUnpackagedEnv(build: { packaged: boolean; env: NodeJS.ProcessEnv }, name: string): string | undefined {
  return build.packaged ? undefined : build.env[name];
}
