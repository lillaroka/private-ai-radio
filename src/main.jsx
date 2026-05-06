import { BrowserRouter, Routes, Route } from "react-router";
import { createRoot } from "react-dom/client";
import StudioPage from "./pages/StudioPage";
import EpisodePage from "./pages/EpisodePage";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<StudioPage />} />
      <Route path="/episode/:id" element={<EpisodePage />} />
    </Routes>
  </BrowserRouter>,
);
