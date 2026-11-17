/** A snapshot of the working tree, kept under refs/river/checkpoints/<n>. Branch history is not changed. */
export interface Checkpoint {
  ref: string
  sha: string
  label: string
  /** ISO time. */
  at: string
}

/** Snapshot tracked and untracked (not ignored) files without changing the working tree or the index. */
export function checkpoint(root: string, label: string): Promise<Checkpoint> {
  throw new Error("not implemented")
}

export function listCheckpoints(root: string): Promise<Checkpoint[]> {
  throw new Error("not implemented")
}

/** Restore the working tree files to the checkpoint. Files created after it are removed. */
export function restoreCheckpoint(root: string, ref: string): Promise<void> {
  throw new Error("not implemented")
}

/** Short SHA of HEAD, plus "+dirty" when the tree has changes. */
export function currentRev(root: string): Promise<string> {
  throw new Error("not implemented")
}
