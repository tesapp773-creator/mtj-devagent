import path from "node:path";
import fs from "node:fs/promises";

/**
 * Resolves a user/agent-supplied relative path against the workspace root,
 * and throws if the resolved path would escape that root. This is the
 * single safety boundary that every file/command tool relies on so the
 * agent can never read or write files outside its sandbox.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async ensureExists(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  resolve(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new Error(
        `Path escapes workspace sandbox: "${relativePath}" resolved to "${resolved}", ` +
          `which is outside root "${this.root}"`
      );
    }
    return resolved;
  }
}
