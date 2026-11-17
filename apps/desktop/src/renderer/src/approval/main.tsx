import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "../styles.css"
import "./approval.css"
import { ApprovalView } from "./ApprovalView"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApprovalView />
  </StrictMode>,
)
