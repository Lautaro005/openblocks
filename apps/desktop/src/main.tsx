import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Follow the system theme live when the user picked "system".
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  const t = localStorage.getItem("ob-theme") || "system";
  if (t === "system") document.documentElement.dataset.theme = e.matches ? "dark" : "light";
});

createRoot(document.getElementById("root")!).render(<App />);
