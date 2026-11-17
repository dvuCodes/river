import { contextBridge, ipcRenderer } from "electron"
import type { ApprovalApi } from "../shared/approval"

const api: ApprovalApi = {
  load: () => ipcRenderer.invoke("approval:load"),
  approve: (jobId, shas) => ipcRenderer.invoke("job:approve", jobId, shas),
  kit: () => ipcRenderer.invoke("approval:kit"),
  cancel: () => ipcRenderer.invoke("approval:cancel"),
}

contextBridge.exposeInMainWorld("approval", api)
