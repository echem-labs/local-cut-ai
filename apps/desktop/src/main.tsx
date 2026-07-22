import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useLocale } from "./i18n";
import "./styles/app.css";
import { initZoom } from "./lib/zoom";
import { initTheme } from "./theme";

initTheme();
initZoom();

/** Remount the tree when the language changes so every t()/m() call re-reads
 * the active catalog — the locale key is the one place that has to know. */
function Root() {
  const locale = useLocale((state) => state.locale);
  return (
    <ErrorBoundary>
      <App key={locale} />
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
