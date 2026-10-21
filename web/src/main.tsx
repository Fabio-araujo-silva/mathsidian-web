import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { UiProvider } from "./components/ui";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/reader.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>
);
