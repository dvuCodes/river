import type { Board, Card, Job, Mark } from "./types"

/** Absolute folder of a board in the workspace: <root>/.river/boards/<name>. Rejects unsafe names. */
export function boardDir(workspaceRoot: string, name: string): string {
  throw new Error("not implemented")
}

/** Read a whole board. A missing board is empty. Skips (and reports via onError) files that fail to parse. */
export function loadBoard(workspaceRoot: string, name: string, onError?: (file: string, err: unknown) => void): Promise<Board> {
  throw new Error("not implemented")
}

export function listBoards(workspaceRoot: string): Promise<string[]> {
  throw new Error("not implemented")
}

/** Write one card (atomic). New cards get an id ("c_" + 8 base36) and createdAt. */
export function saveCard(workspaceRoot: string, board: string, card: Omit<Card, "id" | "createdAt"> & Partial<Pick<Card, "id" | "createdAt">>): Promise<Card> {
  throw new Error("not implemented")
}

export function deleteCard(workspaceRoot: string, board: string, cardId: string): Promise<void> {
  throw new Error("not implemented")
}

/** Write one mark (atomic). New marks get an id ("m_" + 8 base36), createdAt and status "open". */
export function saveMark(workspaceRoot: string, board: string, mark: Omit<Mark, "id" | "createdAt" | "status"> & Partial<Pick<Mark, "id" | "createdAt" | "status">>): Promise<Mark> {
  throw new Error("not implemented")
}

export function deleteMark(workspaceRoot: string, board: string, markId: string): Promise<void> {
  throw new Error("not implemented")
}

/** Marks with status "open", oldest first. */
export function openMarks(board: Board): Mark[] {
  throw new Error("not implemented")
}

/** Jobs: .river/jobs/<id>.json in the workspace. */
export function saveJob(workspaceRoot: string, job: Job): Promise<Job> {
  throw new Error("not implemented")
}

export function loadJob(workspaceRoot: string, jobId: string): Promise<Job> {
  throw new Error("not implemented")
}

export function listJobs(workspaceRoot: string): Promise<Job[]> {
  throw new Error("not implemented")
}
