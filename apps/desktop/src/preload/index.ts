import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { RiverApi } from "../shared/api"

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: RiverApi = {
  getProject: () => invoke("project:get"),
  pickProject: () => invoke("project:pick"),
  loadStory: (rel) => invoke("story:load", rel),
  savePassage: (rel, id, raw) => invoke("story:savePassage", rel, id, raw),
  renamePassage: (rel, id, name) => invoke("story:rename", rel, id, name),
  savePositions: (rel, positions) => invoke("story:savePositions", rel, positions),
  paths: (rel) => invoke("story:paths", rel),
  openState: (rel, state) => invoke("story:openState", rel, state),
  playStart: (rel, from) => invoke("play:start", rel, from),
  playChoose: (id, index) => invoke("play:choose", id, index),
  playUndo: (id) => invoke("play:undo", id),
  playSetVar: (id, name, value) => invoke("play:setVar", id, name, value),
  frames: () => invoke("frames:get"),
  capture: (shotId) => invoke("frames:capture", shotId),
  addThread: (target, text) => invoke("review:add", target, text),
  reply: (threadId, text) => invoke("review:reply", threadId, text),
  setThreadStatus: (threadId, status) => invoke("review:status", threadId, status),
  setPlanStatus: (planId, status) => invoke("plan:status", planId, status),
  boardList: () => invoke("board:list"),
  boardOpen: (name) => invoke("board:open", name),
  boardCard: (name, id) => invoke("board:card", name, id),
  boardMark: (name, id) => invoke("board:mark", name, id),
  boardEdge: (name, id) => invoke("board:edge", name, id),
  boardSaveEdge: (name, edge) => invoke("board:saveEdge", name, edge),
  boardDeleteEdge: (name, id) => invoke("board:deleteEdge", name, id),
  boardSaveCard: (name, card) => invoke("board:saveCard", name, card),
  boardDeleteCard: (name, id) => invoke("board:deleteCard", name, id),
  boardSaveMark: (name, mark) => invoke("board:saveMark", name, mark),
  boardDeleteMark: (name, id) => invoke("board:deleteMark", name, id),
  boardReply: (name, id, text) => invoke("board:reply", name, id, text),
  boardOpenCount: (name) => invoke("board:openCount", name),
  boardRename: (from, to) => invoke("board:rename", from, to),
  boardDelete: (name) => invoke("board:delete", name),
  boardAddFrames: (name, strip) => invoke("board:addFrames", name, strip),
  boardPin: (name, pin) => invoke("board:pin", name, pin),
  boardPickImage: () => invoke("board:pickImage"),
  boardStageImage: (bytes, fileName) => invoke("board:stageImage", bytes, fileName),
  boardAddRef: (name, token, source, at) => invoke("board:addRef", name, token, source, at),
  jobStart: (board, markId) => invoke("job:start", board, markId),
  jobGet: (jobId) => invoke("job:get", jobId),
  jobApprove: (jobId, shas) => invoke("job:approve", jobId, shas),
  jobAccept: (jobId, variants) => invoke("job:accept", jobId, variants),
  jobDismiss: (jobId, reason) => invoke("job:dismiss", jobId, reason),
  jobRevise: (jobId) => invoke("job:revise", jobId),
  agentStatus: () => invoke("agent:status"),
  agentStart: (req) => invoke("agent:start", req),
  agentRespond: (requestId, decision) => invoke("agent:respond", requestId, decision),
  agentAbort: (turnId) => invoke("agent:abort", turnId),
  restoreCheckpoint: (ref) => invoke("agent:restore", ref),
  setApiKey: (key) => invoke("settings:setKey", key),
  clearApiKey: () => invoke("settings:clearKey"),
  setAgentPrefs: (p) => invoke("settings:setAgentPrefs", p),
  canvasTheme: () => invoke("settings:canvasTheme"),
  setCanvasTheme: (t) => invoke("settings:setCanvasTheme", t),
  refreshAgentStatus: () => invoke("agent:refreshStatus"),
  openClaudeSignIn: () => invoke("claude:signIn"),
  onAgentEvent: (cb) => listen("agent:event", cb),
  onAgentPermission: (cb) => listen("agent:permission", cb),
  onFsChange: (cb) => listen("fs:change", cb),
  onNavigate: (cb) => listen("smoke:navigate", cb),
  smokeReady: (view) => ipcRenderer.send("smoke:ready", view),
}

contextBridge.exposeInMainWorld("river", api)
