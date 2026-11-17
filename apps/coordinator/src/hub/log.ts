// The coordinator's own record of why it refused a forwarded identity (Task b5fe71c8). The caller of a refused request only ever hears "转发身份未被接受。" (it must not learn which check
// failed); the reason belongs in this machine's log, on stderr, with the time, so a 401 seen at the Hub can be matched to its cause here. Never the identity or any request body.
export function logHubIdentityRejected(reason: string, write: (line: string) => void = line => { process.stderr.write(line); }, now: () => Date = () => new Date()): void {
  write(`${now().toISOString()} Hub identity rejected: ${reason.replace(/[\r\n]+/g, " ").slice(0, 200)}\n`);
}
