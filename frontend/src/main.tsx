import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@cloudscape-design/global-styles/index.css"
import "./styles/global.css";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { loadRuntimeConfig } from "./api/client";

loadRuntimeConfig().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </React.StrictMode>
  );
});
